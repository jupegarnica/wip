import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "../../src/cli.ts";
import { setClockForTests } from "../../src/clock.ts";
import {
  installPlan,
  resolveTarget,
  setUpgradeInstallForTests,
  setUpgradeRunnerForTests,
} from "../../src/commands/upgrade.ts";
import { KANBAN_MOD } from "../../src/embedded/kanban.ts";
import { EXIT, WipError } from "../../src/errors.ts";
import type { IInstallInfo } from "../../src/install.ts";
import type { ISpawnResult, TRun } from "../../src/upgrade/npm.ts";
import { compareVersions, isNewer, parseVersion } from "../../src/upgrade/version.ts";
import { scratch } from "../helpers/project.ts";
import { loadSchema, validate } from "../helpers/schema.ts";

const SCHEMA = loadSchema("upgrade");
const ID = "wip-kanban@skills-dir";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  setUpgradeRunnerForTests(null);
  setUpgradeInstallForTests(null);
  setClockForTests(null);
});

function tmp(name: string): string {
  const dir = scratch(`upgrade-${name}`);
  dirs.push(dir);
  return dir;
}

function bare(name: string): string {
  return tmp(name);
}

function project(name: string): string {
  const dir = bare(name);
  mkdirSync(join(dir, ".wip"), { recursive: true });
  return dir;
}

function withMod(name: string): string {
  const dir = project(name);
  const out = run(["init", "--yes", "--kanban"], { cwd: dir, env: {} });
  if (out.code !== EXIT.OK) throw new Error(`init failed: ${out.stderr}`);
  return dir;
}

function npmInfo(overrides: Partial<IInstallInfo> = {}): IInstallInfo {
  return {
    kind: "npm",
    root: "/opt/prefix/lib/node_modules/@garndev/wip",
    prefix: "/opt/prefix",
    bin: "/opt/prefix/bin/wip",
    version: "0.2.1",
    problem: null,
    entry: "bin/wip.mjs",
    ...overrides,
  };
}

interface ICall {
  command: string;
  args: string[];
  cwd: string;
}

function fakeRun(handler: (call: ICall, index: number) => Partial<ISpawnResult> | undefined): {
  run: TRun;
  calls: ICall[];
} {
  const calls: ICall[] = [];
  const runner: TRun = (command, args, options) => {
    const call = { command, args, cwd: options.cwd };
    calls.push(call);
    const out = handler(call, calls.length - 1);
    return {
      status: out?.status ?? 0,
      stdout: out?.stdout ?? "",
      stderr: out?.stderr ?? "",
      error: out?.error ?? null,
    };
  };
  return { run: runner, calls };
}

const viewOf = (tags: Record<string, string>): Partial<ISpawnResult> => ({
  stdout: JSON.stringify(tags),
});

const envelope = (body: Record<string, unknown>): Partial<ISpawnResult> => ({
  stdout: JSON.stringify(body),
});

function json(dir: string, argv: string[]): { code: number; body: Record<string, unknown> } {
  const out = run([...argv, "--json"], { cwd: dir, env: {} });
  return { code: out.code, body: JSON.parse(out.stdout) as Record<string, unknown> };
}

function dataOf(body: Record<string, unknown>): Record<string, unknown> {
  return body.data as Record<string, unknown>;
}

function kanbanOf(body: Record<string, unknown>): Record<string, unknown> | null {
  return dataOf(body).kanban as Record<string, unknown> | null;
}

function settingsBytes(dir: string): Record<string, string> {
  const files = [".claude/settings.json", ".claude/settings.local.json"];
  return Object.fromEntries(
    files
      .filter((rel) => existsSync(join(dir, rel)))
      .map((rel) => [rel, readFileSync(join(dir, rel), "utf8")]),
  );
}

function backupCount(dir: string): number {
  const path = join(dir, ".wip", "backups", "kanban");
  return existsSync(path) ? readdirSync(path).length : 0;
}

function settingsBackupCount(dir: string): number {
  const path = join(dir, ".wip", "backups", "claude-settings");
  return existsSync(path) ? readdirSync(path).length : 0;
}

function managed(dir: string): Record<string, string> {
  const root = join(dir, ".claude", "skills", "wip-kanban");
  return Object.fromEntries(
    Object.keys(KANBAN_MOD)
      .sort()
      .map((key) => [key, readFileSync(join(root, key), "utf8")]),
  );
}

