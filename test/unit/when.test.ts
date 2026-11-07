import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { iso } from "../../src/clock.ts";
import { EXIT, WipError } from "../../src/errors.ts";
import { advance, localMinute, parseEvery, parseWhen, step } from "../../src/when.ts";

const NOW = new Date("2026-11-05T10:00:00Z");
let tz: string | undefined;
beforeAll(() => {
  tz = process.env.TZ;
  process.env.TZ = "Europe/Madrid";
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

function codeOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof WipError ? err.code : -1;
  }
}

const at = (raw: string, now = NOW): string => iso(parseWhen(raw, now));

describe("parseWhen", () => {
  test("UTC ISO with Z, with or without seconds", () => {
    expect(at("2026-11-06T13:00:00Z")).toBe("2026-11-06T13:00:00Z");
    expect(at("2026-11-06T13:00Z")).toBe("2026-11-06T13:00:00Z");
  });

  test("ISO with an offset, seconds optional", () => {
    expect(at("2026-11-06T14:00+01:00")).toBe("2026-11-06T13:00:00Z");
    expect(at("2026-11-06T09:30:15-05:00")).toBe("2026-11-06T14:30:15Z");
  });

  test("local YYYY-MM-DD HH:MM in the machine time zone", () => {
    expect(at("2026-11-06 14:00")).toBe("2026-11-06T13:00:00Z");
    expect(at("2027-07-01 14:00")).toBe("2027-07-01T12:00:00Z");
  });

  test("+<N>m, +<N>h, +<N>d", () => {
    expect(at("+90m")).toBe("2026-11-05T11:30:00Z");
    expect(at("+2h")).toBe("2026-11-05T12:00:00Z");
    expect(at("+1d")).toBe("2026-11-06T10:00:00Z");
  });

  test("a time that is not in the future is exit 2", () => {
    expect(codeOf(() => parseWhen("2026-11-05T09:00:00Z", NOW))).toBe(EXIT.USAGE);
    expect(codeOf(() => parseWhen("2026-11-05T10:00:00Z", NOW))).toBe(EXIT.USAGE);
    expect(codeOf(() => parseWhen("2026-11-05 10:59", NOW))).toBe(EXIT.USAGE);
    expect(() => parseWhen("2026-11-05T09:00:00Z", NOW)).toThrow("is not in the future");
  });

  test("anything else is exit 2", () => {
    for (const raw of [
      "tomorrow",
      "+0h",
      "+3w",
      "2026-11-06",
      "2026-11-06 14",
      "2026-02-30 10:00",
      "2026-11-06 24:00",
      "2026-11-06T14:00+25:00",
      "2026-11-06T14:00:00",
    ]) {
      expect(codeOf(() => parseWhen(raw, NOW))).toBe(EXIT.USAGE);
    }
  });

  test("a local time inside the spring DST gap is refused; an autumn one takes the first", () => {
    const march = new Date("2026-03-01T00:00:00Z");
    expect(codeOf(() => parseWhen("2026-03-29 02:30", march))).toBe(EXIT.USAGE);
    expect(() => parseWhen("2026-03-29 02:30", march)).toThrow("does not exist");
    const october = new Date("2026-10-01T00:00:00Z");
    expect(at("2026-10-25 02:30", october)).toBe("2026-10-25T00:30:00Z");
  });

  test("the option name goes into the message", () => {
    expect(() => parseWhen("nope", NOW, "--until")).toThrow("--until 'nope'");
  });
});

describe("parseEvery", () => {
  test("cadences pass, anything else is exit 2", () => {
    expect(parseEvery("7d")).toBe("7d");
    expect(parseEvery("30m")).toBe("30m");
    expect(codeOf(() => parseEvery("1w"))).toBe(EXIT.USAGE);
    expect(codeOf(() => parseEvery("0d"))).toBe(EXIT.USAGE);
  });
});

describe("step and advance", () => {
  test("d keeps the local hour across the 25 Oct change; h keeps absolute time", () => {
    const friday = parseWhen("2026-10-23 14:00", new Date("2026-10-01T00:00:00Z"));
    expect(iso(friday)).toBe("2026-10-23T12:00:00Z");
    const next = step(friday, "7d");
    expect(iso(next)).toBe("2026-10-30T13:00:00Z");
    expect(localMinute(next).at_local).toBe("2026-10-30 14:00");
    expect(iso(step(friday, "168h"))).toBe("2026-10-30T12:00:00Z");
  });

  test("advance skips missed occurrences and never returns a past one", () => {
    const start = new Date("2026-10-23T12:00:00Z");
    expect(iso(advance(start, "7d", new Date("2026-11-05T10:00:00Z")))).toBe(
      "2026-11-06T13:00:00Z",
    );
    expect(iso(advance(start, "1h", new Date("2026-10-23T15:30:00Z")))).toBe(
      "2026-10-23T16:00:00Z",
    );
    expect(iso(advance(start, "30m", new Date("2026-10-23T13:00:00Z")))).toBe(
      "2026-10-23T13:30:00Z",
    );
  });

  test("done early still moves one occurrence on", () => {
    const start = new Date("2026-11-06T13:00:00Z");
    expect(iso(advance(start, "7d", NOW))).toBe("2026-11-13T13:00:00Z");
  });
});

describe("localMinute", () => {
  test("at_local, weekday and a cron expression for that local minute", () => {
    expect(localMinute(new Date("2026-11-06T13:05:00Z"))).toEqual({
      at_local: "2026-11-06 14:05",
      weekday: "Fri",
      cron: "5 14 6 11 *",
    });
  });
});
