// A small catalog the plugin serves itself at /api/v1/plugins/hooks/http/catalog.
// `bb hooks marketplace add starter` subscribes to it; it doubles as the
// worked example of what a published hooks-catalog.json looks like.
import type { Catalog } from "./catalog.js";

export const STARTER_CATALOG: Catalog = {
  name: "starter",
  description: "Extra hooks served by the Hooks plugin itself: a worked example of a published catalog.",
  version: "1.0.0",
  author: "MacHatter1",
  homepage: "https://github.com/MacHatter1/bb-plugin-hooks",
  templates: [
    {
      id: "pushover",
      author: "MacHatter1",
      version: "1.0.0",
      tags: ["notifications", "phone", "push"],
      name: "Pushover notification",
      summary: "Push to your phone through Pushover.",
      kind: "observe",
      events: ["interaction.pending", "thread.failed"],
      params: [
        { key: "token", label: "Application token", type: "string", required: true, secret: true },
        { key: "user", label: "User key", type: "string", required: true, secret: true },
      ],
      url: "https://api.pushover.net/1/messages.json",
      body: `{"token":"{{token}}","user":"{{user}}","title":"BB {{event}}","message":"{{thread.title}}\\n{{lastAssistantText|300}}{{error|300}}"}`,
    },
    {
      id: "home-assistant",
      author: "MacHatter1",
      version: "1.0.0",
      tags: ["integration", "home-automation"],
      name: "Home Assistant webhook",
      summary: "Trigger a Home Assistant automation (turn a lamp red when an agent needs you).",
      kind: "observe",
      events: ["interaction.pending", "thread.idle"],
      params: [{ key: "webhookUrl", label: "Webhook URL", description: "https://<your-ha>/api/webhook/<id>", type: "string", required: true, secret: true }],
      url: "{{webhookUrl}}",
      body: `{"event":"{{event}}","thread":"{{thread.title}}","threadId":"{{thread.id}}"}`,
    },
    {
      id: "github-issue-comment",
      author: "MacHatter1",
      version: "1.0.0",
      tags: ["integration", "github", "automation"],
      name: "Comment on the linked GitHub issue",
      summary: "When a thread whose title mentions #123 finishes, post its output as a comment on issue 123.",
      kind: "observe",
      events: ["thread.idle"],
      params: [{ key: "repo", label: "Repository (owner/name)", type: "string", required: true }],
      command: `repo={{repo}}
n=$(printf '%s' "$BB_THREAD_TITLE" | sed -n 's/.*#\\([0-9][0-9]*\\).*/\\1/p' | head -n 1)
[ -z "$n" ] && exit 0
body=$("\${BB_CLI:-bb}" thread output "$BB_THREAD_ID" 2>/dev/null | head -c 60000)
[ -z "$body" ] && exit 0
printf '%s\\n\\n_Posted by BB hooks from thread %s._\\n' "$body" "$BB_THREAD_ID" | gh issue comment "$n" -R "$repo" --body-file -`,
      timeoutMs: 60_000,
      notes: "Needs the gh CLI authenticated on the machine running the BB server.",
    },
    {
      id: "archive-when-done",
      author: "MacHatter1",
      version: "1.0.0",
      tags: ["automation", "housekeeping"],
      name: "Archive finished threads",
      summary: "Archive a thread as soon as it goes idle. Scope it with --title so only throwaway threads are archived.",
      kind: "observe",
      events: ["thread.idle"],
      params: [],
      command: `"\${BB_CLI:-bb}" thread archive "$BB_THREAD_ID"`,
      notes: "Combine with --title '^chore' or --project. Archived threads can be unarchived from the sidebar.",
    },
  ],
};
