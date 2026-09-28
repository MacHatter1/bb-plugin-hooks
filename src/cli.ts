// The `bb hooks` command: argv parsing and every subcommand. Pure of the bb
// API; server.ts supplies the stores, the registry and a test executor.
import { parseArgs } from "node:util";
import type { PluginCliCommandInfo, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { removeHook, useTemplate } from "./actions.js";
import type { Catalog, CatalogRecord, RegistryEntry, TemplateRegistry } from "./catalog.js";
import { starterCatalogJson } from "./catalog.js";
import {
  EVENT_CATALOG,
  HOOK_EVENTS,
  effectiveTimeoutMs,
  formatIssues,
  hookSchema,
  isGateEvent,
  type HookDefinition,
  type HookEvent,
  type HookInput,
} from "./definitions.js";
import { formatMark, rateTemplate } from "./rating.js";
import { describeDecision, type Decision, type RunOutcome } from "./runner.js";
import { SECRET_PLACEHOLDER, hookSecretRefs, type SecretStore } from "./secrets.js";
import type { HistoryStore, HookStore } from "./store.js";
import type { HookTemplate } from "./templates.js";

export interface TestResult {
  /** The JSON the hook received. */
  payload: Record<string, unknown>;
  /** The BB_* variables the hook received (secrets excluded). */
  env: Record<string, string>;
  outcome: RunOutcome;
  decision: Decision | null;
}

export interface MarketplaceOps {
  /** Configured catalog sources, as URLs. */
  sources(): string[];
  aliases(): Record<string, string>;
  add(input: string): Promise<{ record: CatalogRecord } | { error: string }>;
  remove(input: string): Promise<{ removed: boolean } | { error: string }>;
  refresh(input?: string): Promise<CatalogRecord[] | { error: string }>;
  validate(input: string): Promise<{ url: string; catalog: Catalog } | { error: string }>;
  records(): CatalogRecord[];
}

export interface CliDeps {
  store: HookStore;
  history: HistoryStore;
  secrets: SecretStore;
  registry: TemplateRegistry;
  marketplace: MarketplaceOps;
  test(hook: HookDefinition, threadId: string | null, signal?: AbortSignal): Promise<TestResult>;
}

export const CLI_COMMANDS: PluginCliCommandInfo[] = [
  { name: "list", summary: "List hooks", usage: "bb hooks list [--json]" },
  { name: "events", summary: "List the events a hook can subscribe to", usage: "bb hooks events [--json]" },
  { name: "templates", summary: "List premade hooks (bundled and from marketplace catalogs), or show one", usage: "bb hooks templates [<template>] [--search <text>] [--json]" },
  {
    name: "use",
    summary: "Create hooks from a template; catalog templates need --yes after you have read what they run",
    usage: "bb hooks use <template|catalog/template> [--set key=value]… [--id <hook-id>] [--event <event>]… [--project <proj_id>] [--provider <id>] [--title <regex>] [--text <regex>] [--disabled] [--yes]",
  },
  { name: "marketplace", summary: "Manage catalog sources: list, add, remove, refresh, search, validate, init", usage: "bb hooks marketplace <list|add <src>|remove <src>|refresh [src]|search <text>|validate <src>|init [--name <catalog>]>" },
  { name: "secrets", summary: "Encrypted values hooks reference as {{secret:NAME}}", usage: "bb hooks secrets <list|set <name> <value>|remove <name>>" },
  { name: "show", summary: "Show one hook as JSON", usage: "bb hooks show <id>" },
  {
    name: "add",
    summary: "Create a hook by hand (or replace one with the same id)",
    usage:
      "bb hooks add <id> --event <event> (--command <shell> | --url <https://…>) [--project <proj_id>] [--provider <id>] [--title <regex>] [--text <regex>] [--timeout <ms>] [--cwd <dir>] [--header k=v]… [--on-error proceed|reject|wait] [--description <text>] [--disabled]",
  },
  { name: "edit", summary: "Change fields of an existing hook", usage: "bb hooks edit <id> [same flags as add] [--clear-match]" },
  { name: "remove", summary: "Delete a hook (and secrets only it used)", usage: "bb hooks remove <id>" },
  { name: "enable", summary: "Enable a hook", usage: "bb hooks enable <id>" },
  { name: "disable", summary: "Disable a hook without deleting it", usage: "bb hooks disable <id>" },
  { name: "test", summary: "Run a hook now with a sample payload (or a real thread's)", usage: "bb hooks test <id> [--thread <thread_id>] [--json]" },
  { name: "history", summary: "Show recent hook runs", usage: "bb hooks history [--limit <n>] [--hook <id>] [--json] | bb hooks history clear" },
  { name: "export", summary: "Print a hook as a template you can publish in a catalog", usage: "bb hooks export <id>" },
];

const USAGE = [
  "Usage: bb hooks <command> [options]",
  "",
  ...CLI_COMMANDS.map((command) => `  ${command.usage}`),
  "",
  "Start with `bb hooks templates` for premade hooks, e.g. `bb hooks use desktop-notify`.",
  "Add more with `bb hooks marketplace add owner/repo` (a GitHub repo with hooks-catalog.json).",
  "Events: run `bb hooks events`. Payload JSON arrives on the command's stdin",
  "(or as the webhook POST body); BB_HOOK_EVENT, BB_THREAD_ID, BB_PROJECT_ID,",
  "BB_THREAD_TITLE, BB_THREAD_STATUS and BB_PROVIDER_ID are set in the environment.",
  "Commands run on the machine that hosts the BB server.",
].join("\n");

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  yes: { type: "boolean" },
  event: { type: "string", multiple: true },
  id: { type: "string" },
  set: { type: "string", multiple: true },
  search: { type: "string" },
  name: { type: "string" },
  command: { type: "string" },
  url: { type: "string" },
  cwd: { type: "string" },
  header: { type: "string", multiple: true },
  project: { type: "string" },
  provider: { type: "string" },
  title: { type: "string" },
  text: { type: "string" },
  timeout: { type: "string" },
  "on-error": { type: "string" },
  description: { type: "string" },
  disabled: { type: "boolean" },
  "clear-match": { type: "boolean" },
  thread: { type: "string" },
  limit: { type: "string" },
  hook: { type: "string" },
} as const;

