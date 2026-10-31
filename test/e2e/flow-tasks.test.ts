import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rootAt } from "../../src/env.ts";
import { EXIT } from "../../src/errors.ts";
import { type IWebServer, startWeb } from "../../src/web/server.ts";
import { wipJsonIn, wipOkIn } from "../helpers/bin.ts";
import { scratch } from "../helpers/project.ts";

// A simulated coordinator drives the default `tasks` flow with CLI commands only, as the
// `wip-coordinate` skill tells a real one to. With WIP_BIN it runs the installed binary.

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(name: string): string {
  const dir = scratch(`flow-tasks-${name}`);
  dirs.push(dir);
  return dir;
}

type TRow = Record<string, unknown>;

function rowsOf(body: { data: TRow | null }, key: string): TRow[] {
  const value = body.data?.[key];
  return Array.isArray(value) ? (value as TRow[]) : [];
}

/** Every step is followed by `wip check`, which must find nothing. */
function step(dir: string, argv: readonly string[]): ReturnType<typeof wipOkIn> {
  const body = wipOkIn(dir, argv);
  const check = wipJsonIn(dir, ["check"]);
  expect({ after: argv.join(" "), code: check.code }).toEqual({
    after: argv.join(" "),
    code: EXIT.OK,
  });
  return body;
}

function runSubagent(dir: string, id: string, agent: string, handle: string): void {
  step(dir, ["agent", "start", id, agent, "--handle", handle]);
  step(dir, ["agent", "stop", id, handle, "--status", "done", "--summary", `${agent} finished`]);
}

function artifactDir(dir: string, id: string): string {
  const shown = wipOkIn(dir, ["show", id]);
  const item = shown.item ?? undefined;
  return String(item?.artifact_dir);
}

