<p align="center">
  <img src="assets/logo.svg" width="128" height="128" alt="BB Hooks logo">
</p>

<h1 align="center">BB Hooks</h1>

<p align="center">
  Custom hooks for <a href="https://github.com/get-bb/bb">BB</a> agents: run a shell command or call a webhook when a thread changes state,<br>
  gate messages before they reach the agent, keep credentials encrypted, and install ready-made hooks from a marketplace.
</p>

<p align="center">
  <img alt="version: 0.2.0" src="https://img.shields.io/badge/version-0.2.0-6d5cff?style=flat-square">
  <img alt="bb: 0.43+" src="https://img.shields.io/badge/bb-0.43%2B-3b82f6?style=flat-square">
  <img alt="templates: 12 bundled" src="https://img.shields.io/badge/templates-12%20bundled-10b981?style=flat-square">
  <img alt="tests: 61" src="https://img.shields.io/badge/tests-61-ef4444?style=flat-square">
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square">
</p>

<p align="center">
  <a href="https://github.com/MacHatter1/bb-hooks-marketplace">Community catalog</a> ·
  <a href="#the-hooks-page">The Hooks page</a> ·
  <a href="#premade-hooks">Premade hooks</a> ·
  <a href="#secrets">Secrets</a> ·
  <a href="#marketplace">Marketplace</a> ·
  <a href="#cli">CLI</a>
</p>

```
bb hooks add notify --event thread.idle \
  --command 'osascript -e "display notification \"$BB_THREAD_TITLE\" with title \"Agent finished\""'

bb hooks add no-prod --event message.dispatch --text 'prod(uction)?' \
  --command 'echo "Mention of production needs a human; send from the UI with Send now." >&2; exit 2'

bb hooks add slack --event thread.failed --url https://hooks.slack.com/triggers/…
```

## The Hooks page

The plugin adds a **Hooks** page to the BB sidebar. A stats strip shows
installed hooks, runs in the last 24 hours with failures, and marketplace
size; the title bar holds the master switch (Running / Paused) and a refresh.

- **Marketplace** — every template from the built-in set and your catalogs,
  with search (`/` focuses it), category chips (Notify, Integrate, Automate,
  Guard, Observe), source and kind filters, and a "start here" row. Each
  card opens a dialog with About, Install (parameters, events, filters,
  hook id) and What it runs. Catalog templates need an explicit trust
  confirmation. Cards show how many hooks you already have from them.
- **Installed** — hooks grouped into gates and reacting hooks, each with an
  on/off switch, last-run status, Test (status, decision, output, payload),
  Edit, Remove, and expandable details. **New hook** opens a new thread
  seeded with the bundled `create-hook` skill: you describe what should
  happen and when, and the agent picks a template or writes the hook, tests
  it with `bb hooks test`, and hands it over. The same "Create a hook" entry
  sits in every composer's **+** menu, so you can start from any thread. A
  "write by hand" button opens the form editor instead, which Edit also uses. The run log below is live,
  filterable by hook and failures, and opens the full output per row.
- **Sources** — catalogs as cards with template counts, status and homepage,
  add by `owner/repo`, URL or alias, refresh, browse, remove.
- **Secrets** — encrypted values with the hooks that use them, rotate in
  place, copy the `{{secret:name}}` placeholder.
- **Reference** — events, payload, environment variables, gate decisions,
  placeholders and the CLI on one page.

Everything the page does is also available from `bb hooks`, and the page
updates live when hooks change from the CLI or an agent.

## Skills for agents

Two skills ship with the plugin and are injected into every agent thread:

- `hooks` — the reference: events, payload, environment, `bb hooks` commands,
  templates, secrets, and the rules an agent should follow.
- `create-hook` — the guided flow behind the New hook button: understand
  what the user wants, prefer a template, otherwise write the hook, test it,
  and hand it over. An agent also uses it whenever someone asks to automate
  something on a thread event.

