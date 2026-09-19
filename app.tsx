// bb-plugin-hooks — the Hooks marketplace page in the BB sidebar.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time.
import { useEffect, useState } from "react";
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { InstalledTab } from "./src/ui/installed";
import { MarketplaceTab } from "./src/ui/marketplace";
import { SecretsTab } from "./src/ui/secrets";
import { OverviewProvider, useOverview } from "./src/ui/shared";
import { SourcesTab } from "./src/ui/sources";

const PANEL_PATH = "marketplace";
const TABS = [
  { id: "", label: "Marketplace" },
  { id: "installed", label: "Installed" },
  { id: "sources", label: "Sources" },
  { id: "secrets", label: "Secrets" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function tabFromSubPath(subPath: string): TabId {
  const first = subPath.split("/")[0] ?? "";
  return (TABS.find((tab) => tab.id === first)?.id ?? "") as TabId;
}

function HooksPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const [tab, setTab] = useState<TabId>(() => tabFromSubPath(subPath));
  useEffect(() => {
    setTab(tabFromSubPath(subPath));
  }, [subPath]);
  const go = (next: TabId) => {
    setTab(next);
    navigate.toPluginPanel(PANEL_PATH, { subPath: next });
  };
  return (
    <OverviewProvider>
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-5">
          <Tabs active={tab} onSelect={go} />
          {tab === "" ? <MarketplaceTab onInstalled={() => go("installed")} /> : null}
          {tab === "installed" ? <InstalledTab onBrowse={() => go("")} /> : null}
          {tab === "sources" ? <SourcesTab /> : null}
          {tab === "secrets" ? <SecretsTab /> : null}
        </div>
      </div>
    </OverviewProvider>
  );
}

function Tabs({ active, onSelect }: { active: TabId; onSelect: (tab: TabId) => void }) {
  return (
    <TabCounts>
      {(counts) => (
        <nav className="flex gap-1 border-b border-border" aria-label="Hooks sections">
          {TABS.map((tab) => {
            const count = counts[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onSelect(tab.id)}
                aria-current={active === tab.id ? "page" : undefined}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                  active === tab.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                {count !== undefined ? <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{count}</span> : null}
              </button>
            );
          })}
        </nav>
      )}
    </TabCounts>
  );
}

function TabCounts({ children }: { children: (counts: Partial<Record<TabId, number>>) => React.ReactNode }) {
  const { data } = useOverview();
  return <>{children(data === null ? {} : { "": data.templates.length, installed: data.hooks.length, sources: data.catalogs.length, secrets: data.secrets.length })}</>;
}

function HeaderActions() {
  return (
    <OverviewProvider>
      <HeaderRefresh />
    </OverviewProvider>
  );
}

function HeaderRefresh() {
  const { refetch, error } = useOverview();
  return (
    <div className="flex items-center gap-2">
      {error !== null ? <span className="text-xs text-destructive">{error}</span> : null}
      <Button type="button" size="sm" variant="ghost" onClick={refetch} aria-label="Refresh">
        <Icon name="RotateCcw" className="size-4" />
      </Button>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "marketplace",
    title: "Hooks",
    icon: "Webhook",
    path: PANEL_PATH,
    component: HooksPage,
    headerContent: HeaderActions,
  });
});
