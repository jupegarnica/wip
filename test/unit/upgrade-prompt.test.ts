import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli.ts";
import {
  type IDefsData,
  isUpgradeDefsPrompt,
  promptDefsAfterInstall,
  promptUpgradeDefs,
  setUpgradeInstallForTests,
  setUpgradeRunnerForTests,
} from "../../src/commands/upgrade.ts";
import { TEMPLATES } from "../../src/embedded/templates.ts";
import { EXIT } from "../../src/errors.ts";
import {
  type IAsker,
  type ISelectOption,
  optionsError,
  resolveOption,
} from "../../src/init/prompt.ts";
import { PLAIN } from "../../src/init/style.ts";
import type { IInstallInfo } from "../../src/install.ts";
import { scratch } from "../helpers/project.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  setUpgradeRunnerForTests(null);
  setUpgradeInstallForTests(null);
});

function tmp(): string {
  const dir = scratch("upgrade-prompt");
  dirs.push(dir);
  return dir;
}

/** A `wip init --yes --flows tasks` project with the thinker agent edited, so the comparison has one change. */
function initTasks(): string {
  const dir = tmp();
  const out = run(["init", "--yes", "--flows", "tasks"], { cwd: dir, env: {} });
  if (out.code !== EXIT.OK) throw new Error(`init failed: ${out.stderr}`);
  writeFileSync(
    join(dir, ".claude", "agents", "thinker.md"),
    `${TEMPLATES["agents/thinker.md"]}edited\n`,
  );
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

/**
 * Answers in order: `""` takes the highlighted option, `null` is Ctrl+C. A bad select answer is asked again from
 * the queue.
 */
function fake(answers: (string | null)[]): IAsker & { said: string[]; asked: string[] } {
  const queue = [...answers];
  const said: string[] = [];
  const asked: string[] = [];
  const next = () => (queue.length === 0 ? null : (queue.shift() as string | null));
  return {
    said,
    asked,
    style: PLAIN,
    select: async (spec) => {
      asked.push(
        `${spec.question} [${spec.options.map((o) => o.value).join("|")}] @${spec.initial}`,
      );
      for (;;) {
        const a = next();
        if (a === null) return null;
        if (a === "") return (spec.options[spec.initial] as ISelectOption).value;
        const i = resolveOption(a, spec.options);
        if (i >= 0) return (spec.options[i] as ISelectOption).value;
        said.push(optionsError(spec.options));
      }
    },
    multiSelect: async () => null,
    input: async () => null,
    say: (line) => {
      said.push(line);
    },
    close: () => {},
  };
}

describe("isUpgradeDefsPrompt", () => {
  test("a normal run in a terminal asks", () => {
    for (const argv of [
      ["upgrade"],
      ["upgrade", "--channel", "next"],
      ["upgrade", "--kanban"],
      ["upgrade", "--no-kanban"],
    ]) {
      expect(isUpgradeDefsPrompt(argv, true)).toBe(true);
    }
  });

  test("no terminal, no question", () => {
    expect(isUpgradeDefsPrompt(["upgrade"], false)).toBe(false);
  });

  test("every mode that must not block a script is silent", () => {
    for (const argv of [
      ["upgrade", "--json"],
      ["upgrade", "--help"],
      ["upgrade", "-h"],
      ["upgrade", "--check"],
      ["upgrade", "--dry-run"],
      ["upgrade", "--no-defs"],
      ["upgrade", "--apply-defs"],
      ["upgrade", "--apply-mod"],
      ["upgrade", "--apply-defs-after"],
      ["upgrade", "--defs-status"],
    ]) {
      expect(isUpgradeDefsPrompt(argv, true)).toBe(false);
    }
  });

  test("another command and the usage errors never ask", () => {
    for (const argv of [
      ["status"],
      ["upgrade", "extra"],
      ["upgrade", "--check", "--dry-run"],
      ["upgrade", "--channel", "bogus"],
      ["upgrade", "--bogus"],
    ]) {
      expect(isUpgradeDefsPrompt(argv, true)).toBe(false);
    }
  });
});

describe("promptUpgradeDefs", () => {
  const env = { PATH: "" };

  test("the hint and the question are exact; Enter applies and adds the hidden flag", async () => {
    setUpgradeInstallForTests(npmInfo());
    const dir = initTasks();
    const asker = fake([""]);
    const out = await promptUpgradeDefs(["upgrade", "--no-kanban"], dir, env, asker);
    expect(out).toEqual({
      argv: ["upgrade", "--no-kanban", "--apply-defs-after"],
      code: 0,
      asked: true,
    });
    expect(asker.said).toContain("defs: 1 out of date in .claude/ (1 changed)");
    expect(asker.asked).toEqual(["Apply the definitions? [apply|cancel] @0"]);
  });

  test("typing apply applies too", async () => {
    setUpgradeInstallForTests(npmInfo());
    const dir = initTasks();
    const out = await promptUpgradeDefs(["upgrade"], dir, env, fake(["apply"]));
    expect(out.argv).toEqual(["upgrade", "--apply-defs-after"]);
    expect(out.code).toBe(EXIT.OK);
    expect(out.asked).toBe(true);
  });

  test("cancel leaves the argv as it is", async () => {
    setUpgradeInstallForTests(npmInfo());
    const dir = initTasks();
    const out = await promptUpgradeDefs(["upgrade"], dir, env, fake(["cancel"]));
    expect(out).toEqual({ argv: ["upgrade"], code: 0, asked: true });
  });

  test("a bad answer is asked again", async () => {
    setUpgradeInstallForTests(npmInfo());
    const dir = initTasks();
    const asker = fake(["nope", "cancel"]);
    const out = await promptUpgradeDefs(["upgrade"], dir, env, asker);
    expect(out.argv).toEqual(["upgrade"]);
    expect(asker.said.join("\n")).toContain("not an option: choose 1-2 or type apply / cancel");
  });

  test("Ctrl+C aborts with 130 and says nothing was upgraded", async () => {
    setUpgradeInstallForTests(npmInfo());
    const dir = initTasks();
    const asker = fake([null]);
    const out = await promptUpgradeDefs(["upgrade"], dir, env, asker);
    expect(out).toEqual({ argv: null, code: 130, asked: true });
    expect(asker.said).toContain("aborted: nothing upgraded");
  });

  test("a source or binary install is refused before the question", async () => {
    const dir = initTasks();
    const cases = [
      npmInfo({ kind: "source", root: null, prefix: null, bin: null }),
      npmInfo({ kind: "binary", root: "/usr/local/bin/wip", prefix: null, bin: null }),
    ];
    for (const info of cases) {
      setUpgradeInstallForTests(info);
      const asker = fake([]);
      expect(await promptUpgradeDefs(["upgrade"], dir, env, asker)).toEqual({
        argv: ["upgrade"],
        code: 0,
        asked: false,
      });
      expect(asker.asked).toEqual([]);
    }
  });

  test("outside a project there is no comparison and no question", async () => {
    setUpgradeInstallForTests(npmInfo());
    const asker = fake([]);
    expect(await promptUpgradeDefs(["upgrade"], tmp(), env, asker)).toEqual({
      argv: ["upgrade"],
      code: 0,
      asked: false,
    });
    expect(asker.asked).toEqual([]);
  });

  test("a project whose definitions are up to date is not asked", async () => {
    setUpgradeInstallForTests(npmInfo());
    const dir = tmp();
    const out = run(["init", "--yes", "--flows", "tasks"], { cwd: dir, env: {} });
    if (out.code !== EXIT.OK) throw new Error(`init failed: ${out.stderr}`);
    const asker = fake([]);
    expect(await promptUpgradeDefs(["upgrade", "--no-kanban"], dir, env, asker)).toEqual({
      argv: ["upgrade", "--no-kanban"],
      code: 0,
      asked: false,
    });
    expect(asker.asked).toEqual([]);
    expect(asker.said).toEqual([]);
  });

  test("a foreign file is reported, not asked about", async () => {
    setUpgradeInstallForTests(npmInfo());
    const dir = tmp();
    const out = run(["init", "--yes", "--flows", "tasks"], { cwd: dir, env: {} });
    if (out.code !== EXIT.OK) throw new Error(`init failed: ${out.stderr}`);
    writeFileSync(join(dir, ".claude", "agents", "thinker.md"), "plain\n");
    const asker = fake([]);
    expect(await promptUpgradeDefs(["upgrade", "--no-kanban"], dir, env, asker)).toEqual({
      argv: ["upgrade", "--no-kanban"],
      code: 0,
      asked: false,
    });
    expect(asker.asked).toEqual([]);
    expect(asker.said).toEqual([]);
  });

  test("a foreign file blocks the question even when other files changed", async () => {
    setUpgradeInstallForTests(npmInfo());
    const dir = initTasks();
    writeFileSync(join(dir, ".claude", "agents", "fast.md"), "plain\n");
    const asker = fake([]);
    expect(await promptUpgradeDefs(["upgrade", "--no-kanban"], dir, env, asker)).toEqual({
      argv: ["upgrade", "--no-kanban"],
      code: 0,
      asked: false,
    });
    expect(asker.asked).toEqual([]);
  });

  test("--apply-defs with --channel is a usage error and reaches the command", async () => {
    setUpgradeInstallForTests(npmInfo());
    const dir = initTasks();
    const asker = fake([]);
    const argv = ["upgrade", "--apply-defs", "--channel", "latest"];
    expect(await promptUpgradeDefs(argv, dir, env, asker)).toEqual({
      argv,
      code: 0,
      asked: false,
    });
    expect(asker.asked).toEqual([]);
  });

  test("--no-defs and the other silent flags are not asked", async () => {
    setUpgradeInstallForTests(npmInfo());
    const dir = initTasks();
    for (const argv of [
      ["upgrade", "--no-defs"],
      ["upgrade", "--check"],
      ["upgrade", "--json"],
    ]) {
      const asker = fake([]);
      expect(await promptUpgradeDefs(argv, dir, env, asker)).toEqual({
        argv,
        code: 0,
        asked: false,
      });
      expect(asker.asked).toEqual([]);
    }
  });
});

interface IChildCall {
  command: string;
  args: string[];
  cwd: string;
}

/** A fake child runner that records every call and answers it. */
function fakeChild(
  handler: (call: IChildCall) => {
    status?: number;
    stdout?: string;
    stderr?: string;
    error?: string | null;
  },
): IChildCall[] {
  const calls: IChildCall[] = [];
  setUpgradeRunnerForTests((command, args, options) => {
    const call = { command, args, cwd: options.cwd };
    calls.push(call);
    const out = handler(call);
    return {
      status: out.status ?? 0,
      stdout: out.stdout ?? "",
      stderr: out.stderr ?? "",
      error: out.error ?? null,
    };
  });
  return calls;
}

/** The comparison the installed CLI reports: 9.9.9 is the version of that build, not the running one. */
function defs(overrides: Partial<IDefsData> = {}): IDefsData {
  return {
    action: "outdated",
    dir: ".claude",
    path: ".claude",
    version: "9.9.9",
    missing: [],
    changed: [],
    foreign: [],
    kept: [],
    files: [],
    reason: null,
    ...overrides,
  };
}

function statusOf(data: IDefsData): { stdout: string } {
  return { stdout: JSON.stringify({ data: { defs: data } }) };
}

function stepOf(dir: string): { project: string; root: string; entry: string } {
  return {
    project: dir,
    root: "/opt/prefix/lib/node_modules/@garndev/wip",
    entry: "bin/wip.mjs",
  };
}

describe("promptDefsAfterInstall", () => {
  test("asks with the installed build's comparison and applies with the installed CLI", async () => {
    const dir = tmp();
    const calls = fakeChild((call) =>
      call.args.includes("--defs-status")
        ? statusOf(defs({ changed: [".claude/agents/thinker.md"] }))
        : statusOf(
            defs({
              action: "applied",
              missing: [".claude/skills/wip-flow-tasks/guide.md"],
              files: [
                {
                  path: ".claude/skills/wip-flow-tasks/guide.md",
                  action: "created",
                  backup: null,
                },
              ],
            }),
          ),
    );
    const asker = fake([""]);
    const out = await promptDefsAfterInstall(stepOf(dir), asker);
    expect(asker.asked).toEqual(["Apply the definitions? [apply|cancel] @0"]);
    expect(asker.said).toContain("defs: 1 out of date in .claude/ (1 changed)");
    expect(calls.map((call) => call.args.slice(2))).toEqual([
      ["--defs-status", "--json"],
      ["--apply-defs", "--json"],
    ]);
    for (const call of calls) {
      expect(call.command).toBe(process.execPath);
      expect(call.args[0]).toBe("/opt/prefix/lib/node_modules/@garndev/wip/bin/wip.mjs");
      expect(call.cwd).toBe(dir);
    }
    expect(out.lines).toContain("created .claude/skills/wip-flow-tasks/guide.md");
    expect(out.warnings).toEqual([]);
    expect(out.code).toBe(EXIT.OK);
  });

  test("an up-to-date folder is not asked", async () => {
    const calls = fakeChild(() => statusOf(defs({ action: "current" })));
    const asker = fake([]);
    const out = await promptDefsAfterInstall(stepOf(tmp()), asker);
    expect(asker.asked).toEqual([]);
    expect(out.lines).toEqual(["defs: up to date (.claude/) (wip 9.9.9)"]);
    expect(out.warnings).toEqual([]);
    expect(out.code).toBe(EXIT.OK);
    expect(calls).toHaveLength(1);
  });

  test("a foreign file blocks the question and is reported", async () => {
    const calls = fakeChild(() => statusOf(defs({ foreign: [".claude/agents/fast.md"] })));
    const asker = fake([]);
    const out = await promptDefsAfterInstall(stepOf(tmp()), asker);
    expect(asker.asked).toEqual([]);
    expect(out.lines.join("\n")).toContain("defs: 1 out of date in .claude/ (1 foreign)");
    expect(out.lines).toContain("foreign .claude/agents/fast.md");
    expect(out.warnings.map((warning) => warning.code)).toEqual(["defs_foreign"]);
    expect(out.code).toBe(EXIT.OK);
    expect(calls).toHaveLength(1);
  });

  test("a foreign file blocks the question even with changes", async () => {
    fakeChild(() =>
      statusOf(
        defs({ changed: [".claude/agents/thinker.md"], foreign: [".claude/agents/fast.md"] }),
      ),
    );
    const asker = fake([]);
    const out = await promptDefsAfterInstall(stepOf(tmp()), asker);
    expect(asker.asked).toEqual([]);
    expect(out.warnings.map((warning) => warning.code)).toEqual(["defs_outdated", "defs_foreign"]);
  });

  test("cancel leaves them and proposes --apply-defs", async () => {
    const calls = fakeChild(() => statusOf(defs({ changed: [".claude/agents/thinker.md"] })));
    const out = await promptDefsAfterInstall(stepOf(tmp()), fake(["cancel"]));
    expect(calls.map((call) => call.args.slice(2))).toEqual([["--defs-status", "--json"]]);
    expect(out.lines).toContain(
      "defs: left as they are; run `wip upgrade --apply-defs` to write them",
    );
    expect(out.code).toBe(EXIT.OK);
  });

  test("Ctrl+C is a cancel, not 130", async () => {
    fakeChild(() => statusOf(defs({ changed: [".claude/agents/thinker.md"] })));
    const out = await promptDefsAfterInstall(stepOf(tmp()), fake([null]));
    expect(out.lines).toContain(
      "defs: left as they are; run `wip upgrade --apply-defs` to write them",
    );
    expect(out.code).toBe(EXIT.OK);
  });

  test("the installed CLI could not compare", async () => {
    fakeChild(() => ({ status: 1, stderr: "boom" }));
    const asker = fake([]);
    const out = await promptDefsAfterInstall(stepOf(tmp()), asker);
    expect(asker.asked).toEqual([]);
    expect(out.lines).toEqual(["defs: not compared (boom); run `wip upgrade --apply-defs`"]);
    expect(out.code).toBe(EXIT.OK);
  });

  test("a failed apply warns defs_failed and exits 1", async () => {
    fakeChild((call) =>
      call.args.includes("--defs-status")
        ? statusOf(defs({ changed: [".claude/agents/thinker.md"] }))
        : { status: 3, stderr: "another tool's file" },
    );
    const out = await promptDefsAfterInstall(stepOf(tmp()), fake([""]));
    expect(out.warnings.map((warning) => warning.code)).toContain("defs_failed");
    expect(out.lines).toContain(
      "defs: not applied (another tool's file); run `wip upgrade --apply-defs`",
    );
    expect(out.code).toBe(EXIT.FINDINGS);
  });

  test("the installed package has no bin", async () => {
    const calls = fakeChild(() => ({ status: 1 }));
    const out = await promptDefsAfterInstall({ project: tmp(), root: null, entry: null }, fake([]));
    expect(out.lines).toEqual([
      "defs: not compared (the installed package has no bin to run); run `wip upgrade --apply-defs`",
    ]);
    expect(out.code).toBe(EXIT.OK);
    expect(calls).toEqual([]);
  });
});
