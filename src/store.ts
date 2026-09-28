// Hook definitions live in the plugin's `hooks` setting (a JSON array), so
// they are editable from Settings → Installed plugins, `bb plugin config`,
// and the `bb hooks` CLI alike. Run history lives in the plugin database.
import type Database from "better-sqlite3";
import { parseHooksJson, serializeHooks, type HookDefinition } from "./definitions.js";
import type { RunOutcome } from "./runner.js";

/** The slice of the settings handle the store needs. */
export interface HooksSettings {
  get(): Promise<{ hooks: string }>;
  experimental_set(values: { hooks: string }): Promise<unknown>;
  onChange(listener: (next: { hooks: string }, prev: { hooks: string }) => void): void;
}

export interface HookStore {
  list(): Promise<HookDefinition[]>;
  get(id: string): Promise<HookDefinition | null>;
  /** Insert or replace by id. */
  upsert(hook: HookDefinition): Promise<{ created: boolean }>;
  remove(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<HookDefinition | null>;
  /** The last parse error of the stored setting, when the setting is unusable. */
  lastError(): string | null;
}

export function createHookStore(settings: HooksSettings, onInvalid: (message: string) => void): HookStore {
  let cache: HookDefinition[] | null = null;
  let error: string | null = null;
  // One write at a time. The Hooks page and `bb hooks` both mutate this list.
  let tail: Promise<unknown> = Promise.resolve();

  function adopt(raw: string): HookDefinition[] {
    const parsed = parseHooksJson(raw);
    if ("error" in parsed) {
      error = parsed.error;
      onInvalid(parsed.error);
      cache = [];
    } else {
      error = null;
      cache = parsed.hooks;
    }
    return cache;
  }

  settings.onChange((next) => {
    adopt(next.hooks);
  });

  async function load(): Promise<HookDefinition[]> {
    if (cache !== null) return cache;
    return adopt((await settings.get()).hooks);
  }

  function guard(): void {
    if (error !== null) throw new Error(`the hooks setting is invalid and was left unchanged: ${error}`);
  }

  async function save(hooks: HookDefinition[]): Promise<void> {
    await settings.experimental_set({ hooks: serializeHooks(hooks) });
    cache = hooks;
    error = null;
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    list: async () => [...(await load())],
    get: async (id) => (await load()).find((hook) => hook.id === id) ?? null,
    upsert: (hook) =>
      enqueue(async () => {
        const hooks = await load();
        guard();
        const index = hooks.findIndex((candidate) => candidate.id === hook.id);
        const next = [...hooks];
        if (index === -1) next.push(hook);
        else next[index] = hook;
        await save(next);
        return { created: index === -1 };
      }),
    remove: (id) =>
      enqueue(async () => {
        const hooks = await load();
        guard();
        const next = hooks.filter((hook) => hook.id !== id);
        if (next.length === hooks.length) return false;
        await save(next);
        return true;
      }),
    setEnabled: (id, enabled) =>
      enqueue(async () => {
        const hooks = await load();
        guard();
        const index = hooks.findIndex((hook) => hook.id === id);
        if (index === -1) return null;
        const next = [...hooks];
        next[index] = { ...hooks[index]!, enabled };
        await save(next);
        return next[index]!;
      }),
    lastError: () => error,
  };
}

export interface RunRecord {
  id: number;
  hookId: string;
  event: string;
  threadId: string | null;
  startedAt: number;
  durationMs: number;
  status: RunOutcome["status"];
  exitCode: number | null;
  httpStatus: number | null;
  decision: string | null;
  output: string;
  error: string | null;
}

export interface HistoryStore {
  record(entry: Omit<RunRecord, "id">): void;
  list(options?: { limit?: number; offset?: number; hookId?: string; status?: "ok" | "failed" }): { runs: RunRecord[]; total: number };
  prune(keep: number): void;
  clear(): number;
}

export const HISTORY_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS hook_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hook_id TEXT NOT NULL,
    event TEXT NOT NULL,
    thread_id TEXT,
    started_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    http_status INTEGER,
    decision TEXT,
    output TEXT NOT NULL,
    error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS hook_runs_started_at ON hook_runs(started_at)`,
];

const OUTPUT_KEEP = 4_000;

interface Row {
  id: number;
  hook_id: string;
  event: string;
  thread_id: string | null;
  started_at: number;
  duration_ms: number;
  status: string;
  exit_code: number | null;
  http_status: number | null;
  decision: string | null;
  output: string;
  error: string | null;
}

export function createHistoryStore(db: Database.Database): HistoryStore {
  const insert = db.prepare(
    `INSERT INTO hook_runs (hook_id, event, thread_id, started_at, duration_ms, status, exit_code, http_status, decision, output, error)
     VALUES (@hookId, @event, @threadId, @startedAt, @durationMs, @status, @exitCode, @httpStatus, @decision, @output, @error)`,
  );
  const prune = db.prepare(
    `DELETE FROM hook_runs WHERE id NOT IN (SELECT id FROM hook_runs ORDER BY id DESC LIMIT ?)`,
  );
  const clear = db.prepare(`DELETE FROM hook_runs`);
  const toRecord = (row: Row): RunRecord => ({
    id: row.id,
    hookId: row.hook_id,
    event: row.event,
    threadId: row.thread_id,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    status: row.status as RunOutcome["status"],
    exitCode: row.exit_code,
    httpStatus: row.http_status,
    decision: row.decision,
    output: row.output,
    error: row.error,
  });
  return {
    record(entry) {
      insert.run({ ...entry, output: entry.output.slice(0, OUTPUT_KEEP) });
    },
    list(options = {}) {
      const limit = Math.max(1, Math.min(options.limit ?? 20, 500));
      const offset = Math.max(0, Math.min(options.offset ?? 0, 100_000));
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (options.hookId !== undefined) {
        where.push("hook_id = ?");
        params.push(options.hookId);
      }
      if (options.status === "ok") where.push("status = 'ok'");
      else if (options.status === "failed") where.push("status != 'ok'");
      const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")} `;
      const rows = db.prepare(`SELECT * FROM hook_runs ${clause}ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[];
      const total = db.prepare(`SELECT COUNT(*) AS n FROM hook_runs ${clause}`).get(...params) as { n: number };
      return { runs: rows.map(toRecord), total: Number(total.n) };
    },
    prune(keep) {
      prune.run(Math.max(0, keep));
    },
    clear() {
      return Number(clear.run().changes);
    },
  };
}
