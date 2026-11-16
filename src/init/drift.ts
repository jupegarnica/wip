import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasWipMark } from "../agents.ts";
import { defsDirOf } from "../config.ts";
import { flowOfKey, TEMPLATES } from "../embedded/templates.ts";
import { defsPath, FLOW_SKILL_PREFIX, shownDefsDir, type TEnv } from "../env.ts";
import { rejected } from "../errors.ts";
import { forcedText, type IInitFile, scaffold } from "./scaffold.ts";
import { definitionKeys } from "./switch.ts";

export type TDefsKind = "changed" | "missing" | "foreign";

export interface IDefsEntry {
  /** Template key: `agents/wip.md`, `skills/wip-flow-tasks/guide.md`. */
  key: string;
  /** As messages show it: `<path>/<key>`. */
  path: string;
  kind: TDefsKind;
  /** The shipped flow the file belongs to, or null. */
  flow: string | null;
}

export interface IDefsDrift {
  /** `defs_dir` as configured: `.claude`, `~/.claude`, … */
  dir: string;
  /** As messages show it: relative, or the absolute folder `~/…` resolves to. */
  path: string;
  /** Absolute folder on disk. */
  root: string;
  entries: IDefsEntry[];
  /** Custom agents and skills on disk that no template writes, shown paths, sorted. */
  kept: string[];
  /** The templates in scope for this folder (non-flow ones plus the installed flows). */
  templates: Readonly<Record<string, string>>;
}

export interface IDefsApply {
  drift: IDefsDrift;
  /** Only the files actually written (`created` or `replaced`), with their backups. */
  files: IInitFile[];
}

/** The shipped flow names of `all`, alphabetical. */
function flowNamesOf(all: Readonly<Record<string, string>>): string[] {
  const names = new Set<string>();
  for (const key of Object.keys(all)) {
    const flow = flowOfKey(key);
    if (flow !== null) names.add(flow);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** The shipped flows the folder has, or every shipped flow when it has no `wip-flow-*` folder. */
export function installedFlows(
  root: string,
  all: Readonly<Record<string, string>> = TEMPLATES,
): string[] {
  const skills = join(root, "skills");
  const folders: string[] = [];
  if (existsSync(skills)) {
    for (const entry of readdirSync(skills, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(FLOW_SKILL_PREFIX)) {
        folders.push(entry.name.slice(FLOW_SKILL_PREFIX.length));
      }
    }
  }
  const names = flowNamesOf(all);
  if (folders.length === 0) return names;
  return names.filter((name) => folders.includes(name));
}

/** Every non-flow template plus the templates of the installed flows. */
export function defsTemplates(
  root: string,
  all: Readonly<Record<string, string>> = TEMPLATES,
): Readonly<Record<string, string>> {
  const flows = new Set(installedFlows(root, all));
  return Object.fromEntries(
    Object.entries(all).filter(([key]) => {
      const flow = flowOfKey(key);
      return flow === null || flows.has(flow);
    }),
  );
}

/** What `wip init --force` would change, writing nothing. Pure over the folder. */
export function defsDrift(
  dir: string,
  shown: string,
  root: string,
  all: Readonly<Record<string, string>> = TEMPLATES,
): IDefsDrift {
  const templates = defsTemplates(root, all);
  const entries: IDefsEntry[] = [];
  for (const key of Object.keys(templates).sort()) {
    const template = templates[key] as string;
    const path = `${shown}/${key}`;
    const flow = flowOfKey(key);
    const file = join(root, key);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat === undefined) {
      entries.push({ key, path, kind: "missing", flow });
      continue;
    }
    if (!stat.isFile()) {
      entries.push({ key, path, kind: "foreign", flow });
      continue;
    }
    const current = readFileSync(file, "utf8");
    if (!hasWipMark(current)) {
      entries.push({ key, path, kind: "foreign", flow });
      continue;
    }
    if (forcedText(key, template, current) !== current) {
      entries.push({ key, path, kind: "changed", flow });
    }
  }
  const kept = definitionKeys(root)
    .filter((key) => !Object.hasOwn(templates, key))
    .map((key) => `${shown}/${key}`);
  return { dir, path: shown, root, entries, kept, templates };
}

interface IForeignPath {
  path: string;
  /** A regular file (another tool's) or a directory, a symlink or a dangling link. */
  regular: boolean;
}

function foreignRefusal(foreign: readonly IForeignPath[]): string {
  const regular = foreign.filter((f) => f.regular).map((f) => f.path);
  const odd = foreign.filter((f) => !f.regular).map((f) => f.path);
  const parts: string[] = [];
  if (regular.length === 1) {
    parts.push(`${regular[0]} exists without a \`wip:\` mark (another tool's file)`);
  } else if (regular.length > 1) {
    parts.push(`${regular.join(", ")} exist without a \`wip:\` mark (other tools' files)`);
  }
  if (odd.length === 1) {
    parts.push(`${odd[0]} is not a regular file (no \`wip:\` mark)`);
  } else if (odd.length > 1) {
    parts.push(`${odd.join(", ")} are not regular files (no \`wip:\` mark)`);
  }
  const pronoun = foreign.length === 1 ? "it" : "them";
  return `nothing written: ${parts.join("; ")}; rename or move ${pronoun} and run \`wip upgrade --apply-defs\` again`;
}

/** Applies the templates in place through `scaffold`; exit 3 on a foreign or non-regular path. */
export function applyDefs(
  project: string,
  env: TEnv,
  options: { stamp: string; templates?: Readonly<Record<string, string>> },
): IDefsApply {
  const dir = defsDirOf(project);
  const shown = shownDefsDir(dir, env);
  const root = defsPath(project, dir, env);
  const drift = defsDrift(dir, shown, root, options.templates);
  const foreign: IForeignPath[] = drift.entries
    .filter((entry) => entry.kind === "foreign")
    .map((entry) => {
      const stat = lstatSync(join(root, entry.key), { throwIfNoEntry: false });
      return { path: entry.path, regular: stat?.isFile() === true };
    });
  if (foreign.length > 0) throw rejected(foreignRefusal(foreign));
  const done = scaffold(project, {
    force: true,
    stamp: options.stamp,
    defsDir: shown,
    defsRoot: root,
    ignoreWip: false,
    ignoreDefs: false,
    templates: drift.templates,
  });
  return { drift, files: done.files.filter((file) => file.action !== "exists") };
}
