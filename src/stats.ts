// Anonymous install counts for the BB Hooks Marketplace catalog, and only that
// catalog: installs from any other source are never reported. The user opts in
// once through the `shareInstalls` setting. A report carries the template id and
// its version, and nothing else: no hook settings, ids or thread data. Pure, so
// the frontend can import it; the sender lives in stats-report.ts.

export const SHARE_INSTALLS = ["ask", "on", "off"] as const;
export type ShareInstalls = (typeof SHARE_INSTALLS)[number];

/** The one catalog whose installs are counted, and the counter it reports to. */
export const COUNTED_CATALOG = {
  name: "community",
  /** Where `MacHatter1/bb-hooks-marketplace` (at any ref) is fetched from. */
  sourcePrefix: "https://raw.githubusercontent.com/MacHatter1/bb-hooks-marketplace/",
  label: "BB Hooks Marketplace",
  counter: "https://bb-hooks-stats.machatter1.workers.dev/v1/installs",
} as const;

export interface InstallReport {
  catalog: string;
  template: string;
  version: string | null;
}

export interface InstallStats {
  /** The user's answer so far; "ask" until they give one. */
  consent(): ShareInstalls;
  setConsent(value: ShareInstalls): Promise<void>;
  /** Send one report in the background. Must not throw or delay the install. */
  report(body: InstallReport): void;
}

/**
 * Whether installs of this entry are counted: it must come from the
 * marketplace's own GitHub source. Matching the source URL, not just the
 * catalog name, keeps look-alike catalogs out.
 */
export function countsInstalls(entry: { source: string; sourceUrl: string | null }): boolean {
  return entry.source === COUNTED_CATALOG.name && entry.sourceUrl !== null && entry.sourceUrl.startsWith(COUNTED_CATALOG.sourcePrefix);
}
