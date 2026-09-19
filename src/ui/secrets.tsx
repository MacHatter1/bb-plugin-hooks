// The Secrets tab: encrypted values hooks reference as {{secret:NAME}}.
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Badge, EmptyState, Field, SectionTitle, errorMessage, formatWhen, useOverview } from "./shared";

export function SecretsTab() {
  const { data, rpc, refetch } = useOverview();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);

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
      toast.error(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const remove = async (secretName: string) => {
    try {
      await rpc.call("secret_remove", { name: secretName });
      toast.success(`Removed "${secretName}"`);
      refetch();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  if (data === null) return <EmptyState>Loading…</EmptyState>;
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <SectionTitle>Add or rotate a secret</SectionTitle>
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Name" hint="Letters, digits, . _ / -">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="slack/webhookUrl" autoComplete="off" />
          </Field>
          <Field label="Value" hint="Encrypted at rest">
            <Input type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder="••••••" autoComplete="new-password" />
          </Field>
          <Button type="submit" disabled={pending || name.trim() === "" || value === ""}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Reference a secret from any hook as <code>{"{{secret:name}}"}</code>. Commands receive it as an environment variable; webhooks get it substituted into the url, headers, or body when the request is made. Values are AES-256-GCM encrypted on the server and never shown again.
        </p>
      </section>
      <section className="space-y-2">
        <SectionTitle>Stored secrets</SectionTitle>
        {data.secrets.length === 0 ? (
          <EmptyState>No secrets stored. Installing a template with credentials adds them here automatically.</EmptyState>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {data.secrets.map((secret) => (
              <li key={secret.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <Icon name="Lock" className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono">{secret.name}</span>
                <Badge>{secret.managed ? "from template" : "manual"}</Badge>
                <span className="text-xs text-muted-foreground">
                  used by {secret.usedBy} hook{secret.usedBy === 1 ? "" : "s"} · updated {formatWhen(secret.updatedAt)}
                </span>
                <Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" aria-label={`Remove ${secret.name}`} onClick={() => void remove(secret.name)}>
                  <Icon name="Trash2" className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
