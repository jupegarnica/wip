import { describe, expect, test } from "bun:test";
import { formatBuildInfo, parseBuildInfo } from "../../src/build-info.ts";

const AT = "2026-11-01T10:20:31Z";
const raw = (fields: Record<string, unknown>): string => JSON.stringify(fields);

describe("build info", () => {
  test("no define: the source shape and `(source)`", () => {
    const info = parseBuildInfo("0.1.0", undefined);
    expect(info).toEqual({
      version: "0.1.0",
      source: true,
      branch: null,
      commit: null,
      dirty: null,
      built_at: null,
    });
    expect(formatBuildInfo(info)).toBe("0.1.0 (source)");
  });

  test("clean, dirty, detached and no git lines", () => {
    const line = (fields: Record<string, unknown>): string =>
      formatBuildInfo(parseBuildInfo("0.1.0", raw({ built_at: AT, ...fields })));
    expect(line({ branch: "v1", commit: "d5a93ec", dirty: false })).toBe(
      `0.1.0 (v1 d5a93ec, built ${AT})`,
    );
    expect(line({ branch: "v1", commit: "d5a93ec", dirty: true })).toBe(
      `0.1.0 (v1 d5a93ec-dirty, built ${AT})`,
    );
    expect(line({ branch: null, commit: "d5a93ec", dirty: false })).toBe(
      `0.1.0 (detached d5a93ec, built ${AT})`,
    );
    expect(line({ branch: null, commit: null, dirty: null })).toBe(`0.1.0 (no git, built ${AT})`);
  });

  test("a compiled info keeps its fields", () => {
    expect(
      parseBuildInfo("0.1.0", raw({ branch: "v1", commit: "abc", dirty: true, built_at: AT })),
    ).toEqual({
      version: "0.1.0",
      source: false,
      branch: "v1",
      commit: "abc",
      dirty: true,
      built_at: AT,
    });
  });

  test("a malformed define gives the source shape and never throws", () => {
    for (const bad of [
      "not json",
      "[]",
      "null",
      "42",
      raw({ built_at: 5 }),
      raw({ branch: "v1" }),
    ]) {
      const info = parseBuildInfo("0.1.0", bad);
      expect(info.source).toBe(true);
      expect(formatBuildInfo(info)).toBe("0.1.0 (source)");
    }
    expect(
      parseBuildInfo("0.1.0", raw({ built_at: AT, branch: 1, commit: [], dirty: "yes" })),
    ).toMatchObject({ source: false, branch: null, commit: null, dirty: null });
  });
});
