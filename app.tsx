// bb-plugin-hooks — the Hooks page in the BB sidebar.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { HeaderActions, HooksPage, PANEL_PATH } from "./src/ui/page";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "marketplace",
    title: "Hooks",
    icon: "Webhook",
    path: PANEL_PATH,
    component: HooksPage,
    headerContent: HeaderActions,
  });
});