describe("versions", () => {
  test("X.Y.Z and prereleases parse; anything else is null", () => {
    expect(parseVersion("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("0.3.0-next.1")).toMatchObject({ prerelease: ["next", 1] });
    for (const bad of ["", "1.2", "1.2.3.4", "v1。2.3", "01.2.3", "1.2.3+build"]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });

  test("SemVer 2: numbers, prerelease order and a release above its prereleases", () => {
    expect(compareVersions("0.2.1", "0.3.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.3.0-next.1", "0.3.0")).toBe(-1);
    expect(compareVersions("0.3.0-next.1", "0.3.0-next.0")).toBe(1);
    expect(compareVersions("0.3.0-next.10", "0.3.0-next.9")).toBe(1);
    expect(compareVersions("0.3.0-alpha", "0.3.0-alpha.1")).toBe(-1);
    expect(compareVersions("0.3.0-alpha.1", "0.3.0-alpha.beta")).toBe(-1);
    expect(isNewer("0.3.0", "0.3.0-next.1")).toBe(true);
    expect(isNewer("0.2.1", "0.3.0-next.1")).toBe(false);
  });

  test("an invalid value names itself", () => {
    expect(() => compareVersions("latest", "1.0.0")).toThrow("not a version: latest");
  });
});

describe("installPlan", () => {
  test("the exact install into the running prefix, and null without one", () => {
    const plan = installPlan(npmInfo(), "darwin", "9.9.9", {});
    expect(plan?.command).toEqual([
      "npm",
      "install",
      "-g",
      "--prefix",
      "/opt/prefix",
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
      "--ignore-scripts",
      "@garndev/wip@9.9.9",
    ]);
    expect(plan?.spawn[0]).toBe("npm");
    expect(plan?.spawn[1]).toContain("@garndev/wip@9.9.9");
    expect(installPlan(npmInfo({ prefix: null }), "darwin", "9.9.9", {})).toBeNull();
  });
});

describe("resolveTarget", () => {
  test("the channel's exact version, and whether it is newer", () => {
    expect(resolveTarget({ latest: "0.3.0", next: "0.4.0-next.1" }, "next", "0.3.0")).toEqual({
      target: "0.4.0-next.1",
      update: true,
      older: false,
    });
    expect(resolveTarget({ latest: "0.2.0" }, "latest", "0.3.0")).toEqual({
      target: "0.2.0",
      update: false,
      older: true,
    });
  });

  test("a missing or invalid tag is a refusal", () => {
    expect(() => resolveTarget({}, "next", "0.2.0")).toThrow(WipError);
    expect(() => resolveTarget({ latest: "nightly" }, "latest", "0.2.0")).toThrow(
      "not a version: nightly",
    );
  });
});

describe("wip upgrade --check and --dry-run (fake npm)", () => {
  test("--check with an update exits 1, records the target and only runs npm view", () => {
    const dir = bare("check-update");
    const fake = fakeRun(() => viewOf({ latest: "9.9.9", next: "10.0.0-next.1" }));
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo());
    const { code, body } = json(dir, ["upgrade", "--check"]);
    expect(code).toBe(EXIT.FINDINGS);
    expect(body.ok).toBe(false);
    expect(validate(SCHEMA, body)).toEqual([]);
    expect(dataOf(body)).toMatchObject({
      action: "available",
      target: "9.9.9",
      update: true,
      check: true,
      dry_run: false,
      changelog: null,
    });
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]?.args).toEqual(["view", "@garndev/wip", "dist-tags", "--json"]);
  });

  test("--check on the running version exits 0", () => {
    const dir = bare("check-current");
    const fake = fakeRun(() => viewOf({ latest: "0.2.1" }));
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo());
    const { code, body } = json(dir, ["upgrade", "--check"]);
    expect(code).toBe(EXIT.OK);
    expect(body.ok).toBe(true);
    expect(dataOf(body)).toMatchObject({ action: "current", update: false });
  });

  test("--channel next resolves that tag", () => {
    const dir = bare("check-next");
    const fake = fakeRun(() => viewOf({ latest: "0.2.1", next: "0.3.0-next.1" }));
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo());
    const { code, body } = json(dir, ["upgrade", "--check", "--channel", "next"]);
    expect(code).toBe(EXIT.FINDINGS);
    expect(dataOf(body)).toMatchObject({ channel: "next", target: "0.3.0-next.1" });
  });

  test("a source run still checks and names the manual command", () => {
    const dir = bare("check-source");
    const fake = fakeRun(() => viewOf({ latest: "9.9.9" }));
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo({ kind: "source", root: null, prefix: null, bin: null }));
    const out = run(["upgrade", "--check"], { cwd: dir, env: {} });
    expect(out.code).toBe(EXIT.FINDINGS);
    expect(out.stdout).toContain("manual: npm install -g @garndev/wip@9.9.9");
    const { body } = json(dir, ["upgrade", "--check"]);
    expect((dataOf(body).install as Record<string, unknown>).kind).toBe("source");
  });

  test("--dry-run prints the exact command, spawns only npm view and writes nothing", () => {
    const dir = bare("dry-run");
    const fake = fakeRun(() => viewOf({ latest: "9.9.9" }));
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo());
    const out = run(["upgrade", "--dry-run"], { cwd: dir, env: {} });
    expect(out.code).toBe(EXIT.OK);
    expect(out.stdout).toContain(
      "npm install -g --prefix /opt/prefix --no-audit --no-fund --no-update-notifier --ignore-scripts @garndev/wip@9.9.9",
    );
    expect(fake.calls.length).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    const { body } = json(dir, ["upgrade", "--dry-run"]);
    expect(validate(SCHEMA, body)).toEqual([]);
    expect(dataOf(body)).toMatchObject({
      action: "would-upgrade",
      dry_run: true,
      changelog: null,
    });
    expect((dataOf(body).npm as Record<string, unknown>).code).toBeNull();
  });
});

