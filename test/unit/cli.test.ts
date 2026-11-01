import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { run } from "../../src/cli.ts";
import { EXIT } from "../../src/errors.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("wip --version", () => {
  test("prints the version of package.json, marked as a source run, and exits 0", () => {
    for (const argv of [["--version"], ["-v"], ["version"]]) {
      const out = run(argv);
      expect(out.code).toBe(EXIT.OK);
      expect(out.stdout).toBe(`${pkg.version} (source)\n`);
      expect(out.stderr).toBe("");
    }
  });

  test("--json carries it in data", () => {
    const body = JSON.parse(run(["version", "--json"]).stdout) as { data: unknown };
    expect(body.data).toEqual({
      version: pkg.version,
      source: true,
      branch: null,
      commit: null,
      dirty: null,
      built_at: null,
    });
  });

  test("works as a process", () => {
    const result = Bun.spawnSync([process.execPath, CLI, "--version"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout.toString()).toBe(`${pkg.version} (source)\n`);
  });
});

describe("usage", () => {
  test("an unknown command exits 2 with the message on stderr", () => {
    const out = run(["frobnicate"]);
    expect(out.code).toBe(EXIT.USAGE);
    expect(out.stderr).toContain("unknown command 'frobnicate'");
    expect(out.stdout).toBe("");
  });

  test("an unknown command exits 2 as a process too", () => {
    const result = Bun.spawnSync([process.execPath, CLI, "frobnicate"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
  });
});
