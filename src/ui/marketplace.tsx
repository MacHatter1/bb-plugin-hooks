// The Marketplace tab: categories, featured picks, listing cards, and a
// template dialog with About, Install and What-it-runs sections.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { AgentField } from "./agent-field";
import {
  CATEGORIES,
  Chip,
  Code,
  EmptyState,
  EventPill,
  Field,
  IconBox,
  KindBadge,
  SourceBadge,
  Tag,
  categoryOf,
  errorMessage,
  iconForTemplate,
  shortEvent,
  templateKey,
  useInstalledCounts,
  useOverview,
  useSlashFocus,
  type TemplateEntry,
} from "./shared";

const FEATURED = ["desktop-notify", "slack", "review", "block-pattern"];

function matchesQuery(entry: TemplateEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const { template } = entry;
  return [entry.ref, template.name, template.summary, template.description ?? "", template.notes ?? "", (template.tags ?? []).join(" "), template.events.join(" ")]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

type View = "grid" | "list";
type Sort = "recommended" | "name" | "source";
const VIEW_KEY = "bb-hooks:marketplace-view";

function readView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function toneFor(entry: TemplateEntry): "neutral" | "gate" | "accent" {
  if (entry.template.kind === "gate") return "gate";
  return categoryOf(entry.template).id === "notify" ? "accent" : "neutral";
}

export function MarketplaceTab({ onInstalled, initialSource, onManageSources }: { onInstalled: () => void; initialSource?: string | null; onManageSources?: () => void }) {
  const { data } = useOverview();
  const installed = useInstalledCounts();
  const searchRef = useRef<HTMLInputElement | null>(null);
  useSlashFocus(searchRef);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string>(initialSource ?? "all");
  const [category, setCategory] = useState<string>("all");
  const [kind, setKind] = useState<"all" | "observe" | "gate">("all");
  const [sort, setSort] = useState<Sort>("recommended");
  const [view, setView] = useState<View>(() => readView());
  const [open, setOpen] = useState<{ entry: TemplateEntry; mode: "about" | "install" } | null>(null);
  useEffect(() => {
    if (initialSource) setSource(initialSource);
  }, [initialSource]);
  const changeView = (next: View) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* private mode */
    }
  };

  const templates = data?.templates ?? [];
  const sources = useMemo(() => ["bundled", ...[...new Set(templates.map((entry) => entry.source))].filter((name) => name !== "bundled").sort()], [templates]);
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of templates) {
      const id = categoryOf(entry.template).id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [templates]);
  const filtering = query.trim() !== "" || source !== "all" || category !== "all" || kind !== "all";
  const visible = useMemo(() => {
    const list = templates.filter(
      (entry) =>
        (source === "all" || entry.source === source) &&
        (kind === "all" || entry.template.kind === kind) &&
        (category === "all" || categoryOf(entry.template).id === category) &&
        matchesQuery(entry, query),
    );
    const byName = (a: TemplateEntry, b: TemplateEntry) => a.template.name.localeCompare(b.template.name);
    if (sort === "name") return [...list].sort(byName);
    if (sort === "source") return [...list].sort((a, b) => (a.source === b.source ? byName(a, b) : a.source === "bundled" ? -1 : b.source === "bundled" ? 1 : a.source.localeCompare(b.source)));
    // Recommended: featured first, then the catalog order, which authors curate.
    return [...list].sort((a, b) => {
      const fa = a.source === "bundled" ? FEATURED.indexOf(a.template.id) : -1;
      const fb = b.source === "bundled" ? FEATURED.indexOf(b.template.id) : -1;
      if (fa !== -1 || fb !== -1) return (fa === -1 ? 99 : fa) - (fb === -1 ? 99 : fb);
      return 0;
    });
  }, [templates, source, kind, category, query, sort]);
  const grouped = useMemo(() => {
    if (filtering || sort !== "recommended") return null;
    return CATEGORIES.map((item) => ({ category: item, entries: visible.filter((entry) => categoryOf(entry.template).id === item.id) })).filter((group) => group.entries.length > 0);
  }, [visible, filtering, sort]);
  const featured = useMemo(() => FEATURED.map((id) => templates.find((entry) => entry.source === "bundled" && entry.template.id === id)).filter((entry): entry is TemplateEntry => entry !== undefined), [templates]);
  const sourceRecord = useMemo(() => (source === "all" || source === "bundled" ? null : (data?.catalogs ?? []).find((record) => record.catalog?.name === source) ?? null), [data, source]);

  const renderEntries = (entries: TemplateEntry[]) =>
    view === "list" ? (
      <TemplateList entries={entries} installed={installed} onOpen={(entry, mode) => setOpen({ entry, mode })} />
    ) : (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <TemplateCard key={entry.ref} entry={entry} installedCount={installed.get(templateKey(entry)) ?? 0} onOpen={(mode) => setOpen({ entry, mode })} />
        ))}
      </div>
    );

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search hooks, services, events…  ( / )" aria-label="Search templates" className="pl-8 pr-8" />
          {query !== "" ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <Icon name="X" className="size-4" />
            </button>
          ) : null}
        </div>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-9 md:w-40" aria-label="Source">
            <SelectValue placeholder="All sources" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {sources.map((name) => (
              <SelectItem key={name} value={name}>
                {name === "bundled" ? "Built in" : name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
          <SelectTrigger className="h-9 md:w-36" aria-label="Kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            <SelectItem value="observe">Reacts to events</SelectItem>
            <SelectItem value="gate">Gates messages</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(value) => setSort(value as Sort)}>
          <SelectTrigger className="h-9 md:w-40" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recommended">By category</SelectItem>
            <SelectItem value="name">Name A–Z</SelectItem>
            <SelectItem value="source">By source</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex shrink-0 rounded-md border border-border p-0.5" role="group" aria-label="Layout">
          <Button type="button" size="icon" variant="ghost" className="size-8" aria-label="Grid" aria-pressed={view === "grid"} onClick={() => changeView("grid")}>
            <Icon name="GridView" className="size-4" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="size-8" aria-label="List" aria-pressed={view === "list"} onClick={() => changeView("list")}>
            <Icon name="ListView" className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Chip active={category === "all"} onClick={() => setCategory("all")} count={templates.length}>
          All
        </Chip>
        {CATEGORIES.map((item) => (
          <Chip key={item.id} active={category === item.id} onClick={() => setCategory(category === item.id ? "all" : item.id)} icon={item.icon} count={categoryCounts.get(item.id) ?? 0}>
            {item.label}
          </Chip>
        ))}
      </div>

      {sourceRecord ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3">
          <IconBox name={sourceRecord.url.includes("github") ? "Github" : "Globe"} tone="accent" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="font-semibold">{sourceRecord.catalog?.name}</span>
              {sourceRecord.catalog?.version ? <span className="text-xs text-muted-foreground">v{sourceRecord.catalog.version}</span> : null}
              {sourceRecord.catalog?.author ? <span className="text-xs text-muted-foreground">by {sourceRecord.catalog.author}</span> : null}
              <span className="text-xs text-muted-foreground">· {sourceRecord.catalog?.templates.length ?? 0} templates</span>
            </div>
            <p className="truncate text-xs text-muted-foreground">{sourceRecord.catalog?.description ?? sourceRecord.url}</p>
          </div>
          {sourceRecord.catalog?.homepage ? (
            <a href={sourceRecord.catalog.homepage} target="_blank" rel="noopener noreferrer" className="text-xs underline underline-offset-4">
              homepage
            </a>
          ) : null}
          {onManageSources ? (
            <Button type="button" size="sm" variant="ghost" onClick={onManageSources}>
              Manage sources
            </Button>
          ) : null}
        </div>
      ) : null}

      {data === null ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy>
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="h-40 animate-pulse rounded-lg border border-border bg-muted/40" />
          ))}
        </div>
      ) : (
        <>
          {!filtering && featured.length > 0 && sort === "recommended" ? (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Start here</h2>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {featured.map((entry) => (
                  <button
                    key={entry.ref}
                    type="button"
                    onClick={() => setOpen({ entry, mode: "install" })}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-foreground/30 hover:bg-state-hover"
                  >
                    <IconBox name={iconForTemplate(entry.template)} tone={toneFor(entry)} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">{entry.template.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{entry.template.summary}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {visible.length === 0 ? (
            <EmptyState icon="Search" title="Nothing matches">
              {data.catalogs.length === 0 ? "Add a catalog under Sources to get more hooks, or write your own under Installed." : "Try another search, category or source."}
            </EmptyState>
          ) : grouped ? (
            grouped.map((group) => (
              <section key={group.category.id} className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Icon name={group.category.icon} className="size-3.5" />
                    {group.category.label}
                    <span className="font-normal normal-case">· {group.entries.length}</span>
                  </h2>
                  <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setCategory(group.category.id)}>
                    Only {group.category.label.toLowerCase()}
                  </button>
                </div>
                {renderEntries(group.entries)}
              </section>
            ))
          ) : (
            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {filtering ? `${visible.length} of ${templates.length} hooks` : `All ${templates.length} hooks`}
                </h2>
                {filtering ? (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                    onClick={() => {
                      setQuery("");
                      setSource("all");
                      setCategory("all");
                      setKind("all");
                    }}
                  >
                    Clear filters
                  </button>
                ) : null}
              </div>
              {renderEntries(visible)}
            </section>
          )}
        </>
      )}

      {open === null ? null : (
        <TemplateDialog
          entry={open.entry}
          mode={open.mode}
          onClose={() => setOpen(null)}
          onInstalled={() => {
            setOpen(null);
            onInstalled();
          }}
        />
      )}
    </div>
  );
}