## Premade hooks

`bb hooks templates` lists ready-made hooks; `bb hooks use <template>` turns one
into ordinary hooks you can edit, test, and remove like any other.

| Template | Kind | What it does |
| --- | --- | --- |
| `desktop-notify` | observe | macOS or Linux notification when an agent needs you, finishes, or fails. |
| `speak` | observe | Reads the event aloud with `say` (or spd-say / espeak). |
| `ntfy` | observe | Phone push through ntfy.sh; no account, just a topic. |
| `slack`, `discord`, `telegram` | observe | Chat message with the thread title and the last reply or error. |
| `webhook` | observe | Raw event JSON to any URL, signed when the secret is set. |
| `log-to-file` | observe | One JSON line per event appended to a file. |
| `follow-up` | observe | When a thread finishes, spawn a new thread in the same workspace with your prompt plus its output. |
| `review` | observe | `follow-up` preset as a strict code reviewer, ideally on a different provider. |
| `block-pattern` | gate | Reject messages matching a regular expression, with your reason. |
| `office-hours` | gate | Hold messages outside a daily window until it opens. |

```
bb hooks use desktop-notify --set sound=Glass
bb hooks use ntfy --set topic=my-secret-topic-8f3a
bb hooks use slack --set webhookUrl=https://hooks.slack.com/services/… --event thread.failed
bb hooks use block-pattern --set 'pattern=\bprod(uction)?\b' --set 'message=Production needs a human.'
bb hooks use office-hours --set start=9 --set end=18 --text '#overnight'
bb hooks use review --set provider=codex --title '^feat'
```

`--set key=value` fills a parameter (`bb hooks templates <template>` lists
them), `--event` overrides the default events of an observe template (repeat
it for several; one hook is created per event), and `--project`, `--provider`,
`--title`, `--text` add filters. Generated hooks record their template and
values in a `template` field, and `use` again with the same id replaces them.

## Secrets

Credentials never go into the hooks setting. A template parameter marked
secret (Slack and Discord webhook URLs, the Telegram bot token, the ntfy
topic, …) is stored encrypted by `bb hooks use`, and the hook only carries a
reference:

```
bb hooks use slack --set webhookUrl=https://hooks.slack.com/services/…
bb hooks show slack-idle        # "url": "{{secret:slack/webhookUrl}}"
bb hooks secrets list
bb hooks secrets set slack/webhookUrl https://hooks.slack.com/services/NEW   # rotate
```

Hand-written hooks can reference secrets too: `bb hooks secrets set gh/token
ghp_…`, then use `{{secret:gh/token}}` in a command, url, header, or body.
In commands the value arrives as an environment variable
(`BB_SECRET_GH_TOKEN`), so it never appears on a command line. In urls,
headers and bodies it is substituted when the request is made. Secrets are
AES-256-GCM encrypted in the plugin database; the key lives in the plugin's
secret settings store (a 0600 file BB never sends to the browser). Removing a
hook removes the secrets that only it used. `--set key=secret:<name>` reuses
an existing secret instead of storing a new one.

## Marketplace

Templates can come from catalogs: a `hooks-catalog.json` published at an
https URL or at the root of a GitHub repository.

```
bb hooks marketplace add owner/repo          # or an https URL, or `starter`
bb hooks marketplace list
bb hooks templates --search "phone"          # bundled + every catalog
bb hooks templates acme/pager                # shows exactly what it runs
bb hooks use acme/pager --set routingKey=… --yes
bb hooks marketplace refresh
bb hooks marketplace remove owner/repo
```

Catalog templates are namespaced `catalog/template`; a bare id still works
when it is unique. Installing one requires `--yes`, because it will run on
your machine, and the command always prints the template's command, url, and
body before asking for it. Catalogs are cached in the plugin database, use
ETags, are refreshed every six hours and on demand, and are capped at 512 KiB
and 200 templates. Catalog URLs must be https (http only on localhost).

