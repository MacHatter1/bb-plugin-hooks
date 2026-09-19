// Placeholder rendering shared by webhook bodies and the template catalog.
//
// `{{a.b.c}}` reads a path from a JSON payload. Strings are inserted as
// JSON-escaped string *contents* (no surrounding quotes), so write
// `"{{thread.title}}"` inside a JSON template; everything else is inserted
// as its JSON text. `{{path|200}}` truncates to 200 characters first.

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*(?:\|\s*(\d+)\s*)?\}\}/g;

export function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function jsonStringContents(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/** Render a JSON body template against an event payload. */
export function renderBody(template: string, payload: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_match, path: string, limit: string | undefined) => {
    const value = readPath(payload, path);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") {
      const text = limit === undefined ? value : truncate(value, Number(limit));
      return jsonStringContents(text);
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    const json = JSON.stringify(value);
    return limit === undefined ? json : jsonStringContents(truncate(json, Number(limit)));
  });
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/** Single-quote a value for POSIX sh. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Substitute `{{key}}` with caller-supplied text (already escaped as needed). */
export function fillPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (match, key: string) => (key in values ? values[key]! : match));
}

export function listPlaceholders(template: string): string[] {
  const keys = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) keys.add(match[1]!);
  return [...keys];
}
