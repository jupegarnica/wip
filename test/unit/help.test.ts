import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli.ts";
import { COMMANDS } from "../../src/commands/help.ts";
import { EXIT } from "../../src/errors.ts";
import { scratch } from "../helpers/project.ts";

const V1 = [
  "init",
  "upgrade",
  "phase",
  "poll",
  "cron",
  "prune",
  "set",
  "wait",
  "log",
  "show",
  "start",
  "state",
  "agent",
  "gate",
  "archive",
  "session",
  "check",
  "flow",
  "web",
  "help",
  "version",
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Help never needs a project: it runs in an empty directory and leaves it empty. */
function bare(argv: string[]) {
  const dir = scratch("help");
  dirs.push(dir);
  const out = run(argv, { cwd: dir, env: {} });
  expect(readdirSync(dir)).toEqual([]);
  return out;
}

describe("wip help", () => {
  test("the catalogue is exactly the v1 commands", () => {
    expect(COMMANDS.map((c) => c.name).sort()).toEqual([...V1].sort());
  });

  for (const argv of [["help"], ["--help"], ["-h"], []]) {
    test(`\`wip ${argv.join(" ")}\` lists every v1 command and exits 0`, () => {
      const out = bare(argv);
      expect(out.code).toBe(EXIT.OK);
      for (const name of V1) expect(out.stdout).toMatch(new RegExp(`^ {2}${name} `, "m"));
      expect(out.stdout).toContain("--json");
    });
  }

  test("`wip flow --help` lists lint, disable, enable and order", () => {
    const out = bare(["flow", "--help"]);
    expect(out.code).toBe(EXIT.OK);
    for (const line of [
      "wip flow lint [<flow>]",
      "wip flow disable <flow>",
      "wip flow enable <flow>",
      "wip flow order [<flow> … | --reset]",
    ]) {
      expect(out.stdout).toContain(line);
    }
  });

  test("--json lists the commands with their usage", () => {
    const body = JSON.parse(bare(["help", "--json"]).stdout) as {
      ok: boolean;
      data: { commands: { name: string; usage: string[] }[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.commands.map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
    for (const c of body.data.commands) expect(c.usage.length).toBeGreaterThan(0);
  });

  test("an unknown command in `wip help <cmd>` is exit 2", () => {
    expect(bare(["help", "nope"]).code).toBe(EXIT.USAGE);
  });
});

describe("<cmd> --help", () => {
  for (const name of V1) {
    test(`\`wip ${name} --help\` and \`wip help ${name}\` show its usage`, () => {
      const viaFlag = bare([name, "--help"]);
      expect(viaFlag.code).toBe(EXIT.OK);
      expect(viaFlag.stdout).toContain("Usage:");
      expect(viaFlag.stdout).toContain(name === "version" ? "wip --version" : `wip ${name}`);
      expect(bare(["help", name]).stdout).toBe(viaFlag.stdout);
    });
  }

  test("-h works too, and --help wins over invalid arguments", () => {
    expect(bare(["phase", "-h"]).code).toBe(EXIT.OK);
    expect(bare(["phase", "--bogus", "--help"]).code).toBe(EXIT.OK);
  });

  test("as a process", () => {
    const cli = join(import.meta.dir, "..", "..", "src", "main.ts");
    const result = Bun.spawnSync([process.execPath, cli, "gate", "--help"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout.toString()).toContain("wip gate open <ID>");
  });
});

describe("wip help upgrade", () => {
  test("it names the channel, the safe modes, the mod flags and the npm-only rule", () => {
    const out = bare(["help", "upgrade"]);
    expect(out.stdout).toContain("--channel latest|next");
    expect(out.stdout).toContain("--check");
    expect(out.stdout).toContain("--dry-run");
    expect(out.stdout).toContain("--kanban");
    expect(out.stdout).toContain("--no-kanban");
    expect(out.stdout).toContain("npm only");
    expect(out.stdout).toContain(".wip/backups/kanban/");
    expect(out.stdout).toContain("--apply-defs");
    expect(out.stdout).toContain("--no-defs");
    expect(out.stdout).toContain("definitions");
    expect(out.stdout).toContain(".wip/backups/defs/");
    expect(out.stdout).toContain("Apply the definitions?");
    expect(out.stdout).not.toContain("--apply-mod");
    expect(out.stdout).not.toContain("--apply-defs-after");
  });
});

describe("wip help init", () => {
  test("init help describes the Claude Code definitions folder and has no --harness", () => {
    const out = bare(["help", "init"]);
    expect(out.stdout).toContain("--global");
    expect(out.stdout).toContain("~/.claude/");
    expect(out.stdout).not.toContain("--harness");
  });

  test("it documents the Kanban mod, its two settings files and their scopes", () => {
    const out = bare(["help", "init"]);
    expect(out.stdout).toContain("--kanban");
    expect(out.stdout).toContain("--kanban-settings-file");
    expect(out.stdout).toContain(".claude/settings.json");
    expect(out.stdout).toContain(".claude/settings.local.json");
    expect(out.stdout).toContain("--scope local");
    expect(out.stdout).toContain("--scope project");
    expect(out.stdout).toContain(".wip/backups/kanban/");
    expect(out.stdout).toContain("replace");
    expect(out.stdout).toContain("Install the wip Kanban mod for Claude Code?");
    expect(out.stdout).toContain("Where does the enabledPlugins entry go?");
    expect(out.stdout).toContain("yes (the default");
    expect(out.stdout).not.toContain("no (the default");
    // The old flag name, but never as a word of its own: it is a prefix of --kanban-settings-file.
    expect(out.stdout).not.toMatch(/--kanban-settings(?![\w-])/);
    expect(out.stdout).not.toContain("CLAUDE_CODE_PLUGIN_DIRS");
  });

  test("init usage lists the flag and the option", () => {
    const out = bare(["init", "--help"]);
    expect(out.stdout).toContain("[--kanban]");
    expect(out.stdout).toContain("[--kanban-settings-file settings.json|settings.local.json]");
    expect(out.stdout).toContain("[--flows <names>]");
  });

  test("it says --yes installs the Kanban mod with the wizard's defaults", () => {
    const out = bare(["help", "init"]);
    expect(out.stdout).toContain("`--yes` installs it with the defaults the wizard shows");
    expect(out.stdout).not.toContain("no Kanban");
    expect(out.stdout).not.toContain("installs nothing");
  });

  test("init help describes five steps, the four flows and no --models", () => {
    const out = bare(["help", "init"]);
    expect(out.stdout).toContain("five steps");
    expect(out.stdout).toContain("the flows to write");
    expect(out.stdout).toContain("step 4/5");
    expect(out.stdout).toContain("fifth step");
    expect(out.stdout).toContain("`development`, `ideas`, `reports` and `tasks`");
    expect(out.stdout).toContain("--yes` without `--flows` writes all four");
    expect(out.stdout).not.toContain("four steps");
    expect(out.stdout).not.toContain("--models");
    expect(out.stdout).not.toContain("the model of fast");
    expect(out.stdout).toContain("never asks for or writes a model");
  });
});
