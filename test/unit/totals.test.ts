import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { itemTotals, localDayKey, workSeconds } from "../../src/totals.ts";
import { at, itemInPlan, itemsProject, ok, useProject } from "../helpers/items.ts";

const ctx = useProject();

const date = (iso: string): Date => new Date(iso);
const days = (...keys: string[]): Set<string> => new Set(keys);

// Work time reads local days and 08:00: fixed so the tests do not depend on the runner's time zone.
let tz: string | undefined;
beforeAll(() => {
  tz = process.env.TZ;
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

describe("workSeconds", () => {
  const cases: {
    name: string;
    start: string;
    end: string;
    active: string[];
    expected: number;
  }[] = [
    {
      name: "the day of end counts from 08:00 local",
      start: "2026-10-30T10:00:00Z",
      end: "2026-10-30T12:00:00Z",
      active: ["2026-10-30"],
      expected: 7200,
    },
    {
      name: "before 08:00 on the day of end adds nothing",
      start: "2026-10-30T06:00:00Z",
      end: "2026-10-30T07:00:00Z",
      active: ["2026-10-30"],
      expected: 0,
    },
    {
      name: "8 h is the most a day adds",
      start: "2026-10-29T06:00:00Z",
      end: "2026-10-30T10:00:00Z",
      active: ["2026-10-29", "2026-10-30"],
      expected: 36_000,
    },
    {
      name: "a day without activity adds nothing",
      start: "2026-10-29T06:00:00Z",
      end: "2026-10-30T10:00:00Z",
      active: ["2026-10-29"],
      expected: 28_800,
    },
    {
      name: "the day of start counts even without activity",
      start: "2026-10-30T06:00:00Z",
      end: "2026-10-30T09:00:00Z",
      active: [],
      expected: 3600,
    },
    {
      name: "several days, only those with activity",
      start: "2026-10-26T10:00:00Z",
      end: "2026-10-30T10:00:00Z",
      active: ["2026-10-26", "2026-10-30"],
      expected: 36_000,
    },
    {
      name: "every day with activity",
      start: "2026-10-28T00:00:00Z",
      end: "2026-10-30T12:00:00Z",
      active: ["2026-10-28", "2026-10-29", "2026-10-30"],
      expected: 72_000,
    },
    {
      name: "weekends count when they have activity",
      start: "2026-10-30T06:00:00Z",
      end: "2026-11-01T10:00:00Z",
      active: ["2026-10-30", "2026-10-31", "2026-11-01"],
      expected: 64_800,
    },
    {
      name: "end at or before start is 0",
      start: "2026-10-30T12:00:00Z",
      end: "2026-10-30T10:00:00Z",
      active: ["2026-10-30"],
      expected: 0,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(workSeconds(date(c.start), date(c.end), days(...c.active))).toBe(c.expected);
    });
  }

  test("localDayKey is the local calendar day", () => {
    expect(localDayKey(date("2026-10-30T00:00:00Z"))).toBe("2026-10-30");
    expect(localDayKey(date("2026-10-30T23:59:59Z"))).toBe("2026-10-30");
  });
});

describe("workSeconds · daylight saving time in Europe/Madrid", () => {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.TZ;
    process.env.TZ = "Europe/Madrid";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });

  test("07:00→09:00 local on the day of end adds the hour after 08:00", () => {
    expect(
      workSeconds(date("2026-03-30T05:00:00Z"), date("2026-03-30T07:00:00Z"), days("2026-03-30")),
    ).toBe(3600);
  });

  test("a stretch across the change of 29 March keeps the real local hours", () => {
    // 28 March 13:00 CET → 29 March 14:00 CEST: the clocks move forward at 02:00 local.
    expect(
      workSeconds(
        date("2026-03-28T12:00:00Z"),
        date("2026-03-29T12:00:00Z"),
        days("2026-03-28", "2026-03-29"),
      ),
    ).toBe(50_400);
  });
});

describe("itemTotals · clock and work time from the database", () => {
  test("an open item grows with `at`, its end day counting from 08:00", () => {
    const p = ctx.set(itemsProject("totals-open"));
    itemInPlan(p);
    const db = p.db();
    try {
      expect(itemTotals(db, "T1", date("2026-10-30T12:00:00Z"))).toMatchObject({
        clock_seconds: 7200,
        work_seconds: 7200,
      });
      expect(itemTotals(db, "T1", date("2026-10-30T13:00:00Z"))).toMatchObject({
        clock_seconds: 10_800,
        work_seconds: 10_800,
      });
    } finally {
      db.close();
    }
  });

  test("an archived item is frozen at archived_at, whatever `at` is", () => {
    const p = ctx.set(itemsProject("totals-archived"));
    itemInPlan(p);
    at("2026-11-02T10:00:00Z");
    ok(p, ["archive", "T1"]);
    const db = p.db();
    try {
      const later = itemTotals(db, "T1", date("2026-11-05T12:00:00Z"));
      // 30 Oct 10:00 → 2 Nov 10:00 is 3 days; the work days are the creation's and the archive's.
      expect(later.clock_seconds).toBe(259_200);
      expect(later.work_seconds).toBe(36_000);
      expect(itemTotals(db, "T1", date("2026-12-01T09:00:00Z"))).toEqual(later);
    } finally {
      db.close();
    }
  });

  test("a terminal item that is not archived keeps counting, and a later log adds that day", () => {
    const p = ctx.set(itemsProject("totals-terminal"));
    itemInPlan(p);
    at("2026-10-30T15:00:00Z");
    ok(p, ["phase", "T1", "execute"]);
    ok(p, ["phase", "T1", "verify"]);
    ok(p, ["phase", "T1", "done"]);
    at("2026-11-02T11:00:00Z");
    ok(p, ["log", "T1", "still here"]);
    const db = p.db();
    try {
      const totals = itemTotals(db, "T1", date("2026-11-02T12:00:00Z"));
      // Open until `at`: 3 days and 2 h; 30 Oct capped at 8 h plus 2 Nov 08:00→12:00.
      expect(totals.clock_seconds).toBe(266_400);
      expect(totals.work_seconds).toBe(43_200);
    } finally {
      db.close();
    }
  });

  test("a clock behind leaves both totals at 0; an unknown item has neither", () => {
    const p = ctx.set(itemsProject("totals-behind"));
    itemInPlan(p);
    const db = p.db();
    try {
      expect(itemTotals(db, "T1", date("2026-10-30T09:00:00Z"))).toMatchObject({
        clock_seconds: 0,
        work_seconds: 0,
      });
      expect(itemTotals(db, "NOPE", date("2026-10-30T09:00:00Z"))).toMatchObject({
        clock_seconds: 0,
        work_seconds: 0,
      });
    } finally {
      db.close();
    }
  });

  test("the default `at` is the pinned clock", () => {
    const p = ctx.set(itemsProject("totals-clock"));
    itemInPlan(p);
    at("2026-10-30T10:17:00Z");
    const db = p.db();
    try {
      expect(itemTotals(db, "T1")).toMatchObject({ clock_seconds: 1020, work_seconds: 1020 });
    } finally {
      db.close();
    }
  });
});
