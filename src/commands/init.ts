import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { modelsUnset } from "../agents.ts";
import { allow, type IArgs, parseArgs } from "../args.ts";
import { compact } from "../clock.ts";
import {
  CONFIG_FILE,
  DEFAULT_DEFS_DIR,
  defaultStart,
  HOME_PREFIX,
  readConfig,
  validateStart,
  WIP_DIR,
  writeConfig,
} from "../config.ts";
import type { ICtx, IHandler } from "../context.ts";
import { openForRead } from "../db.ts";
import { KANBAN_MOD } from "../embedded/kanban.ts";
import { flowNames, selectTemplates } from "../embedded/templates.ts";
import { defsPath, FLOW_SKILL_PREFIX, rootAt, shownDefsDir, type TEnv } from "../env.ts";
import { EXIT, rejected, usage } from "../errors.ts";
import { liveItems, loadFlows } from "../flow/registry.ts";
import { askInit } from "../init/ask.ts";
import {
  applySettings,
  isSettingsFile,
  KANBAN_PLUGIN_ID,
  scopeOf,
  settingsRel,
  type TSettingsFile,
} from "../init/claude-settings.ts";
import { splitCommand } from "../init/command.ts";
import { savedStart } from "../init/current.ts";
import { parseFlows } from "../init/flows.ts";
import {
  type IKanbanCopyResult,
  KANBAN_DIR,
  KanbanCopyFailed,
  kanbanAskDefaults,
  kanbanPreflight,
  kanbanState,
  syncKanban,
} from "../init/kanban.ts";
import { Aborted, type IAsker, terminalAsker } from "../init/prompt.ts";
import { foreignFiles, scaffold } from "../init/scaffold.ts";
import { seedItems } from "../init/seed.ts";
import { leftBehind, uncoveredFlows } from "../init/switch.ts";
import { COMMANDS } from "./help.ts";
import { launchBin } from "./start.ts";

/** Printed when a model or the start command is still unset after init: says which and how to set them. */
export function unsetLine(models: readonly string[], startUnset: boolean): string | null {
  const parts: string[] = [];
  if (models.length > 0) parts.push(`no model for ${models.join(", ")}`);
  if (startUnset) parts.push("no start command");
  if (parts.length === 0) return null;
  const advice: string[] = [];
  if (models.length > 0) {
    advice.push(
      "Add a `model:` line to each agent file (ask the coordinator, «Changing a model»).",
    );
  }
  if (startUnset) {
    advice.push("Set the start with `wip init --start <command>` or `wip start --set`.");
  }
  if (models.length > 0) advice.push("Until then the runtime default model applies.");
  return `Still unset: ${parts.join("; ")}. ${advice.join(" ")}`;
}

const INIT_USAGE =
  "usage: wip init [<path>] [--global] [--force] [--yes] [--flows <names>] [--start <command> | --start-default | --no-start] [--gitignore wip,defs | none] [--kanban] [--kanban-settings-file settings.json|settings.local.json]";

const CLAUDE_CODE_NEXT = [
  "Run `wip start` (or bare `wip`) in this directory: it starts the coordinator, the runtime that runs the project's flows.",
];

