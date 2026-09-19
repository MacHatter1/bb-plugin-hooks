import { createServer, type Server } from "node:http";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin from "../server.js";
import { catalogSchema, createRegistry, fetchCatalog, parseSourceInput, starterCatalogJson, type Catalog } from "../src/catalog.js";
import { STARTER_CATALOG } from "../src/community-catalog.js";
import { hookToTemplate } from "../src/cli.js";
import { hookSchema } from "../src/definitions.js";
import { TEMPLATES, templateSchema } from "../src/templates.js";

const remote: Catalog = {
  name: "acme",
  description: "Acme's hooks",
  templates: [
    {
      id: "pager",
      name: "Page on-call",
      summary: "Page the on-call engineer when a thread fails.",
      kind: "observe",
      events: ["thread.failed"],
      params: [{ key: "routingKey", label: "Routing key", type: "string", required: true, secret: true }],
      url: "https://events.acme.test/v2/enqueue",
      body: '{"routing_key":"{{routingKey}}","summary":"{{thread.title}}"}',
    },
    {
      id: "desktop-notify",
      name: "Acme notify",
      summary: "Same id as a bundled template, to test disambiguation.",
      kind: "observe",
      events: ["thread.idle"],
      params: [],
      command: "echo acme",
    },
  ],
};

describe("catalog documents", () => {
  it("validates the bundled templates, the starter catalog and the init document", () => {
    for (const template of TEMPLATES) expect(templateSchema.safeParse(template).success, template.id).toBe(true);
    expect(catalogSchema.safeParse(STARTER_CATALOG).success).toBe(true);
    expect(catalogSchema.safeParse(JSON.parse(starterCatalogJson("mine"))).success).toBe(true);
  });

  it("rejects broken catalogs", () => {
    expect(catalogSchema.safeParse({ name: "Bad Name", templates: [] }).success).toBe(false);
    expect(catalogSchema.safeParse({ name: "x", templates: [remote.templates[0], remote.templates[0]] }).success).toBe(false);
    expect(templateSchema.safeParse({ ...remote.templates[1], events: ["message.dispatch"] }).success).toBe(false);
    expect(templateSchema.safeParse({ ...remote.templates[1], url: "https://x" }).success).toBe(false);
    expect(templateSchema.safeParse({ ...remote.templates[1], params: [{ key: "n", label: "n", type: "integer", secret: true }] }).success).toBe(false);
  });

  it("turns hooks back into templates", () => {
    const hook = hookSchema.parse({ id: "notify", event: "thread.idle", url: "{{secret:notify/webhookUrl}}", body: '{"t":"{{thread.title}}"}', enabled: true, description: "Notify" });
    const template = hookToTemplate(hook);
    expect(template).toMatchObject({ id: "notify", kind: "observe", events: ["thread.idle"], url: "{{webhookUrl}}", params: [{ key: "webhookUrl", secret: true, required: true }] });
    expect(templateSchema.safeParse(template).success).toBe(true);
  });
});

describe("sources", () => {
  it("accepts https URLs, loopback http, GitHub shorthand and aliases", () => {
    expect(parseSourceInput("https://example.test/hooks-catalog.json")).toEqual({ url: "https://example.test/hooks-catalog.json" });
    expect(parseSourceInput("http://127.0.0.1:1234/c.json")).toEqual({ url: "http://127.0.0.1:1234/c.json" });
    expect(parseSourceInput("http://example.test/c.json")).toMatchObject({ error: expect.stringContaining("https") });
    expect(parseSourceInput("acme/bb-hooks")).toEqual({ url: "https://raw.githubusercontent.com/acme/bb-hooks/HEAD/hooks-catalog.json" });
    expect(parseSourceInput("acme/bb-hooks@v1.2")).toEqual({ url: "https://raw.githubusercontent.com/acme/bb-hooks/v1.2/hooks-catalog.json" });
    expect(parseSourceInput("starter", { starter: "http://127.0.0.1:1/x" })).toEqual({ url: "http://127.0.0.1:1/x" });
    expect(parseSourceInput("what is this")).toMatchObject({ error: expect.any(String) });
  });
});

