// The Sources tab: catalogs the marketplace reads, and how to publish one.
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Badge, Code, EmptyState, SectionTitle, errorMessage, formatWhen, useOverview } from "./shared";

export function SourcesTab() {
  const { data, rpc, refetch } = useOverview();
  const [source, setSource] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  const call = async (label: string, work: () => Promise<unknown>, success: string) => {
    setPending(label);
    try {
      await work();
      toast.success(success);
      refetch();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = source.trim();
    if (value === "") return;
    void call("add", () => rpc.call("catalog_add", { source: value }), `Added catalog ${value}`).then(() => setSource(""));
  };

  if (data === null) return <EmptyState>Loading…</EmptyState>;
  const aliases = Object.keys(data.aliases);
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <SectionTitle>Add a catalog</SectionTitle>
        <form onSubmit={add} className="flex items-center gap-2">
          <Input value={source} onChange={(event) => setSource(event.target.value)} placeholder="owner/repo, https://…/hooks-catalog.json, or starter" aria-label="Catalog source" />
          <Button type="submit" disabled={pending !== null || source.trim() === ""}>
            <Icon name="Plus" className="size-4" />
            {pending === "add" ? "Adding…" : "Add"}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          A catalog is a <code>hooks-catalog.json</code> at an https URL or at the root of a GitHub repository ({aliases.length > 0 ? `alias${aliases.length === 1 ? "" : "es"}: ${aliases.join(", ")}` : "no aliases"}). Templates from catalogs are installed only after you confirm what they run.
        </p>
      </section>

      <section className="space-y-2">
        <SectionTitle
          actions={
            <Button type="button" size="sm" variant="ghost" disabled={pending !== null || data.catalogs.length === 0} onClick={() => void call("refresh", () => rpc.call("catalog_refresh", {}), "Catalogs refreshed")}>
              <Icon name="RotateCcw" className="size-3.5" />
              {pending === "refresh" ? "Refreshing…" : "Refresh all"}
            </Button>
          }
        >
          Catalogs
        </SectionTitle>
        {data.catalogs.length === 0 ? (
          <EmptyState>No catalogs yet. Add one above.</EmptyState>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {data.catalogs.map((record) => (
              <li key={record.url} className="flex items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{record.catalog?.name ?? record.name ?? "unknown"}</span>
                    <Badge>{record.catalog?.templates.length ?? 0} templates</Badge>
                    {record.error ? <Badge tone="warn">{record.error}</Badge> : <Badge tone="ok">ok</Badge>}
                    <span className="text-xs text-muted-foreground">fetched {formatWhen(record.fetchedAt)}</span>
                  </div>
                  {record.catalog?.description ? <p className="text-xs text-muted-foreground">{record.catalog.description}</p> : null}
                  <p className="truncate font-mono text-[11px] text-muted-foreground" title={record.url}>
                    {record.url}
                  </p>
                </div>
                <Button type="button" size="sm" variant="ghost" disabled={pending !== null} onClick={() => void call(record.url, () => rpc.call("catalog_refresh", { source: record.url }), "Catalog refreshed")}>
                  Refresh
                </Button>
                <Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" aria-label={`Remove ${record.url}`} disabled={pending !== null} onClick={() => void call(record.url, () => rpc.call("catalog_remove", { source: record.url }), "Catalog removed")}>
                  <Icon name="Trash2" className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <SectionTitle>Publish your own</SectionTitle>
        <p className="text-xs text-muted-foreground">Put a hooks-catalog.json at the root of a GitHub repo; anyone can then add it as owner/repo. Start from the built-in example and turn existing hooks into templates:</p>
        <Code>{"bb hooks marketplace init --name my-hooks > hooks-catalog.json\nbb hooks export <hook-id>            # a template from an installed hook\nbb hooks marketplace validate owner/repo"}</Code>
      </section>
    </div>
  );
}
