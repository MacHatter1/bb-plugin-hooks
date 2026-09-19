// The Installed tab: every hook with enable, test and remove, plus recent runs.
import { useCallback, useEffect, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Badge, Code, EmptyState, SectionTitle, compact, errorMessage, formatWhen, shortEvent, targetOf, useOverview, type HookRow, type RunRecordRow, type TestResultRow } from "./shared";

export function InstalledTab({ onBrowse }: { onBrowse: () => void }) {
  const { data, rpc, refetch } = useOverview();
  const [testing, setTesting] = useState<{ hook: HookRow; result: TestResultRow } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (hook: HookRow) => {
    setBusy(hook.id);
    try {
      const result = await rpc.call("hook_test", { id: hook.id });
      setTesting({ hook, result });
      refetch();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (hook: HookRow, enabled: boolean) => {
    try {
      await rpc.call("hook_set_enabled", { id: hook.id, enabled });
      refetch();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };
  const remove = async (hook: HookRow) => {
    try {
      const result = await rpc.call("hook_remove", { id: hook.id });
      toast.success(`Removed "${hook.id}"${result.secretsRemoved.length > 0 ? ` and its secret${result.secretsRemoved.length === 1 ? "" : "s"}` : ""}`);
      refetch();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  if (data === null) return <EmptyState>Loading…</EmptyState>;
  return (
    <div className="space-y-6">
      {!data.enabled ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">Hooks are switched off in the plugin settings (Run hooks). Nothing will fire until it is on.</p>
      ) : null}
      {data.hooksError !== null ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">The hooks setting is invalid and no hooks are active: {data.hooksError}</p>
      ) : null}
      <section className="space-y-2">
        <SectionTitle>Installed hooks</SectionTitle>
        {data.hooks.length === 0 ? (
          <EmptyState>
            No hooks yet.{" "}
            <button type="button" className="text-foreground underline underline-offset-4" onClick={onBrowse}>
              Browse the marketplace
            </button>{" "}
            or run <code>bb hooks add</code>.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {data.hooks.map((hook) => (
              <HookItem key={hook.id} hook={hook} busy={busy === hook.id} onToggle={(enabled) => void toggle(hook, enabled)} onTest={() => void run(hook)} onRemove={() => void remove(hook)} />
            ))}
          </ul>
        )}
      </section>
      <RecentRuns />
      {testing === null ? null : <TestDialog hook={testing.hook} result={testing.result} onClose={() => setTesting(null)} />}
    </div>
  );
}

function HookItem({ hook, busy, onToggle, onTest, onRemove }: { hook: HookRow; busy: boolean; onToggle: (enabled: boolean) => void; onTest: () => void; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState(false);
  const match = hook.match ? Object.entries(hook.match).map(([key, value]) => `${key}=${value}`).join("  ") : "";
  return (
    <li className="space-y-1.5 px-4 py-3 text-sm">
      <div className="flex items-center gap-3">
        <Checkbox checked={hook.enabled} onCheckedChange={(value) => onToggle(value === true)} aria-label={`${hook.enabled ? "Disable" : "Enable"} ${hook.id}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-sm text-foreground">{hook.id}</span>
            <Badge tone={hook.event === "message.dispatch" ? "warn" : "neutral"}>{shortEvent(hook.event)}</Badge>
            {hook.template ? <Badge tone="accent">{hook.template.source && hook.template.source !== "bundled" ? `${hook.template.source}/` : ""}{hook.template.id}</Badge> : null}
            {!hook.enabled ? <Badge>disabled</Badge> : null}
          </div>
          <button type="button" className="mt-0.5 block max-w-full truncate text-left font-mono text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen((value) => !value)} title="Show the full command">
            {compact(targetOf(hook))}
          </button>
          {match !== "" ? <div className="font-mono text-[11px] text-muted-foreground">{match}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="sm" variant="outline" onClick={onTest} disabled={busy}>
            <Icon name="Play" className="size-3.5" />
            {busy ? "Running…" : "Test"}
          </Button>
          {confirm ? (
            <>
              <Button type="button" size="sm" variant="destructive" onClick={onRemove}>
                Confirm
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" aria-label={`Remove ${hook.id}`} onClick={() => setConfirm(true)}>
              <Icon name="Trash2" className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {open ? (
        <Code>
          {targetOf(hook)}
          {hook.body ? `\nbody: ${hook.body}` : ""}
          {hook.headers ? `\nheaders: ${JSON.stringify(hook.headers)}` : ""}
        </Code>
      ) : null}
    </li>
  );
}

function RecentRuns() {
  const { rpc } = useOverview();
  const [runs, setRuns] = useState<RunRecordRow[] | null>(null);
  const load = useCallback(() => {
    rpc.call("history_list", { limit: 25 }).then(setRuns, (cause) => toast.error(errorMessage(cause)));
  }, [rpc]);
  useEffect(() => {
    load();
  }, [load]);
  // Every hook run records a row and the server announces it; keep the log live.
  useRealtime("hooks-changed", load);
  return (
    <section className="space-y-2">
      <SectionTitle
        actions={
          <Button type="button" size="sm" variant="ghost" onClick={load}>
            <Icon name="RotateCcw" className="size-3.5" />
            Refresh
          </Button>
        }
      >
        Recent runs
      </SectionTitle>
      {runs === null ? (
        <EmptyState>Loading…</EmptyState>
      ) : runs.length === 0 ? (
        <EmptyState>No runs yet. Runs appear here as events fire or when you press Test.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 font-medium">When</th>
                <th className="px-3 py-1.5 font-medium">Hook</th>
                <th className="px-3 py-1.5 font-medium">Event</th>
                <th className="px-3 py-1.5 font-medium">Status</th>
                <th className="px-3 py-1.5 font-medium">Decision</th>
                <th className="px-3 py-1.5 font-medium">Output</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((run) => (
                <tr key={run.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{formatWhen(run.startedAt)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono">{run.hookId}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted-foreground">{shortEvent(run.event)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <Badge tone={run.status === "ok" ? "ok" : "warn"}>
                      {run.status}
                      {run.exitCode !== null ? ` ${run.exitCode}` : run.httpStatus !== null ? ` ${run.httpStatus}` : ""}
                    </Badge>{" "}
                    <span className="text-muted-foreground">{run.durationMs} ms</span>
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">{run.decision ?? ""}</td>
                  <td className="max-w-[16rem] truncate px-3 py-1.5 font-mono text-muted-foreground" title={run.error ?? run.output}>
                    {compact(run.error ?? run.output, 80)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TestDialog({ hook, result, onClose }: { hook: HookRow; result: TestResultRow; onClose: () => void }) {
  const { outcome, decision } = result;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Test run: {hook.id}</DialogTitle>
          <DialogDescription>
            {outcome.status === "ok" ? "Ran" : outcome.status === "timeout" ? "Timed out" : "Failed"}
            {outcome.exitCode !== null ? ` with exit ${outcome.exitCode}` : ""}
            {outcome.httpStatus !== null ? ` with HTTP ${outcome.httpStatus}` : ""} in {outcome.durationMs} ms, using a sample payload.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {outcome.error ? <p className="text-destructive">{outcome.error}</p> : null}
          {decision ? (
            <p>
              Decision: <strong>{decision.action}</strong>
              {decision.action === "reject" ? ` — ${decision.message}` : decision.action === "wait" ? ` — ${decision.reason}` : ""}
            </p>
          ) : null}
          {outcome.stdout.trim() !== "" ? (
            <div className="space-y-1">
              <span className="text-xs font-medium">stdout</span>
              <Code>{outcome.stdout.trimEnd()}</Code>
            </div>
          ) : null}
          {outcome.stderr.trim() !== "" ? (
            <div className="space-y-1">
              <span className="text-xs font-medium">stderr</span>
              <Code>{outcome.stderr.trimEnd()}</Code>
            </div>
          ) : null}
          <div className="space-y-1">
            <span className="text-xs font-medium">Payload the hook received</span>
            <Code>{JSON.stringify(result.payload, null, 2)}</Code>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
