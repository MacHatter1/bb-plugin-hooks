// Executes one hook: a shell command on the BB server (event JSON on stdin,
// BB_HOOK_* in the environment) or an HTTP POST to a webhook. Pure of the bb
// API so it can be tested against real processes and a fake fetch.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { HookDefinition } from "./definitions.js";
import { SECRET_PLACEHOLDER, envNameFor, hookSecretRefs } from "./secrets.js";
import { renderBody } from "./template.js";

export type Decision =
  | { action: "proceed" }
  | { action: "wait"; reason: string; sendAt?: number | null }
  | { action: "reject"; message: string };

export interface RunOutcome {
  status: "ok" | "error" | "timeout";
  /** Command hooks: the process exit code (null when killed). */
  exitCode: number | null;
  /** Url hooks: the HTTP status. */
  httpStatus: number | null;
  /** Command stdout, or the webhook response body. Capped. */
  stdout: string;
  stderr: string;
  durationMs: number;
  error: string | null;
}

export interface RunRequest {
  hook: HookDefinition;
  payload: Record<string, unknown>;
  env: Record<string, string>;
  timeoutMs: number;
  /** Signs url hook bodies with HMAC-SHA256 when set. */
  webhookSecret?: string;
  /** Resolves `{{secret:NAME}}` references; a missing secret fails the run. */
  secrets?: (name: string) => string | undefined;
  signal?: AbortSignal;
}

export interface Runner {
  run(request: RunRequest): Promise<RunOutcome>;
  /** Kill running commands and abort in-flight requests. */
  dispose(): void;
  readonly active: number;
}

export interface RunnerOptions {
  /** Hooks running at once; the rest wait their turn. Default 8. */
  maxConcurrent?: number;
  fetchImpl?: typeof fetch;
  /** Shell used for command hooks. Default /bin/sh (cmd.exe on Windows). */
  shell?: { file: string; args: string[] };
}

export const OUTPUT_CAP_BYTES = 64 * 1024;

const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("proceed") }).strip(),
  z.object({ action: z.literal("wait"), reason: z.string().max(500).optional(), sendAt: z.number().nullable().optional() }).strip(),
  z.object({ action: z.literal("reject"), message: z.string().max(2000).optional() }).strip(),
]);

function cap(text: string): string {
  if (Buffer.byteLength(text) <= OUTPUT_CAP_BYTES) return text;
  return `${Buffer.from(text).subarray(0, OUTPUT_CAP_BYTES).toString()}\n…[truncated]`;
}

function defaultShell(): { file: string; args: string[] } {
  return process.platform === "win32"
    ? { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] }
    : { file: "/bin/sh", args: ["-c"] };
}

class Semaphore {
  private waiting: Array<() => void> = [];
  private used = 0;
  constructor(private readonly limit: number) {}
  get active(): number {
    return this.used;
  }
  async acquire(): Promise<() => void> {
    if (this.used < this.limit) {
      this.used += 1;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
      this.used += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= 1;
      this.waiting.shift()?.();
    };
  }
}

