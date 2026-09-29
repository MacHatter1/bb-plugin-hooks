// bb-plugin-hooks — custom hooks for BB.
//
// Users define hooks (a shell command or a webhook URL bound to a BB event)
// in the `hooks` setting or with `bb hooks add`. Observe-only lifecycle
// events fan out to matching hooks after the fact; the `message.dispatch`
// checkpoint runs matching gate hooks and acts on their answer.
import { execFileSync } from "node:child_process";
import type { BbPluginApi, MessageDispatchHookContext, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CATALOG_MIGRATIONS, createCatalogCache, createRegistry, fetchCatalog, parseSourceInput, type CatalogRecord } from "./src/catalog.js";
import { removeHook, useTemplate } from "./src/actions.js";
import { CLI_COMMANDS, createCliRun, type MarketplaceOps, type TestResult } from "./src/cli.js";
import {
  EVENT_CATALOG,
  GATE_TIMEOUT_CEILING_MS,
  OBSERVE_EVENTS,
  effectiveTimeoutMs,
  isGateEvent,
  matches,
  parseHooksJson,
  type HookDefinition,
  type ObserveEvent,
} from "./src/definitions.js";
import { prepareDispatch, prepareObserveEvent, prepareSample, type PreparedEvent, type ThreadFacts } from "./src/payload.js";
import { createRunner, decide, describeDecision, type Decision, type RunOutcome, type Runner } from "./src/runner.js";
import { rpcContract } from "./src/rpc.js";
import { SECRET_MIGRATIONS, createSecretStore, generateKey, hookSecretRefs, type SecretStore } from "./src/secrets.js";
import { SHARE_INSTALLS, type InstallStats, type ShareInstalls } from "./src/stats.js";
import { sendInstallReport } from "./src/stats-report.js";
import { HISTORY_MIGRATIONS, createHistoryStore, createHookStore, type HookStore } from "./src/store.js";

export { type HookDefinition } from "./src/definitions.js";
export { rpcContract } from "./src/rpc.js";

/** Realtime channel the marketplace page listens on; fired after any change. */
const CHANGED = "hooks-changed";

/** Total time the dispatch handler may spend; core fails the attempt at 10 s. */
const DISPATCH_BUDGET_MS = 8_500;

