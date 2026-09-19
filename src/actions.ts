// Mutations shared by the CLI and the marketplace UI, so both surfaces
// behave identically: installing a template and removing a hook.
import type { RegistryEntry, TemplateRegistry } from "./catalog.js";
import { formatIssues, hookSchema, type HookDefinition, type HookEvent, type HookInput } from "./definitions.js";
import { referencedSecrets, type SecretStore } from "./secrets.js";
import type { HookStore } from "./store.js";
import { renderTemplate } from "./templates.js";

export interface ActionDeps {
  store: HookStore;
  secrets: SecretStore;
  registry: TemplateRegistry;
}

export interface UseTemplateInput {
  ref: string;
  params: Record<string, string>;
  events?: HookEvent[];
  id?: string;
  match?: NonNullable<HookInput["match"]>;
  enabled?: boolean;
  description?: string;
  /** Required for templates that come from a catalog. */
  trusted?: boolean;
}

export type UseTemplateResult =
  | { ok: true; entry: RegistryEntry; hooks: HookDefinition[]; replaced: string[]; secrets: string[] }
  | { ok: false; code: "not-found" | "untrusted" | "invalid"; message: string; entry?: RegistryEntry };

export async function useTemplate(deps: ActionDeps, input: UseTemplateInput): Promise<UseTemplateResult> {
  const resolved = deps.registry.resolve(input.ref);
  if ("error" in resolved) return { ok: false, code: "not-found", message: resolved.error };
  const { entry } = resolved;
  if (entry.source !== "bundled" && !input.trusted) {
    return {
      ok: false,
      code: "untrusted",
      entry,
      message: `"${entry.ref}" comes from catalog "${entry.source}" and will run on this machine. Read what it does first.`,
    };
  }
  const rendered = renderTemplate(entry.template, input.params, {
    id: input.id,
    events: input.events,
    enabled: input.enabled,
    description: input.description,
    match: input.match,
    source: entry.source,
  });
  if ("error" in rendered) return { ok: false, code: "invalid", entry, message: rendered.error };
  const hooks: HookDefinition[] = [];
  for (const hook of rendered.hooks) {
    const validated = hookSchema.safeParse(hook);
    if (!validated.success) return { ok: false, code: "invalid", entry, message: `Template produced an invalid hook: ${formatIssues(validated.error)}` };
    hooks.push(validated.data);
  }
  for (const secret of rendered.secrets) deps.secrets.set(secret.name, secret.value, { managed: true });
  const replaced: string[] = [];
  for (const hook of hooks) {
    const { created } = await deps.store.upsert(hook);
    if (!created) replaced.push(hook.id);
  }
  return { ok: true, entry, hooks, replaced, secrets: rendered.secrets.map((secret) => secret.name) };
}

export async function removeHook(deps: ActionDeps, id: string): Promise<{ removed: boolean; secretsRemoved: string[] }> {
  if (!(await deps.store.remove(id))) return { removed: false, secretsRemoved: [] };
  const secretsRemoved = deps.secrets.gcManaged(referencedSecrets(await deps.store.list()));
  return { removed: true, secretsRemoved };
}
