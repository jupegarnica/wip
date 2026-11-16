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
import { dirname, join } from "node:path";
import { flowOfKey, TEMPLATES } from "../../src/embedded/templates.ts";
import { EXIT, WipError } from "../../src/errors.ts";
import {
  applyDefs,
  defsDrift,
  defsTemplates,
  type IDefsDrift,
  installedFlows,
} from "../../src/init/drift.ts";
import { scratch } from "../helpers/project.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = scratch(`defs-drift-${name}`);
  dirs.push(dir);
  return dir;
}

function write(root: string, key: string, text: string): void {
  const file = join(root, key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function writeTemplates(root: string, keys: readonly string[] = Object.keys(TEMPLATES)): void {
  for (const key of keys) write(root, key, TEMPLATES[key] as string);
}

function kindOf(drift: IDefsDrift, key: string): string | undefined {
  return drift.entries.find((entry) => entry.key === key)?.kind;
}

function pathOf(drift: IDefsDrift, key: string): string | undefined {
  return drift.entries.find((entry) => entry.key === key)?.path;
}

const NON_FLOW = Object.keys(TEMPLATES).filter((key) => flowOfKey(key) === null);
const TASKS = Object.keys(TEMPLATES).filter((key) => flowOfKey(key) === "tasks");

describe("defsDrift", () => {
  test("a folder holding every template is current", () => {
    const root = tmp("current");
    writeTemplates(root);
    const drift = defsDrift(".claude", ".claude", root);
    expect(drift.entries).toEqual([]);
    expect(drift.kept).toEqual([]);
    expect(drift.templates).toEqual(TEMPLATES);
    expect(drift).toMatchObject({ dir: ".claude", path: ".claude", root });
  });

  test("a body edit is changed and a deleted template is missing, with shown paths", () => {
    const root = tmp("changed-missing");
    writeTemplates(root);
    write(root, "agents/efficient.md", `${TEMPLATES["agents/efficient.md"]}\nedited\n`);
    rmSync(join(root, "agents/fast.md"));
    const drift = defsDrift(".claude", ".claude", root);
    expect(kindOf(drift, "agents/efficient.md")).toBe("changed");
    expect(kindOf(drift, "agents/fast.md")).toBe("missing");
    expect(pathOf(drift, "agents/efficient.md")).toBe(".claude/agents/efficient.md");
    expect(pathOf(drift, "agents/fast.md")).toBe(".claude/agents/fast.md");
  });

  test("a model-only edit is current, because --force keeps the model line", () => {
    const root = tmp("model");
    writeTemplates(root);
    const thinker = TEMPLATES["agents/thinker.md"] as string;
    const sonnet = thinker.replace(/^model: .*$/m, "model: sonnet");
    expect(sonnet).not.toBe(thinker);
    write(root, "agents/thinker.md", sonnet);
    expect(defsDrift(".claude", ".claude", root).entries).toEqual([]);
    write(root, "agents/thinker.md", `${sonnet}\nedited\n`);
    expect(kindOf(defsDrift(".claude", ".claude", root), "agents/thinker.md")).toBe("changed");
  });

  test("a file without a wip: mark, a directory and a symlink at a template path are foreign", () => {
    const root = tmp("foreign");
    writeTemplates(root);
    write(root, "agents/fast.md", "plain\n");
    rmSync(join(root, "agents/wise.md"));
    mkdirSync(join(root, "agents/wise.md"));
    rmSync(join(root, "agents/efficient.md"));
    symlinkSync("thinker.md", join(root, "agents/efficient.md"));
    const drift = defsDrift(".claude", ".claude", root);
    for (const key of ["agents/fast.md", "agents/wise.md", "agents/efficient.md"]) {
      expect(kindOf(drift, key)).toBe("foreign");
    }
  });

  test("a custom agent and a custom skill are kept, never entries", () => {
    const root = tmp("kept");
    writeTemplates(root);
    write(root, "agents/custom.md", "---\nname: custom\n---\n");
    write(root, "skills/my-skill/SKILL.md", "---\nname: my-skill\n---\n");
    const drift = defsDrift(".claude", ".claude", root);
    expect(drift.entries).toEqual([]);
    expect(drift.kept).toEqual([".claude/agents/custom.md", ".claude/skills/my-skill/SKILL.md"]);
  });

  test("only the installed flow folders are in scope", () => {
    const root = tmp("scope-tasks");
    writeTemplates(root, [...NON_FLOW, ...TASKS]);
    expect(installedFlows(root)).toEqual(["tasks"]);
    const keys = Object.keys(defsTemplates(root));
    expect(keys.some((key) => key.startsWith("skills/wip-flow-development/"))).toBe(false);
    expect(keys).toContain("skills/wip-flow-tasks/guide.md");
    expect(defsDrift(".claude", ".claude", root).entries).toEqual([]);

    const wiped = tmp("scope-wiped");
    writeTemplates(wiped, NON_FLOW);
    expect(installedFlows(wiped)).toEqual(["development", "ideas", "reports", "tasks"]);
    expect(
      defsDrift(".claude", ".claude", wiped).entries.some(
        (entry) => entry.key === "skills/wip-flow-development/SKILL.md" && entry.kind === "missing",
      ),
    ).toBe(true);

    const custom = tmp("scope-custom");
    writeTemplates(custom, NON_FLOW);
    write(custom, "skills/wip-flow-custom/SKILL.md", "---\nname: custom\n---\n");
    expect(installedFlows(custom)).toEqual([]);
    expect(
      Object.keys(defsTemplates(custom)).some((key) => key.startsWith("skills/wip-flow-")),
    ).toBe(false);
    expect(defsDrift(".claude", ".claude", custom).entries).toEqual([]);
  });

  test("a partially deleted flow reports its missing SKILL.md", () => {
    const root = tmp("partial-flow");
    writeTemplates(root, NON_FLOW);
    write(
      root,
      "skills/wip-flow-tasks/guide.md",
      TEMPLATES["skills/wip-flow-tasks/guide.md"] as string,
    );
    const drift = defsDrift(".claude", ".claude", root);
    expect(kindOf(drift, "skills/wip-flow-tasks/SKILL.md")).toBe("missing");
    expect(kindOf(drift, "skills/wip-flow-tasks/guide.md")).toBeUndefined();
  });
});

describe("applyDefs", () => {
  test("writes the changed and missing files with backups, keeps custom definitions and is idempotent", () => {
    const project = tmp("apply");
    const root = join(project, ".claude");
    writeTemplates(root);
    write(root, "agents/fast.md", `${TEMPLATES["agents/fast.md"]}\nedited\n`);
    rmSync(join(root, "agents/efficient.md"));
    write(root, "agents/custom.md", "---\nname: custom\n---\n");

    const stamp = "20260101T000000Z";
    const done = applyDefs(project, {}, { stamp });
    expect(done.files.map((file) => [file.path, file.action])).toEqual([
      [".claude/agents/efficient.md", "created"],
      [".claude/agents/fast.md", "replaced"],
    ]);
    expect(readFileSync(join(root, "agents/efficient.md"), "utf8")).toBe(
      TEMPLATES["agents/efficient.md"] as string,
    );
    expect(readFileSync(join(root, "agents/fast.md"), "utf8")).toBe(
      TEMPLATES["agents/fast.md"] as string,
    );
    const backup = join(project, ".wip", "backups", "defs", "agents", `fast.md.${stamp}`);
    expect(readFileSync(backup, "utf8")).toContain("edited");
    expect(readFileSync(join(root, "agents/custom.md"), "utf8")).toContain("custom");

    const again = applyDefs(project, {}, { stamp: "20260102T000000Z" });
    expect(again.files).toEqual([]);
    expect(readdirSync(join(project, ".wip", "backups", "defs", "agents"))).toEqual([
      `fast.md.${stamp}`,
    ]);
  });

  test("a foreign file refuses the whole run with exit 3 and writes nothing", () => {
    const project = tmp("apply-foreign");
    const root = join(project, ".claude");
    writeTemplates(root);
    write(root, "agents/fast.md", `${TEMPLATES["agents/fast.md"]}\nedited\n`);
    write(root, "agents/thinker.md", "plain\n");

    let error: WipError | null = null;
    try {
      applyDefs(project, {}, { stamp: "20260101T000000Z" });
    } catch (err) {
      error = err as WipError;
    }
    expect(error).toBeInstanceOf(WipError);
    expect(error?.code).toBe(EXIT.REJECTED);
    expect(error?.message).toContain("nothing written");
    expect(error?.message).toContain("without a `wip:` mark");
    expect(error?.message).toContain(".claude/agents/thinker.md");
    expect(readFileSync(join(root, "agents/fast.md"), "utf8")).toContain("edited");
    expect(readFileSync(join(root, "agents/thinker.md"), "utf8")).toBe("plain\n");
    expect(existsSync(join(project, ".wip", "backups", "defs"))).toBe(false);
  });

  test("a directory at a template path refuses with its own wording", () => {
    const project = tmp("apply-directory");
    const root = join(project, ".claude");
    writeTemplates(root);
    rmSync(join(root, "agents/wise.md"));
    mkdirSync(join(root, "agents/wise.md"));
    expect(() => applyDefs(project, {}, { stamp: "20260101T000000Z" })).toThrow(
      "is not a regular file (no `wip:` mark)",
    );
  });

  test("a ~/.claude folder resolves from HOME, applies and shows the absolute path", () => {
    const project = tmp("global");
    const home = tmp("global-home");
    mkdirSync(join(project, ".wip"), { recursive: true });
    writeFileSync(
      join(project, ".wip", "config.json"),
      `${JSON.stringify({ defs_dir: "~/.claude" }, null, 2)}\n`,
    );
    const root = join(home, ".claude");
    writeTemplates(root);
    write(root, "agents/fast.md", `${TEMPLATES["agents/fast.md"]}\nedited\n`);

    const done = applyDefs(project, { HOME: home }, { stamp: "20260101T000000Z" });
    expect(done.drift.dir).toBe("~/.claude");
    expect(done.drift.path).toBe(root);
    expect(done.files.map((file) => file.path)).toEqual([join(root, "agents/fast.md")]);
    expect(readFileSync(join(root, "agents/fast.md"), "utf8")).toBe(
      TEMPLATES["agents/fast.md"] as string,
    );
    expect(
      existsSync(join(project, ".wip", "backups", "defs", "agents", "fast.md.20260101T000000Z")),
    ).toBe(true);
  });
});
