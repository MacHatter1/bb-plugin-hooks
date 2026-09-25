Hooks runs your shell commands or sends webhooks when BB thread events happen. Add a gate on `message.dispatch` to let messages through, reject them with a reason, or wait before they reach the provider.

## What you can do

- **Start from a template:** install desktop notifications, Slack, Discord, Telegram, ntfy, follow-up threads, code reviews, message gates and more.
- **Browse catalogs:** the built-in `starter` examples and community catalog are available by default. Add other GitHub repositories or HTTPS catalog URLs, then search and install their templates.
- **Protect credentials:** secrets are encrypted in the plugin database and referenced from hooks without storing their values in the hook definition.
- **Choose the match:** react to thread lifecycle events, filter by project, provider, title or text, or check each outgoing message before dispatch.
- **Use the interface you prefer:** manage and test hooks from the Hooks page, `bb hooks`, or an agent using the bundled skills.

## How it works

Hooks live in the plugin settings. Commands run on the machine hosting the BB server and receive event JSON on stdin; webhooks get a JSON POST, with an optional body template. Observe hooks run after events. Gate hooks run before dispatch and can proceed, reject or wait. Gates have an 8-second time limit and proceed on errors by default.

The server fetches configured marketplace catalogs periodically. URL hooks send event JSON to the endpoint you configure; shell commands run with the server user's access and can make their own network requests. Catalog templates require explicit confirmation before installation.

## For agents

The `hooks` skill documents events, payloads and the `bb hooks` CLI. The `create-hook` skill turns a request into a configured and tested hook; the New hook action opens a thread with that skill.
