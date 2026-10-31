import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_DEFS_DIR } from "./config.ts";

export const GENERIC_MARK = "generic";
export const COORDINATOR_MARK = "coordinator";

export interface IAgentDef {
  name: string;
  file: string;
  /** `null` when the file has no frontmatter or its YAML does not parse. */
  frontmatter: Record<string, unknown> | null;
  description: string | null;
  generic: boolean;
  coordinator: boolean;
  model: string | null;
  problems: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function parseFrontmatter(text: string): Record<string, unknown> | null {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return null;
  const parsed: unknown = Bun.YAML.parse(match[1] ?? "");
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the frontmatter is not a YAML mapping");
  }
  return parsed as Record<string, unknown>;
}

const MARK_LINE_RE = /^wip:\s*["']?([\w-]+)["']?\s*(#.*)?$/m;
const MODEL_LINE_RE = /^model:.*$/m;
const DESCRIPTION_LINE_RE = /^description:.*$/m;

/** The `wip:` mark, read line by line when the frontmatter's YAML does not parse. */
function wipMark(source: string): unknown {
  try {
    return parseFrontmatter(source)?.wip;
  } catch {
    return source.match(FRONTMATTER_RE)?.[1]?.match(MARK_LINE_RE)?.[1];
  }
}

/** Any `wip:` mark: the file is one wip wrote, so `init --force` may replace it. */
export function hasWipMark(source: string): boolean {
  const mark = wipMark(source);
  return typeof mark === "string" && mark !== "";
}

export function hasGenericMark(source: string): boolean {
  return wipMark(source) === GENERIC_MARK;
}

export function hasCoordinatorMark(source: string): boolean {
  return wipMark(source) === COORDINATOR_MARK;
}

/** The raw `model:` line of the frontmatter, as written. */
export function modelLine(source: string): string | null {
  return source.match(FRONTMATTER_RE)?.[1]?.match(MODEL_LINE_RE)?.[0] ?? null;
}

/** Puts `line` in place of the frontmatter's `model:` line, or right after `description:`. */
export function withModelLine(source: string, line: string): string {
  const block = source.match(FRONTMATTER_RE)?.[1];
  if (block === undefined) return source;
  let next: string;
  if (MODEL_LINE_RE.test(block)) next = block.replace(MODEL_LINE_RE, () => line);
  else if (DESCRIPTION_LINE_RE.test(block)) {
    next = block.replace(DESCRIPTION_LINE_RE, (d) => `${d}\n${line}`);
  } else next = `${block}\n${line}`;
  return source.replace(block, () => next);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Only the keys wip reads are validated; `model` and any runtime key pass untouched. */
export function readAgent(file: string): IAgentDef {
  const name = basename(file, ".md");
  const def: IAgentDef = {
    name,
    file,
    frontmatter: null,
    description: null,
    generic: false,
    coordinator: false,
    model: null,
    problems: [],
  };
  let fm: Record<string, unknown> | null;
  try {
    fm = parseFrontmatter(readFileSync(file, "utf8"));
  } catch (err) {
    def.problems.push(`invalid frontmatter: ${(err as Error).message}`);
    return def;
  }
  if (fm === null) {
    def.problems.push("no frontmatter (--- block at the top)");
    return def;
  }
  def.frontmatter = fm;
  def.description = text(fm.description);
  def.generic = fm.wip === GENERIC_MARK;
  def.coordinator = fm.wip === COORDINATOR_MARK;
  def.model = text(fm.model);
  if (fm.name === undefined) def.problems.push("frontmatter has no name");
  else if (fm.name !== name) {
    def.problems.push(`frontmatter name '${String(fm.name)}' differs from the file name '${name}'`);
  }
  if (def.description === null) def.problems.push("frontmatter has no description");
  return def;
}

export function agentFile(agentsDir: string, name: string): string {
  return join(agentsDir, `${name}.md`);
}

/** Problems of the agent a flow phase names; empty when it is usable. */
export function lintAgentRef(
  agentsDir: string,
  name: string,
  defsDir: string = DEFAULT_DEFS_DIR,
): string[] {
  const file = agentFile(agentsDir, name);
  if (!existsSync(file)) return [`no agent file ${defsDir}/agents/${name}.md`];
  return readAgent(file).problems;
}

export function listAgents(agentsDir: string): IAgentDef[] {
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => readAgent(join(agentsDir, f)));
}

/** wip's own agents (`wip: generic` or `wip: coordinator`) with no `model:` yet, in alphabetical order. */
export function modelsUnset(agentsDir: string): string[] {
  return listAgents(agentsDir)
    .filter((a) => (a.generic || a.coordinator) && a.model === null)
    .map((a) => a.name)
    .sort();
}
