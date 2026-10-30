import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { MIGRATIONS } from "../../src/embedded/migrations.ts";
import { TEMPLATES } from "../../src/embedded/templates.ts";
import { MARKDOWN_LIB, MARKDOWN_PACKAGE, WEB } from "../../src/embedded/web.ts";

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

  test("every file under web/ is in the manifest, with its text as it is on disk", () => {
    expect(Object.keys(WEB).sort()).toEqual(keys(join(REPO, "web")));
    for (const [key, text] of Object.entries(WEB)) {
      expect(text).toBe(readFileSync(join(REPO, "web", key), "utf8"));
    }
  });

  test("@garndev/markdown is the exact 0.3.1 devDependency, and the manifest is closed under its imports", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.devDependencies[MARKDOWN_PACKAGE]).toBe("0.3.1");
    expect(pkg.dependencies).toBeUndefined();
    const dir = join(REPO, "node_modules", "@garndev", "markdown");
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("0.3.1");
    for (const [key, text] of Object.entries(MARKDOWN_LIB)) {
      expect(text).toBe(readFileSync(join(dir, key), "utf8"));
      for (const m of text.matchAll(/from\s+'\.\/([a-z-]+\.js)'/g)) {
        expect({ key, imports: `dist/${m[1]}` in MARKDOWN_LIB }).toEqual({ key, imports: true });
      }
    }
  });
});
