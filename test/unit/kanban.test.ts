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
import { KANBAN_MOD } from "../../src/embedded/kanban.ts";
import { KANBAN_PLUGIN_ID, settingsAbs } from "../../src/init/claude-settings.ts";
import {
  copyState,
  KANBAN_BACKUPS,
  KANBAN_DIR,
  KanbanCopyFailed,
  kanbanAskDefaults,
  kanbanDefaults,
  kanbanPreflight,
  kanbanState,
  markProblem,
  syncKanban,
} from "../../src/init/kanban.ts";
import { scratch } from "../helpers/project.ts";

const STAMP = "26-11-07-10-00";
const COPY = join(KANBAN_DIR, ".claude-plugin", "wip.json");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const dir = scratch("kanban");
  dirs.push(dir);
  mkdirSync(join(dir, ".wip"), { recursive: true });
  return dir;
}

function writeSettings(dir: string, file: string, value: unknown): void {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    settingsAbs(dir, file as "settings.json"),
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function entry(value: boolean): Record<string, unknown> {
  return { enabledPlugins: { [KANBAN_PLUGIN_ID]: value } };
}

const textOf = (dir: string, key: string): string =>
  readFileSync(join(dir, KANBAN_DIR, key), "utf8");

describe("the mod copy (init/kanban)", () => {
  test("the manifest is the eight files the decision lists", () => {
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
  });

  test("the ownership mark is closed: exactly format 1, the owner and the plugin", () => {
    const good = KANBAN_MOD[".claude-plugin/wip.json"] as string;
    expect(markProblem(good)).toBeNull();
    expect(
      markProblem('{"format": 1, "owner": "@garndev/wip", "plugin": "wip-kanban", "x": 1}'),
    ).toContain("does not hold exactly");
    expect(markProblem('{"format": 2, "owner": "@garndev/wip", "plugin": "wip-kanban"}')).toContain(
      "is not wip's mark",
    );
    expect(markProblem("{oops")).toContain("not valid JSON");
    expect(markProblem("[]")).toContain("not a JSON object");
  });

  test("--kanban on a new project creates the copy with the embedded text", () => {
    const dir = project();
    const result = syncKanban(dir, { requested: true, force: false, stamp: STAMP });
    expect(result).toMatchObject({ action: "created", backup: null, removed: [], touched: true });
    for (const [key, text] of Object.entries(KANBAN_MOD)) expect(textOf(dir, key)).toBe(text);
    expect(copyState(dir).state).toBe("owned");
    expect(kanbanState(dir).copy).toBe("owned");
  });

  test("a second run says exists and changes no bytes", () => {
    const dir = project();
    syncKanban(dir, { requested: true, force: false, stamp: STAMP });
    const before = readFileSync(join(dir, COPY), "utf8");
    expect(syncKanban(dir, { requested: true, force: false, stamp: STAMP })).toMatchObject({
      action: "exists",
      touched: false,
    });
    expect(readFileSync(join(dir, COPY), "utf8")).toBe(before);
  });

  test("without --force it creates missing files, leaves differing ones and keeps extras", () => {
    const dir = project();
    syncKanban(dir, { requested: true, force: false, stamp: STAMP });
    writeFileSync(join(dir, KANBAN_DIR, "README.md"), "edited");
    rmSync(join(dir, KANBAN_DIR, "LICENSE"));
    writeFileSync(join(dir, KANBAN_DIR, "notas.txt"), "mine");
    const result = syncKanban(dir, { requested: true, force: false, stamp: STAMP });
    expect(result).toMatchObject({
      action: "updated",
      removed: [],
      differ: [`${KANBAN_DIR}/README.md`],
    });
    expect(textOf(dir, "README.md")).toBe("edited");
    expect(textOf(dir, "LICENSE")).toBe(KANBAN_MOD.LICENSE as string);
    expect(existsSync(join(dir, KANBAN_DIR, "notas.txt"))).toBe(true);
  });

  test("--force backs the whole folder up, restores managed files, removes extras and keeps the types", () => {
    const dir = project();
    syncKanban(dir, { requested: true, force: false, stamp: STAMP });
    writeFileSync(join(dir, KANBAN_DIR, "README.md"), "edited");
    writeFileSync(join(dir, KANBAN_DIR, "notas.txt"), "mine");
    mkdirSync(join(dir, KANBAN_DIR, ".claude-plugin", "types"), { recursive: true });
    writeFileSync(join(dir, KANBAN_DIR, ".claude-plugin", "types", "index.d.ts"), "generated");

    const result = syncKanban(dir, { requested: true, force: true, stamp: STAMP });
    expect(result?.action).toBe("replaced");
    expect(result?.removed).toEqual([`${KANBAN_DIR}/notas.txt`]);
    expect(result?.backup).toBe(`${KANBAN_BACKUPS}/wip-kanban.${STAMP}`);
    expect(textOf(dir, "README.md")).toBe(KANBAN_MOD["README.md"] as string);
    expect(existsSync(join(dir, KANBAN_DIR, "notas.txt"))).toBe(false);
    expect(
      readFileSync(join(dir, KANBAN_DIR, ".claude-plugin", "types", "index.d.ts"), "utf8"),
    ).toBe("generated");
    expect(readFileSync(join(dir, result?.backup as string, "notas.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(dir, result?.backup as string, "README.md"), "utf8")).toBe("edited");
  });

  test("a second --force with the same state says exists and adds no backup", () => {
    const dir = project();
    syncKanban(dir, { requested: true, force: false, stamp: STAMP });
    writeFileSync(join(dir, KANBAN_DIR, "README.md"), "edited");
    expect(syncKanban(dir, { requested: true, force: true, stamp: STAMP })?.action).toBe(
      "replaced",
    );
    const backups = readdirSync(join(dir, KANBAN_BACKUPS));
    expect(backups).toHaveLength(1);
    expect(syncKanban(dir, { requested: true, force: true, stamp: STAMP })).toMatchObject({
      action: "exists",
      backup: null,
    });
    expect(readdirSync(join(dir, KANBAN_BACKUPS))).toEqual(backups);

    // A force with nothing to do on an untouched copy creates no backup either.
    const clean = project();
    syncKanban(clean, { requested: true, force: false, stamp: STAMP });
    expect(syncKanban(clean, { requested: true, force: true, stamp: STAMP })?.action).toBe(
      "exists",
    );
    expect(existsSync(join(clean, KANBAN_BACKUPS))).toBe(false);
  });

  test("a backup whose stamp is taken gets -2", () => {
    const dir = project();
    syncKanban(dir, { requested: true, force: false, stamp: STAMP });
    writeFileSync(join(dir, KANBAN_DIR, "README.md"), "edited");
    expect(syncKanban(dir, { requested: true, force: true, stamp: STAMP })?.backup).toBe(
      `${KANBAN_BACKUPS}/wip-kanban.${STAMP}`,
    );
    writeFileSync(join(dir, KANBAN_DIR, "notas.txt"), "again");
    const result = syncKanban(dir, { requested: true, force: true, stamp: STAMP });
    expect(result?.backup).toBe(`${KANBAN_BACKUPS}/wip-kanban.${STAMP}-2`);
  });

  test("--force without --kanban refreshes an owned copy and does nothing without one", () => {
    const dir = project();
    syncKanban(dir, { requested: true, force: false, stamp: STAMP });
    writeFileSync(join(dir, KANBAN_DIR, "README.md"), "edited");
    const result = syncKanban(dir, { requested: false, force: true, stamp: STAMP });
    expect(result?.action).toBe("replaced");
    expect(textOf(dir, "README.md")).toBe(KANBAN_MOD["README.md"] as string);

    const other = project();
    expect(syncKanban(other, { requested: false, force: true, stamp: STAMP })).toBeNull();
    expect(existsSync(join(other, KANBAN_DIR))).toBe(false);
  });

  test("a foreign folder is refused with --kanban; a file or a symlink at the path too", () => {
    const foreign = project();
    mkdirSync(join(foreign, KANBAN_DIR, ".claude-plugin"), { recursive: true });
    writeFileSync(join(foreign, COPY), '{"format": 1, "owner": "someone", "plugin": "wip-kanban"}');
    const pre = kanbanPreflight(foreign, { requested: true, force: true });
    expect(pre.refusals).toHaveLength(1);
    expect(pre.refusals[0]).toContain("not wip's");
    expect(() => syncKanban(foreign, { requested: true, force: true, stamp: STAMP })).toThrow(
      KanbanCopyFailed,
    );
    // Without --kanban the foreign folder is left alone.
    const quiet = kanbanPreflight(foreign, { requested: false, force: false });
    expect(quiet.refusals).toEqual([]);
    expect(syncKanban(foreign, { requested: false, force: false, stamp: STAMP })).toBeNull();

    const file = project();
    mkdirSync(join(file, ".claude", "skills"), { recursive: true });
    writeFileSync(join(file, KANBAN_DIR), "not a folder");
    expect(kanbanPreflight(file, { requested: true, force: true }).refusals[0]).toContain(
      "is not a directory",
    );

    const link = project();
    mkdirSync(join(link, ".claude", "skills"), { recursive: true });
    mkdirSync(join(link, "elsewhere"));
    symlinkSync(join(link, "elsewhere"), join(link, KANBAN_DIR));
    expect(copyState(link).state).toBe("not-dir");
    expect(kanbanPreflight(link, { requested: true, force: true }).refusals[0]).toContain(
      "is not a directory",
    );
  });

  test("a managed path that is a directory needs --force", () => {
    const dir = project();
    syncKanban(dir, { requested: true, force: false, stamp: STAMP });
    rmSync(join(dir, KANBAN_DIR, "hooks", "hooks.json"));
    mkdirSync(join(dir, KANBAN_DIR, "hooks", "hooks.json"));
    const pre = kanbanPreflight(dir, { requested: true, force: false });
    expect(pre.refusals[0]).toContain(`${KANBAN_DIR}/hooks/hooks.json`);
    expect(kanbanPreflight(dir, { requested: true, force: true }).refusals).toEqual([]);
    expect(syncKanban(dir, { requested: true, force: true, stamp: STAMP })?.action).toBe(
      "replaced",
    );
    expect(textOf(dir, "hooks/hooks.json")).toBe(KANBAN_MOD["hooks/hooks.json"] as string);
  });

  test("the preflight refuses a chosen settings file that cannot take the entry", () => {
    for (const [text, message] of [
      ["{oops", "is not valid JSON"],
      [`{"enabledPlugins": []}`, "is not an object"],
      [`{"enabledPlugins": {"${KANBAN_PLUGIN_ID}": 1}}`, "is not a boolean"],
    ] as const) {
      const dir = project();
      writeSettings(dir, "settings.json", text);
      const pre = kanbanPreflight(dir, { requested: true, force: false, file: "settings.json" });
      expect(pre.refusals.join(" ")).toContain(".claude/settings.json");
      expect(pre.refusals.join(" ")).toContain(message);
      expect(copyState(dir).state).toBe("missing");
    }
    const dir = project();
    mkdirSync(join(dir, ".claude", "settings.local.json"), { recursive: true });
    const pre = kanbanPreflight(dir, {
      requested: true,
      force: false,
      file: "settings.local.json",
    });
    expect(pre.refusals[0]).toContain("not a regular file");
  });
});

describe("the state of the two settings files and the wizard defaults", () => {
  test("nothing on disk: yes, settings.json (a new project installs the mod)", () => {
    const state = kanbanState(project());
    expect(state.files["settings.json"].state).toBe("missing");
    expect(state.files["settings.local.json"].state).toBe("missing");
    expect(kanbanDefaults(state)).toMatchObject({ install: true, file: "settings.json" });
  });

  test("a complete copy defaults to yes with the file that holds the true entry", () => {
    const json = project();
    syncKanban(json, { requested: true, force: false, stamp: STAMP });
    writeSettings(json, "settings.json", entry(true));
    expect(kanbanDefaults(kanbanState(json))).toMatchObject({
      install: true,
      file: "settings.json",
    });

    const local = project();
    syncKanban(local, { requested: true, force: false, stamp: STAMP });
    writeSettings(local, "settings.local.json", entry(true));
    expect(kanbanDefaults(kanbanState(local))).toMatchObject({
      install: true,
      file: "settings.local.json",
    });

    const both = project();
    syncKanban(both, { requested: true, force: false, stamp: STAMP });
    writeSettings(both, "settings.json", entry(true));
    writeSettings(both, "settings.local.json", entry(true));
    const defaults = kanbanDefaults(kanbanState(both));
    expect(defaults).toMatchObject({ install: true, file: "settings.local.json" });
    expect(defaults.notes.join(" ")).toContain("wins over");
  });

  test("no entry defaults to yes; a disable to no; an orphan entry to yes; a conflict to no", () => {
    const noEntry = project();
    syncKanban(noEntry, { requested: true, force: false, stamp: STAMP });
    const noEntryDefaults = kanbanDefaults(kanbanState(noEntry));
    expect(noEntryDefaults).toMatchObject({ install: true, file: "settings.json" });
    expect(noEntryDefaults.notes.join(" ")).toContain("loads as wip-kanban@skills-dir");

    const disabled = project();
    syncKanban(disabled, { requested: true, force: false, stamp: STAMP });
    writeSettings(disabled, "settings.local.json", entry(false));
    const disabledDefaults = kanbanDefaults(kanbanState(disabled));
    expect(disabledDefaults).toMatchObject({ install: false, file: "settings.local.json" });
    expect(disabledDefaults.notes.join(" ")).toContain("re-enables it");

    const orphan = project();
    writeSettings(orphan, "settings.json", entry(true));
    const orphanDefaults = kanbanDefaults(kanbanState(orphan));
    expect(orphanDefaults).toMatchObject({ install: true, file: "settings.json" });
    expect(orphanDefaults.notes.join(" ")).toContain("choosing yes installs it");

    const orphanBoth = project();
    writeSettings(orphanBoth, "settings.json", entry(true));
    writeSettings(orphanBoth, "settings.local.json", entry(true));
    expect(kanbanDefaults(kanbanState(orphanBoth))).toMatchObject({
      install: true,
      file: "settings.local.json",
    });

    const foreign = project();
    mkdirSync(join(foreign, KANBAN_DIR, ".claude-plugin"), { recursive: true });
    writeFileSync(join(foreign, COPY), '{"format": 1, "owner": "someone", "plugin": "wip-kanban"}');
    const foreignDefaults = kanbanDefaults(kanbanState(foreign));
    expect(foreignDefaults).toMatchObject({ install: false, file: "settings.json" });
    expect(foreignDefaults.notes.join(" ")).toContain("is not wip's mark");
  });

  test("local wins over project: a local false disables, a local true enables", () => {
    const off = project();
    writeSettings(off, "settings.json", entry(true));
    writeSettings(off, "settings.local.json", entry(false));
    expect(kanbanDefaults(kanbanState(off))).toMatchObject({
      install: false,
      file: "settings.local.json",
    });

    const on = project();
    writeSettings(on, "settings.json", entry(false));
    writeSettings(on, "settings.local.json", entry(true));
    expect(kanbanDefaults(kanbanState(on))).toMatchObject({
      install: true,
      file: "settings.local.json",
    });

    const projectOff = project();
    writeSettings(projectOff, "settings.json", entry(false));
    const offDefaults = kanbanDefaults(kanbanState(projectOff));
    expect(offDefaults).toMatchObject({ install: false, file: "settings.json" });
    expect(offDefaults.notes.join(" ")).toContain("re-enables it");
  });

  test("one unreadable file sends the entry to the other; both unreadable default to no", () => {
    const dir = project();
    writeSettings(dir, "settings.json", "{oops");
    const defaults = kanbanDefaults(kanbanState(dir));
    expect(defaults).toMatchObject({ install: true, file: "settings.local.json" });
    expect(defaults.notes.join(" ")).toContain("unreadable");
    expect(defaults.notes.join(" ")).toContain("settings.local.json");

    const both = project();
    writeSettings(both, "settings.json", "{oops");
    writeSettings(both, "settings.local.json", "{oops");
    const bothDefaults = kanbanDefaults(kanbanState(both));
    expect(bothDefaults).toMatchObject({ install: false, file: "settings.json" });
    expect(bothDefaults.notes.join(" ")).toContain("exit 3");

    const other = project();
    writeSettings(other, "settings.json", entry(true));
    writeSettings(other, "settings.local.json", "{oops");
    const otherDefaults = kanbanDefaults(kanbanState(other));
    expect(otherDefaults).toMatchObject({ install: true, file: "settings.json" });
    expect(otherDefaults.notes.join(" ")).toContain("unreadable");
  });

  test("the preflight guard keeps yes only when init would accept the chosen file", () => {
    const dir = project();
    syncKanban(dir, { requested: true, force: false, stamp: STAMP });
    rmSync(join(dir, KANBAN_DIR, "hooks", "register.tsx"));
    mkdirSync(join(dir, KANBAN_DIR, "hooks", "register.tsx"));

    const guarded = kanbanAskDefaults(kanbanState(dir), dir, false);
    expect(guarded).toMatchObject({ install: false, file: "settings.json" });
    expect(guarded.notes.join(" ")).toContain("exit 3");
    expect(kanbanAskDefaults(kanbanState(dir), dir, true)).toMatchObject({
      install: true,
      file: "settings.json",
    });
  });
});

describe("the precedence warnings", () => {
  test("a false local entry overrides the project one, which is never edited", () => {
    const dir = project();
    writeSettings(dir, "settings.local.json", entry(false));
    const pre = kanbanPreflight(dir, { requested: true, force: false, file: "settings.json" });
    expect(pre.refusals).toEqual([]);
    expect(pre.warnings.map((w) => w.code)).toEqual(["kanban_settings_overridden"]);
    expect(pre.warnings[0]?.message).toContain(".claude/settings.local.json");
    expect(pre.warnings[0]?.message).toContain("--scope local");
  });

  test("a local true with a project false is a duplicate; a project true is not", () => {
    const dir = project();
    writeSettings(dir, "settings.json", entry(false));
    writeSettings(dir, "settings.local.json", entry(true));
    const pre = kanbanPreflight(dir, {
      requested: true,
      force: false,
      file: "settings.local.json",
    });
    expect(pre.warnings.map((w) => w.code)).toEqual(["kanban_settings_duplicate"]);
    expect(pre.warnings[0]?.message).toContain(".claude/settings.json");
    expect(pre.warnings[0]?.message).toContain("--scope project");

    const same = project();
    writeSettings(same, "settings.json", entry(true));
    writeSettings(same, "settings.local.json", entry(true));
    expect(
      kanbanPreflight(same, { requested: true, force: false, file: "settings.local.json" })
        .warnings,
    ).toEqual([]);
    writeSettings(same, "settings.local.json", entry(true));
    expect(
      kanbanPreflight(same, { requested: true, force: false, file: "settings.json" }).warnings,
    ).toEqual([]);
  });

  test("an unreadable other file only warns and does not block", () => {
    const dir = project();
    writeSettings(dir, "settings.local.json", "{oops");
    const pre = kanbanPreflight(dir, { requested: true, force: false, file: "settings.json" });
    expect(pre.refusals).toEqual([]);
    expect(pre.warnings.map((w) => w.code)).toEqual(["kanban_settings_unreadable"]);
    expect(pre.warnings[0]?.message).toContain(".claude/settings.local.json");
  });

  test("without --kanban it refuses and warns nothing", () => {
    const dir = project();
    writeSettings(dir, "settings.local.json", entry(false));
    const pre = kanbanPreflight(dir, { requested: false, force: false });
    expect(pre.refusals).toEqual([]);
    expect(pre.warnings).toEqual([]);
  });
});