describe("wip upgrade (fake npm)", () => {
  test("installs the exact version, verifies it and reports the upgrade", () => {
    const dir = bare("install");
    const fake = fakeRun((call) => {
      if (call.args[0] === "view") return viewOf({ latest: "9.9.9" });
      if (call.args.includes("version")) return envelope({ data: { version: "9.9.9" } });
      return { status: 0 };
    });
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo());
    const { code, body } = json(dir, ["upgrade"]);
    expect(code).toBe(EXIT.OK);
    expect(validate(SCHEMA, body)).toEqual([]);
    expect(dataOf(body)).toMatchObject({ action: "upgraded", target: "9.9.9" });
    expect(kanbanOf(body)).toMatchObject({ action: "skipped", reason: "no-project" });
    const install = fake.calls.find((call) => call.args[0] === "install");
    expect(install?.args).toEqual([
      "install",
      "-g",
      "--prefix",
      "/opt/prefix",
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
      "--ignore-scripts",
      "@garndev/wip@9.9.9",
    ]);
    expect(fake.calls.some((call) => call.args.includes("--apply-mod"))).toBe(false);
  });

  test("a failed npm install exits 1, reports stderr and leaves the project untouched", () => {
    const dir = withMod("install-fails");
    const before = settingsBytes(dir);
    const fake = fakeRun((call) => {
      if (call.args[0] === "view") return viewOf({ latest: "9.9.9" });
      return { status: 1, stderr: "npm ERR! EACCES: permission denied, open '/opt/prefix'" };
    });
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo());
    const { code, body } = json(dir, ["upgrade"]);
    expect(code).toBe(EXIT.FINDINGS);
    expect(body.ok).toBe(false);
    expect(dataOf(body)).toMatchObject({ action: "failed", changelog: null });
    expect((body.message as string) ?? "").toContain("EACCES");
    expect(kanbanOf(body)).toBeNull();
    expect(
      (body.warnings as { code: string }[]).some((warning) =>
        warning.code.startsWith("changelog_"),
      ),
    ).toBe(false);
    expect(settingsBytes(dir)).toEqual(before);
    expect(backupCount(dir)).toBe(0);
    expect(existsSync(join(dir, ".wip", "backups"))).toBe(false);
  });

  test("a verification mismatch runs the rollback and exits 1", () => {
    const dir = bare("rollback");
    let verifications = 0;
    const fake = fakeRun((call) => {
      if (call.args[0] === "view") return viewOf({ latest: "9.9.9" });
      if (call.args.includes("version")) {
        verifications++;
        return envelope({ data: { version: verifications === 1 ? "0.0.1" : "0.2.1" } });
      }
      return { status: 0 };
    });
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo());
    const { code, body } = json(dir, ["upgrade"]);
    expect(code).toBe(EXIT.FINDINGS);
    expect(dataOf(body)).toMatchObject({ action: "failed", changelog: null });
    expect(
      (body.warnings as { code: string }[]).some((warning) =>
        warning.code.startsWith("changelog_"),
      ),
    ).toBe(false);
    expect(dataOf(body).rollback).toMatchObject({
      version: "0.2.1",
      code: 0,
    });
    expect((dataOf(body).rollback as { command: string[] }).command.join(" ")).toContain(
      "@garndev/wip@0.2.1",
    );
    expect(fake.calls.length).toBe(5);
    expect(fake.calls[0]?.args[0]).toBe("view");
    expect(fake.calls[1]?.args.join(" ")).toContain("@garndev/wip@9.9.9");
    expect(fake.calls[2]?.args).toContain("version");
    expect(fake.calls[3]?.args.join(" ")).toContain("@garndev/wip@0.2.1");
    expect(fake.calls[4]?.args).toContain("version");
  });

  test("a failed rollback names both failures and the manual command", () => {
    const dir = bare("rollback-fails");
    let installs = 0;
    const fake = fakeRun((call) => {
      if (call.args[0] === "view") return viewOf({ latest: "9.9.9" });
      if (call.args.includes("version")) return envelope({ data: { version: "0.0.1" } });
      installs++;
      return installs === 1 ? { status: 0 } : { status: 1, stderr: "EACCES" };
    });
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo());
    const { code, body } = json(dir, ["upgrade"]);
    expect(code).toBe(EXIT.FINDINGS);
    expect(dataOf(body).rollback).toMatchObject({ version: "0.2.1", code: 1 });
    const message = body.message as string;
    expect(message).toContain("did not verify");
    expect(message).toContain("rollback");
    expect(message).toContain("failed");
  });

  test("source, binary and a refused npm install exit 3 without spawning anything", () => {
    const cases: [string, IInstallInfo, string][] = [
      ["source", npmInfo({ kind: "source", root: null, prefix: null, bin: null }), "source run"],
      [
        "binary",
        npmInfo({ kind: "binary", root: "/usr/local/bin/wip", prefix: null, bin: null }),
        "standalone binary",
      ],
      [
        "bun",
        npmInfo({ problem: "this is a Bun global install: bun add -g @garndev/wip@latest" }),
        "Bun global install",
      ],
    ];
    for (const [name, info, message] of cases) {
      const dir = bare(`refuse-${name}`);
      const fake = fakeRun(() => viewOf({ latest: "9.9.9" }));
      setUpgradeRunnerForTests(fake.run);
      setUpgradeInstallForTests(info);
      const { code, body } = json(dir, ["upgrade"]);
      expect(code).toBe(EXIT.REJECTED);
      expect(body.message as string).toContain(message);
      expect(fake.calls.length).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  test("outside a project, the mod is skipped with reason no-project", () => {
    const dir = bare("no-project");
    const fake = fakeRun(() => viewOf({ latest: "0.2.1" }));
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo());
    const { code, body } = json(dir, ["upgrade"]);
    expect(code).toBe(EXIT.OK);
    expect(dataOf(body)).toMatchObject({ action: "current" });
    expect(kanbanOf(body)).toMatchObject({ action: "skipped", reason: "no-project" });
    expect(fake.calls.length).toBe(1);
  });

  test("a pinned wip_bin only warns and is never written", () => {
    const dir = withMod("pinned");
    const config = join(dir, ".wip", "config.json");
    const parsed = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
    parsed.wip_bin = "/opt/other/wip";
    writeFileSync(config, `${JSON.stringify(parsed, null, 2)}\n`);
    const before = readFileSync(config, "utf8");
    const fake = fakeRun(() => viewOf({ latest: "0.2.1" }));
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo());
    const { code, body } = json(dir, ["upgrade"]);
    expect(code).toBe(EXIT.OK);
    expect((body.warnings as { code: string }[]).map((w) => w.code)).toContain("wip_bin_pinned");
    expect(readFileSync(config, "utf8")).toBe(before);
  });

  test("--no-kanban writes no file and does not look for a project", () => {
    const dir = withMod("no-kanban");
    const before = settingsBytes(dir);
    const copies = managed(dir);
    const fake = fakeRun(() => viewOf({ latest: "0.2.1" }));
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo());
    const { code, body } = json(dir, ["upgrade", "--no-kanban"]);
    expect(code).toBe(EXIT.OK);
    expect(dataOf(body)).toMatchObject({ project: null, kanban: null });
    expect(settingsBytes(dir)).toEqual(before);
    expect(managed(dir)).toEqual(copies);
    expect(fake.calls.length).toBe(1);
  });
});

