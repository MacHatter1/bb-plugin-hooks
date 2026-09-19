// The Secrets tab: encrypted values, where they are used, rotate and copy.
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, Field, SectionTitle, errorMessage, formatWhen, useOverview, type SecretRow } from "./shared";

export function SecretsTab() {
  const { data, rpc, refetch } = useOverview();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const usedBy = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const hook of data?.hooks ?? []) {
      for (const text of [hook.command, hook.url, hook.body, ...Object.values(hook.headers ?? {})]) {
        for (const match of (text ?? "").matchAll(/\{\{\s*secret:([^}\s]+)\s*\}\}/g)) {
          const list = map.get(match[1]!) ?? [];
          if (!list.includes(hook.id)) list.push(hook.id);
          map.set(match[1]!, list);
        }
      }
    }
    return map;
  }, [data]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || name.trim() === "" || value === "") return;
    setPending(true);
    try {
      await rpc.call("secret_set", { name: name.trim(), value });
      toast.success(`Stored "${name.trim()}" (encrypted)`);
      setName("");
      setValue("");
      refetch();
    } catch (cause) {
      toast.error(errorMessage(cause).replace(/^rpc handler failed: /, ""));
    } finally {
      setPending(false);
    }
  };

  if (data === null) return <EmptyState icon="Loading" title="Loading…" />;
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <SectionTitle hint="Reference a secret from any hook as {{secret:name}}. Commands get it as an environment variable; webhooks get it substituted when the request is made. Values are AES-256-GCM encrypted and never shown again.">Add or rotate a secret</SectionTitle>
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Name" hint="Letters, digits, . _ / -">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="slack/webhookUrl" autoComplete="off" />
          </Field>
          <Field label="Value" hint="Encrypted at rest">
            <Input type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder="••••••" autoComplete="new-password" />
          </Field>
          <Button type="submit" disabled={pending || name.trim() === "" || value === ""} className="sm:mb-5">
            <Icon name="Lock" className="size-4" />
            {pending ? "Saving…" : "Save"}
          </Button>
        </form>
      </section>
      <section className="space-y-2">
        <SectionTitle>
          Stored secrets <span className="font-normal text-muted-foreground">({data.secrets.length})</span>
        </SectionTitle>
        {data.secrets.length === 0 ? (
          <EmptyState icon="Lock" title="No secrets stored">
            Installing a template with credentials adds them here automatically.
          </EmptyState>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Created by</TableHead>
                  <TableHead>Used by</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.secrets.map((secret) => (
                  <SecretRowView key={secret.name} secret={secret} usedBy={usedBy.get(secret.name) ?? []} onChanged={refetch} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

function SecretRowView({ secret, usedBy, onChanged }: { secret: SecretRow; usedBy: string[]; onChanged: () => void }) {
  const { rpc } = useOverview();
  const [rotating, setRotating] = useState(false);
  const [next, setNext] = useState("");
  const placeholder = `{{secret:${secret.name}}}`;
  const rotate = async () => {
    if (next === "") return;
    try {
      await rpc.call("secret_set", { name: secret.name, value: next });
      toast.success(`Rotated "${secret.name}"`);
      setRotating(false);
      setNext("");
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };
  const remove = async () => {
    try {
      await rpc.call("secret_remove", { name: secret.name });
      toast.success(`Removed "${secret.name}"`);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(placeholder);
      toast.success(`Copied ${placeholder}`);
    } catch {
      toast.error("Clipboard unavailable");
    }
  };
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="Lock" className="size-3.5 text-muted-foreground" />
          {secret.name}
        </span>
        {rotating ? (
          <div className="mt-2 flex items-center gap-1.5">
            <Input type="password" value={next} onChange={(event) => setNext(event.target.value)} placeholder="New value" className="h-8 w-56" autoComplete="new-password" />
            <Button type="button" size="sm" onClick={rotate} disabled={next === ""}>
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRotating(false)}>
              Cancel
            </Button>
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{secret.managed ? "template" : "you"}</TableCell>
      <TableCell className="text-xs">
        {usedBy.length === 0 ? <span className="text-muted-foreground">no hook</span> : usedBy.map((id) => <span key={id} className="mr-1 rounded-md bg-muted px-1.5 py-0.5 font-mono">{id}</span>)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{formatWhen(secret.updatedAt)}</TableCell>
      <TableCell className="text-right">
        <div className="inline-flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="icon" variant="ghost" className="size-8" aria-label="Copy placeholder" onClick={copy}>
                <Icon name="Copy" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy {placeholder}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="icon" variant="ghost" className="size-8" aria-label="Rotate" onClick={() => setRotating((value) => !value)}>
                <Icon name="RotateCcw" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Rotate value</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" aria-label={`Remove ${secret.name}`} onClick={remove}>
                <Icon name="Trash2" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{usedBy.length > 0 ? `Used by ${usedBy.length} hook${usedBy.length === 1 ? "" : "s"}` : "Remove"}</TooltipContent>
          </Tooltip>
        </div>
      </TableCell>
    </TableRow>
  );
}