describe("the tasks flow from intake to done with CLI commands only (§1.6)", () => {
  test("a simulated coordinator takes T1 through research, plan, execute, a red check, review and deliver", () => {
    const dir = project("t1");
    expect(wipJsonIn(dir, ["init"]).code).toBe(EXIT.OK);
    expect(wipJsonIn(dir, ["check"]).code).toBe(EXIT.OK);

    step(dir, ["session", "start", "--id", "s1"]);
    step(dir, ["phase", "T1", "intake", "--flow", "tasks"]);
    step(dir, ["set", "T1", "title=Add a README"]);
    const artifacts = artifactDir(dir, "T1");
    expect(artifacts).toBe(join(dir, ".wip", "items", "tasks", "T1"));
    writeFileSync(join(artifacts, "request.md"), "## What\n\nA README.\n\n## Context\n\nNone.\n");

    step(dir, ["phase", "T1", "research"]);
    runSubagent(dir, "T1", "thinker", "h0");

    step(dir, ["phase", "T1", "plan"]);
    step(dir, ["agent", "start", "T1", "thinker", "--phase", "plan", "--handle", "h1"]);
    writeFileSync(join(artifacts, "v1.plan.md"), "# Plan\n\n1. Write README.md.\n");
    step(dir, ["agent", "stop", "T1", "h1", "--status", "done", "--summary", "v1.plan.md"]);
    step(dir, [
      "gate",
      "open",
      "T1",
      "--question",
      "Approve v1.plan.md?",
      "--detail",
      join(artifacts, "v1.plan.md"),
    ]);
    step(dir, ["gate", "close", "T1", "--answer", "approved v1.plan.md", "--next", "execute"]);

    step(dir, ["phase", "T1", "execute"]);
    runSubagent(dir, "T1", "efficient", "h2");

    step(dir, ["phase", "T1", "check"]);
    // `fast` is not the phase's `agent:` (efficient): the coordinator may pick another generic.
    runSubagent(dir, "T1", "fast", "h3");
    // Red check: back to execute without a gate.
    step(dir, ["phase", "T1", "execute"]);
    runSubagent(dir, "T1", "efficient", "h4");
    step(dir, ["phase", "T1", "check"]);
    runSubagent(dir, "T1", "fast", "h5");

    step(dir, ["phase", "T1", "review"]);
    step(dir, ["gate", "open", "T1", "--question", "Approve the result of T1?"]);
    step(dir, ["gate", "close", "T1", "--answer", "Approve and open the pull request"]);
    step(dir, ["phase", "T1", "deliver"]);
    runSubagent(dir, "T1", "efficient", "h6");
    step(dir, ["gate", "open", "T1", "--question", "Publish v1.deliver.md?"]);
    step(dir, ["gate", "close", "T1", "--answer", "approved v1.deliver.md"]);
    step(dir, ["phase", "T1", "done"]);
    step(dir, ["archive", "T1"]);

    const shown = wipOkIn(dir, ["show", "T1"]);
    const item = shown.item as TRow;
    expect(item).toMatchObject({ id: "T1", flow: "tasks", phase: "done", title: "Add a README" });
    expect(item.status).toBe("archived");

    const runs = rowsOf(shown, "agent_runs");
    expect(runs.map((r) => r.agent)).toEqual([
      "thinker",
      "thinker",
      "efficient",
      "fast",
      "efficient",
      "fast",
      "efficient",
    ]);
    expect(runs.map((r) => r.phase)).toEqual([
      "research",
      "plan",
      "execute",
      "check",
      "execute",
      "check",
      "deliver",
    ]);
    expect(runs.every((r) => r.status === "done")).toBe(true);

    const gates = rowsOf(shown, "gates");
    expect(gates.map((g) => [g.phase, g.answer])).toEqual([
      ["plan", "approved v1.plan.md"],
      ["review", "Approve and open the pull request"],
      ["deliver", "approved v1.deliver.md"],
    ]);

    const totals = shown.data?.totals as Record<string, number>;
    const runSeconds = runs.reduce((sum, r) => sum + Number(r.duration_s), 0);
    expect(totals).toMatchObject({ runs: 7, running: 0, gates: 3, agent_seconds: runSeconds });
    expect(totals.user_wait_seconds).toBeGreaterThanOrEqual(0);

    expect(rowsOf(wipOkIn(dir, ["state"]), "items").map((i) => i.id)).toEqual(["onboarding"]);
    const archived = rowsOf(wipOkIn(dir, ["state", "--archived"]), "items");
    expect(archived.map((i) => i.id)).toEqual(["T1"]);
    expect(existsSync(join(artifacts, "request.md"))).toBe(true);
    expect(readFileSync(join(artifacts, "v1.plan.md"), "utf8")).toContain("README.md");
  });

  test("a restarted coordinator finds the live run orphaned and relaunches nothing", () => {
    const dir = project("restart");
    expect(wipJsonIn(dir, ["init"]).code).toBe(EXIT.OK);
    step(dir, ["session", "start", "--id", "s1"]);
    step(dir, ["phase", "T2", "intake", "--flow", "tasks"]);
    step(dir, ["phase", "T2", "plan"]);
    step(dir, ["agent", "start", "T2", "thinker", "--handle", "h1"]);

    step(dir, ["session", "start", "--id", "s2"]);

    const shown = wipOkIn(dir, ["show", "T2"]);
    const runs = rowsOf(shown, "agent_runs");
    expect(runs.map((r) => [r.agent, r.status])).toEqual([["thinker", "orphaned"]]);
    expect(shown.data?.totals).toMatchObject({ runs: 1, running: 0 });
  });

  test("intake goes straight to plan when the request is clear; the flow allows no shortcut past check", () => {
    const dir = project("direct");
    expect(wipJsonIn(dir, ["init"]).code).toBe(EXIT.OK);
    step(dir, ["phase", "T3", "intake", "--flow", "tasks"]);
    step(dir, ["phase", "T3", "plan"]);
    step(dir, ["phase", "T3", "execute"]);
    expect(wipJsonIn(dir, ["phase", "T3", "review"]).code).toBe(EXIT.REJECTED);
    step(dir, ["phase", "T3", "check"]);
    step(dir, ["phase", "T3", "review"]);
    step(dir, ["phase", "T3", "done"]);
    expect(wipOkIn(dir, ["show", "T3"]).item).toMatchObject({ phase: "done" });
  });
});

