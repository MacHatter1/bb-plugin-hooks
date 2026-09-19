// Premade, configurable hooks. `bb hooks use <template> --set key=value`
// renders one into ordinary hook definitions, which then live in the
// `hooks` setting like any hand-written hook.
import { z } from "zod";
import { GATE_EVENTS, HOOK_EVENTS, HOOK_ID_PATTERN, MAX_TIMEOUT_MS, OBSERVE_EVENTS, type HookEvent, type HookInput } from "./definitions.js";
import { SECRET_NAME_PATTERN, secretPlaceholder } from "./secrets.js";
import { fillPlaceholders, shellQuote } from "./template.js";

export const templateParamSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/, "param keys are letters, digits and _ (max 32)"),
    label: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    type: z.enum(["string", "integer"]),
    /** Text default; a param without one and with `required` must be set. */
    default: z.string().max(4096).optional(),
    required: z.boolean().optional(),
    /** Stored encrypted by `bb hooks use` and referenced as `{{secret:…}}`; never written into the hook. */
    secret: z.boolean().optional(),
  })
  .strict();

export const templateSchema = z
  .object({
    id: z.string().regex(HOOK_ID_PATTERN, "template ids are lowercase letters, digits and dashes (max 64)"),
    name: z.string().min(1).max(80),
    summary: z.string().min(1).max(300),
    kind: z.enum(["observe", "gate"]),
    /** Default events. Observe templates accept `--event` overrides; gate templates are fixed. */
    events: z.array(z.enum(HOOK_EVENTS)).min(1).max(16),
    params: z.array(templateParamSchema).max(20),
    /** `{{key}}` params are inserted single-quoted for sh (integers verbatim). */
    command: z.string().min(1).max(8192).optional(),
    /** `{{key}}` params are inserted verbatim. */
    url: z.string().min(1).max(2048).optional(),
    /** `{{key}}` params are inserted JSON-escaped; other `{{paths}}` render at run time. */
    body: z.string().min(1).max(16_384).optional(),
    headers: z.record(z.string().min(1), z.string()).optional(),
    /** `{{key}}` params are inserted verbatim. */
    match: z.object({ projectId: z.string().optional(), providerId: z.string().optional(), title: z.string().optional(), text: z.string().optional() }).strict().optional(),
    timeoutMs: z.number().int().min(100).max(MAX_TIMEOUT_MS).optional(),
    onError: z.enum(["proceed", "reject", "wait"]).optional(),
    /** Requirements or caveats shown in `bb hooks templates <id>`. */
    notes: z.string().max(500).optional(),
    /** Longer listing text (plain text or light markdown). */
    description: z.string().max(4000).optional(),
    /** Listing tags for search and filtering, e.g. ["notifications", "slack"]. */
    tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).max(10).optional(),
    author: z.string().max(80).optional(),
    version: z.string().max(32).optional(),
    homepage: z.string().url().max(2048).optional(),
  })
  .strict()
  .superRefine((template, ctx) => {
    if ((template.command === undefined) === (template.url === undefined)) {
      ctx.addIssue({ code: "custom", message: "a template needs exactly one of command or url" });
    }
    const gate = template.kind === "gate";
    for (const [index, event] of template.events.entries()) {
      const isGate = (GATE_EVENTS as readonly string[]).includes(event);
      if (gate !== isGate) ctx.addIssue({ code: "custom", path: ["events", index], message: `${event} is not a ${template.kind} event` });
    }
    const keys = new Set<string>();
    for (const [index, param] of template.params.entries()) {
      if (keys.has(param.key)) ctx.addIssue({ code: "custom", path: ["params", index, "key"], message: `duplicate param "${param.key}"` });
      keys.add(param.key);
      if (param.secret && param.type !== "string") ctx.addIssue({ code: "custom", path: ["params", index, "secret"], message: "only string params can be secret" });
    }
  });

export type TemplateParam = z.infer<typeof templateParamSchema>;
export type HookTemplate = z.infer<typeof templateSchema>;

const NOTIFY_MESSAGE = `case "$BB_HOOK_EVENT" in
  interaction.pending) msg="Needs you: $BB_THREAD_TITLE" ;;
  thread.idle) msg="Finished: $BB_THREAD_TITLE" ;;
  thread.failed) msg="Failed: $BB_THREAD_TITLE" ;;
  turn.failed) msg="Turn failed: $BB_THREAD_TITLE" ;;
  *) msg="$BB_HOOK_EVENT: $BB_THREAD_TITLE" ;;
esac`;

const CHAT_TEXT = "BB {{event}} — {{thread.title}}\\n{{lastAssistantText|500}}{{error|500}}";

