import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setClockForTests } from "../../src/clock.ts";
import { EXIT } from "../../src/errors.ts";
import { flowFile, minimalFlow, putAgent, putFlow } from "../helpers/defs.ts";
import { agentText, at, ok, useProject, wipJson } from "../helpers/items.ts";
import { type IProject, makeProject } from "../helpers/project.ts";

const ctx = useProject();
const T = "2026-11-01T10:00:00Z";

const FLOW_A = [
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
  "seed:",
  "  - {id: seed-a, phase: intake, title: Seed of a}",
  "```",
  "",
].join("\n");

/** Flows `a` (a poll and a seed) and `b`; a-1 has an open gate, a-2 waits, a-3 is archived, b-1 is open. */
function setup(name: string): IProject {
  const p = ctx.set(makeProject(name));
  putFlow(p.dir, "a", FLOW_A);
  putFlow(p.dir, "b", minimalFlow());
  putAgent(p.dir, "fast", agentText("fast"));
  at(T);
  ok(p, ["phase", "a-1", "intake", "--flow", "a"]);
  ok(p, ["gate", "open", "a-1", "--question", "Approve?"]);
  ok(p, ["phase", "a-2", "intake", "--flow", "a"]);
  ok(p, ["phase", "a-2", "waiting", "--next", "wait for the answer"]);
  ok(p, ["phase", "a-3", "intake", "--flow", "a"]);
  ok(p, ["archive", "a-3"]);
  ok(p, ["phase", "b-1", "todo", "--flow", "b"]);
  return p;
}

const defsHash = (dir: string): string => {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const f of readdirSync(d).sort()) {
      const full = join(d, f);
      if (statSync(full).isDirectory()) walk(full);
      else h.update(full).update(readFileSync(full));
    }
  };
  walk(join(dir, ".agents"));
  return h.digest("hex");
};

const stateIds = (p: IProject, extra: string[] = []): string[] =>
  ((ok(p, ["state", ...extra]).data?.items as { id: string }[]) ?? []).map((i) => i.id);

const view = (p: IProject, id: string): string => JSON.stringify(p.json(["show", id]));

const MSG = "flow a is disabled; enable it with wip flow enable a";

