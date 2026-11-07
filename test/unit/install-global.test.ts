import { describe, expect, test } from "bun:test";
import { isAbsolute, resolve } from "node:path";
import {
  dirtyGate,
  nextSteps,
  parseArgs,
  pinWarning,
  replaceGate,
  USAGE,
} from "../../scripts/install-global.ts";

describe("install-global parseArgs", () => {
  test("--name is required", () => {
    expect(() => parseArgs([])).toThrow(USAGE);
    expect(() => parseArgs(["--allow-dirty"])).toThrow(USAGE);
  });

  test("a valid name with the defaults", () => {
    const options = parseArgs(["--name", "wip2"]);
    expect(options).toMatchObject({
      name: "wip2",
      prefix: null,
      allowDirty: false,
      replace: false,
    });
    expect(isAbsolute(options.out)).toBe(true);
  });

  test("an invalid or empty name throws the usage", () => {
    for (const name of ["Wip", "../x", "", "2wip", "a b"])
      expect(() => parseArgs(["--name", name])).toThrow(USAGE);
  });

  test("--prefix and --out resolve to absolute paths; the flags are read", () => {
    expect(
      parseArgs(["--name", "w", "--prefix", "a", "--out", "b", "--allow-dirty", "--replace"]),
    ).toMatchObject({
      prefix: resolve("a"),
      out: resolve("b"),
      allowDirty: true,
      replace: true,
    });
  });

  test("an unknown flag throws the usage", () => {
    expect(() => parseArgs(["--name", "w", "--bogus"])).toThrow(USAGE);
  });
});

describe("install-global gates", () => {
  const info = (dirty: boolean | null) => ({ branch: "v1", commit: "abc", dirty });

  test("dirtyGate", () => {
    expect(dirtyGate(info(false), false)).toBeNull();
    expect(dirtyGate(info(true), false)).toContain("uncommitted");
    expect(dirtyGate(info(null), false)).toContain("git is unusable");
    expect(dirtyGate(info(true), true)).toBeNull();
  });

  test("replaceGate", () => {
    expect(replaceGate(null, "wip2", false)).toBeNull();
    expect(replaceGate({ bin: { wip2: "bin/wip.mjs" } }, "wip2", false)).toBeNull();
    const refusal = replaceGate({ bin: { wip2: "bin/wip.mjs" } }, "wip3", false);
    expect(refusal).toContain("wip2");
    expect(refusal).toContain("--replace");
    expect(replaceGate({ bin: { wip2: "bin/wip.mjs" } }, "wip3", true)).toBeNull();
  });

  test("pinWarning", () => {
    expect(pinWarning({ wip_bin: "/a/wip2" }, "/a/wip2")).toBeNull();
    expect(pinWarning({ wip_bin: "/b/wip2" }, "/a/wip2")).toContain("/b/wip2");
    expect(pinWarning(null, "/a/wip2")).toBeNull();
    expect(pinWarning({}, "/a/wip2")).toBeNull();
  });
});

test("nextSteps names the command and the schema and is only text", () => {
  const text = nextSteps("wip2", 4);
  expect(typeof text).toBe("string");
  expect(text).toContain("wip2 check");
  expect(text).toContain("schema 4");
  expect(text).toContain("PRAGMA user_version");
});
