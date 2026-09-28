// The Installed tab: hooks with switches, last-run status, details, editing,
// and the run log with filters.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { HookEditor } from "./hook-editor";
import {
  Chip,
  Code,
  EmptyState,
  EventPill,
  IconBox,
  SectionTitle,
  SourceBadge,
  StatusDot,
  compact,
  errorMessage,
  formatDuration,
  formatWhen,
  iconForHook,
  lastRunByHook,
  matchText,
  targetOf,
  useHistory,
  useOverview,
  type HookRow,
  type RunRecordRow,
  type TestResultRow,
} from "./shared";

export function InstalledTab({ onBrowse, onNewHook }: { onBrowse: () => void; onNewHook: () => void }) {
  const { data, rpc, refetch } = useOverview();
  const { runs, reload } = useHistory();
  const lastRuns = useMemo(() => lastRunByHook(runs), [runs]);
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<"all" | "gate" | "observe" | "disabled">("all");
  const [editing, setEditing] = useState<HookRow | null | "new">(null);
  const [testing, setTesting] = useState<{ hook: HookRow; result: TestResultRow } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const hooks = data?.hooks ?? [];
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return hooks.filter((hook) => {
      if (only === "gate" && hook.event !== "message.dispatch") return false;
      if (only === "observe" && hook.event === "message.dispatch") return false;
      if (only === "disabled" && hook.enabled) return false;
      if (needle === "") return true;
      return [hook.id, hook.event, hook.description ?? "", hook.command ?? "", hook.url ?? "", hook.template?.id ?? ""].join("\n").toLowerCase().includes(needle);
    });
  }, [hooks, query, only]);
  const gates = visible.filter((hook) => hook.event === "message.dispatch");
  const reacts = visible.filter((hook) => hook.event !== "message.dispatch");

  const run = async (hook: HookRow) => {
    setBusy(hook.id);
    try {
      const result = await rpc.call("hook_test", { id: hook.id });
      setTesting({ hook, result });
      reload();
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
  const closeEditor = () => setEditing(null);

  if (data === null) return <EmptyState icon="Loading" title="Loading…" />;
  return (
    <div className="space-y-6">
      {data.hooksError !== null ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" />
          The hooks setting is invalid and no hooks are active: {data.hooksError}
        </p>
      ) : null}

      <section className="space-y-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter installed hooks" aria-label="Filter hooks" className="pl-8" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={only === "all"} onClick={() => setOnly("all")} count={hooks.length}>
              All
            </Chip>
            <Chip active={only === "observe"} onClick={() => setOnly("observe")} icon="Zap" count={hooks.filter((hook) => hook.event !== "message.dispatch").length}>
              Reacts
            </Chip>
            <Chip active={only === "gate"} onClick={() => setOnly("gate")} icon="SecurityCheck" count={hooks.filter((hook) => hook.event === "message.dispatch").length}>
              Gates
            </Chip>
            <Chip active={only === "disabled"} onClick={() => setOnly("disabled")} icon="Pause" count={hooks.filter((hook) => !hook.enabled).length}>
              Off
            </Chip>
          </div>
          <div className="flex items-center gap-1">
            <Button type="button" onClick={onNewHook}>
              <Icon name="Plus" className="size-4" />
              New hook
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" size="icon" variant="outline" className="size-9" aria-label="Write a hook by hand" onClick={() => setEditing("new")}>
                  <Icon name="Terminal" className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Write a hook by hand instead</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {hooks.length === 0 ? (
          <EmptyState
            icon="Zap"
            title="No hooks yet"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button type="button" onClick={onNewHook}>
                  <Icon name="Plus" className="size-4" />
                  Describe a hook to an agent
                </Button>
                <Button type="button" variant="outline" onClick={onBrowse}>
                  <Icon name="Puzzle" className="size-4" />
                  Browse the marketplace
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditing("new")}>
                  <Icon name="Terminal" className="size-4" />
                  Write by hand
                </Button>
              </div>
            }
          >
            Tell an agent what should happen and when, install a ready-made hook, or bind any event to your own command or webhook.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState icon="Search" title="No hooks match" />
        ) : (
          <div className="space-y-4">
            {gates.length > 0 ? <HookGroup title="Gates" hint="Run before every message reaches an agent" hooks={gates} lastRuns={lastRuns} busy={busy} onToggle={toggle} onTest={run} onEdit={setEditing} onRemove={remove} /> : null}
            {reacts.length > 0 ? <HookGroup title="Reacts to events" hint="Run after the fact; they never block a thread" hooks={reacts} lastRuns={lastRuns} busy={busy} onToggle={toggle} onTest={run} onEdit={setEditing} onRemove={remove} /> : null}
          </div>
        )}
      </section>

      <RunLog hooks={hooks} onReload={reload} />

      {editing === null ? null : <HookEditor hook={editing === "new" ? null : editing} onClose={closeEditor} onSaved={closeEditor} />}
      {testing === null ? null : <TestDialog hook={testing.hook} result={testing.result} onClose={() => setTesting(null)} />}
    </div>
  );
}

