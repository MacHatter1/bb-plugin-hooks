// The Sources tab: catalogs as cards, add by alias or reference, publish help.
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Chip, Code, EmptyState, IconBox, SectionTitle, StatusDot, errorMessage, formatWhen, useOverview } from "./shared";

export function SourcesTab({ onBrowse }: { onBrowse: (source: string) => void }) {
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
      toast.error(errorMessage(cause).replace(/^rpc handler failed: /, ""));
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

  if (data === null) return <EmptyState icon="Loading" title="Loading…" />;
  const aliases = Object.keys(data.aliases);
  const configured = new Set(data.catalogs.map((record) => record.url));
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <SectionTitle hint="A catalog is a hooks-catalog.json at an https URL or at the root of a GitHub repository. Its templates appear in the Marketplace and need your confirmation before they run.">Add a catalog</SectionTitle>
        <form onSubmit={add} className="flex items-center gap-2">
          <div className="relative flex-1">
            <Icon name="Puzzle" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={source} onChange={(event) => setSource(event.target.value)} placeholder="owner/repo, owner/repo@v1.0.0, or https://…/hooks-catalog.json" aria-label="Catalog source" className="pl-8" />
          </div>
          <Button type="submit" disabled={pending !== null || source.trim() === ""}>
            <Icon name="Plus" className="size-4" />
            {pending === "add" ? "Adding…" : "Add"}
          </Button>
        </form>
        {aliases.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>Shortcuts:</span>
            {aliases.map((alias) => (
              <Chip key={alias} active={configured.has(data.aliases[alias] ?? "")} onClick={() => setSource(alias)} icon="Star">
                {alias}
              </Chip>
            ))}
            <Chip active={false} onClick={() => setSource("MacHatter1/bb-hooks-marketplace")} icon="Github">
              community
            </Chip>
          </div>
        ) : null}
      </section>

      <section className="space-y-2">
        <SectionTitle
          hint="Refreshed every six hours and whenever you ask."
          actions={
            <Button type="button" size="sm" variant="ghost" disabled={pending !== null || data.catalogs.length === 0} onClick={() => void call("refresh", () => rpc.call("catalog_refresh", {}), "Catalogs refreshed")}>
              <Icon name="RotateCcw" className="size-3.5" />
              {pending === "refresh" ? "Refreshing…" : "Refresh all"}
            </Button>
          }
        >
          Catalogs <span className="font-normal text-muted-foreground">({data.catalogs.length})</span>
        </SectionTitle>
        {data.catalogs.length === 0 ? (
          <EmptyState icon="Puzzle" title="No catalogs yet">
            Add one above. The built-in templates are always available.
          </EmptyState>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {data.catalogs.map((record) => {
              const name = record.catalog?.name ?? record.name ?? "unknown";
              const count = record.catalog?.templates.length ?? 0;
              const gates = record.catalog?.templates.filter((template) => template.kind === "gate").length ?? 0;
              return (
                <article key={record.url} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
                  <div className="flex items-start gap-3">
                    <IconBox name={record.url.includes("github") ? "Github" : "Globe"} tone="accent" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold">{name}</span>
                        {record.catalog?.version ? <span className="text-xs text-muted-foreground">v{record.catalog.version}</span> : null}
                        {record.catalog?.author ? <span className="text-xs text-muted-foreground">by {record.catalog.author}</span> : null}
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <StatusDot status={record.error ? "error" : "ok"} />
                          {record.error ? record.error : `fetched ${formatWhen(record.fetchedAt)}`}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{record.catalog?.description ?? "No description."}</p>
                      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={record.url}>
                        {record.url}
                      </p>
                    </div>
                  </div>
                  {record.catalog && record.catalog.templates.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {record.catalog.templates.slice(0, 6).map((template) => (
                        <span key={template.id} className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {template.name}
                        </span>
                      ))}
                      {record.catalog.templates.length > 6 ? <span className="px-1 text-[11px] text-muted-foreground">+{record.catalog.templates.length - 6} more</span> : null}
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {count} template{count === 1 ? "" : "s"}
                      {gates > 0 ? ` · ${gates} gate${gates === 1 ? "" : "s"}` : ""}
                      {record.catalog?.homepage ? (
                        <>
                          {" · "}
                          <a href={record.catalog.homepage} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                            homepage
                          </a>
                        </>
                      ) : null}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button type="button" size="sm" variant="outline" onClick={() => onBrowse(name)} disabled={count === 0}>
                        Browse
                      </Button>
                      <Button type="button" size="sm" variant="ghost" disabled={pending !== null} onClick={() => void call(record.url, () => rpc.call("catalog_refresh", { source: record.url }), "Catalog refreshed")}>
                        <Icon name="RotateCcw" className="size-3.5" />
                      </Button>
                      <Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" aria-label={`Remove ${name}`} disabled={pending !== null} onClick={() => void call(record.url, () => rpc.call("catalog_remove", { source: record.url }), "Catalog removed")}>
                        <Icon name="Trash2" className="size-4" />
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <SectionTitle hint="Put a hooks-catalog.json at the root of a GitHub repository; anyone can then add it as owner/repo.">Publish your own</SectionTitle>
        <Code>{"bb hooks marketplace init --name my-hooks > hooks-catalog.json\nbb hooks export <hook-id>              # turn an installed hook into a template\nbb hooks marketplace validate owner/repo"}</Code>
      </section>
    </div>
  );
}
