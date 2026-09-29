import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { HookDefinition } from "../src/definitions.js";
import { HISTORY_MIGRATIONS, createHistoryStore, createHookStore, type HooksSettings } from "../src/store.js";

function memorySettings(initial: string): HooksSettings & { raw: () => string } {
  let hooks = initial;
  const listeners: Array<(next: { hooks: string }, prev: { hooks: string }) => void> = [];
  return {
    async get() {
      return { hooks };
    },
    async experimental_set(values) {
      const prev = hooks;
      hooks = values.hooks;
      for (const listener of listeners) listener({ hooks }, { hooks: prev });
      return { hooks };
    },
    onChange(listener) {
      listeners.push(listener);
    },
    raw: () => hooks,
  };
}

const hook = (id: string): HookDefinition => ({ id, event: "thread.idle", command: "true", enabled: true });

describe("hook store", () => {
  it("leaves an unreadable hooks setting untouched", async () => {
    const settings = memorySettings("{");
    const store = createHookStore(settings, () => {});
    await expect(store.upsert(hook("a"))).rejects.toThrow(/left unchanged/);
    expect(settings.raw()).toBe("{");
    expect(await store.list()).toEqual([]);
  });

  it("applies overlapping adds in order", async () => {
    const settings = memorySettings("[]");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = settings.experimental_set.bind(settings);
    let writes = 0;
    settings.experimental_set = async (values) => {
      writes += 1;
      if (writes === 1) await gate;
      return original(values);
    };
    const store = createHookStore(settings, () => {});
    const first = store.upsert(hook("a"));
    const second = store.upsert(hook("b"));
    release?.();
    await Promise.all([first, second]);
    expect((await store.list()).map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("run log", () => {
  it("returns one page and the total, including a failure filter", () => {
    const db = new Database(":memory:");
    for (const sql of HISTORY_MIGRATIONS) db.exec(sql);
    const history = createHistoryStore(db);
    for (let index = 0; index < 5; index += 1) {
      history.record({
        hookId: index % 2 === 0 ? "even" : "odd",
        event: "thread.idle",
        threadId: null,
        startedAt: index,
        durationMs: 1,
        status: index === 3 ? "error" : "ok",
        exitCode: 0,
        httpStatus: null,
        decision: null,
        output: String(index),
        error: null,
      });
    }
    const page = history.list({ limit: 2, offset: 2 });
    expect(page.total).toBe(5);
    expect(page.runs.map((run) => run.output)).toEqual(["2", "1"]);
    const failed = history.list({ status: "failed", limit: 10 });
    expect(failed.total).toBe(1);
    expect(failed.runs[0]?.hookId).toBe("odd");
    db.close();
  });
});
