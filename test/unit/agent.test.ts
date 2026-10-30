import { describe, expect, test } from "bun:test";
import { EXIT } from "../../src/errors.ts";
import { itemInPlan, itemsProject, ok, T0, tick, useProject, wipJson } from "../helpers/items.ts";

const ctx = useProject();

function runs(body: { data: Record<string, unknown> | null }): Record<string, unknown>[] {
  return (body.data?.agent_runs ?? []) as Record<string, unknown>[];
}

describe("wip agent start (F-RUN-01)", () => {
  test("it records a run in the item's phase and the item waits on the agent", () => {
    const p = ctx.set(itemsProject("agent-start"));
    itemInPlan(p);
    ok(p, ["session", "start", "--id", "s1"]);
    const body = ok(p, ["agent", "start", "T1", "thinker", "--handle", "task-42"]);
    expect(body.item).toMatchObject({ waiting_on: "agent:thinker", next: null });
    expect(body.events[0]).toMatchObject({
      kind: "agent_start",
      phase: "plan",
      data: { agent: "thinker", handle: "task-42" },
    });
    expect(runs(ok(p, ["show", "T1"]))[0]).toMatchObject({
      agent: "thinker",
      phase: "plan",
      handle: "task-42",
      session_id: "s1",
      status: "running",
      started_at: T0,
    });
  });

  test("any existing agent is accepted, not only the phase's agent:, and it is the one recorded", () => {
    const p = ctx.set(itemsProject("agent-other"));
    itemInPlan(p);
    ok(p, ["agent", "start", "T1", "fast"]);
    expect(runs(ok(p, ["show", "T1"]))[0]).toMatchObject({ agent: "fast", phase: "plan" });
  });

  test("an agent with no file is not found and an invalid name is a usage error", () => {
    const p = ctx.set(itemsProject("agent-missing"));
    itemInPlan(p);
    expect(p.wip(["agent", "start", "T1", "wise"]).code).toBe(EXIT.NOT_FOUND);
    expect(p.wip(["agent", "start", "T1", "../x"]).code).toBe(EXIT.USAGE);
  });

  test("--phase outside the flow is rejected (I1); two agents run at once", () => {
    const p = ctx.set(itemsProject("agent-two"));
    itemInPlan(p);
    expect(p.wip(["agent", "start", "T1", "fast", "--phase", "nope"]).code).toBe(EXIT.REJECTED);
    ok(p, ["agent", "start", "T1", "thinker"]);
    expect(ok(p, ["agent", "start", "T1", "fast"]).item).toMatchObject({
      waiting_on: "agent:thinker,fast",
    });
  });

  test("the same handle twice is a no-op with a warning", () => {
    const p = ctx.set(itemsProject("agent-handle"));
    itemInPlan(p);
    ok(p, ["agent", "start", "T1", "thinker", "--handle", "h1"]);
    const body = ok(p, ["agent", "start", "T1", "thinker", "--handle", "h1"]);
    expect(body.warnings.map((w) => w.code)).toEqual(["handle_running"]);
    expect(runs(ok(p, ["show", "T1"]))).toHaveLength(1);
  });

  test("stop options on start are refused", () => {
    const p = ctx.set(itemsProject("agent-options"));
    itemInPlan(p);
    expect(p.wip(["agent", "start", "T1", "thinker", "--status", "done"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["agent", "go", "T1", "thinker"]).code).toBe(EXIT.USAGE);
  });
});

describe("wip agent stop (F-RUN-02, F-RUN-03)", () => {
  test("the duration comes from the CLI's clock and the summary is kept", () => {
    const p = ctx.set(itemsProject("agent-stop"));
    itemInPlan(p);
    ok(p, ["agent", "start", "T1", "thinker"]);
    tick(125);
    const body = ok(p, [
      "agent",
      "stop",
      "T1",
      "thinker",
      "--status",
      "done",
      "--summary",
      "plan.md",
    ]);
    expect(body.data).toMatchObject({ duration_s: 125 });
    expect(body.events[0]).toMatchObject({
      kind: "agent_stop",
      text: "thinker done (125s): plan.md",
      data: { status: "done", duration_s: 125 },
    });
    expect(runs(ok(p, ["show", "T1"]))[0]).toMatchObject({
      status: "done",
      duration_s: 125,
      finished_at: "2026-10-30T10:02:05Z",
      summary: "plan.md",
    });
  });

  test("with no runs left the phase's waiting_default applies: agent → the user reviews it", () => {
    const p = ctx.set(itemsProject("agent-default"));
    itemInPlan(p);
    ok(p, ["agent", "start", "T1", "thinker"]);
    const body = ok(p, ["agent", "stop", "T1", "thinker", "--status", "done"]);
    expect(body.item).toMatchObject({
      waiting_on: "user",
      next: "review the result of thinker",
    });
    const withNext = ctx.get();
    ok(withNext, ["agent", "start", "T1", "thinker"]);
    expect(
      ok(withNext, ["agent", "stop", "T1", "thinker", "--status", "blocked", "--next", "unblock"])
        .item,
    ).toMatchObject({ waiting_on: "user", next: "unblock" });
  });

  test("with another run still going the item keeps waiting on it", () => {
    const p = ctx.set(itemsProject("agent-remaining"));
    itemInPlan(p);
    ok(p, ["agent", "start", "T1", "thinker"]);
    ok(p, ["agent", "start", "T1", "fast"]);
    expect(ok(p, ["agent", "stop", "T1", "fast", "--status", "done"]).item).toMatchObject({
      waiting_on: "agent:thinker",
    });
  });

  test("by handle; an agent name with two runs is ambiguous", () => {
    const p = ctx.set(itemsProject("agent-ambiguous"));
    itemInPlan(p);
    ok(p, ["agent", "start", "T1", "thinker", "--handle", "a"]);
    ok(p, ["agent", "start", "T1", "thinker", "--handle", "b"]);
    expect(p.wip(["agent", "stop", "T1", "thinker", "--status", "done"]).code).toBe(EXIT.USAGE);
    ok(p, ["agent", "stop", "T1", "a", "--status", "done"]);
    expect(ok(p, ["agent", "stop", "T1", "thinker", "--status", "done"]).item).toMatchObject({
      waiting_on: "user",
    });
  });

  test("a bad --status, no --status or no running run are refused", () => {
    const p = ctx.set(itemsProject("agent-stop-errors"));
    itemInPlan(p);
    ok(p, ["agent", "start", "T1", "thinker"]);
    expect(p.wip(["agent", "stop", "T1", "thinker", "--status", "finished"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["agent", "stop", "T1", "thinker"]).code).toBe(EXIT.USAGE);
    const none = wipJson(p, ["agent", "stop", "T1", "fast", "--status", "done"]);
    expect(none.code).toBe(EXIT.REJECTED);
  });
});