export function createRunner(options: RunnerOptions = {}): Runner {
  const semaphore = new Semaphore(options.maxConcurrent ?? 8);
  const fetchImpl = options.fetchImpl ?? fetch;
  const shell = options.shell ?? defaultShell();
  const children = new Set<ChildProcess>();
  const inflight = new Set<AbortController>();
  let disposed = false;

  async function runCommand(request: RunRequest, rawCommand: string, secretEnv: Record<string, string>): Promise<RunOutcome> {
    const started = Date.now();
    const body = `${JSON.stringify(request.payload)}\n`;
    const command = rawCommand.replace(SECRET_PLACEHOLDER, (_match, name: string) => `"$${envNameFor(name)}"`);
    return new Promise<RunOutcome>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      const finish = (outcome: Omit<RunOutcome, "durationMs" | "stdout" | "stderr">) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer !== null) clearTimeout(killTimer);
        request.signal?.removeEventListener("abort", onAbort);
        children.delete(child);
        resolve({ ...outcome, stdout: cap(stdout), stderr: cap(stderr), durationMs: Date.now() - started });
      };
      let child: ChildProcess;
      try {
        child = spawn(shell.file, [...shell.args, command], {
          cwd: request.hook.cwd,
          env: { ...process.env, ...request.env, ...secretEnv },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (cause) {
        resolve({
          status: "error",
          exitCode: null,
          httpStatus: null,
          stdout: "",
          stderr: "",
          durationMs: Date.now() - started,
          error: `spawn failed: ${(cause as Error).message}`,
        });
        return;
      }
      children.add(child);
      const kill = () => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, request.timeoutMs);
      const onAbort = () => kill();
      request.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        if (stdout.length < OUTPUT_CAP_BYTES * 2) stdout += chunk;
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < OUTPUT_CAP_BYTES * 2) stderr += chunk;
      });
      // A command that never reads stdin closes the pipe; that is not an error.
      child.stdin?.on("error", () => {});
      child.on("error", (cause) => {
        finish({ status: "error", exitCode: null, httpStatus: null, error: `spawn failed: ${cause.message}` });
      });
      child.on("close", (code, signal) => {
        if (timedOut) {
          finish({ status: "timeout", exitCode: code, httpStatus: null, error: `timed out after ${request.timeoutMs} ms` });
        } else if (request.signal?.aborted || disposed) {
          finish({ status: "error", exitCode: code, httpStatus: null, error: "cancelled" });
        } else if (code === null) {
          finish({ status: "error", exitCode: null, httpStatus: null, error: `killed by ${signal ?? "signal"}` });
        } else {
          finish({ status: "ok", exitCode: code, httpStatus: null, error: null });
        }
      });
      child.stdin?.end(body);
    });
  }

  async function runUrl(request: RunRequest, rawUrl: string, secretValues: Record<string, string>): Promise<RunOutcome> {
    const started = Date.now();
    const raw = (text: string) => text.replace(SECRET_PLACEHOLDER, (_match, name: string) => secretValues[name] ?? "");
    const url = raw(rawUrl);
    const rendered = request.hook.body === undefined ? JSON.stringify(request.payload) : renderBody(request.hook.body, request.payload);
    const body = rendered.replace(SECRET_PLACEHOLDER, (_match, name: string) => JSON.stringify(secretValues[name] ?? "").slice(1, -1));
    const controller = new AbortController();
    inflight.add(controller);
    const timer = setTimeout(() => controller.abort(new Error("timeout")), request.timeoutMs);
    const onAbort = () => controller.abort(new Error("cancelled"));
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "bb-plugin-hooks",
      "x-bb-hooks-event": request.hook.event,
      "x-bb-hooks-id": request.hook.id,
      ...Object.fromEntries(Object.entries(request.hook.headers ?? {}).map(([key, value]) => [key, raw(value)])),
    };
    if (request.webhookSecret !== undefined && request.webhookSecret !== "") {
      const timestamp = String(Math.floor(started / 1000));
      const digest = createHmac("sha256", request.webhookSecret).update(`${timestamp}.${body}`).digest("hex");
      headers["x-bb-hooks-timestamp"] = timestamp;
      headers["x-bb-hooks-signature"] = `sha256=${digest}`;
    }
    try {
      const response = await fetchImpl(url, { method: "POST", headers, body, signal: controller.signal });
      const text = cap(await response.text());
      return {
        status: response.ok ? "ok" : "error",
        exitCode: null,
        httpStatus: response.status,
        stdout: text,
        stderr: "",
        durationMs: Date.now() - started,
        error: response.ok ? null : `HTTP ${response.status}`,
      };
    } catch (cause) {
      const timedOut = controller.signal.aborted && (controller.signal.reason as Error | undefined)?.message === "timeout";
      return {
        status: timedOut ? "timeout" : "error",
        exitCode: null,
        httpStatus: null,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - started,
        error: timedOut ? `timed out after ${request.timeoutMs} ms` : `request failed: ${(cause as Error).message}`,
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      inflight.delete(controller);
    }
  }

  return {
    get active() {
      return semaphore.active;
    },
    async run(request) {
      if (disposed) {
        return { status: "error", exitCode: null, httpStatus: null, stdout: "", stderr: "", durationMs: 0, error: "runner disposed" };
      }
      const secretValues: Record<string, string> = {};
      const secretEnv: Record<string, string> = {};
      for (const name of hookSecretRefs(request.hook)) {
        const value = request.secrets?.(name);
        if (value === undefined) {
          return { status: "error", exitCode: null, httpStatus: null, stdout: "", stderr: "", durationMs: 0, error: `missing secret "${name}" (set it with: bb hooks secrets set ${name} <value>)` };
        }
        secretValues[name] = value;
        secretEnv[envNameFor(name)] = value;
      }
      const release = await semaphore.acquire();
      try {
        if (request.hook.command !== undefined) return await runCommand(request, request.hook.command, secretEnv);
        if (request.hook.url !== undefined) return await runUrl(request, request.hook.url, secretValues);
        return { status: "error", exitCode: null, httpStatus: null, stdout: "", stderr: "", durationMs: 0, error: "hook has neither command nor url" };
      } finally {
        release();
      }
    },
    dispose() {
      disposed = true;
      for (const child of children) child.kill("SIGTERM");
      for (const controller of inflight) controller.abort(new Error("cancelled"));
    },
  };
}

