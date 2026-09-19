import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { HookDefinition } from "../src/definitions.js";
import { createRunner, decide } from "../src/runner.js";

const dir = mkdtempSync(join(tmpdir(), "bb-hooks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const runner = createRunner({ maxConcurrent: 2 });
const gate = (command: string, extra: Partial<HookDefinition> = {}): HookDefinition => ({
  id: "gate",
  event: "message.dispatch",
  command,
  enabled: true,
  ...extra,
});

describe("command hooks", () => {
  it("delivers the payload on stdin and BB_* variables in the environment", async () => {
    const out = join(dir, "payload.json");
    const outcome = await runner.run({
      hook: { id: "w", event: "thread.idle", command: `cat > "$OUT"; echo "$BB_THREAD_ID/$BB_HOOK_EVENT"`, enabled: true },
      payload: { event: "thread.idle", thread: { id: "thr_1" } },
      env: { OUT: out, BB_THREAD_ID: "thr_1", BB_HOOK_EVENT: "thread.idle" },
      timeoutMs: 5_000,
    });
    expect(outcome).toMatchObject({ status: "ok", exitCode: 0, error: null });
    expect(outcome.stdout.trim()).toBe("thr_1/thread.idle");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ event: "thread.idle", thread: { id: "thr_1" } });
  });

  it("tolerates a command that never reads stdin", async () => {
    const outcome = await runner.run({ hook: { id: "n", event: "thread.idle", command: "exit 0", enabled: true }, payload: { big: "x".repeat(200_000) }, env: {}, timeoutMs: 5_000 });
    expect(outcome.status).toBe("ok");
  });

  it("times out and reports it", async () => {
    const outcome = await runner.run({ hook: { id: "slow", event: "thread.idle", command: "sleep 5", enabled: true }, payload: {}, env: {}, timeoutMs: 200 });
    expect(outcome.status).toBe("timeout");
    expect(outcome.error).toContain("timed out");
  });

  it("honours cwd", async () => {
    const outcome = await runner.run({ hook: { id: "c", event: "thread.idle", command: "pwd", cwd: dir, enabled: true }, payload: {}, env: {}, timeoutMs: 5_000 });
    expect(outcome.stdout.trim().endsWith(dir.split("/").pop() ?? "")).toBe(true);
  });
});

describe("decide", () => {
  it("maps exit codes to decisions", async () => {
    const ok = await runner.run({ hook: gate("exit 0"), payload: {}, env: {}, timeoutMs: 2_000 });
    expect(decide(gate("exit 0"), ok)).toEqual({ decision: { action: "proceed" }, fromError: false });

    const rejected = await runner.run({ hook: gate("echo 'not allowed' >&2; exit 2"), payload: {}, env: {}, timeoutMs: 2_000 });
    expect(decide(gate(""), rejected).decision).toEqual({ action: "reject", message: "not allowed" });

    const waited = await runner.run({ hook: gate("echo busy; exit 3"), payload: {}, env: {}, timeoutMs: 2_000 });
    expect(decide(gate(""), waited).decision).toEqual({ action: "wait", reason: "busy", sendAt: null });
  });

  it("prefers a JSON decision on the last stdout line", async () => {
    const outcome = await runner.run({ hook: gate(`echo noise; echo '{"action":"wait","reason":"quota","sendAt":123}'`), payload: {}, env: {}, timeoutMs: 2_000 });
    expect(decide(gate(""), outcome).decision).toEqual({ action: "wait", reason: "quota", sendAt: 123 });
  });

  it("applies onError to failures and timeouts", async () => {
    const crashed = await runner.run({ hook: gate("exit 7"), payload: {}, env: {}, timeoutMs: 2_000 });
    expect(decide(gate("", { onError: undefined }), crashed)).toMatchObject({ decision: { action: "proceed" }, fromError: true });
    expect(decide(gate("", { onError: "reject" }), crashed).decision).toMatchObject({ action: "reject", message: expect.stringContaining("failed") });
    const timedOut = await runner.run({ hook: gate("sleep 5"), payload: {}, env: {}, timeoutMs: 100 });
    expect(decide(gate("", { onError: "wait" }), timedOut).decision).toMatchObject({ action: "wait", reason: expect.stringContaining("timed out") });
  });
});

describe("url hooks", () => {
  it("posts signed JSON and reads the decision from the response", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ action: "reject", message: "no thanks" }), { status: 200 });
    };
    const local = createRunner({ fetchImpl });
    const hook: HookDefinition = { id: "web", event: "message.dispatch", url: "https://example.test/hook", headers: { "x-extra": "1" }, enabled: true };
    const outcome = await local.run({ hook, payload: { event: "message.dispatch" }, env: {}, timeoutMs: 2_000, webhookSecret: "s3cret" });
    expect(outcome).toMatchObject({ status: "ok", httpStatus: 200 });
    expect(decide(hook, outcome).decision).toEqual({ action: "reject", message: "no thanks" });

    const [call] = seen;
    expect(call?.url).toBe("https://example.test/hook");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["x-extra"]).toBe("1");
    expect(headers["x-bb-hooks-event"]).toBe("message.dispatch");
    const expected = createHmac("sha256", "s3cret").update(`${headers["x-bb-hooks-timestamp"]}.${String(call?.init.body)}`).digest("hex");
    expect(headers["x-bb-hooks-signature"]).toBe(`sha256=${expected}`);
  });

  it("treats a non-2xx response as an error", async () => {
    const local = createRunner({ fetchImpl: async () => new Response("boom", { status: 500 }) });
    const hook: HookDefinition = { id: "web", event: "thread.idle", url: "https://example.test/hook", enabled: true };
    const outcome = await local.run({ hook, payload: {}, env: {}, timeoutMs: 2_000 });
    expect(outcome).toMatchObject({ status: "error", httpStatus: 500, error: "HTTP 500" });
  });
});