const SPAWN_FOLLOW_UP = `prompt={{prompt}}; provider={{provider}}
bb="\${BB_CLI:-bb}"
# Only top-level threads chain, so a follow-up never triggers another follow-up.
[ -n "$BB_PARENT_THREAD_ID" ] && exit 0
output=$("$bb" thread output "$BB_THREAD_ID" 2>/dev/null | head -c 20000)
set -- --project "$BB_PROJECT_ID" --parent-thread "$BB_THREAD_ID"
[ -n "$BB_ENVIRONMENT_ID" ] && set -- "$@" --environment "$BB_ENVIRONMENT_ID"
[ -n "$provider" ] && set -- "$@" --provider "$provider"
"$bb" thread spawn "$@" --prompt "$(printf '%s\\n\\n---\\nOutput of thread %s:\\n%s' "$prompt" "$BB_THREAD_ID" "$output")"`;

export const TEMPLATES: readonly HookTemplate[] = ([
  {
    id: "desktop-notify",
    author: "MacHatter1",
    version: "1.0.0",
    homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
    tags: ["notifications", "desktop"],
    description: "A native notification the moment an agent stops for you, finishes, or fails. Works on macOS through osascript and on Linux through notify-send. Pick a sound on macOS with --set sound=Glass.",
    name: "Desktop notification",
    summary: "Show a desktop notification when an agent needs you, finishes, or fails.",
    kind: "observe",
    events: ["interaction.pending", "thread.idle", "thread.failed"],
    params: [
      { key: "title", label: "Notification title", type: "string", default: "BB" },
      { key: "sound", label: "macOS sound name", description: "For example Glass or Ping; empty for silent.", type: "string", default: "" },
    ],
    command: `title={{title}}; sound={{sound}}
${NOTIFY_MESSAGE}
esc() { printf '%s' "$1" | tr '\\n' ' ' | sed 's/["\\\\]/\\\\&/g'; }
if command -v osascript >/dev/null 2>&1; then
  script="display notification \\"$(esc "$msg")\\" with title \\"$(esc "$title")\\""
  [ -n "$sound" ] && script="$script sound name \\"$(esc "$sound")\\""
  osascript -e "$script"
elif command -v notify-send >/dev/null 2>&1; then
  notify-send "$title" "$msg"
else
  echo "no notifier found (needs osascript or notify-send)" >&2; exit 1
fi`,
    notes: "macOS (osascript) or Linux (notify-send) on the machine running the BB server.",
  },
  {
    id: "speak",
    author: "MacHatter1",
    version: "1.0.0",
    homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
    tags: ["notifications", "desktop", "voice"],
    name: "Speak it",
    summary: "Read the event aloud with the system voice.",
    kind: "observe",
    events: ["interaction.pending", "thread.idle"],
    params: [{ key: "voice", label: "Voice name (macOS)", type: "string", default: "" }],
    command: `voice={{voice}}
case "$BB_HOOK_EVENT" in
  interaction.pending) msg="An agent needs you on $BB_THREAD_TITLE" ;;
  thread.idle) msg="Agent finished $BB_THREAD_TITLE" ;;
  thread.failed) msg="Agent failed on $BB_THREAD_TITLE" ;;
  *) msg="$BB_HOOK_EVENT on $BB_THREAD_TITLE" ;;
esac
if command -v say >/dev/null 2>&1; then
  if [ -n "$voice" ]; then say -v "$voice" "$msg"; else say "$msg"; fi
elif command -v spd-say >/dev/null 2>&1; then spd-say "$msg"
elif command -v espeak >/dev/null 2>&1; then espeak "$msg"
else echo "no speech tool found (needs say, spd-say or espeak)" >&2; exit 1; fi`,
    notes: "macOS `say`, or spd-say / espeak on Linux.",
  },
  {
    id: "ntfy",
    author: "MacHatter1",
    version: "1.0.0",
    homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
    tags: ["notifications", "phone", "push"],
    description: "Push notifications to your phone with the free ntfy app and no account: install ntfy, subscribe to a topic, and give the same topic here. Use a long random topic name, since anyone who guesses it can read your notifications.",
    name: "Phone push via ntfy",
    summary: "Push to your phone through ntfy.sh (no account needed: subscribe to a topic in the ntfy app).",
    kind: "observe",
    events: ["interaction.pending", "thread.failed"],
    params: [
      { key: "topic", label: "ntfy topic", description: "Pick something unguessable; anyone who knows it can read it.", type: "string", required: true, secret: true },
      { key: "server", label: "ntfy server", type: "string", default: "https://ntfy.sh" },
    ],
    url: "{{server}}",
    body: `{"topic":"{{topic}}","title":"BB {{event}}","message":"{{thread.title}}\\n{{lastAssistantText|300}}{{error|300}}","tags":["robot"]}`,
  },
  {
    id: "slack",
    author: "MacHatter1",
    version: "1.0.0",
    homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
    tags: ["notifications", "chat", "slack"],
    description: "Posts a short message with the thread title and the last reply or error to a Slack channel. Create an Incoming Webhook in your Slack app settings and paste its URL; it is stored encrypted.",
    name: "Slack message",
    summary: "Post to a Slack channel through an incoming webhook.",
    kind: "observe",
    events: ["thread.idle", "thread.failed", "interaction.pending"],
    params: [{ key: "webhookUrl", label: "Incoming webhook URL", type: "string", required: true, secret: true }],
    url: "{{webhookUrl}}",
    body: `{"text":"${CHAT_TEXT}"}`,
    notes: "Create the webhook at api.slack.com/apps → Incoming Webhooks. The URL is stored encrypted (bb hooks secrets).",
  },
  {
    id: "discord",
    author: "MacHatter1",
    version: "1.0.0",
    homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
    tags: ["notifications", "chat", "discord"],
    name: "Discord message",
    summary: "Post to a Discord channel through a channel webhook.",
    kind: "observe",
    events: ["thread.idle", "thread.failed", "interaction.pending"],
    params: [{ key: "webhookUrl", label: "Channel webhook URL", type: "string", required: true, secret: true }],
    url: "{{webhookUrl}}",
    body: `{"content":"${CHAT_TEXT}"}`,
  },
  {
    id: "telegram",
    author: "MacHatter1",
    version: "1.0.0",
    homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
    tags: ["notifications", "chat", "telegram", "phone"],
    name: "Telegram message",
    summary: "Send a message from a Telegram bot to a chat.",
    kind: "observe",
    events: ["thread.idle", "thread.failed", "interaction.pending"],
    params: [
      { key: "botToken", label: "Bot token", description: "From @BotFather.", type: "string", required: true, secret: true },
      { key: "chatId", label: "Chat id", description: "Your user or group id; message the bot first.", type: "string", required: true },
    ],
    url: "https://api.telegram.org/bot{{botToken}}/sendMessage",
    body: `{"chat_id":"{{chatId}}","text":"${CHAT_TEXT}"}`,
    notes: "The bot token is stored encrypted (bb hooks secrets).",
  },
  {
    id: "webhook",
    author: "MacHatter1",
    version: "1.0.0",
    homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
    tags: ["integration", "webhook"],
    description: "Sends the complete event JSON to any HTTP endpoint: Zapier, n8n, Make, a serverless function, or your own service. Set the plugin's webhook signing secret to verify requests with x-bb-hooks-signature.",
    name: "Generic webhook",
    summary: "POST the raw event JSON to any URL (signed when the webhook secret is set).",
    kind: "observe",
    events: ["thread.idle"],
    params: [{ key: "url", label: "Endpoint URL", type: "string", required: true }],
    url: "{{url}}",
  },
  {
    id: "log-to-file",
    author: "MacHatter1",
    version: "1.0.0",
    homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
    tags: ["audit", "logging"],
    name: "Log to file",
    summary: "Append every event as one JSON line to a file on the server.",
    kind: "observe",
    events: ["thread.created", "thread.idle", "thread.failed", "thread.archived"],
    params: [{ key: "path", label: "File path (on the BB server)", type: "string", required: true }],
    command: "cat >> {{path}}",
  },
  {
    id: "follow-up",
    author: "MacHatter1",
    version: "1.0.0",
    homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
    tags: ["automation", "agents", "chaining"],
    description: "Chains agents: when a thread finishes, a new thread starts in the same workspace with your prompt plus the finished thread's output. Only top-level threads trigger it, so the chain stops after one hop. Scope it with --title or --project.",
    name: "Spawn a follow-up thread",
    summary: "When a thread finishes, start a new thread in the same workspace with your prompt plus the finished thread's output.",
    kind: "observe",
    events: ["thread.idle"],
    params: [
      { key: "prompt", label: "Prompt for the follow-up", type: "string", required: true },
      { key: "provider", label: "Provider id", description: "Empty uses the project default.", type: "string", default: "" },
    ],
    command: SPAWN_FOLLOW_UP,
    timeoutMs: 120_000,
    notes: "Uses the bb CLI from the server (BB_CLI). Only top-level threads trigger it, so chains stop after one hop. Add --title or --project filters to scope it.",
  },
  {
    id: "review",
    author: "MacHatter1",
    version: "1.0.0",
    homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
    tags: ["automation", "agents", "code-review"],
    description: "A second opinion on every finished thread: a reviewer thread inspects the diff, runs the tests, and answers APPROVE or REQUEST CHANGES. Run it on a different provider than the author for real independence.",
    name: "Automatic code review",
    summary: "When a thread finishes, spawn a reviewer thread that inspects its work and answers APPROVE or REQUEST CHANGES.",
    kind: "observe",
    events: ["thread.idle"],
    params: [
      {
        key: "prompt",
        label: "Reviewer prompt",
        type: "string",
        default:
          "You are a strict code reviewer. Inspect the changes made by the previous thread in this workspace (git diff and git log), run the tests, and reply with APPROVE or REQUEST CHANGES followed by specific, actionable findings. Do not make changes.",
      },
      { key: "provider", label: "Reviewer provider id", description: "Use a different provider than the author for a second opinion.", type: "string", default: "" },
    ],
    command: SPAWN_FOLLOW_UP,
    timeoutMs: 120_000,
    notes: "Same mechanics as follow-up. Scope it with --title '^feat' or --project so not every thread gets reviewed.",
  },
  {
    id: "block-pattern",
    author: "MacHatter1",
    version: "1.0.0",
    homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
    tags: ["gate", "policy", "safety"],
    description: "A guardrail on outgoing messages: anything matching the pattern is rejected before it reaches the agent, and the sender sees your reason. Send now on a queued message can override it.",
    name: "Block messages matching a pattern",
    summary: "Reject any message whose text matches a regular expression, showing your reason.",
    kind: "gate",
    events: ["message.dispatch"],
    params: [
      { key: "pattern", label: "Regular expression", description: "Tested against the message text, for example \\bprod(uction)?\\b.", type: "string", required: true },
      { key: "message", label: "Reason shown to the sender", type: "string", default: "Blocked by the block-pattern hook." },
    ],
    command: `message={{message}}; echo "$message" >&2; exit 2`,
    match: { text: "{{pattern}}" },
  },
  {
    id: "office-hours",
    author: "MacHatter1",
    version: "1.0.0",
    homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
    tags: ["gate", "policy", "scheduling"],
    description: "Holds messages sent outside the window and sends them automatically when it opens, using the server's local time. Combine with --text '#overnight' to queue only tagged work for the night.",
    name: "Office hours",
    summary: "Hold messages sent outside a daily window until it opens (server local time).",
    kind: "gate",
    events: ["message.dispatch"],
    params: [
      { key: "start", label: "Opening hour (0-23)", type: "integer", default: "9" },
      { key: "end", label: "Closing hour (1-24)", type: "integer", default: "18" },
    ],
    command: `start={{start}}; end={{end}}
now=$(date +%s); h=$(date +%H); m=$(date +%M); s=$(date +%S)
h=\${h#0}; m=\${m#0}; s=\${s#0}
today=$(( h * 3600 + m * 60 + s ))
open=$(( start * 3600 )); close=$(( end * 3600 ))
if [ "$today" -ge "$open" ] && [ "$today" -lt "$close" ]; then exit 0; fi
if [ "$today" -lt "$open" ]; then wait=$(( open - today )); else wait=$(( 86400 - today + open )); fi
printf '{"action":"wait","reason":"Outside office hours (%02d:00-%02d:00)","sendAt":%d}\\n' "$start" "$end" $(( (now + wait) * 1000 ))`,
    notes: "Combine with --text '#overnight' to hold only tagged messages. Send now on the queued card overrides it.",
  },
] satisfies HookTemplate[]) as readonly HookTemplate[];

