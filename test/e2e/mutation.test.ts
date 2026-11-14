import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probe } from "../../src/commands/web.ts";
import { EXIT } from "../../src/errors.ts";
import { WIP_CMD, wipJsonIn, wipOkIn } from "../helpers/bin.ts";
import { scratch } from "../helpers/project.ts";

// The coordinator creates and edits a flow the way `wip-new-flow` says: backup, write, `wip flow lint`,
// restore on failure. With WIP_TEST_BIN every command runs the installed binary.

const REPO = join(import.meta.dir, "..", "..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type TRow = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: JSON bodies of the web API
type TJson = any;

const REVIEW_PHASES = [
  "version: 1",
  "fields:",
  "  title: string",
  "phases:",
  "  - name: intake",
  "    gate: none",
  "    next: [review]",
  "    waiting_default: user",
  "  - name: review",
  "    gate: ask",
  "    next: [fix, done]",
  "    agent: thinker",
  "    writes: artifacts",
  "  - name: fix",
  "    gate: auto",
  "    next: [review]",
  "    agent: efficient",
  "    writes: project",
  "  - name: done",
  "    kind: terminal",
];

function withBlock(flowText: string, lines: readonly string[]): string {
  return flowText.replace(
    /```wip-flow\n[\s\S]*?```/,
    `\`\`\`wip-flow\n${lines.join("\n")}\n\`\`\``,
  );
}

interface IFlowProject {
  dir: string;
  review: string;
  edit: (lines: readonly string[]) => string;
  backup: () => string;
  restore: (backup: string) => void;
}

/** `wip init`, then the skill `wip-flow-review` copied from `wip-flow-tasks` with its name and other phases. */
function flowProject(name: string): IFlowProject {
  const dir = scratch(`mutation-${name}`);
  dirs.push(dir);
  expect(wipJsonIn(dir, ["init"]).code).toBe(EXIT.OK);
  const skills = join(dir, ".claude", "skills");
  mkdirSync(join(skills, "wip-flow-review"));
  const review = join(skills, "wip-flow-review", "SKILL.md");
  const template = readFileSync(join(skills, "wip-flow-tasks", "SKILL.md"), "utf8")
    .replace("name: wip-flow-tasks", "name: wip-flow-review")
    .replace("wip: flow\n", "");
  writeFileSync(review, withBlock(template, REVIEW_PHASES));
  let n = 0;
  return {
    dir,
    review,
    edit: (lines) => {
      writeFileSync(review, withBlock(readFileSync(review, "utf8"), lines));
      return review;
    },
    backup: () => {
      const backups = join(dir, ".wip", "backups", "defs", "skills", "wip-flow-review");
      mkdirSync(backups, { recursive: true });
      const path = join(backups, `SKILL.md.2026103${n++}T120000Z`);
      copyFileSync(review, path);
      return path;
    },
    restore: (backup) => copyFileSync(backup, review),
  };
}

function lint(dir: string, flow?: string): { code: number; flows: TRow[] } {
  const out = wipJsonIn(dir, flow ? ["flow", "lint", flow] : ["flow", "lint"]);
  return { code: out.code, flows: (out.body.data?.flows as TRow[] | undefined) ?? [] };
}

function problems(dir: string, flow: string): string[] {
  const found = lint(dir, flow).flows.find((f) => f.name === flow);
  return (found?.problems as string[] | undefined) ?? [];
}

function itemIds(body: { data: TRow | null }): string[] {
  return ((body.data?.items as TRow[] | undefined) ?? []).map((i) => String(i.id));
}

function phaseOf(dir: string, id: string): unknown {
  return wipOkIn(dir, ["show", id]).item?.phase;
}

describe("a new flow created by copying the tasks flow skill (§1.7)", () => {
  test("lints, takes an item and shows in `state --flow` next to tasks", () => {
    const p = flowProject("new");
    expect(lint(p.dir)).toMatchObject({ code: EXIT.OK });
    expect(lint(p.dir).flows.map((f) => [f.name, f.ok])).toEqual([
      ["development", true],
      ["ideas", true],
      ["reports", true],
      ["review", true],
      ["tasks", true],
    ]);

    wipOkIn(p.dir, ["phase", "R1", "intake", "--flow", "review"]);
    wipOkIn(p.dir, ["phase", "R1", "review"]);
    wipOkIn(p.dir, ["phase", "W1", "todo", "--flow", "tasks"]);

    expect(itemIds(wipOkIn(p.dir, ["state", "--flow", "review"]))).toEqual(["R1"]);
    expect(itemIds(wipOkIn(p.dir, ["state", "--flow", "tasks"]))).toEqual(["W1", "onboarding"]);
    expect(wipJsonIn(p.dir, ["check"]).code).toBe(EXIT.OK);
  });

  test("a broken edit fails the lint while commands keep the last valid version (F-NEW-04)", () => {
    const p = flowProject("broken");
    wipOkIn(p.dir, ["phase", "R1", "intake", "--flow", "review"]);
    wipOkIn(p.dir, ["phase", "R1", "review"]);

    const backup = p.backup();
    p.edit(REVIEW_PHASES.map((l) => (l === "    next: [review]" ? "    next: [nowhere]" : l)));
    expect(lint(p.dir, "review").code).toBe(EXIT.FINDINGS);
    expect(problems(p.dir, "review").join("\n")).toContain("nowhere");

    const state = wipJsonIn(p.dir, ["state", "--flow", "review"]);
    expect(state.code).toBe(EXIT.OK);
    expect(state.body.warnings.map((w) => w.code)).toContain("flow_invalid");
    wipOkIn(p.dir, ["phase", "R1", "done"]);
    expect(phaseOf(p.dir, "R1")).toBe("done");
    expect(wipJsonIn(p.dir, ["check"]).code).toBe(EXIT.OK);

    p.restore(backup);
    expect(lint(p.dir, "review").code).toBe(EXIT.OK);
    const fixed = wipJsonIn(p.dir, ["state", "--flow", "review"]);
    expect(fixed.body.warnings.map((w) => w.code)).not.toContain("flow_invalid");
  });

  test("a new agent becomes a phase's `agent:` and runs in it", () => {
    const p = flowProject("agent");
    writeFileSync(
      join(p.dir, ".claude", "agents", "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Reviews a change against the request and lists what is missing.",
        "tools: Read, Bash, Grep, Glob",
        "model: inherit",
        "---",
        "",
        "Review the change.",
        "",
      ].join("\n"),
    );
    p.edit(REVIEW_PHASES.map((l) => (l === "    agent: thinker" ? "    agent: reviewer" : l)));
    expect(readFileSync(p.review, "utf8")).toContain("agent: reviewer");
    expect(lint(p.dir, "review").code).toBe(EXIT.OK);

    wipOkIn(p.dir, ["phase", "R2", "intake", "--flow", "review"]);
    wipOkIn(p.dir, ["phase", "R2", "review"]);
    wipOkIn(p.dir, ["agent", "start", "R2", "reviewer", "--handle", "h1"]);
    wipOkIn(p.dir, ["agent", "stop", "R2", "h1", "--status", "done"]);
    const runs = wipOkIn(p.dir, ["show", "R2"]).data?.agent_runs as TRow[];
    expect(runs.map((r) => [r.agent, r.phase, r.status])).toEqual([["reviewer", "review", "done"]]);

    p.edit(REVIEW_PHASES.map((l) => (l === "    agent: thinker" ? "    agent: nobody" : l)));
    expect(lint(p.dir, "review").code).toBe(EXIT.FINDINGS);
    expect(problems(p.dir, "review").join("\n")).toContain("nobody");
  });

  test("removing a phase that holds a live item, or `writes: everything`, fails the lint", () => {
    const p = flowProject("occupied");
    wipOkIn(p.dir, ["phase", "R3", "intake", "--flow", "review"]);
    wipOkIn(p.dir, ["phase", "R3", "review"]);
    wipOkIn(p.dir, ["phase", "R3", "fix"]);
    const backup = p.backup();

    const fixStart = REVIEW_PHASES.indexOf("  - name: fix");
    const withoutFix = REVIEW_PHASES.slice(0, fixStart)
      .concat(REVIEW_PHASES.slice(fixStart + 5))
      .map((l) => (l === "    next: [fix, done]" ? "    next: [done]" : l));
    expect(withoutFix.some((l) => l.includes("fix"))).toBe(false);
    p.edit(withoutFix);
    expect(lint(p.dir, "review").code).toBe(EXIT.FINDINGS);
    expect(problems(p.dir, "review").join("\n")).toContain("R3");
    expect(wipJsonIn(p.dir, ["check"]).code).toBe(EXIT.OK);
    expect(phaseOf(p.dir, "R3")).toBe("fix");

    p.restore(backup);
    p.edit(REVIEW_PHASES.map((l) => (l === "    writes: project" ? "    writes: everything" : l)));
    expect(lint(p.dir, "review").code).toBe(EXIT.FINDINGS);
    expect(problems(p.dir, "review").join("\n")).toContain("everything");

    p.restore(backup);
    expect(lint(p.dir).code).toBe(EXIT.OK);
  });
});

async function freePort(): Promise<number> {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

describe("wip web over both flows (§1.8)", () => {
  test("the kanban shows the tasks and review columns, your turn, gates and running agents", async () => {
    const p = flowProject("web");
    wipOkIn(p.dir, ["phase", "W1", "todo", "--flow", "tasks"]);
    wipOkIn(p.dir, ["phase", "W1", "doing"]);
    wipOkIn(p.dir, ["agent", "start", "W1", "thinker", "--handle", "h1"]);
    wipOkIn(p.dir, ["phase", "R1", "intake", "--flow", "review"]);
    wipOkIn(p.dir, ["phase", "R1", "review"]);
    wipOkIn(p.dir, ["gate", "open", "R1", "--question", "Approve the review?"]);
    wipOkIn(p.dir, ["wait", "R1", "user", "--next", "answer the gate"]);

    const port = await freePort();
    const args = ["web", "--port", String(port), "--local"];
    const cmd = [...(WIP_CMD ?? [process.execPath, join(REPO, "src", "main.ts")]), ...args];
    const proc = Bun.spawn(cmd, {
      cwd: p.dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        up = (await probe(port, 200)).kind === "wip";
        if (!up) await Bun.sleep(50);
      }
      expect(up).toBe(true);
      const kanban = (await (await fetch(`http://127.0.0.1:${port}/api/kanban`)).json()) as TJson;
      const columns = Object.fromEntries(
        kanban.flows.map((f: TJson) => [f.name, f.columns.flatMap((c: TJson) => c.phases)]),
      );
      expect(columns).toEqual({
        development: [
          "backlog",
          "plan",
          "worktree",
          "build",
          "qa-plan",
          "qa-exec",
          "human-review",
          "commit",
          "release",
          "close",
        ],
        ideas: ["initial", "refine", "final", "will", "done", "discarded"],
        reports: ["request", "plan", "search", "check", "report", "review", "waiting", "done"],
        review: ["intake", "review", "fix", "done"],
        tasks: ["todo", "doing", "done", "closed"],
      });
      const tasks = kanban.flows.find((f: TJson) => f.name === "tasks");
      expect(tasks.columns.map((c: TJson) => [c.label, c.alpha])).toEqual([
        ["todo", null],
        ["doing", null],
        ["done", null],
        ["closed", null],
      ]);
      expect(tasks.columns.every((c: TJson) => c.color === "" && c.alpha === null)).toBe(true);
      const development = kanban.flows.find((f: TJson) => f.name === "development");
      expect(development.columns.map((c: TJson) => [c.label, c.alpha])).toEqual([
        ["plan", 1],
        ["build", 0.63],
        ["review", 0.25],
      ]);
      expect(
        new Set(development.columns.map((c: TJson) => c.color.split(",").slice(0, 3).join())),
      ).toEqual(new Set(["rgba(170, 51, 0"]));
      const reviewFlow = kanban.flows.find((f: TJson) => f.name === "review");
      expect(reviewFlow.columns.every((c: TJson) => c.color === "" && c.alpha === null)).toBe(true);
      expect(kanban.your_turn.map((i: TJson) => i.id)).toContain("R1");
      expect(kanban.open_gates.map((g: TJson) => [g.item_id, g.question])).toEqual([
        ["R1", "Approve the review?"],
      ]);
      expect(kanban.running.map((r: TJson) => [r.item_id, r.agent])).toEqual([["W1", "thinker"]]);
      const foreign = await fetch(`http://127.0.0.1:${port}/api/kanban`, {
        headers: { Host: "evil.example" },
      });
      expect(foreign.status).toBe(403);
    } finally {
      proc.kill("SIGTERM");
    }
    expect(await proc.exited).toBe(0);
  }, 20000);
});
