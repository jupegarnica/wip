import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { EXIT_OK, EXIT_USAGE, type IOutput, run } from "../../src/cli.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

function capture(): IOutput & { stdout: string; stderr: string } {
  const sink = {
    stdout: "",
    stderr: "",
    out: (text: string) => {
      sink.stdout += text;
    },
    err: (text: string) => {
      sink.stderr += text;
    },
  };
  return sink;
}

describe("wip --version", () => {
  test("prints the version of package.json and exits 0", () => {
    const io = capture();
    expect(run(["--version"], io)).toBe(EXIT_OK);
    expect(io.stdout).toBe(`${pkg.version}\n`);
    expect(io.stderr).toBe("");
  });

  test("works as a process", () => {
    const result = Bun.spawnSync([process.execPath, CLI, "--version"]);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout.toString()).toBe(`${pkg.version}\n`);
  });
});

describe("usage", () => {
  test("an unknown command exits 2 with the usage on stderr", () => {
    const io = capture();
    expect(run(["frobnicate"], io)).toBe(EXIT_USAGE);
    expect(io.stderr).toContain("unknown command 'frobnicate'");
    expect(io.stdout).toBe("");
  });

  test("--help prints the usage and exits 0", () => {
    const io = capture();
    expect(run(["--help"], io)).toBe(EXIT_OK);
    expect(io.stdout).toContain("wip --version");
  });
});