describe("wip upgrade release notes (fake npm)", () => {
  const MARKDOWN = `# Changelog

## 9.9.9 (2026-12-01)

- target bullet

## 0.3.0 (2026-11-01)

- middle bullet

## 0.2.1 (2026-10-01)

- running bullet
`;

  function notesRoot(name: string, markdown?: string): string {
    const dir = bare(name);
    if (markdown !== undefined) writeFileSync(join(dir, "CHANGELOG.md"), markdown);
    return dir;
  }

  /** A fake upgrade of npmInfo's running 0.2.1 to 9.9.9, with `root` as the package that installs. */
  function installing(root: string): { run: TRun; calls: ICall[] } {
    const fake = fakeRun((call) => {
      if (call.args[0] === "view") return viewOf({ latest: "9.9.9" });
      if (call.args.includes("version")) return envelope({ data: { version: "9.9.9" } });
      return { status: 0 };
    });
    setUpgradeRunnerForTests(fake.run);
    setUpgradeInstallForTests(npmInfo({ root, prefix: root, bin: join(root, "bin/wip") }));
    return fake;
  }

  test("prints the sections between the running and the installed version, not the running one", () => {
    const dir = notesRoot("notes-upgrade", MARKDOWN);
    installing(dir);
    const out = run(["upgrade"], { cwd: dir, env: {} });
    expect(out.code).toBe(EXIT.OK);
    expect(out.stdout).toContain("upgraded wip 0.2.1 -> 9.9.9 (latest)");
    expect(out.stdout).toContain("what's new (0.2.1 -> 9.9.9):");
    expect(out.stdout).toContain("9.9.9 (2026-12-01)\n- target bullet");
    expect(out.stdout).toContain("0.3.0 (2026-11-01)\n- middle bullet");
    expect(out.stdout).not.toContain("running bullet");
    expect(out.stdout).not.toContain("0.2.1 (2026-10-01)");
  });

  test("--json carries every entry and the range in data.changelog", () => {
    const dir = notesRoot("notes-json", MARKDOWN);
    installing(dir);
    const { code, body } = json(dir, ["upgrade"]);
    expect(code).toBe(EXIT.OK);
    expect(validate(SCHEMA, body)).toEqual([]);
    expect(dataOf(body).changelog).toEqual({
      from: "0.2.1",
      to: "9.9.9",
      entries: [
        { version: "9.9.9", title: "9.9.9 (2026-12-01)", body: "- target bullet" },
        { version: "0.3.0", title: "0.3.0 (2026-11-01)", body: "- middle bullet" },
      ],
      truncated: false,
    });
  });

  test("a package without CHANGELOG.md warns changelog_missing and still exits 0", () => {
    const dir = notesRoot("notes-missing");
    installing(dir);
    const { code, body } = json(dir, ["upgrade"]);
    expect(code).toBe(EXIT.OK);
    expect(dataOf(body).action).toBe("upgraded");
    expect(dataOf(body).changelog).toBeNull();
    expect((body.warnings as { code: string }[]).map((warning) => warning.code)).toContain(
      "changelog_missing",
    );
  });

  test("a changelog without a section in range warns changelog_empty and exits 0", () => {
    const dir = notesRoot("notes-empty", "## 0.2.1 (2026-10-01)\n\n- running bullet\n");
    installing(dir);
    const { code, body } = json(dir, ["upgrade"]);
    expect(code).toBe(EXIT.OK);
    expect(dataOf(body).changelog).toBeNull();
    const warnings = body.warnings as { code: string; message: string }[];
    expect(warnings.map((warning) => warning.code)).toContain("changelog_empty");
    expect(warnings.find((warning) => warning.code === "changelog_empty")?.message).toContain(
      "between 0.2.1 and 9.9.9",
    );
  });
});