/** Absolute path to `bb` for command hooks, when this process can see one. */
function resolveBbCli(): string | null {
  const fromEnv = process.env.BB_CLI?.trim();
  if (fromEnv) return fromEnv;
  try {
    const bin = process.platform === "win32" ? "where.exe" : "which";
    const found = execFileSync(bin, ["bb"], { encoding: "utf8", timeout: 1_000, windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "");
    return found ?? null;
  } catch {
    return null;
  }
}

const hooksSettingSchema = z.string().superRefine((value, ctx) => {
  const parsed = parseHooksJson(value);
  if ("error" in parsed) ctx.addIssue({ code: "custom", message: parsed.error });
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hooks: {
      type: "string",
      label: "Advanced: hooks as JSON",
      description:
        "The raw list behind the Hooks page, for copying, pasting or version control. Manage hooks on the Hooks page or with `bb hooks` instead of editing this by hand.",
      experimental_multiline: true,
      experimental_schema: hooksSettingSchema,
      default: "[]",
    },
    enabled: { type: "boolean", label: "Run hooks", description: "Master switch. Off keeps definitions but runs nothing.", default: true },
    historyLimit: {
      type: "number",
      label: "Runs to keep in history",
      experimental_schema: z.number().int().min(0).max(10_000),
      default: 200,
    },
    maxConcurrent: {
      type: "number",
      label: "Max concurrent hook runs",
      description: "Applies after reload.",
      experimental_schema: z.number().int().min(1).max(64),
      default: 8,
    },
    webhookSecret: {
      type: "string",
      label: "Webhook signing secret",
      description: "When set, url hooks carry x-bb-hooks-signature (HMAC-SHA256 of `<timestamp>.<body>`).",
      secret: true,
    },
    catalogs: {
      type: "string",
      label: "Marketplace catalogs",
      description: "One per line: an https URL of a hooks-catalog.json, or a GitHub owner/repo. `bb hooks marketplace add` writes here too.",
      experimental_multiline: true,
      default: "MacHatter1/bb-hooks-marketplace",
    },
    shareInstalls: {
      type: "select",
      label: "Share anonymous install counts",
      description:
        "Counts installs from the BB Hooks Marketplace catalog only. When on, each new install from it sends the template id and version, and nothing else. ask: BB asks on your first such install.",
      options: [...SHARE_INSTALLS],
      default: "ask",
    },
    secretsKey: {
      type: "string",
      label: "Secrets encryption key",
      description: "Generated automatically; encrypts values stored by `bb hooks secrets`. Changing it makes existing secrets unreadable.",
      secret: true,
    },
  });

  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
  });

  function notify(kind: string): void {
    try {
      bb.realtime.publish(CHANGED, { kind });
    } catch (cause) {
      bb.log.debug(`realtime publish failed: ${(cause as Error).message}`);
    }
  }
  const rawStore = createHookStore(settings, (message) => bb.log.warn(`hooks setting ignored: ${message}`));
  const store: HookStore = {
    ...rawStore,
    async upsert(hook) {
      const result = await rawStore.upsert(hook);
      notify("hooks");
      return result;
    },
    async remove(id) {
      const result = await rawStore.remove(id);
      if (result) notify("hooks");
      return result;
    },
    async setEnabled(id, enabled) {
      const result = await rawStore.setEnabled(id, enabled);
      if (result !== null) notify("hooks");
      return result;
    },
  };
  const initial = await store.list();
  const invalid = store.lastError();
  if (invalid !== null) bb.log.warn(`no hooks are active until the hooks setting is fixed: ${invalid}`);
  else bb.log.info(`loaded ${initial.length} hook${initial.length === 1 ? "" : "s"}`);

  const db = bb.storage.database();
  bb.storage.migrate(db, [...HISTORY_MIGRATIONS, ...SECRET_MIGRATIONS, ...CATALOG_MIGRATIONS]);
  const history = createHistoryStore(db);

  let secretsKey = current.secretsKey;
  if (secretsKey === undefined || secretsKey === "") {
    secretsKey = generateKey();
    await settings.experimental_set({ secretsKey });
  }
  const rawSecrets = createSecretStore(db, secretsKey);
  const secrets: SecretStore = {
    ...rawSecrets,
    set(name, value, options) {
      rawSecrets.set(name, value, options);
      notify("secrets");
    },
    remove(name) {
      const removed = rawSecrets.remove(name);
      if (removed) notify("secrets");
      return removed;
    },
    gcManaged(referenced) {
      const removed = rawSecrets.gcManaged(referenced);
      if (removed.length > 0) notify("secrets");
      return removed;
    },
  };

  // --- Marketplace: every template comes from a catalog in the `catalogs` setting.
  // Fetched documents are cached in the database. The plugin ships none of its own.
  const catalogCache = createCatalogCache(db);
  function aliases(): Record<string, string> {
    return {};
  }
  function sourceLines(): string[] {
    return current.catalogs
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  }
  function configuredUrls(): string[] {
    const urls: string[] = [];
    for (const line of sourceLines()) {
      const parsed = parseSourceInput(line, aliases());
      if ("url" in parsed && !urls.includes(parsed.url)) urls.push(parsed.url);
      else if ("error" in parsed) bb.log.warn(`catalogs setting: ${parsed.error}`);
    }
    return urls;
  }
  function records(): CatalogRecord[] {
    const urls = configuredUrls();
    return urls.map((url) => catalogCache.get(url) ?? { url, name: null, etag: null, fetchedAt: null, catalog: null, error: "not fetched yet" });
  }
  const registry = createRegistry([], () => records());

  async function refreshUrl(url: string, signal?: AbortSignal): Promise<CatalogRecord> {
    const previous = catalogCache.get(url);
    const result = await fetchCatalog(url, { etag: previous?.etag ?? null, signal });
    let record: CatalogRecord;
    if (result.status === "ok") {
      record = { url, name: result.catalog.name, etag: result.etag, fetchedAt: Date.now(), catalog: result.catalog, error: null };
    } else if (result.status === "not-modified" && previous !== null) {
      record = { ...previous, fetchedAt: Date.now(), error: null };
    } else {
      const message = result.status === "error" ? result.message : "not modified but nothing cached";
      record = { url, name: previous?.name ?? null, etag: previous?.etag ?? null, fetchedAt: previous?.fetchedAt ?? null, catalog: previous?.catalog ?? null, error: message };
      bb.log.warn(`catalog ${url}: ${message}`);
    }
    try {
      catalogCache.put(record);
    } catch (cause) {
      bb.log.debug(`catalog cache write skipped: ${(cause as Error).message}`);
      return record;
    }
    notify("catalogs");
    return record;
  }
  async function refreshAll(signal?: AbortSignal): Promise<CatalogRecord[]> {
    const out: CatalogRecord[] = [];
    for (const url of configuredUrls()) {
      if (signal?.aborted) break;
      out.push(await refreshUrl(url, signal));
    }
    return out;
  }

  const marketplace: MarketplaceOps = {
    sources: () => configuredUrls(),
    aliases,
    records,
    async add(input) {
      const parsed = parseSourceInput(input, aliases());
      if ("error" in parsed) return parsed;
      const record = await refreshUrl(parsed.url);
      if (record.catalog === null) return { error: `could not load catalog from ${parsed.url}: ${record.error ?? "unknown error"}` };
      if (!configuredUrls().includes(parsed.url)) {
        const lines = sourceLines();
        lines.push(input.trim());
        await settings.experimental_set({ catalogs: lines.join("\n") });
      }
      return { record };
    },
    async remove(input) {
      const parsed = parseSourceInput(input, aliases());
      if ("error" in parsed) return parsed;
      const before = sourceLines();
      const after = before.filter((line) => {
        const candidate = parseSourceInput(line, aliases());
        return !("url" in candidate && candidate.url === parsed.url);
      });
      if (after.length === before.length) return { removed: false };
      await settings.experimental_set({ catalogs: after.join("\n") });
      catalogCache.remove(parsed.url);
      notify("catalogs");
      return { removed: true };
    },
    async refresh(input) {
      if (input === undefined) return refreshAll();
      const parsed = parseSourceInput(input, aliases());
      if ("error" in parsed) return parsed;
      if (!configuredUrls().includes(parsed.url)) return { error: `"${input}" is not a configured catalog. Run "bb hooks marketplace list".` };
      return [await refreshUrl(parsed.url)];
    },
    async validate(input) {
      const parsed = parseSourceInput(input, aliases());
      if ("error" in parsed) return parsed;
      const result = await fetchCatalog(parsed.url);
      if (result.status === "ok") return { url: parsed.url, catalog: result.catalog };
      return { error: result.status === "error" ? result.message : "not modified" };
    },
  };

  bb.background.service("catalog-refresh", {
    async start(signal) {
      await refreshAll(signal);
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 6 * 60 * 60 * 1000);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (!signal.aborted) await refreshAll(signal);
      }
    },
  });
  settings.onChange((next, prev) => {
    if (next.catalogs !== prev.catalogs) void refreshAll();
    if (next.hooks !== prev.hooks || next.enabled !== prev.enabled || next.shareInstalls !== prev.shareInstalls) notify("settings");
  });

  // Gate hooks get their own lane so a burst of slow observe hooks can never
  // push a dispatch decision past core's deadline.
  const observeRunner = createRunner({ maxConcurrent: current.maxConcurrent });
  const gateRunner = createRunner({ maxConcurrent: 4 });

  function serverUrl(): string | null {
    try {
      return bb.server.loopbackBaseUrl;
    } catch {
      return null;
    }
  }

  const bbCli = resolveBbCli();

  /** Exactly what a hook receives: the JSON payload and the BB_* environment. */
  function buildDelivery(hook: HookDefinition, prepared: PreparedEvent, startedAt: number): { payload: Record<string, unknown>; env: Record<string, string> } {
    const url = serverUrl();
    return {
      payload: {
        event: prepared.event,
        hookId: hook.id,
        timestamp: new Date(startedAt).toISOString(),
        serverUrl: url,
        ...prepared.payload,
      },
      env: {
        ...prepared.env,
        BB_HOOK_ID: hook.id,
        ...(url === null ? {} : { BB_SERVER_URL: url }),
        ...(bbCli === null ? {} : { BB_CLI: bbCli }),
      },
    };
  }

  async function execute(
    hook: HookDefinition,
    prepared: PreparedEvent,
    options: { runner: Runner; timeoutMs?: number; signal?: AbortSignal; label?: string } = { runner: observeRunner },
  ): Promise<RunOutcome> {
    const startedAt = Date.now();
    const outcome = await options.runner.run({
      hook,
      ...buildDelivery(hook, prepared, startedAt),
      timeoutMs: options.timeoutMs ?? effectiveTimeoutMs(hook),
      webhookSecret: current.webhookSecret,
      secrets: (name) => secrets.get(name),
      signal: options.signal,
    });
    const decision = isGateEvent(hook.event) ? decide(hook, outcome).decision : null;
    record(hook, prepared, outcome, decision, startedAt, options.label);
    if (outcome.status !== "ok") {
      bb.log.warn(`hook "${hook.id}" (${prepared.event}) ${outcome.status}: ${outcome.error ?? "unknown"}${outcome.stderr.trim() === "" ? "" : ` — ${outcome.stderr.trim().slice(0, 300)}`}`);
    } else {
      bb.log.debug(`hook "${hook.id}" (${prepared.event}) ok in ${outcome.durationMs} ms`);
    }
    return outcome;
  }

  function record(hook: HookDefinition, prepared: PreparedEvent, outcome: RunOutcome, decision: Decision | null, startedAt: number, label?: string) {
    if (current.historyLimit <= 0) return;
    try {
      history.record({
        hookId: hook.id,
        event: label === undefined ? prepared.event : `${prepared.event} ${label}`,
        threadId: prepared.threadId,
        startedAt,
        durationMs: outcome.durationMs,
        status: outcome.status,
        exitCode: outcome.exitCode,
        httpStatus: outcome.httpStatus,
        decision: decision === null ? null : describeDecision(decision),
        output: [outcome.stdout, outcome.stderr].filter((part) => part.trim() !== "").join("\n--- stderr\n"),
        error: outcome.error,
      });
      history.prune(current.historyLimit);
      notify("history");
    } catch (cause) {
      bb.log.warn(`could not record hook run: ${(cause as Error).message}`);
    }
  }

  async function activeHooks(event: HookDefinition["event"]): Promise<HookDefinition[]> {
    if (!current.enabled) return [];
    return (await store.list()).filter((hook) => hook.enabled && hook.event === event);
  }

  async function lookupThread(threadId: string): Promise<ThreadFacts | null> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return {
        id: thread.id,
        projectId: thread.projectId,
        providerId: thread.providerId,
        title: thread.title,
        titleFallback: thread.titleFallback,
        status: thread.status,
        parentThreadId: thread.parentThreadId,
        environmentId: thread.environmentId,
      };
    } catch (cause) {
      bb.log.debug(`could not load thread ${threadId} for hook payload: ${(cause as Error).message}`);
      return null;
    }
  }

  const EXECUTION_VARS = /BB_(MODEL|REASONING_LEVEL|SERVICE_TIER|PERMISSION_MODE)\b/;

  /**
   * The triggering thread's current execution settings, for hooks that
   * mention them (an "inherit" agent, for one). One SDK call per run, only
   * when a matching hook asks for it.
   */
  async function executionEnv(threadId: string): Promise<Record<string, string>> {
    try {
      const options = await bb.sdk.threads.defaultExecutionOptions({ threadId });
      if (options === null) return {};
      return { BB_MODEL: options.model, BB_REASONING_LEVEL: options.reasoningLevel, BB_SERVICE_TIER: options.serviceTier, BB_PERMISSION_MODE: options.permissionMode };
    } catch (cause) {
      bb.log.debug(`could not load execution options for ${threadId}: ${(cause as Error).message}`);
      return {};
    }
  }

  function wantsExecution(hook: HookDefinition): boolean {
    return [hook.command, hook.url, hook.body, ...Object.values(hook.headers ?? {})].some((text) => text !== undefined && EXECUTION_VARS.test(text));
  }

  /** Thread id for payloads that carry one without the thread DTO. */
  function referencedThreadId(payload: Record<string, unknown>): string | null {
    if (typeof payload.threadId === "string") return payload.threadId;
    const entry = payload.entry as { threadId?: unknown } | undefined;
    if (typeof entry?.threadId === "string") return entry.threadId;
    const terminal = payload.terminal as { threadId?: unknown } | undefined;
    if (typeof terminal?.threadId === "string") return terminal.threadId;
    return null;
  }

  async function handleObserve<E extends ObserveEvent>(event: E, payload: PluginThreadEventPayloads[E]): Promise<void> {
    const hooks = await activeHooks(event);
    if (hooks.length === 0) return;
    const record = payload as Record<string, unknown>;
    let fetched: ThreadFacts | null = null;
    if (typeof record.thread !== "object" || record.thread === null) {
      const threadId = referencedThreadId(record);
      if (threadId !== null) fetched = await lookupThread(threadId);
    }
    const prepared = prepareObserveEvent(event, payload, fetched);
    const matching = hooks.filter((hook) => matches(hook, prepared.subject));
    if (prepared.threadId !== null && matching.some(wantsExecution)) Object.assign(prepared.env, await executionEnv(prepared.threadId));
    await Promise.all(matching.map((hook) => execute(hook, prepared)));
  }

  function listen<E extends ObserveEvent>(event: E): void {
    bb.events.on(event, (payload) => handleObserve(event, payload));
  }
  for (const event of OBSERVE_EVENTS) listen(event);

  bb.experimental_hooks.on("message.dispatch", async (ctx: MessageDispatchHookContext) => {
    const deadline = Date.now() + DISPATCH_BUDGET_MS;
    try {
      const hooks = await activeHooks("message.dispatch");
      if (hooks.length === 0) return { action: "proceed" };
      const prepared = prepareDispatch(ctx);
      const waits: string[] = [];
      let sendAt: number | null = null;
      for (const hook of hooks) {
        if (!matches(hook, prepared.subject)) continue;
        const remaining = deadline - Date.now();
        let decision: Decision;
        if (remaining < 250) {
          const startedAt = Date.now();
          const outcome: RunOutcome = { status: "timeout", exitCode: null, httpStatus: null, stdout: "", stderr: "", durationMs: 0, error: "dispatch budget exhausted" };
          decision = decide(hook, outcome).decision;
          record(hook, prepared, outcome, decision, startedAt);
          bb.log.warn(`hook "${hook.id}" skipped: dispatch budget exhausted by earlier gate hooks`);
        } else {
          const outcome = await execute(hook, prepared, {
            runner: gateRunner,
            timeoutMs: Math.min(effectiveTimeoutMs(hook), remaining, GATE_TIMEOUT_CEILING_MS),
          });
          decision = decide(hook, outcome).decision;
        }
        if (decision.action === "reject") {
          bb.log.info(`hook "${hook.id}" rejected dispatch on ${ctx.thread.id}: ${decision.message}`);
          return decision;
        }
        if (decision.action === "wait") {
          waits.push(decision.reason);
          if (typeof decision.sendAt === "number" && (sendAt === null || decision.sendAt < sendAt)) sendAt = decision.sendAt;
        }
      }
      if (waits.length > 0) return { action: "wait", reason: waits.join("; "), sendAt };
      return { action: "proceed" };
    } catch (cause) {
      // Never throw: core would fail the user's message with this plugin named.
      bb.log.error(`message.dispatch hooks failed, letting the message through: ${(cause as Error).message}`);
      return { action: "proceed" };
    }
  });

  async function test(hook: HookDefinition, threadId: string | null, signal?: AbortSignal): Promise<TestResult> {
    let thread: ThreadFacts | null = null;
    if (threadId !== null) {
      thread = await lookupThread(threadId);
      if (thread === null) throw new Error(`thread ${threadId} not found`);
    }
    const prepared = prepareSample(hook.event, thread);
    if (thread !== null && wantsExecution(hook)) Object.assign(prepared.env, await executionEnv(thread.id));
    const gate = isGateEvent(hook.event);
    const startedAt = Date.now();
    const outcome = await execute(hook, prepared, { runner: gate ? gateRunner : observeRunner, signal, label: "(test)" });
    return { ...buildDelivery(hook, prepared, startedAt), outcome, decision: gate ? decide(hook, outcome).decision : null };
  }

  const stats: InstallStats = {
    consent: () => ((SHARE_INSTALLS as readonly string[]).includes(current.shareInstalls ?? "") ? (current.shareInstalls as ShareInstalls) : "ask"),
    async setConsent(value) {
      await settings.experimental_set({ shareInstalls: value });
    },
    report(body) {
      void sendInstallReport(body).then((sent) => {
        if (!sent) bb.log.debug(`install count for ${body.catalog}/${body.template} was not accepted`);
      });
    },
  };
  const actionDeps = { store, secrets, registry, stats };
  bb.rpc.register(rpcContract, {
    async overview() {
      const hooks = await store.list();
      const usage = new Map<string, number>();
      for (const hook of hooks) for (const ref of hookSecretRefs(hook)) usage.set(ref, (usage.get(ref) ?? 0) + 1);
      return {
        enabled: current.enabled,
        shareInstalls: stats.consent(),
        hooks,
        hooksError: store.lastError(),
        templates: registry.list(),
        catalogs: records(),
        secrets: secrets.list().map((secret) => ({ ...secret, usedBy: usage.get(secret.name) ?? 0 })),
        events: [...EVENT_CATALOG],
        aliases: aliases(),
      };
    },
    async template_use(input) {
      const result = await useTemplate(actionDeps, input);
      if (!result.ok) throw new Error(result.message);
      return { hooks: result.hooks, replaced: result.replaced, secrets: result.secrets };
    },
    async hook_save(hook) {
      await store.upsert(hook);
      return hook;
    },
    async hook_set_enabled({ id, enabled }) {
      const hook = await store.setEnabled(id, enabled);
      if (hook === null) throw new Error(`No hook with id "${id}"`);
      return hook;
    },
    async settings_set_enabled({ enabled }) {
      const next = await settings.experimental_set({ enabled });
      return { enabled: next.enabled };
    },
    history_clear() {
      const removed = history.clear();
      notify("history");
      return { removed };
    },
    hook_remove: ({ id }) => removeHook(actionDeps, id),
    async hook_test({ id, threadId }) {
      const hook = await store.get(id);
      if (hook === null) throw new Error(`No hook with id "${id}"`);
      const result = await test(hook, threadId ?? null);
      return { outcome: result.outcome, decision: result.decision, payload: result.payload };
    },
    history_list: ({ limit, offset, hookId, status }) => history.list({ limit, offset, hookId, status }),
    async catalog_add({ source }) {
      const result = await marketplace.add(source);
      if ("error" in result) throw new Error(result.error);
      return result.record;
    },
    async catalog_remove({ source }) {
      const result = await marketplace.remove(source);
      if ("error" in result) throw new Error(result.error);
      return result;
    },
    async catalog_refresh({ source }) {
      const result = await marketplace.refresh(source);
      if ("error" in result) throw new Error(result.error);
      return result;
    },
    secret_set({ name, value }) {
      secrets.set(name, value);
      return { name };
    },
    secret_remove: ({ name }) => ({ removed: secrets.remove(name) }),
  });

  bb.cli.register({
    name: "hooks",
    summary: "Create custom hooks: run a shell command or webhook on BB thread events, or gate message dispatch",
    commands: CLI_COMMANDS,
    run: createCliRun({ store, history, secrets, registry, marketplace, stats, test }),
  });

  bb.onDispose(() => {
    observeRunner.dispose();
    gateRunner.dispose();
  });
}
