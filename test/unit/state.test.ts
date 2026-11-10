import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/errors.ts";
import { minimalFlow, putFlow } from "../helpers/defs.ts";
import { itemInPlan, itemsProject, ok, rows, useProject, wipJson } from "../helpers/items.ts";
import { makeProject } from "../helpers/project.ts";
import { loadSchema, validate } from "../helpers/schema.ts";

const STATE = loadSchema("state");
const ctx = useProject();

interface IRow {
  id: string;
  signals: { attention: boolean; incoherent: string[] };
  matches?: unknown[];
}

function ids(p: Parameters<typeof ok>[0], argv: string[] = []): string[] {
  const { code, body } = wipJson(p, ["state", ...argv]);
  expect(code).toBe(EXIT.OK);
  expect(validate(STATE, body)).toEqual([]);
  return ((body.data?.items ?? []) as IRow[]).map((i) => i.id);
}

/** T1 waits on the user with a gate, T2 runs an agent, T3 waits on external, A1 is in another flow. */
function fourItems(): Parameters<typeof ok>[0] {
  const p = ctx.set(itemsProject("state"));
  putFlow(p.dir, "minimal", minimalFlow());
  itemInPlan(p, "T1");
  ok(p, ["gate", "open", "T1", "--question", "Approve the plan?"]);
  itemInPlan(p, "T2");
  ok(p, ["agent", "start", "T2", "thinker"]);
  itemInPlan(p, "T3");
  ok(p, ["wait", "T3", "external"]);
  ok(p, ["log", "T3", "Waiting for the CI of the docs"]);
  ok(p, ["phase", "A1", "todo", "--flow", "minimal", "--wait", "external"]);
  return p;
}

describe("wip state (F-EST-16)", () => {
  test("it lists the open items by flow and ID, validated by state.json", () => {
    const p = fourItems();
    expect(ids(p)).toEqual(["A1", "T1", "T2", "T3"]);
    const body = ok(p, ["state", "--flow", "valid"]);
    const t2 = rows(body, "items")[1];
    expect(t2).toMatchObject({
      id: "T2",
      waiting_on: "agent:thinker",
      agents: [{ agent: "thinker", phase: "plan", handle: null }],
    });
  });

  test("filters: --flow, --waiting (agent matches any agent:<a>), --grep and --archived", () => {
    const p = fourItems();
    expect(ids(p, ["--flow", "minimal"])).toEqual(["A1"]);
    expect(ids(p, ["--waiting", "agent"])).toEqual(["T2"]);
    expect(ids(p, ["--waiting", "external"])).toEqual(["A1", "T3"]);
    expect(ids(p, ["--grep", "ci of THE"])).toEqual(["T3"]);
    expect(p.wip(["state", "--grep", " "]).code).toBe(EXIT.USAGE);
    ok(p, ["archive", "T3"]);
    expect(ids(p, ["--archived"])).toEqual(["T3"]);
    expect(p.wip(["state", "extra"]).code).toBe(EXIT.USAGE);
  });

  test("--attention is «your turn»: the user's wait with an open gate or a next step (F-EST-17)", () => {
    const p = fourItems();
    expect(ids(p, ["--attention"])).toEqual(["T1"]);
    ok(p, ["agent", "stop", "T2", "thinker", "--status", "needs-input"]);
    expect(ids(p, ["--attention"])).toEqual(["T1", "T2"]);
    const t1 = rows(ok(p, ["state", "--attention"]), "items")[0];
    expect(t1).toMatchObject({
      open_gates: [{ phase: "plan", question: "Approve the plan?" }],
      signals: { attention: true, incoherent: [] },
    });
  });

  test("flow_order puts the configured flows first in data.board.flows", () => {
    const p = fourItems();
    writeFileSync(
      join(p.dir, ".wip", "config.json"),
      `${JSON.stringify({ defs_dir: ".claude", flow_order: ["valid", "minimal"] }, null, 2)}\n`,
    );
    const board = ok(p, ["state"]).data?.board as { flows: { name: string }[] };
    expect(board.flows.map((f) => f.name)).toEqual(["valid", "minimal"]);
  });

  test("incoherent carries the invariants the stored item breaks", () => {
    const p = fourItems();
    const db = new Database(p.dbPath);
    db.exec("UPDATE items SET waiting_on = 'none' WHERE id = 'T3'");
    db.close();
    const rows = ok(p, ["state"]).data?.items as IRow[];
    expect(rows.find((r) => r.id === "T3")?.signals.incoherent).toEqual(["I4"]);
    expect(p.wip(["state"]).stdout).toContain("! I4");
  });

  test("data.board lists the flows' phases and columns, also when a filter hides their items", () => {
    const p = fourItems();
    const body = ok(p, ["state", "--flow", "minimal"]);
    const board = body.data?.board as { flows: Record<string, unknown>[] };
    expect(board.flows.map((f) => f.name)).toEqual(["minimal", "valid"]);
    const valid = board.flows.find((f) => f.name === "valid") as {
      source: string;
      phases: string[];
      columns: { key: string; phases: string[] }[];
    };
    expect(valid.source).toBe("file");
    expect(valid.phases).toEqual(["intake", "plan", "execute", "verify", "done"]);
    expect(valid.columns.map((c) => [c.key, c.phases])).toEqual([
      ["stage:todo", ["intake"]],
      ["stage:doing", ["plan", "execute", "verify"]],
      ["stage:closed", ["done"]],
    ]);
    // The filtered items keep their own list; the board is metadata of the flows.
    expect((body.data as { items: { id: string }[] }).items.map((i) => i.id)).toEqual(["A1"]);
  });

  test("a project with no database lists nothing and does not create it", () => {
    const p = ctx.set(makeProject("state-empty"));
    expect(p.wip(["state"]).stdout).toBe("no items\n");
    const body = ok(p, ["state"]);
    expect(body.data?.board).toEqual({ flows: [] });
    expect((body.data as { items: unknown[] }).items.length).toBe(0);
  });
});
