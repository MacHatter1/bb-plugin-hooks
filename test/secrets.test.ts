import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import type { HookDefinition } from "../src/definitions.js";
import { createRunner } from "../src/runner.js";
import { SECRET_MIGRATIONS, createSecretStore, decrypt, encrypt, envNameFor, generateKey, hookSecretRefs, referencedSecrets } from "../src/secrets.js";

const dir = mkdtempSync(join(tmpdir(), "bb-hooks-secrets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function openStore() {
  const db = new BetterSqlite3(join(dir, `${Math.random().toString(36).slice(2)}.db`));
  for (const statement of SECRET_MIGRATIONS) db.exec(statement);
  return createSecretStore(db, generateKey());
}

describe("encryption", () => {
  it("round-trips and rejects a wrong key", () => {
    const key = generateKey();
    const blob = encrypt(key, "hunter2");
    expect(blob).not.toContain("hunter2");
    expect(decrypt(key, blob)).toBe("hunter2");
    expect(() => decrypt(generateKey(), blob)).toThrow();
  });

  it("maps names to environment variables", () => {
    expect(envNameFor("slack/webhookUrl")).toBe("BB_SECRET_SLACK_WEBHOOKURL");
    expect(envNameFor("my-token.v2")).toBe("BB_SECRET_MY_TOKEN_V2");
  });
});

describe("secret store", () => {
  it("stores, lists, updates and removes", () => {
    const store = openStore();
    store.set("a/token", "one", { managed: true });
    store.set("manual", "two");
    expect(store.get("a/token")).toBe("one");
    expect(store.list().map((secret) => [secret.name, secret.managed])).toEqual([
      ["a/token", true],
      ["manual", false],
    ]);
    store.set("a/token", "three");
    expect(store.get("a/token")).toBe("three");
    expect(store.list().find((secret) => secret.name === "a/token")?.managed).toBe(true);
    expect(store.remove("manual")).toBe(true);
    expect(store.remove("manual")).toBe(false);
    expect(() => store.set("bad name!", "x")).toThrow(/invalid secret name/);
  });

  it("garbage-collects managed secrets that no hook references", () => {
    const store = openStore();
    store.set("slack/webhookUrl", "u", { managed: true });
    store.set("old/token", "t", { managed: true });
    store.set("keep-manual", "m");
    const hooks: HookDefinition[] = [{ id: "slack", event: "thread.idle", url: "{{secret:slack/webhookUrl}}", enabled: true }];
    expect(hookSecretRefs(hooks[0]!)).toEqual(["slack/webhookUrl"]);
    expect(store.gcManaged(referencedSecrets(hooks))).toEqual(["old/token"]);
    expect(store.list().map((secret) => secret.name)).toEqual(["keep-manual", "slack/webhookUrl"]);
  });
});

describe("runner secret resolution", () => {
  const values: Record<string, string> = { "demo/token": "s3cr3t", "demo/url": "https://hooks.example.test/abc" };
  const resolve = (name: string) => values[name];

  it("passes command secrets through the environment, never the command line", async () => {
    const runner = createRunner();
    const hook: HookDefinition = { id: "c", event: "thread.idle", command: `printf 'got=%s' {{secret:demo/token}}`, enabled: true };
    const outcome = await runner.run({ hook, payload: {}, env: {}, timeoutMs: 5_000, secrets: resolve });
    expect(outcome).toMatchObject({ status: "ok", stdout: "got=s3cr3t" });
  });

  it("substitutes secrets into url, headers and body at request time", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const runner = createRunner({
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
        return new Response("", { status: 200 });
      },
    });
    const hook: HookDefinition = {
      id: "u",
      event: "thread.idle",
      url: "{{secret:demo/url}}",
      headers: { authorization: "Bearer {{secret:demo/token}}" },
      body: '{"token":"{{secret:demo/token}}","title":"{{thread.title}}"}',
      enabled: true,
    };
    const outcome = await runner.run({ hook, payload: { thread: { title: "T" } }, env: {}, timeoutMs: 5_000, secrets: resolve });
    expect(outcome.status).toBe("ok");
    expect(seen[0]?.url).toBe("https://hooks.example.test/abc");
    expect(seen[0]?.headers.authorization).toBe("Bearer s3cr3t");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ token: "s3cr3t", title: "T" });
  });

  it("fails clearly when a secret is missing", async () => {
    const runner = createRunner();
    const hook: HookDefinition = { id: "m", event: "thread.idle", command: "echo {{secret:nope}}", enabled: true };
    const outcome = await runner.run({ hook, payload: {}, env: {}, timeoutMs: 5_000, secrets: resolve });
    expect(outcome).toMatchObject({ status: "error", error: expect.stringContaining('missing secret "nope"') });
  });
});
