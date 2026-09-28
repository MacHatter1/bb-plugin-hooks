import { createHash, randomBytes } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import plugin from "../server.js";
import { useTemplate, type ActionDeps } from "../src/actions.js";
import { createRegistry, type Catalog, type CatalogRecord } from "../src/catalog.js";
import type { HookDefinition } from "../src/definitions.js";
import type { SecretStore } from "../src/secrets.js";
import { leadingZeroBits, sendInstallReport, solveChallenge } from "../src/stats-report.js";
import { COUNTED_CATALOG, countsInstalls, type InstallReport, type ShareInstalls } from "../src/stats.js";
import type { HookStore } from "../src/store.js";

const OFFICIAL_URL = `${COUNTED_CATALOG.sourcePrefix}HEAD/hooks-catalog.json`;
const catalog = (name = "community"): Catalog => ({
  name,
  templates: [
    { id: "ping", name: "Ping", summary: "Echo on idle.", kind: "observe", events: ["thread.idle"], params: [], command: "echo ping", version: "1.2.0" },
    { id: "pong", name: "Pong", summary: "Echo on failure.", kind: "observe", events: ["thread.failed"], params: [], command: "echo pong" },
  ],
});

/** A fake counter: issues challenges and accepts only solved reports. */
function fakeCounter(difficulty = 8) {
  const issued = new Set<string>();
  const received: InstallReport[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  async function handle(url: string, init?: RequestInit): Promise<Response | null> {
    if (url.startsWith(`${COUNTED_CATALOG.counter}/challenge?`)) {
      requests.push({ url, init });
      const token = randomBytes(8).toString("hex");
      issued.add(token);
      return Response.json({ token, difficulty });
    }
    if (url === COUNTED_CATALOG.counter && init?.method === "POST") {
      requests.push({ url, init });
      const body = JSON.parse(String(init.body)) as InstallReport & { token: string; nonce: number };
      const solved = leadingZeroBits(createHash("sha256").update(`${body.token}.${body.nonce}`).digest()) >= difficulty;
      if (!issued.has(body.token) || !solved) return new Response("no", { status: 403 });
      received.push({ catalog: body.catalog, template: body.template, version: body.version });
      return new Response(null, { status: 204 });
    }
    return null;
  }
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => (await handle(String(url), init)) ?? new Response("not found", { status: 404 })) as typeof fetch;
  return { handle, fetchImpl, received, requests };
}

describe("which installs count", () => {
  it("counts only the marketplace catalog, from its own GitHub source", () => {
    expect(countsInstalls({ source: "community", sourceUrl: OFFICIAL_URL })).toBe(true);
    expect(countsInstalls({ source: "community", sourceUrl: `${COUNTED_CATALOG.sourcePrefix}v1.1.0/hooks-catalog.json` })).toBe(true);
    expect(countsInstalls({ source: "community", sourceUrl: "https://raw.githubusercontent.com/someone/fork/HEAD/hooks-catalog.json" })).toBe(false);
    expect(countsInstalls({ source: "acme", sourceUrl: OFFICIAL_URL })).toBe(false);
    expect(countsInstalls({ source: "bundled", sourceUrl: null })).toBe(false);
  });
});

