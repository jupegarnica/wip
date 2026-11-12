import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EXIT } from "../../src/errors.ts";
import {
  at,
  itemInPlan,
  itemsProject,
  ok,
  rows,
  T0,
  useProject,
  wipJson,
} from "../helpers/items.ts";
import { makeProject } from "../helpers/project.ts";
import { loadSchema, validate } from "../helpers/schema.ts";

const SHOW = loadSchema("show");
const ctx = useProject();

// Work time reads local days and 08:00: fixed so the totals do not depend on the runner's time zone.
let tz: string | undefined;
beforeAll(() => {
  tz = process.env.TZ;
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

describe("wip show (F-EST-14)", () => {
  test("--json follows show.json and brings the runs, gates, events, signals and totals", () => {
    const p = ctx.set(itemsProject("show-json"));
    itemInPlan(p);
    ok(p, ["set", "T1", "title=Write docs", "tags=a"]);
    ok(p, ["agent", "start", "T1", "thinker", "--handle", "h1"]);
    at("2026-10-30T10:05:00Z");
    ok(p, ["agent", "stop", "T1", "h1", "--status", "done"]);
    ok(p, ["gate", "open", "T1", "--question", "Approve?"]);
    at("2026-10-30T10:15:00Z");
    ok(p, ["gate", "close", "T1", "--answer", "Approve", "--next", "execute"]);
    ok(p, ["phase", "T1", "execute"]);
    ok(p, ["agent", "start", "T1", "efficient"]);
    at("2026-10-30T10:16:40Z");
    ok(p, ["agent", "stop", "T1", "efficient", "--status", "done"]);
    ok(p, ["gate", "open", "T1", "--question", "Ship?"]);
    at("2026-10-30T10:17:00Z");

    const { code, body } = wipJson(p, ["show", "T1"]);
    expect(code).toBe(EXIT.OK);
    expect(validate(SHOW, body)).toEqual([]);
    expect(body.item).toMatchObject({ id: "T1", title: "Write docs", fields: { tags: ["a"] } });
    expect(body.data?.totals).toEqual({
      runs: 2,
      running: 0,
      agent_seconds: 300 + 100,
      gates: 2,
      user_wait_seconds: 600 + 20,
      clock_seconds: 1020,
      work_seconds: 1020,
    });
    expect(body.data?.signals).toEqual({ attention: true, incoherent: [] });
    expect(rows(body, "agent_runs").map((r) => r.agent)).toEqual(["thinker", "efficient"]);
    expect(body.events[0]).toMatchObject({ kind: "phase", ts: T0, data: { to: "intake" } });
  });

  test("--log N keeps the last N events and --since keeps those from a time on", () => {
    const p = ctx.set(itemsProject("show-log"));
    itemInPlan(p);
    at("2026-10-30T11:00:00Z");
    ok(p, ["log", "T1", "later"]);
    expect(ok(p, ["show", "T1", "--log", "1"]).events.map((e) => e.text)).toEqual(["later"]);
    expect(ok(p, ["show", "T1", "--since", "2026-10-30T10:30:00Z"]).events).toHaveLength(1);
    expect(ok(p, ["show", "T1", "--log", "0"]).events).toEqual([]);
  });

  test("bad options are usage errors and an unknown item is not found", () => {
    const p = ctx.set(itemsProject("show-errors"));
    itemInPlan(p);
    expect(p.wip(["show", "T1", "--log", "x"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["show", "T1", "--since", "yesterday"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["show", "T1", "--log", "1", "--since", T0]).code).toBe(EXIT.USAGE);
    expect(p.wip(["show", "T9"]).code).toBe(EXIT.NOT_FOUND);
    expect(ctx.set(makeProject("show-no-db")).wip(["show", "T1"]).code).toBe(EXIT.NOT_FOUND);
  });

  test("the text form has the fields, totals, agents, gates and log", () => {
    const p = ctx.set(itemsProject("show-text"));
    itemInPlan(p);
    ok(p, ["set", "T1", "size=s"]);
    ok(p, ["gate", "open", "T1", "--question", "Approve?"]);
    const out = p.wip(["show", "T1"]).stdout;
    expect(out).toContain("T1 · valid · plan · user · open");
    expect(out).toContain("size: s");
    expect(out).toContain("totals: 0 runs");
    expect(out).toContain("clock 0s");
    expect(out).toContain("work 0s");
    expect(out).toContain("## Gates");
    expect(out).toContain("## Log");
  });
});

describe("wip show · crons", () => {
  test("data.crons has the item's open crons and the text a Cron line", () => {
    const p = ctx.set(itemsProject("show-cron"));
    itemInPlan(p);
    ok(p, [
      "cron",
      "add",
      "ping the reviewer",
      "--at",
      "2026-10-31T09:00:00Z",
      "--item",
      "T1",
      "--every",
      "1d",
    ]);
    ok(p, ["cron", "add", "done one", "--at", "+1h", "--item", "T1"]);
    ok(p, ["cron", "done", "c2"]);
    ok(p, ["cron", "add", "other", "--at", "+1h"]);
    const { code, body } = wipJson(p, ["show", "T1"]);
    expect(code).toBe(EXIT.OK);
    expect(validate(SHOW, body)).toEqual([]);
    expect(rows(body, "crons").map((c) => [c.id, c.at, c.every])).toEqual([
      ["c1", "2026-10-31T09:00:00Z", "1d"],
    ]);
    const local = rows(body, "crons")[0]?.at_local;
    expect(p.wip(["show", "T1"]).stdout).toContain(
      `Cron: c1 · ${local} · ping the reviewer · every 1d`,
    );
  });
});
