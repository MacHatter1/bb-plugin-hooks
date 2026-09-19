// The Marketplace tab: browse listings from every source and install one.
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Badge, Code, EmptyState, Field, errorMessage, shortEvent, useOverview, type TemplateEntry } from "./shared";

function matchesQuery(entry: TemplateEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const { template } = entry;
  return [entry.ref, template.name, template.summary, template.description ?? "", template.notes ?? "", (template.tags ?? []).join(" "), template.events.join(" ")]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

export function MarketplaceTab({ onInstalled }: { onInstalled: () => void }) {
  const { data } = useOverview();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string>("all");
  const [kind, setKind] = useState<"all" | "observe" | "gate">("all");
  const [installing, setInstalling] = useState<TemplateEntry | null>(null);

  const sources = useMemo(() => {
    const names = new Set<string>();
    for (const entry of data?.templates ?? []) names.add(entry.source);
    return ["bundled", ...[...names].filter((name) => name !== "bundled").sort()];
  }, [data]);
  const visible = useMemo(
    () => (data?.templates ?? []).filter((entry) => (source === "all" || entry.source === source) && (kind === "all" || entry.template.kind === kind) && matchesQuery(entry, query)),
    [data, source, kind, query],
  );
  const installedTemplates = useMemo(() => new Set((data?.hooks ?? []).map((hook) => hook.template?.id).filter((id): id is string => id !== undefined)), [data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search hooks: slack, phone, review, gate…" aria-label="Search templates" className="pl-8" />
        </div>
        <div className="flex flex-wrap gap-1">
          {(["all", "observe", "gate"] as const).map((value) => (
            <Button key={value} type="button" size="sm" variant={kind === value ? "secondary" : "ghost"} onClick={() => setKind(value)}>
              {value === "all" ? "All kinds" : value === "observe" ? "Reacts" : "Gates"}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <span className="mr-1 text-muted-foreground">Source:</span>
        <FilterChip active={source === "all"} onClick={() => setSource("all")}>
          All
        </FilterChip>
        {sources.map((name) => (
          <FilterChip key={name} active={source === name} onClick={() => setSource(name)}>
            {name === "bundled" ? "Built in" : name}
          </FilterChip>
        ))}
      </div>
      {data === null ? (
        <EmptyState>Loading the marketplace…</EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>
          Nothing matches. {data.catalogs.length === 0 ? "Add a catalog under Sources to get more hooks." : "Try another search or source."}
        </EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {visible.map((entry) => (
            <TemplateCard key={entry.ref} entry={entry} installed={installedTemplates.has(entry.template.id)} onInstall={() => setInstalling(entry)} />
          ))}
        </div>
      )}
      {installing === null ? null : (
        <InstallDialog
          entry={installing}
          onClose={() => setInstalling(null)}
          onInstalled={() => {
            setInstalling(null);
            onInstalled();
          }}
        />
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-0.5 transition-colors",
        active ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function TemplateCard({ entry, installed, onInstall }: { entry: TemplateEntry; installed: boolean; onInstall: () => void }) {
  const { template } = entry;
  const [open, setOpen] = useState(false);
  return (
    <Card className="flex flex-col">
      <CardHeader className="space-y-1.5 pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm leading-5">{template.name}</CardTitle>
          <div className="flex shrink-0 gap-1">
            <Badge tone={template.kind === "gate" ? "warn" : "neutral"}>{template.kind === "gate" ? "gate" : "reacts"}</Badge>
            <Badge tone={entry.source === "bundled" ? "ok" : "accent"}>{entry.source === "bundled" ? "built in" : entry.source}</Badge>
          </div>
        </div>
        <CardDescription className="text-xs leading-5">{template.summary}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-2 pb-3">
        <div className="flex flex-wrap gap-1">
          {template.events.map((event) => (
            <span key={event} className="font-mono text-[11px] text-muted-foreground">
              {shortEvent(event)}
            </span>
          ))}
        </div>
        {template.tags && template.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {template.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        ) : null}
        {open ? (
          <div className="space-y-2 pt-1 text-xs text-muted-foreground">
            {template.description ? <p className="leading-5">{template.description}</p> : null}
            {template.notes ? <p className="leading-5">Note: {template.notes}</p> : null}
            <WhatItRuns entry={entry} />
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="flex items-center justify-between gap-2 pt-0">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((value) => !value)}>
          {open ? "Less" : "Details"}
        </Button>
        <div className="flex items-center gap-2">
          {installed ? <span className="text-xs text-muted-foreground">Installed</span> : null}
          <Button type="button" size="sm" onClick={onInstall}>
            <Icon name="Plus" className="size-4" />
            {installed ? "Add again" : "Install"}
          </Button>
        </div>
      </CardFooter>
    </Card>
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
    <div className="space-y-1">
      <span className="font-medium text-foreground">What it runs{entry.source === "bundled" ? "" : " (from a catalog: review before installing)"}</span>
      <Code>{lines.join("\n")}</Code>
    </div>
  );
}

function InstallDialog({ entry, onClose, onInstalled }: { entry: TemplateEntry; onClose: () => void; onInstalled: () => void }) {
  const { rpc, data, refetch } = useOverview();
  const { template } = entry;
  const observeEvents = useMemo(() => (data?.events ?? []).filter((info) => info.kind === "observe"), [data]);
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
      // RPC inputs must be plain JSON: only include optional fields that are set.
      const input: Parameters<typeof rpc.call<"template_use">>[1] = { ref: entry.ref, params: cleanParams, trusted };
      if (template.kind !== "gate") input.events = events as typeof template.events;
      if (hookId.trim() !== "" && hookId.trim() !== template.id) input.id = hookId.trim();
      if (Object.keys(match).length > 0) input.match = match;
      const result = await rpc.call("template_use", input);
      toast.success(`Installed ${result.hooks.length === 1 ? `"${result.hooks[0]?.id}"` : `${result.hooks.length} hooks`}${result.secrets.length > 0 ? " and stored its secret" : ""}`);
      refetch();
      onInstalled();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Install {template.name}</DialogTitle>
            <DialogDescription>{template.summary}</DialogDescription>
          </DialogHeader>

          {template.params.length > 0 ? (
            <div className="space-y-3">
              {template.params.map((param) => (
                <Field key={param.key} label={`${param.label}${param.required ? "" : " (optional)"}`} hint={[param.description, param.secret ? "Stored encrypted; never written into the hook." : null].filter(Boolean).join(" ")}>
                  <Input
                    type={param.secret ? "password" : param.type === "integer" ? "number" : "text"}
                    value={params[param.key] ?? ""}
                    onChange={(event) => setParams((prev) => ({ ...prev, [param.key]: event.target.value }))}
                    placeholder={param.default ?? ""}
                    autoComplete="off"
                  />
                </Field>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">This hook has no settings.</p>
          )}

          {template.kind === "observe" ? (
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-foreground">Run when</span>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {observeEvents.map((info) => {
                  const checked = events.includes(info.event);
                  return (
                    <label key={info.event} className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-state-hover" title={info.summary}>
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => setEvents((prev) => (value === true ? [...prev, info.event] : prev.filter((event) => event !== info.event)))}
                        className="mt-0.5"
                      />
                      <span className="font-mono">{shortEvent(info.event)}</span>
                    </label>
                  );
                })}
              </div>
              {events.length === 0 ? <p className="text-xs text-destructive">Pick at least one event.</p> : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Gate hook: runs on every message before it reaches the agent, within 8 seconds.</p>
          )}

          <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setAdvanced((value) => !value)}>
            {advanced ? "Hide" : "Show"} filters and id
          </button>
          {advanced ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Hook id" hint="Several events get -event suffixes.">
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

          <WhatItRuns entry={entry} />
          {entry.source !== "bundled" ? (
            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
              <Checkbox checked={trusted} onCheckedChange={(value) => setTrusted(value === true)} className="mt-0.5" />
              <span>
                This hook comes from the <strong>{entry.source}</strong> catalog and will run on the machine hosting BB. I have read what it runs and trust it.
              </span>
            </label>
          ) : null}
          {template.notes ? <p className="text-xs text-muted-foreground">Note: {template.notes}</p> : null}
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || missing.length > 0 || !trusted || (template.kind === "observe" && events.length === 0)}>
              {pending ? "Installing…" : missing.length > 0 ? `Fill in ${missing.join(", ")}` : "Install"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
