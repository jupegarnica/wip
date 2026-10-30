import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli.ts";
import { COMMANDS } from "../../src/commands/help.ts";
import { EXIT } from "../../src/errors.ts";
import { scratch } from "../helpers/project.ts";

const V1 = [
  "init",
  "phase",
  "set",
  "wait",
  "log",
  "show",
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
    const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");
    const result = Bun.spawnSync([process.execPath, cli, "gate", "--help"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout.toString()).toContain("wip gate open <ID>");
  });
});
