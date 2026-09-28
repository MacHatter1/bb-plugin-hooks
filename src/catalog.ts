// The hooks marketplace: remote catalogs of templates. A catalog is a JSON
// document (`hooks-catalog.json`) at an https URL or in a GitHub repository.
// Fetched catalogs are cached in the plugin database. The registry lists them
// and resolves `catalog/template` references. The plugin ships no templates.
import type Database from "better-sqlite3";
import { z } from "zod";
import { formatIssues } from "./definitions.js";
import { templateSchema, type HookTemplate } from "./templates.js";

export const CATALOG_FILE = "hooks-catalog.json";
export const MAX_CATALOG_BYTES = 512 * 1024;
export const MAX_CATALOG_TEMPLATES = 200;

export const catalogSchema = z
  .object({
    /** Editor hint (`"$schema": "./schema/hooks-catalog.schema.json"`); ignored. */
    $schema: z.string().max(2048).optional(),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "catalog name must be lowercase letters, digits and dashes (max 64)"),
    description: z.string().max(500).optional(),
    version: z.string().max(64).optional(),
    homepage: z.string().url().max(2048).optional(),
    /** Who maintains the catalog (a name or GitHub login). */
    author: z.string().max(80).optional(),
    templates: z.array(templateSchema).max(MAX_CATALOG_TEMPLATES),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    catalog.templates.forEach((template, index) => {
      if (seen.has(template.id)) ctx.addIssue({ code: "custom", path: ["templates", index, "id"], message: `duplicate template id "${template.id}"` });
      seen.add(template.id);
    });
  });

export type Catalog = z.infer<typeof catalogSchema>;

/**
 * Turn what the user typed into a catalog URL. Accepts an https URL (http only
 * on loopback), `owner/repo`, `owner/repo@ref`, or an alias the caller supplies.
 */
export function parseSourceInput(input: string, aliases: Record<string, string> = {}): { url: string } | { error: string } {
  const trimmed = input.trim();
  if (trimmed === "") return { error: "source is empty" };
  if (trimmed in aliases) return { url: aliases[trimmed]! };
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { error: `"${trimmed}" is not a valid URL` };
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol === "http:" && !loopback) return { error: "catalog URLs must use https (http is allowed only on localhost)" };
    return { url: url.toString() };
  }
  const github = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9_./-]+))?$/.exec(trimmed);
  if (github !== null) {
    const [, owner, repo, ref] = github;
    return { url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref ?? "HEAD"}/${CATALOG_FILE}` };
  }
  return { error: `"${trimmed}" is not a catalog URL, an owner/repo GitHub shorthand, or a known alias` };
}

export type FetchCatalogResult =
  | { status: "ok"; catalog: Catalog; etag: string | null }
  | { status: "not-modified" }
  | { status: "error"; message: string };

export async function fetchCatalog(
  url: string,
  options: { fetchImpl?: typeof fetch; etag?: string | null; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<FetchCatalogResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), options.timeoutMs ?? 15_000);
  const onAbort = () => controller.abort(new Error("cancelled"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "bb-plugin-hooks" };
    if (options.etag) headers["if-none-match"] = options.etag;
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "follow" });
    if (response.status === 304) return { status: "not-modified" };
    if (!response.ok) return { status: "error", message: `HTTP ${response.status}` };
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) return { status: "error", message: `catalog is larger than ${MAX_CATALOG_BYTES / 1024} KiB` };
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      return { status: "error", message: `catalog is not valid JSON: ${(cause as Error).message}` };
    }
    const parsed = catalogSchema.safeParse(value);
    if (!parsed.success) return { status: "error", message: `catalog is invalid: ${formatIssues(parsed.error)}` };
    return { status: "ok", catalog: parsed.data, etag: response.headers.get("etag") };
  } catch (cause) {
    const reason = (controller.signal.reason as Error | undefined)?.message;
    return { status: "error", message: reason === "timeout" ? "timed out" : `request failed: ${(cause as Error).message}` };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export const CATALOG_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS catalogs (
    url TEXT PRIMARY KEY,
    name TEXT,
    etag TEXT,
    fetched_at INTEGER,
    json TEXT,
    error TEXT
  )`,
];

export interface CatalogRecord {
  url: string;
  name: string | null;
  etag: string | null;
  fetchedAt: number | null;
  catalog: Catalog | null;
  error: string | null;
}

export interface CatalogCache {
  list(): CatalogRecord[];
  get(url: string): CatalogRecord | null;
  put(record: CatalogRecord): void;
  remove(url: string): boolean;
}

interface Row {
  url: string;
  name: string | null;
  etag: string | null;
  fetched_at: number | null;
  json: string | null;
  error: string | null;
}

