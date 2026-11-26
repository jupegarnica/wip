import { resolve } from "node:path";
import type { IArgs } from "../args.ts";
import {
  DEFAULT_DEFS_DIR,
  defaultStart,
  HOME_PREFIX,
  readConfig,
  START_VARIABLES,
  validateStart,
} from "../config.ts";
import { DEFAULT_FLOWS, flowNames } from "../embedded/templates.ts";
import { shownDefsDir, type TEnv } from "../env.ts";
import { isSettingsFile, type TSettingsFile } from "./claude-settings.ts";
import { joinCommand, splitCommand } from "./command.ts";
import { savedStart } from "./current.ts";
import { parseFlows } from "./flows.ts";
import { type IKanbanState, KANBAN_DIR, kanbanAskDefaults, kanbanState } from "./kanban.ts";
import { askMultiSelect, askSelect, askText, askYesNo, type IAsker } from "./prompt.ts";
import { type IQuietState, QUIET_DIR, quietAskDefaults, quietState } from "./quiet.ts";
import { isIgnored } from "./scaffold.ts";
import { box } from "./style.ts";

export interface IAskInput {
  args: IArgs;
  cwd: string;
  env: TEnv;
}

const STEPS = 7;

/** One line on what each shipped flow is for, in the wizard's Flows step. */
const FLOW_HINTS: Record<string, string> = {
  development: "worktree, build, QA, release",
  ideas: "shape before building",
  reports: "search and report, one-off or recurring",
  tasks: "task with a clear outcome; seeds onboarding",
};

/** The answer that leaves no start command, as the start step reads it. */
const SKIP = "skip";

