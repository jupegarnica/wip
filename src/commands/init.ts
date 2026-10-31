import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IArgs } from "../args.ts";
import { compact } from "../clock.ts";
import { CONFIG_FILE, readConfig, WIP_DIR, writeConfig } from "../config.ts";
import type { ICtx, IHandler } from "../context.ts";
import { openForRead } from "../db.ts";
import { COORDINATOR_AGENT } from "../embedded/templates.ts";
import { rootAt } from "../env.ts";
import { EXIT, rejected, usage } from "../errors.ts";
import { loadFlows } from "../flow/registry.ts";
import { CLAUDE_CODE, defsDirFor, nativeDefsDir } from "../init/harness.ts";
import { foreignFiles, scaffold } from "../init/scaffold.ts";
import { seedItems } from "../init/seed.ts";

export const FIRST_RUN_LINE =
  "Start your coordinator: on its first run it asks which model it and each generic agent use.";

const INIT_USAGE = "usage: wip init [<path>] [--force] [--harness <name>]";

function pointAHarness(defs: string): string[] {
  return [
    `Point your harness at ${defs}/:`,
    `  - the coordinator is ${defs}/agents/${COORDINATOR_AGENT}.md and loads the skill ${defs}/skills/wip-coordinate/SKILL.md;`,
    `  - subagents are ${defs}/agents/<name>.md; skills, flows included, are ${defs}/skills/<name>/SKILL.md;`,
    "  - Claude Code: in a new project, `wip init --harness claude-code` writes them into .claude/ instead;",
    `  - a harness without agent definitions: paste ${defs}/skills/wip-coordinate/SKILL.md into a session as its first message.`,
  ];
}

const CLAUDE_CODE_NEXT = [
  `Run the coordinator with \`claude --agent ${COORDINATOR_AGENT}\` in this directory: it starts on its own.`,
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

function initCommandFor(defsDir: string): string {
  return defsDirFor(CLAUDE_CODE) === defsDir ? "wip init --harness claude-code" : "wip init";
}

/** A project already set up keeps its definitions folder: init never moves it. */
function folderConflict(project: string, defsDir: string): string | null {
  if (!existsSync(join(project, WIP_DIR))) return null;
  const current = readConfig(project)?.defs_dir ?? defsDirFor(null);
  if (current === defsDir) return null;
  return `this project keeps its definitions in ${current}/ and this init would write them to ${defsDir}/; wip does not move them: run \`${initCommandFor(current)}\` (with --force to refresh), or move them by hand and edit ${WIP_DIR}/${CONFIG_FILE}`;
}

function run(ctx: ICtx, args: IArgs): void {
  const [path, extra] = args.pos;
  if (extra !== undefined) throw usage(INIT_USAGE);
  const harnessOpt = args.opts.harness;
  if (harnessOpt !== undefined && harnessOpt.trim() === "") throw usage(INIT_USAGE);
  const harness = harnessOpt ?? null;
  const project = resolve(ctx.cwd, path ?? ".");
  const force = args.flags.has("force");
  const defsDir = defsDirFor(harness);
  assertDirectory(project);

  const moved = folderConflict(project, defsDir);
  const conflicts = [
    ...(moved ? [moved] : []),
    ...foreignFiles(project, defsDir).map(
      (rel) =>
        `${rel} exists without a \`wip:\` mark (another tool's file); rename or move it and run init again`,
    ),
  ];
  if (conflicts.length > 0) throw rejected(`nothing written: ${conflicts.join("; ")}`);

  mkdirSync(project, { recursive: true });
  const before = readConfig(project);
  const done = scaffold(project, { force, stamp: compact(), defsDir });
  writeConfig(project, { defs_dir: defsDir, harness });
  let configAction: "created" | "exists" | "updated" = "created";
  if (before !== null) configAction = before.harness === harness ? "exists" : "updated";

  const lines = ctx.result.lines;
  lines.push(`wip init · ${project}`);
  lines.push(`${done.wipDir} ${WIP_DIR}/`);
  const gitignoreLine = {
    created: `created .gitignore with ${WIP_DIR}/`,
    added: `added ${WIP_DIR}/ to .gitignore`,
    exists: `exists ${WIP_DIR}/ in .gitignore`,
  } as const;
  lines.push(gitignoreLine[done.gitignore]);
  lines.push(`${configAction} ${WIP_DIR}/${CONFIG_FILE} (definitions in ${defsDir}/)`);
  for (const f of done.files) {
    lines.push(`${f.action} ${f.path}${f.backup ? ` (backup ${f.backup})` : ""}`);
  }
  const items = seedItems(rootAt(project));
  for (const i of items) {
    const verb = i.action === "seeded" ? "seeded item" : "exists item";
    const files = i.files.length > 0 ? ` with ${i.files.join(", ")}` : "";
    lines.push(`${verb} ${i.id} (${i.flow} · ${i.phase})${files}`);
  }
  const lintOk = lint(ctx, project);

  const next = [
    ...(nativeDefsDir(harness) !== null ? CLAUDE_CODE_NEXT : pointAHarness(defsDir)),
    FIRST_RUN_LINE,
  ];
  lines.push("", "Next steps:", ...next);
  ctx.result.message = `wip initialised in ${project}`;
  ctx.result.data = {
    project,
    wip: done.wipDir,
    gitignore: done.gitignore,
    config: configAction,
    defs_dir: defsDir,
    harness,
    files: done.files,
    items,
    lint: { ok: lintOk },
    next,
  };
  if (!lintOk) {
    ctx.result.ok = false;
    ctx.result.code = EXIT.FINDINGS;
  }
}

export const initCmd: IHandler = { db: "none", run };
