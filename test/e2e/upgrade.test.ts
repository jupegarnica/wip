import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KANBAN_MOD } from "../../src/embedded/kanban.ts";
import { TEMPLATES } from "../../src/embedded/templates.ts";
import { EXIT } from "../../src/errors.ts";
import { type IEnvelopeOut, WIP_BIN, wipIn, wipJsonIn } from "../helpers/bin.ts";
import { scratch } from "../helpers/project.ts";

const ID = "wip-kanban@skills-dir";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = scratch(`upgrade-${name}`);
  dirs.push(dir);
  return dir;
}

function withMod(name: string): string {
  const dir = tmp(name);
  const init = wipJsonIn(dir, ["init", "--yes", "--kanban"]);
  if (init.code !== EXIT.OK) throw new Error(`init failed: ${init.body.message}`);
  return dir;
}

function settingsBytes(dir: string): Record<string, string> {
  return Object.fromEntries(
    [".claude/settings.json", ".claude/settings.local.json"]
      .filter((rel) => existsSync(join(dir, rel)))
      .map((rel) => [rel, readFileSync(join(dir, rel), "utf8")]),
  );
}

function managed(dir: string): Record<string, string> {
  const root = join(dir, ".claude", "skills", "wip-kanban");
  return Object.fromEntries(
    Object.keys(KANBAN_MOD)
      .sort()
      .map((key) => [key, readFileSync(join(root, key), "utf8")]),
  );
}

const expectedMod = (): Record<string, string> =>
  Object.fromEntries(
    Object.keys(KANBAN_MOD)
      .sort()
      .map((key) => [key, KANBAN_MOD[key] as string]),
  );