/** The last non-empty stdout line, parsed as a decision object when it is one. */
function parseDecisionLine(stdout: string): Decision | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const last = lines.at(-1);
  if (last === undefined || !last.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(last);
  } catch {
    return null;
  }
  const parsed = decisionSchema.safeParse(value);
  if (!parsed.success) return null;
  return normalizeDecision(parsed.data);
}

function normalizeDecision(value: z.infer<typeof decisionSchema>, fallback = ""): Decision {
  switch (value.action) {
    case "proceed":
      return { action: "proceed" };
    case "wait":
      return { action: "wait", reason: value.reason ?? fallback, sendAt: value.sendAt ?? null };
    case "reject":
      return { action: "reject", message: value.message ?? fallback };
  }
}

function firstText(...candidates: string[]): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed !== "") return trimmed.split(/\r?\n/).slice(0, 5).join("\n").slice(0, 500);
  }
  return null;
}

/**
 * Turn a gate hook's outcome into the decision core acts on.
 *
 * A JSON object on the last stdout line wins ({"action":"reject","message":…}).
 * Otherwise exit 0 proceeds, 2 rejects and 3 waits, with stderr (then stdout)
 * as the message. Any other failure applies the hook's onError (default proceed).
 */
export function decide(hook: HookDefinition, outcome: RunOutcome): { decision: Decision; fromError: boolean } {
  const label = `hook "${hook.id}"`;
  const fallbackDecision = (): Decision => {
    switch (hook.onError ?? "proceed") {
      case "reject":
        return { action: "reject", message: `${label} failed: ${outcome.error ?? "unknown error"}` };
      case "wait":
        return { action: "wait", reason: `${label} failed: ${outcome.error ?? "unknown error"}`, sendAt: null };
      default:
        return { action: "proceed" };
    }
  };
  if (outcome.status !== "ok") return { decision: fallbackDecision(), fromError: true };

  if (hook.url !== undefined) {
    const trimmed = outcome.stdout.trim();
    if (trimmed === "") return { decision: { action: "proceed" }, fromError: false };
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { decision: { action: "proceed" }, fromError: false };
    }
    const parsed = decisionSchema.safeParse(value);
    if (!parsed.success) return { decision: { action: "proceed" }, fromError: false };
    return { decision: normalizeDecision(parsed.data, `${label} asked to ${parsed.data.action}`), fromError: false };
  }

  const explicit = parseDecisionLine(outcome.stdout);
  if (explicit !== null) {
    if (explicit.action === "wait" && explicit.reason === "") explicit.reason = `${label} asked to wait`;
    if (explicit.action === "reject" && explicit.message === "") explicit.message = `${label} rejected the message`;
    return { decision: explicit, fromError: false };
  }
  switch (outcome.exitCode) {
    case 0:
      return { decision: { action: "proceed" }, fromError: false };
    case 2:
      return {
        decision: { action: "reject", message: firstText(outcome.stderr, outcome.stdout) ?? `${label} rejected the message` },
        fromError: false,
      };
    case 3:
      return {
        decision: { action: "wait", reason: firstText(outcome.stderr, outcome.stdout) ?? `${label} asked to wait`, sendAt: null },
        fromError: false,
      };
    default:
      return {
        decision: fallbackDecision(),
        fromError: true,
      };
  }
}

export function describeDecision(decision: Decision): string {
  switch (decision.action) {
    case "proceed":
      return "proceed";
    case "wait":
      return `wait (${decision.reason})`;
    case "reject":
      return `reject (${decision.message})`;
  }
}
