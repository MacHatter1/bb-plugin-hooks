// Create or edit a hook by hand: command or webhook, event, filters, timing.
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { HookInput } from "../definitions";
import { EventPill, Field, IconBox, KindBadge, SourceBadge, errorMessage, iconForTemplate, useOverview, type HookRow, type TemplateEntry } from "./shared";
import { Icon } from "@/components/ui/icon";

function headersToText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function textToHeaders(text: string): { headers: Record<string, string> } | { error: string } {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const index = line.indexOf(":");
    if (index <= 0) return { error: `Header line "${line}" needs the form name: value` };
    headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return { headers };
}

/** Edit or create a hook. A hook installed from a template gets its settings as fields first. */
export function HookEditor({ hook, onClose, onSaved }: { hook: HookRow | null; onClose: () => void; onSaved: () => void }) {
  const { data } = useOverview();
  const [raw, setRaw] = useState(false);
  const entry = useMemo(() => {
    if (!hook?.template) return null;
    const source = hook.template.source ?? "bundled";
    return (data?.templates ?? []).find((candidate) => candidate.source === source && candidate.template.id === hook.template?.id) ?? null;
  }, [hook, data]);
  if (hook && entry && !raw) return <TemplateHookEditor hook={hook} entry={entry} onClose={onClose} onSaved={onSaved} onRaw={() => setRaw(true)} />;
  return <RawHookEditor hook={hook} onClose={onClose} onSaved={onSaved} detached={hook?.template !== undefined && entry !== null} />;
}

