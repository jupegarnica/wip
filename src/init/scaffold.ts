import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hasGenericMark, hasWipMark, modelLine, withModelLine } from "../agents.ts";
import { WIP_DIR } from "../config.ts";
import { COORDINATOR_AGENT, GENERIC_AGENTS, TEMPLATES } from "../embedded/templates.ts";

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
  /** Relative to the project, forward slashes: where the templates go. */
  defsDir: string;
}

const GITIGNORE_ENTRY = `${WIP_DIR}/`;
const IGNORED_FORMS = new Set([WIP_DIR, `${WIP_DIR}/`, `/${WIP_DIR}`, `/${WIP_DIR}/`]);
const BACKUPS_DIR = `${WIP_DIR}/backups/defs`;

const genericKeys = new Set<string>(GENERIC_AGENTS.map((name) => `agents/${name}.md`));

/** Files at a template's path without a `wip:` mark: another tool's, never written over, not even with `--force`. */
export function foreignFiles(project: string, defsDir: string): string[] {
  return Object.keys(TEMPLATES)
    .sort()
    .map((key) => `${defsDir}/${key}`)
    .filter((rel) => {
      const file = join(project, rel);
      return existsSync(file) && !hasWipMark(readFileSync(file, "utf8"));
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

const COORDINATOR_KEY = `agents/${COORDINATOR_AGENT}.md`;

// The onboarding's answer survives `--force`; nothing else of the user's edits does (they keep their backup).
function keepsModel(key: string, current: string): boolean {
  return key === COORDINATOR_KEY || (genericKeys.has(key) && hasGenericMark(current));
}

function desired(key: string, template: string, current: string): string {
  if (!keepsModel(key, current)) return template;
  const line = modelLine(current);
  return line === null ? template : withModelLine(template, line);
}

function placeTemplate(
  project: string,
  key: string,
  template: string,
  options: IScaffoldOptions,
): IInitFile {
  const rel = `${options.defsDir}/${key}`;
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
