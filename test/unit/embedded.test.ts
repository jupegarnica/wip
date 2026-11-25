import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { KANBAN_MOD } from "../../src/embedded/kanban.ts";
import { MIGRATIONS } from "../../src/embedded/migrations.ts";
import { QUIET_MOD } from "../../src/embedded/quiet.ts";
import { TEMPLATES } from "../../src/embedded/templates.ts";
import { WEB } from "../../src/embedded/web.ts";

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

  test("KANBAN_MOD holds exactly the eight distributable files, with their text as on disk", () => {
    const dir = join(REPO, "mods", "wip-kanban");
    expect(Object.keys(KANBAN_MOD).sort()).toEqual([
      ".claude-plugin/plugin.json",
      ".claude-plugin/wip.json",
      "LICENSE",
      "README.md",
      "hooks/hooks.json",
      "hooks/register.tsx",
      "tsconfig.json",
      "types/index.d.ts",
    ]);
    for (const [key, text] of Object.entries(KANBAN_MOD)) {
      expect(text).toBe(readFileSync(join(dir, key), "utf8"));
    }
    expect(Object.keys(KANBAN_MOD).some((key) => key.endsWith(".test.tsx"))).toBe(false);
    expect(Object.keys(KANBAN_MOD).some((key) => key.startsWith(".claude-plugin/types/"))).toBe(
      false,
    );
    expect(JSON.parse(KANBAN_MOD[".claude-plugin/wip.json"] as string)).toEqual({
      format: 1,
      owner: "@garndev/wip",
      plugin: "wip-kanban",
    });
  });

  test("QUIET_MOD holds exactly the ten distributable files, with their text as on disk", () => {
    const dir = join(REPO, "mods", "wip-quiet");
    expect(Object.keys(QUIET_MOD).sort()).toEqual([
      ".claude-plugin/plugin.json",
      ".claude-plugin/wip.json",
      "LICENSE",
      "README.md",
      "hooks/classify.ts",
      "hooks/hooks.json",
      "hooks/register.tsx",
      "hooks/timestamps.ts",
      "tsconfig.json",
      "types/index.d.ts",
    ]);
    for (const [key, text] of Object.entries(QUIET_MOD)) {
      expect(text).toBe(readFileSync(join(dir, key), "utf8"));
    }
    expect(Object.keys(QUIET_MOD).some((key) => key.startsWith("tests/"))).toBe(false);
    expect(Object.keys(QUIET_MOD).some((key) => key.endsWith(".test.tsx"))).toBe(false);
    expect(Object.keys(QUIET_MOD).some((key) => key.startsWith(".claude-plugin/types/"))).toBe(
      false,
    );
    expect(JSON.parse(QUIET_MOD[".claude-plugin/wip.json"] as string)).toEqual({
      format: 1,
      owner: "@garndev/wip",
      plugin: "wip-quiet",
    });
  });

  test("marked is the exact 18.2.0 devDependency and the vendored bundle carries its version", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.devDependencies.marked).toBe("18.2.0");
    expect(pkg.devDependencies["@garndev/markdown"]).toBeUndefined();
    expect(pkg.dependencies).toBeUndefined();
    const marked = JSON.parse(
      readFileSync(join(REPO, "node_modules", "marked", "package.json"), "utf8"),
    );
    expect(marked.version).toBe("18.2.0");
    const vendor = WEB["vendor/markdown.js"] as string;
    expect(vendor.startsWith("/*!")).toBe(true);
    expect(vendor).toContain(`marked ${marked.version} (MIT`);
    expect(vendor).toContain("globalThis.WipMarkdown");
    expect(vendor).toContain("parseMarkdown");
  });
});
