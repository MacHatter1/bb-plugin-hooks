import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin from "../server.js";
import { hookSchema, type HookDefinition } from "../src/definitions.js";
import { createRunner, decide } from "../src/runner.js";
import { renderBody } from "../src/template.js";
import { TEMPLATES, findTemplate, renderTemplate } from "../src/templates.js";

const dir = mkdtempSync(join(tmpdir(), "bb-hooks-templates-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function requiredParams(templateId: string): Record<string, string> {
  const template = findTemplate(templateId);
  if (template === null) throw new Error(`no template ${templateId}`);
  return Object.fromEntries(
    template.params
      .filter((param) => param.required)
      .map((param) => [param.key, /url|server/i.test(param.key) ? `https://example.test/${param.key}` : `value-for-${param.key}`]),
  );
}

function renderOne(templateId: string, params: Record<string, string> = requiredParams(templateId), options = {}): HookDefinition {
  const template = findTemplate(templateId);
  if (template === null) throw new Error(`no template ${templateId}`);
  const rendered = renderTemplate(template, params, options);
  if ("error" in rendered) throw new Error(rendered.error);
  const first = rendered.hooks[0];
  if (first === undefined) throw new Error("no hooks rendered");
  return hookSchema.parse(first);
}

describe("template catalog", () => {
  it("renders every template into valid hooks with only its required parameters", () => {
    for (const template of TEMPLATES) {
      const rendered = renderTemplate(template, requiredParams(template.id));
      expect(rendered, template.id).not.toHaveProperty("error");
      if ("error" in rendered) continue;
      expect(rendered.hooks.length).toBe(template.events.length);
      for (const hook of rendered.hooks) {
        const parsed = hookSchema.safeParse(hook);
        expect(parsed.success, `${template.id}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
        expect(hook.template).toMatchObject({ id: template.id, source: "bundled", params: expect.any(Object) });
        for (const param of template.params) {
          if (param.secret) expect(hook.template?.params).not.toHaveProperty(param.key);
        }
        // Every parameter placeholder is filled; `{{secret:…}}` resolves at run time and `body` keeps payload placeholders.
        const { body: _body, ...rest } = hook;
        expect(JSON.stringify(rest).replace(/\{\{secret:[^}]+\}\}/g, "")).not.toContain("{{");
        if (hook.body !== undefined) for (const param of template.params) expect(hook.body).not.toContain(`{{${param.key}}}`);
      }
    }
  });

  it("names multi-event hooks after their event and honours --event and --id", () => {
    const notify = findTemplate("desktop-notify")!;
    const all = renderTemplate(notify, {});
    if ("error" in all) throw new Error(all.error);
    expect(all.hooks.map((hook) => hook.id)).toEqual(["desktop-notify-interaction-pending", "desktop-notify-idle", "desktop-notify-failed"]);
    const one = renderTemplate(notify, {}, { id: "ping", events: ["thread.idle"] });
    if ("error" in one) throw new Error(one.error);
    expect(one.hooks.map((hook) => hook.id)).toEqual(["ping"]);
  });

  it("reports unknown, missing and malformed parameters", () => {
    expect(renderTemplate(findTemplate("slack")!, {})).toMatchObject({ error: expect.stringContaining("--set webhookUrl=") });
    expect(renderTemplate(findTemplate("slack")!, { webhookUrl: "https://x", nope: "1" })).toMatchObject({ error: expect.stringContaining("unknown parameter nope") });
    expect(renderTemplate(findTemplate("office-hours")!, { start: "nine" })).toMatchObject({ error: expect.stringContaining("must be an integer") });
    expect(renderTemplate(findTemplate("block-pattern")!, { pattern: "x" }, { events: ["thread.idle"] })).toMatchObject({ error: expect.stringContaining("gate hook") });
    expect(renderTemplate(findTemplate("slack")!, { webhookUrl: "https://x" }, { events: ["message.dispatch"] })).toMatchObject({ error: expect.stringContaining("observe hook") });
  });

  it("shell-quotes string parameters so they cannot break the script", async () => {
    const hook = renderOne("log-to-file", { path: join(dir, "it's here.jsonl") });
    const runner = createRunner();
    const outcome = await runner.run({ hook, payload: { event: "thread.idle", n: 1 }, env: {}, timeoutMs: 5_000 });
    expect(outcome.status).toBe("ok");
    expect(readFileSync(join(dir, "it's here.jsonl"), "utf8")).toBe('{"event":"thread.idle","n":1}\n');
  });
});

describe("webhook body templates", () => {
  it("renders payload paths with JSON escaping and truncation", () => {
    const body = renderBody('{"text":"{{event}}: {{thread.title}} {{lastAssistantText|6}} {{missing}} {{n}}","obj":{{thread}}}', {
      event: "thread.idle",
      thread: { title: 'Say "hi"\nnow', id: "t" },
      lastAssistantText: "abcdefghij",
      n: 3,
    });
    expect(JSON.parse(body)).toEqual({ text: 'thread.idle: Say "hi"\nnow abcde…  3', obj: { title: 'Say "hi"\nnow', id: "t" } });
  });

  it("slack and telegram templates send a valid JSON body built from the event", async () => {
    const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
    const runner = createRunner({
      fetchImpl: async (url, init) => {
        sent.push({ url: String(url), body: String(init?.body), headers: init?.headers as Record<string, string> });
        return new Response("ok", { status: 200 });
      },
    });
    const payload = { event: "thread.idle", thread: { title: "Fix \"quotes\"" }, lastAssistantText: "Done." };
    const vault: Record<string, string> = { "slack/webhookUrl": "https://hooks.slack.test/abc", "telegram/botToken": "123:abc" };
    const secrets = (name: string) => vault[name];
    const slack = renderOne("slack", { webhookUrl: "https://hooks.slack.test/abc" });
    expect(slack.url).toBe("{{secret:slack/webhookUrl}}");
    await runner.run({ hook: slack, payload, env: {}, timeoutMs: 2_000, secrets });
    const telegram = renderOne("telegram", { botToken: "123:abc", chatId: "42" });
    expect(telegram.template?.secrets).toEqual({ botToken: "telegram/botToken" });
    expect(telegram.template?.params).toEqual({ chatId: "42" });
    await runner.run({ hook: telegram, payload, env: {}, timeoutMs: 2_000, secrets });

    expect(sent[0]?.url).toBe("https://hooks.slack.test/abc");
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({ text: 'BB thread.idle — Fix "quotes"\nDone.' });
    expect(sent[1]?.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(JSON.parse(sent[1]?.body ?? "")).toEqual({ chat_id: "42", text: 'BB thread.idle — Fix "quotes"\nDone.' });
  });
});

describe("gate templates", () => {
  const runner = createRunner();

  it("office-hours proceeds inside the window and waits outside it", async () => {
    const hour = new Date().getHours();
    const inside = renderOne("office-hours", { start: String(hour), end: String(hour + 1) });
    const open = await runner.run({ hook: inside, payload: {}, env: {}, timeoutMs: 5_000 });
    expect(decide(inside, open).decision).toEqual({ action: "proceed" });

    const closedStart = (hour + 2) % 24;
    const outside = renderOne("office-hours", { start: String(closedStart), end: String(closedStart + 1) });
    const closed = await runner.run({ hook: outside, payload: {}, env: {}, timeoutMs: 5_000 });
    const decision = decide(outside, closed).decision;
    expect(decision).toMatchObject({ action: "wait", reason: expect.stringContaining("Outside office hours") });
    if (decision.action !== "wait") throw new Error("expected wait");
    const sendAt = decision.sendAt ?? 0;
    expect(sendAt).toBeGreaterThan(Date.now());
    expect(sendAt).toBeLessThan(Date.now() + 24 * 3600 * 1000);
    expect(new Date(sendAt).getHours()).toBe(closedStart);
  });

  it("follow-up does nothing for child threads", async () => {
    const hook = renderOne("follow-up", { prompt: "continue" });
    const outcome = await runner.run({ hook, payload: {}, env: { BB_PARENT_THREAD_ID: "thr_parent", BB_THREAD_ID: "thr_child", BB_CLI: "/nonexistent/bb" }, timeoutMs: 5_000 });
    expect(outcome).toMatchObject({ status: "ok", exitCode: 0, stdout: "" });
  });
});

describe("bb hooks use", () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "hooks" });
  beforeAll(async () => {
    await plugin(bb);
  });
  afterAll(async () => {
    await harness.lifecycle.dispose();
  });

  it("lists and describes templates", async () => {
    const list = await harness.behavior.runCli(["templates"]);
    expect(list.exitCode).toBe(0);
    for (const template of TEMPLATES) expect(list.stdout).toContain(template.id);
    const detail = await harness.behavior.runCli(["templates", "block-pattern"]);
    expect(detail.stdout).toContain("--set pattern=");
    expect(await harness.behavior.runCli(["templates", "nope"])).toMatchObject({ exitCode: 1 });
  });

  it("creates a working gate hook from block-pattern", async () => {
    const result = await harness.behavior.runCli(["use", "block-pattern", "--set", "pattern=\\bprod\\b", "--set", "message=Production needs a human."]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('Added hook "block-pattern"');
    const handler = harness.registrations.hooks["message.dispatch"]!;
    await expect(handler(makeMessageDispatchHookContext({ input: { text: "deploy to prod now" } }))).resolves.toEqual({ action: "reject", message: "Production needs a human." });
    await expect(handler(makeMessageDispatchHookContext({ input: { text: "deploy to staging" } }))).resolves.toEqual({ action: "proceed" });
  });

  it("creates one hook per event, applies filters, and refuses bad input", async () => {
    const out = join(dir, "log.jsonl");
    const result = await harness.behavior.runCli(["use", "log-to-file", "--set", `path=${out}`, "--event", "thread.idle", "--event", "thread.failed", "--project", "proj_a", "--id", "audit"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const hooks = JSON.parse((await harness.behavior.runCli(["list", "--json"])).stdout).hooks as HookDefinition[];
    const audit = hooks.filter((hook) => hook.id.startsWith("audit"));
    expect(audit.map((hook) => [hook.id, hook.event, hook.match])).toEqual([
      ["audit-idle", "thread.idle", { projectId: "proj_a" }],
      ["audit-failed", "thread.failed", { projectId: "proj_a" }],
    ]);
    expect(existsSync(out)).toBe(false);

    expect(await harness.behavior.runCli(["use", "slack"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("--set webhookUrl=") });
    expect(await harness.behavior.runCli(["use", "slack", "--set", "bogus"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("key=value") });
    expect(await harness.behavior.runCli(["use", "nope"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("No template") });
  });
});
