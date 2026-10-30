import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { MIGRATIONS } from "../../src/embedded/migrations.ts";
import { TEMPLATES } from "../../src/embedded/templates.ts";

const REPO = join(import.meta.dir, "..", "..");

function tree(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? tree(path) : [path];
  });
}

function keys(dir: string): string[] {
  return tree(dir)
    .map((file) => relative(dir, file).split(sep).join("/"))
    .sort();
}

describe("embedded files (D15)", () => {
  test("every file under templates/ is in the manifest, and nothing else", () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(keys(join(REPO, "templates")));
  });

  test("the manifest carries each template's text as it is on disk", () => {
    for (const [key, text] of Object.entries(TEMPLATES)) {
      expect(text).toBe(readFileSync(join(REPO, "templates", key), "utf8"));
    }
  });

  test("every migration under src/migrations/ is in the manifest, in order", () => {
    expect(MIGRATIONS.map(([name]) => name)).toEqual(keys(join(REPO, "src", "migrations")));
  });
});
