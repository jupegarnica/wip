import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hasGenericMark, modelLine, withModelLine } from "../agents.ts";
import { GENERIC_AGENTS, TEMPLATES } from "../embedded/templates.ts";
import { DEFS_DIR, WIP_DIR } from "../env.ts";

export type TFileAction = "created" | "exists" | "replaced";
export type TGitignoreAction = "created" | "added" | "exists";

export interface IInitFile {
  /** Relative to the project, forward slashes. */
  path: string;
  action: TFileAction;
  backup: string | null;
}

export interface IScaffold {
  wipDir: "created" | "exists";
  gitignore: TGitignoreAction;
  files: IInitFile[];
}

export interface IScaffoldOptions {
  force: boolean;
  /** Suffix of the backup files: `compact()` of the run. */
  stamp: string;
}

const GITIGNORE_ENTRY = `${WIP_DIR}/`;
const IGNORED_FORMS = new Set([WIP_DIR, `${WIP_DIR}/`, `/${WIP_DIR}`, `/${WIP_DIR}/`]);
const BACKUPS_DIR = `${WIP_DIR}/backups/defs`;

const genericKeys = new Set<string>(GENERIC_AGENTS.map((name) => `agents/${name}.md`));

/** The generic agents' files that exist without `wip: generic`: another tool's agents. */
export function foreignGenerics(project: string): string[] {
  return [...genericKeys]
    .sort()
    .map((key) => `${DEFS_DIR}/${key}`)
    .filter((rel) => {
      const file = join(project, rel);
      return existsSync(file) && !hasGenericMark(readFileSync(file, "utf8"));
    });
}

function ensureGitignore(project: string): TGitignoreAction {
  const file = join(project, ".gitignore");
  if (!existsSync(file)) {
    writeFileSync(file, `${GITIGNORE_ENTRY}\n`);
    return "created";
  }
  const text = readFileSync(file, "utf8");
  if (text.split(/\r?\n/).some((line) => IGNORED_FORMS.has(line.trim()))) return "exists";
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileSync(file, `${text}${separator}${GITIGNORE_ENTRY}\n`);
  return "added";
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// A generic that already has a model keeps it: the onboarding's answer survives `--force`.
function desired(key: string, template: string, current: string): string {
  if (!genericKeys.has(key) || !hasGenericMark(current)) return template;
  const line = modelLine(current);
  return line === null ? template : withModelLine(template, line);
}

function placeTemplate(
  project: string,
  key: string,
  template: string,
  options: IScaffoldOptions,
): IInitFile {
  const rel = `${DEFS_DIR}/${key}`;
  const file = join(project, rel);
  if (!existsSync(file)) {
    write(file, template);
    return { path: rel, action: "created", backup: null };
  }
  const current = readFileSync(file, "utf8");
  const text = desired(key, template, current);
  if (!options.force || text === current) return { path: rel, action: "exists", backup: null };
  const backup = `${BACKUPS_DIR}/${key}.${options.stamp}`;
  write(join(project, backup), current);
  write(file, text);
  return { path: rel, action: "replaced", backup };
}

/** Never overwrites without `force`; with it, every replaced file is copied to `.wip/backups/defs/` first. */
export function scaffold(project: string, options: IScaffoldOptions): IScaffold {
  const wip = join(project, WIP_DIR);
  const wipDir = existsSync(wip) ? "exists" : "created";
  mkdirSync(wip, { recursive: true });
  const gitignore = ensureGitignore(project);
  const files = Object.keys(TEMPLATES)
    .sort()
    .map((key) => placeTemplate(project, key, TEMPLATES[key] as string, options));
  return { wipDir, gitignore, files };
}
