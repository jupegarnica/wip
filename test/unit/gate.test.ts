import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EXIT } from "../../src/errors.ts";
import { itemInPlan, itemsProject, ok, tick, useProject, wipJson } from "../helpers/items.ts";

const ctx = useProject();

function gates(body: { data: Record<string, unknown> | null }): Record<string, unknown>[] {
  return (body.data?.gates ?? []) as Record<string, unknown>[];
}

describe("wip gate open (F-GAT-01)", () => {
  test("it opens a gate in the item's phase and the item waits on the user", () => {
    const p = ctx.set(itemsProject("gate-open"));
    itemInPlan(p);
    const body = ok(p, [
      "gate",
      "open",
      "T1",
      "--question",
      "Approve the plan?",
      "--detail",
      "plan.md",
    ]);
    expect(body.item).toMatchObject({ waiting_on: "user", next: null });
    expect(body.events[0]).toMatchObject({ kind: "gate_open", phase: "plan" });
    expect(gates(ok(p, ["show", "T1"]))[0]).toMatchObject({
      phase: "plan",
      question: "Approve the plan?",
      detail_path: join(p.dir, "plan.md"),
      closed_at: null,
    });
  });

  test("one open gate per phase; another phase of the flow can have its own", () => {
    const p = ctx.set(itemsProject("gate-one"));
    itemInPlan(p);
    ok(p, ["gate", "open", "T1", "--question", "Q1"]);
    expect(p.wip(["gate", "open", "T1", "--question", "Q2"]).code).toBe(EXIT.REJECTED);
    ok(p, ["gate", "open", "T1", "verify", "--question", "Q3"]);
    expect(p.wip(["gate", "open", "T1", "nope", "--question", "Q4"]).code).toBe(EXIT.REJECTED);
  });

  test("--question is required and close options are refused", () => {
    const p = ctx.set(itemsProject("gate-usage"));
    itemInPlan(p);
    expect(p.wip(["gate", "open", "T1"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["gate", "open", "T1", "--question", "Q", "--answer", "A"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["gate", "shut", "T1"]).code).toBe(EXIT.USAGE);
  });

  test("a running agent and an open gate contradict each other (I2)", () => {
    const p = ctx.set(itemsProject("gate-agent"));
    itemInPlan(p);
    ok(p, ["agent", "start", "T1", "thinker"]);
    expect(wipJson(p, ["gate", "open", "T1", "--question", "Q"]).body.message).toContain("I2");
  });
});

describe("wip gate close (F-GAT-02)", () => {
  test("it keeps the answer and decision and leaves a next step for the coordinator", () => {
    const p = ctx.set(itemsProject("gate-close"));
    itemInPlan(p);
    ok(p, ["gate", "open", "T1", "--question", "Approve?"]);
    tick(90);
    const body = ok(p, ["gate", "close", "T1", "--answer", "Approve", "--decision", "approved"]);
    expect(body.item).toMatchObject({
      waiting_on: "user",
      next: "apply the approved of gate plan",
    });
    expect(body.events[0]).toMatchObject({ kind: "gate_close", actor: "user" });
    expect(gates(ok(p, ["show", "T1"]))[0]).toMatchObject({
      answer: "Approve",
      decision: "approved",
      closed_at: "2026-10-30T10:01:30Z",
    });
  });

  test("--next and --wait set what follows", () => {
    const p = ctx.set(itemsProject("gate-next"));
    itemInPlan(p);
    ok(p, ["gate", "open", "T1", "--question", "Approve?"]);
    expect(
      ok(p, ["gate", "close", "T1", "--answer", "Yes", "--next", "execute"]).item,
    ).toMatchObject({ waiting_on: "user", next: "execute" });
    ok(p, ["gate", "open", "T1", "--question", "Again?"]);
    expect(
      ok(p, ["gate", "close", "T1", "--answer", "Wait for CI", "--wait", "external"]).item,
    ).toMatchObject({ waiting_on: "external", next: null });
  });

  test("with two open gates the phase is required; with none it is rejected", () => {
    const p = ctx.set(itemsProject("gate-two"));
    itemInPlan(p);
    expect(p.wip(["gate", "close", "T1", "--answer", "A"]).code).toBe(EXIT.REJECTED);
    ok(p, ["gate", "open", "T1", "--question", "Q1"]);
    ok(p, ["gate", "open", "T1", "verify", "--question", "Q2"]);
    expect(p.wip(["gate", "close", "T1", "--answer", "A"]).code).toBe(EXIT.USAGE);
    expect(ok(p, ["gate", "close", "T1", "verify", "--answer", "A"]).item).toMatchObject({
      waiting_on: "user",
    });
    expect(p.wip(["gate", "close", "T1", "--answer"]).code).toBe(EXIT.USAGE);
  });
});