export function findTemplate(id: string): HookTemplate | null {
  return TEMPLATES.find((template) => template.id === id) ?? null;
}

export function shortEventName(event: HookEvent): string {
  return event.replace(/^(thread|experimental_)\./, "").replace(/\./g, "-");
}

export interface RenderOptions {
  id?: string;
  events?: HookEvent[];
  enabled?: boolean;
  description?: string;
  match?: { projectId?: string; providerId?: string; title?: string; text?: string };
  /** Catalog name recorded on the hooks; defaults to "bundled". */
  source?: string;
}

export interface RenderedTemplate {
  hooks: HookInput[];
  /** New secrets to store before the hooks run (managed by the hooks). */
  secrets: Array<{ name: string; value: string }>;
}

function jsonStringContents(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/**
 * Render a template into hook inputs, one per event. A secret param's value
 * becomes an encrypted secret named `<hook id>/<param>` (or references an
 * existing one when given as `secret:<name>`); the hooks only carry the
 * `{{secret:…}}` placeholder.
 */
export function renderTemplate(
  template: HookTemplate,
  params: Record<string, string>,
  options: RenderOptions = {},
): RenderedTemplate | { error: string } {
  const known = new Set(template.params.map((param) => param.key));
  const unknown = Object.keys(params).filter((key) => !known.has(key));
  if (unknown.length > 0) return { error: `unknown parameter${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}; this template takes ${[...known].join(", ") || "no parameters"}` };

  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const param of template.params) {
    const raw = params[param.key] ?? param.default;
    if (raw === undefined) {
      if (param.required) missing.push(param.key);
      continue;
    }
    if (param.type === "integer" && !/^-?\d+$/.test(raw.trim())) return { error: `parameter ${param.key} must be an integer, got "${raw}"` };
    values[param.key] = param.type === "integer" ? raw.trim() : raw;
  }
  if (missing.length > 0) return { error: `missing required parameter${missing.length === 1 ? "" : "s"}: ${missing.map((key) => `--set ${key}=…`).join(" ")}` };

  const baseId = options.id ?? template.id;
  const secrets: Array<{ name: string; value: string }> = [];
  const secretNames: Record<string, string> = {};
  const storedParams: Record<string, string> = {};
  for (const param of template.params) {
    const value = values[param.key];
    if (value === undefined) continue;
    if (!param.secret) {
      storedParams[param.key] = value;
      continue;
    }
    if (value.startsWith("secret:")) {
      const name = value.slice("secret:".length);
      if (!SECRET_NAME_PATTERN.test(name)) return { error: `"${value}" is not a valid secret reference` };
      secretNames[param.key] = name;
    } else {
      const name = `${baseId}/${param.key}`;
      secretNames[param.key] = name;
      secrets.push({ name, value });
    }
  }

  const placeholderFor = (key: string) => secretPlaceholder(secretNames[key]!);
  const shellValues = Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (key in secretNames) return [key, placeholderFor(key)];
      return [key, template.params.find((param) => param.key === key)?.type === "integer" ? value : shellQuote(value)];
    }),
  );
  const rawValues = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, key in secretNames ? placeholderFor(key) : value]));
  const jsonValues = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, key in secretNames ? placeholderFor(key) : jsonStringContents(value)]));

  let events: HookEvent[];
  if (template.kind === "gate") {
    if (options.events !== undefined && options.events.some((event) => !(GATE_EVENTS as readonly string[]).includes(event))) {
      return { error: `template ${template.id} is a gate hook and only runs on ${GATE_EVENTS.join(", ")}` };
    }
    events = [...template.events];
  } else {
    events = options.events ?? [...template.events];
    const bad = events.filter((event) => !(OBSERVE_EVENTS as readonly string[]).includes(event));
    if (bad.length > 0) return { error: `template ${template.id} is an observe hook and cannot run on ${bad.join(", ")}` };
  }
  if (events.length === 0) return { error: "no events selected" };

  const hooks: HookInput[] = events.map((event) => {
    const hook: HookInput = {
      id: events.length === 1 ? baseId : `${baseId}-${shortEventName(event)}`,
      event,
      enabled: options.enabled ?? true,
      description: options.description ?? template.summary,
      template: {
        id: template.id,
        source: options.source ?? "bundled",
        params: storedParams,
        ...(Object.keys(secretNames).length > 0 ? { secrets: secretNames } : {}),
      },
    };
    if (template.command !== undefined) hook.command = fillPlaceholders(template.command, shellValues);
    if (template.url !== undefined) hook.url = fillPlaceholders(template.url, rawValues);
    if (template.body !== undefined) hook.body = fillPlaceholders(template.body, jsonValues);
    if (template.headers !== undefined) hook.headers = Object.fromEntries(Object.entries(template.headers).map(([key, value]) => [key, fillPlaceholders(value, rawValues)]));
    if (template.timeoutMs !== undefined) hook.timeoutMs = template.timeoutMs;
    if (template.onError !== undefined) hook.onError = template.onError;
    const match = { ...(template.match ?? {}), ...(options.match ?? {}) };
    const rendered = Object.fromEntries(Object.entries(match).filter(([, value]) => value !== undefined).map(([key, value]) => [key, fillPlaceholders(value as string, storedParams)]));
    if (Object.keys(rendered).length > 0) hook.match = rendered;
    return hook;
  });
  return { hooks, secrets };
}
