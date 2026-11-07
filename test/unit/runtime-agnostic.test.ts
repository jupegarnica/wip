import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");

// Biome (noRestrictedImports, noRestrictedGlobals) and tsconfig.src.json catch most of this; `import.meta.main` and
// `import.meta.dir` are Bun extensions neither of them sees.
const BUN_ONLY = [
  /from\s+["']bun(:[\w-]+)?["']/,
  /\bBun\./,
  /import\.meta\.(main|dir|file|path)\b/,
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

test("src/ uses no Bun-only API, so the npm package runs on Node", () => {
  const found: string[] = [];
  for (const path of sources(SRC)) {
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (BUN_ONLY.some((re) => re.test(line)))
          found.push(`${relative(SRC, path)}:${i + 1}: ${line.trim()}`);
      });
  }
  expect(found).toEqual([]);
});
