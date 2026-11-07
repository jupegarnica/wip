import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/errors.ts";
import { fixture, flowFile, minimalFlow, putFlow } from "../helpers/defs.ts";
import { itemInPlan, itemsProject, ok, T0, tick, useProject, wipJson } from "../helpers/items.ts";
import { count, makeProject } from "../helpers/project.ts";

const ctx = useProject();

function events(dbPath: () => import("../../src/sqlite.ts").Database, id = "T1"): number {
  const db = dbPath();
  try {
    return count(db, `SELECT count(*) AS n FROM events WHERE item_id = '${id}'`);
  } finally {
    db.close();
  }
}

describe("wip phase · creating an item (F-EST-08)", () => {
  test("--flow creates the item in the phase, with its artifact directory and a phase event", () => {
    const p = ctx.set(itemsProject("phase-create"));
    const { code, body } = wipJson(p, ["phase", "T1", "intake", "--flow", "valid"]);
    expect(code).toBe(EXIT.OK);
    expect(body.item).toMatchObject({
      id: "T1",
      flow: "valid",
      phase: "intake",
      waiting_on: "user",
      next: "continue intake",
      status: "open",
      fields: {},
      created_at: T0,
    });
    const dir = join(p.dir, ".wip", "items", "valid", "T1");
    expect(body.item?.artifact_dir).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ kind: "phase", text: "created in intake", ts: T0 });
  });

  test("without --flow it uses the only flow skill", () => {
    const p = ctx.set(makeProject("phase-only"));
    putFlow(p.dir, "minimal", minimalFlow());
    const body = ok(p, ["phase", "A1", "todo"]);
    expect(body.item).toMatchObject({ flow: "minimal", phase: "todo" });
  });

  test("without --flow and several flows it is a usage error that names them", () => {
    const p = ctx.set(itemsProject("phase-several"));
    putFlow(p.dir, "minimal", minimalFlow());
    const { code, body } = wipJson(p, ["phase", "T1", "intake"]);
    expect(code).toBe(EXIT.USAGE);
    expect(body.message).toContain("minimal, valid");
  });

  test("with no flows at all it is not found", () => {
    const p = ctx.set(makeProject("phase-none"));
    expect(p.wip(["phase", "T1", "todo"]).code).toBe(EXIT.NOT_FOUND);
  });

  test("an unknown --flow is not found", () => {
    const p = ctx.set(itemsProject("phase-unknown-flow"));
    expect(p.wip(["phase", "T1", "intake", "--flow", "nope"]).code).toBe(EXIT.NOT_FOUND);
  });

  test("the ID is checked: a path never passes, and the flow's id_pattern applies (F-EST-19)", () => {
    const p = ctx.set(itemsProject("phase-id"));
    expect(p.wip(["phase", "../x", "intake", "--flow", "valid"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["phase", "X1", "intake", "--flow", "valid"]).code).toBe(EXIT.USAGE);
    expect(existsSync(p.dbPath)).toBe(true);
    const db = p.db();
    try {
      expect(count(db, "SELECT count(*) AS n FROM items")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("a phase outside the flow is rejected (I1)", () => {
    const p = ctx.set(itemsProject("phase-i1"));
    const { code, body } = wipJson(p, ["phase", "T1", "nope", "--flow", "valid"]);
    expect(code).toBe(EXIT.REJECTED);
    expect(body.message).toContain("I1");
  });

  test("a phase whose waiting_default is agent waits on the user to launch it, with a warning", () => {
    const p = ctx.set(itemsProject("phase-default-agent"));
    ok(p, ["phase", "T1", "intake", "--flow", "valid"]);
    const body = ok(p, ["phase", "T1", "plan"]);
    expect(body.item).toMatchObject({ waiting_on: "user", next: "launch plan" });
    expect(body.warnings.map((w) => w.code)).toContain("no_agent");
  });

  test("an explicit --wait user needs a --next (I3) and an invalid --wait is a usage error", () => {
    const p = ctx.set(itemsProject("phase-wait"));
    expect(p.wip(["phase", "T1", "intake", "--flow", "valid", "--wait", "user"]).code).toBe(
      EXIT.REJECTED,
    );
    expect(p.wip(["phase", "T1", "intake", "--flow", "valid", "--wait", "bob"]).code).toBe(
      EXIT.USAGE,
    );
    const body = ok(p, ["phase", "T1", "intake", "--flow", "valid", "--wait", "external"]);
    expect(body.item).toMatchObject({ waiting_on: "external", next: null });
  });
});

describe("wip phase · transitions", () => {
  test("it moves only along next; anything else is rejected and leaves no trace", () => {
    const p = ctx.set(itemsProject("phase-next"));
    itemInPlan(p);
    const before = events(p.db);
    const { code, body } = wipJson(p, ["phase", "T1", "verify"]);
    expect(code).toBe(EXIT.REJECTED);
    expect(body.message).toContain("plan → verify");
    expect(body.message).toContain("allowed: execute");
    expect(events(p.db)).toBe(before);
    expect(ok(p, ["phase", "T1", "execute"]).item).toMatchObject({ phase: "execute" });
  });

  test("the same phase with nothing new is a no-op; with --note it records an event", () => {
    const p = ctx.set(itemsProject("phase-same"));
    itemInPlan(p);
    const before = events(p.db);
    expect(p.wip(["phase", "T1", "plan"]).stdout).toContain("no changes");
    expect(events(p.db)).toBe(before);
    const body = ok(p, ["phase", "T1", "plan", "--note", "still planning"]);
    expect(body.events[0]).toMatchObject({ kind: "phase", text: "still planning" });
  });

  test("--flow of another flow on an existing item is a usage error", () => {
    const p = ctx.set(itemsProject("phase-other-flow"));
    putFlow(p.dir, "minimal", minimalFlow());
    itemInPlan(p);
    expect(p.wip(["phase", "T1", "execute", "--flow", "minimal"]).code).toBe(EXIT.USAGE);
  });

  test("an archived item does not move", () => {
    const p = ctx.set(itemsProject("phase-archived"));
    itemInPlan(p);
    ok(p, ["archive", "T1"]);
    expect(p.wip(["phase", "T1", "execute"]).code).toBe(EXIT.REJECTED);
  });

  test("into the terminal phase it waits on none", () => {
    const p = ctx.set(itemsProject("phase-terminal"));
    itemInPlan(p);
    ok(p, ["phase", "T1", "execute"]);
    ok(p, ["phase", "T1", "verify"]);
    expect(ok(p, ["phase", "T1", "done"]).item).toMatchObject({ waiting_on: "none", next: null });
  });
});

describe("wip phase --force --reason (F-EST-09)", () => {
  test("--reason without --force, and --force without --reason, are usage errors", () => {
    const p = ctx.set(itemsProject("force-usage"));
    itemInPlan(p);
    expect(p.wip(["phase", "T1", "verify", "--reason", "x"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["phase", "T1", "verify", "--force"]).code).toBe(EXIT.USAGE);
  });

  test("without a user decision in the last 10 min it is rejected", () => {
    const p = ctx.set(itemsProject("force-none"));
    itemInPlan(p);
    const { code, body } = wipJson(p, ["phase", "T1", "verify", "--force", "--reason", "skip"]);
    expect(code).toBe(EXIT.REJECTED);
    expect(body.message).toContain("decision of the user");
  });

  test("a `user` event in the window allows it and records a correction pointing at it", () => {
    const p = ctx.set(itemsProject("force-user"));
    itemInPlan(p);
    const decision = ok(p, ["log", "T1", "skip the plan", "--kind", "user"]).events[0];
    tick(599);
    const body = ok(p, ["phase", "T1", "verify", "--force", "--reason", "user said so"]);
    expect(body.item).toMatchObject({ phase: "verify" });
    expect(body.events[0]).toMatchObject({
      kind: "correction",
      text: "user said so",
      data: { from: "plan", to: "verify", ref: decision?.id },
    });
  });

  test("a decision older than 10 min does not count", () => {
    const p = ctx.set(itemsProject("force-old"));
    itemInPlan(p);
    ok(p, ["log", "T1", "skip the plan", "--kind", "user"]);
    tick(601);
    expect(p.wip(["phase", "T1", "verify", "--force", "--reason", "late"]).code).toBe(
      EXIT.REJECTED,
    );
  });

  test("a gate close is a decision too", () => {
    const p = ctx.set(itemsProject("force-gate"));
    itemInPlan(p);
    ok(p, ["gate", "open", "T1", "--question", "Skip?"]);
    ok(p, ["gate", "close", "T1", "--answer", "Yes, go to verify"]);
    expect(ok(p, ["phase", "T1", "verify", "--force", "--reason", "gate"]).item).toMatchObject({
      phase: "verify",
    });
  });

  test("--force on an allowed transition only warns", () => {
    const p = ctx.set(itemsProject("force-unused"));
    itemInPlan(p);
    const body = ok(p, ["phase", "T1", "execute", "--force", "--reason", "x"]);
    expect(body.warnings.map((w) => w.code)).toContain("force_unused");
  });
});

describe("wip phase · from_any", () => {
  const block = [
    "```wip-flow",
    "phases:",
    "  - name: intake",
    "    next: [plan]",
    "  - name: plan",
    "    from_any: true",
    "    next: [execute]",
    "  - name: execute",
    "    next: [verify]",
    "  - name: verify",
    "    next: [done]",
    "  - name: done",
    "    kind: terminal",
    "    from_any: true",
    "```",
    "",
  ].join("\n");

  function inExecute(name: string) {
    const p = ctx.set(makeProject(name));
    putFlow(p.dir, "fa", block);
    ok(p, ["phase", "T1", "intake"]);
    ok(p, ["phase", "T1", "plan"]);
    ok(p, ["phase", "T1", "execute"]);
    return p;
  }

  function kinds(p: ReturnType<typeof inExecute>, kind: string): number {
    const db = p.db();
    try {
      return count(
        db,
        `SELECT count(*) AS n FROM events WHERE item_id = 'T1' AND kind = '${kind}'`,
      );
    } finally {
      db.close();
    }
  }

  test("a from_any phase is reachable without --force and leaves no correction", () => {
    const p = inExecute("fa-move");
    const phases = kinds(p, "phase");
    const body = ok(p, ["phase", "T1", "plan"]);
    expect(body.item).toMatchObject({ phase: "plan" });
    expect(kinds(p, "phase")).toBe(phases + 1);
    expect(kinds(p, "correction")).toBe(0);
  });

  test("out of the terminal phase it is rejected", () => {
    const p = inExecute("fa-terminal");
    ok(p, ["phase", "T1", "done"]);
    const before = events(p.db);
    const { code } = wipJson(p, ["phase", "T1", "plan"]);
    expect(code).toBe(EXIT.REJECTED);
    expect(events(p.db)).toBe(before);
  });

  test("the rejection lists the from_any phases", () => {
    const p = inExecute("fa-list");
    const { code, body } = wipJson(p, ["phase", "T1", "intake"]);
    expect(code).toBe(EXIT.REJECTED);
    expect(body.message).toContain("allowed: verify, plan, done");
  });

  test("--force on a from_any move only warns", () => {
    const p = inExecute("fa-force");
    const body = ok(p, ["phase", "T1", "plan", "--force", "--reason", "x"]);
    expect(body.warnings.map((w) => w.code)).toContain("force_unused");
    expect(kinds(p, "correction")).toBe(0);
  });
});

describe("wip phase · several terminal phases", () => {
  const block = [
    "```wip-flow",
    "phases:",
    "  - name: todo",
    "    next: [done, dropped]",
    "  - name: hub",
    "    from_any: true",
    "    next: [done]",
    "  - name: done",
    "    kind: terminal",
    "  - name: dropped",
    "    kind: terminal",
    "```",
    "",
  ].join("\n");

  function inTodo(name: string) {
    const p = ctx.set(makeProject(name));
    putFlow(p.dir, "two", block);
    ok(p, ["phase", "T1", "todo", "--flow", "two"]);
    return p;
  }

  test("into the second terminal it waits on none, and check finds no I4", () => {
    const p = inTodo("two-into");
    expect(ok(p, ["phase", "T1", "dropped"]).item).toMatchObject({
      phase: "dropped",
      waiting_on: "none",
      next: null,
    });
    expect(ok(p, ["check"]).data).toEqual({ findings: [] });
  });

  test("out of the second terminal without --force is rejected, and offers no from_any phase", () => {
    const p = inTodo("two-out");
    ok(p, ["phase", "T1", "dropped"]);
    const before = events(p.db);
    const { code, body } = wipJson(p, ["phase", "T1", "hub"]);
    expect(code).toBe(EXIT.REJECTED);
    expect(body.message).toContain("allowed: none");
    expect(events(p.db)).toBe(before);
  });
});

describe("wip phase · flows (F-NEW-04 in a write command)", () => {
  test("it records the flow's valid version and keeps using it when the file breaks", () => {
    const p = ctx.set(itemsProject("phase-stored"));
    itemInPlan(p);
    writeFileSync(flowFile(p.dir, "valid"), "broken: no block\n");
    const { code, body } = wipJson(p, ["phase", "T1", "execute"]);
    expect(code).toBe(EXIT.OK);
    expect(body.item).toMatchObject({ phase: "execute" });
    expect(body.warnings.map((w) => w.code)).toContain("flow_invalid");
  });

  test("a broken flow with no valid version makes the command exit 1", () => {
    const p = ctx.set(makeProject("phase-broken"));
    putFlow(p.dir, "broken", fixture("flows", "no-terminal"));
    expect(p.wip(["phase", "A1", "todo"]).code).toBe(EXIT.FINDINGS);
  });
});
