// Shapes each BB event into what a hook receives: the JSON payload (stdin or
// POST body), BB_* environment variables, and the subject matchers test.
import type { MessageDispatchHookContext, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import type { HookEvent, MatchSubject, ObserveEvent } from "./definitions.js";

/** The thread fields every payload and matcher relies on. */
export interface ThreadFacts {
  id: string;
  projectId: string;
  providerId: string;
  title: string | null;
  titleFallback?: string | null;
  status: string;
  parentThreadId?: string | null;
  environmentId?: string | null;
}

export interface PreparedEvent {
  event: HookEvent;
  threadId: string | null;
  subject: MatchSubject;
  payload: Record<string, unknown>;
  env: Record<string, string>;
}

const MAX_ENV_TEXT = 1_000;

function threadFrom(value: unknown): ThreadFacts | null {
  if (typeof value !== "object" || value === null) return null;
  const thread = value as Partial<ThreadFacts>;
  if (typeof thread.id !== "string" || typeof thread.projectId !== "string") return null;
  return {
    id: thread.id,
    projectId: thread.projectId,
    providerId: typeof thread.providerId === "string" ? thread.providerId : "",
    title: typeof thread.title === "string" ? thread.title : null,
    titleFallback: typeof thread.titleFallback === "string" ? thread.titleFallback : null,
    status: typeof thread.status === "string" ? thread.status : "",
    parentThreadId: typeof thread.parentThreadId === "string" ? thread.parentThreadId : null,
    environmentId: typeof thread.environmentId === "string" ? thread.environmentId : null,
  };
}

function displayTitle(thread: ThreadFacts | null): string | null {
  if (thread === null) return null;
  return thread.title ?? thread.titleFallback ?? null;
}

function baseEnv(event: HookEvent, thread: ThreadFacts | null, threadId: string | null): Record<string, string> {
  const env: Record<string, string> = { BB_HOOK_EVENT: event };
  const id = thread?.id ?? threadId;
  if (id !== null) env.BB_THREAD_ID = id;
  if (thread !== null) {
    env.BB_PROJECT_ID = thread.projectId;
    env.BB_PROVIDER_ID = thread.providerId;
    env.BB_THREAD_STATUS = thread.status;
    env.BB_THREAD_TITLE = (displayTitle(thread) ?? "").slice(0, MAX_ENV_TEXT);
    if (typeof thread.parentThreadId === "string") env.BB_PARENT_THREAD_ID = thread.parentThreadId;
    if (typeof thread.environmentId === "string") env.BB_ENVIRONMENT_ID = thread.environmentId;
  }
  return env;
}

function subjectFor(thread: ThreadFacts | null, text: string | null): MatchSubject {
  return {
    projectId: thread?.projectId ?? null,
    providerId: thread?.providerId ?? null,
    title: displayTitle(thread),
    text,
  };
}

/**
 * Prepare an observe-only event. `fetchedThread` is the thread DTO the caller
 * looked up for events whose payload carries only a thread id.
 */
export function prepareObserveEvent<E extends ObserveEvent>(
  event: E,
  payload: PluginThreadEventPayloads[E],
  fetchedThread: ThreadFacts | null = null,
): PreparedEvent {
  const record = payload as Record<string, unknown>;
  let thread = threadFrom(record.thread) ?? fetchedThread;
  let threadId: string | null = thread?.id ?? null;
  let text: string | null = null;
  const body: Record<string, unknown> = { ...record };

  switch (event) {
    case "thread.idle":
      text = typeof record.lastAssistantText === "string" ? record.lastAssistantText : null;
      break;
    case "thread.failed":
      text = typeof record.error === "string" ? record.error : null;
      break;
    case "turn.failed":
      threadId = typeof record.threadId === "string" ? record.threadId : threadId;
      if (thread !== null) body.thread = thread;
      break;
    case "message.queued":
    case "message.dispatched":
    case "message.cancelled": {
      const entry = record.entry as { threadId?: string; content?: unknown } | undefined;
      threadId = entry?.threadId ?? threadId;
      if (thread !== null) body.thread = thread;
      text = extractText(entry?.content);
      break;
    }
    case "experimental_terminal.input": {
      const terminal = record.terminal as { threadId?: string | null } | undefined;
      threadId = typeof terminal?.threadId === "string" ? terminal.threadId : threadId;
      if (thread !== null) body.thread = thread;
      break;
    }
    default:
      break;
  }
  if (thread === null && fetchedThread !== null) thread = fetchedThread;

  return {
    event,
    threadId,
    subject: subjectFor(thread, text),
    payload: body,
    env: baseEnv(event, thread, threadId),
  };
}

function extractText(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const parts = blocks
    .map((block) => (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .filter((part) => part !== "");
  return parts.length === 0 ? null : parts.join("\n");
}

/** Prepare the message.dispatch checkpoint. Image blocks are reduced to their type. */
export function prepareDispatch(ctx: MessageDispatchHookContext): PreparedEvent {
  const thread = threadFrom(ctx.thread);
  const blocks = ctx.input.blocks.map((block) => {
    const typed = block as { type: string; text?: string };
    return typed.type === "text" ? { type: "text", text: typed.text ?? "" } : { type: typed.type };
  });
  type LegacyQueuedMessage = { id: string; waitingOn: unknown; sendAt: number | null };
  const legacyContext = ctx as MessageDispatchHookContext & {
    queuedMessage?: LegacyQueuedMessage | null;
    startedOnBehalfOf?: { initiator: "agent" | "system"; senderThreadId: string } | null;
  };
  const queuedMessages = Array.isArray(ctx.queuedMessages)
    ? ctx.queuedMessages.map(({ id, waitingOn, sendAt, initiator, senderThreadId, origin, originPluginId }) => ({
        id,
        waitingOn,
        sendAt,
        initiator,
        senderThreadId,
        origin,
        originPluginId,
      }))
    : legacyContext.queuedMessage == null
      ? []
      : [legacyContext.queuedMessage];
  const initiator = ctx.initiator ?? legacyContext.startedOnBehalfOf?.initiator ?? "user";
  const senderThreadId = ctx.senderThreadId ?? legacyContext.startedOnBehalfOf?.senderThreadId ?? null;
  const startedOnBehalfOf =
    (initiator === "agent" || initiator === "system") && typeof senderThreadId === "string"
      ? { initiator, senderThreadId }
      : null;
  const payload: Record<string, unknown> = {
    thread: ctx.thread,
    project: ctx.project,
    environment: ctx.environment,
    host: ctx.host,
    environmentIntent: ctx.environmentIntent,
    attempt: ctx.attempt,
    input: { text: ctx.input.text, blocks },
    requestedExecution: ctx.requestedExecution,
    executionSources: ctx.executionSources,
    initiator,
    senderThreadId,
    queuedMessages,
    queuedMessage: queuedMessages[0] ?? null,
    experimentalSubmission: ctx.experimental_submission ?? null,
    origin: ctx.origin,
    originPluginId: ctx.originPluginId,
    startedOnBehalfOf,
    parentThreadId: ctx.parentThreadId,
  };
  const env = baseEnv("message.dispatch", thread, ctx.thread.id);
  env.BB_DISPATCH_ATTEMPT = ctx.attempt;
  env.BB_PROVIDER_ID = ctx.requestedExecution.providerId;
  if (ctx.requestedExecution.model !== null) env.BB_MODEL = ctx.requestedExecution.model;
  if (ctx.requestedExecution.reasoningLevel !== null) env.BB_REASONING_LEVEL = ctx.requestedExecution.reasoningLevel;
  if (ctx.requestedExecution.serviceTier !== null) env.BB_SERVICE_TIER = ctx.requestedExecution.serviceTier;
  if (ctx.requestedExecution.permissionMode !== null) env.BB_PERMISSION_MODE = ctx.requestedExecution.permissionMode;
  env.BB_MESSAGE_TEXT = ctx.input.text.slice(0, MAX_ENV_TEXT);
  return {
    event: "message.dispatch",
    threadId: ctx.thread.id,
    subject: { projectId: ctx.project.id, providerId: ctx.requestedExecution.providerId, title: displayTitle(thread), text: ctx.input.text },
    payload,
    env,
  };
}

/** A representative payload for `bb hooks test`, built around a real or sample thread. */
export function prepareSample(event: HookEvent, thread: ThreadFacts | null): PreparedEvent {
  const now = Date.now();
  const sampleThread: ThreadFacts & Record<string, unknown> = thread
    ? { ...thread }
    : {
        id: "thr_sample",
        projectId: "proj_sample",
        providerId: "claude-code",
        title: "Sample thread",
        titleFallback: null,
        status: "idle",
        createdAt: now,
        updatedAt: now,
        sample: true,
      };
  const base: Record<string, unknown> = { thread: sampleThread, sample: true };
  switch (event) {
    case "thread.idle":
      return prepareObserveEvent("thread.idle", { ...base, lastAssistantText: "Sample assistant reply." } as never, sampleThread);
    case "thread.failed":
      return prepareObserveEvent("thread.failed", { ...base, error: "Sample error." } as never, sampleThread);
    case "turn.failed":
      return prepareObserveEvent(
        "turn.failed",
        { threadId: sampleThread.id, requestId: "req_sample", turnId: null, errorInfo: null, inputAccepted: false, rateLimits: null, attemptNumber: 1, sample: true } as never,
        sampleThread,
      );
    case "message.queued":
    case "message.dispatched":
    case "message.cancelled":
      return prepareObserveEvent(
        event,
        { entry: { id: "qm_sample", threadId: sampleThread.id, content: [{ type: "text", text: "Sample queued message." }], sendAt: null, waitingOn: null }, sample: true } as never,
        sampleThread,
      );
    case "interaction.pending":
      return prepareObserveEvent("interaction.pending", { ...base, interaction: { id: "int_sample", kind: "sample" } } as never, sampleThread);
    case "experimental_thread.events":
      return prepareObserveEvent("experimental_thread.events", { ...base, sequence: 1 } as never, sampleThread);
    case "experimental_terminal.input":
      return prepareObserveEvent("experimental_terminal.input", { terminal: { id: "term_sample", hostId: "host_sample", threadId: sampleThread.id }, sample: true } as never, sampleThread);
    case "message.dispatch": {
      const prepared: PreparedEvent = {
        event,
        threadId: sampleThread.id,
        subject: { projectId: sampleThread.projectId, providerId: sampleThread.providerId, title: displayTitle(sampleThread), text: "Sample message." },
        payload: {
          thread: sampleThread,
          project: { id: sampleThread.projectId, name: "Sample project", kind: "standard" },
          environment: null,
          host: null,
          environmentIntent: null,
          attempt: "start-turn",
          input: { text: "Sample message.", blocks: [{ type: "text", text: "Sample message." }] },
          requestedExecution: { providerId: sampleThread.providerId, model: null, reasoningLevel: null, serviceTier: null, permissionMode: null },
          executionSources: { providerId: null, model: null, reasoningLevel: null, serviceTier: null, permissionMode: null },
          initiator: "user",
          senderThreadId: null,
          queuedMessages: [],
          queuedMessage: null,
          experimentalSubmission: null,
          origin: null,
          originPluginId: null,
          startedOnBehalfOf: null,
          parentThreadId: null,
          sample: true,
        },
        env: { ...baseEnv(event, sampleThread, sampleThread.id), BB_DISPATCH_ATTEMPT: "start-turn", BB_MESSAGE_TEXT: "Sample message." },
      };
      return prepared;
    }
    default:
      return prepareObserveEvent(event, base as never, sampleThread);
  }
}
