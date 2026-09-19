// The Reference tab: everything needed to write a hook by hand.
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Code, EventPill, KindBadge, SectionTitle, useOverview } from "./shared";

export function ReferenceTab() {
  const { data } = useOverview();
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionTitle hint="A hook subscribes to one event. Reacting hooks run after the fact; the gate decides before a message reaches the agent.">Events</SectionTitle>
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-56">Event</TableHead>
                <TableHead className="w-24">Kind</TableHead>
                <TableHead>What it means</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.events ?? []).map((info) => (
                <TableRow key={info.event}>
                  <TableCell>
                    <EventPill event={info.event} />
                  </TableCell>
                  <TableCell>
                    <KindBadge kind={info.kind} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{info.summary}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <SectionTitle hint="Command hooks read one JSON object from stdin; webhooks receive it as the POST body.">Payload</SectionTitle>
          <Code>{`{
  "event": "thread.idle",
  "hookId": "notify",
  "timestamp": "2026-09-19T09:00:00.000Z",
  "serverUrl": "http://127.0.0.1:38886",
  "thread": { "id": "thr_…", "projectId": "proj_…", "providerId": "claude-code",
              "title": "…", "status": "idle", "environmentId": "env_…", … },
  "lastAssistantText": "…"      // thread.idle
  "error": "…"                  // thread.failed
  "interaction": { … }          // interaction.pending
  "entry": { … }                // message.queued / dispatched / cancelled
  "requestId", "errorInfo", "rateLimits", "attemptNumber"   // turn.failed
  "project", "environment", "host", "attempt", "input": { "text" },
  "requestedExecution", "queuedMessage"                      // message.dispatch
}`}</Code>
        </div>
        <div className="space-y-2">
          <SectionTitle hint="Set for every command hook. Secrets arrive as BB_SECRET_<NAME>.">Environment</SectionTitle>
          <Code>{`BB_HOOK_EVENT        thread.idle
BB_HOOK_ID           notify
BB_THREAD_ID         thr_…
BB_THREAD_TITLE      first 1000 characters
BB_THREAD_STATUS     idle | active | error | pending | …
BB_PROJECT_ID        proj_…
BB_PROVIDER_ID       claude-code
BB_ENVIRONMENT_ID    env_…            (when known)
BB_PARENT_THREAD_ID  thr_…            (child threads only)
BB_SERVER_URL        http://127.0.0.1:38886
BB_CLI               absolute path to the bb binary
BB_MODEL             the thread's model      (gate hooks always; observe
BB_REASONING_LEVEL   … reasoning level        hooks when the command
BB_SERVICE_TIER      … service tier           mentions the variable)
BB_PERMISSION_MODE   … permission mode
BB_MESSAGE_TEXT      gate hooks: the message (first 1000 chars)
BB_DISPATCH_ATTEMPT  gate hooks: start-turn | join-turn`}</Code>
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <SectionTitle hint="A gate hook must answer within 8 seconds. Send now on a queued message bypasses gates by design.">Gate decisions</SectionTitle>
          <Code>{`exit 0                       proceed
echo "reason" >&2; exit 2    reject   (the sender sees the reason)
echo "reason" >&2; exit 3    wait     (queued with the reason)

# or a JSON object on the last stdout line:
{"action":"proceed"}
{"action":"reject","message":"Production needs a human."}
{"action":"wait","reason":"After hours","sendAt":1760000000000}

# any other failure or a timeout applies the hook's onError:
# proceed (default) | reject | wait`}</Code>
        </div>
        <div className="space-y-2">
          <SectionTitle hint="Webhook bodies are templates; commands use the environment or stdin.">Placeholders and secrets</SectionTitle>
          <Code>{`{"text": "BB {{event}} — {{thread.title}}\\n{{lastAssistantText|500}}"}

{{path}}          any payload path, JSON-escaped when a string
{{path|300}}      truncated to 300 characters
{{secret:name}}   a stored secret (url, headers, body); in a
                  command it becomes "$BB_SECRET_NAME"

Webhook headers: x-bb-hooks-event, x-bb-hooks-id and, when the
signing secret is set, x-bb-hooks-timestamp plus
x-bb-hooks-signature = sha256 HMAC of "<timestamp>.<body>"`}</Code>
        </div>
      </section>

      <section className="space-y-2">
        <SectionTitle hint="Everything on this page is also a command, which is what agents use.">CLI</SectionTitle>
        <Code>{`bb hooks templates [--search text]        bb hooks use <template> --set key=value [--yes]
bb hooks list | show <id> | test <id>    bb hooks add <id> --event <event> --command '…' | --url …
bb hooks enable|disable|remove <id>      bb hooks history [--hook id] [--limit n]
bb hooks marketplace add owner/repo      bb hooks secrets set <name> <value>
bb hooks export <id>                     bb hooks marketplace init > hooks-catalog.json`}</Code>
      </section>
    </div>
  );
}
