import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/errors.ts";
import { flowFile, putAgent, putFlow } from "../helpers/defs.ts";
import {
  agentText,
  at,
  itemInPlan,
  itemsProject,
  ok,
  T0,
  tick,
  useProject,
  wipJson,
} from "../helpers/items.ts";
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
    ["I4", "waiting on none outside a terminal phase", "UPDATE items SET waiting_on = 'none'"],
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
    writeFileSync(flowFile(p.dir, "valid"), "no block\n");
    const { code, body } = wipJson(p, ["check"]);
    expect(code).toBe(EXIT.OK);
    expect(body.warnings.map((w) => w.code)).toEqual([
      "flow_invalid",
      "models_unset",
      "start_unset",
    ]);
    expect(p.wip(["check"]).stderr).toContain("warning: flow valid does not pass");
  });

  test("a deleted flow file with open items shows as flow_missing", () => {
    const p = ctx.set(itemsProject("check-flow-missing"));
    itemInPlan(p);
    rmSync(flowFile(p.dir, "valid"));
    const { code, body } = wipJson(p, ["check"]);
    expect(code).toBe(EXIT.OK);
    expect(body.warnings.map((w) => w.code)).toEqual([
      "flow_missing",
      "models_unset",
      "start_unset",
    ]);
  });

  test("an item whose flow has no valid version is an I1 finding", () => {
    const p = ctx.set(itemsProject("check-no-version"));
    itemInPlan(p);
    sql(p, "DELETE FROM flows");
    writeFileSync(flowFile(p.dir, "valid"), "no block\n");
    expect(findings(p)).toEqual({ code: EXIT.FINDINGS, codes: ["I1"] });
  });

  test("check is a reader: it never creates the database", () => {
    const p = ctx.set(makeProject("check-reader"));
    p.wip(["check"]);
    expect(existsSync(p.dbPath)).toBe(false);
  });
});

describe("wip check: generic agents (F-NEW-07)", () => {
  const generic = (name: string, model = ""): string =>
    `---\nname: ${name}\ndescription: generic ${name}\n${model ? `model: ${model}\n` : ""}wip: generic\n---\n\nBody.\n`;

  function modelsWarning(p: IProject): { code: number; agents: unknown } {
    const { code, body } = wipJson(p, ["check"]);
    return { code, agents: body.warnings.find((w) => w.code === "models_unset")?.agents ?? null };
  }

  test("generics without model are a models_unset warning, alphabetical, with exit 0", () => {
    const p = ctx.set(makeProject("check-models"));
    for (const name of ["wise", "fast", "thinker", "efficient"])
      putAgent(p.dir, name, generic(name));
    expect(modelsWarning(p)).toEqual({
      code: EXIT.OK,
      agents: ["efficient", "fast", "thinker", "wise"],
    });
    expect(p.wip(["check"]).stderr).toContain("warning: agents without model: efficient");
  });

  const coordinator = (name: string, model = ""): string =>
    `---\nname: ${name}\ndescription: coordinator ${name}\n${model ? `model: ${model}\n` : ""}wip: coordinator\n---\n\nBody.\n`;

  test("the coordinator by its mark joins the list in alphabetical order, and leaves it with a model", () => {
    const p = ctx.set(makeProject("check-models-coordinator"));
    for (const name of ["wise", "fast"]) putAgent(p.dir, name, generic(name));
    putAgent(p.dir, "wip", coordinator("wip"));
    expect(modelsWarning(p)).toEqual({
      code: EXIT.OK,
      agents: ["fast", "wip", "wise"],
    });
    putAgent(p.dir, "wip", coordinator("wip", "inherit"));
    expect(modelsWarning(p).agents).toEqual(["fast", "wise"]);
  });

  test("a renamed coordinator is listed by its name; a wip.md without the mark is not", () => {
    const p = ctx.set(makeProject("check-models-coordinator-foreign"));
    putAgent(p.dir, "lead", coordinator("lead"));
    putAgent(p.dir, "wip", "---\nname: wip\ndescription: another tool's coordinator\n---\n");
    expect(modelsWarning(p)).toEqual({ code: EXIT.OK, agents: ["lead"] });
  });

  test("a broken wip.md is a finding only with the coordinator mark", () => {
    const p = ctx.set(makeProject("check-coordinator-invalid"));
    putAgent(p.dir, "wip", "---\nname: wip\ndescription: [unclosed\n---\n");
    expect(wipJson(p, ["check"]).code).toBe(EXIT.OK);
    putAgent(p.dir, "wip", "---\nname: wip\ndescription: [unclosed\nwip: coordinator\n---\n");
    const { code, body } = wipJson(p, ["check"]);
    expect(code).toBe(EXIT.FINDINGS);
    const list = (body.data?.findings ?? []) as { code: string; agent: string }[];
    expect(list.map((f) => [f.code, f.agent])).toEqual([["agent_invalid", "wip"]]);
  });

  test("it lists only the generics still without model, and disappears with all four set", () => {
    const p = ctx.set(makeProject("check-models-partial"));
    putAgent(p.dir, "fast", generic("fast", "cheap"));
    putAgent(p.dir, "wise", generic("wise", '"vendor:big"'));
    putAgent(p.dir, "efficient", generic("efficient"));
    putAgent(p.dir, "thinker", generic("thinker"));
    expect(modelsWarning(p).agents).toEqual(["efficient", "thinker"]);
    putAgent(p.dir, "efficient", generic("efficient", "inherit"));
    putAgent(p.dir, "thinker", generic("thinker", "mid"));
    expect(modelsWarning(p)).toEqual({ code: EXIT.OK, agents: null });
  });

  test("an agent without wip: generic and without model is not listed", () => {
    const p = ctx.set(makeProject("check-models-custom"));
    putAgent(p.dir, "custom");
    expect(modelsWarning(p)).toEqual({ code: EXIT.OK, agents: null });
  });

  test("a generic with a broken frontmatter is an agent_invalid finding with exit 1", () => {
    const p = ctx.set(makeProject("check-agent-invalid"));
    putAgent(p.dir, "fast", "---\nname: fast\ndescription: [unclosed\nwip: generic\n---\n");
    putAgent(p.dir, "broken");
    putAgent(p.dir, "plain");
    const { code, body } = wipJson(p, ["check"]);
    expect(code).toBe(EXIT.FINDINGS);
    const list = (body.data?.findings ?? []) as { code: string; agent: string }[];
    expect(list.map((f) => [f.code, f.agent])).toEqual([
      ["agent_invalid", "broken"],
      ["agent_invalid", "fast"],
    ]);
    expect(p.wip(["check"]).stdout).toContain(
      "agent_invalid · .claude/agents/fast.md · invalid frontmatter",
    );
  });

  test("with defs_dir .claude in .wip/config.json it reads .claude/agents and ignores .agents/agents", () => {
    const p = ctx.set(makeProject("check-defs-claude"));
    writeFileSync(
      join(p.dir, ".wip", "config.json"),
      '{"defs_dir": ".claude", "harness": "claude-code"}\n',
    );
    putAgent(
      p.dir,
      "fast",
      "---\nname: fast\ndescription: [unclosed\nwip: generic\n---\n",
      ".agents",
    );
    putAgent(p.dir, "wise", generic("wise"), ".claude");
    putAgent(p.dir, "wip", coordinator("wip"), ".claude");
    putAgent(
      p.dir,
      "thinker",
      "---\nname: thinker\ndescription: [unclosed\nwip: generic\n---\n",
      ".claude",
    );
    const { code, body } = wipJson(p, ["check"]);
    expect(code).toBe(EXIT.FINDINGS);
    expect(body.warnings.find((w) => w.code === "models_unset")?.agents).toEqual(["wip", "wise"]);
    expect(p.wip(["check"]).stdout).toContain(
      "agent_invalid · .claude/agents/thinker.md · invalid frontmatter",
    );
    expect(p.wip(["check"]).stdout).not.toContain(".agents/agents/fast.md");
  });

  test("an invalid .wip/config.json is exit 3 with its path", () => {
    const p = ctx.set(makeProject("check-config-invalid"));
    writeFileSync(join(p.dir, ".wip", "config.json"), '{"defs_dir": "../elsewhere"}\n');
    const out = p.wip(["check"]);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.stderr).toContain(".wip/config.json");
  });
});

