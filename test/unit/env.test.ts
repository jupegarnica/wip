import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli.ts";
import { artifactDir, findRoot, rootAt, shownDefsDir } from "../../src/env.ts";
import { EXIT, WipError } from "../../src/errors.ts";
import { PROBES, probeRoot, probeWrite } from "../helpers/probes.ts";
import { makeProject, scratch } from "../helpers/project.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = scratch(name);
  dirs.push(dir);
  return dir;
}

function codeOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof WipError ? err.code : -1;
  }
}

describe("project root", () => {
  test("is the nearest .wip/ upwards from a subdirectory", () => {
    const project = tmp("root-sub");
    mkdirSync(join(project, ".wip"));
    const deep = join(project, "src", "a", "b");
    mkdirSync(deep, { recursive: true });
    const root = findRoot(deep, {});
    expect(root.project).toBe(project);
    expect(root.db).toBe(join(project, ".wip", "wip.sqlite"));
    expect(artifactDir(root, "wip", "T1")).toBe(join(project, ".wip", "items", "wip", "T1"));
  });

  test("the nearest one wins over an outer project", () => {
    const outer = tmp("root-nested");
    mkdirSync(join(outer, ".wip"));
    const inner = join(outer, "packages", "inner");
    mkdirSync(join(inner, ".wip"), { recursive: true });
    expect(findRoot(join(inner), {}).project).toBe(inner);
  });

  test("a .wip file is not a root", () => {
    const project = tmp("root-file");
    writeFileSync(join(project, ".wip"), "");
    expect(codeOf(() => findRoot(project, {}))).toBe(EXIT.NOT_FOUND);
  });

  test("without .wip/ it is exit 4 with the `wip init` hint", () => {
    const empty = tmp("root-none");
    try {
      findRoot(empty, {});
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(WipError);
      expect((err as WipError).code).toBe(EXIT.NOT_FOUND);
      expect((err as WipError).message).toContain("wip init");
    }
  });

  test("WIP_HOME with a .wip/ replaces the search", () => {
    const home = tmp("root-home");
    mkdirSync(join(home, ".wip"));
    const elsewhere = tmp("root-elsewhere");
    mkdirSync(join(elsewhere, ".wip"));
    expect(findRoot(elsewhere, { WIP_HOME: home }).project).toBe(home);
  });

  test("WIP_HOME without .wip/ inside is exit 4, even when the cwd has one", () => {
    const home = tmp("root-home-empty");
    const project = tmp("root-cwd");
    mkdirSync(join(project, ".wip"));
    expect(codeOf(() => findRoot(project, { WIP_HOME: home }))).toBe(EXIT.NOT_FOUND);
  });

  test("a WIP_HOME shaped like an agent fleet home (agents/, flows/, db/) is exit 4", () => {
    const fleet = tmp("root-fleet");
    for (const sub of ["agents", "flows", "db", "wip"]) mkdirSync(join(fleet, sub));
    writeFileSync(join(fleet, "db", "wip.sqlite"), "");
    expect(codeOf(() => findRoot(fleet, { WIP_HOME: fleet }))).toBe(EXIT.NOT_FOUND);
  });

  test("a project without a config reads .claude", () => {
    const p = makeProject("root-default");
    try {
      expect(rootAt(p.dir, {}).defsDir).toBe(".claude");
    } finally {
      p.cleanup();
    }
  });

  test("WIP_HOME=~/.agents is exit 4 when it has no .wip/", () => {
    const agents = join(homedir(), ".agents");
    if (existsSync(join(agents, ".wip"))) return;
    expect(codeOf(() => findRoot(tmp("root-agents"), { WIP_HOME: agents }))).toBe(EXIT.NOT_FOUND);
  });
});

describe("root through the CLI", () => {
  test("a command run from a subdirectory finds the project", () => {
    const p = makeProject("cli-sub");
    try {
      const sub = join(p.dir, "deep", "er");
      mkdirSync(sub, { recursive: true });
      const out = p.json(["probe-root"], { cwd: sub, extra: PROBES });
      expect(out.data).toEqual({ project: p.dir, db: p.dbPath });
    } finally {
      p.cleanup();
    }
  });

  test("a write without .wip/ is exit 4 with the hint and writes nothing", () => {
    const empty = tmp("cli-none");
    const out = run(["probe-write"], { cwd: empty, env: {}, extra: [probeWrite] });
    expect(out.code).toBe(EXIT.NOT_FOUND);
    expect(out.stderr).toContain("wip init");
    expect(readdirSync(empty)).toEqual([]);
  });

  test("an inherited WIP_HOME without .wip/ is exit 4 and nothing is written there", () => {
    const home = tmp("cli-home");
    const p = makeProject("cli-home-project", { WIP_HOME: home });
    try {
      const out = p.wip(["probe-write"], { extra: [probeWrite] });
      expect(out.code).toBe(EXIT.NOT_FOUND);
      expect(out.stderr).toContain("WIP_HOME");
      expect(readdirSync(home)).toEqual([]);
      expect(existsSync(p.dbPath)).toBe(false);
      expect(p.wip(["probe-root"], { extra: [probeRoot] }).code).toBe(EXIT.NOT_FOUND);
    } finally {
      p.cleanup();
    }
  });
});

