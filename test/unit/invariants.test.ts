import { describe, expect, test } from "bun:test";
import { EXIT } from "../../src/errors.ts";
import { itemInPlan, itemsProject, ok, useProject, wipJson } from "../helpers/items.ts";
import { count, type IProject } from "../helpers/project.ts";

const ctx = useProject();

function snapshot(p: IProject): string {
  const db = p.db();
  try {
    const n = (sql: string): number => count(db, sql);
    const item = db.query("SELECT * FROM items WHERE id = 'T1'").get();
    return JSON.stringify({
      item,
      events: n("SELECT count(*) AS n FROM events"),
      runs: n("SELECT count(*) AS n FROM agent_runs"),
      gates: n("SELECT count(*) AS n FROM gates"),
    });
  } finally {
    db.close();
  }
}

// Each write that would leave the item breaking an invariant is exit 3 and leaves no trace.
const cases: [string, string[], string[]][] = [
  ["I1", [], ["agent", "start", "T1", "thinker", "--phase", "gone"]],
  ["I2f", [], ["phase", "T1", "plan", "--wait", "agent:Bad"]],
  ["I2", [], ["wait", "T1", "agent:thinker"]],
  ["I2", [], ["phase", "T1", "plan", "--wait", "external", "--note", "x"]],
  ["I3", [], ["phase", "T1", "plan", "--wait", "user", "--note", "x"]],
  ["I4", [], ["phase", "T1", "plan", "--wait", "none", "--note", "x"]],
];

describe("invariants on write (F-INV-01…05)", () => {
  for (const [code, , argv] of cases) {
    test(`${code}: wip ${argv.join(" ")} is refused and leaves no trace`, () => {
      const p = ctx.set(itemsProject(`inv-${code}`));
      itemInPlan(p);
      if (code === "I2" && argv[0] === "phase") ok(p, ["agent", "start", "T1", "thinker"]);
      const before = snapshot(p);
      const { code: exit, body } = wipJson(p, argv);
      expect(exit === EXIT.REJECTED || exit === EXIT.USAGE).toBe(true);
      if (exit === EXIT.REJECTED) expect(body.message).toContain(code);
      expect(snapshot(p)).toBe(before);
    });
  }

  test("a coherent sequence never trips them: check stays at 0 after every step", () => {
    const p = ctx.set(itemsProject("inv-sequence"));
    const steps: string[][] = [
      ["session", "start", "--id", "s1"],
      ["phase", "T1", "intake", "--flow", "valid"],
      ["set", "T1", "title=Readme"],
      ["phase", "T1", "plan"],
      ["agent", "start", "T1", "thinker", "--handle", "h1"],
      ["agent", "stop", "T1", "h1", "--status", "done"],
      ["gate", "open", "T1", "--question", "Approve?"],
      ["gate", "close", "T1", "--answer", "Approve", "--next", "execute"],
      ["phase", "T1", "execute"],
      ["agent", "start", "T1", "efficient"],
      ["agent", "stop", "T1", "efficient", "--status", "done"],
      ["phase", "T1", "verify"],
      ["agent", "start", "T1", "fast"],
      ["agent", "stop", "T1", "fast", "--status", "done"],
      ["gate", "open", "T1", "--question", "Ship it?"],
      ["gate", "close", "T1", "--answer", "Change the intro", "--next", "execute again"],
      ["phase", "T1", "execute"],
      ["phase", "T1", "verify"],
      ["phase", "T1", "done"],
      ["archive", "T1"],
    ];
    for (const step of steps) {
      ok(p, step);
      expect(wipJson(p, ["check"]).code).toBe(EXIT.OK);
    }
    const show = ok(p, ["show", "T1"]);
    expect(show.data?.totals).toMatchObject({ runs: 3, gates: 2 });
    expect(show.item).toMatchObject({ status: "archived", phase: "done", waiting_on: "none" });
  });
});