function TemplateHookEditor({ hook, entry, onClose, onSaved, onRaw }: { hook: HookRow; entry: TemplateEntry; onClose: () => void; onSaved: () => void; onRaw: () => void }) {
  const { rpc, refetch } = useOverview();
  const { template } = entry;
  const gate = template.kind === "gate";
  const stored = hook.template?.params ?? {};
  const secretNames = hook.template?.secrets ?? {};
  const [params, setParams] = useState<Record<string, string>>(() => Object.fromEntries(template.params.map((param) => [param.key, param.secret ? "" : (stored[param.key] ?? param.default ?? "")])));
  const [description, setDescription] = useState(hook.description ?? "");
  const [title, setTitle] = useState(hook.match?.title ?? "");
  const [projectId, setProjectId] = useState(hook.match?.projectId ?? "");
  const [providerId, setProviderId] = useState(hook.match?.providerId ?? "");
  const [text, setText] = useState(hook.match?.text ?? "");
  const [enabled, setEnabled] = useState(hook.enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = template.params.filter((param) => param.required && !param.secret && (params[param.key] ?? "").trim() === "").map((param) => param.label);

  const submit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const next: Record<string, string> = {};
      for (const param of template.params) {
        const value = params[param.key] ?? "";
        if (param.secret) {
          if (value !== "") next[param.key] = value;
          else if (secretNames[param.key]) next[param.key] = `secret:${secretNames[param.key]}`;
        } else if (value !== "") {
          next[param.key] = value;
        }
      }
      const match: NonNullable<HookInput["match"]> = {};
      if (title.trim() !== "") match.title = title.trim();
      if (projectId.trim() !== "") match.projectId = projectId.trim();
      if (providerId.trim() !== "") match.providerId = providerId.trim();
      if (text.trim() !== "") match.text = text.trim();
      const input: Parameters<typeof rpc.call<"template_use">>[1] = { ref: entry.ref, params: next, id: hook.id, enabled, trusted: true };
      if (!gate) input.events = [hook.event];
      if (Object.keys(match).length > 0) input.match = match;
      await rpc.call("template_use", input);
      if (description.trim() !== "" && description.trim() !== (hook.description ?? "")) {
        const saved = await rpc.call("overview");
        const fresh = saved.hooks.find((candidate) => candidate.id === hook.id);
        if (fresh) await rpc.call("hook_save", { ...fresh, description: description.trim() });
      }
      toast.success(`Saved "${hook.id}"`);
      refetch();
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(value) => (value ? undefined : onClose())}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border px-6 pb-4 pt-6 text-left">
          <div className="flex items-start gap-3">
            <IconBox name={iconForTemplate(template)} tone={gate ? "gate" : "accent"} className="size-11" />
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
                <span className="font-mono">{hook.id}</span>
                <KindBadge kind={template.kind} />
                <SourceBadge source={entry.source} />
              </DialogTitle>
              <DialogDescription className="mt-1">
                {template.name} · runs on <EventPill event={hook.event} />
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <form id="template-hook-editor" onSubmit={submit} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          {template.params.length > 0 ? (
            <div className="space-y-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Settings</span>
              <div className="grid gap-3 sm:grid-cols-2">
                {template.params.map((param) => (
                  <Field
                    key={param.key}
                    className={!param.secret && (stored[param.key] ?? param.default ?? "").length > 40 ? "sm:col-span-2" : undefined}
                    label={`${param.label}${param.required ? "" : " (optional)"}`}
                    hint={[param.description, param.secret ? (secretNames[param.key] ? "Stored encrypted. Leave blank to keep the current value." : "Stored encrypted.") : null].filter(Boolean).join(" ")}
                  >
                    <Input
                      type={param.secret ? "password" : param.type === "integer" ? "number" : "text"}
                      value={params[param.key] ?? ""}
                      onChange={(formEvent) => setParams((prev) => ({ ...prev, [param.key]: formEvent.target.value }))}
                      placeholder={param.secret && secretNames[param.key] ? "••••••  (unchanged)" : (param.default ?? "")}
                      autoComplete="off"
                    />
                  </Field>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">This template has no settings of its own.</p>
          )}
          <div className="space-y-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">When it runs</span>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Only threads whose title matches" hint="Regular expression">
                <Input value={title} onChange={(formEvent) => setTitle(formEvent.target.value)} placeholder="^feat" />
              </Field>
              <Field label="Only when the text matches" hint="Regular expression on the message or reply">
                <Input value={text} onChange={(formEvent) => setText(formEvent.target.value)} placeholder="#overnight" />
              </Field>
              <Field label="Only in project" hint="A proj_… id">
                <Input value={projectId} onChange={(formEvent) => setProjectId(formEvent.target.value)} placeholder="proj_…" />
              </Field>
              <Field label="Only on provider">
                <Input value={providerId} onChange={(formEvent) => setProviderId(formEvent.target.value)} placeholder="claude-code" />
              </Field>
              <Field label="Description (optional)" className="sm:col-span-2">
                <Input value={description} onChange={(formEvent) => setDescription(formEvent.target.value)} placeholder={template.summary} />
              </Field>
            </div>
          </div>
          <label className="flex items-center gap-3 text-sm">
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
            <span>{enabled ? "Enabled" : "Disabled"}</span>
          </label>
          <button type="button" onClick={onRaw} className="flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:underline">
            <Icon name="Terminal" className="size-3.5" />
            Edit the generated {hook.url !== undefined ? "webhook" : "command"} instead
          </button>
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter className="border-t border-border px-6 py-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="template-hook-editor" disabled={pending || missing.length > 0}>
            {pending ? "Saving…" : missing.length > 0 ? `Fill in ${missing.join(", ")}` : "Save settings"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RawHookEditor({ hook, onClose, onSaved, detached }: { hook: HookRow | null; onClose: () => void; onSaved: () => void; detached: boolean }) {
  const { rpc, data, refetch } = useOverview();
  const events = data?.events ?? [];
  const [id, setId] = useState(hook?.id ?? "");
  const [event, setEvent] = useState<string>(hook?.event ?? "thread.idle");
  const [target, setTarget] = useState<"command" | "url">(hook?.url !== undefined ? "url" : "command");
  const [command, setCommand] = useState(hook?.command ?? "");
  const [cwd, setCwd] = useState(hook?.cwd ?? "");
  const [url, setUrl] = useState(hook?.url ?? "");
  const [body, setBody] = useState(hook?.body ?? "");
  const [headers, setHeaders] = useState(headersToText(hook?.headers));
  const [description, setDescription] = useState(hook?.description ?? "");
  const [title, setTitle] = useState(hook?.match?.title ?? "");
  const [projectId, setProjectId] = useState(hook?.match?.projectId ?? "");
  const [providerId, setProviderId] = useState(hook?.match?.providerId ?? "");
  const [text, setText] = useState(hook?.match?.text ?? "");
  const [timeout, setTimeout_] = useState(hook?.timeoutMs !== undefined ? String(hook.timeoutMs) : "");
  const [onError, setOnError] = useState<string>(hook?.onError ?? "proceed");
  const [enabled, setEnabled] = useState(hook?.enabled ?? true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = event === "message.dispatch";
  const info = useMemo(() => events.find((candidate) => candidate.event === event), [events, event]);

  const submit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (pending) return;
    setError(null);
    const next: HookInput = { id: id.trim(), event: event as HookInput["event"], enabled };
    if (target === "command") {
      next.command = command;
      if (cwd.trim() !== "") next.cwd = cwd.trim();
    } else {
      next.url = url.trim();
      if (body.trim() !== "") next.body = body;
      const parsed = textToHeaders(headers);
      if ("error" in parsed) {
        setError(parsed.error);
        return;
      }
      if (Object.keys(parsed.headers).length > 0) next.headers = parsed.headers;
    }
    if (description.trim() !== "") next.description = description.trim();
    const match: NonNullable<HookInput["match"]> = {};
    if (title.trim() !== "") match.title = title.trim();
    if (projectId.trim() !== "") match.projectId = projectId.trim();
    if (providerId.trim() !== "") match.providerId = providerId.trim();
    if (text.trim() !== "") match.text = text.trim();
    if (Object.keys(match).length > 0) next.match = match;
    if (timeout.trim() !== "") next.timeoutMs = Number(timeout);
    if (gate && onError !== "proceed") next.onError = onError as HookInput["onError"];
    if (hook?.template) next.template = hook.template;
    setPending(true);
    try {
      await rpc.call("hook_save", next);
      toast.success(`${hook ? "Saved" : "Created"} hook "${next.id}"`);
      refetch();
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause).replace(/^rpc handler failed: /, ""));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(value) => (value ? undefined : onClose())}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-6 pb-4 pt-6 text-left">
          <DialogTitle>{hook ? `Edit ${hook.id}` : "New hook"}</DialogTitle>
          <DialogDescription>
            {hook ? "Changes apply to the next event." : "Bind an event to a shell command or a webhook. Commands run on the machine that hosts BB."}
            {detached ? " This hook came from a template; editing the generated text here means the template's settings no longer describe it." : ""}
          </DialogDescription>
        </DialogHeader>
        <form id="hook-editor" onSubmit={submit} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Id" hint="Lowercase letters, digits and dashes.">
              <Input value={id} onChange={(formEvent) => setId(formEvent.target.value)} placeholder="notify-me" disabled={hook !== null} autoComplete="off" />
            </Field>
            <Field label="Event" hint={info?.summary}>
              <Select value={event} onValueChange={setEvent}>
                <SelectTrigger aria-label="Event">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {events.map((candidate) => (
                    <SelectItem key={candidate.event} value={candidate.event}>
                      <span className="flex items-center gap-2">
                        <EventPill event={candidate.event} />
                        <span className="text-xs text-muted-foreground">{candidate.kind === "gate" ? "gate" : "reacts"}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="space-y-3">
            <Tabs value={target} onValueChange={(value) => setTarget(value as typeof target)}>
              <TabsList className="w-fit">
                <TabsTrigger value="command">Shell command</TabsTrigger>
                <TabsTrigger value="url">Webhook</TabsTrigger>
              </TabsList>
            </Tabs>
            {target === "command" ? (
              <>
                <Field label="Command" hint={gate ? "Exit 0 proceeds, 2 rejects (stderr is the reason), 3 waits; or print a JSON decision. Must answer within 8 seconds." : "Runs with /bin/sh. The event JSON is on stdin; BB_THREAD_TITLE, BB_THREAD_ID and friends are in the environment. Use {{secret:name}} for credentials."}>
                  <Textarea value={command} onChange={(formEvent) => setCommand(formEvent.target.value)} rows={5} className="font-mono text-xs" placeholder={gate ? 'echo "Not allowed" >&2; exit 2' : 'echo "$BB_THREAD_TITLE finished" >> "$HOME/hooks.log"'} />
                </Field>
                <Field label="Working directory (optional)" hint="A path on the BB server.">
                  <Input value={cwd} onChange={(formEvent) => setCwd(formEvent.target.value)} placeholder="/path/on/the/server" />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL" hint="https, or {{secret:name}} for a secret webhook URL.">
                  <Input value={url} onChange={(formEvent) => setUrl(formEvent.target.value)} placeholder="https://hooks.example.com/…" />
                </Field>
                <Field label="Body template (optional)" hint="JSON with {{thread.title}}, {{lastAssistantText|500}}, {{secret:name}} … Empty sends the whole event.">
                  <Textarea value={body} onChange={(formEvent) => setBody(formEvent.target.value)} rows={4} className="font-mono text-xs" placeholder={'{"text":"BB {{event}} — {{thread.title}}"}'} />
                </Field>
                <Field label="Headers (optional)" hint="One per line, name: value.">
                  <Textarea value={headers} onChange={(formEvent) => setHeaders(formEvent.target.value)} rows={2} className="font-mono text-xs" placeholder="authorization: Bearer {{secret:api/token}}" />
                </Field>
              </>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Description (optional)" className="sm:col-span-2">
              <Input value={description} onChange={(formEvent) => setDescription(formEvent.target.value)} placeholder="What this hook is for" />
            </Field>
            <Field label="Only threads whose title matches" hint="Regular expression">
              <Input value={title} onChange={(formEvent) => setTitle(formEvent.target.value)} placeholder="^feat" />
            </Field>
            <Field label="Only when the text matches" hint="Regular expression on the message or reply">
              <Input value={text} onChange={(formEvent) => setText(formEvent.target.value)} placeholder="#overnight" />
            </Field>
            <Field label="Only in project" hint="A proj_… id">
              <Input value={projectId} onChange={(formEvent) => setProjectId(formEvent.target.value)} placeholder="proj_…" />
            </Field>
            <Field label="Only on provider">
              <Input value={providerId} onChange={(formEvent) => setProviderId(formEvent.target.value)} placeholder="claude-code" />
            </Field>
            <Field label="Timeout (ms)" hint={gate ? "Capped at 8000 for gates." : "Default 30000."}>
              <Input type="number" value={timeout} onChange={(formEvent) => setTimeout_(formEvent.target.value)} placeholder={gate ? "8000" : "30000"} />
            </Field>
            {gate ? (
              <Field label="On error or timeout" hint="What the gate answers when the command fails.">
                <Select value={onError} onValueChange={setOnError}>
                  <SelectTrigger aria-label="On error">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="proceed">Let the message through</SelectItem>
                    <SelectItem value="reject">Reject the message</SelectItem>
                    <SelectItem value="wait">Queue the message</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
          </div>

          <label className="flex items-center gap-3 text-sm">
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
            <span>{enabled ? "Enabled" : "Disabled until you switch it on"}</span>
          </label>
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter className="border-t border-border px-6 py-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="hook-editor" disabled={pending || id.trim() === "" || (target === "command" ? command.trim() === "" : url.trim() === "")}>
            {pending ? "Saving…" : hook ? "Save changes" : "Create hook"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
