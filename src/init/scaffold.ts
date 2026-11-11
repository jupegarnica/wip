import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hasGenericMark, hasWipMark, modelLine, withModelLine } from "../agents.ts";
import { WIP_DIR } from "../config.ts";
import { COORDINATOR_AGENT, GENERIC_AGENTS, TEMPLATES } from "../embedded/templates.ts";

export type TFileAction = "created" | "exists" | "replaced";
export type TGitignoreAction = "created" | "added" | "exists";
export type TGitignoreResult = TGitignoreAction | "skipped";

export interface IInitFile {
  /** As shown: relative to the project, or `~/…`; forward slashes. */
  path: string;
  action: TFileAction;
  backup: string | null;
}

export interface IScaffold {
  wipDir: "created" | "exists";
  /** The action on `.wip/`; `skipped` when `--gitignore` leaves it out. */
  gitignore: TGitignoreResult;
  /** The action on the definitions' entries; `skipped` when `defs` was not asked. */
  gitignoreDefs: TGitignoreResult;
  files: IInitFile[];
}

export interface IScaffoldOptions {
  force: boolean;
  /** Suffix of the backup files: `compact()` of the run. */
  stamp: string;
  /** As shown: relative to the project, or `~/…`; forward slashes: where the templates go. */
  defsDir: string;
  /** Absolute path of that folder on disk. */
  defsRoot: string;
  /** Whether `.wip/` goes into `.gitignore` (default true). */
  ignoreWip?: boolean;
  /** Also write the definitions' own paths into `.gitignore` (local scope only; the default is not to). */
  ignoreDefs?: boolean;
  /** What to write; `TEMPLATES` when missing (a selection keeps every non-flow template and only some flows). */
  templates?: Readonly<Record<string, string>>;
}

const GITIGNORE_ENTRY = `${WIP_DIR}/`;
const BACKUPS_DIR = `${WIP_DIR}/backups/defs`;

const genericKeys = new Set<string>(GENERIC_AGENTS.map((name) => `agents/${name}.md`));

/** Files at a template's path without a `wip:` mark: another tool's, never written over, not even with `--force`. */
export function foreignFiles(
  defsRoot: string,
  defsDir: string,
  templates: Readonly<Record<string, string>> = TEMPLATES,
): string[] {
  return Object.keys(templates)
    .sort()
    .filter((key) => {
      const file = join(defsRoot, key);
      return existsSync(file) && !hasWipMark(readFileSync(file, "utf8"));
    })
    .map((key) => `${defsDir}/${key}`);
}

const DEFS_HEADER = "# wip definitions";

/** The `.gitignore` entries of the templates under `defsDir` (relative, no `~/`): agent files and one folder per skill. */
export function defsIgnoreEntries(
  defsDir: string,
  templates: Readonly<Record<string, string>> = TEMPLATES,
): string[] {
  const out = new Set<string>();
  for (const key of Object.keys(templates).sort()) {
    const m = /^(skills\/[^/]+)\//.exec(key);
    out.add(m ? `${defsDir}/${m[1]}/` : `${defsDir}/${key}`);
  }
  return [...out];
}

/** Whether `.gitignore` of the project already ignores `entry` (the forms of `.wip` count as equal). */
export function isIgnored(project: string, entry: string): boolean {
  const file = join(project, ".gitignore");
  if (!existsSync(file)) return false;
  return hasEntry(readFileSync(file, "utf8"), entry);
}

function equivalents(entry: string): Set<string> {
  const bare = entry.replace(/^\//, "").replace(/\/$/, "");
  return new Set([bare, `${bare}/`, `/${bare}`, `/${bare}/`]);
}

function hasEntry(text: string, entry: string): boolean {
  const forms = equivalents(entry);
  return text.split(/\r?\n/).some((line) => forms.has(line.trim()));
}

/**
 * Appends the entries not there yet (one per line, after `header` when given), creating the file when missing.
 * Idempotent; the line ending already in the file is kept.
 */
function ensureGitignore(
  project: string,
  entries: readonly string[],
  header?: string,
): TGitignoreAction {
  const file = join(project, ".gitignore");
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, "utf8") : "";
  const missing = entries.filter((e) => !hasEntry(text, e));
  if (exists && missing.length === 0) return "exists";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const separator = text === "" || text.endsWith("\n") ? "" : eol;
  const head = header !== undefined && !text.split(/\r?\n/).some((l) => l.trim() === header);
  const block = [...(head ? [header] : []), ...missing].map((l) => `${l}${eol}`).join("");
  writeFileSync(file, `${text}${separator}${block}`);
  return exists ? "added" : "created";
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
  const file = join(options.defsRoot, key);
  if (!existsSync(file)) {
    write(file, template);
    return { path: rel, action: "created", backup: null };
  }
  const current = readFileSync(file, "utf8");
  const text = options.force ? desired(key, template, current) : current;
  if (text === current) return { path: rel, action: "exists", backup: null };
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
  const gitignore =
    options.ignoreWip === false ? "skipped" : ensureGitignore(project, [GITIGNORE_ENTRY]);
  const templates = options.templates ?? TEMPLATES;
  const files = Object.keys(templates)
    .sort()
    .map((key) => placeTemplate(project, key, templates[key] as string, options));
  const gitignoreDefs = options.ignoreDefs
    ? ensureGitignore(project, defsIgnoreEntries(options.defsDir, templates), DEFS_HEADER)
    : "skipped";
  return { wipDir, gitignore, gitignoreDefs, files };
}