describe("the guided onboarding (F-NEW-08)", () => {
  let web: IWebServer | null = null;
  afterEach(() => {
    web?.stop();
    web = null;
  });

  const GUIDE_VIEW = "/view/item/tasks/onboarding/artifact/guide.md";
  const GUIDE_API = "/api/item/tasks/onboarding/artifact/guide.md";

  async function status(path: string): Promise<number> {
    return (await fetch(`http://127.0.0.1:${web?.port}${path}`)).status;
  }

  test("guide → questions → gate → done → archive, with the guide served by wip web all along", async () => {
    const dir = project("onboarding");
    expect(wipJsonIn(dir, ["init"]).code).toBe(EXIT.OK);
    expect(wipJsonIn(dir, ["check"]).code).toBe(EXIT.OK);
    const attention = rowsOf(wipOkIn(dir, ["state", "--attention"]), "items");
    expect(attention.map((i) => [i.id, i.flow, i.phase, i.waiting_on, i.title, i.next])).toEqual([
      [
        "onboarding",
        "tasks",
        "intake",
        "user",
        "Get to know wip",
        "tell the coordinator when you want to start the onboarding",
      ],
    ]);
    const guide = join(artifactDir(dir, "onboarding"), "guide.md");
    web = startWeb({ port: 0, root: rootAt(dir), local: true });

    step(dir, ["session", "start", "--id", "s1"]);
    step(dir, ["log", "onboarding", "let's start", "--kind", "user"]);
    step(dir, [
      "wait",
      "onboarding",
      "user",
      "--next",
      "read the guide and find this task on the kanban",
    ]);
    expect(await status(GUIDE_VIEW)).toBe(200);
    const served = await fetch(`http://127.0.0.1:${web.port}${GUIDE_API}`);
    expect(await served.text()).toBe(readFileSync(guide, "utf8"));

    step(dir, ["log", "onboarding", "read it", "--kind", "milestone:guide-read"]);
    step(dir, ["wait", "onboarding", "user", "--next", "close the onboarding at its gate"]);
    const question = "Close the onboarding?";
    step(dir, ["gate", "open", "onboarding", "intake", "--question", question, "--detail", guide]);
    const waiting = rowsOf(wipOkIn(dir, ["state", "--attention"]), "items");
    expect(waiting.map((i) => i.id)).toEqual(["onboarding"]);
    const kanban = (await (await fetch(`http://127.0.0.1:${web.port}/api/kanban`)).json()) as {
      open_gates: { item_id: string; question: string }[];
    };
    expect(kanban.open_gates.map((g) => [g.item_id, g.question])).toEqual([
      ["onboarding", question],
    ]);

    step(dir, [
      "gate",
      "close",
      "onboarding",
      "--answer",
      "one more question",
      "--decision",
      "change",
      "--next",
      "answer: how do I add a flow?",
    ]);
    step(dir, ["gate", "open", "onboarding", "intake", "--question", question, "--detail", guide]);
    step(dir, ["gate", "close", "onboarding", "--answer", "yes", "--decision", "approved"]);
    step(dir, ["phase", "onboarding", "done"]);
    step(dir, ["archive", "onboarding"]);
    expect(rowsOf(wipOkIn(dir, ["state", "--attention"]), "items")).toEqual([]);
    expect(await status(GUIDE_VIEW)).toBe(200);
    expect(await status(GUIDE_API)).toBe(200);

    expect(wipJsonIn(dir, ["init", "--force"]).code).toBe(EXIT.OK);
    expect(rowsOf(wipOkIn(dir, ["state"]), "items")).toEqual([]);
    const archived = rowsOf(wipOkIn(dir, ["state", "--archived"]), "items");
    expect(archived.map((i) => [i.id, i.phase])).toEqual([["onboarding", "done"]]);
  });
});
