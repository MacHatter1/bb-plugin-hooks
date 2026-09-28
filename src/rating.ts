// Browse ratings for a template, out of 100. Derived from the command or URL
// it runs, so a catalog cannot claim a score its template does not earn.
// The letter is the usual scale: A+ is 97–100, then A, A-, B+, and so on to F.

export interface RatedTemplate {
  kind: "observe" | "gate";
  events: readonly string[];
  command?: string;
  url?: string;
  timeoutMs?: number;
  params?: readonly { secret?: boolean }[];
}

export interface Score {
  /** 0–100. Higher is better: faster, or safer. */
  score: number;
  /** A+ through F, including A, A-, B+, B, B-. */
  letter: string;
  reason: string;
}

const FETCH_PIPE = /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)\b/;
const REMOTE = /\b(curl|wget|nc|ncat|ssh|scp)\b|\bgh\s+/;
const HEAVY = /\bthread (spawn|output)\b|\bsleep\b/;

export function letterGrade(score: number): string {
  const bands: ReadonlyArray<readonly [number, string]> = [
    [97, "A+"],
    [93, "A"],
    [90, "A-"],
    [87, "B+"],
    [83, "B"],
    [80, "B-"],
    [77, "C+"],
    [73, "C"],
    [70, "C-"],
    [67, "D+"],
    [63, "D"],
    [60, "D-"],
  ];
  for (const [min, letter] of bands) if (score >= min) return letter;
  return "F";
}

function settle(raw: number, reasons: string[], fallback: string): Score {
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const detail = reasons.at(-1);
  const reason = detail === undefined ? fallback : `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`;
  return { score, letter: letterGrade(score), reason };
}

/** How much the template costs when it fires. Gate hooks share an 8 second budget. */
export function ratePerformance(template: RatedTemplate): Score {
  let score = template.command === undefined ? 100 : 97;
  const command = template.command ?? "";
  const timeout = template.timeoutMs ?? (template.kind === "gate" ? 8_000 : 30_000);
  const reasons: string[] = [];
  const remote = template.url !== undefined || REMOTE.test(command);
  const heavy = HEAVY.test(command);
  if (remote) {
    score -= 8;
    reasons.push("waits on the network");
  }
  if (heavy) {
    score -= 28;
    reasons.push("starts other work");
  } else if (timeout >= 60_000) {
    score -= 22;
    reasons.push("allows a run of a minute or more");
  } else if (template.timeoutMs !== undefined && timeout > 15_000) {
    score -= 8;
    reasons.push("allows a longer run");
  }
  if (template.events.includes("experimental_thread.events")) {
    score -= 18;
    reasons.push("can fire about once a second per running thread");
  }
  if (template.kind === "gate" && (template.url !== undefined || heavy || timeout > 8_000)) {
    score -= 20;
    reasons.push("runs on the message path, which has an 8 second budget");
  }
  return settle(score, reasons, "Finishes locally, well inside the default time limit.");
}

/** What the template can reach, and where event data goes. */
export function rateSecurity(template: RatedTemplate): Score {
  const command = template.command ?? "";
  if (FETCH_PIPE.test(command) || /\beval\b/.test(command) || /\/dev\/tcp/.test(command)) {
    return settle(45, ["can run code fetched from the network"], "");
  }
  if (template.url !== undefined && /^http:\/\//i.test(template.url)) {
    return settle(60, ["sends the payload over plain HTTP"], "");
  }
  let score = 100;
  const reasons: string[] = [];
  if (template.command !== undefined) {
    score -= 6;
    reasons.push("runs a shell as the BB server user");
  }
  if (template.url !== undefined) {
    score -= 16;
    reasons.push("sends event data to another service");
  } else if (REMOTE.test(command)) {
    score -= 22;
    reasons.push("the command can reach the network");
  }
  if (/\bthread spawn\b/.test(command)) {
    score -= 14;
    reasons.push("starts another agent with this thread's output");
  }
  if (/>>/.test(command)) {
    score -= 8;
    reasons.push("writes a file on the machine that hosts BB");
  }
  return settle(score, reasons, "Stays on this machine.");
}

export function rateTemplate(template: RatedTemplate): { performance: Score; security: Score } {
  return { performance: ratePerformance(template), security: rateSecurity(template) };
}

/** `92 A-` — the mark used in the Hooks page and the README. */
export function formatMark(score: Score): string {
  return `${score.score} ${score.letter}`;
}
