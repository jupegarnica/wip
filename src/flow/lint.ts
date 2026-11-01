import { realpathSync } from "node:fs";
import { lintAgentRef, parseFrontmatter } from "../agents.ts";
import { artifactFile, isArtifactName } from "../artifact-name.ts";
import { DEFAULT_DEFS_DIR } from "../config.ts";
import { FLOW_SKILL_PREFIX } from "../env.ts";
import { DEFAULT_ID_RE, type IFlow, parseFlow } from "./parse.ts";

export interface ILiveItem {
  id: string;
  phase: string;
}

export interface ILintInput {
  name: string;
  text: string;
  agentsDir: string;
  /** Relative to the project; it names missing agent files. */
  defsDir?: string;
  /** The text is a flow skill: its frontmatter must carry `name` and `description`. */
  skill?: boolean;
  /** Folder of the flow's skill: the `files` of each seed must be in it. Without it, only their names are checked. */
  skillDir?: string;
  /** Open items of this flow; empty when there is no database yet. */
  liveItems: readonly ILiveItem[];
}

// A harness loads the flow as a skill by its frontmatter; without it the coordinator never sees the flow.
export function lintSkillFrontmatter(name: string, text: string): string[] {
  const folder = `${FLOW_SKILL_PREFIX}${name}`;
  let fm: Record<string, unknown> | null;
  try {
    fm = parseFrontmatter(text);
  } catch (err) {
    return [`invalid frontmatter: ${(err as Error).message}`];
  }
  if (fm === null) return ["no frontmatter (--- block at the top with name and description)"];
  const problems: string[] = [];
  if (fm.name !== folder) {
    problems.push(
      fm.name === undefined
        ? `frontmatter has no name (it must be ${folder})`
        : `frontmatter name '${String(fm.name)}' differs from the folder name '${folder}'`,
    );
  }
  if (typeof fm.description !== "string" || fm.description.trim() === "") {
    problems.push("frontmatter has no description");
  }
  return problems;
}

export interface ILintResult {
  flow: IFlow | null;
  block: string | null;
  problems: string[];
}

