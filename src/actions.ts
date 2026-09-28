// Mutations shared by the CLI and the marketplace UI, so both surfaces
// behave identically: installing a template and removing a hook.
import type { RegistryEntry, TemplateRegistry } from "./catalog.js";
import { formatIssues, hookSchema, type HookDefinition, type HookEvent, type HookInput } from "./definitions.js";
import { referencedSecrets, type SecretStore } from "./secrets.js";
import { countsInstalls, type InstallStats, type ShareInstalls } from "./stats.js";
import type { HookStore } from "./store.js";
import { renderTemplate } from "./templates.js";

export interface ActionDeps {
  store: HookStore;
  secrets: SecretStore;
  registry: TemplateRegistry;
  /** Reports installs from the marketplace catalog; absent in tests that don't care. */
  stats?: InstallStats;
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
  /** The user's answer when asked whether to share install counts; remembered as the setting. */
  shareInstalls?: boolean;
}

export type UseTemplateResult =
  | {
      ok: true;
      entry: RegistryEntry;
      hooks: HookDefinition[];
      replaced: string[];
      secrets: string[];
      /** The sharing choice in effect for a marketplace template, otherwise null. */
      shareInstalls: ShareInstalls | null;
    }
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
  // Re-rendering a hook with a new secret value leaves the old managed secret
  // unreferenced; drop it unless a sibling hook still uses it.
  if (replaced.length > 0) deps.secrets.gcManaged(referencedSecrets(await deps.store.list()));
  let shareInstalls: ShareInstalls | null = null;
  if (deps.stats !== undefined && countsInstalls(entry)) {
    shareInstalls = deps.stats.consent();
    if (shareInstalls === "ask" && input.shareInstalls !== undefined) {
      shareInstalls = input.shareInstalls ? "on" : "off";
      await deps.stats.setConsent(shareInstalls);
    }
    // Only a new install counts; re-running `use` to change settings replaces hooks.
    if (shareInstalls === "on" && replaced.length < hooks.length) {
      deps.stats.report({ catalog: entry.source, template: entry.template.id, version: entry.template.version ?? null });
    }
  }
  return { ok: true, entry, hooks, replaced, secrets: rendered.secrets.map((secret) => secret.name), shareInstalls };
}

export async function removeHook(deps: ActionDeps, id: string): Promise<{ removed: boolean; secretsRemoved: string[] }> {
  if (!(await deps.store.remove(id))) return { removed: false, secretsRemoved: [] };
  const secretsRemoved = deps.secrets.gcManaged(referencedSecrets(await deps.store.list()));
  return { removed: true, secretsRemoved };
}
