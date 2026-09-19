// Data context, shared types and the small presentational pieces every tab uses.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../rpc";
import { Badge as UiBadge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Output type of a Standard Schema validator (what an RPC method returns). */
type Infer<S> = S extends { "~standard": { types?: { output: infer O } } } ? O : never;
export type Overview = Infer<(typeof rpcContract)["overview"]["output"]>;
export type HookRow = Overview["hooks"][number];
export type TemplateEntry = Overview["templates"][number];
export type CatalogRow = Overview["catalogs"][number];
export type SecretRow = Overview["secrets"][number];
export type EventInfo = Overview["events"][number];
export type RunRecordRow = Infer<(typeof rpcContract)["history_list"]["output"]>[number];
export type TestResultRow = Infer<(typeof rpcContract)["hook_test"]["output"]>;
export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export interface OverviewState {
  rpc: Rpc;
  data: Overview | null;
  error: string | null;
  refetch: () => void;
}

const OverviewContext = createContext<OverviewState | null>(null);

/** A readable message, including validation issues the RPC boundary attaches. */
export function errorMessage(cause: unknown): string {
  const issues = (cause as { issues?: Array<{ message: string; path?: unknown[] }> } | null)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map((issue) => (issue.path && issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^rpc handler failed: /, "");
}

export function OverviewProvider({ children }: { children: ReactNode }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("overview").then(
      (next) => {
        setData(next);
        setError(null);
      },
      (cause) => setError(errorMessage(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("hooks-changed", refetch);
  return <OverviewContext.Provider value={{ rpc, data, error, refetch }}>{children}</OverviewContext.Provider>;
}

export function useOverview(): OverviewState {
  const state = useContext(OverviewContext);
  if (state === null) throw new Error("useOverview outside OverviewProvider");
  return state;
}

/** The recent run log, kept live by the server's realtime signal. */
export function useHistory(limit = 200): { runs: RunRecordRow[] | null; reload: () => void } {
  const { rpc } = useOverview();
  const [runs, setRuns] = useState<RunRecordRow[] | null>(null);
  const reload = useCallback(() => {
    rpc.call("history_list", { limit }).then(setRuns, () => setRuns((prev) => prev ?? []));
  }, [rpc, limit]);
  useEffect(() => {
    reload();
  }, [reload]);
  useRealtime("hooks-changed", reload);
  return { runs, reload };
}

export function lastRunByHook(runs: RunRecordRow[] | null): Map<string, RunRecordRow> {
  const map = new Map<string, RunRecordRow>();
  for (const run of runs ?? []) if (!map.has(run.hookId)) map.set(run.hookId, run);
  return map;
}

// ---------------------------------------------------------------- categories

export interface Category {
  id: string;
  label: string;
  icon: string;
  tags: readonly string[];
}

export const CATEGORIES: readonly Category[] = [
  { id: "notify", label: "Notify", icon: "BellDot", tags: ["notifications", "desktop", "phone", "push", "voice", "chat", "slack", "discord", "telegram", "teams", "mattermost", "email", "on-call", "pagerduty"] },
  { id: "integrate", label: "Integrate", icon: "Globe", tags: ["integration", "webhook", "github", "home-automation"] },
  { id: "automate", label: "Automate", icon: "Bot", tags: ["automation", "agents", "chaining", "code-review", "housekeeping", "resilience", "scheduling"] },
  { id: "guard", label: "Guard", icon: "SecurityCheck", tags: ["gate", "policy", "safety", "secrets", "process"] },
  { id: "observe", label: "Observe", icon: "FileText", tags: ["audit", "logging"] },
];

export function categoryOf(template: TemplateEntry["template"]): Category {
  if (template.kind === "gate") return CATEGORIES[3]!;
  const tags = template.tags ?? [];
  for (const category of CATEGORIES) if (tags.some((tag) => category.tags.includes(tag))) return category;
  return CATEGORIES[1]!;
}

const TAG_ICONS: Array<[string, string]> = [
  ["phone", "Smartphone"],
  ["push", "Smartphone"],
  ["email", "Mail"],
  ["voice", "Mic"],
  ["desktop", "Laptop"],
  ["github", "Github"],
  ["discord", "Discord"],
  ["chat", "MessageSquare"],
  ["on-call", "BellDot"],
  ["home-automation", "Plug02"],
  ["code-review", "GitPullRequest"],
  ["agents", "Bot"],
  ["chaining", "Workflow"],
  ["housekeeping", "Archive"],
  ["resilience", "Repeat"],
  ["scheduling", "Clock"],
  ["secrets", "Lock"],
  ["safety", "SecurityCheck"],
  ["policy", "SecurityCheck"],
  ["process", "CheckList"],
  ["audit", "FileText"],
  ["logging", "FileText"],
  ["webhook", "Globe"],
  ["integration", "Globe"],
  ["notifications", "BellDot"],
];

export function iconForTemplate(template: TemplateEntry["template"]): string {
  const tags = template.tags ?? [];
  for (const [tag, icon] of TAG_ICONS) if (tags.includes(tag)) return icon;
  return template.kind === "gate" ? "SecurityCheck" : "Zap";
}

export function iconForHook(hook: HookRow, templates: TemplateEntry[]): string {
  const entry = hook.template ? templates.find((candidate) => candidate.template.id === hook.template?.id) : undefined;
  if (entry) return iconForTemplate(entry.template);
  if (hook.event === "message.dispatch") return "SecurityCheck";
  return hook.url !== undefined ? "Globe" : "Terminal";
}

// ------------------------------------------------------------------ helpers

export function shortEvent(event: string): string {
  return event.replace(/^(thread|experimental_)\./, "");
}

export function formatWhen(ms: number | null): string {
  if (ms === null) return "never";
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function targetOf(hook: Pick<HookRow, "command" | "url">): string {
  return hook.command !== undefined ? `$ ${hook.command}` : `POST ${hook.url ?? ""}`;
}

export function compact(text: string, max = 90): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function matchText(hook: HookRow): string {
  if (hook.match === undefined) return "";
  return Object.entries(hook.match)
    .map(([key, value]) => `${key} ~ ${value}`)
    .join("   ");
}

// ------------------------------------------------------------- presentation

export function KindBadge({ kind }: { kind: "observe" | "gate" }) {
  return kind === "gate" ? (
    <UiBadge variant="destructive" className="gap-1 font-medium">
      <Icon name="SecurityCheck" className="size-3" />
      gate
    </UiBadge>
  ) : (
    <UiBadge variant="secondary" className="gap-1 font-medium">
      <Icon name="Zap" className="size-3" />
      reacts
    </UiBadge>
  );
}

export function SourceBadge({ source }: { source: string }) {
  return source === "bundled" ? (
    <UiBadge variant="outline" className="font-medium text-muted-foreground">
      built in
    </UiBadge>
  ) : (
    <UiBadge variant="outline" className="gap-1 font-medium">
      <Icon name="Puzzle" className="size-3" />
      {source}
    </UiBadge>
  );
}

export function EventPill({ event, className }: { event: string; className?: string }) {
  return <span className={cn("rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-4 text-muted-foreground", className)}>{shortEvent(event)}</span>;
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-border px-2 py-0.5 text-[11px] leading-4 text-muted-foreground">{children}</span>;
}

export function StatusDot({ status, className }: { status: "ok" | "error" | "timeout" | "idle"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 rounded-full",
        status === "ok" && "bg-primary",
        status === "error" && "bg-destructive",
        status === "timeout" && "bg-destructive/60",
        status === "idle" && "bg-muted-foreground/40",
        className,
      )}
    />
  );
}

export function Chip({ active, onClick, icon, children, count }: { active: boolean; onClick: () => void; icon?: string; children: ReactNode; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
        active ? "border-foreground bg-foreground text-background" : "border-border bg-transparent text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      {icon ? <Icon name={icon} className="size-3.5" /> : null}
      {children}
      {count !== undefined ? <span className={cn("rounded-full px-1 text-[10px]", active ? "bg-background/20" : "bg-muted")}>{count}</span> : null}
    </button>
  );
}

export function IconBox({ name, tone = "neutral", className }: { name: string; tone?: "neutral" | "gate" | "accent"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-lg border",
        tone === "neutral" && "border-border bg-muted text-foreground",
        tone === "gate" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "accent" && "border-primary/30 bg-primary/10 text-primary",
        className,
      )}
    >
      <Icon name={name} className="size-4.5" />
    </span>
  );
}

export function EmptyState({ icon = "Info", title, children, action }: { icon?: string; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <Icon name={icon} className="size-6 text-muted-foreground" />
      {title ? <p className="text-sm font-medium text-foreground">{title}</p> : null}
      {children ? <p className="max-w-md text-sm text-muted-foreground">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, actions, hint }: { children: ReactNode; actions?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{children}</h2>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {actions}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block space-y-1", className)}>
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <pre className={cn("max-h-72 overflow-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs leading-5 text-foreground whitespace-pre-wrap break-words", className)}>{children}</pre>;
}

export function Stat({ icon, label, value, hint, tone = "neutral", onClick }: { icon: string; label: string; value: ReactNode; hint?: ReactNode; tone?: "neutral" | "warn" | "ok"; onClick?: () => void }) {
  const body = (
    <>
      <span className={cn("flex size-8 items-center justify-center rounded-md", tone === "warn" ? "bg-destructive/10 text-destructive" : tone === "ok" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
        <Icon name={icon} className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-lg font-semibold leading-6 text-foreground">{value}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {label}
          {hint ? <span className="text-muted-foreground/70"> · {hint}</span> : null}
        </span>
      </span>
    </>
  );
  const className = "flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(className, "transition-colors hover:bg-state-hover")}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** Press `/` anywhere on the page to focus the search box. */
export function useSlashFocus(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ref]);
}

export function useInstalledCounts(): Map<string, number> {
  const { data } = useOverview();
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const hook of data?.hooks ?? []) {
      if (!hook.template) continue;
      const key = `${hook.template.source ?? "bundled"}/${hook.template.id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [data]);
}

export function templateKey(entry: TemplateEntry): string {
  return `${entry.source}/${entry.template.id}`;
}
