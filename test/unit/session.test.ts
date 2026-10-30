import { describe, expect, test } from "bun:test";
import { EXIT } from "../../src/errors.ts";
import { itemInPlan, itemsProject, ok, rows, useProject } from "../helpers/items.ts";

const ctx = useProject();

describe("wip session start (F-SES-01, F-RUN-06)", () => {
  test("it opens a session and closes the previous one", () => {
    const p = ctx.set(itemsProject("session-start"));
    expect(ok(p, ["session", "start", "--id", "s1"]).data).toEqual({ session: "s1", orphaned: [] });
    ok(p, ["session", "start", "--id", "s2"]);
    const db = p.db();
    try {
      expect(
        db.query("SELECT id, ended_at IS NOT NULL AS ended FROM sessions ORDER BY id").all(),
      ).toEqual([
        { id: "s1", ended: 1 },
        { id: "s2", ended: 0 },
      ]);
    } finally {
      db.close();
    }
    expect(p.wip(["session", "start", "--id", "s2"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["session", "stop"]).code).toBe(EXIT.USAGE);
  });

  test("without --id it makes one up", () => {
    const p = ctx.set(itemsProject("session-uuid"));
    expect(ok(p, ["session", "start"]).data?.session).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("runs left running become orphaned and their items wait on the user to decide", () => {
    const p = ctx.set(itemsProject("session-orphan"));
    itemInPlan(p);
    ok(p, ["session", "start", "--id", "s1"]);
    ok(p, ["agent", "start", "T1", "thinker", "--handle", "h1"]);
    const body = ok(p, ["session", "start", "--id", "s2"]);
    expect(rows(body, "orphaned")).toHaveLength(1);
    const show = ok(p, ["show", "T1"]);
    expect(show.item).toMatchObject({
      waiting_on: "user",
      next: "relaunch plan (thinker) or decide",
    });
    expect(rows(show, "agent_runs")[0]).toMatchObject({
      status: "orphaned",
      session_id: "s1",
    });
    expect(ok(p, ["check"]).data).toEqual({ findings: [] });
  });
});
