// Rendered on the plugin's page under Settings → Installed plugins, below the
// host's declarative settings form: the friendly view of what the raw JSON
// field holds, with the switches people actually want and a way to the page.
import { toast } from "sonner";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EventPill, OverviewProvider, SourceBadge, compact, errorMessage, targetOf, useOverview } from "./shared";

export function SettingsSection() {
  return (
    <OverviewProvider>
      <TooltipProvider delayDuration={300}>
        <SettingsBody />
      </TooltipProvider>
    </OverviewProvider>
  );
}

function SettingsBody() {
  const { data, rpc, refetch } = useOverview();
  const navigate = useBbNavigate();
  const toggle = async (id: string, enabled: boolean) => {
    try {
      await rpc.call("hook_set_enabled", { id, enabled });
      refetch();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };
  const master = async (enabled: boolean) => {
    try {
      await rpc.call("settings_set_enabled", { enabled });
      refetch();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };
  if (data === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={data.enabled} onCheckedChange={(value) => void master(value)} aria-label="Run hooks" />
          <span>{data.enabled ? "Hooks are running" : "Hooks are paused"}</span>
        </label>
        <span className="text-xs text-muted-foreground">
          {data.hooks.length} hook{data.hooks.length === 1 ? "" : "s"} · {data.templates.length} in the marketplace · {data.secrets.length} secret{data.secrets.length === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex gap-2">
          <Button type="button" size="sm" onClick={() => navigate.toPluginPanel("marketplace")}>
            <Icon name="Puzzle" className="size-3.5" />
            Open the Hooks page
          </Button>
        </div>
      </div>
      {data.hooks.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">No hooks yet. Install one from the marketplace or describe one to an agent on the Hooks page.</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {data.hooks.map((hook) => (
            <li key={hook.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Switch checked={hook.enabled} onCheckedChange={(value) => void toggle(hook.id, value)} aria-label={`${hook.enabled ? "Disable" : "Enable"} ${hook.id}`} />
              <span className="font-mono text-xs">{hook.id}</span>
              <EventPill event={hook.event} />
              {hook.template ? <SourceBadge source={hook.template.source ?? "bundled"} /> : null}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{hook.description ?? compact(targetOf(hook), 80)}</span>
              <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => navigate.toPluginPanel("marketplace", { subPath: "installed" })}>
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">The raw JSON field above is the same list; it is there for copying, pasting and version control. Everything else is easier on the Hooks page.</p>
    </div>
  );
}