describe("sending a report", () => {
  it("solves the challenge and posts exactly the template, version and proof", async () => {
    const counter = fakeCounter();
    expect(await sendInstallReport({ catalog: "community", template: "ping", version: "1.2.0" }, { fetchImpl: counter.fetchImpl })).toBe(true);
    expect(counter.received).toEqual([{ catalog: "community", template: "ping", version: "1.2.0" }]);
    const [challenge, report] = counter.requests;
    expect(challenge?.url).toBe(`${COUNTED_CATALOG.counter}/challenge?template=ping`);
    expect(challenge?.init?.redirect).toBe("error");
    expect(report?.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(Object.keys(JSON.parse(String(report?.init?.body))).sort()).toEqual(["catalog", "nonce", "template", "token", "version"]);
  });

  it("refuses challenges above the difficulty cap, and never throws", async () => {
    const hard = fakeCounter(30);
    expect(await sendInstallReport({ catalog: "community", template: "ping", version: null }, { fetchImpl: hard.fetchImpl })).toBe(false);
    expect(hard.requests).toHaveLength(1);
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await sendInstallReport({ catalog: "community", template: "ping", version: null }, { fetchImpl: offline })).toBe(false);
    const garbage = (async () => Response.json({ token: 42 })) as unknown as typeof fetch;
    expect(await sendInstallReport({ catalog: "community", template: "ping", version: null }, { fetchImpl: garbage })).toBe(false);
  });

  it("yields while solving, so the server stays responsive", async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 0);
    const nonce = await solveChallenge("responsive", 16);
    clearInterval(timer);
    expect(leadingZeroBits(createHash("sha256").update(`responsive.${nonce}`).digest())).toBeGreaterThanOrEqual(16);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe("useTemplate install reports", () => {
  function setup(consent: ShareInstalls, url = OFFICIAL_URL, name = "community") {
    const hooks = new Map<string, HookDefinition>();
    const store = {
      list: async () => [...hooks.values()],
      upsert: async (hook: HookDefinition) => {
        const created = !hooks.has(hook.id);
        hooks.set(hook.id, hook);
        return { created };
      },
    } as unknown as HookStore;
    const secrets = { set() {}, gcManaged: () => [] } as unknown as SecretStore;
    const record: CatalogRecord = { url, name, etag: null, fetchedAt: 0, catalog: catalog(name), error: null };
    const reports: InstallReport[] = [];
    const state = { consent };
    const deps: ActionDeps = {
      store,
      secrets,
      registry: createRegistry([], () => [record]),
      stats: {
        consent: () => state.consent,
        setConsent: async (value) => {
          state.consent = value;
        },
        report: (body) => reports.push(body),
      },
    };
    return { deps, reports, state, ref: `${name}/ping` };
  }

  it("reports a new install when the user has agreed", async () => {
    const { deps, reports, ref } = setup("on");
    expect(await useTemplate(deps, { ref, params: {}, trusted: true })).toMatchObject({ ok: true, shareInstalls: "on" });
    expect(reports).toEqual([{ catalog: "community", template: "ping", version: "1.2.0" }]);
  });

  it("does not count re-running use on an installed hook", async () => {
    const { deps, reports, ref } = setup("on");
    await useTemplate(deps, { ref, params: {}, trusted: true });
    await useTemplate(deps, { ref, params: {}, trusted: true });
    expect(reports).toHaveLength(1);
  });

  it("sends nothing when off, or while undecided", async () => {
    const off = setup("off");
    expect(await useTemplate(off.deps, { ref: off.ref, params: {}, trusted: true })).toMatchObject({ shareInstalls: "off" });
    const ask = setup("ask");
    expect(await useTemplate(ask.deps, { ref: ask.ref, params: {}, trusted: true })).toMatchObject({ shareInstalls: "ask" });
    expect([...off.reports, ...ask.reports]).toEqual([]);
    expect(ask.state.consent).toBe("ask");
  });

  it("remembers the answer given at install time", async () => {
    const yes = setup("ask");
    await useTemplate(yes.deps, { ref: yes.ref, params: {}, trusted: true, shareInstalls: true });
    expect(yes.state.consent).toBe("on");
    expect(yes.reports).toHaveLength(1);
    const no = setup("ask");
    await useTemplate(no.deps, { ref: no.ref, params: {}, trusted: true, shareInstalls: false });
    expect(no.state.consent).toBe("off");
    expect(no.reports).toEqual([]);
  });

  it("never reports other catalogs, even one named community", async () => {
    for (const other of [setup("on", "https://raw.githubusercontent.com/someone/fork/HEAD/hooks-catalog.json"), setup("on", "https://acme.test/hooks-catalog.json", "acme")]) {
      expect(await useTemplate(other.deps, { ref: other.ref, params: {}, trusted: true, shareInstalls: true })).toMatchObject({ ok: true, shareInstalls: null });
      expect(other.reports).toEqual([]);
    }
  });
});

describe("install counts end to end", () => {
  const counter = fakeCounter();
  const { bb, harness } = createFakePluginHost({ pluginId: "hooks", settings: { catalogs: "" } });
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    // Serve the marketplace catalog and the counter at their real addresses.
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url) === OFFICIAL_URL) return Response.json(catalog());
      return (await counter.handle(String(url), init)) ?? realFetch(url, init);
    });
    await plugin(bb);
  });
  afterAll(async () => {
    await harness.lifecycle.dispose();
    vi.unstubAllGlobals();
  });

  const settle = async (count: number) => {
    for (let i = 0; i < 60 && counter.received.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  };

  it("asks first, then reports each new marketplace install once the user opts in", async () => {
    expect((await harness.behavior.runCli(["marketplace", "add", "MacHatter1/bb-hooks-marketplace"])).exitCode).toBe(0);

    const first = await harness.behavior.runCli(["use", "community/ping", "--yes"]);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout).toContain("counts installs anonymously");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(counter.received).toEqual([]);

    expect((await harness.behavior.runCli(["marketplace", "stats"])).stdout).toContain("ask: nothing is reported");
    expect((await harness.behavior.runCli(["marketplace", "stats", "on"])).stdout).toContain("on: new installs are reported");
    expect((await harness.behavior.runCli(["marketplace", "stats", "maybe"])).exitCode).toBe(1);

    const second = await harness.behavior.runCli(["use", "community/pong", "--yes"]);
    expect(second.stdout).not.toContain("counts installs anonymously");
    await settle(1);
    expect(counter.received).toEqual([{ catalog: "community", template: "pong", version: null }]);

    await harness.behavior.runCli(["use", "community/pong", "--yes"]);
    await harness.behavior.runCli(["marketplace", "stats", "off"]);
    await harness.behavior.runCli(["use", "community/ping", "--yes", "--id", "ping-two"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(counter.received).toHaveLength(1);
  });
});