Two catalogs are subscribed by default: the plugin's own `starter` example
served at `/api/v1/plugins/hooks/http/catalog`, and the community catalog at
[github.com/MacHatter1/bb-hooks-marketplace](https://github.com/MacHatter1/bb-hooks-marketplace)
(PagerDuty, Teams, Mattermost, Pushover, email, Home Assistant, GitHub issue
comments, provider failover, credential and ticket gates). Contribute there
with a pull request.

### Publishing a catalog

```
bb hooks marketplace init --name my-hooks > hooks-catalog.json
bb hooks export my-hook >> ideas.json         # turn an existing hook into a template
bb hooks marketplace validate owner/repo      # after pushing
```

A catalog is `{ name, description?, version?, homepage?, templates: [...] }`.
Each template has `id`, `name`, `summary`, `kind` (`observe` or `gate`),
`events`, `params` (`key`, `label`, `type` string|integer, `default?`,
`required?`, `secret?`, `description?`), one of `command` or `url`, optional
`body`, `headers`, `match`, `timeoutMs`, `onError`, `notes`. `{{key}}` in
`command` is inserted shell-quoted (integers verbatim), in `url` and `match`
verbatim, in `body` JSON-escaped; secret params become `{{secret:…}}`
references. Anyone can then `bb hooks marketplace add owner/repo`.

## What a hook is

One JSON object, stored in the plugin's `hooks` setting (Settings → Installed
plugins → Hooks) and managed by `bb hooks`:

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits, dashes. |
| `event` | One of the events below. |
| `command` | Shell command run on the BB server (`/bin/sh -c`). Receives the payload on stdin. |
| `url` | Alternatively, an http(s) endpoint that receives the payload as a JSON POST. |
| `body` | Url hooks only: a body template such as `{"text":"{{thread.title}} {{lastAssistantText\|300}}"}`. Strings are JSON-escaped; without it the whole event JSON is sent. |
| `match` | Optional `{ projectId, providerId, title, text }`; `title` and `text` are regular expressions. |
| `timeoutMs` | Default 30 000; gate hooks are capped at 8 000. |
| `onError` | Gate hooks only: `proceed` (default), `reject` or `wait` when the hook fails or times out. |
| `cwd`, `headers`, `enabled`, `description` | As named. |

## Events

Observe-only, fired after the fact: `thread.created`, `thread.active`,
`thread.idle`, `thread.failed`, `thread.archived`, `thread.unarchived`,
`thread.deleted`, `interaction.pending`, `message.queued`,
`message.dispatched`, `message.cancelled`, `turn.failed`,
`experimental_thread.events`, `experimental_terminal.input`.

Gate, acted on: `message.dispatch`. The hook runs before every message reaches
the provider (first message, follow-up, steer, retry, queued re-attempt).

- exit `0` → proceed
- exit `2` → reject; stderr (then stdout) is the message the user sees
- exit `3` → wait; the message is queued with stderr as the reason
- a JSON object on the last stdout line overrides the exit code:
  `{"action":"reject","message":"…"}`, `{"action":"wait","reason":"…","sendAt":1700000000000}`, `{"action":"proceed"}`
- a webhook answers with the same JSON in its response body; an empty 2xx proceeds

A user's explicit **Send now** on a queued message bypasses gate hooks by
design.

## Payload

stdin / POST body:

```json
{
  "event": "thread.idle",
  "hookId": "notify",
  "timestamp": "2026-09-18T19:00:00.000Z",
  "serverUrl": "http://127.0.0.1:38886",
  "thread": { "id": "thr_…", "projectId": "proj_…", "providerId": "claude-code", "title": "…", "status": "idle", "…": "…" },
  "lastAssistantText": "…"
}
```