describe("fetchCatalog", () => {
  it("parses, validates, honours etags and caps size", async () => {
    const ok = await fetchCatalog("https://x/c.json", { fetchImpl: async () => new Response(JSON.stringify(remote), { status: 200, headers: { etag: '"v1"' } }) });
    expect(ok).toMatchObject({ status: "ok", etag: '"v1"', catalog: { name: "acme" } });
    const notModified = await fetchCatalog("https://x/c.json", { etag: '"v1"', fetchImpl: async (_url, init) => new Response(null, { status: (init?.headers as Record<string, string>)["if-none-match"] === '"v1"' ? 304 : 200 }) });
    expect(notModified).toEqual({ status: "not-modified" });
    expect(await fetchCatalog("https://x/c.json", { fetchImpl: async () => new Response("nope", { status: 404 }) })).toEqual({ status: "error", message: "HTTP 404" });
    expect(await fetchCatalog("https://x/c.json", { fetchImpl: async () => new Response("{not json", { status: 200 }) })).toMatchObject({ status: "error", message: expect.stringContaining("not valid JSON") });
    expect(await fetchCatalog("https://x/c.json", { fetchImpl: async () => new Response(JSON.stringify({ name: "x" }), { status: 200 }) })).toMatchObject({ status: "error", message: expect.stringContaining("invalid") });
    expect(await fetchCatalog("https://x/c.json", { fetchImpl: async () => new Response("x".repeat(600 * 1024), { status: 200 }) })).toMatchObject({ status: "error", message: expect.stringContaining("larger") });
  });
});

describe("registry", () => {
  const registry = createRegistry(TEMPLATES, () => [{ url: "https://x/c.json", name: "acme", etag: null, fetchedAt: 1, catalog: remote, error: null }]);

  it("lists bundled and catalog templates with refs", () => {
    const refs = registry.list().map((entry) => entry.ref);
    expect(refs).toContain("slack");
    expect(refs).toContain("acme/pager");
    expect(refs).toContain("acme/desktop-notify");
  });

  it("resolves exact refs, unique bare ids, and reports ambiguity", () => {
    expect(registry.resolve("acme/pager")).toMatchObject({ entry: { source: "acme" } });
    expect(registry.resolve("pager")).toMatchObject({ entry: { ref: "acme/pager" } });
    expect(registry.resolve("desktop-notify")).toMatchObject({ entry: { source: "bundled" } });
    expect(registry.resolve("nope")).toMatchObject({ error: expect.stringContaining("No template") });
    expect(registry.search("on-call").map((entry) => entry.ref)).toEqual(["acme/pager"]);
  });
});