describe("wip upgrade --apply-mod (e2e)", () => {
  test("refreshes an edited copy, backs it up and leaves settings alone", () => {
    const dir = withMod("apply-refresh");
    const file = join(dir, ".claude", "skills", "wip-kanban", "README.md");
    writeFileSync(file, "edited by hand\n");
    const before = settingsBytes(dir);
    const { code, body } = wipJsonIn(dir, ["upgrade", "--apply-mod"]);
    expect(code).toBe(EXIT.OK);
    const kanban = (body.data as { kanban: { action: string; backup: string | null } }).kanban;
    expect(kanban.action).toBe("updated");
    expect(readFileSync(file, "utf8")).toBe(KANBAN_MOD["README.md"] as string);
    expect(kanban.backup).toContain(".wip/backups/kanban/wip-kanban.");
    expect(settingsBytes(dir)).toEqual(before);
    const again = wipJsonIn(dir, ["upgrade", "--apply-mod"]);
    expect((again.body.data as { kanban: { action: string } }).kanban.action).toBe("exists");
  });

  test("--kanban installs the copy and the entry where absent", () => {
    const dir = tmp("apply-install");
    mkdirSync(join(dir, ".wip"), { recursive: true });
    const { code, body } = wipJsonIn(dir, ["upgrade", "--apply-mod", "--kanban"]);
    expect(code).toBe(EXIT.OK);
    const kanban = (
      body.data as { kanban: { action: string; settings: { file: string; action: string } } }
    ).kanban;
    expect(kanban.action).toBe("installed");
    expect(managed(dir)).toEqual(expectedMod());
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")) as {
      enabledPlugins: Record<string, boolean>;
    };
    expect(settings.enabledPlugins[ID]).toBe(true);
    expect(kanban.settings.action).toBe("created");
    const again = wipJsonIn(dir, ["upgrade", "--apply-mod", "--kanban"]);
    expect((again.body.data as { kanban: { action: string } }).kanban.action).toBe("exists");
    const backups = join(dir, ".wip", "backups", "kanban");
    expect(existsSync(backups) ? readdirSync(backups).length : 0).toBe(0);
  });

  test("a foreign folder exits 3 and writes nothing", () => {
    const dir = tmp("apply-foreign");
    mkdirSync(join(dir, ".wip"), { recursive: true });
    const foreign = join(dir, ".claude", "skills", "wip-kanban", "other.txt");
    mkdirSync(join(dir, ".claude", "skills", "wip-kanban"), { recursive: true });
    writeFileSync(foreign, "another plugin\n");
    const { code } = wipJsonIn(dir, ["upgrade", "--apply-mod", "--kanban"]);
    expect(code).toBe(EXIT.REJECTED);
    expect(readFileSync(foreign, "utf8")).toBe("another plugin\n");
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
  });

  test("without .wip/ exits 4", () => {
    const dir = tmp("apply-no-project");
    const { code } = wipJsonIn(dir, ["upgrade", "--apply-mod", "--kanban"]);
    expect(code).toBe(EXIT.NOT_FOUND);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("usage errors exit 2", () => {
    const dir = tmp("usage");
    for (const argv of [
      ["upgrade", "--check", "--dry-run"],
      ["upgrade", "--kanban", "--no-kanban"],
      ["upgrade", "--channel", "beta"],
      ["upgrade", "extra"],
      ["upgrade", "--apply-defs-after", "--check"],
      ["upgrade", "--apply-defs-after", "--no-defs"],
    ]) {
      expect(wipJsonIn(dir, argv).code).toBe(EXIT.USAGE);
    }
  });
});

describe("wip upgrade --apply-defs (e2e)", () => {
  function initTasks(name: string): string {
    const dir = tmp(name);
    const init = wipJsonIn(dir, ["init", "--yes", "--flows", "tasks"]);
    if (init.code !== EXIT.OK) throw new Error(`init failed: ${init.body.message}`);
    return dir;
  }

  interface IDefsBody {
    action: string;
    files: { path: string; action: string; backup: string | null }[];
    changed: string[];
    missing: string[];
  }

  const defsOf = (body: IEnvelopeOut["body"]): IDefsBody => (body.data as { defs: IDefsBody }).defs;

  test("restores a body edit and a removed guide, backs up and is idempotent", () => {
    const dir = initTasks("defs-apply");
    writeFileSync(
      join(dir, ".claude/agents/thinker.md"),
      `${TEMPLATES["agents/thinker.md"]}edited\n`,
    );
    rmSync(join(dir, ".claude/skills/wip-flow-tasks/guide.md"));
    const first = wipJsonIn(dir, ["upgrade", "--apply-defs"]);
    expect(first.code).toBe(EXIT.OK);
    const defs = defsOf(first.body);
    expect(defs.action).toBe("applied");
    expect(defs.changed).toEqual([".claude/agents/thinker.md"]);
    expect(defs.missing).toEqual([".claude/skills/wip-flow-tasks/guide.md"]);
    expect(defs.files.map((file) => [file.path, file.action])).toEqual([
      [".claude/agents/thinker.md", "replaced"],
      [".claude/skills/wip-flow-tasks/guide.md", "created"],
    ]);
    expect(defs.files[0]?.backup).toContain(".wip/backups/defs/agents/thinker.md.");
    expect(readFileSync(join(dir, ".claude/agents/thinker.md"), "utf8")).toBe(
      TEMPLATES["agents/thinker.md"] as string,
    );
    expect(readFileSync(join(dir, ".claude/skills/wip-flow-tasks/guide.md"), "utf8")).toBe(
      TEMPLATES["skills/wip-flow-tasks/guide.md"] as string,
    );

    const again = wipJsonIn(dir, ["upgrade", "--apply-defs"]);
    expect(again.code).toBe(EXIT.OK);
    expect(defsOf(again.body)).toMatchObject({ action: "current", files: [] });
    expect(readdirSync(join(dir, ".wip/backups/defs/agents"))).toHaveLength(1);
  });

  test("a foreign file exits 3 and writes nothing", () => {
    const dir = initTasks("defs-foreign");
    writeFileSync(
      join(dir, ".claude/agents/thinker.md"),
      `${TEMPLATES["agents/thinker.md"]}edited\n`,
    );
    writeFileSync(join(dir, ".claude/agents/fast.md"), "plain\n");
    const { code, body } = wipJsonIn(dir, ["upgrade", "--apply-defs"]);
    expect(code).toBe(EXIT.REJECTED);
    expect(body.message as string).toContain("without a `wip:` mark");
    expect(readFileSync(join(dir, ".claude/agents/fast.md"), "utf8")).toBe("plain\n");
    expect(readFileSync(join(dir, ".claude/agents/thinker.md"), "utf8")).toContain("edited");
    expect(existsSync(join(dir, ".wip/backups/defs"))).toBe(false);
  });

  test("without .wip/ exits 4 and its usage errors exit 2", () => {
    const outside = tmp("defs-no-project");
    const missing = wipJsonIn(outside, ["upgrade", "--apply-defs"]);
    expect(missing.code).toBe(EXIT.NOT_FOUND);
    expect(readdirSync(outside)).toEqual([]);
    for (const argv of [
      ["upgrade", "--apply-defs", "--check"],
      ["upgrade", "--apply-defs", "--dry-run"],
      ["upgrade", "--apply-defs", "--channel", "next"],
      ["upgrade", "--apply-defs", "--kanban"],
      ["upgrade", "--apply-defs", "--no-defs"],
      ["upgrade", "--apply-defs", "--apply-mod"],
    ]) {
      expect(wipJsonIn(outside, argv).code).toBe(EXIT.USAGE);
    }
  });
});

// A source run refuses the CLI install before touching npm; an installed package would read the registry, which
// these tests never do.
describe.skipIf(WIP_BIN !== null)("wip upgrade --no-kanban without a network (source run)", () => {
  test("writes no file of the project's mod", () => {
    const dir = withMod("no-kanban");
    const before = settingsBytes(dir);
    const copy = managed(dir);
    const out = wipIn(dir, ["upgrade", "--no-kanban"]);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.stderr).toContain("source run");
    expect(settingsBytes(dir)).toEqual(before);
    expect(managed(dir)).toEqual(copy);
  });
});
