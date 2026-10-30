import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { IArgs } from "../args.ts";
import { compact } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import { openForRead } from "../db.ts";
import { rootAt } from "../env.ts";
import { EXIT, rejected, usage } from "../errors.ts";
import { loadFlows } from "../flow/registry.ts";
import { CLAUDE_CODE, claudeCodeConflicts, type ILink, linkClaudeCode } from "../init/runtime.ts";
import { foreignGenerics, scaffold } from "../init/scaffold.ts";

export const FIRST_RUN_LINE =
  "Start your coordinator: on its first run it asks which model each generic agent uses.";

const POINT_A_RUNTIME = [
  "Point your runtime at .agents/:",
  "  - the coordinator is .agents/agents/wip-coordinator.md and loads the skill .agents/skills/wip-coordinate/SKILL.md;",
  "  - subagents are .agents/agents/<name>.md; skills are .agents/skills/<name>/SKILL.md;",
  "  - Claude Code: `wip init --runtime claude-code` links .claude/agents and .claude/skills to them;",
  "  - a runtime without agent definitions: paste .agents/skills/wip-coordinate/SKILL.md into a session.",
];

const CLAUDE_CODE_NEXT = [
  "Run the coordinator with `claude --agent wip-coordinator` in this directory.",
];

function assertDirectory(project: string): void {
  const stat = statSync(project, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw usage(`${project} is not a directory`);
}

function lint(ctx: ICtx, project: string): boolean {
  const root = rootAt(project);
  const db = openForRead(root.db);
  try {
    const set = loadFlows(root, db);
    const entries = [...set.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.problems.length === 0) ctx.result.lines.push(`flow lint: OK ${e.name}`);
      else for (const p of e.problems) ctx.result.lines.push(`flow lint: ${e.name} · ${p}`);
    }
    return entries.every((e) => e.problems.length === 0);
  } finally {
    db?.close();
  }
}

function run(ctx: ICtx, args: IArgs): void {
  const [path, extra] = args.pos;
  if (extra !== undefined)
    throw usage("usage: wip init [<path>] [--force] [--runtime claude-code]");
  const project = resolve(ctx.cwd, path ?? ".");
  const force = args.flags.has("force");
  const runtime = args.opts.runtime ?? null;
  assertDirectory(project);

  const conflicts = [
    ...(force ? [] : foreignGenerics(project)).map(
      (rel) =>
        `${rel} exists without \`wip: generic\` (another tool's agent); rename it, or run init --force to back it up in .wip/backups/defs/ and replace it`,
    ),
    ...(runtime === CLAUDE_CODE ? claudeCodeConflicts(project) : []),
  ];
  if (conflicts.length > 0) throw rejected(`nothing written: ${conflicts.join("; ")}`);

  mkdirSync(project, { recursive: true });
  const done = scaffold(project, { force, stamp: compact() });
  const links: ILink[] = runtime === CLAUDE_CODE ? linkClaudeCode(project) : [];

  const lines = ctx.result.lines;
  lines.push(`wip init · ${project}`);
  lines.push(`${done.wipDir} .wip/`);
  const gitignoreLine = {
    created: "created .gitignore with .wip/",
    added: "added .wip/ to .gitignore",
    exists: "exists .wip/ in .gitignore",
  } as const;
  lines.push(gitignoreLine[done.gitignore]);
  for (const f of done.files) {
    lines.push(`${f.action} ${f.path}${f.backup ? ` (backup ${f.backup})` : ""}`);
  }
  for (const l of links)
    lines.push(`${l.action === "created" ? "linked" : "exists"} ${l.path} -> ${l.target}`);
  const lintOk = lint(ctx, project);

  const next = [...(runtime === CLAUDE_CODE ? CLAUDE_CODE_NEXT : POINT_A_RUNTIME), FIRST_RUN_LINE];
  lines.push("", "Next steps:", ...next);
  ctx.result.message = `wip initialised in ${project}`;
  ctx.result.data = {
    project,
    wip: done.wipDir,
    gitignore: done.gitignore,
    files: done.files,
    runtime: runtime === CLAUDE_CODE ? { name: CLAUDE_CODE, links } : null,
    lint: { ok: lintOk },
    next,
  };
  if (!lintOk) {
    ctx.result.ok = false;
    ctx.result.code = EXIT.FINDINGS;
  }
}

export const initCmd: IHandler = { db: "none", run };