describe("defs_dir in the user's home", () => {
  function globalProject(defsDir: string): string {
    const dir = tmp("home-defs");
    mkdirSync(join(dir, ".wip"));
    writeFileSync(
      join(dir, ".wip", "config.json"),
      JSON.stringify({ defs_dir: defsDir, harness: null }),
    );
    return dir;
  }

  test("~/.agents in the config resolves agents and skills under env HOME", () => {
    const dir = globalProject("~/.agents");
    const h = tmp("home-h");
    for (const root of [rootAt(dir, { HOME: h }), findRoot(dir, { HOME: h })]) {
      expect(root.defsDir).toBe("~/.agents");
      expect(root.agents).toBe(join(h, ".agents", "agents"));
      expect(root.skills).toBe(join(h, ".agents", "skills"));
    }
  });

  test("shownDefsDir: a ~/ folder is shown where HOME puts it, a project folder as it is", () => {
    const h = tmp("home-shown");
    expect(shownDefsDir("~/.claude", { HOME: h })).toBe(join(h, ".claude"));
    expect(shownDefsDir("~/.agents", { USERPROFILE: h })).toBe(join(h, ".agents"));
    expect(shownDefsDir(".claude", { HOME: h })).toBe(".claude");
    expect(shownDefsDir("~/.agents", {})).toBe("~/.agents");
    expect(shownDefsDir("~/.agents", { HOME: "rel/home" })).toBe("~/.agents");
  });

  test("USERPROFILE stands in for HOME", () => {
    const dir = globalProject("~/.claude");
    const h = tmp("home-up");
    expect(rootAt(dir, { USERPROFILE: h }).agents).toBe(join(h, ".claude", "agents"));
  });

  test("a ~/ defs_dir without HOME is exit 3", () => {
    const dir = globalProject("~/.agents");
    for (const fn of [() => rootAt(dir, {}), () => findRoot(dir, {})]) {
      let code: number | null = null;
      let message = "";
      try {
        fn();
      } catch (err) {
        code = (err as WipError).code;
        message = (err as Error).message;
      }
      expect(code).toBe(EXIT.REJECTED);
      expect(message).toContain("needs HOME");
    }
  });

  test("a relative HOME or USERPROFILE counts as missing and writes nothing under cwd", () => {
    const dir = globalProject("~/.agents");
    const cwd = tmp("home-rel-cwd");
    const before = process.cwd();
    process.chdir(cwd);
    try {
      for (const env of [{ HOME: "rel/home" }, { USERPROFILE: "rel/home" }, { HOME: "." }]) {
        let code: number | null = null;
        let message = "";
        try {
          rootAt(dir, env);
        } catch (err) {
          code = (err as WipError).code;
          message = (err as Error).message;
        }
        expect(code).toBe(EXIT.REJECTED);
        expect(message).toContain("needs HOME");
      }
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      process.chdir(before);
    }
  });

  test("~, ~x, ~/../x, /abs and ../x stay invalid", () => {
    for (const bad of ["~", "~x", "~/../x", "/abs", "../x", "~/"]) {
      const dir = globalProject(bad);
      let message = "";
      try {
        rootAt(dir, { HOME: "/h" });
      } catch (err) {
        expect((err as WipError).code).toBe(EXIT.REJECTED);
        message = (err as Error).message;
      }
      expect(message).toContain("has no valid defs_dir");
    }
  });

  test("a config without defs_dir still fails as before", () => {
    const dir = tmp("home-no-defs");
    mkdirSync(join(dir, ".wip"));
    writeFileSync(join(dir, ".wip", "config.json"), "{}\n");
    let message = "";
    try {
      rootAt(dir, { HOME: "/h" });
    } catch (err) {
      expect((err as WipError).code).toBe(EXIT.REJECTED);
      message = (err as Error).message;
    }
    expect(message).toContain("has no valid defs_dir");
  });
});