function TemplateCard({ entry, installedCount, onOpen }: { entry: TemplateEntry; installedCount: number; onOpen: (mode: "about" | "install") => void }) {
  const { template } = entry;
  const events = template.events.slice(0, 3);
  const more = template.events.length - events.length;
  return (
    <article className="group relative flex h-full flex-col rounded-lg border border-border bg-card transition-colors hover:border-foreground/30">
      <button type="button" onClick={() => onOpen("about")} className="flex flex-1 flex-col gap-3 px-4 pb-3 pt-4 text-left">
        <span className="flex items-start gap-3">
          <IconBox name={iconForTemplate(template)} tone={toneFor(entry)} className="size-10" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 pr-10">
              <span className="truncate text-sm font-semibold text-foreground">{template.name}</span>
              {template.kind === "gate" ? <KindBadge kind="gate" /> : null}
            </span>
            <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">{template.summary}</span>
          </span>
        </span>
        <span className="flex flex-nowrap items-center gap-1 overflow-hidden whitespace-nowrap">
          {events.map((event) => (
            <EventPill key={event} event={event} />
          ))}
          {more > 0 ? <span className="text-[11px] text-muted-foreground">+{more}</span> : null}
        </span>
        {installedCount > 0 ? (
          <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary" title={`${installedCount} installed`}>
            <Icon name="Check" className="size-3" />
            {installedCount}
          </span>
        ) : null}
      </button>
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2">
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground">
          <SourceBadge source={entry.source} />
          {template.author ? <span className="truncate">by {template.author}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onOpen("about")}>
            Details
          </Button>
          <Button type="button" size="sm" className="h-7 px-2.5 text-xs" onClick={() => onOpen("install")}>
            <Icon name="Plus" className="size-3.5" />
            Install
          </Button>
        </span>
      </div>
    </article>
  );
}

