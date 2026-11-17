import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli.ts";
import {
  isUpgradeDefsPrompt,
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
  });

  test("cancel leaves the argv as it is", async () => {
    setUpgradeInstallForTests(npmInfo());
    const dir = initTasks();
    const out = await promptUpgradeDefs(["upgrade"], dir, env, fake(["cancel"]));
    expect(out).toEqual({ argv: ["upgrade"], code: 0 });
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
    expect(out).toEqual({ argv: null, code: 130 });
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
    });
    expect(asker.asked).toEqual([]);
  });

  test("--apply-defs with --channel is a usage error and reaches the command", async () => {
    setUpgradeInstallForTests(npmInfo());
    const dir = initTasks();
    const asker = fake([]);
    const argv = ["upgrade", "--apply-defs", "--channel", "latest"];
    expect(await promptUpgradeDefs(argv, dir, env, asker)).toEqual({ argv, code: 0 });
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
      expect(await promptUpgradeDefs(argv, dir, env, asker)).toEqual({ argv, code: 0 });
      expect(asker.asked).toEqual([]);
    }
  });
});
