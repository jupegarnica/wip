import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/errors.ts";
import { itemInPlan, itemsProject, ok, useProject, wipJson } from "../helpers/items.ts";
import type { IProject } from "../helpers/project.ts";
import { makeProject } from "../helpers/project.ts";

const ctx = useProject();

/** Corrupts the stored state by hand, the way nothing in the CLI can. */
function sql(p: IProject, statement: string): void {
  const db = new Database(p.dbPath);
  try {
    db.exec(statement);
  } finally {
    db.close();
  }
}

function findings(p: IProject, argv: string[] = []): { code: number; codes: string[] } {
  const { code, body } = wipJson(p, ["check", ...argv]);
  const list = (body.data?.findings ?? []) as { code: string }[];
  return { code, codes: list.map((f) => f.code) };
}

describe("wip check (F-INV-08)", () => {
  test("a coherent project, and a project with no database yet, are OK with exit 0", () => {
    const empty = ctx.set(makeProject("check-empty"));
    expect(empty.wip(["check"]).stdout).toBe("OK: no findings\n");
    expect(empty.wip(["check", "T1"]).code).toBe(EXIT.NOT_FOUND);
  });

  const cases: [string, string, string][] = [
    ["I1", "phase outside the flow", "UPDATE items SET phase = 'gone'"],
    ["I2f", "waiting_on outside its format", "UPDATE items SET waiting_on = 'bob'"],
    ["I2", "waiting on an agent with no running run", "UPDATE items SET waiting_on = 'agent:fast'"],
    ["I3", "waiting on the user with no gate nor next", "UPDATE items SET next = NULL"],
    ["I4", "waiting on none before the terminal phase", "UPDATE items SET waiting_on = 'none'"],
  ];
  for (const [code, what, statement] of cases) {
    test(`${code}: ${what} is a finding with exit 1 (F-INV-01…05)`, () => {
      const p = ctx.set(itemsProject(`check-${code}`));
      itemInPlan(p);
      expect(findings(p)).toEqual({ code: EXIT.OK, codes: [] });
      sql(p, statement);
      const out = p.wip(["check"]);
      expect(out.code).toBe(EXIT.FINDINGS);
      expect(out.stdout).toContain(`${code} · T1 · `);
      expect(findings(p, ["T1"]).codes).toContain(code);
    });
  }

  test("I2 the other way round: a running run while the item waits on someone else", () => {
    const p = ctx.set(itemsProject("check-I2-run"));
    itemInPlan(p);
    ok(p, ["agent", "start", "T1", "thinker"]);
    sql(p, "UPDATE items SET waiting_on = 'external'");
    expect(findings(p).codes).toEqual(["I2"]);
  });

  test("only open items are checked unless one is named", () => {
    const p = ctx.set(itemsProject("check-archived"));
    itemInPlan(p);
    ok(p, ["archive", "T1"]);
    sql(p, "UPDATE items SET phase = 'gone'");
    expect(findings(p).codes).toEqual([]);
    expect(findings(p, ["T1"]).codes).toEqual(["I1"]);
  });

  test("a broken flow file shows as flow_invalid without changing the exit code (F-NEW-04)", () => {
    const p = ctx.set(itemsProject("check-flow-invalid"));
    itemInPlan(p);
    writeFileSync(join(p.dir, ".agents", "flows", "valid.md"), "no block\n");
    const { code, body } = wipJson(p, ["check"]);
    expect(code).toBe(EXIT.OK);
    expect(body.warnings.map((w) => w.code)).toEqual(["flow_invalid"]);
    expect(p.wip(["check"]).stderr).toContain("warning: flow valid does not pass");
  });

  test("a deleted flow file with open items shows as flow_missing", () => {
    const p = ctx.set(itemsProject("check-flow-missing"));
    itemInPlan(p);
    rmSync(join(p.dir, ".agents", "flows", "valid.md"));
    const { code, body } = wipJson(p, ["check"]);
    expect(code).toBe(EXIT.OK);
    expect(body.warnings.map((w) => w.code)).toEqual(["flow_missing"]);
  });

  test("an item whose flow has no valid version is an I1 finding", () => {
    const p = ctx.set(itemsProject("check-no-version"));
    itemInPlan(p);
    sql(p, "DELETE FROM flows");
    writeFileSync(join(p.dir, ".agents", "flows", "valid.md"), "no block\n");
    expect(findings(p)).toEqual({ code: EXIT.FINDINGS, codes: ["I1"] });
  });

  test("check is a reader: it never creates the database", () => {
    const p = ctx.set(makeProject("check-reader"));
    p.wip(["check"]);
    expect(existsSync(p.dbPath)).toBe(false);
  });
});
