// Encrypted secrets for hooks. Values are AES-256-GCM encrypted with a key
// kept in the plugin's secret settings store (0600 file, never sent to the
// frontend), and referenced from hooks as `{{secret:NAME}}` so a hook
// definition never contains a credential.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { HookDefinition } from "./definitions.js";

export const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/;
export const SECRET_PLACEHOLDER = /\{\{\s*secret:([A-Za-z0-9][A-Za-z0-9_./-]*)\s*\}\}/g;

export function secretPlaceholder(name: string): string {
  return `{{secret:${name}}}`;
}

export function listSecretRefs(text: string | undefined): string[] {
  if (text === undefined) return [];
  const names = new Set<string>();
  for (const match of text.matchAll(SECRET_PLACEHOLDER)) names.add(match[1]!);
  return [...names];
}

/** Every secret a hook references in its command, url, headers or body. */
export function hookSecretRefs(hook: Pick<HookDefinition, "command" | "url" | "headers" | "body">): string[] {
  const names = new Set<string>();
  for (const text of [hook.command, hook.url, hook.body, ...Object.values(hook.headers ?? {})]) {
    for (const name of listSecretRefs(text)) names.add(name);
  }
  return [...names];
}

export function referencedSecrets(hooks: readonly HookDefinition[]): Set<string> {
  const names = new Set<string>();
  for (const hook of hooks) for (const name of hookSecretRefs(hook)) names.add(name);
  return names;
}

/** Environment variable a command hook reads a secret from. */
export function envNameFor(name: string): string {
  return `BB_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export function generateKey(): string {
  return randomBytes(32).toString("hex");
}

export function encrypt(keyHex: string, plain: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("secrets key must be 32 bytes of hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function decrypt(keyHex: string, blob: string): string {
  const key = Buffer.from(keyHex, "hex");
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export const SECRET_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    managed INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
];

export interface SecretInfo {
  name: string;
  /** Created by `bb hooks use` for a template parameter; removed with its hooks. */
  managed: boolean;
  updatedAt: number;
}

export interface SecretStore {
  list(): SecretInfo[];
  has(name: string): boolean;
  get(name: string): string | undefined;
  set(name: string, value: string, options?: { managed?: boolean }): void;
  remove(name: string): boolean;
  /** Delete managed secrets no hook references any more; returns their names. */
  gcManaged(referenced: Set<string>): string[];
}

interface Row {
  name: string;
  value: string;
  managed: number;
  updated_at: number;
}

export function createSecretStore(db: Database.Database, keyHex: string): SecretStore {
  const selectAll = db.prepare(`SELECT name, managed, updated_at FROM secrets ORDER BY name`);
  const selectOne = db.prepare(`SELECT * FROM secrets WHERE name = ?`);
  const upsert = db.prepare(
    `INSERT INTO secrets (name, value, managed, updated_at) VALUES (@name, @value, @managed, @updatedAt)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, managed = excluded.managed, updated_at = excluded.updated_at`,
  );
  const del = db.prepare(`DELETE FROM secrets WHERE name = ?`);
  return {
    list: () => (selectAll.all() as Omit<Row, "value">[]).map((row) => ({ name: row.name, managed: row.managed === 1, updatedAt: row.updated_at })),
    has: (name) => selectOne.get(name) !== undefined,
    get(name) {
      const row = selectOne.get(name) as Row | undefined;
      if (row === undefined) return undefined;
      return decrypt(keyHex, row.value);
    },
    set(name, value, options = {}) {
      if (!SECRET_NAME_PATTERN.test(name)) throw new Error(`invalid secret name "${name}": use letters, digits, ., _, / and - (max 128)`);
      const existing = selectOne.get(name) as Row | undefined;
      upsert.run({ name, value: encrypt(keyHex, value), managed: (options.managed ?? existing?.managed === 1) ? 1 : 0, updatedAt: Date.now() });
    },
    remove: (name) => Number(del.run(name).changes) > 0,
    gcManaged(referenced) {
      const removed: string[] = [];
      for (const row of selectAll.all() as Omit<Row, "value">[]) {
        if (row.managed === 1 && !referenced.has(row.name)) {
          del.run(row.name);
          removed.push(row.name);
        }
      }
      return removed;
    },
  };
}