export function createCatalogCache(db: Database.Database): CatalogCache {
  const selectAll = db.prepare(`SELECT * FROM catalogs ORDER BY rowid`);
  const selectOne = db.prepare(`SELECT * FROM catalogs WHERE url = ?`);
  const upsert = db.prepare(
    `INSERT INTO catalogs (url, name, etag, fetched_at, json, error) VALUES (@url, @name, @etag, @fetchedAt, @json, @error)
     ON CONFLICT(url) DO UPDATE SET name = excluded.name, etag = excluded.etag, fetched_at = excluded.fetched_at, json = excluded.json, error = excluded.error`,
  );
  const del = db.prepare(`DELETE FROM catalogs WHERE url = ?`);
  const toRecord = (row: Row): CatalogRecord => {
    let catalog: Catalog | null = null;
    if (row.json !== null) {
      const parsed = catalogSchema.safeParse(JSON.parse(row.json));
      catalog = parsed.success ? parsed.data : null;
    }
    return { url: row.url, name: row.name, etag: row.etag, fetchedAt: row.fetched_at, catalog, error: row.error };
  };
  return {
    list: () => (selectAll.all() as Row[]).map(toRecord),
    get(url) {
      const row = selectOne.get(url) as Row | undefined;
      return row === undefined ? null : toRecord(row);
    },
    put(record) {
      upsert.run({
        url: record.url,
        name: record.name,
        etag: record.etag,
        fetchedAt: record.fetchedAt,
        json: record.catalog === null ? null : JSON.stringify(record.catalog),
        error: record.error,
      });
    },
    remove: (url) => Number(del.run(url).changes) > 0,
  };
}

export interface RegistryEntry {
  /** What `bb hooks use` takes: the bare id for bundled templates, `catalog/id` otherwise. */
  ref: string;
  source: "bundled" | string;
  sourceUrl: string | null;
  template: HookTemplate;
}

export interface TemplateRegistry {
  list(): RegistryEntry[];
  /** Resolve a ref; a bare id also matches a unique catalog template. */
  resolve(ref: string): { entry: RegistryEntry } | { error: string };
  search(query: string): RegistryEntry[];
}

export function createRegistry(bundled: readonly HookTemplate[], catalogs: () => CatalogRecord[]): TemplateRegistry {
  function list(): RegistryEntry[] {
    const entries: RegistryEntry[] = bundled.map((template) => ({ ref: template.id, source: "bundled", sourceUrl: null, template }));
    for (const record of catalogs()) {
      if (record.catalog === null) continue;
      for (const template of record.catalog.templates) {
        entries.push({ ref: `${record.catalog.name}/${template.id}`, source: record.catalog.name, sourceUrl: record.url, template });
      }
    }
    return entries;
  }
  return {
    list,
    resolve(ref) {
      const entries = list();
      const exact = entries.find((entry) => entry.ref === ref);
      if (exact !== undefined) return { entry: exact };
      const bare = entries.filter((entry) => entry.template.id === ref);
      if (bare.length === 1) return { entry: bare[0]! };
      if (bare.length > 1) return { error: `"${ref}" is ambiguous; use one of ${bare.map((entry) => entry.ref).join(", ")}` };
      return { error: `No template "${ref}". Run "bb hooks templates" or "bb hooks marketplace search <query>".` };
    },
    search(query) {
      const needle = query.trim().toLowerCase();
      if (needle === "") return list();
      return list().filter((entry) => {
        const haystack = [entry.ref, entry.template.name, entry.template.summary, entry.template.notes ?? "", entry.template.description ?? "", (entry.template.tags ?? []).join(" "), entry.template.events.join(" ")]
          .join("\n")
          .toLowerCase();
        return haystack.includes(needle);
      });
    },
  };
}

/** A starter catalog document users can copy to publish their own. */
export function starterCatalogJson(name = "my-hooks"): string {
  const catalog: Catalog = {
    name,
    description: "Hook templates for the BB Hooks plugin.",
    version: "1.0.0",
    author: "your-github-login",
    templates: [
      {
        id: "say-done",
        name: "Announce finished threads",
        summary: "Speak the thread title when a thread finishes (macOS).",
        kind: "observe",
        events: ["thread.idle"],
        params: [{ key: "voice", label: "Voice", type: "string", default: "Samantha" }],
        command: 'say -v {{voice}} "Finished $BB_THREAD_TITLE"',
        notes: "Publish this file as hooks-catalog.json in a GitHub repo; users add it with `bb hooks marketplace add owner/repo`.",
      },
    ],
  };
  return JSON.stringify(catalog, null, 2);
}
