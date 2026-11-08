import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/errors.ts";
import {
  applySettings,
  fileKind,
  KANBAN_PLUGIN_ID,
  readEntry,
  readSettings,
  SETTINGS_FILES,
  scopeOf,
  settingsAbs,
  settingsRel,
} from "../../src/init/claude-settings.ts";
import { scratch } from "../helpers/project.ts";

const STAMP = "26-11-07-10-00";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const dir = scratch("claude-settings");
  dirs.push(dir);
  return dir;
}

function write(dir: string, file: string, text: string): void {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(settingsAbs(dir, file as "settings.json"), text);
}

const read = (dir: string, file: string): string =>
  readFileSync(settingsAbs(dir, file as "settings.json"), "utf8");

describe("the settings editor (claude-settings)", () => {
  test("scopeOf and the paths of the two files", () => {
    expect(SETTINGS_FILES).toEqual(["settings.json", "settings.local.json"]);
    expect(scopeOf("settings.json")).toBe("project");
    expect(scopeOf("settings.local.json")).toBe("local");
    expect(settingsRel("settings.json")).toBe(".claude/settings.json");
    expect(settingsRel("settings.local.json")).toBe(".claude/settings.local.json");
    expect(settingsAbs("/p", "settings.local.json")).toBe("/p/.claude/settings.local.json");
    expect(KANBAN_PLUGIN_ID).toBe("wip-kanban@skills-dir");
  });

  for (const file of SETTINGS_FILES) {
    test(`${file}: a missing file is created with $schema and the entry`, () => {
      const dir = project();
      const result = applySettings(dir, file, { stamp: STAMP });
      expect(result).toEqual({ action: "created", backup: null });
      expect(JSON.parse(read(dir, file))).toEqual({
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        enabledPlugins: { [KANBAN_PLUGIN_ID]: true },
      });
      expect(read(dir, file).endsWith("\n")).toBe(true);
      // The other file of the pair is never touched.
      const other = file === "settings.json" ? "settings.local.json" : "settings.json";
      expect(existsSync(settingsAbs(dir, other))).toBe(false);
    });
  }

  test("an existing file keeps every key, its order and its other plugins; $schema is not injected", () => {
    const dir = project();
    const before = `{
  "permissions": { "allow": ["Bash"] },
  "enabledPlugins": { "other@market": true },
  "env": { "A": "1" }
}
`;
    write(dir, "settings.json", before);
    const result = applySettings(dir, "settings.json", { stamp: STAMP });
    expect(result.action).toBe("added");
    const after = JSON.parse(read(dir, "settings.json"));
    expect(after).toEqual({
      permissions: { allow: ["Bash"] },
      enabledPlugins: { "other@market": true, [KANBAN_PLUGIN_ID]: true },
      env: { A: "1" },
    });
    expect(Object.keys(after)).toEqual(["permissions", "enabledPlugins", "env"]);
    expect(read(dir, "settings.json")).not.toContain("$schema");
    expect(read(dir, "settings.json")).toBe(`${JSON.stringify(after, null, 2)}\n`);
  });

  test("enabledPlugins absent is added at the end; false becomes true with a backup of the old text", () => {
    const dir = project();
    const before = `{
  "permissions": {}
}
`;
    write(dir, "settings.json", before);
    expect(applySettings(dir, "settings.json", { stamp: STAMP }).action).toBe("added");
    const added = JSON.parse(read(dir, "settings.json"));
    expect(Object.keys(added)).toEqual(["permissions", "enabledPlugins"]);

    write(
      dir,
      "settings.local.json",
      `${JSON.stringify({ enabledPlugins: { [KANBAN_PLUGIN_ID]: false } }, null, 2)}\n`,
    );
    const previous = read(dir, "settings.local.json");
    const result = applySettings(dir, "settings.local.json", { stamp: STAMP });
    expect(result).toEqual({
      action: "updated",
      backup: `.wip/backups/claude-settings/settings.local.json.${STAMP}`,
    });
    expect(readFileSync(join(dir, result.backup as string), "utf8")).toBe(previous);
    expect(readEntry(settingsAbs(dir, "settings.local.json")).value).toBe(true);
  });

  test("true is exists: no bytes, no backup, also on a second run", () => {
    const dir = project();
    applySettings(dir, "settings.json", { stamp: STAMP });
    const before = read(dir, "settings.json");
    const tree = existsSync(join(dir, ".wip"))
      ? readdirSync(join(dir, ".wip"), { recursive: true }).map(String).sort()
      : [];
    expect(applySettings(dir, "settings.json", { stamp: STAMP })).toEqual({
      action: "exists",
      backup: null,
    });
    expect(read(dir, "settings.json")).toBe(before);
    expect(
      existsSync(join(dir, ".wip"))
        ? readdirSync(join(dir, ".wip"), { recursive: true }).map(String).sort()
        : [],
    ).toEqual(tree);
  });

  test("two backups of the same stamp do not overwrite each other", () => {
    const dir = project();
    write(
      dir,
      "settings.json",
      `${JSON.stringify({ enabledPlugins: { [KANBAN_PLUGIN_ID]: false } })}\n`,
    );
    const first = applySettings(dir, "settings.json", { stamp: STAMP });
    write(
      dir,
      "settings.json",
      `${JSON.stringify({ enabledPlugins: { [KANBAN_PLUGIN_ID]: false } })}\n`,
    );
    const second = applySettings(dir, "settings.json", { stamp: STAMP });
    expect(first.backup).not.toBe(second.backup);
    expect(second.backup).toBe(`.wip/backups/claude-settings/settings.json.${STAMP}-2`);
  });

  test("invalid JSON, a non-object, a non-object enabledPlugins or a non-boolean value are rejected, writing nothing", () => {
    const cases: [string, string][] = [
      ["{oops", "is not valid JSON"],
      ["[]", "is not a JSON object"],
      [`{"enabledPlugins": []}`, "enabledPlugins in .claude/settings.json is not an object"],
      [
        `{"enabledPlugins": {"${KANBAN_PLUGIN_ID}": "yes"}}`,
        `enabledPlugins["${KANBAN_PLUGIN_ID}"] in .claude/settings.json is not a boolean`,
      ],
    ];
    for (const [text, message] of cases) {
      const dir = project();
      write(dir, "settings.json", text);
      let code: number = EXIT.OK;
      let thrown = "";
      try {
        applySettings(dir, "settings.json", { stamp: STAMP });
      } catch (err) {
        code = (err as { code: number }).code;
        thrown = (err as Error).message;
      }
      expect({ text, code }).toEqual({ text, code: EXIT.REJECTED });
      expect(thrown).toContain(message);
      expect(read(dir, "settings.json")).toBe(text);
      expect(existsSync(join(dir, ".wip"))).toBe(false);
    }
  });

  test("a directory or a symbolic link at the file's path is not a regular file", () => {
    const dir = project();
    mkdirSync(join(dir, ".claude", "settings.json"), { recursive: true });
    expect(fileKind(settingsAbs(dir, "settings.json"))).toBe("not-file");
    expect(readEntry(settingsAbs(dir, "settings.json"))).toMatchObject({ state: "not-file" });
    expect(() => applySettings(dir, "settings.json", { stamp: STAMP })).toThrow(
      "is not a regular file",
    );

    const link = project();
    mkdirSync(join(link, ".claude"), { recursive: true });
    writeFileSync(join(link, "target.json"), "{}");
    symlinkSync(join(link, "target.json"), join(link, ".claude", "settings.json"));
    expect(readEntry(settingsAbs(link, "settings.json")).state).toBe("not-file");
    expect(() => applySettings(link, "settings.json", { stamp: STAMP })).toThrow(
      "is not a regular file",
    );
  });

  test("no temporary file is left behind", () => {
    const dir = project();
    applySettings(dir, "settings.json", { stamp: STAMP });
    expect(readdirSync(join(dir, ".claude"))).toEqual(["settings.json"]);
  });

  test("readEntry: missing, ok true, ok false, missing id, invalid JSON and not-file", () => {
    const dir = project();
    const file = settingsAbs(dir, "settings.json");
    expect(readEntry(file)).toEqual({ state: "missing", value: null, problem: null });
    write(dir, "settings.json", `{"enabledPlugins": {"${KANBAN_PLUGIN_ID}": true}}`);
    expect(readEntry(file)).toEqual({ state: "ok", value: true, problem: null });
    write(dir, "settings.json", `{"enabledPlugins": {"${KANBAN_PLUGIN_ID}": false}}`);
    expect(readEntry(file)).toEqual({ state: "ok", value: false, problem: null });
    write(dir, "settings.json", `{"enabledPlugins": {"other@m": true}}`);
    expect(readEntry(file)).toEqual({ state: "missing", value: null, problem: null });
    write(dir, "settings.json", `{"permissions": {}}`);
    expect(readEntry(file)).toEqual({ state: "missing", value: null, problem: null });
    write(dir, "settings.json", "{oops");
    expect(readEntry(file).state).toBe("invalid");
    expect(readEntry(file).problem).toContain("is not valid JSON");
  });

  test("readSettings reports the file, its shown path and the entry, for both basenames", () => {
    const dir = project();
    write(dir, "settings.local.json", `{"enabledPlugins": {"${KANBAN_PLUGIN_ID}": true}}`);
    const json = readSettings(dir, "settings.json");
    const local = readSettings(dir, "settings.local.json");
    expect(json).toMatchObject({ file: "settings.json", path: ".claude/settings.json" });
    expect(json.entry.state).toBe("missing");
    expect(local.entry).toEqual({ state: "ok", value: true, problem: null });
  });
});
