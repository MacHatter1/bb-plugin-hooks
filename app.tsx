// bb-plugin-hooks — the Hooks page in the BB sidebar and a composer entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { HeaderActions, HooksPage, PANEL_PATH } from "./src/ui/page";
import { NEW_HOOK_PROMPT } from "./src/ui/shared";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "marketplace",
    title: "Hooks",
    icon: "Webhook",
    path: PANEL_PATH,
    component: HooksPage,
    headerContent: HeaderActions,
  });

  // The composer's "+" menu: start describing a hook from any composer.
  app.composer.customize({
    id: "hooks",
    plusMenu: [
      {
        id: "create-hook",
        label: "Create a hook",
        description: "Describe what should happen on a thread event; the agent installs and tests it.",
        run: ({ composer }) => {
          composer.updateText((current) => (current.trim() === "" ? NEW_HOOK_PROMPT : `${current.trimEnd()}\n\n${NEW_HOOK_PROMPT}`));
        },
      },
    ],
  });
});
