import { describe, expect, test } from "bun:test";
import { EXIT } from "../../src/errors.ts";
import { itemInPlan, itemsProject, ok, rows, tick, useProject, wipJson } from "../helpers/items.ts";

const ctx = useProject();

describe("wip archive (F-ARC-01)", () => {
  test("an idle item is archived, waits on none and leaves the open list", () => {
    const p = ctx.set(itemsProject("archive-ok"));
    itemInPlan(p);
    const body = ok(p, ["archive", "T1"]);
    expect(body.item).toMatchObject({
      status: "archived",
      waiting_on: "none",
      next: null,
      archived_at: "2026-10-30T10:00:00Z",
    });
    expect(body.events[0]).toMatchObject({ kind: "archive", phase: "plan" });
    expect(ok(p, ["state"]).data).toEqual({ items: [] });
    expect(rows(ok(p, ["state", "--archived"]), "items")).toHaveLength(1);
    expect(ok(p, ["check"]).data).toEqual({ findings: [] });
    expect(p.wip(["archive", "T1"]).stdout).toContain("already archived");
  });

  test("it is rejected with a running agent or an open gate", () => {
    const p = ctx.set(itemsProject("archive-busy"));
    itemInPlan(p);
    ok(p, ["agent", "start", "T1", "thinker"]);
    expect(wipJson(p, ["archive", "T1"]).body.message).toContain("1 running agents");
    ok(p, ["agent", "stop", "T1", "thinker", "--status", "done"]);
    ok(p, ["gate", "open", "T1", "--question", "Q"]);
    expect(p.wip(["archive", "T1"]).code).toBe(EXIT.REJECTED);
  });

  test("--force --reason stops the runs, closes the gates and records a correction", () => {
    const p = ctx.set(itemsProject("archive-force"));
    itemInPlan(p);
    ok(p, ["gate", "open", "T1", "--question", "Q"]);
    ok(p, ["gate", "close", "T1", "--answer", "go", "--next", "plan again"]);
    ok(p, ["agent", "start", "T1", "thinker"]);
    tick(30);
    const body = ok(p, ["archive", "T1", "--force", "--reason", "dropped"]);
    expect(body.events.map((e) => e.kind)).toEqual(["correction", "archive"]);
    const show = ok(p, ["show", "T1"]);
    expect(rows(show, "agent_runs")[0]).toMatchObject({
      status: "stopped",
      duration_s: 30,
    });
    expect(p.wip(["archive", "T9"]).code).toBe(EXIT.NOT_FOUND);
  });
});
