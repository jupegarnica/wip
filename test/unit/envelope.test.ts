import { afterEach, describe, expect, test } from "bun:test";
import { allow, forceReason, parseArgs } from "../../src/args.ts";
import { compact, iso, now, parseIso, setClockForTests } from "../../src/clock.ts";
import { EXIT, type TExitCode, type WipError } from "../../src/errors.ts";
import { PROBES } from "../helpers/probes.ts";
import { type IProject, makeProject } from "../helpers/project.ts";
import { loadSchema, validate } from "../helpers/schema.ts";

const ENVELOPE = loadSchema("envelope");
const KEYS = ["data", "events", "item", "message", "ok", "warnings"];

let p: IProject | null = null;
afterEach(() => {
  p?.cleanup();
  p = null;
  setClockForTests(null);
});

describe("--json envelope", () => {
  test("a success has exactly ok, item, events, warnings, message and data", () => {
    p = makeProject("env-ok");
    const out = p.wip(["probe-write", "s1", "--json"], { extra: PROBES });
    expect(out.code).toBe(EXIT.OK);
    expect(out.stderr).toBe("");
    const body = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(validate(ENVELOPE, body)).toEqual([]);
    expect(Object.keys(body).sort()).toEqual(KEYS);
    expect(body.ok).toBe(true);
    expect(body.message).toBe("session s1 started");
    expect((body.events as unknown[]).length).toBe(1);
  });

  test("warnings travel in the envelope with --json and on stderr without it", () => {
    p = makeProject("env-warn");
    const body = p.json(["probe-write", "s1", "--warn"], { extra: PROBES });
    expect(validate(ENVELOPE, body)).toEqual([]);
    expect(body.warnings).toEqual([{ code: "probe", message: "careful" }]);
    const text = p.wip(["probe-write", "s2", "--warn"], { extra: PROBES });
    expect(text.stdout).toBe("session s2 started\n");
    expect(text.stderr).toBe("warning: careful\n");
  });

  test("a failure is the same envelope with ok false, the message and the exit code", () => {
    p = makeProject("env-fail");
    const cases: [string[], TExitCode][] = [
      [["frobnicate", "--json"], EXIT.USAGE],
      [["probe-write", "--bogus", "x", "--json"], EXIT.USAGE],
      [["probe-write", "--fail", "rejected", "--json"], EXIT.REJECTED],
    ];
    for (const [argv, code] of cases) {
      const out = p.wip(argv, { extra: PROBES });
      expect({ argv, code: out.code }).toEqual({ argv, code });
      const body = JSON.parse(out.stdout) as Record<string, unknown>;
      expect(validate(ENVELOPE, body)).toEqual([]);
      expect(body.ok).toBe(false);
      expect(typeof body.message).toBe("string");
      expect(body.data).toEqual({ code });
      expect(out.stderr).toStartWith("wip: ");
    }
  });

  test("without .wip/ the --json failure is exit 4 with the hint", () => {
    p = makeProject("env-root");
    const out = p.wip(["probe-write", "--json"], {
      extra: PROBES,
      env: { WIP_HOME: `${p.dir}/nowhere` },
    });
    expect(out.code).toBe(EXIT.NOT_FOUND);
    const body = JSON.parse(out.stdout) as { message: string };
    expect(body.message).toContain("wip init");
  });

  test("--json after -- is an argument, not the flag", () => {
    p = makeProject("env-dashdash");
    const out = p.wip(["probe-write", "--", "--json"], { extra: PROBES });
    expect(out.stdout).toBe("session --json started\n");
  });
});

describe("exit codes", () => {
  test("0 ok · 1 findings · 2 usage · 3 rejected · 4 not found · 10 database, and no 5", () => {
    expect(EXIT).toEqual({ OK: 0, FINDINGS: 1, USAGE: 2, REJECTED: 3, NOT_FOUND: 4, DB: 10 });
    expect(Object.values(EXIT)).not.toContain(5);
  });

  test("an unknown command is exit 2 and points at wip help", () => {
    p = makeProject("exit-unknown");
    const out = p.wip(["frobnicate"]);
    expect(out.code).toBe(EXIT.USAGE);
    expect(out.stderr).toContain("wip help");
  });

  test("`wip web` through the synchronous run() is exit 2: only the entry point serves", () => {
    p = makeProject("exit-web");
    const out = p.wip(["web", "--local"]);
    expect(out.code).toBe(EXIT.USAGE);
    expect(out.stderr).toContain("serves in the foreground");
  });
});

describe("clock (F-EST-04)", () => {
  test("times are UTC ISO with seconds and no milliseconds", () => {
    expect(iso(new Date("2026-10-20T10:14:56.789Z"))).toBe("2026-10-20T10:14:56Z");
    expect(compact(new Date("2026-10-20T10:14:56Z"))).toBe("20261020T101456Z");
    expect(iso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("the event time comes from the CLI clock, never from the caller", () => {
    setClockForTests(new Date("2026-01-02T03:04:05Z"));
    expect(iso(now())).toBe("2026-01-02T03:04:05Z");
    p = makeProject("clock");
    setClockForTests(new Date("2026-01-02T03:04:05Z"));
    const body = p.json(["probe-write", "s1"], { extra: PROBES });
    expect(body.data).toEqual({ id: "s1", ts: "2026-01-02T03:04:05Z" });
  });

  test("parseIso accepts UTC ISO only", () => {
    expect(parseIso("2026-10-20T10:14:56Z").toISOString()).toBe("2026-10-20T10:14:56.000Z");
    expect(() => parseIso("2026-10-20 10:14")).toThrow();
    expect(() => parseIso("2026-10-20T10:14:56+02:00")).toThrow();
  });
});

describe("arguments", () => {
  test("positionals, options with a value, flags and --", () => {
    const args = parseArgs(
      ["T1", "--flow", "wip", "--note=a=b", "--force", "--", "--x"],
      ["force"],
    );
    expect(args.pos).toEqual(["T1", "--x"]);
    expect(args.opts).toEqual({ flow: "wip", note: "a=b" });
    expect([...args.flags]).toEqual(["force"]);
  });

  test("usage errors: missing value, repeated option, value on a flag, unknown option", () => {
    const code = (fn: () => unknown): number | null => {
      try {
        fn();
        return null;
      } catch (err) {
        return (err as WipError).code;
      }
    };
    expect(code(() => parseArgs(["--flow"]))).toBe(EXIT.USAGE);
    expect(code(() => parseArgs(["--a", "1", "--a", "2"]))).toBe(EXIT.USAGE);
    expect(code(() => parseArgs(["--json=1"]))).toBe(EXIT.USAGE);
    expect(code(() => allow(parseArgs(["--nope", "1"]), ["flow"]))).toBe(EXIT.USAGE);
    expect(code(() => forceReason(parseArgs(["--reason", "x"])))).toBe(EXIT.USAGE);
    expect(code(() => forceReason(parseArgs(["--force"], ["force"])))).toBe(EXIT.USAGE);
    expect(forceReason(parseArgs(["--force", "--reason", "why"], ["force"]))).toBe("why");
  });
});