describe("bb hooks marketplace (live over loopback)", () => {
  let server: Server;
  let url = "";
  let served = 0;
  // The real plugin subscribes to its own `starter` catalog by default; start empty here.
  const { bb, harness } = createFakePluginHost({ pluginId: "hooks", settings: { catalogs: "" } });

  beforeAll(async () => {
    server = createServer((req, res) => {
      served += 1;
      if (req.url === "/hooks-catalog.json") {
        res.writeHead(200, { "content-type": "application/json", etag: '"one"' });
        res.end(JSON.stringify(remote));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    url = `http://127.0.0.1:${address.port}/hooks-catalog.json`;
    await plugin(bb);
  });
  afterAll(async () => {
    await harness.lifecycle.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("adds a catalog, lists it, and exposes its templates", async () => {
    expect((await harness.behavior.runCli(["marketplace", "list"])).stdout).toContain("No catalogs configured");
    const added = await harness.behavior.runCli(["marketplace", "add", url]);
    expect(added.exitCode, added.stderr).toBe(0);
    expect(added.stdout).toContain('Added catalog "acme" (2 templates)');
    const list = await harness.behavior.runCli(["marketplace", "list"]);
    expect(list.stdout).toContain("acme");
    expect(list.stdout).toContain(url);
    const templates = await harness.behavior.runCli(["templates", "--search", "on-call"]);
    expect(templates.stdout).toContain("acme/pager");
    expect((await harness.behavior.runCli(["marketplace", "search", "on-call"])).stdout).toContain("acme/pager");
    expect(await harness.behavior.runCli(["marketplace", "add", "http://127.0.0.1:1/nothing.json"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("could not load catalog") });
    expect(await harness.behavior.runCli(["marketplace", "validate", url])).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("acme/pager") });
    expect((await harness.behavior.runCli(["marketplace", "init", "--name", "mine"])).stdout).toContain('"name": "mine"');
  });

  it("requires --yes for catalog templates and stores secret params encrypted", async () => {
    const refused = await harness.behavior.runCli(["use", "acme/pager", "--set", "routingKey=abc123"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("--yes");
    expect(refused.stderr).toContain("POST https://events.acme.test/v2/enqueue");

    const used = await harness.behavior.runCli(["use", "acme/pager", "--set", "routingKey=abc123", "--yes"]);
    expect(used.exitCode, used.stderr).toBe(0);
    expect(used.stdout).toContain('Stored secret "pager/routingKey"');
    const shown = JSON.parse((await harness.behavior.runCli(["show", "pager"])).stdout);
    expect(shown.body).toBe('{"routing_key":"{{secret:pager/routingKey}}","summary":"{{thread.title}}"}');
    expect(JSON.stringify(shown)).not.toContain("abc123");
    expect(shown.template).toEqual({ id: "pager", source: "acme", params: {}, secrets: { routingKey: "pager/routingKey" } });

    const secrets = await harness.behavior.runCli(["secrets", "list"]);
    expect(secrets.stdout).toContain("pager/routingKey");
    expect(secrets.stdout).toContain("template");

    const removed = await harness.behavior.runCli(["remove", "pager"]);
    expect(removed.stdout).toContain("Removed unused secret pager/routingKey");
    expect((await harness.behavior.runCli(["secrets", "list"])).stdout).toContain("No secrets");
  });

  it("disambiguates ids shared with bundled templates", async () => {
    const bundled = await harness.behavior.runCli(["use", "desktop-notify", "--event", "thread.idle", "--id", "dn"]);
    expect(bundled.exitCode, bundled.stderr).toBe(0);
    expect(JSON.parse((await harness.behavior.runCli(["show", "dn"])).stdout).template.source).toBe("bundled");
    const external = await harness.behavior.runCli(["use", "acme/desktop-notify", "--id", "dn2", "--yes"]);
    expect(external.exitCode, external.stderr).toBe(0);
    expect(JSON.parse((await harness.behavior.runCli(["show", "dn2"])).stdout)).toMatchObject({ command: "echo acme", template: { source: "acme" } });
  });

  it("refreshes with etags and removes catalogs", async () => {
    const before = served;
    const refreshed = await harness.behavior.runCli(["marketplace", "refresh"]);
    expect(refreshed.exitCode).toBe(0);
    expect(served).toBe(before + 1);
    expect((await harness.behavior.runCli(["marketplace", "remove", url])).exitCode).toBe(0);
    expect((await harness.behavior.runCli(["templates"])).stdout).not.toContain("acme/pager");
    expect(await harness.behavior.runCli(["use", "acme/pager", "--yes"])).toMatchObject({ exitCode: 1 });
  });

  it("manages manual secrets and injects them into hooks", async () => {
    expect((await harness.behavior.runCli(["secrets", "set", "demo/token", "tok-1"])).exitCode).toBe(0);
    await harness.behavior.runCli(["add", "uses-secret", "--event", "thread.idle", "--command", "printf 'token=%s' {{secret:demo/token}}"]);
    const result = await harness.behavior.runCli(["test", "uses-secret"]);
    expect(result.stdout).toContain("token=tok-1");
    expect(result.stdout).not.toContain("BB_SECRET");
    const asJson = JSON.parse((await harness.behavior.runCli(["test", "uses-secret", "--json"])).stdout);
    expect(JSON.stringify(asJson.env)).not.toContain("tok-1");
    expect((await harness.behavior.runCli(["secrets", "remove", "demo/token"])).exitCode).toBe(0);
    expect((await harness.behavior.runCli(["test", "uses-secret"])).stdout).toContain('missing secret "demo/token"');
  });
});

describe("marketplace page RPC", () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "hooks", settings: { catalogs: "" } });
  beforeAll(async () => {
    await plugin(bb);
  });
  afterAll(async () => {
    await harness.lifecycle.dispose();
  });

  it("serves the overview the page renders", async () => {
    const overview = (await harness.behavior.callRpc("overview")) as { hooks: unknown[]; templates: { ref: string }[]; catalogs: unknown[]; secrets: unknown[]; events: unknown[]; enabled: boolean };
    expect(overview.enabled).toBe(true);
    expect(overview.hooks).toEqual([]);
    expect(overview.templates.map((entry) => entry.ref)).toContain("slack");
    expect(overview.events.length).toBe(15);
  });

  it("installs, tests, toggles and removes through RPC and announces changes", async () => {
    const before = harness.inspection.realtimeSignals.length;
    const installed = (await harness.behavior.callRpc("template_use", { ref: "slack", params: { webhookUrl: "https://hooks.slack.test/rpc" }, events: ["thread.idle"], trusted: false })) as { hooks: { id: string; url?: string }[]; secrets: string[] };
    expect(installed.hooks.map((hook) => hook.id)).toEqual(["slack"]);
    expect(installed.hooks[0]?.url).toBe("{{secret:slack/webhookUrl}}");
    expect(installed.secrets).toEqual(["slack/webhookUrl"]);
    expect(harness.inspection.realtimeSignals.length).toBeGreaterThan(before);
    expect(harness.inspection.realtimeSignals.at(-1)).toMatchObject({ channel: "hooks-changed" });

    const toggled = (await harness.behavior.callRpc("hook_set_enabled", { id: "slack", enabled: false })) as { enabled: boolean };
    expect(toggled.enabled).toBe(false);

    await harness.behavior.callRpc("secret_set", { name: "demo/token", value: "t" });
    const secrets = ((await harness.behavior.callRpc("overview")) as { secrets: { name: string; usedBy: number }[] }).secrets;
    expect(secrets.map((secret) => [secret.name, secret.usedBy])).toEqual([
      ["demo/token", 0],
      ["slack/webhookUrl", 1],
    ]);

    const removed = (await harness.behavior.callRpc("hook_remove", { id: "slack" })) as { removed: boolean; secretsRemoved: string[] };
    expect(removed).toEqual({ removed: true, secretsRemoved: ["slack/webhookUrl"] });
    await expect(harness.behavior.callRpc("template_use", { ref: "nope", params: {} })).rejects.toThrow(/No template/);
    await expect(harness.behavior.callRpc("template_use", { ref: "slack", params: {}, match: undefined })).rejects.toThrow();
  });

  it("runs a hook test and lists history through RPC", async () => {
    await harness.behavior.callRpc("template_use", { ref: "block-pattern", params: { pattern: "x" } });
    const result = (await harness.behavior.callRpc("hook_test", { id: "block-pattern" })) as { outcome: { status: string; exitCode: number | null }; decision: { action: string } | null; payload: { event: string } };
    expect(result.outcome).toMatchObject({ status: "ok", exitCode: 2 });
    expect(result.decision).toMatchObject({ action: "reject" });
    expect(result.payload.event).toBe("message.dispatch");
    const history = (await harness.behavior.callRpc("history_list", { limit: 5 })) as { hookId: string }[];
    expect(history[0]?.hookId).toBe("block-pattern");
  });
});

describe("page-only RPC methods", () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "hooks", settings: { catalogs: "" } });
  beforeAll(async () => {
    await plugin(bb);
  });
  afterAll(async () => {
    await harness.lifecycle.dispose();
  });

  it("saves hand-written hooks with the same validation as the setting", async () => {
    const saved = (await harness.behavior.callRpc("hook_save", { id: "mine", event: "thread.idle", command: "echo hi", description: "Mine" })) as { id: string; enabled: boolean };
    expect(saved).toMatchObject({ id: "mine", enabled: true });
    const listed = JSON.parse((await harness.behavior.runCli(["show", "mine"])).stdout);
    expect(listed).toMatchObject({ id: "mine", command: "echo hi", description: "Mine", enabled: true });
    await expect(harness.behavior.callRpc("hook_save", { id: "Bad Id", event: "thread.idle", command: "x" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("hook_save", { id: "no-target", event: "thread.idle" })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("command or a url") })]),
    });
    await expect(harness.behavior.callRpc("hook_save", { id: "bad-gate", event: "thread.idle", command: "x", onError: "reject" })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("onError") })]),
    });
  });

  it("flips the master switch and clears history", async () => {
    expect(((await harness.behavior.callRpc("overview")) as { enabled: boolean }).enabled).toBe(true);
    expect(await harness.behavior.callRpc("settings_set_enabled", { enabled: false })).toEqual({ enabled: false });
    expect(((await harness.behavior.callRpc("overview")) as { enabled: boolean }).enabled).toBe(false);
    await harness.behavior.callRpc("settings_set_enabled", { enabled: true });
    await harness.behavior.callRpc("hook_test", { id: "mine" });
    expect(((await harness.behavior.callRpc("history_list", { limit: 5 })) as unknown[]).length).toBe(1);
    expect(await harness.behavior.callRpc("history_clear")).toEqual({ removed: 1 });
    expect(((await harness.behavior.callRpc("history_list", { limit: 5 })) as unknown[]).length).toBe(0);
  });
});
