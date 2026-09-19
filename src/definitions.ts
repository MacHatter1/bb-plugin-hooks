// Hook definitions: the user-authored shape, its validation, the event
// catalog, and matching. Pure module — no bb API, so it is unit-testable.
import { z } from "zod";

/** Observe-only lifecycle events a hook can subscribe to (bb.events.on). */
export const OBSERVE_EVENTS = [
  "thread.created",
  "thread.active",
  "thread.idle",
  "thread.failed",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "interaction.pending",
  "message.queued",
  "message.dispatched",
  "message.cancelled",
  "turn.failed",
  "experimental_thread.events",
  "experimental_terminal.input",
] as const;

/** The gating checkpoint (bb.experimental_hooks): the hook's answer is acted on. */
export const GATE_EVENTS = ["message.dispatch"] as const;

export const HOOK_EVENTS = [...OBSERVE_EVENTS, ...GATE_EVENTS] as const;
export type ObserveEvent = (typeof OBSERVE_EVENTS)[number];
export type GateEvent = (typeof GATE_EVENTS)[number];
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface EventInfo {
  event: HookEvent;
  kind: "observe" | "gate";
  summary: string;
}

export const EVENT_CATALOG: readonly EventInfo[] = [
  { event: "thread.created", kind: "observe", summary: "A thread row was created (its first message may not be in the timeline yet)." },
  { event: "thread.active", kind: "observe", summary: "A thread started running a turn." },
  { event: "thread.idle", kind: "observe", summary: "A thread finished its turn; payload carries lastAssistantText." },
  { event: "thread.failed", kind: "observe", summary: "A thread entered the error state; payload carries the error text." },
  { event: "thread.archived", kind: "observe", summary: "A thread was archived (including cascade archives)." },
  { event: "thread.unarchived", kind: "observe", summary: "A thread came back from the archive." },
  { event: "thread.deleted", kind: "observe", summary: "A thread was soft-deleted." },
  { event: "interaction.pending", kind: "observe", summary: "The agent is waiting on the user (permission prompt, question)." },
  { event: "message.queued", kind: "observe", summary: "A message was queued behind a wait instead of dispatching." },
  { event: "message.dispatched", kind: "observe", summary: "A queued message's waits cleared and it was sent." },
  { event: "message.cancelled", kind: "observe", summary: "A queued message was removed before it dispatched." },
  { event: "turn.failed", kind: "observe", summary: "A turn failed; payload has the request id, error info and rate limits." },
  { event: "experimental_thread.events", kind: "observe", summary: "The thread's event log advanced (at most once per second per thread). Noisy." },
  { event: "experimental_terminal.input", kind: "observe", summary: "A user typed into a BB terminal (no keystroke contents)." },
  { event: "message.dispatch", kind: "gate", summary: "GATE: decide whether a message may reach the provider. Exit 0 proceeds, 2 rejects, 3 waits." },
];

export const HOOK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Hard ceilings so a hook can never wedge the server. */
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Core fails a dispatch handler that takes over 10 s; leave headroom. */
export const GATE_TIMEOUT_CEILING_MS = 8_000;

const regexString = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    try {
      new RegExp(value);
      return true;
    } catch {
      return false;
    }
  }, "must be a valid regular expression");

export const matchSchema = z
  .object({
    /** Only threads in this project (proj_* id). */
    projectId: z.string().min(1).optional(),
    /** Only threads on this provider (e.g. claude-code, codex). */
    providerId: z.string().min(1).optional(),
    /** Regular expression tested against the thread title. */
    title: regexString.optional(),
    /**
     * Regular expression tested against the message text: the dispatch input
     * on message.dispatch, the last assistant text on thread.idle, the error
     * on thread.failed.
     */
    text: regexString.optional(),
  })
  .strict();