function assertDirectory(project: string): void {
  const stat = statSync(project, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw usage(`${project} is not a directory`);
}

function lint(ctx: ICtx, project: string): boolean {
  const root = rootAt(project, ctx.env);
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

/** The command that refreshes a project whose definitions live in `current`: `--force` moves a legacy folder. */
function refreshCommandFor(current: string): string {
  const global = current.startsWith(HOME_PREFIX);
  const folder = global ? current.slice(HOME_PREFIX.length) : current;
  const target = folder === DEFAULT_DEFS_DIR;
  return `wip init${global ? " --global" : ""}${target ? "" : " --force"}`;
}

/** `from`: the folder the project used (a switch, with --force); `refusal`: why nothing may be written. */
export interface IFolderSwitch {
  from: string | null;
  refusal: string | null;
}

/**
 * A project keeps its definitions folder until an init for `defsDir` of the same scope runs with --force: then
 * `defs_dir` switches and the old folder stays as it is. Local and --global are never switched.
 */
export function folderSwitch(
  project: string,
  defsDir: string,
  force: boolean,
  env: TEnv,
): IFolderSwitch {
  if (!existsSync(join(project, WIP_DIR))) return { from: null, refusal: null };
  const current = readConfig(project)?.defs_dir ?? DEFAULT_DEFS_DIR;
  if (current === defsDir) return { from: null, refusal: null };
  const shownCurrent = shownDefsDir(current, env);
  const shownNew = shownDefsDir(defsDir, env);
  if (current.startsWith(HOME_PREFIX) !== defsDir.startsWith(HOME_PREFIX)) {
    return {
      from: null,
      refusal: `this project keeps its definitions in ${shownCurrent}/ and this init would write them to ${shownNew}/; wip does not move them between local and --global: run \`${refreshCommandFor(current)}\` to refresh them, or move them by hand and edit ${WIP_DIR}/${CONFIG_FILE}`,
    };
  }
  if (!force) {
    return {
      from: null,
      refusal: `this project keeps its definitions in ${shownCurrent}/ and this init would write them to ${shownNew}/; run with --force to add ${shownNew}/ and use it from now on (${shownCurrent}/ stays as it is and wip stops reading it)`,
    };
  }
  return { from: current, refusal: null };
}

/** The open items' flows of the project's database, read only; no database means no items. */
function liveFlows(project: string, env: TEnv): ReturnType<typeof liveItems> {
  const db = openForRead(rootAt(project, env).db);
  try {
    return liveItems(db);
  } finally {
    db?.close();
  }
}

/** The refusals of a switch whose live items use a flow the new folder lacks: nothing is written then. */
function liveFlowRefusals(
  project: string,
  from: string,
  to: string,
  env: TEnv,
  templates: Readonly<Record<string, string>>,
): string[] {
  const oldRoot = defsPath(project, from, env);
  const newRoot = defsPath(project, to, env);
  const shipped = flowNames();
  const runAgain = "and run init again";
  return uncoveredFlows(liveFlows(project, env), newRoot, templates).map(({ flow, id, more }) => {
    const inOld = existsSync(join(oldRoot, "skills", `${FLOW_SKILL_PREFIX}${flow}`, "SKILL.md"));
    const shownOld = shownDefsDir(from, env);
    const shownNew = shownDefsDir(to, env);
    const who = `item ${id}${more > 0 ? ` (and ${more} more)` : ""}`;
    if (shipped.includes(flow)) {
      return `${who} uses the flow ${flow}, which is shipped but not selected; add it to --flows or copy skills/${FLOW_SKILL_PREFIX}${flow}/ to ${shownNew}/ by hand ${runAgain}`;
    }
    return inOld
      ? `${who} uses the flow ${flow}, which is in ${shownOld}/ and not in ${shownNew}/; copy skills/${FLOW_SKILL_PREFIX}${flow}/ to ${shownNew}/ by hand ${runAgain}`
      : `${who} uses the flow ${flow}, which is not in ${shownNew}/ (nor in ${shownOld}/); add skills/${FLOW_SKILL_PREFIX}${flow}/SKILL.md to ${shownNew}/ by hand ${runAgain}`;
  });
}

/** The start command to save, or `null` to leave `start` as it is (a saved one stays; none is written). */
function startAnswer(args: IArgs, project: string): string[] | null {
  const given = [
    args.opts.start !== undefined,
    args.flags.has("start-default"),
    args.flags.has("no-start"),
  ];
  if (given.filter(Boolean).length > 1) {
    throw usage("--start, --start-default and --no-start are exclusive");
  }
  if (args.opts.start !== undefined) {
    try {
      return validateStart(splitCommand(args.opts.start));
    } catch (err) {
      throw usage(`--start: ${(err as Error).message}`);
    }
  }
  if (args.flags.has("start-default")) return defaultStart();
  if (args.flags.has("no-start") || !args.flags.has("yes")) return null;
  return savedStart(project) === null ? defaultStart() : null;
}

const GITIGNORE_VALUES = ["wip", "defs", "none"];

/** What `--gitignore` asks to ignore; without it `.wip/` only. */
function gitignoreAnswer(args: IArgs): { wip: boolean; defs: boolean } {
  const text = args.opts.gitignore;
  if (text === undefined) return { wip: true, defs: false };
  const values = text.split(",").map((v) => v.trim());
  const bad = values.filter((v) => !GITIGNORE_VALUES.includes(v));
  if (bad.length > 0 || values.length === 0) {
    throw usage(
      `--gitignore: ${bad.length > 0 ? `unknown value ${bad.map((v) => `"${v}"`).join(", ")}; ` : ""}use wip, defs (comma separated) or none`,
    );
  }
  if (values.includes("none") && values.length > 1) {
    throw usage("--gitignore: none is exclusive");
  }
  return { wip: values.includes("wip"), defs: values.includes("defs") };
}

function run(ctx: ICtx, args: IArgs): void {
  const [path, extra] = args.pos;
  if (extra !== undefined) throw usage(INIT_USAGE);
  const project = resolve(ctx.cwd, path ?? ".");
  const force = args.flags.has("force");
  const global = args.flags.has("global");
  const yes = args.flags.has("yes");
  const kanbanFlag = args.flags.has("kanban");
  const kanbanFileValue = args.opts["kanban-settings-file"];
  if (kanbanFileValue !== undefined) {
    if (!kanbanFlag) throw usage("--kanban-settings-file only goes with --kanban");
    if (!isSettingsFile(kanbanFileValue)) {
      throw usage("--kanban-settings-file: use settings.json or settings.local.json");
    }
  }
  const flows = args.opts.flows === undefined ? flowNames() : parseFlows(args.opts.flows);
  const templates = selectTemplates(flows);
  const defsDir = (global ? HOME_PREFIX : "") + DEFAULT_DEFS_DIR;
  const defsRoot = defsPath(project, defsDir, ctx.env);
  const shown = shownDefsDir(defsDir, ctx.env);
  assertDirectory(project);

  // With --yes, init takes the wizard's default answers too, the Kanban step included.
  const yesKanban =
    yes && !kanbanFlag ? kanbanAskDefaults(kanbanState(project), project, force) : null;
  const kanban = kanbanFlag || (yesKanban?.install ?? false);
  const kanbanFile: TSettingsFile = kanbanFileValue ?? yesKanban?.file ?? "settings.json";

  const sw = folderSwitch(project, defsDir, force, ctx.env);
  const kanbanPre = kanbanPreflight(project, { requested: kanban, force, file: kanbanFile });
  const conflicts = [
    ...(sw.refusal ? [sw.refusal] : []),
    ...(sw.from === null ? [] : liveFlowRefusals(project, sw.from, defsDir, ctx.env, templates)),
    ...foreignFiles(defsRoot, shown, templates).map(
      (rel) =>
        `${rel} exists without a \`wip:\` mark (another tool's file); rename or move it and run init again`,
    ),
    ...kanbanPre.refusals,
  ];
  if (conflicts.length > 0) throw rejected(`nothing written: ${conflicts.join("; ")}`);
  ctx.result.warnings.push(
    ...kanbanPre.warnings.map((w) => ({ code: w.code, message: w.message })),
  );

  const start = startAnswer(args, project);
  const ignore = gitignoreAnswer(args);
  const defsIgnored = ignore.defs && !global;
  if (ignore.defs && global) {
    ctx.result.warnings.push({
      code: "gitignore_defs_global",
      message: `--gitignore defs ignored: the definitions are in ${shown}/, outside the project; nothing written for them`,
    });
  }

  mkdirSync(project, { recursive: true });
  const before = readConfig(project);
  const bin = launchBin(ctx.env, process.execPath, ctx.cwd);
  const stamp = compact();
  const done = scaffold(project, {
    force,
    stamp,
    defsDir: shown,
    defsRoot,
    ignoreWip: ignore.wip,
    ignoreDefs: defsIgnored,
    templates,
  });
  writeConfig(project, {
    defs_dir: defsDir,
    wip_bin: bin ?? before?.wip_bin ?? null,
    ...(start === null ? {} : { start }),
  });
  const configAction = before === null ? "created" : sw.from === null ? "exists" : "updated";

  const touchCopy = kanban || (force && kanbanPre.state.copy === "owned");
  let kanbanCopy: IKanbanCopyResult | null = null;
  let settings: { action: string; backup: string | null } | null = null;
  let kanbanFailed = false;
  try {
    if (touchCopy) kanbanCopy = syncKanban(project, { requested: kanban, force, stamp });
    if (kanban) settings = applySettings(project, kanbanFile, { stamp });
  } catch (err) {
    if (err instanceof KanbanCopyFailed) {
      kanbanCopy = null;
      kanbanFailed = true;
      ctx.result.warnings.push({ code: "kanban_copy_failed", message: err.message });
    } else if (kanban) {
      settings = null;
      kanbanFailed = true;
      ctx.result.warnings.push({
        code: "kanban_settings_failed",
        message: `the ${settingsRel(kanbanFile)} entry could not be written (${(err as Error).message}); the copy stays installed and Claude still loads ${KANBAN_PLUGIN_ID} from it`,
      });
    } else throw err;
  }
  const installed = kanbanState(project).copy === "owned";

  const lines = ctx.result.lines;
  lines.push(`wip init · ${project}`);
  lines.push(`${done.wipDir} ${WIP_DIR}/`);
  const gitignoreLine = {
    created: `created .gitignore with ${WIP_DIR}/`,
    added: `added ${WIP_DIR}/ to .gitignore`,
    exists: `exists ${WIP_DIR}/ in .gitignore`,
    skipped: "skipped .gitignore (--gitignore does not list wip)",
  } as const;
  lines.push(gitignoreLine[done.gitignore]);
  const defsLine = {
    created: "created .gitignore with the wip definitions",
    added: "added the wip definitions to .gitignore (files already tracked by git stay tracked)",
    exists: "exists the wip definitions in .gitignore",
  } as const;
  if (done.gitignoreDefs !== "skipped") lines.push(defsLine[done.gitignoreDefs]);
  if (bin !== null && bin !== (before?.wip_bin ?? null)) {
    lines.push(
      before?.wip_bin
        ? `wip_bin changed from ${before.wip_bin} to ${bin}`
        : `wip_bin set to ${bin}`,
    );
  }
  const shared = global ? ", shared by every --global project" : "";
  lines.push(`${configAction} ${WIP_DIR}/${CONFIG_FILE} (definitions in ${shown}/${shared})`);
  lines.push(`flows: ${flows.join(", ")}`);
  if (sw.from !== null) {
    const oldShown = shownDefsDir(sw.from, ctx.env);
    lines.push(
      `switched definitions from ${oldShown}/ to ${shown}/; ${oldShown}/ stays as it is and wip no longer reads it`,
    );
    const left = leftBehind(defsPath(project, sw.from, ctx.env), defsRoot, templates).map(
      (key) => `${oldShown}/${key}`,
    );
    if (left.length > 0) {
      const list = left.join(", ");
      ctx.result.warnings.push({
        code: "defs_left_behind",
        message: `custom agents and skills in ${oldShown}/ were not copied to ${shown}/: ${list}; copy them by hand if you need them`,
      });
      lines.push(`not copied to ${shown}/: ${list}`);
    }
  }
  for (const f of done.files) {
    lines.push(`${f.action} ${f.path}${f.backup ? ` (backup ${f.backup})` : ""}`);
  }
  if (start !== null) lines.push(`start: ${start.join(" ")}`);
  const items = seedItems(rootAt(project, ctx.env));
  for (const i of items) {
    const verb = i.action === "seeded" ? "seeded item" : "exists item";
    const files = i.files.length > 0 ? ` with ${i.files.join(", ")}` : "";
    lines.push(`${verb} ${i.id} (${i.flow} · ${i.phase})${files}`);
  }
  const lintOk = lint(ctx, project);

  if (kanbanCopy !== null) {
    const files = Object.keys(KANBAN_MOD).length;
    const copyLine = {
      created: `created ${KANBAN_DIR}/ (${files} files)`,
      updated: `updated ${KANBAN_DIR}/ (missing files created; run with --force to replace the folder)`,
      replaced: `replaced ${KANBAN_DIR}/ (backup ${kanbanCopy.backup})`,
      exists:
        kanbanCopy.differ.length > 0
          ? `exists ${KANBAN_DIR}/ (files differ; run with --force to replace the folder)`
          : `exists ${KANBAN_DIR}/`,
    } as const;
    lines.push(copyLine[kanbanCopy.action]);
    for (const rel of kanbanCopy.removed) lines.push(`removed ${rel}`);
  }
  if (settings !== null) {
    const base = settingsRel(kanbanFile);
    const what = `enabledPlugins ${KANBAN_PLUGIN_ID}`;
    const settingsLine = {
      created: `created ${base} with ${what}`,
      added: `added ${base}: ${what}`,
      updated: `updated ${base}: ${what} (backup ${settings.backup})`,
      exists: `exists ${base}: ${what}`,
    } as const;
    lines.push(
      settingsLine[settings.action as keyof typeof settingsLine] ?? `exists ${base}: ${what}`,
    );
  }

  const unsetModels = modelsUnset(join(defsRoot, "agents"));
  const startUnset = savedStart(project) === null;
  const unset = unsetLine(unsetModels, startUnset);
  const kanbanNext: string[] = [];
  if (installed && kanbanCopy?.action === "created") {
    kanbanNext.push(
      `Reload plugins or restart Claude Code: it loads ${KANBAN_PLUGIN_ID}; trust this workspace if Claude asks to.`,
    );
  }
  if (kanban) {
    const scope = scopeOf(kanbanFile);
    kanbanNext.push(
      `Disable the mod with \`claude plugin disable ${KANBAN_PLUGIN_ID} --scope ${scope}\`; enable it with \`claude plugin enable ${KANBAN_PLUGIN_ID} --scope ${scope}\`.`,
    );
  }
  const next = [...CLAUDE_CODE_NEXT, ...kanbanNext, ...(unset === null ? [] : [unset])];
  lines.push("", "Next steps:", ...next);
  ctx.result.message = `wip initialised in ${project}`;
  ctx.result.data = {
    project,
    wip: done.wipDir,
    gitignore: done.gitignore,
    gitignore_defs: done.gitignoreDefs,
    wip_bin: bin ?? before?.wip_bin ?? null,
    config: configAction,
    defs_dir: defsDir,
    switched_from: sw.from,
    flows,
    files: done.files,
    items,
    start,
    unset: { models: unsetModels, start: startUnset },
    lint: { ok: lintOk },
    kanban: {
      requested: kanban,
      installed,
      path: installed ? KANBAN_DIR : null,
      id: installed ? KANBAN_PLUGIN_ID : null,
      copy:
        kanbanCopy === null
          ? null
          : {
              action: kanbanCopy.action,
              backup: kanbanCopy.backup,
              removed: kanbanCopy.removed,
            },
      settings:
        settings === null || !kanban
          ? null
          : {
              path: settingsRel(kanbanFile),
              scope: scopeOf(kanbanFile),
              action: settings.action,
              backup: settings.backup,
            },
    },
    next,
  };
  if (!lintOk || kanbanFailed) {
    ctx.result.ok = false;
    ctx.result.code = EXIT.FINDINGS;
  }
}

export const initCmd: IHandler = { db: "none", run };

const NO_PROMPT = ["--yes", "--json", "--help", "-h"];

/** `wip init` asks questions only in a terminal, and never with --yes, --json or --help. */
export function isInitPrompt(argv: readonly string[], tty: boolean): boolean {
  if (!tty || argv[0] !== "init") return false;
  const rest = argv.slice(1);
  const dashdash = rest.indexOf("--");
  const head = dashdash < 0 ? rest : rest.slice(0, dashdash);
  return !head.some((a) => NO_PROMPT.includes(a));
}

export interface IInitPrompt {
  /** The argv to run: the user's plus the answers; `null` when nothing is to be written. */
  argv: string[] | null;
  /** 130 on Ctrl+C or end of input, 0 when the summary was declined. */
  code: number;
}

/** Asks the open questions, then returns the argv the non-interactive init runs; writes nothing itself. */
export async function promptInit(
  argv: readonly string[],
  cwd: string,
  env: TEnv,
  asker: IAsker = terminalAsker(),
): Promise<IInitPrompt> {
  const spec = COMMANDS.find((c) => c.name === "init");
  let args: IArgs;
  try {
    args = parseArgs(argv.slice(1), spec?.flags ?? []);
    allow(args, [...(spec?.options ?? []), ...(spec?.flags ?? [])]);
  } catch {
    return { argv: [...argv], code: 0 }; // the command reports the usage error itself
  }
  const kanbanFile = args.opts["kanban-settings-file"];
  if (kanbanFile !== undefined && (!args.flags.has("kanban") || !isSettingsFile(kanbanFile))) {
    return { argv: [...argv], code: 0 }; // the command reports the usage error itself
  }
  if (args.opts.flows !== undefined) {
    try {
      parseFlows(args.opts.flows);
    } catch {
      return { argv: [...argv], code: 0 }; // the command reports the usage error itself
    }
  }
  try {
    const extra = await askInit(asker, { args, cwd, env });
    if (extra === null) {
      asker.say("nothing written");
      return { argv: null, code: 0 };
    }
    return { argv: [...argv, ...extra], code: 0 };
  } catch (err) {
    if (err instanceof Aborted) {
      asker.say("");
      asker.say("aborted: nothing written");
      return { argv: null, code: 130 };
    }
    throw err;
  } finally {
    asker.close();
  }
}
