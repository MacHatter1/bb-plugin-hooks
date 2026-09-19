import { describe, expect, it } from "vitest";
import { effectiveTimeoutMs, matches, parseHooksJson, serializeHooks, type HookDefinition } from "../src/definitions.js";

const base: HookDefinition = { id: "a", event: "thread.idle", command: "true", enabled: true };

describe("parseHooksJson", () => {
  it("accepts an empty setting", () => {
    expect(parseHooksJson("")).toEqual({ hooks: [] });
    expect(parseHooksJson("[]")).toEqual({ hooks: [] });
  });

  it("fills defaults and round-trips", () => {
    const parsed = parseHooksJson('[{"id":"notify","event":"thread.idle","command":"echo hi"}]');
    expect(parsed).toEqual({ hooks: [{ id: "notify", event: "thread.idle", command: "echo hi", enabled: true }] });
    if ("hooks" in parsed) expect(parseHooksJson(serializeHooks(parsed.hooks))).toEqual(parsed);
  });

  it("rejects malformed definitions with readable messages", () => {
    expect(parseHooksJson("nope")).toMatchObject({ error: expect.stringContaining("not valid JSON") });
    expect(parseHooksJson('[{"id":"x","event":"thread.idle"}]')).toMatchObject({ error: expect.stringContaining("needs a command or a url") });
    expect(parseHooksJson('[{"id":"x","event":"thread.idle","command":"a","url":"https://x"}]')).toMatchObject({ error: expect.stringContaining("not both") });
    expect(parseHooksJson('[{"id":"Bad Id","event":"thread.idle","command":"a"}]')).toMatchObject({ error: expect.stringContaining("id must be") });
    expect(parseHooksJson('[{"id":"x","event":"nope","command":"a"}]')).toMatchObject({ error: expect.stringContaining("event") });
    expect(parseHooksJson('[{"id":"x","event":"thread.idle","url":"ftp://x"}]')).toMatchObject({ error: expect.stringContaining("http") });
    expect(parseHooksJson('[{"id":"x","event":"thread.idle","command":"a","onError":"reject"}]')).toMatchObject({ error: expect.stringContaining("onError") });
    expect(parseHooksJson('[{"id":"x","event":"thread.idle","command":"a","match":{"title":"("}}]')).toMatchObject({ error: expect.stringContaining("regular expression") });
    expect(parseHooksJson('[{"id":"x","event":"thread.idle","command":"a"},{"id":"x","event":"thread.idle","command":"b"}]')).toMatchObject({ error: expect.stringContaining("duplicate") });
  });
});

describe("matches", () => {
  const subject = { projectId: "proj_1", providerId: "codex", title: "Fix login bug", text: "all done" };
  it("matches everything without filters", () => {
    expect(matches(base, subject)).toBe(true);
  });
  it("filters on project, provider, title and text", () => {
    expect(matches({ ...base, match: { projectId: "proj_1" } }, subject)).toBe(true);
    expect(matches({ ...base, match: { projectId: "proj_2" } }, subject)).toBe(false);
    expect(matches({ ...base, match: { providerId: "codex" } }, subject)).toBe(true);
    expect(matches({ ...base, match: { providerId: "claude-code" } }, subject)).toBe(false);
    expect(matches({ ...base, match: { title: "^Fix" } }, subject)).toBe(true);
    expect(matches({ ...base, match: { title: "^Add" } }, subject)).toBe(false);
    expect(matches({ ...base, match: { text: "done$" } }, subject)).toBe(true);
    expect(matches({ ...base, match: { text: "done$" } }, { ...subject, text: null })).toBe(false);
  });
});

describe("effectiveTimeoutMs", () => {
  it("defaults observe hooks to 30 s and caps gate hooks at 8 s", () => {
    expect(effectiveTimeoutMs(base)).toBe(30_000);
    expect(effectiveTimeoutMs({ ...base, timeoutMs: 1_000 })).toBe(1_000);
    expect(effectiveTimeoutMs({ ...base, event: "message.dispatch", timeoutMs: 60_000 })).toBe(8_000);
  });
});