function HookGroup({ title, hint, hooks, lastRuns, busy, onToggle, onTest, onEdit, onRemove }: { title: string; hint: string; hooks: HookRow[]; lastRuns: Map<string, RunRecordRow>; busy: string | null; onToggle: (hook: HookRow, enabled: boolean) => void; onTest: (hook: HookRow) => void; onEdit: (hook: HookRow) => void; onRemove: (hook: HookRow) => void }) {
  return (
    <section className="space-y-2">
      <SectionTitle hint={hint}>
        {title} <span className="font-normal text-muted-foreground">({hooks.length})</span>
      </SectionTitle>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {hooks.map((hook) => (
          <HookItem key={hook.id} hook={hook} lastRun={lastRuns.get(hook.id)} busy={busy === hook.id} onToggle={(enabled) => onToggle(hook, enabled)} onTest={() => onTest(hook)} onEdit={() => onEdit(hook)} onRemove={() => onRemove(hook)} />
        ))}
      </ul>
    </section>
  );
}

function HookItem({ hook, lastRun, busy, onToggle, onTest, onEdit, onRemove }: { hook: HookRow; lastRun: RunRecordRow | undefined; busy: boolean; onToggle: (enabled: boolean) => void; onTest: () => void; onEdit: () => void; onRemove: () => void }) {
  const { data } = useOverview();
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState(false);
  const gate = hook.event === "message.dispatch";
  const match = matchText(hook);
  return (
    <li className={cn("px-4 py-3 text-sm", !hook.enabled && "bg-muted/40")}>
      <div className="flex items-center gap-3">
        <Switch checked={hook.enabled} onCheckedChange={onToggle} aria-label={`${hook.enabled ? "Disable" : "Enable"} ${hook.id}`} />
        <IconBox name={iconForHook(hook, data?.templates ?? [])} tone={gate ? "gate" : "neutral"} className={cn("size-8", !hook.enabled && "opacity-50")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn("font-mono text-sm", hook.enabled ? "text-foreground" : "text-muted-foreground line-through")}>{hook.id}</span>
            <EventPill event={hook.event} className={gate ? "bg-destructive/10 text-destructive" : undefined} />
            {hook.template ? <SourceBadge source={hook.template.source ?? "bundled"} /> : null}
            {hook.template ? <span className="text-[11px] text-muted-foreground">from {hook.template.id}</span> : null}
          </div>
          <button type="button" className="mt-0.5 block max-w-full truncate text-left font-mono text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen((value) => !value)} title="Show details">
            {hook.description ? `${hook.description} · ` : ""}
            {compact(targetOf(hook), 100)}
          </button>
          {match !== "" ? <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{match}</div> : null}
        </div>
        <div className="hidden w-36 shrink-0 text-right text-xs text-muted-foreground lg:block">
          {lastRun ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot status={lastRun.status} />
                  {lastRun.status === "ok" ? "ok" : lastRun.status} · {formatWhen(lastRun.startedAt)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="left">
                {lastRun.event} in {formatDuration(lastRun.durationMs)}
                {lastRun.decision ? ` → ${lastRun.decision}` : ""}
                {lastRun.error ? ` (${lastRun.error})` : ""}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <StatusDot status="idle" />
              never ran
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Test ${hook.id}`} onClick={onTest} disabled={busy}>
                <Icon name={busy ? "Loading" : "Play"} className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run with a sample payload</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Edit ${hook.id}`} onClick={onEdit}>
                <Icon name="Edit" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{hook.template ? "Edit settings" : "Edit"}</TooltipContent>
          </Tooltip>
          {confirm ? (
            <>
              <Button type="button" size="sm" variant="destructive" onClick={onRemove}>
                Remove
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" aria-label={`Remove ${hook.id}`} onClick={() => setConfirm(true)}>
                  <Icon name="Trash2" className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Remove</TooltipContent>
            </Tooltip>
          )}
          <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={open ? "Hide details" : "Show details"} onClick={() => setOpen((value) => !value)}>
            <Icon name={open ? "ChevronUp" : "ChevronDown"} className="size-4" />
          </Button>
        </div>
      </div>
      {open ? (
        <div className="mt-3 grid gap-3 pl-[4.25rem] text-xs md:grid-cols-[1fr_14rem]">
          <Code>
            {targetOf(hook)}
            {hook.body ? `\nbody: ${hook.body}` : ""}
            {hook.headers ? `\nheaders: ${JSON.stringify(hook.headers)}` : ""}
            {hook.cwd ? `\ncwd: ${hook.cwd}` : ""}
          </Code>
          <dl className="space-y-1.5 text-muted-foreground">
            <div>
              <dt className="font-medium text-foreground">Timeout</dt>
              <dd>{hook.timeoutMs ?? (gate ? 8000 : 30000)} ms{gate ? ` · on error: ${hook.onError ?? "proceed"}` : ""}</dd>
            </div>
            {hook.template ? (
              <div>
                <dt className="font-medium text-foreground">Template settings</dt>
                <dd>
                  {Object.entries(hook.template.params).length === 0 && !hook.template.secrets ? "none" : null}
                  {Object.entries(hook.template.params).map(([key, value]) => (
                    <span key={key} className="block truncate font-mono">
                      {key} = {value}
                    </span>
                  ))}
                  {Object.entries(hook.template.secrets ?? {}).map(([key, name]) => (
                    <span key={key} className="block truncate font-mono">
                      {key} = 🔒 {name}
                    </span>
                  ))}
                </dd>
              </div>
            ) : null}
            {lastRun ? (
              <div>
                <dt className="font-medium text-foreground">Last run</dt>
                <dd>
                  {lastRun.status}
                  {lastRun.exitCode !== null ? ` (exit ${lastRun.exitCode})` : ""}
                  {lastRun.httpStatus !== null ? ` (HTTP ${lastRun.httpStatus})` : ""} · {formatDuration(lastRun.durationMs)} · {formatWhen(lastRun.startedAt)}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </li>
  );
}

const RUN_PAGE = 25;

function RunLog({ hooks, onReload }: { hooks: HookRow[]; onReload: () => void }) {
  const { rpc } = useOverview();
  const [hookFilter, setHookFilter] = useState("all");
  const [status, setStatus] = useState<"all" | "ok" | "failed">("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<RunRecordRow | null>(null);
  const [data, setData] = useState<{ runs: RunRecordRow[]; total: number } | null>(null);
  const hookIds = useMemo(() => [...new Set(hooks.map((hook) => hook.id))].sort(), [hooks]);
  const filtered = hookFilter !== "all" || status !== "all";
  const load = useCallback(() => {
    rpc
      .call("history_list", {
        limit: RUN_PAGE,
        offset: page * RUN_PAGE,
        ...(hookFilter === "all" ? {} : { hookId: hookFilter }),
        ...(status === "all" ? {} : { status }),
      })
      .then((next) => {
        const pages = Math.max(1, Math.ceil(next.total / RUN_PAGE));
        if (page > pages - 1) setPage(pages - 1);
        else setData(next);
      }, () => setData((prev) => prev ?? { runs: [], total: 0 }));
  }, [rpc, page, hookFilter, status]);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime("hooks-changed", load);
  const runs = data?.runs ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / RUN_PAGE));
  const clear = async () => {
    try {
      const result = await rpc.call("history_clear");
      toast.success(`Cleared ${result.removed} run${result.removed === 1 ? "" : "s"}`);
      setPage(0);
      onReload();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };
  return (
    <section className="space-y-2">
      <SectionTitle
        hint="Every hook run, newest first. Click a row for the full output."
        actions={
          <div className="flex items-center gap-1.5">
            <Select
              value={hookFilter}
              onValueChange={(value) => {
                setHookFilter(value);
                setPage(0);
              }}
            >
              <SelectTrigger className="h-8 w-40" aria-label="Filter by hook">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All hooks</SelectItem>
                {hookIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Chip
              active={status === "failed"}
              onClick={() => {
                setStatus(status === "failed" ? "all" : "failed");
                setPage(0);
              }}
              icon="AlertTriangle"
            >
              Failures
            </Chip>
            <Button type="button" size="sm" variant="ghost" onClick={clear} disabled={data !== null && !filtered && total === 0}>
              Clear
            </Button>
          </div>
        }
      >
        Run log
      </SectionTitle>
      {data === null ? (
        <EmptyState icon="Loading" title="Loading…" />
      ) : runs.length === 0 ? (
        <EmptyState icon="Clock" title={filtered ? "No runs match" : "No runs yet"}>
          {filtered ? undefined : "Runs appear here as events fire, or when you press Test on a hook."}
        </EmptyState>
      ) : (
        <div className="space-y-2">
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">When</TableHead>
                <TableHead>Hook</TableHead>
                <TableHead>Event</TableHead>
                <TableHead className="w-32">Result</TableHead>
                <TableHead>Output</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id} className="cursor-pointer" onClick={() => setSelected(run)}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatWhen(run.startedAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{run.hookId}</TableCell>
                  <TableCell className="text-xs">
                    <EventPill event={run.event} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot status={run.status} />
                      {run.status}
                      {run.exitCode !== null ? ` ${run.exitCode}` : run.httpStatus !== null ? ` ${run.httpStatus}` : ""}
                      <span className="text-muted-foreground">· {formatDuration(run.durationMs)}</span>
                    </span>
                  </TableCell>
                  <TableCell className="max-w-[18rem] truncate font-mono text-xs text-muted-foreground">{run.decision ? `${run.decision} · ` : ""}{compact(run.error ?? run.output, 90)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {page * RUN_PAGE + 1}–{Math.min(total, (page + 1) * RUN_PAGE)} of {total}
          </span>
          <span className="flex items-center gap-1">
            <Button type="button" size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((current) => current - 1)}>
              Previous
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage((current) => current + 1)}>
              Next
            </Button>
          </span>
        </div>
        </div>
      )}
      {selected === null ? null : (
        <Dialog open onOpenChange={(value) => (value ? undefined : setSelected(null))}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {selected.hookId} · {selected.event}
              </DialogTitle>
              <DialogDescription>
                {new Date(selected.startedAt).toLocaleString()} · {selected.status}
                {selected.exitCode !== null ? ` (exit ${selected.exitCode})` : ""}
                {selected.httpStatus !== null ? ` (HTTP ${selected.httpStatus})` : ""} · {formatDuration(selected.durationMs)}
                {selected.threadId ? ` · thread ${selected.threadId}` : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              {selected.error ? <p className="text-destructive">{selected.error}</p> : null}
              {selected.decision ? <p>Decision: {selected.decision}</p> : null}
              <Code>{selected.output.trim() === "" ? "(no output)" : selected.output}</Code>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function TestDialog({ hook, result, onClose }: { hook: HookRow; result: TestResultRow; onClose: () => void }) {
  const { outcome, decision } = result;
  return (
    <Dialog open onOpenChange={(value) => (value ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <StatusDot status={outcome.status} />
            Test run: {hook.id}
          </DialogTitle>
          <DialogDescription>
            {outcome.status === "ok" ? "Ran" : outcome.status === "timeout" ? "Timed out" : "Failed"}
            {outcome.exitCode !== null ? ` with exit ${outcome.exitCode}` : ""}
            {outcome.httpStatus !== null ? ` with HTTP ${outcome.httpStatus}` : ""} in {formatDuration(outcome.durationMs)}, using a sample payload.
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
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Payload the hook received</summary>
            <Code className="mt-1">{JSON.stringify(result.payload, null, 2)}</Code>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  );
}
