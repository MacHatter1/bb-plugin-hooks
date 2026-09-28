// Premade, configurable hooks. `bb hooks use <template> --set key=value`
// renders one into ordinary hook definitions, which then live in the
// `hooks` setting like any hand-written hook.
import { z } from "zod";
import { GATE_EVENTS, HOOK_EVENTS, HOOK_ID_PATTERN, MAX_TIMEOUT_MS, OBSERVE_EVENTS, type HookEvent, type HookInput } from "./definitions.js";
import { agentValueOf, parseAgentValue } from "./agent.js";
import { SECRET_NAME_PATTERN, secretPlaceholder } from "./secrets.js";
import { fillPlaceholders, shellQuote } from "./template.js";

export { agentValueOf, parseAgentValue, type AgentChoice } from "./agent.js";

export const templateParamSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/, "param keys are letters, digits and _ (max 32)"),
    label: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    /**
     * `agent` picks who runs a spawned thread: the value is `inherit` (same
     * provider, model and reasoning as the triggering thread), a provider id,
     * or JSON `{ providerId, model?, reasoningLevel?, serviceTier? }`. The
     * template reads it as `{{key.mode}}`, `{{key.providerId}}`, `{{key.model}}`,
     * `{{key.reasoningLevel}}` and `{{key.serviceTier}}`.
     */
    type: z.enum(["string", "integer", "agent"]),
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
      if (param.type === "agent" && param.default !== undefined && "error" in parseAgentValue(param.default)) {
        ctx.addIssue({ code: "custom", path: ["params", index, "default"], message: "agent default must be inherit, a provider id, or JSON with providerId" });
      }
    }
  });

export type TemplateParam = z.infer<typeof templateParamSchema>;
export type HookTemplate = z.infer<typeof templateSchema>;

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
    if (param.type === "agent") {
      const choice = parseAgentValue(raw);
      if ("error" in choice) return { error: `parameter ${param.key}: ${choice.error}` };
      values[param.key] = agentValueOf(choice);
      continue;
    }
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
  // Agent params expand into their parts so a shell script never parses JSON.
  for (const param of template.params) {
    if (param.type !== "agent" || values[param.key] === undefined) continue;
    const choice = parseAgentValue(values[param.key]!);
    if ("error" in choice) continue;
    for (const part of ["mode", "providerId", "model", "reasoningLevel", "serviceTier"] as const) shellValues[`${param.key}.${part}`] = shellQuote(choice[part]);
  }
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
