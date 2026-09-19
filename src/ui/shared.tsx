// Small presentational pieces and the data context shared by the tabs.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../rpc";
import { cn } from "@/lib/utils";

/** Output type of a Standard Schema validator (what an RPC method returns). */
type Infer<S> = S extends { "~standard": { types?: { output: infer O } } } ? O : never;
export type Overview = Infer<(typeof rpcContract)["overview"]["output"]>;
export type HookRow = Overview["hooks"][number];
export type TemplateEntry = Overview["templates"][number];
export type CatalogRow = Overview["catalogs"][number];
export type SecretRow = Overview["secrets"][number];
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

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" | "ok"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4",
        tone === "neutral" && "border-border bg-muted text-muted-foreground",
        tone === "accent" && "border-primary/30 bg-primary/10 text-primary",
        tone === "warn" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "ok" && "border-border bg-secondary text-secondary-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-foreground">{children}</h2>
      {actions}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <pre className={cn("max-h-64 overflow-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs leading-5 text-foreground whitespace-pre-wrap break-words", className)}>{children}</pre>;
}

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

export function targetOf(hook: HookRow): string {
  return hook.command !== undefined ? `$ ${hook.command}` : `POST ${hook.url ?? ""}`;
}

export function compact(text: string, max = 90): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
