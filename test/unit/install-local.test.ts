import { describe, expect, test } from "bun:test";
import { isAbsolute, join, resolve } from "node:path";
import { BIN_NAME, parseArgs, USAGE } from "../../scripts/install-local.ts";

describe("install-local parseArgs", () => {
  test("defaults: the binary, no prefix and an absolute out ending in dist", () => {
    const options = parseArgs([]);
    expect(options.node).toBe(false);
    expect(options.prefix).toBeNull();
    expect(isAbsolute(options.out)).toBe(true);
    expect(options.out.endsWith(`${join("/", "dist")}`)).toBe(true);
  });

  test("--prefix and --out resolve to absolute paths", () => {
    expect(parseArgs(["--prefix", "a", "--out", "b"])).toEqual({
      prefix: resolve("a"),
      out: resolve("b"),
      node: false,
    });
  });

  test("--node installs the npm package instead of the binary", () => {
    expect(parseArgs(["--node"]).node).toBe(true);
    expect(parseArgs(["--out", "b", "--node"])).toMatchObject({ node: true, out: resolve("b") });
  });

  test("an unknown flag, a flag without value and a trailing --prefix throw the usage", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(USAGE);
    expect(() => parseArgs(["--out", ""])).toThrow(USAGE);
    expect(() => parseArgs(["--out", "b", "--prefix"])).toThrow(USAGE);
  });
});

test("the installed command is wip2", () => {
  expect(BIN_NAME).toBe("wip2");
});