export const hookSchema = z
  .object({
    id: z.string().regex(HOOK_ID_PATTERN, "id must be lowercase letters, digits and dashes (max 64)"),
    event: z.enum(HOOK_EVENTS),
    /** Shell command run on the BB server with the event JSON on stdin. */
    command: z.string().min(1).max(8192).optional(),
    /** Working directory for the command, on the BB server. */
    cwd: z.string().min(1).optional(),
    /** HTTP(S) endpoint that receives the event JSON as a POST body; may contain `{{secret:NAME}}`. */
    url: z.string().min(1).max(2048).optional(),
    /** Extra request headers for url hooks. */
    headers: z.record(z.string().min(1), z.string()).optional(),
    /**
     * Request body template for url hooks. `{{thread.title}}` reads the event
     * payload (strings are JSON-escaped), `{{lastAssistantText|300}}` truncates.
     * Without it the whole event JSON is sent.
     */
    body: z.string().min(1).max(16_384).optional(),
    /** Set by `bb hooks use`: which template produced this hook and with what values. */
    template: z
      .object({
        id: z.string().min(1),
        /** Catalog name, or "bundled". */
        source: z.string().min(1).optional(),
        params: z.record(z.string(), z.string()),
        /** Secret parameters: param key → secret name (`bb hooks secrets`). */
        secrets: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
    match: matchSchema.optional(),
    timeoutMs: z.number().int().min(100).max(MAX_TIMEOUT_MS).optional(),
    /** For message.dispatch hooks: what to do when the hook fails or times out. */
    onError: z.enum(["proceed", "reject", "wait"]).optional(),
    enabled: z.boolean().default(true),
    description: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((hook, ctx) => {
    if (hook.command === undefined && hook.url === undefined) {
      ctx.addIssue({ code: "custom", message: "a hook needs a command or a url" });
    }
    if (hook.command !== undefined && hook.url !== undefined) {
      ctx.addIssue({ code: "custom", message: "a hook takes either a command or a url, not both" });
    }
    if (hook.url !== undefined && !hook.url.includes("{{secret:")) {
      let valid = false;
      try {
        valid = /^https?:$/.test(new URL(hook.url).protocol);
      } catch {
        valid = false;
      }
      if (!valid) ctx.addIssue({ code: "custom", path: ["url"], message: "url must be a valid http or https URL (or reference a {{secret:…}})" });
    }
    if (hook.headers !== undefined && hook.url === undefined) {
      ctx.addIssue({ code: "custom", path: ["headers"], message: "headers only apply to url hooks" });
    }
    if (hook.body !== undefined && hook.url === undefined) {
      ctx.addIssue({ code: "custom", path: ["body"], message: "body only applies to url hooks" });
    }
    if (hook.cwd !== undefined && hook.command === undefined) {
      ctx.addIssue({ code: "custom", path: ["cwd"], message: "cwd only applies to command hooks" });
    }
    if (hook.onError !== undefined && hook.event !== "message.dispatch") {
      ctx.addIssue({ code: "custom", path: ["onError"], message: "onError only applies to message.dispatch hooks" });
    }
  });

export type HookDefinition = z.infer<typeof hookSchema>;
export type HookInput = z.input<typeof hookSchema>;

export const hookListSchema = z.array(hookSchema).superRefine((hooks, ctx) => {
  const seen = new Set<string>();
  hooks.forEach((hook, index) => {
    if (seen.has(hook.id)) {
      ctx.addIssue({ code: "custom", path: [index, "id"], message: `duplicate hook id "${hook.id}"` });
    }
    seen.add(hook.id);
  });
});

export function isGateEvent(event: HookEvent): event is GateEvent {
  return (GATE_EVENTS as readonly string[]).includes(event);
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

/** Parse the hooks setting (a JSON array). Returns the hooks or an error message. */
export function parseHooksJson(raw: string): { hooks: HookDefinition[] } | { error: string } {
  let value: unknown;
  try {
    value = raw.trim() === "" ? [] : JSON.parse(raw);
  } catch (cause) {
    return { error: `hooks setting is not valid JSON: ${(cause as Error).message}` };
  }
  const parsed = hookListSchema.safeParse(value);
  if (!parsed.success) return { error: formatIssues(parsed.error) };
  return { hooks: parsed.data };
}

export function serializeHooks(hooks: readonly HookDefinition[]): string {
  return JSON.stringify(hooks, null, 2);
}

/** Effective timeout: the hook's own, capped for gate hooks so core's 10 s box is never hit. */
export function effectiveTimeoutMs(hook: HookDefinition): number {
  const requested = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return isGateEvent(hook.event) ? Math.min(requested, GATE_TIMEOUT_CEILING_MS) : requested;
}

/** What the matcher sees, extracted from any event payload by the caller. */
export interface MatchSubject {
  projectId: string | null;
  providerId: string | null;
  title: string | null;
  text: string | null;
}

const MAX_MATCH_TEXT = 20_000;

export function matches(hook: HookDefinition, subject: MatchSubject): boolean {
  const match = hook.match;
  if (match === undefined) return true;
  if (match.projectId !== undefined && subject.projectId !== match.projectId) return false;
  if (match.providerId !== undefined && subject.providerId !== match.providerId) return false;
  if (match.title !== undefined) {
    if (!new RegExp(match.title).test((subject.title ?? "").slice(0, MAX_MATCH_TEXT))) return false;
  }
  if (match.text !== undefined) {
    if (!new RegExp(match.text).test((subject.text ?? "").slice(0, MAX_MATCH_TEXT))) return false;
  }
  return true;
}