function checkStart(text: string): string | null {
  try {
    validateStart(splitCommand(text));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function header(asker: IAsker, n: number, title: string, note?: string): void {
  const s = asker.style;
  asker.say("");
  asker.say(`${s.cyan(s.bold(`${n}/${STEPS}`))} ${s.bold(title)}`);
  if (note) asker.say(`    ${s.dim(note)}`);
}

/**
 * Asks what the flags left open, in the order scope, flows, start, Git, Kanban, Quiet and Settings, and returns the
 * extra arguments to give the non-interactive init (`--global`, `--flows`, `--start`, `--no-start`, `--gitignore`,
 * `--kanban`, `--quiet`, `--mods-settings-file`), or `null` when the user declines the summary. The settings-file
 * question is asked once, in the seventh step, and its answer serves both mods. Nothing is written here: every
 * answer is asked before the first write. Throws `Aborted` on Ctrl+C.
 */
export async function askInit(asker: IAsker, input: IAskInput): Promise<string[] | null> {
  const { args } = input;
  const s = asker.style;
  const extra: string[] = [];
  const project = resolve(input.cwd, args.pos[0] ?? ".");

  let global = args.flags.has("global");
  let kept: string | null = null;
  try {
    kept = readConfig(project)?.defs_dir ?? null;
  } catch {
    kept = null;
  }
  header(asker, 1, "Scope");
  if (global) {
    asker.say(`  ${s.dim("from --global")}`);
  } else if (kept !== null) {
    global = kept.startsWith(HOME_PREFIX);
    asker.say(`  ${s.dim(`scope kept: ${global ? "global" : "local"}`)}`);
    if (global) extra.push("--global");
  } else {
    const answer = await askSelect(asker, {
      question: "Where do the agents and skills live?",
      options: [
        {
          value: "local",
          label: "local",
          hint: "in this project (.claude/), versioned with it",
        },
        {
          value: "global",
          label: "global",
          hint: `in your home folder (${shownDefsDir(`${HOME_PREFIX}${DEFAULT_DEFS_DIR}`, input.env)}/), shared by every --global project`,
        },
      ],
      initial: 0,
    });
    global = answer === "global";
    if (global) extra.push("--global");
  }

  const defsDir = (global ? HOME_PREFIX : "") + DEFAULT_DEFS_DIR;
  const shownDefs = shownDefsDir(defsDir, input.env);
  // A legacy folder needs --force to move to .claude; the rest of the answers are written as they are.
  const switchFrom =
    kept !== null &&
    kept !== defsDir &&
    kept.startsWith(HOME_PREFIX) === defsDir.startsWith(HOME_PREFIX)
      ? shownDefsDir(kept, input.env)
      : null;
  if (switchFrom !== null) {
    asker.say(
      `  ${s.dim(`this project uses ${switchFrom}/; wip now writes ${shownDefs}/, and switching needs \`wip init --force\``)}`,
    );
  }
  if (global) {
    asker.say(
      `  ${s.dim(`global: the definitions and their models live in ${shownDefs}/, shared by every --global project.`)}`,
    );
  }

  header(asker, 2, "Flows", "what wip writes into the definitions folder; Space toggles");
  let flows: string[];
  if (args.opts.flows !== undefined) {
    flows = parseFlows(args.opts.flows);
    asker.say(`  ${s.dim(`from --flows ${flows.join(", ")}`)}`);
  } else {
    flows = await askMultiSelect(asker, {
      question: "Which flows should wip write?",
      options: flowNames().map((name) => ({
        value: name,
        label: name,
        hint: FLOW_HINTS[name],
      })),
      initial: DEFAULT_FLOWS,
    });
    // The non-interactive default is all four; only a different selection is passed on.
    if (flows.join(",") !== DEFAULT_FLOWS.join(",")) extra.push("--flows", flows.join(","));
  }

  header(
    asker,
    3,
    "Start command",
    `what \`wip start\` runs; variables ${START_VARIABLES.map((v) => `{${v}}`).join(" ")}; leave empty for none`,
  );
  const now = savedStart(project);
  let startShown: string | null = now === null ? null : joinCommand(now);
  if (args.opts.start !== undefined) startShown = args.opts.start;
  else if (args.flags.has("start-default")) startShown = joinCommand(defaultStart());
  else if (args.flags.has("no-start")) startShown = now === null ? null : joinCommand(now);
  else {
    const def = startShown ?? joinCommand(defaultStart());
    const answer = await askText(asker, "Command", def, (a) =>
      a === "" || a === SKIP ? null : checkStart(a),
    );
    if (answer === "" || answer === SKIP) extra.push("--no-start");
    else {
      startShown = answer;
      if (answer !== joinCommand(now ?? [])) extra.push("--start", answer);
    }
  }

  header(asker, 4, "Git", "what goes into .gitignore");
  let gitShown: string;
  if (args.opts.gitignore !== undefined) {
    asker.say(`  ${s.dim(`from --gitignore ${args.opts.gitignore}`)}`);
    gitShown = args.opts.gitignore;
  } else {
    const picked: string[] = [];
    if (isIgnored(project, ".wip/")) {
      asker.say(`  ${s.dim(".wip/ already ignored")}`);
      picked.push("wip");
    } else if (await askYesNo(asker, "Ignore .wip/ in .gitignore?", true)) picked.push("wip");
    if (global) {
      asker.say(
        `  ${s.dim(`the definitions are in ${shownDefs}/, outside the project: nothing to ignore`)}`,
      );
    } else if (
      await askYesNo(
        asker,
        `Also ignore the wip definitions in ${shownDefs}/ (only the files wip writes)?`,
        false,
      )
    ) {
      picked.push("defs");
    }
    gitShown = picked.length === 0 ? "none" : picked.join(",");
    if (gitShown !== "wip" || !isIgnored(project, ".wip/")) extra.push("--gitignore", gitShown);
  }

  header(asker, 5, "Kanban", "optional: a read-only board of the open items, shown by Claude Code");
  let state: IKanbanState | null = null;
  try {
    state = kanbanState(project);
  } catch {
    state = null;
  }
  const defaults =
    state === null
      ? { install: false, file: "settings.json" as TSettingsFile, notes: [] }
      : kanbanAskDefaults(state, project, args.flags.has("force"));
  const copyOwned = state?.copy === "owned";
  asker.say(`  ${s.dim(`default: ${defaults.install ? "yes" : "no"}`)}`);
  if (args.flags.has("force") && copyOwned) {
    asker.say(
      `  ${s.dim("--force refreshes the copy even when the answer is no; only --kanban changes settings")}`,
    );
  }
  if (global) {
    asker.say(`  ${s.dim(`the mod is installed in this project anyway (${KANBAN_DIR}/)`)}`);
  }
  for (const note of defaults.notes) asker.say(`  ${s.dim(note)}`);

  let installKanban = false;
  if (args.flags.has("kanban")) {
    installKanban = true;
    asker.say(`  ${s.dim("from --kanban")}`);
  } else {
    const answer = await askSelect(asker, {
      question: "Install the wip Kanban mod for Claude Code?",
      options: [
        { value: "no", label: "no", hint: "don't install it" },
        {
          value: "yes",
          label: "yes",
          hint: `${KANBAN_DIR}/ with an enabledPlugins entry`,
        },
      ],
      initial: defaults.install ? 1 : 0,
    });
    installKanban = answer === "yes";
    if (installKanban) extra.push("--kanban");
  }

  header(asker, 6, "Quiet", "optional: a quieter transcript, shown by Claude Code");
  let quietStateValue: IQuietState | null = null;
  try {
    quietStateValue = quietState(project);
  } catch {
    quietStateValue = null;
  }
  const quietDefault =
    quietStateValue === null
      ? { install: false, file: "settings.json" as TSettingsFile, notes: [] }
      : quietAskDefaults(quietStateValue, project, args.flags.has("force"));
  const quietOwned = quietStateValue?.copy === "owned";
  asker.say(`  ${s.dim(`default: ${quietDefault.install ? "yes" : "no"}`)}`);
  if (args.flags.has("force") && quietOwned) {
    asker.say(
      `  ${s.dim("--force refreshes the copy even when the answer is no; only --quiet changes settings")}`,
    );
  }
  if (global) {
    asker.say(`  ${s.dim(`the mod is installed in this project anyway (${QUIET_DIR}/)`)}`);
  }
  for (const note of quietDefault.notes) asker.say(`  ${s.dim(note)}`);

  let installQuiet = false;
  if (args.flags.has("quiet")) {
    installQuiet = true;
    asker.say(`  ${s.dim("from --quiet")}`);
  } else {
    const answer = await askSelect(asker, {
      question: "Install the wip Quiet mod for Claude Code?",
      options: [
        { value: "no", label: "no", hint: "don't install it" },
        {
          value: "yes",
          label: "yes",
          hint: `${QUIET_DIR}/ with an enabledPlugins entry`,
        },
      ],
      initial: quietDefault.install ? 1 : 0,
    });
    installQuiet = answer === "yes";
    if (installQuiet) extra.push("--quiet");
  }

  // Step 7 asks where the enabledPlugins entry goes, once for both mods and after both install questions.
  const givenMods = args.opts["mods-settings-file"];
  const givenAlias = args.opts["kanban-settings-file"];
  const givenFile: TSettingsFile | null =
    givenMods !== undefined && isSettingsFile(givenMods)
      ? givenMods
      : givenAlias !== undefined && isSettingsFile(givenAlias)
        ? givenAlias
        : null;
  let selectedFile: TSettingsFile | null = null;

  if (!installKanban && !installQuiet) {
    header(asker, 7, "Settings", "no mod installed: no enabledPlugins entry to write");
  } else {
    header(asker, 7, "Settings", "where the enabledPlugins entry goes; one answer for both mods");
    const fallback: TSettingsFile = installKanban ? defaults.file : quietDefault.file;
    if (givenFile !== null) {
      selectedFile = givenFile;
      const from =
        givenMods !== undefined
          ? `from --mods-settings-file ${givenFile}`
          : `from --kanban-settings-file ${givenFile} (deprecated)`;
      asker.say(`  ${s.dim(from)}`);
    } else if (installKanban && args.flags.has("kanban") && args.flags.has("force")) {
      selectedFile = "settings.json";
      asker.say(
        `  ${s.dim("--kanban --force installs with the defaults: .claude/settings.json, no file question")}`,
      );
    } else {
      const answer = await askSelect(asker, {
        question: "Where does the enabledPlugins entry go?",
        options: [
          {
            value: "settings.json",
            label: "settings.json",
            hint: ".claude/settings.json (project, shared with the repository; default)",
          },
          {
            value: "settings.local.json",
            label: "settings.local.json",
            hint: ".claude/settings.local.json (local to this clone, not shared; wins over settings.json)",
          },
        ],
        initial: fallback === "settings.local.json" ? 1 : 0,
      });
      selectedFile = isSettingsFile(answer) ? answer : fallback;
    }
  }
  if (
    selectedFile === "settings.local.json" &&
    givenMods === undefined &&
    givenAlias === undefined
  ) {
    extra.push("--mods-settings-file", "settings.local.json");
  }

  const row = (k: string, v: string | null) =>
    `${s.dim(k.padEnd(10))}${v === null ? s.dim("(unset)") : s.cyan(v)}`;
  const rows = [
    row("scope", global ? "global" : "local"),
    row("defs", `${shownDefs}/${switchFrom === null ? "" : ` (switch from ${switchFrom}/)`}`),
    row("flows", flows.join(", ")),
    row("start", startShown),
    row("gitignore", gitShown),
    row("kanban", installKanban ? "yes" : "no"),
    row("quiet", installQuiet ? "yes" : "no"),
    ...(installKanban || installQuiet
      ? [row("settings", `.claude/${selectedFile ?? "settings.json"}`)]
      : []),
  ];
  asker.say("");
  for (const line of box("Summary", rows, s)) asker.say(line);
  const ok = await askYesNo(asker, "Write?", true);
  return ok ? extra : null;
}
