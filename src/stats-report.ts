// Sends one install report to the marketplace counter. The counter first
// issues a challenge bound to this network address, the template and the day;
// solving it takes a moment of CPU (proof of work), which makes faking
// installs expensive. Runs in the background and never throws.
import { createHash } from "node:crypto";
import { COUNTED_CATALOG, type InstallReport } from "./stats.js";

export const REQUEST_TIMEOUT_MS = 5_000;
/** Refuse challenges harder than this, so a misbehaving counter can't burn this server's CPU. */
export const MAX_DIFFICULTY = 22;
/** Hashes between yields, so solving never blocks hooks for more than a few milliseconds. */
const SLICE = 2_000;

export interface ReportOptions {
  counter?: string;
  fetchImpl?: typeof fetch;
  maxDifficulty?: number;
}

/** Report one install. Resolves true when the counter accepted it, false on any failure. */
export async function sendInstallReport(body: InstallReport, options: ReportOptions = {}): Promise<boolean> {
  const counter = options.counter ?? COUNTED_CATALOG.counter;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const challengeUrl = new URL(`${counter.replace(/\/$/, "")}/challenge`);
    challengeUrl.searchParams.set("template", body.template);
    const issued = await fetchImpl(challengeUrl, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "user-agent": "bb-plugin-hooks" } });
    if (!issued.ok) return false;
    const { token, difficulty } = (await issued.json()) as { token?: unknown; difficulty?: unknown };
    if (typeof token !== "string" || token.length > 512 || typeof difficulty !== "number" || !Number.isInteger(difficulty) || difficulty < 0) return false;
    if (difficulty > (options.maxDifficulty ?? MAX_DIFFICULTY)) return false;
    const nonce = await solveChallenge(token, difficulty);
    const response = await fetchImpl(counter, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "bb-plugin-hooks" },
      body: JSON.stringify({ ...body, token, nonce }),
      // Redirects could carry the report somewhere the plugin didn't choose.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Find a nonce whose SHA-256 of `<token>.<nonce>` starts with `difficulty` zero bits. */
export async function solveChallenge(token: string, difficulty: number): Promise<number> {
  for (let nonce = 0; ; nonce += 1) {
    if (leadingZeroBits(createHash("sha256").update(`${token}.${nonce}`).digest()) >= difficulty) return nonce;
    if (nonce % SLICE === SLICE - 1) await new Promise((resolve) => setImmediate(resolve));
  }
}

export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}
