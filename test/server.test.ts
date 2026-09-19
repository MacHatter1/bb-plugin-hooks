import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin from "../server.js";

const dir = mkdtempSync(join(tmpdir(), "bb-hooks-server-"));
const host = createFakePluginHost({ pluginId: "hooks" });
const { bb, harness } = host;

beforeAll(async () => {
  await plugin(bb);
});
afterAll(async () => {
  await harness.lifecycle.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("bb hooks CLI", () => {
  it("adds, lists, edits, disables and removes hooks through the setting", async () => {
    const added = await harness.behavior.runCli(["add", "greet", "--event", "thread.idle", "--command", "echo hi", "--title", "^Fix"]);
    expect(added).toMatchObject({ exitCode: 0 });
    expect(added.stdout).toContain('Added hook "greet"');

    const listed = await harness.behavior.runCli(["list", "--json"]);
    expect(JSON.parse(listed.stdout)).toEqual({
      hooks: [{ id: "greet", event: "thread.idle", command: "echo hi", enabled: true, match: { title: "^Fix" } }],
      error: null,
    });

    const edited = await harness.behavior.runCli(["edit", "greet", "--clear-match", "--timeout", "1500", "--description", "says hi"]);
    expect(edited.exitCode).toBe(0);
    const shown = JSON.parse((await harness.behavior.runCli(["show", "greet"])).stdout);
    expect(shown).toEqual({ id: "greet", event: "thread.idle", command: "echo hi", enabled: true, timeoutMs: 1500, description: "says hi" });

    expect((await harness.behavior.runCli(["disable", "greet"])).exitCode).toBe(0);
    expect(JSON.parse((await harness.behavior.runCli(["show", "greet"])).stdout).enabled).toBe(false);
    expect((await harness.behavior.runCli(["remove", "greet"])).exitCode).toBe(0);
    expect((await harness.behavior.runCli(["remove", "greet"])).exitCode).toBe(1);
    expect(JSON.parse((await harness.behavior.runCli(["list", "--json"])).stdout).hooks).toEqual([]);
  });

  it("rejects bad input with a usage error", async () => {
    expect(await harness.behavior.runCli(["add", "x", "--event", "nope", "--command", "true"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("unknown event") });
    expect(await harness.behavior.runCli(["add", "x", "--event", "thread.idle"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("needs a command or a url") });
    expect(await harness.behavior.runCli(["add", "x", "--event", "thread.idle", "--command", "true", "--bogus"])).toMatchObject({ exitCode: 1 });
    expect(await harness.behavior.runCli(["frobnicate"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Unknown command") });
    expect(await harness.behavior.runCli(["events"])).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("message.dispatch") });
  });

  it("surfaces an invalid setting instead of failing", async () => {
    await expect(harness.behavior.setSettings({ hooks: "[{bad" })).rejects.toThrow();
  });
});

describe("observe hooks", () => {
  it("runs matching hooks with the event payload and skips non-matching ones", async () => {
    const out = join(dir, "idle.json");
    const skipped = join(dir, "skipped.json");
    await harness.behavior.runCli(["add", "on-idle", "--event", "thread.idle", "--command", `cat > "${out}"; echo "$BB_THREAD_TITLE" >> "${out}"`, "--project", "proj_a"]);
    await harness.behavior.runCli(["add", "other-project", "--event", "thread.idle", "--command", `touch "${skipped}"`, "--project", "proj_b"]);

    const thread = makeThreadResponse({ id: "thr_idle", projectId: "proj_a", title: "Fix the build" });
    const { errors } = await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Build fixed." });
    expect(errors).toEqual([]);
    await waitFor(() => existsSync(out));
    await waitFor(() => readFileSync(out, "utf8").includes("Fix the build"));

    const [jsonLine] = readFileSync(out, "utf8").split("\n");
    const payload = JSON.parse(jsonLine ?? "{}");
    expect(payload).toMatchObject({ event: "thread.idle", hookId: "on-idle", lastAssistantText: "Build fixed.", thread: { id: "thr_idle", projectId: "proj_a" } });
    expect(existsSync(skipped)).toBe(false);

    await waitFor(() => JSON.parse(harness.registrations.cli ? "1" : "0") === 1);
    const history = JSON.parse((await harness.behavior.runCli(["history", "--json", "--hook", "on-idle"])).stdout);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ hookId: "on-idle", event: "thread.idle", threadId: "thr_idle", status: "ok", exitCode: 0 });
  });

  it("runs nothing when the master switch is off", async () => {
    const out = join(dir, "off.json");
    await harness.behavior.runCli(["add", "off", "--event", "thread.failed", "--command", `touch "${out}"`]);
    await harness.behavior.setSettings({ enabled: false });
    await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_off" }), error: "boom" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(out)).toBe(false);
    await harness.behavior.setSettings({ enabled: true });
  });

  it("looks the thread up for payloads that only carry an id", async () => {
    const out = join(dir, "turn-failed.json");
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_tf", projectId: "proj_a", title: "Looked up" }));
    await harness.behavior.runCli(["add", "on-turn-failed", "--event", "turn.failed", "--command", `cat > "${out}"`, "--project", "proj_a"]);
    await harness.behavior.emitThreadEvent("turn.failed", {
      threadId: "thr_tf",
      requestId: "req_1",
      turnId: null,
      errorInfo: null,
      inputAccepted: false,
      rateLimits: null,
      attemptNumber: 1,
    });
    await waitFor(() => existsSync(out));
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload).toMatchObject({ event: "turn.failed", threadId: "thr_tf", requestId: "req_1", thread: { id: "thr_tf", title: "Looked up" } });
  });
});

describe("gate hooks", () => {
  const dispatch = () => {
    const handler = harness.registrations.hooks["message.dispatch"];
    if (handler === null) throw new Error("message.dispatch handler not registered");
    return handler;
  };

  it("proceeds when no gate hook matches", async () => {
    await expect(dispatch()(makeMessageDispatchHookContext())).resolves.toEqual({ action: "proceed" });
  });

  it("rejects when the command exits 2, with stderr as the message", async () => {
    await harness.behavior.runCli(["add", "no-force-push", "--event", "message.dispatch", "--command", `echo "blocked: $BB_MESSAGE_TEXT" >&2; exit 2`, "--text", "force"]);
    await expect(dispatch()(makeMessageDispatchHookContext({ input: { text: "please force push" } }))).resolves.toEqual({ action: "reject", message: "blocked: please force push" });
    await expect(dispatch()(makeMessageDispatchHookContext({ input: { text: "just commit" } }))).resolves.toEqual({ action: "proceed" });
    await harness.behavior.runCli(["remove", "no-force-push"]);
  });

  it("collects waits and lets failures through by default", async () => {
    await harness.behavior.runCli(["add", "hold", "--event", "message.dispatch", "--command", `echo '{"action":"wait","reason":"after hours","sendAt":4102444800000}'`]);
    await harness.behavior.runCli(["add", "crashy", "--event", "message.dispatch", "--command", "exit 9"]);
    await expect(dispatch()(makeMessageDispatchHookContext())).resolves.toEqual({ action: "wait", reason: "after hours", sendAt: 4102444800000 });
    await harness.behavior.runCli(["edit", "crashy", "--on-error", "reject"]);
    await harness.behavior.runCli(["remove", "hold"]);
    await expect(dispatch()(makeMessageDispatchHookContext())).resolves.toMatchObject({ action: "reject", message: expect.stringContaining('hook "crashy" failed') });
    await harness.behavior.runCli(["remove", "crashy"]);
  });

  it("caps a gate hook at the dispatch budget", async () => {
    await harness.behavior.runCli(["add", "slow-gate", "--event", "message.dispatch", "--command", "sleep 30", "--timeout", "600000", "--on-error", "reject"]);
    const started = Date.now();
    const decision = await dispatch()(makeMessageDispatchHookContext());
    expect(Date.now() - started).toBeLessThan(9_500);
    expect(decision).toMatchObject({ action: "reject", message: expect.stringContaining("timed out") });
    await harness.behavior.runCli(["remove", "slow-gate"]);
  }, 15_000);
});

describe("bb hooks test", () => {
  it("runs a hook with a sample payload and reports the outcome", async () => {
    await harness.behavior.runCli(["add", "sample", "--event", "thread.idle", "--command", `jq -r '.thread.id + \" \" + .event' 2>/dev/null || cat`]);
    const result = await harness.behavior.runCli(["test", "sample"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Ran with a sample payload.");
    expect(result.stdout).toContain("Status: ok (exit 0)");
    expect(result.stdout).toContain("thr_sample");

    await harness.behavior.runCli(["add", "sample-gate", "--event", "message.dispatch", "--command", "exit 2"]);
    const gate = await harness.behavior.runCli(["test", "sample-gate", "--json"]);
    expect(JSON.parse(gate.stdout)).toMatchObject({ decision: { action: "reject" }, payload: { event: "message.dispatch", input: { text: "Sample message." } } });
  });
});