type Parsed = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>;
type Values = Parsed["values"];

function ok(text: string): PluginCliResult {
  return { exitCode: 0, stdout: text };
}
function fail(text: string, exitCode = 1): PluginCliResult {
  return { exitCode, stderr: text };
}
function json(value: unknown): PluginCliResult {
  return { exitCode: 0, stdout: JSON.stringify(value, null, 2) };
}

function targetOf(hook: HookDefinition): string {
  return hook.command !== undefined ? `$ ${hook.command}` : `POST ${hook.url ?? ""}`;
}

/** One line, for tables and summaries; `bb hooks show` has the full text. */
function compactTarget(hook: HookDefinition, max = 80): string {
  const oneLine = targetOf(hook).replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function matchOf(hook: HookDefinition): string {
  if (hook.match === undefined) return "";
  return Object.entries(hook.match)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function table(rows: string[][], headers: string[]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

function parseTimeout(raw: string | undefined): number | undefined | { error: string } {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) return { error: `--timeout must be an integer number of milliseconds, got "${raw}"` };
  return value;
}

function parseKeyValues(raw: readonly string[] | undefined, flag: string): { values: Record<string, string> } | { error: string } {
  const values: Record<string, string> = {};
  for (const entry of raw ?? []) {
    const index = entry.indexOf("=");
    if (index <= 0) return { error: `${flag} expects key=value, got "${entry}"` };
    values[entry.slice(0, index).trim()] = entry.slice(index + 1);
  }
  return { values };
}

/** Build a hook input from flags, layered over an existing hook when editing. */
function buildHook(id: string, values: Values, existing: HookDefinition | null): HookInput | { error: string } {
  const timeout = parseTimeout(values.timeout);
  if (typeof timeout === "object") return timeout;
  const parsedHeaders = parseKeyValues(values.header, "--header");
  if ("error" in parsedHeaders) return parsedHeaders;
  const headers = values.header === undefined || values.header.length === 0 ? undefined : parsedHeaders.values;

  const eventFlag = values.event?.at(-1);
  const base: HookInput = existing ? { ...existing } : { id, event: (eventFlag ?? "") as HookEvent, enabled: true };
  base.id = id;
  if (eventFlag !== undefined) base.event = eventFlag as HookEvent;
  if (values.command !== undefined) {
    base.command = values.command;
    delete base.url;
    delete base.headers;
    delete base.body;
  }
  if (values.url !== undefined) {
    base.url = values.url;
    delete base.command;
    delete base.cwd;
  }
  if (values.cwd !== undefined) base.cwd = values.cwd;
  if (headers !== undefined) base.headers = { ...(base.headers ?? {}), ...headers };
  if (timeout !== undefined) base.timeoutMs = timeout;
  if (values["on-error"] !== undefined) base.onError = values["on-error"] as HookInput["onError"];
  if (values.description !== undefined) base.description = values.description;
  if (values.disabled) base.enabled = false;
  else if (existing === null) base.enabled = true;

  if (values["clear-match"]) delete base.match;
  const match = { ...(base.match ?? {}) };
  if (values.project !== undefined) match.projectId = values.project;
  if (values.provider !== undefined) match.providerId = values.provider;
  if (values.title !== undefined) match.title = values.title;
  if (values.text !== undefined) match.text = values.text;
  if (Object.keys(match).length > 0) base.match = match;
  else delete base.match;

  if (!(HOOK_EVENTS as readonly string[]).includes(base.event)) {
    return { error: (base.event as string) === "" ? "--event is required; run `bb hooks events` for the list" : `unknown event "${base.event}"; run \`bb hooks events\` for the list` };
  }
  return base;
}

function shortEvent(event: HookEvent): string {
  return event.replace(/^(thread|experimental_)\./, "");
}

function describeTemplate(entry: RegistryEntry, full: boolean): string {
  const { template } = entry;
  const lines = [
    `${entry.ref} — ${template.name}`,
    template.summary,
    "",
    `Source: ${entry.source === "bundled" ? "bundled with the plugin" : `catalog "${entry.source}" (${entry.sourceUrl ?? ""})`}`,
    `By: ${[template.author ?? "unknown", template.version ? `v${template.version}` : null, template.homepage].filter(Boolean).join(" · ")}`,
    `Kind: ${template.kind}${template.kind === "gate" ? " (message.dispatch only)" : `; default events: ${template.events.join(", ")} (override with --event)`}`,
  ];
  const rating = rateTemplate(template);
  lines.push(`Performance: ${formatMark(rating.performance)} — ${rating.performance.reason}`);
  lines.push(`Security: ${formatMark(rating.security)} — ${rating.security.reason}`);
  if (template.params.length === 0) lines.push("Parameters: none");
  else {
    lines.push("Parameters (--set key=value):");
    lines.push(
      table(
        template.params.map((param) => [
          param.key,
          param.required ? "required" : `default ${JSON.stringify(param.default ?? "")}`,
          `${param.label}${param.secret ? " [stored encrypted]" : ""}${param.type === "agent" ? " [inherit, a provider id, or JSON {providerId, model, reasoningLevel}]" : ""}${param.description ? ` — ${param.description}` : ""}`,
        ]),
        ["KEY", "VALUE", "MEANING"],
      )
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );
  }
  if (template.notes !== undefined) lines.push("", `Note: ${template.notes}`);
  if (full || entry.source !== "bundled") {
    lines.push("", "What it runs:");
    if (template.command !== undefined) lines.push(...template.command.split("\n").map((line) => `  $ ${line}`));
    if (template.url !== undefined) lines.push(`  POST ${template.url}`);
    if (template.body !== undefined) lines.push(`  body: ${template.body}`);
    if (template.headers !== undefined) lines.push(`  headers: ${JSON.stringify(template.headers)}`);
    if (template.match !== undefined) lines.push(`  match: ${JSON.stringify(template.match)}`);
  }
  const example = template.params.filter((param) => param.required).map((param) => ` --set ${param.key}=…`).join("");
  lines.push("", `Example: bb hooks use ${entry.ref}${example}${entry.source === "bundled" ? "" : " --yes"}`);
  return lines.join("\n");
}

function formatRun(result: TestResult, hook: HookDefinition): string {
  const { outcome, decision } = result;
  const lines = [
    `Hook: ${hook.id} (${hook.event}) → ${compactTarget(hook)}`,
    `Status: ${outcome.status}${outcome.exitCode !== null ? ` (exit ${outcome.exitCode})` : ""}${outcome.httpStatus !== null ? ` (HTTP ${outcome.httpStatus})` : ""} in ${outcome.durationMs} ms`,
  ];
  if (outcome.error !== null) lines.push(`Error: ${outcome.error}`);
  if (decision !== null) lines.push(`Decision: ${describeDecision(decision)}`);
  if (outcome.stdout.trim() !== "") lines.push("--- stdout", outcome.stdout.trimEnd());
  if (outcome.stderr.trim() !== "") lines.push("--- stderr", outcome.stderr.trimEnd());
  return lines.join("\n");
}

function formatCatalogRecord(record: CatalogRecord): string[] {
  const templates = record.catalog?.templates.length ?? 0;
  const when = record.fetchedAt === null ? "never" : new Date(record.fetchedAt).toISOString().replace("T", " ").slice(0, 16);
  return [record.catalog?.name ?? "?", record.catalog?.author ?? "", String(templates), when, record.error ?? "ok", record.url];
}

/** Turn an existing hook into a shareable template (secrets become secret params). */
export function hookToTemplate(hook: HookDefinition): HookTemplate {
  const params: HookTemplate["params"] = [];
  const keyFor = (name: string) => {
    const base = name.split("/").pop()?.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[^a-zA-Z]+/, "") || "secret";
    let key = base;
    let n = 2;
    while (params.some((param) => param.key === key)) key = `${base}${n++}`;
    return key;
  };
  const keys = new Map<string, string>();
  for (const name of hookSecretRefs(hook)) {
    const key = keyFor(name);
    keys.set(name, key);
    params.push({ key, label: key, type: "string", required: true, secret: true });
  }
  const swap = (text: string) => text.replace(SECRET_PLACEHOLDER, (_match, name: string) => `{{${keys.get(name) ?? name}}}`);
  const template: HookTemplate = {
    id: hook.id,
    name: hook.description ?? hook.id,
    summary: hook.description ?? `Hook ${hook.id} on ${hook.event}.`,
    kind: isGateEvent(hook.event) ? "gate" : "observe",
    events: [hook.event],
    params,
  };
  if (hook.command !== undefined) template.command = swap(hook.command);
  if (hook.url !== undefined) template.url = swap(hook.url);
  if (hook.body !== undefined) template.body = swap(hook.body);
  if (hook.headers !== undefined) template.headers = Object.fromEntries(Object.entries(hook.headers).map(([key, value]) => [key, swap(value)]));
  if (hook.match !== undefined) template.match = hook.match;
  if (hook.timeoutMs !== undefined) template.timeoutMs = hook.timeoutMs;
  if (hook.onError !== undefined) template.onError = hook.onError;
  return template;
}

export function createCliRun(deps: CliDeps): (argv: string[], ctx: PluginCliContext) => Promise<PluginCliResult> {
  return async (argv, ctx) => {
    let parsed: Parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (cause) {
      return fail(`${(cause as Error).message}\n\n${USAGE}`);
    }
    const { values, positionals } = parsed;
    const [command, id, ...rest] = positionals;
    if (values.help || command === undefined || command === "help") return ok(USAGE);

    const requireId = (what = "a hook id"): PluginCliResult | string => (id === undefined ? fail(`bb hooks ${command} needs ${what}\n\n${USAGE}`) : id);
    const notFound = (hookId: string) => fail(`No hook with id "${hookId}". Run "bb hooks list".`);

    try {
    switch (command) {
      case "list": {
        const hooks = await deps.store.list();
        const error = deps.store.lastError();
        if (values.json) return json({ hooks, error });
        const header = error !== null ? `WARNING: the hooks setting is invalid and no hooks are active: ${error}\n\n` : "";
        if (hooks.length === 0) return ok(`${header}No hooks. Try: bb hooks templates, then bb hooks use <template>`);
        const rows = hooks.map((hook) => [hook.id, hook.event, hook.enabled ? "yes" : "no", hook.template ? `${hook.template.source === "bundled" || hook.template.source === undefined ? "" : `${hook.template.source}/`}${hook.template.id}` : "", matchOf(hook), compactTarget(hook, 60)]);
        return ok(header + table(rows, ["ID", "EVENT", "ENABLED", "TEMPLATE", "MATCH", "TARGET"]));
      }
      case "events": {
        if (values.json) return json(EVENT_CATALOG);
        return ok(table(EVENT_CATALOG.map((info) => [info.event, info.kind, info.summary]), ["EVENT", "KIND", "WHAT IT MEANS"]));
      }
      case "templates": {
        if (id === undefined) {
          const entries = values.search === undefined ? deps.registry.list() : deps.registry.search(values.search);
          if (values.json) return json(entries);
          if (entries.length === 0) return ok(values.search === undefined ? "No templates." : `No templates match "${values.search}".`);
          const rows = entries.map((entry) => [entry.ref, entry.source, entry.template.author ?? "", entry.template.kind, entry.template.events.map(shortEvent).join(","), entry.template.summary]);
          const sources = deps.marketplace.sources().length;
          return ok(
            `${table(rows, ["TEMPLATE", "SOURCE", "AUTHOR", "KIND", "DEFAULT EVENTS", "WHAT IT DOES"])}\n\nDetails: bb hooks templates <template>   Create: bb hooks use <template> --set key=value` +
              (sources === 0 ? "\nMore: bb hooks marketplace add owner/repo" : ""),
          );
        }
        const resolved = deps.registry.resolve(id);
        if ("error" in resolved) return fail(resolved.error);
        return values.json ? json(resolved.entry) : ok(describeTemplate(resolved.entry, true));
      }
      case "use": {
        const ref = requireId("a template");
        if (typeof ref !== "string") return ref;
        const params = parseKeyValues(values.set, "--set");
        if ("error" in params) return fail(params.error);
        const match: NonNullable<HookInput["match"]> = {};
        if (values.project !== undefined) match.projectId = values.project;
        if (values.provider !== undefined) match.providerId = values.provider;
        if (values.title !== undefined) match.title = values.title;
        if (values.text !== undefined) match.text = values.text;
        const result = await useTemplate(deps, {
          ref,
          params: params.values,
          events: values.event as HookEvent[] | undefined,
          id: values.id,
          match,
          enabled: values.disabled ? false : undefined,
          description: values.description,
          trusted: values.yes === true,
        });
        if (!result.ok) {
          if (result.code === "untrusted" && result.entry !== undefined) return fail(`${result.message} Then add --yes:\n\n${describeTemplate(result.entry, true)}`);
          if (result.code === "invalid" && result.entry !== undefined) return fail(`${result.message}\n\n${describeTemplate(result.entry, false)}`);
          return fail(result.message);
        }
        if (values.json) return json({ hooks: result.hooks, secrets: result.secrets });
        const lines = result.hooks.map((hook) => `${result.replaced.includes(hook.id) ? "Replaced" : "Added"} hook "${hook.id}" on ${hook.event}${hook.match ? ` (${matchOf(hook)})` : ""}`);
        for (const name of result.secrets) lines.push(`Stored secret "${name}" (encrypted; rotate with: bb hooks secrets set ${name} <value>)`);
        const first = result.hooks[0];
        lines.push("", `Test it: bb hooks test ${first?.id ?? ""}   Inspect: bb hooks show ${first?.id ?? ""}`);
        if (result.entry.template.notes !== undefined) lines.push(`Note: ${result.entry.template.notes}`);
        return ok(lines.join("\n"));
      }
      case "marketplace": {
        const sub = id ?? "list";
        const arg = rest[0];
        switch (sub) {
          case "list": {
            const records = deps.marketplace.records();
            if (values.json) return json(records);
            const aliases = Object.entries(deps.marketplace.aliases());
            if (records.length === 0) {
              return ok(
                `No catalogs configured.\n\nAdd one: bb hooks marketplace add owner/repo   (a GitHub repo with ${"hooks-catalog.json"} at its root)\n` +
                  (aliases.length > 0 ? `Aliases: ${aliases.map(([name]) => name).join(", ")}\n` : "") +
                  "Publish your own: bb hooks marketplace init > hooks-catalog.json",
              );
            }
            return ok(table(records.map(formatCatalogRecord), ["CATALOG", "BY", "TEMPLATES", "FETCHED (UTC)", "STATUS", "URL"]));
          }
          case "add": {
            if (arg === undefined) return fail("bb hooks marketplace add needs a source: an https URL, owner/repo, or an alias");
            const result = await deps.marketplace.add(arg);
            if ("error" in result) return fail(result.error);
            if (values.json) return json(result.record);
            const count = result.record.catalog?.templates.length ?? 0;
            return ok(`Added catalog "${result.record.catalog?.name ?? "?"}" (${count} template${count === 1 ? "" : "s"}) from ${result.record.url}\n\nBrowse: bb hooks templates --search <text>   Install: bb hooks use ${result.record.catalog?.name ?? "<catalog>"}/<template> --yes`);
          }
          case "remove": {
            if (arg === undefined) return fail("bb hooks marketplace remove needs a source");
            const result = await deps.marketplace.remove(arg);
            if ("error" in result) return fail(result.error);
            if (!result.removed) return fail(`"${arg}" is not a configured catalog. Run "bb hooks marketplace list".`);
            return values.json ? json({ removed: true }) : ok(`Removed catalog ${arg}.`);
          }
          case "refresh": {
            const result = await deps.marketplace.refresh(arg);
            if ("error" in result) return fail(result.error);
            if (values.json) return json(result);
            if (result.length === 0) return ok("No catalogs configured.");
            return ok(table(result.map(formatCatalogRecord), ["CATALOG", "BY", "TEMPLATES", "FETCHED (UTC)", "STATUS", "URL"]));
          }
          case "search": {
            const query = [arg, ...rest.slice(1)].filter((part) => part !== undefined).join(" ");
            if (query.trim() === "") return fail("bb hooks marketplace search needs some text");
            const entries = deps.registry.search(query);
            if (values.json) return json(entries);
            if (entries.length === 0) return ok(`No templates match "${query}".`);
            return ok(table(entries.map((entry) => [entry.ref, entry.source, entry.template.kind, entry.template.summary]), ["TEMPLATE", "SOURCE", "KIND", "WHAT IT DOES"]));
          }
          case "validate": {
            if (arg === undefined) return fail("bb hooks marketplace validate needs a source");
            const result = await deps.marketplace.validate(arg);
            if ("error" in result) return fail(`Invalid: ${result.error}`);
            if (values.json) return json(result);
            const names = result.catalog.templates.map((template) => `${result.catalog.name}/${template.id}`);
            return ok(`Valid catalog "${result.catalog.name}" at ${result.url}: ${names.length} template${names.length === 1 ? "" : "s"}\n${names.map((name) => `  ${name}`).join("\n")}`);
          }
          case "init":
            return ok(starterCatalogJson(values.name));
          default:
            return fail(`Unknown marketplace command "${sub}".\n\n${USAGE}`);
        }
      }
      case "secrets": {
        const sub = id ?? "list";
        const name = rest[0];
        switch (sub) {
          case "list": {
            const hooks = await deps.store.list();
            const usage = new Map<string, number>();
            for (const hook of hooks) for (const ref of hookSecretRefs(hook)) usage.set(ref, (usage.get(ref) ?? 0) + 1);
            const secrets = deps.secrets.list().map((secret) => ({ ...secret, usedBy: usage.get(secret.name) ?? 0 }));
            if (values.json) return json(secrets);
            if (secrets.length === 0) return ok("No secrets. Set one with: bb hooks secrets set <name> <value>, then reference it as {{secret:<name>}}.");
            return ok(
              table(
                secrets.map((secret) => [secret.name, secret.managed ? "template" : "manual", String(secret.usedBy), new Date(secret.updatedAt).toISOString().slice(0, 10)]),
                ["NAME", "CREATED BY", "USED BY HOOKS", "UPDATED"],
              ),
            );
          }
          case "set": {
            const value = rest[1];
            if (name === undefined || value === undefined) return fail("bb hooks secrets set needs a name and a value");
            try {
              deps.secrets.set(name, value);
            } catch (cause) {
              return fail((cause as Error).message);
            }
            return values.json ? json({ name }) : ok(`Stored secret "${name}" (encrypted). Reference it as {{secret:${name}}}.`);
          }
          case "remove": {
            if (name === undefined) return fail("bb hooks secrets remove needs a name");
            if (!deps.secrets.remove(name)) return fail(`No secret "${name}".`);
            return values.json ? json({ removed: true }) : ok(`Removed secret "${name}".`);
          }
          default:
            return fail(`Unknown secrets command "${sub}".\n\n${USAGE}`);
        }
      }
      case "show": {
        const hookId = requireId();
        if (typeof hookId !== "string") return hookId;
        const hook = await deps.store.get(hookId);
        if (hook === null) return notFound(hookId);
        return json(hook);
      }
      case "export": {
        const hookId = requireId();
        if (typeof hookId !== "string") return hookId;
        const hook = await deps.store.get(hookId);
        if (hook === null) return notFound(hookId);
        return json(hookToTemplate(hook));
      }
      case "add":
      case "edit": {
        const hookId = requireId();
        if (typeof hookId !== "string") return hookId;
        if (rest.length > 0) return fail(`unexpected argument "${rest[0]}"; quote values that contain spaces\n\n${USAGE}`);
        const existing = await deps.store.get(hookId);
        if (command === "edit" && existing === null) return notFound(hookId);
        const input = buildHook(hookId, values, command === "edit" ? existing : null);
        if ("error" in input) return fail(input.error);
        const validated = hookSchema.safeParse(input);
        if (!validated.success) return fail(`Invalid hook: ${formatIssues(validated.error)}`);
        const { created } = await deps.store.upsert(validated.data);
        if (values.json) return json(validated.data);
        const verb = command === "edit" ? "Updated" : created ? "Added" : "Replaced";
        const note = isGateEvent(validated.data.event)
          ? `\nGate hooks answer within ${effectiveTimeoutMs(validated.data)} ms: exit 0 proceeds, 2 rejects, 3 waits.`
          : "";
        return ok(`${verb} hook "${validated.data.id}" on ${validated.data.event}: ${compactTarget(validated.data)}${note}`);
      }
      case "remove": {
        const hookId = requireId();
        if (typeof hookId !== "string") return hookId;
        const result = await removeHook(deps, hookId);
        if (!result.removed) return notFound(hookId);
        const dropped = result.secretsRemoved;
        if (values.json) return json({ removed: true, id: hookId, secretsRemoved: dropped });
        return ok(`Removed hook "${hookId}".${dropped.length > 0 ? ` Removed unused secret${dropped.length === 1 ? "" : "s"} ${dropped.join(", ")}.` : ""}`);
      }
      case "enable":
      case "disable": {
        const hookId = requireId();
        if (typeof hookId !== "string") return hookId;
        const hook = await deps.store.setEnabled(hookId, command === "enable");
        if (hook === null) return notFound(hookId);
        return values.json ? json(hook) : ok(`${command === "enable" ? "Enabled" : "Disabled"} hook "${hookId}".`);
      }
      case "test": {
        const hookId = requireId();
        if (typeof hookId !== "string") return hookId;
        const hook = await deps.store.get(hookId);
        if (hook === null) return notFound(hookId);
        const threadId = values.thread ?? ctx.threadId ?? null;
        let result: TestResult;
        try {
          result = await deps.test(hook, threadId, ctx.signal);
        } catch (cause) {
          return fail(`Test failed: ${(cause as Error).message}`);
        }
        if (values.json) return json({ hook, payload: result.payload, env: result.env, outcome: result.outcome, decision: result.decision });
        const source = threadId === null ? "a sample payload" : `thread ${threadId}`;
        return {
          exitCode: result.outcome.status === "ok" ? 0 : 1,
          stdout: `Ran with ${source}.\n${formatRun(result, hook)}`,
        };
      }
      case "history": {
        if (id === "clear") {
          const removed = deps.history.clear();
          return values.json ? json({ removed }) : ok(`Cleared ${removed} run${removed === 1 ? "" : "s"}.`);
        }
        const limit = values.limit === undefined ? 20 : Number(values.limit);
        if (!Number.isInteger(limit) || limit < 1) return fail(`--limit must be a positive integer, got "${values.limit}"`);
        const { runs } = deps.history.list({ limit, hookId: values.hook });
        if (values.json) return json(runs);
        if (runs.length === 0) return ok("No hook runs recorded yet.");
        const rows = runs.map((run) => [
          new Date(run.startedAt).toISOString().replace("T", " ").slice(0, 19),
          run.hookId,
          run.event,
          run.threadId ?? "",
          run.status + (run.exitCode !== null ? ` (${run.exitCode})` : run.httpStatus !== null ? ` (${run.httpStatus})` : ""),
          `${run.durationMs} ms`,
          run.decision ?? "",
          (run.error ?? run.output).replace(/\s+/g, " ").trim().slice(0, 60),
        ]);
        return ok(table(rows, ["WHEN (UTC)", "HOOK", "EVENT", "THREAD", "STATUS", "TIME", "DECISION", "OUTPUT"]));
      }
      default:
        return fail(`Unknown command "${command}".\n\n${USAGE}`);
    }
    } catch (cause) {
      return fail((cause as Error).message);
    }
  };
}
