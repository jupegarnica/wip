import { describe, expect, test } from "bun:test";
import { EXIT } from "../../src/errors.ts";
import { itemInPlan, itemsProject, ok, useProject, wipJson } from "../helpers/items.ts";

const ctx = useProject();

describe("wip wait (F-EST-12)", () => {
  test("external and user with --next are recorded with a wait event", () => {
    const p = ctx.set(itemsProject("wait-ok"));
    itemInPlan(p);
    const body = ok(p, ["wait", "T1", "external"]);
    expect(body.item).toMatchObject({ waiting_on: "external", next: null });
    expect(body.events[0]).toMatchObject({ kind: "wait", data: { waiting_on: "external" } });
    expect(ok(p, ["wait", "T1", "user", "--next", "review the plan"]).item).toMatchObject({
      waiting_on: "user",
      next: "review the plan",
    });
  });

  test("the same wait again is a no-op", () => {
    const p = ctx.set(itemsProject("wait-same"));
    itemInPlan(p);
    ok(p, ["wait", "T1", "external"]);
    const body = ok(p, ["wait", "T1", "external"]);
    expect(body.events).toEqual([]);
  });

  test("a value outside user | external | none | agent:<a>[,<b>] is a usage error", () => {
    const p = ctx.set(itemsProject("wait-format"));
    itemInPlan(p);
    for (const bad of ["human-reviewer", "agent:", "agent:A", "agent:a,,b", "everyone"]) {
      expect(p.wip(["wait", "T1", bad]).code).toBe(EXIT.USAGE);
    }
  });

  test("user without --next or gate breaks I3, none outside the terminal phase breaks I4", () => {
    const p = ctx.set(itemsProject("wait-invariants"));
    itemInPlan(p);
    const user = wipJson(p, ["wait", "T1", "user"]);
    expect(user.code).toBe(EXIT.REJECTED);
    expect(user.body.message).toContain("I3");
    const none = wipJson(p, ["wait", "T1", "none"]);
    expect(none.code).toBe(EXIT.REJECTED);
    expect(none.body.message).toContain("I4");
  });

  test("agent:<a> needs a running run of <a> (I2), and agent:a,b is accepted with both running", () => {
    const p = ctx.set(itemsProject("wait-agents"));
    itemInPlan(p);
    expect(wipJson(p, ["wait", "T1", "agent:thinker"]).body.message).toContain("I2");
    ok(p, ["agent", "start", "T1", "thinker"]);
    ok(p, ["agent", "start", "T1", "fast"]);
    expect(ok(p, ["wait", "T1", "agent:fast,thinker"]).item).toMatchObject({
      waiting_on: "agent:fast,thinker",
    });
  });
});