function regexProblem(source: string): string | null {
  try {
    new RegExp(source);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

function reachable(flow: IFlow): Set<string> {
  const byName = new Map(flow.phases.map((p) => [p.name, p]));
  const first = flow.phases[0];
  const seen = new Set<string>();
  const queue = first ? [first.name] : [];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const phase = byName.get(name);
    for (const n of phase?.next ?? []) if (byName.has(n)) queue.push(n);
    if (phase && phase.kind !== "terminal") {
      for (const p of flow.phases) if (p.fromAny === true) queue.push(p.name);
    }
  }
  return seen;
}

/** Rules on the phase graph, patterns and stages; no file system and no database. */
export function lintGraph(flow: IFlow): string[] {
  const problems: string[] = [];
  const names = flow.phases.map((p) => p.name);
  const known = new Set(names);
  const repeated = names.filter((n, i) => names.indexOf(n) !== i);
  if (repeated.length > 0)
    problems.push(`phase names repeat: ${[...new Set(repeated)].join(", ")}`);

  const terminals = flow.phases.filter((p) => p.kind === "terminal").map((p) => p.name);
  if (terminals.length === 0)
    problems.push("no terminal phase: exactly one phase has kind terminal");
  if (terminals.length > 1) {
    problems.push(`${terminals.length} terminal phases (${terminals.join(", ")}): exactly one`);
  }

  for (const p of flow.phases) {
    const where = `phase ${p.name}`;
    for (const n of p.next) {
      if (n === p.name) problems.push(`${where}: next names the phase itself`);
      else if (!known.has(n)) problems.push(`${where}: next '${n}' is not a phase`);
    }
    if (p.kind === "terminal") {
      if (p.next.length > 0) problems.push(`${where}: a terminal phase has no next`);
      if (p.waitingDefault !== "none") problems.push(`${where}: a terminal phase waits on none`);
    } else {
      if (p.next.length === 0) problems.push(`${where}: no next, the item could never leave it`);
      if (p.waitingDefault === "none") {
        problems.push(`${where}: waiting_default none is only for the terminal phase`);
      }
    }
  }

  const seen = reachable(flow);
  const unreachable = names.filter((n) => !seen.has(n));
  if (unreachable.length > 0) {
    problems.push(
      `unreachable from ${names[0]}: ${[...new Set(unreachable)].join(", ")} (no next leads there)`,
    );
  }

  if (flow.phases.every((p) => p.stage !== null)) {
    const runs: string[] = [];
    for (const p of flow.phases)
      if (runs[runs.length - 1] !== p.stage) runs.push(p.stage as string);
    if (new Set(runs).size !== runs.length) {
      problems.push(`stages must be contiguous in phase order: ${runs.join(" → ")}`);
    }
  }

  if (flow.idPattern !== null) {
    const err = regexProblem(flow.idPattern);
    if (err) problems.push(`id_pattern is not a valid regular expression: ${err}`);
  }
  flow.links.forEach((link, i) => {
    const err = regexProblem(link.pattern);
    if (err) problems.push(`links[${i}].pattern is not a valid regular expression: ${err}`);
    if (!/^https?:\/\//.test(link.url)) problems.push(`links[${i}].url must start with http(s)://`);
  });
  problems.push(...lintSeed(flow));
  return problems;
}

// A seeded item has no running agent and no work done yet: it can only wait on a person.
const SEED_WAITS = ["user", "external"];

function lintSeed(flow: IFlow): string[] {
  const problems: string[] = [];
  const pattern =
    flow.idPattern !== null && regexProblem(flow.idPattern) === null
      ? new RegExp(`^(?:${flow.idPattern})$`)
      : null;
  const ids = flow.seed.map((s) => s.id);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length > 0) problems.push(`seed ids repeat: ${[...new Set(repeated)].join(", ")}`);
  for (const s of flow.seed) {
    const where = `seed ${s.id}`;
    if (!DEFAULT_ID_RE.test(s.id) || (pattern !== null && !pattern.test(s.id))) {
      problems.push(`${where}: not a valid item ID for this flow`);
    }
    const phase = flow.phases.find((p) => p.name === s.phase);
    if (!phase) problems.push(`${where}: phase '${s.phase}' is not a phase`);
    else if (!SEED_WAITS.includes(phase.waitingDefault)) {
      problems.push(
        `${where}: phase ${s.phase} waits on ${phase.waitingDefault}; a seeded item starts in a phase whose waiting_default is user or external`,
      );
    }
    for (const f of s.files) {
      if (!isArtifactName(f)) problems.push(`${where}: file '${f}' is not a valid artifact name`);
    }
    const twice = s.files.filter((f, i) => s.files.indexOf(f) !== i);
    if (twice.length > 0)
      problems.push(`${where}: files repeat: ${[...new Set(twice)].join(", ")}`);
  }
  return problems;
}

function realDir(dir: string): string | null {
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

/** Each seed file is a regular file directly in the flow's skill folder; a link that leaves it does not count. */
export function lintSeedFiles(flow: IFlow, skillDir: string, defsDir: string): string[] {
  const dir = realDir(skillDir);
  const shown = `${defsDir}/skills/${FLOW_SKILL_PREFIX}${flow.name}/`;
  const problems: string[] = [];
  for (const s of flow.seed) {
    for (const f of new Set(s.files)) {
      if (!isArtifactName(f)) continue;
      if (dir === null || artifactFile(dir, f) === null) {
        problems.push(`seed ${s.id}: file '${f}' is missing from ${shown}`);
      }
    }
  }
  return problems;
}

export function lintAgents(
  flow: IFlow,
  agentsDir: string,
  defsDir: string = DEFAULT_DEFS_DIR,
): string[] {
  const problems: string[] = [];
  const checked = new Map<string, string[]>();
  for (const p of flow.phases) {
    if (p.agent === null) continue;
    if (!checked.has(p.agent)) checked.set(p.agent, lintAgentRef(agentsDir, p.agent, defsDir));
    for (const problem of checked.get(p.agent) ?? []) {
      problems.push(`phase ${p.name}: agent ${p.agent}: ${problem}`);
    }
  }
  return problems;
}

export function lintLiveItems(flow: IFlow, items: readonly ILiveItem[]): string[] {
  const known = new Set(flow.phases.map((p) => p.name));
  return items
    .filter((item) => !known.has(item.phase))
    .map((item) => `item ${item.id} is in phase ${item.phase}, which the flow no longer has`);
}

/** Every rule `wip flow lint` applies; a flow is only activated with no problems (F-NEW-04). */
export function lintFlow(input: ILintInput): ILintResult {
  const parsed = parseFlow(input.name, input.text);
  const problems = [
    ...(input.skill ? lintSkillFrontmatter(input.name, input.text) : []),
    ...parsed.problems,
  ];
  if (parsed.flow) {
    problems.push(...lintGraph(parsed.flow));
    if (input.skillDir !== undefined) {
      problems.push(
        ...lintSeedFiles(parsed.flow, input.skillDir, input.defsDir ?? DEFAULT_DEFS_DIR),
      );
    }
    problems.push(...lintAgents(parsed.flow, input.agentsDir, input.defsDir));
    problems.push(...lintLiveItems(parsed.flow, input.liveItems));
  }
  return { flow: parsed.flow, block: parsed.block, problems };
}
