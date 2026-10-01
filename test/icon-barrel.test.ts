import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("hugeicons barrel", () => {
  it("references icon files with the case stored on disk", () => {
    const root = dirname(require.resolve("@hugeicons/core-free-icons/package.json"));
    const esm = join(root, "dist/esm");
    const index = readFileSync(join(esm, "index.js"), "utf8");
    const files = new Set(readdirSync(esm));
    const refs: string[] = [];
    for (const match of index.matchAll(/from '\.\/([^']+)'/g)) {
      const name = match[1];
      if (name !== undefined) refs.push(name);
    }
    const missing = [...new Set(refs)].filter((name) => !files.has(name));
    expect(missing).toEqual([]);
  });
});