describe("wip upgrade --apply-mod", () => {
  test("refreshes a corrupted owned copy with a backup and leaves settings alone", () => {
    const dir = withMod("apply-refresh");
    const file = join(dir, ".claude", "skills", "wip-kanban", "README.md");
    writeFileSync(file, "edited by hand\n");
    const before = settingsBytes(dir);
    const { code, body } = json(dir, ["upgrade", "--apply-mod"]);
    expect(code).toBe(EXIT.OK);
    expect(kanbanOf(body)).toMatchObject({ action: "updated" });
    expect(dataOf(body).changelog).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(KANBAN_MOD["README.md"] as string);
    expect(kanbanOf(body)?.backup as string).toContain(".wip/backups/kanban/wip-kanban.");
    expect(settingsBytes(dir)).toEqual(before);
    expect(backupCount(dir)).toBe(1);

    const again = json(dir, ["upgrade", "--apply-mod"]);
    expect(kanbanOf(again.body)).toMatchObject({ action: "exists", backup: null });
    expect(backupCount(dir)).toBe(1);
  });

  test("--kanban installs the copy and merges the entry with a backup, idempotently", () => {
    const dir = project("apply-install");
    const settings = join(dir, ".claude", "settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(
      settings,
      `${JSON.stringify({ other: 1, enabledPlugins: { [ID]: false, "x@y": true } })}\n`,
    );
    const { code, body } = json(dir, ["upgrade", "--apply-mod", "--kanban"]);
    expect(code).toBe(EXIT.OK);
    expect(kanbanOf(body)).toMatchObject({
      action: "installed",
      removed: [],
      settings: { file: ".claude/settings.json", action: "updated" },
    });
    expect(managed(dir)).toEqual(
      Object.fromEntries(
        Object.keys(KANBAN_MOD)
          .sort()
          .map((key) => [key, KANBAN_MOD[key] as string]),
      ),
    );
    const merged = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
    expect(merged.other).toBe(1);
    expect((merged.enabledPlugins as Record<string, boolean>)[ID]).toBe(true);
    expect((merged.enabledPlugins as Record<string, boolean>)["x@y"]).toBe(true);
    expect(settingsBackupCount(dir)).toBe(1);

    const again = json(dir, ["upgrade", "--apply-mod", "--kanban"]);
    expect(kanbanOf(again.body)).toMatchObject({
      action: "exists",
      settings: { file: ".claude/settings.json", action: "exists" },
    });
    expect(settingsBackupCount(dir)).toBe(1);
    expect(backupCount(dir)).toBe(0);
  });

  test("--kanban recreates a deleted copy and leaves the enabled entry alone", () => {
    const dir = withMod("apply-recreate");
    rmSync(join(dir, ".claude", "skills", "wip-kanban"), { recursive: true, force: true });
    const before = settingsBytes(dir);
    const { code, body } = json(dir, ["upgrade", "--apply-mod", "--kanban"]);
    expect(code).toBe(EXIT.OK);
    expect(kanbanOf(body)).toMatchObject({
      action: "installed",
      settings: { action: "exists" },
    });
    expect(Object.keys(managed(dir)).length).toBe(8);
    expect(settingsBytes(dir)).toEqual(before);
  });

  test("the file that already wins the entry is the one written", () => {
    const dir = project("apply-local");
    const local = join(dir, ".claude", "settings.local.json");
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, `${JSON.stringify({ enabledPlugins: { [ID]: true } })}\n`);
    const { code, body } = json(dir, ["upgrade", "--apply-mod", "--kanban"]);
    expect(code).toBe(EXIT.OK);
    expect(kanbanOf(body)).toMatchObject({
      action: "installed",
      settings: { file: ".claude/settings.local.json", action: "exists" },
    });
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
  });

  test("a foreign folder exits 3 with nothing written", () => {
    const dir = project("apply-foreign");
    const foreign = join(dir, ".claude", "skills", "wip-kanban", "other.txt");
    mkdirSync(dirname(foreign), { recursive: true });
    writeFileSync(foreign, "another plugin\n");
    const { code, body } = json(dir, ["upgrade", "--apply-mod", "--kanban"]);
    expect(code).toBe(EXIT.REJECTED);
    expect(body.message as string).toContain("another plugin's folder");
    expect(readFileSync(foreign, "utf8")).toBe("another plugin\n");
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
  });

  test("without .wip/ it exits 4", () => {
    const dir = bare("apply-no-project");
    for (const argv of [
      ["upgrade", "--apply-mod"],
      ["upgrade", "--apply-mod", "--kanban"],
    ]) {
      const { code, body } = json(dir, argv);
      expect(code).toBe(EXIT.NOT_FOUND);
      expect(body.message as string).toContain("no .wip/");
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("wip upgrade usage", () => {
  test("bad combinations and values exit 2", () => {
    const dir = bare("usage");
    const cases = [
      ["upgrade", "--check", "--dry-run"],
      ["upgrade", "--kanban", "--no-kanban"],
      ["upgrade", "--channel", "beta"],
      ["upgrade", "extra"],
      ["upgrade", "--apply-mod", "--check"],
      ["upgrade", "--apply-mod", "--channel", "next"],
      ["upgrade", "--apply-mod", "--dry-run"],
    ];
    for (const argv of cases) {
      const { code } = json(dir, argv);
      expect(code).toBe(EXIT.USAGE);
    }
  });
});
