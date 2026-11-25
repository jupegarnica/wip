import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { rejected } from "../errors.ts";

/** The entry `wip init` writes: a plugin Claude Code discovers in the project's skills folder. */
export const KANBAN_PLUGIN_ID = "wip-kanban@skills-dir";
export const QUIET_PLUGIN_ID = "wip-quiet@skills-dir";

/** The two settings files the mod may use; `settings.json` is Claude's project scope, the other its local one. */
export const SETTINGS_FILES = ["settings.json", "settings.local.json"] as const;
export type TSettingsFile = (typeof SETTINGS_FILES)[number];
export type TSettingsScope = "project" | "local";

export const SETTINGS_SCHEMA = "https://json.schemastore.org/claude-code-settings.json";
const SETTINGS_DIR = ".claude";
const BACKUPS_DIR = ".wip/backups/claude-settings";

export function isSettingsFile(value: string): value is TSettingsFile {
  return (SETTINGS_FILES as readonly string[]).includes(value);
}

/** `settings.json` is project scope; `settings.local.json` is local scope in Claude's terms. */
export function scopeOf(file: TSettingsFile): TSettingsScope {
  return file === "settings.local.json" ? "local" : "project";
}

export function settingsRel(file: TSettingsFile): string {
  return `${SETTINGS_DIR}/${file}`;
}

export function settingsAbs(project: string, file: TSettingsFile): string {
  return join(project, SETTINGS_DIR, file);
}

export type TEntryState = "missing" | "ok" | "invalid" | "not-file";