describe("wip flow disable / enable", () => {
  test("disable hides the flow", () => {
    const p = setup("fd-hide");
    const before = defsHash(p.dir);
    const out = p.wip(["flow", "disable", "a"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("a · disabled · enable it with wip flow enable a");
    expect(defsHash(p.dir)).toBe(before);
    // repeating gives the same result; enabling an enabled flow too
    const again = p.wip(["flow", "disable", "a"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("a · disabled · enable it with wip flow enable a");
    const en = p.wip(["flow", "enable", "b"]);
    expect(en.code).toBe(0);
    expect(en.stdout).toContain("b · enabled");
    for (const extra of [[], ["--attention"], ["--archived"], ["--grep", "a-"], ["--flow", "a"]]) {
      expect(stateIds(p, extra).filter((id) => id.startsWith("a-"))).toEqual([]);
      const body = ok(p, ["state", ...extra]);
      expect(body.warnings.filter((w) => w.flow === "a")).toEqual([]);
    }
    expect(stateIds(p)).toEqual(["b-1"]);
    expect(ok(p, ["check"]).warnings.filter((w) => w.flow === "a")).toEqual([]);
    expect(p.wip(["check"]).stdout).not.toContain("a-");
  });

  test("writes on a disabled flow exit 3", () => {
    const p = setup("fd-writes");
    ok(p, ["flow", "disable", "a"]);
    const shown = view(p, "a-2");
    const attempts: string[][] = [
      ["phase", "a-new", "intake", "--flow", "a"],
      ["phase", "a-2", "done"],
      ["set", "a-2", "k=v"],
      ["wait", "a-2", "user"],
      ["log", "a-2", "hello"],
      ["agent", "start", "a-2", "fast"],
      ["gate", "close", "a-1", "--answer", "ok"],
      ["gate", "open", "a-2", "--question", "q"],
      ["archive", "a-2"],
      ["poll", "record", "a", "waiting"],
      ["poll", "seen", "a", "waiting", "k"],
    ];
    for (const argv of attempts) {
      const { code, body } = wipJson(p, argv);
      expect({ argv, code, message: body.message }).toEqual({
        argv,
        code: EXIT.REJECTED,
        message: expect.stringContaining(MSG),
      });
    }
    expect(view(p, "a-2")).toBe(shown);
    expect(p.wip(["show", "a-new"]).code).toBe(EXIT.NOT_FOUND);
  });

  test("show still works with a warning and no invariant finding", () => {
    const p = setup("fd-show");
    ok(p, ["flow", "disable", "a"]);
    const body = ok(p, ["show", "a-1"]);
    expect(body.item?.id).toBe("a-1");
    expect(body.warnings.map((w) => [w.code, w.message])).toEqual([["flow_disabled", MSG]]);
    expect(body.data?.signals).toBeDefined();
    expect(p.wip(["show", "a-1"]).stdout).toContain("a-1 · a · intake");
  });

  test("check, poll due and lint leave it out", () => {
    const p = setup("fd-lint");
    ok(p, ["flow", "disable", "a"]);
    const lint = ok(p, ["flow", "lint"]);
    expect(lint.data?.disabled).toEqual(["a"]);
    expect(p.wip(["flow", "lint"]).stdout).toContain("DISABLED a");
    for (const damage of ["delete", "break"]) {
      if (damage === "delete") rmSync(flowFile(p.dir, "a"));
      else writeFileSync(flowFile(p.dir, "a"), "not a flow\n");
      const check = p.wip(["check"]);
      expect(check.code).toBe(0);
      expect(check.stdout).not.toMatch(/\ba\b/);
      const due = ok(p, ["poll", "due"]);
      expect(JSON.stringify(due.data)).not.toContain('"flow":"a"');
      expect(p.wip(["flow", "lint"]).code).toBe(0);
      expect(p.wip(["flow", "lint"]).stdout).toContain("DISABLED a");
      for (const argv of [
        ["state"],
        ["check"],
        ["flow", "lint"],
        ["poll", "due"],
        ["show", "a-1"],
      ]) {
        const out = p.wip(argv);
        expect(out.stdout + out.stderr).not.toContain("last valid version");
      }
    }
    const direct = wipJson(p, ["flow", "lint", "a"]);
    expect(direct.code).toBe(EXIT.REJECTED);
    expect(direct.body.message).toBe(MSG);
    expect(wipJson(p, ["poll", "due", "--flow", "a"]).code).toBe(EXIT.NOT_FOUND);
  });

  test("without disabling, deleting the file warns about the last valid version", () => {
    const p = setup("fd-warn");
    rmSync(flowFile(p.dir, "a"));
    expect(p.wip(["state"]).stderr + p.wip(["state"]).stdout).toContain("last valid version");
  });

  test("default flow ignores disabled flows", () => {
    const p = setup("fd-default");
    ok(p, ["flow", "disable", "a"]);
    expect(ok(p, ["phase", "x", "todo"]).item?.flow).toBe("b");
    ok(p, ["flow", "disable", "b"]);
    const none = wipJson(p, ["phase", "y", "todo"]);
    expect(none.code).toBe(EXIT.NOT_FOUND);
    expect(none.body.message).toContain("no flows in");
    expect(none.body.message).not.toMatch(/\b[ab]\b/);
  });

  test("the flag survives reloads and file changes", () => {
    const p = setup("fd-reload");
    // The file changes while the flow is active: disable reloads in write mode (the upsert) before it flags the row.
    writeFileSync(
      flowFile(p.dir, "a"),
      readFileSync(flowFile(p.dir, "a"), "utf8").replace("Flow a of the tests.", "Changed."),
    );
    ok(p, ["flow", "disable", "a"]);
    const stored = () => {
      const db = p.db();
      const r = db.query("SELECT hash, disabled FROM flows WHERE name = 'a'").get() as {
        hash: string;
        disabled: number;
      };
      db.close();
      return r;
    };
    const atDisable = stored();
    expect(atDisable.disabled).toBe(1);
    writeFileSync(
      flowFile(p.dir, "a"),
      readFileSync(flowFile(p.dir, "a"), "utf8").replace("Changed.", "Changed again."),
    );
    ok(p, ["log", "b-1", "writes load the flows"]);
    expect(wipJson(p, ["log", "a-2", "x"]).code).toBe(EXIT.REJECTED);
    const row = p.db().query("SELECT disabled FROM flows WHERE name = 'a'").get() as {
      disabled: number;
    };
    expect(row.disabled).toBe(1);
    putFlow(p.dir, "a", FLOW_A.replace("cadence: 1h", "cadence: 2h"));
    ok(p, ["log", "b-1", "again"]);
    expect(stateIds(p)).toEqual(["b-1"]);
    // A disabled flow's file is never reloaded: the stored version and the flag stay as they were at disable.
    expect(stored()).toEqual(atDisable);
  });

  test("unknown flow exits 4", () => {
    const p = setup("fd-unknown");
    expect(p.wip(["flow", "disable", "zzz"]).code).toBe(EXIT.NOT_FOUND);
    expect(p.wip(["flow", "enable", "zzz"]).code).toBe(EXIT.NOT_FOUND);
  });

  test("a flow whose file never passed lint cannot be disabled", () => {
    const p = setup("fd-nolint");
    putFlow(p.dir, "broken", "not a flow\n");
    expect(p.wip(["flow", "disable", "broken"]).code).toBe(EXIT.NOT_FOUND);
  });

  test("enable brings it back as it was", () => {
    const p = setup("fd-enable");
    const snap = () =>
      JSON.stringify([
        p.json(["state"]),
        p.json(["state", "--attention"]),
        p.json(["poll", "due"]),
        p.json(["show", "a-1"]),
        p.json(["show", "a-2"]),
      ]);
    const before = snap();
    ok(p, ["flow", "disable", "a"]);
    expect(snap()).not.toBe(before);
    const out = p.wip(["flow", "enable", "a"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("a · enabled");
    expect(snap()).toBe(before);
    expect(stateIds(p, ["--attention"])).toContain("a-1");
  });

  test("enable works with a broken or missing file and shows the active-flow warnings", () => {
    const p = setup("fd-enable-broken");
    ok(p, ["flow", "disable", "a"]);
    writeFileSync(flowFile(p.dir, "a"), "not a flow\n");
    expect(p.wip(["flow", "enable", "a"]).code).toBe(0);
    expect(ok(p, ["state"]).warnings.map((w) => w.code)).toContain("flow_invalid");
    ok(p, ["flow", "disable", "a"]);
    rmSync(flowFile(p.dir, "a"));
    expect(p.wip(["flow", "enable", "a"]).code).toBe(0);
    expect(ok(p, ["state"]).warnings.map((w) => w.code)).toContain("flow_missing");
  });

  test("session start still orphans runs of a disabled flow", () => {
    const p = setup("fd-session");
    ok(p, ["agent", "start", "a-2", "fast"]);
    ok(p, ["flow", "disable", "a"]);
    const out = ok(p, ["session", "start"]);
    expect(out.data?.orphaned).toHaveLength(1);
    const db = p.db();
    const run = db.query("SELECT status FROM agent_runs WHERE item_id = 'a-2'").get() as {
      status: string;
    };
    expect(run.status).toBe("orphaned");
    db.close();
    ok(p, ["flow", "enable", "a"]);
    expect(p.wip(["check"]).code).toBe(0);
    expect(ok(p, ["show", "a-2"]).item?.waiting_on).toBe("user");
  });

  test("enable records an active flow that was never recorded", () => {
    const p = ctx.set(makeProject("fd-unrecorded"));
    putFlow(p.dir, "a", FLOW_A);
    putAgent(p.dir, "fast", agentText("fast"));
    expect(p.wip(["flow", "enable", "a"]).code).toBe(0);
    expect(p.wip(["flow", "enable", "zzz"]).code).toBe(EXIT.NOT_FOUND);
  });

  test("flow disable|enable leave the items and the log alone", () => {
    const p = setup("fd-items");
    const shown = [view(p, "a-1"), view(p, "a-2")];
    ok(p, ["flow", "disable", "a"]);
    ok(p, ["flow", "enable", "a"]);
    expect([view(p, "a-1"), view(p, "a-2")]).toEqual(shown);
  });

  test("init seeds nothing for a disabled flow and does not enable it", () => {
    const p = ctx.set(makeProject("fd-init"));
    setClockForTests(null);
    expect(p.wip(["init"]).code).toBe(0);
    const seeded = stateIds(p);
    expect(seeded.length).toBeGreaterThan(0);
    const flow = (ok(p, ["show", seeded[0] as string]).item?.flow as string) ?? "";
    ok(p, ["flow", "disable", flow]);
    const db = new Database(p.dbPath);
    db.exec("DELETE FROM events; DELETE FROM items");
    db.close();
    expect(p.wip(["init"]).code).toBe(0);
    expect(stateIds(p)).toEqual([]);
    expect(p.wip(["flow", "lint"]).stdout).toContain(`DISABLED ${flow}`);
  });

  test("init --force after editing the file keeps the flow disabled", () => {
    const p = ctx.set(makeProject("fd-force"));
    expect(p.wip(["init"]).code).toBe(0);
    ok(p, ["flow", "disable", "tasks"]);
    appendFileSync(flowFile(p.dir, "tasks"), "\nedited by hand\n");
    expect(p.wip(["init", "--force"]).code).toBe(0);
    expect(p.wip(["flow", "lint"]).stdout).toContain("DISABLED tasks");
    rmSync(flowFile(p.dir, "tasks"));
    expect(p.wip(["flow", "lint"]).stdout).toContain("DISABLED tasks");
  });

  test("help and the usage of flow", () => {
    const p = setup("fd-help");
    const help = p.wip(["flow", "--help"]).stdout;
    expect(help).toContain("wip flow disable <flow>");
    expect(help).toContain("wip flow enable <flow>");
    expect(help).not.toContain("flow list");
    expect(p.wip(["flow", "disable"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["flow", "nope"]).code).toBe(EXIT.USAGE);
  });
});
