import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli.ts";
import { artifactDir, findRoot } from "../../src/env.ts";
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