/** The id's entry in one settings file, read without writing; `not-file` is a directory or a symbolic link. */
export interface IEntry {
  state: TEntryState;
  /** The value when `state` is `ok`. */
  value: boolean | null;
  /** Why it is invalid or not a file; null otherwise. */
  problem: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `abs` is a regular file, a directory, a link or missing. */
export function fileKind(abs: string): "file" | "not-file" | "missing" {
  const stat = lstatSync(abs, { throwIfNoEntry: false });
  if (!stat) return "missing";
  return stat.isFile() ? "file" : "not-file";
}

/** The id's entry of a settings file, read only: `missing|ok|invalid|not-file` and its boolean value. */
export function readEntry(abs: string, id: string = KANBAN_PLUGIN_ID): IEntry {
  const kind = fileKind(abs);
  if (kind === "missing") return { state: "missing", value: null, problem: null };
  if (kind === "not-file") {
    return { state: "not-file", value: null, problem: `${abs} is not a regular file` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return { state: "invalid", value: null, problem: `${abs} is not valid JSON` };
  }
  if (!isRecord(raw))
    return { state: "invalid", value: null, problem: `${abs} is not a JSON object` };
  const plugins = raw.enabledPlugins;
  if (plugins === undefined) return { state: "missing", value: null, problem: null };
  if (!isRecord(plugins)) {
    return { state: "invalid", value: null, problem: `enabledPlugins in ${abs} is not an object` };
  }
  const value = plugins[id];
  if (value === undefined) return { state: "missing", value: null, problem: null };
  if (typeof value !== "boolean") {
    return {
      state: "invalid",
      value: null,
      problem: `enabledPlugins["${id}"] in ${abs} is not a boolean`,
    };
  }
  return { state: "ok", value, problem: null };
}

export interface ISettingsRead {
  file: TSettingsFile;
  /** As shown: `.claude/settings.json`. */
  path: string;
  absolute: string;
  entry: IEntry;
}

export function readSettings(
  project: string,
  file: TSettingsFile,
  id: string = KANBAN_PLUGIN_ID,
): ISettingsRead {
  const absolute = settingsAbs(project, file);
  return { file, path: settingsRel(file), absolute, entry: readEntry(absolute, id) };
}

/** A free path under `.wip/backups/claude-settings/`; the basename keeps the two files' backups apart. */
function backupPath(project: string, file: TSettingsFile, stamp: string): string {
  mkdirSync(join(project, BACKUPS_DIR), { recursive: true });
  const base = `${basename(file)}.${stamp}`;
  let rel = `${BACKUPS_DIR}/${base}`;
  for (let n = 2; existsSync(join(project, rel)); n++) rel = `${BACKUPS_DIR}/${base}-${n}`;
  return rel;
}

/** Writes beside the target and renames, so a failed write never leaves half a settings file. */
function writeAtomic(abs: string, text: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${basename(abs)}.wip.tmp`);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, abs);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export type TSettingsAction = "created" | "added" | "updated" | "exists";

export interface ISettingsResult {
  action: TSettingsAction;
  /** Project-relative path of the backup of the file as it was, or null. */
  backup: string | null;
}

export interface ISettingsManyResult {
  /** Project-relative path of the backup of the file as it was, or null. */
  backup: string | null;
  /** The action per id, in the caller's order. */
  actions: Record<string, TSettingsAction>;
}

/**
 * Merges `"<id>": true` for every id into the chosen settings file, preserving every other key and every other
 * plugin, backs the previous text up once and writes once. It validates every id before writing anything, so one
 * unusable entry refuses the whole write; a file whose JSON or `enabledPlugins` is not usable, or one that is not a
 * regular file, is refused too.
 */
export function applySettingsMany(
  project: string,
  file: TSettingsFile,
  ids: readonly string[],
  options: { stamp: string },
): ISettingsManyResult {
  const abs = settingsAbs(project, file);
  const rel = settingsRel(file);
  const kind = fileKind(abs);
  if (kind === "not-file") throw rejected(`${rel} is not a regular file; nothing written`);
  if (kind === "missing") {
    const created = {
      $schema: SETTINGS_SCHEMA,
      enabledPlugins: Object.fromEntries(ids.map((id) => [id, true])),
    };
    writeAtomic(abs, `${JSON.stringify(created, null, 2)}\n`);
    return { backup: null, actions: Object.fromEntries(ids.map((id) => [id, "created"])) };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    throw rejected(`${rel} is not valid JSON; nothing written`);
  }
  if (!isRecord(raw)) throw rejected(`${rel} is not a JSON object; nothing written`);
  const plugins = raw.enabledPlugins;
  if (plugins !== undefined && !isRecord(plugins)) {
    throw rejected(`enabledPlugins in ${rel} is not an object; nothing written`);
  }

  const actions: Record<string, TSettingsAction> = {};
  const writable: string[] = [];
  for (const id of ids) {
    const current = isRecord(plugins) ? plugins[id] : undefined;
    if (current !== undefined && typeof current !== "boolean") {
      throw rejected(`enabledPlugins["${id}"] in ${rel} is not a boolean; nothing written`);
    }
    if (current === true) actions[id] = "exists";
    else {
      actions[id] = current === false ? "updated" : "added";
      writable.push(id);
    }
  }
  if (writable.length === 0) return { backup: null, actions };

  const out: Record<string, unknown> = {};
  let hasPlugins = false;
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "enabledPlugins") {
      out[key] = value;
      continue;
    }
    out[key] = {
      ...(value as Record<string, unknown>),
      ...Object.fromEntries(writable.map((id) => [id, true])),
    };
    hasPlugins = true;
  }
  if (!hasPlugins) {
    out.enabledPlugins = Object.fromEntries(writable.map((id) => [id, true]));
  }

  const previous = readFileSync(abs, "utf8");
  const backup = backupPath(project, file, options.stamp);
  writeFileSync(join(project, backup), previous);
  writeAtomic(abs, `${JSON.stringify(out, null, 2)}\n`);
  return { backup, actions };
}

/** Merges one `"<id>": true`; the one-id case of `applySettingsMany`. */
export function applySettings(
  project: string,
  file: TSettingsFile,
  options: { stamp: string; id?: string },
): ISettingsResult {
  const id = options.id ?? KANBAN_PLUGIN_ID;
  const many = applySettingsMany(project, file, [id], options);
  return { action: many.actions[id] ?? "exists", backup: many.backup };
}