`thread.failed` adds `error`; `interaction.pending` adds `interaction`;
`message.*` add `entry`; `turn.failed` carries `requestId`, `errorInfo`,
`rateLimits` and `attemptNumber` plus a looked-up `thread`; `message.dispatch`
carries `project`, `environment`, `host`, `attempt`, `input.text`,
`requestedExecution` and `queuedMessage`.

Environment: `BB_HOOK_EVENT`, `BB_HOOK_ID`, `BB_THREAD_ID`, `BB_PROJECT_ID`,
`BB_PROVIDER_ID`, `BB_THREAD_TITLE`, `BB_THREAD_STATUS`, `BB_SERVER_URL`, and
for gate hooks `BB_DISPATCH_ATTEMPT`, `BB_MODEL`, `BB_MESSAGE_TEXT`.

Webhook headers: `x-bb-hooks-event`, `x-bb-hooks-id`, and with the
**Webhook signing secret** setting, `x-bb-hooks-timestamp` and
`x-bb-hooks-signature: sha256=HMAC_SHA256(secret, "<timestamp>.<body>")`.

## CLI

```
bb hooks templates [<template>] [--search text]
bb hooks use <template|catalog/template> [--set k=v]… [--id id] [--event e]… [--project id] [--provider id] [--title re] [--text re] [--disabled] [--yes]
bb hooks marketplace list|add <src>|remove <src>|refresh [src]|search <text>|validate <src>|init [--name n]
bb hooks secrets list|set <name> <value>|remove <name>
bb hooks export <id>
bb hooks events
bb hooks list [--json]
bb hooks show <id>
bb hooks add <id> --event <event> (--command <shell> | --url <url>) [--project id] [--provider id] [--title re] [--text re] [--timeout ms] [--cwd dir] [--header k=v] [--on-error mode] [--description text] [--disabled]
bb hooks edit <id> [same flags] [--clear-match]
bb hooks enable|disable|remove <id>
bb hooks test <id> [--thread thr_…]
bb hooks history [--limit n] [--hook id] | bb hooks history clear
```

## Settings

- **Hooks (JSON array)** — the definitions; validated on save.
- **Run hooks** — master switch.
- **Runs to keep in history** — default 200; 0 disables history.
- **Max concurrent hook runs** — default 8 (applies after reload).
- **Webhook signing secret** — optional, stored as a secret.
- **Marketplace catalogs** — one source per line; `bb hooks marketplace add` writes here.
- **Secrets encryption key** — generated on first load; changing it makes stored secrets unreadable.

## Constraints

- Commands run on the machine that hosts the BB server, with the server's
  user and environment. They do not run inside the thread's environment or on
  an enrolled remote machine.
- A gate hook that throws BB's 10 second decision box would fail the user's
  message, so this plugin caps every gate hook at 8 seconds total per dispatch
  and treats overruns as `onError`.
- `experimental_thread.events` fires up to once per second per running thread.

## Install

From a clone (path install, loads `server.ts` directly and follows your edits
after `bb plugin reload hooks`):

```
git clone https://github.com/MacHatter1/bb-plugin-hooks.git
cd bb-plugin-hooks && npm install
bb plugin install .
```

Or straight from git, which builds on install and can be updated with
`bb plugin update`:

```
bb plugin install git:https://github.com/MacHatter1/bb-plugin-hooks.git
```

The repository is private for now, so a git install needs git credentials for
GitHub on the machine running BB (`gh auth setup-git` configures them).

## Branding assets

`assets/logo.svg` is the plugin's logo (also shown by BB on the plugin page)
and `assets/social-preview.png` is the 1280×640 image for the repository's
social preview. They are rendered from SVG with the `npm run assets` script in
the [marketplace repository](https://github.com/MacHatter1/bb-hooks-marketplace),
which shares the same mark.

## Develop

```
npm install
npm run typecheck
npm test
bb plugin install .      # path install; loads server.ts directly
bb plugin build          # compiles app.tsx into dist/app.js (+ server bundle)
bb plugin reload hooks   # after edits; or `bb plugin dev` to rebuild on save
```
