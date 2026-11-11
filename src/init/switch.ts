import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES } from "../embedded/templates.ts";
import { FLOW_SKILL_PREFIX } from "../env.ts";
import type { ILiveItem } from "../flow/lint.ts";

/**
 * The keys of a definitions folder that a switch leaves behind when it is not a template: `agents/<name>.md` and
 * `skills/<name>/SKILL.md`, relative, forward slashes, sorted.
 */
export function definitionKeys(root: string): string[] {
  const keys: string[] = [];
  const agents = join(root, "agents");
  if (existsSync(agents)) {
    for (const e of readdirSync(agents, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) keys.push(`agents/${e.name}`);
    }
  }
  const skills = join(root, "skills");
  if (existsSync(skills)) {
    for (const e of readdirSync(skills, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(skills, e.name, "SKILL.md"))) {
        keys.push(`skills/${e.name}/SKILL.md`);
      }
    }
  }
  return keys.sort();
}

/**
 * The custom agents and skills of the old folder that the new one lacks and that init does not copy: wip's own
 * templates are not custom (init writes them into the new folder), and a file the new folder already has is not left
 * behind.
 */
export function leftBehind(
  oldRoot: string,
  newRoot: string,
  templates: Readonly<Record<string, string>> = TEMPLATES,
): string[] {
  return definitionKeys(oldRoot).filter(
    (key) => !Object.hasOwn(templates, key) && !existsSync(join(newRoot, key)),
  );
}

/** A flow a live item uses that the new folder cannot run: first item, and how many more use it. */
export interface IUncoveredFlow {
  flow: string;
  id: string;
  more: number;
}

/**
 * Live items' flows with no skill in the new folder: a flow is covered by `skills/wip-flow-<name>/SKILL.md` there or by
 * the template init writes at that path. `live` is the open items grouped by flow (the registry's `liveItems`).
 */
export function uncoveredFlows(
  live: ReadonlyMap<string, readonly ILiveItem[]>,
  newRoot: string,
  templates: Readonly<Record<string, string>> = TEMPLATES,
): IUncoveredFlow[] {
  const out: IUncoveredFlow[] = [];
  for (const flow of [...live.keys()].sort((a, b) => a.localeCompare(b))) {
    const items = live.get(flow) ?? [];
    const first = items[0];
    if (first === undefined) continue;
    const key = `skills/${FLOW_SKILL_PREFIX}${flow}/SKILL.md`;
    if (Object.hasOwn(templates, key) || existsSync(join(newRoot, key))) continue;
    out.push({ flow, id: first.id, more: items.length - 1 });
  }
  return out;
}
