// The page: a stats strip, the tab strip, and the active tab's content.
import { useEffect, useMemo, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { InstalledTab } from "./installed";
import { MarketplaceTab } from "./marketplace";
import { ReferenceTab } from "./reference";
import { SecretsTab } from "./secrets";
import { NEW_HOOK_PROMPT, OverviewProvider, Stat, errorMessage, useHistory, useOverview } from "./shared";
import { SourcesTab } from "./sources";

export const PANEL_PATH = "marketplace";
const TABS = [
  { id: "marketplace", label: "Marketplace", icon: "Puzzle" },
  { id: "installed", label: "Installed", icon: "Zap" },
  { id: "sources", label: "Sources", icon: "Github" },
  { id: "secrets", label: "Secrets", icon: "Lock" },
  { id: "reference", label: "Reference", icon: "FileText" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function tabFromSubPath(subPath: string): TabId {
  const first = subPath.split("/")[0] ?? "";
  if (first === "" || first === "marketplace") return "marketplace";
  return (TABS.find((tab) => tab.id === first)?.id ?? "marketplace") as TabId;
}

export function HooksPage({ subPath }: { subPath: string }) {
  return (
    <OverviewProvider>
      <TooltipProvider delayDuration={300}>
        <PageBody subPath={subPath} />
      </TooltipProvider>
    </OverviewProvider>
  );
}

function PageBody({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const { data, error } = useOverview();
  const [tab, setTab] = useState<TabId>(() => tabFromSubPath(subPath));
  const [marketSource, setMarketSource] = useState<string | null>(null);
  const newHook = () => navigate.toCompose({ initialPrompt: NEW_HOOK_PROMPT, focusPrompt: true });
  useEffect(() => {
    setTab(tabFromSubPath(subPath));
  }, [subPath]);
  const go = (next: TabId) => {
    setTab(next);
    navigate.toPluginPanel(PANEL_PATH, { subPath: next === "marketplace" ? "" : next });
  };
  const counts: Partial<Record<TabId, number>> = data === null ? {} : { marketplace: data.templates.length, installed: data.hooks.length, sources: data.catalogs.length, secrets: data.secrets.length };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-5 p-4 md:p-5">
        {error !== null ? (
          <p className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <Icon name="AlertTriangle" className="size-3.5" />
            {error}
          </p>
        ) : null}
        <StatsStrip onGo={go} onNewHook={newHook} />
        <Tabs value={tab} onValueChange={(value) => go(value as TabId)}>
          <TabsList className="w-full justify-start overflow-x-auto">
            {TABS.map((item) => (
              <TabsTrigger key={item.id} value={item.id} className="gap-1.5">
                <Icon name={item.icon} className="size-3.5" />
                {item.label}
                {counts[item.id] !== undefined ? <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{counts[item.id]}</span> : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {tab === "marketplace" ? <MarketplaceTab onInstalled={() => go("installed")} initialSource={marketSource} /> : null}
        {tab === "installed" ? <InstalledTab onBrowse={() => go("marketplace")} onNewHook={newHook} /> : null}
        {tab === "sources" ? (
          <SourcesTab
            onBrowse={(source) => {
              setMarketSource(source);
              go("marketplace");
            }}
          />
        ) : null}
        {tab === "secrets" ? <SecretsTab /> : null}
        {tab === "reference" ? <ReferenceTab /> : null}
      </div>
    </div>
  );
}

function StatsStrip({ onGo, onNewHook }: { onGo: (tab: TabId) => void; onNewHook: () => void }) {
  const { data } = useOverview();
  const { runs } = useHistory(200);
  const stats = useMemo(() => {
    const dayAgo = Date.now() - 86_400_000;
    const recent = (runs ?? []).filter((run) => run.startedAt >= dayAgo);
    const failed = recent.filter((run) => run.status !== "ok").length;
    const enabled = (data?.hooks ?? []).filter((hook) => hook.enabled).length;
    return { recent: recent.length, failed, enabled };
  }, [runs, data]);
  if (data === null) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <Stat icon="Zap" label={data.enabled ? "hooks installed" : "hooks installed · paused"} value={data.hooks.length} hint={data.hooks.length > 0 ? `${stats.enabled} on` : undefined} tone={data.enabled ? (data.hooks.length > 0 ? "ok" : "neutral") : "warn"} onClick={() => onGo("installed")} />
      <Stat icon="Clock" label="runs in the last 24 h" value={stats.recent} hint={stats.failed > 0 ? `${stats.failed} failed` : runs === null ? undefined : "all ok"} tone={stats.failed > 0 ? "warn" : "neutral"} onClick={() => onGo("installed")} />
      <Stat icon="Puzzle" label="hooks in the marketplace" value={data.templates.length} hint={`${data.catalogs.length} catalog${data.catalogs.length === 1 ? "" : "s"}`} onClick={() => onGo("marketplace")} />
      <button type="button" onClick={onNewHook} className="flex items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2.5 text-left transition-colors hover:border-foreground/40 hover:bg-state-hover">
        <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon name="Plus" className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">New hook</span>
          <span className="block truncate text-xs text-muted-foreground">Describe it to an agent</span>
        </span>
      </button>
    </div>
  );
}

/** Rendered in the host title bar: the master switch and a refresh button. */
export function HeaderActions() {
  return (
    <OverviewProvider>
      <TooltipProvider delayDuration={300}>
        <HeaderControls />
      </TooltipProvider>
    </OverviewProvider>
  );
}

function HeaderControls() {
  const { data, rpc, refetch } = useOverview();
  const [pending, setPending] = useState(false);
  const toggle = async (enabled: boolean) => {
    setPending(true);
    try {
      await rpc.call("settings_set_enabled", { enabled });
      toast.success(enabled ? "Hooks are running" : "Hooks paused: nothing fires until you switch them back on");
      refetch();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex items-center gap-3">
      {data === null ? null : (
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={data.enabled} onCheckedChange={(value) => void toggle(value)} disabled={pending} aria-label="Run hooks" />
          <span className={data.enabled ? "text-foreground" : "text-destructive"}>{data.enabled ? "Running" : "Paused"}</span>
        </label>
      )}
      <button type="button" onClick={refetch} aria-label="Refresh" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground">
        <Icon name="RotateCcw" className="size-4" />
      </button>
    </div>
  );
}