function TemplateList({ entries, installed, onOpen }: { entries: TemplateEntry[]; installed: Map<string, number>; onOpen: (entry: TemplateEntry, mode: "about" | "install") => void }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {entries.map((entry) => {
        const { template } = entry;
        const count = installed.get(templateKey(entry)) ?? 0;
        return (
          <li key={entry.ref} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-state-hover">
            <IconBox name={iconForTemplate(template)} tone={toneFor(entry)} className="size-8" />
            <button type="button" onClick={() => onOpen(entry, "about")} className="min-w-0 flex-1 text-left">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-medium text-foreground">{template.name}</span>
                {template.kind === "gate" ? <KindBadge kind="gate" /> : null}
                <SourceBadge source={entry.source} />
                {count > 0 ? (
                  <span className="inline-flex items-center gap-0.5 text-[11px] text-primary">
                    <Icon name="Check" className="size-3" />
                    {count}
                  </span>
                ) : null}
              </span>
              <span className="block truncate text-xs text-muted-foreground">{template.summary}</span>
            </button>
            <div className="hidden shrink-0 items-center gap-1 lg:flex">
              {template.events.slice(0, 2).map((event) => (
                <EventPill key={event} event={event} />
              ))}
              {template.events.length > 2 ? <span className="text-[11px] text-muted-foreground">+{template.events.length - 2}</span> : null}
            </div>
            <span className="hidden w-24 shrink-0 truncate text-[11px] text-muted-foreground md:block">{template.author ? `by ${template.author}` : ""}</span>
            <Button type="button" size="sm" className="h-7 px-2.5 text-xs" onClick={() => onOpen(entry, "install")}>
              <Icon name="Plus" className="size-3.5" />
              Install
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function WhatItRuns({ entry }: { entry: TemplateEntry }) {
  const { template } = entry;
  const lines: string[] = [];
  if (template.command !== undefined) lines.push(template.command);
  if (template.url !== undefined) lines.push(`POST ${template.url}`);
  if (template.body !== undefined) lines.push(`body: ${template.body}`);
  if (template.headers !== undefined) lines.push(`headers: ${JSON.stringify(template.headers)}`);
  if (template.match !== undefined) lines.push(`match: ${JSON.stringify(template.match)}`);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {template.command !== undefined ? "A /bin/sh script on the machine that hosts BB. " : "An HTTPS request BB sends itself; no shell runs. "}
        {entry.source === "bundled" ? "Bundled with the plugin." : `From the "${entry.source}" catalog: read it before installing.`}
      </p>
      <Code>{lines.join("\n")}</Code>
    </div>
  );
}

function TemplateDialog({ entry, mode, onClose, onInstalled }: { entry: TemplateEntry; mode: "about" | "install"; onClose: () => void; onInstalled: () => void }) {
  const { rpc, data, refetch } = useOverview();
  const { template } = entry;
  const gate = template.kind === "gate";
  const observeEvents = useMemo(() => (data?.events ?? []).filter((info) => info.kind === "observe"), [data]);
  const [tab, setTab] = useState<string>(mode);
  const [params, setParams] = useState<Record<string, string>>(() => Object.fromEntries(template.params.map((param) => [param.key, param.default ?? ""])));
  const [events, setEvents] = useState<string[]>(template.events);
  const [hookId, setHookId] = useState(template.id);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [text, setText] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [trusted, setTrusted] = useState(entry.source === "bundled");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = template.params.filter((param) => param.required && (params[param.key] ?? "").trim() === "").map((param) => param.label);
  const category = categoryOf(template);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const match: Record<string, string> = {};
      if (title.trim() !== "") match.title = title.trim();
      if (projectId.trim() !== "") match.projectId = projectId.trim();
      if (text.trim() !== "") match.text = text.trim();
      const cleanParams = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== ""));
      const input: Parameters<typeof rpc.call<"template_use">>[1] = { ref: entry.ref, params: cleanParams, trusted };
      if (!gate) input.events = events as typeof template.events;
      if (hookId.trim() !== "" && hookId.trim() !== template.id) input.id = hookId.trim();
      if (Object.keys(match).length > 0) input.match = match;
      const result = await rpc.call("template_use", input);
      toast.success(`Installed ${result.hooks.length === 1 ? `"${result.hooks[0]?.id}"` : `${result.hooks.length} hooks`}${result.secrets.length > 0 ? ", secret stored encrypted" : ""}`);
      refetch();
      onInstalled();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(value) => (value ? undefined : onClose())}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="space-y-3 border-b border-border px-6 pb-4 pt-6 text-left">
          <div className="flex items-start gap-3">
            <IconBox name={iconForTemplate(template)} tone={gate ? "gate" : "accent"} className="size-11" />
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
                {template.name}
                <KindBadge kind={template.kind} />
                <SourceBadge source={entry.source} />
              </DialogTitle>
              <DialogDescription className="mt-1">
                {template.summary}
                {template.author ? (
                  <span className="mt-1 block text-xs">
                    by {template.author}
                    {template.version ? ` · v${template.version}` : ""}
                    {template.homepage ? (
                      <>
                        {" · "}
                        <a href={template.homepage} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                          homepage
                        </a>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-6 mt-3 w-fit">
            <TabsTrigger value="about">About</TabsTrigger>
            <TabsTrigger value="install">Install</TabsTrigger>
            <TabsTrigger value="runs">What it runs</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <TabsContent value="about" className="mt-0 space-y-4">
              {template.description ? <p className="text-sm leading-6 text-foreground">{template.description}</p> : <p className="text-sm text-muted-foreground">No further description.</p>}
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Category</dt>
                  <dd className="mt-0.5 flex items-center gap-1.5">
                    <Icon name={category.icon} className="size-3.5" />
                    {category.label}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">{gate ? "Runs on" : "Default events"}</dt>
                  <dd className="mt-0.5 flex flex-wrap gap-1">
                    {template.events.map((event) => (
                      <EventPill key={event} event={event} />
                    ))}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Settings</dt>
                  <dd className="mt-0.5 text-muted-foreground">
                    {template.params.length === 0 ? "none" : template.params.map((param) => `${param.label}${param.secret ? " (encrypted)" : ""}${param.required ? "" : " (optional)"}`).join(", ")}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Tags</dt>
                  <dd className="mt-0.5 flex flex-wrap gap-1">{(template.tags ?? []).length === 0 ? <span className="text-muted-foreground">none</span> : template.tags?.map((tag) => <Tag key={tag}>{tag}</Tag>)}</dd>
                </div>
                {template.author || template.version || template.homepage ? (
                  <div className="sm:col-span-2">
                    <dt className="text-xs font-medium text-muted-foreground">Listing</dt>
                    <dd className="mt-0.5 text-muted-foreground">
                      {[template.author, template.version ? `v${template.version}` : null].filter(Boolean).join(" · ")}
                      {template.homepage ? (
                        <>
                          {" · "}
                          <a href={template.homepage} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                            homepage
                          </a>
                        </>
                      ) : null}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {template.notes ? (
                <p className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                  <Icon name="Info" className="mt-0.5 size-3.5 shrink-0" />
                  {template.notes}
                </p>
              ) : null}
            </TabsContent>
            <TabsContent value="install" className="mt-0">
              <form id="install-form" onSubmit={submit} className="space-y-4">
                {template.params.length > 0 ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {template.params.map((param) => (
                      <Field
                        key={param.key}
                        className={param.type === "agent" || (param.type === "string" && !param.secret && (param.default ?? "").length > 40) ? "sm:col-span-2" : undefined}
                        label={`${param.label}${param.required ? "" : " (optional)"}`}
                        hint={[param.description, param.secret ? "Stored encrypted, never written into the hook." : null].filter(Boolean).join(" ")}
                      >
                        {param.type === "agent" ? (
                          <AgentField value={params[param.key] ?? "inherit"} onChange={(next) => setParams((prev) => ({ ...prev, [param.key]: next }))} />
                        ) : (
                          <Input
                            type={param.secret ? "password" : param.type === "integer" ? "number" : "text"}
                            value={params[param.key] ?? ""}
                            onChange={(event) => setParams((prev) => ({ ...prev, [param.key]: event.target.value }))}
                            placeholder={param.default ?? ""}
                            autoComplete="off"
                          />
                        )}
                      </Field>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">This hook has no settings.</p>
                )}
                {gate ? (
                  <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-foreground">
                    <Icon name="SecurityCheck" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                    Gate hook: runs before every message reaches an agent and must answer within 8 seconds. Send now on a queued message bypasses it.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-foreground">Run when</span>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {observeEvents.map((info) => {
                        const checked = events.includes(info.event);
                        return (
                          <label key={info.event} className={cn("flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 text-xs hover:bg-state-hover", checked ? "border-foreground/40" : "border-border")} title={info.summary}>
                            <Checkbox checked={checked} onCheckedChange={(value) => setEvents((prev) => (value === true ? [...prev, info.event] : prev.filter((event) => event !== info.event)))} className="mt-0.5" />
                            <span className="min-w-0">
                              <span className="block font-mono">{shortEvent(info.event)}</span>
                              <span className="block truncate text-muted-foreground">{info.summary}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {events.length === 0 ? <p className="text-xs text-destructive">Pick at least one event.</p> : null}
                  </div>
                )}
                <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setAdvanced((value) => !value)}>
                  {advanced ? "Hide" : "Show"} filters and hook id
                </button>
                {advanced ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Hook id" hint="Several events get an -event suffix.">
                      <Input value={hookId} onChange={(event) => setHookId(event.target.value)} />
                    </Field>
                    <Field label="Only threads whose title matches" hint="Regular expression, e.g. ^feat">
                      <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="^feat" />
                    </Field>
                    <Field label="Only in project" hint="A proj_… id">
                      <Input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="proj_…" />
                    </Field>
                    <Field label="Only when the text matches" hint="Regular expression on the message or reply">
                      <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="#overnight" />
                    </Field>
                  </div>
                ) : null}
                {entry.source !== "bundled" ? (
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
                    <Checkbox checked={trusted} onCheckedChange={(value) => setTrusted(value === true)} className="mt-0.5" />
                    <span>
                      This hook comes from the <strong>{entry.source}</strong> catalog and will run on the machine hosting BB. I have read <button type="button" className="underline underline-offset-2" onClick={() => setTab("runs")}>what it runs</button> and trust it.
                    </span>
                  </label>
                ) : null}
                {error === null ? null : (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </form>
            </TabsContent>
            <TabsContent value="runs" className="mt-0">
              <WhatItRuns entry={entry} />
            </TabsContent>
          </div>
        </Tabs>
        <DialogFooter className="border-t border-border px-6 py-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          {tab === "install" ? (
            <Button type="submit" form="install-form" disabled={pending || missing.length > 0 || !trusted || (!gate && events.length === 0)}>
              {pending ? "Installing…" : missing.length > 0 ? `Fill in ${missing.join(", ")}` : "Install"}
            </Button>
          ) : (
            <Button type="button" onClick={() => setTab("install")}>
              <Icon name="Plus" className="size-3.5" />
              Install
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
