import { describe, expect, test } from "bun:test";
import { EXIT } from "../../src/errors.ts";
import { itemInPlan, itemsProject, ok, useProject } from "../helpers/items.ts";

const ctx = useProject();

describe("wip log (F-EST-13)", () => {
  test("a note by default, in the item's phase", () => {
    const p = ctx.set(itemsProject("log-note"));
    itemInPlan(p);
    const body = ok(p, ["log", "T1", "looked at the repo"]);
    expect(body.events[0]).toMatchObject({
      kind: "note",
      phase: "plan",
      text: "looked at the repo",
      actor: "coordinator",
    });
  });

  test("--kind user records a decision of the user", () => {
    const p = ctx.set(itemsProject("log-user"));
    itemInPlan(p);
    const body = ok(p, ["log", "T1", "go ahead", "--kind", "user"]);
    expect(body.events[0]).toMatchObject({ kind: "user", actor: "user", text: "go ahead" });
  });

  test("--kind milestone:<name> keeps the name in data", () => {
    const p = ctx.set(itemsProject("log-milestone"));
    itemInPlan(p);
    const body = ok(p, ["log", "T1", "first draft", "--kind", "milestone:draft"]);
    expect(body.events[0]).toMatchObject({ kind: "milestone", data: { name: "draft" } });
  });

  test("other kinds, a split text and an unknown item are refused", () => {
    const p = ctx.set(itemsProject("log-errors"));
    itemInPlan(p);
    expect(p.wip(["log", "T1", "x", "--kind", "gate_close"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["log", "T1", "x", "--kind", "milestone:"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["log", "T1", "two", "words"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["log", "T9", "x"]).code).toBe(EXIT.NOT_FOUND);
  });

  test("an archived item still takes notes", () => {
    const p = ctx.set(itemsProject("log-archived"));
    itemInPlan(p);
    ok(p, ["archive", "T1"]);
    expect(ok(p, ["log", "T1", "post-mortem"]).events).toHaveLength(1);
  });
});
