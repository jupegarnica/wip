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
import { defsPath, shownDefsDir, type TEnv } from "../env.ts";
import { joinCommand, splitCommand } from "./command.ts";
import { currentModels, savedStart } from "./current.ts";
import { MODEL_AGENTS, parseModels, SKIP, suggestedModel } from "./models.ts";
import { askSelect, askText, askYesNo, type IAsker } from "./prompt.ts";
import { isIgnored } from "./scaffold.ts";
import { box } from "./style.ts";

export interface IAskInput {
  args: IArgs;
  cwd: string;
  env: TEnv;
}

const STEPS = 4;

const MODEL_ROLES: Readonly<Record<string, string>> = {
  fast: "mechanical tasks",
  efficient: "scoped work",
  thinker: "plans and decisions",
  wise: "high level advisor",
  wip: "the coordinator",
};

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
 * Asks what the flags left open, in the order scope, models, start and Git, and returns the extra arguments to give
 * the non-interactive init (`--global`, `--models`, `--start`, `--no-start`), or `null` when the user declines the
 * summary. Nothing is written here: every answer is asked before the first write. Throws `Aborted` on Ctrl+C.
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
  const current = currentModels(defsPath(project, defsDir, input.env));
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

  header(asker, 2, "Models", "one per agent; Enter takes the suggestion");
  const given = args.opts.models === undefined ? {} : parseModels(args.opts.models);
  const shown: Record<string, string | null> = {};
  const written: string[] = [];
  for (const agent of MODEL_AGENTS) {
    const was = current[agent] ?? null;
    if (agent in given) {
      shown[agent] = given[agent] as string;
      continue;
    }
    const label = `Model of ${agent}${MODEL_ROLES[agent] ? ` ${s.dim(`(${MODEL_ROLES[agent]})`)}` : ""}`;
    const def = was ?? suggestedModel(agent);
    const answer = await askText(
      asker,
      was ? `${label} ${s.dim(`now ${was}`)}` : label,
      def,
      (a) => (/[\r\n]/.test(a) ? "one line only" : null),
    );
    if (answer === "") shown[agent] = was;
    else {
      shown[agent] = answer;
      if (answer !== was) written.push(`${agent}=${answer}`);
    }
  }
  if (written.length > 0) extra.push("--models", written.join(","));

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

  const row = (k: string, v: string | null) =>
    `${s.dim(k.padEnd(10))}${v === null ? s.dim("(unset)") : s.cyan(v)}`;
  const rows = [
    row("scope", global ? "global" : "local"),
    row("defs", `${shownDefs}/${switchFrom === null ? "" : ` (switch from ${switchFrom}/)`}`),
    ...MODEL_AGENTS.map((a) => row(a, shown[a] ?? null)),
    row("start", startShown),
    row("gitignore", gitShown),
  ];
  asker.say("");
  for (const line of box("Summary", rows, s)) asker.say(line);
  const ok = await askYesNo(asker, "Write?", true);
  return ok ? extra : null;
}