describe("poll_overdue (polling)", () => {
  const flow = [
    "```wip-flow",
    "phases:",
    "  - name: intake",
    "    next: [waiting]",
    "    waiting_default: user",
    "  - name: waiting",
    "    kind: wait",
    "    waiting_default: external",
    "    next: [done]",
    "  - name: done",
    "    kind: terminal",
    "polling:",
    "  - name: waiting",
    "    phases: [waiting]",
    "    agent: fast",
    "    cadence: 1h",
    "```",
    "",
  ].join("\n");

  test("an overdue poll is a warning with exit 0, and only without an ID", () => {
    const p = ctx.set(makeProject("check-poll"));
    putFlow(p.dir, "review", flow);
    putAgent(p.dir, "fast", agentText("fast"));
    at(T0);
    ok(p, ["phase", "q1", "intake", "--flow", "review"]);
    ok(p, ["phase", "q1", "waiting", "--next", "x"]);
    expect(wipJson(p, ["check"]).body.warnings.map((w) => w.code)).not.toContain("poll_overdue");
    tick(5401);
    const out = wipJson(p, ["check"]);
    expect(out.code).toBe(EXIT.OK);
    expect(out.body.warnings.find((w) => w.code === "poll_overdue")).toMatchObject({
      flow: "review",
      poll: "waiting",
      last_run: null,
      overdue_at: "2026-10-30T11:30:00Z",
    });
    expect(wipJson(p, ["check", "q1"]).body.warnings.map((w) => w.code)).not.toContain(
      "poll_overdue",
    );
  });
});

describe("cron_due and cron_item_closed (wip cron)", () => {
  test("a cron more than 2 minutes past warns cron_due; one tied to an archived item warns cron_item_closed", () => {
    const p = ctx.set(itemsProject("check-cron"));
    itemInPlan(p, "T1");
    ok(p, ["cron", "add", "call X", "--at", "+1h", "--item", "T1"]);
    ok(p, ["cron", "add", "later", "--at", "+3h"]);
    const codes = () => wipJson(p, ["check"]).body.warnings.map((w) => w.code);
    expect(codes()).not.toContain("cron_due");
    tick(3600 + 120);
    expect(codes()).not.toContain("cron_due");
    tick(3600 + 121);
    const out = wipJson(p, ["check"]);
    expect(out.code).toBe(EXIT.OK);
    const due = out.body.warnings.filter((w) => w.code === "cron_due");
    expect(due.map((w) => w.id)).toEqual(["c1"]);
    expect(due[0]?.message).toContain("call X");
    ok(p, ["archive", "T1", "--force", "--reason", "test", "--no-prune"]);
    const closed = wipJson(p, ["check"]).body.warnings.find((w) => w.code === "cron_item_closed");
    expect(closed).toMatchObject({ id: "c1", item: "T1" });
    expect(wipJson(p, ["check", "T2"]).body.warnings.map((w) => w.code)).not.toContain("cron_due");
  });
});
