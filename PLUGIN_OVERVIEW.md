Make BB call your code when threads change state. Bind a shell command or a
webhook URL to any thread lifecycle event, filter it by project, provider or
title, and manage it all from `bb hooks` or the settings page.

## What you get

- **Premade hooks** you configure with one command: desktop notifications,
  spoken alerts, phone push via ntfy, Slack, Discord and Telegram messages,
  log to file, automatic follow-up and review threads, a pattern blocker, and
  office hours. `bb hooks use slack --set webhookUrl=…` and you are done.
- **A marketplace**: the community catalog at
  https://github.com/MacHatter1/bb-hooks-marketplace is subscribed out of the
  box; add more catalogs from GitHub repos or URLs, search across them,
  install with one command, and publish your own with
  `bb hooks marketplace init` and `bb hooks export`.
- **Encrypted secrets**: webhook URLs and tokens are stored encrypted and
  referenced as `{{secret:name}}`, never written into a hook.
- **Custom hooks** on every BB lifecycle event: thread created, active,
  idle, failed, archived, unarchived, deleted; interaction pending; messages
  queued, dispatched or cancelled; turn failed.
- **Gate hooks** on `message.dispatch`: your script decides whether a
  message proceeds, waits, or is rejected, with the reason shown to the user.
- **Shell or webhook targets**: commands get the event as JSON on stdin plus
  `BB_*` environment variables; webhooks get a signed JSON POST.
- **A `bb hooks` CLI** for agents and terminals: add, edit, enable, disable,
  test with a sample or real thread, and read run history.
- **Editable in settings**: the same definitions live in a JSON setting, so
  you can paste or version them.

## How it works

Hook definitions are stored in the plugin's settings on the BB server. When
an event fires, matching hooks run concurrently with a per-hook timeout and
the outcome is recorded in a bounded run history. Gate hooks run in their own
lane with an 8 second budget so a slow script never blocks BB.

Commands run on the machine hosting the BB server. Nothing leaves your
machine unless you point a hook at a URL.

## For agents

The bundled skill teaches agents the events, the payload shape, and the
`bb hooks` workflow: list events, add a hook, test it, check history.
