import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { KANBAN_MOD } from "../embedded/kanban.ts";
import { KANBAN_PLUGIN_ID, readSettings, type TSettingsFile } from "./claude-settings.ts";

/** Where `wip init` writes the mod: always the project's own Claude skills folder, never the definitions folder. */
export const KANBAN_DIR = ".claude/skills/wip-kanban";
export const KANBAN_BACKUPS = ".wip/backups/kanban";
export const KANBAN_TYPES = ".claude-plugin/types";
const MARK_FILE = ".claude-plugin/wip.json";
const MARK_FORMAT = 1;
const MARK_OWNER = "@garndev/wip";
const MARK_PLUGIN = "wip-kanban";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type TCopyState = "missing" | "owned" | "foreign" | "not-dir";

/** Whether the folder at the mod's path is absent, wip's own copy, another tool's, or not a folder at all. */
export interface ICopyState {
  state: TCopyState;
  /** Why it is `foreign` or `not-dir`. */
  problem: string | null;
}

/** The ownership mark of a copy: exactly `{format: 1, owner: "@garndev/wip", plugin: "wip-kanban"}`. */
export function markProblem(text: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return `${KANBAN_DIR}/${MARK_FILE} is not valid JSON`;
  }
  if (!isRecord(raw)) return `${KANBAN_DIR}/${MARK_FILE} is not a JSON object`;
  const keys = Object.keys(raw).sort();
  if (keys.join(",") !== "format,owner,plugin") {
    return `${KANBAN_DIR}/${MARK_FILE} does not hold exactly format, owner and plugin`;
  }
  if (raw.format !== MARK_FORMAT || raw.owner !== MARK_OWNER || raw.plugin !== MARK_PLUGIN) {
    return `${KANBAN_DIR}/${MARK_FILE} is not wip's mark (format ${MARK_FORMAT}, owner ${MARK_OWNER}, plugin ${MARK_PLUGIN})`;
  }
  return null;
}

export function copyState(project: string): ICopyState {
  const abs = join(project, KANBAN_DIR);
  const stat = lstatSync(abs, { throwIfNoEntry: false });
  if (!stat) return { state: "missing", problem: null };
  if (!stat.isDirectory()) {
    return {
      state: "not-dir",
      problem: `${KANBAN_DIR} exists and is not a directory; move it away and run init again`,
    };
  }
  const mark = join(abs, MARK_FILE);
  if (!existsSync(mark)) {
    return {
      state: "foreign",
      problem: `${KANBAN_DIR} exists without wip's ${MARK_FILE} mark (another plugin's folder); move it away or restore the mark and run init again`,
    };
  }
  const problem = markProblem(readFileSync(mark, "utf8"));
  return problem === null
    ? { state: "owned", problem: null }
    : { state: "foreign", problem: `the copy is not wip's: ${problem}` };
}

export interface ISettingsState {
  file: TSettingsFile;
  /** As shown: `.claude/settings.json`. */
  path: string;
  state: "missing" | "ok" | "invalid" | "not-file";
  value: boolean | null;
  problem: string | null;
}

export interface IKanbanState {
  copy: TCopyState;
  copyProblem: string | null;
  files: { "settings.json": ISettingsState; "settings.local.json": ISettingsState };
}

/** Reads the copy and both settings files, writing nothing. */
export function kanbanState(project: string): IKanbanState {
  const copy = copyState(project);
  const json = readSettings(project, "settings.json");
  const local = readSettings(project, "settings.local.json");
  return {
    copy: copy.state,
    copyProblem: copy.problem,
    files: {
      "settings.json": { file: "settings.json", path: json.path, ...json.entry },
      "settings.local.json": { file: "settings.local.json", path: local.path, ...local.entry },
    },
  };
}

const isBroken = (s: ISettingsState): boolean => s.state === "invalid" || s.state === "not-file";

export interface IKanbanDefaults {
  /** The wizard's first answer: install the mod, or leave it as it is. */
  install: boolean;
  /** The wizard's second answer: where the `enabledPlugins` entry goes. */
  file: TSettingsFile;
  /** What the step shows beside the two answers. */
  notes: string[];
}

/** The entry Claude would apply: the local file's boolean wins over the project file's, if it has one. */
const effectiveEntry = (
  json: ISettingsState,
  local: ISettingsState,
): { file: TSettingsFile; value: boolean } | null => {
  if (local.state === "ok" && local.value !== null) {
    return { file: "settings.local.json", value: local.value };
  }
  if (json.state === "ok" && json.value !== null) {
    return { file: "settings.json", value: json.value };
  }
  return null;
};

/**
 * The wizard's two defaults, derived from what is on disk: `yes` when the plugin is enabled or has no entry
 * (a new project included), `no` only for an explicit `false` or a state `init` would refuse. The file is the
 * one that wins the entry, or the one that can take it when the other is unreadable.
 */
export function kanbanDefaults(state: IKanbanState): IKanbanDefaults {
  const notes: string[] = [];
  const json = state.files["settings.json"];
  const local = state.files["settings.local.json"];
  const jsonBroken = isBroken(json);
  const localBroken = isBroken(local);

  const noteBroken = (): void => {
    if (jsonBroken && localBroken) {
      notes.push(
        `both settings files are unreadable (${json.problem}; ${local.problem}); choosing yes would exit 3, so the default is no`,
      );
    } else if (jsonBroken) {
      notes.push(
        `${json.path} is unreadable (${json.problem}); the entry goes to ${local.path} so init can write it; fix ${json.path} separately`,
      );
    } else if (localBroken) {
      notes.push(
        `${local.path} is unreadable (${local.problem}); the entry goes to ${json.path} so init can write it; fix ${local.path} separately`,
      );
    }
  };

  if (state.copy === "foreign" || state.copy === "not-dir") {
    notes.push(`${state.copyProblem}; choosing yes makes init exit 3 without writing`);
    noteBroken();
    return { install: false, file: "settings.json", notes };
  }

  const effective = effectiveEntry(json, local);

  // Both files unreadable and no entry: installing would make init exit 3.
  if (effective === null && jsonBroken && localBroken) {
    noteBroken();
    return { install: false, file: "settings.json", notes };
  }

  noteBroken();

  const file: TSettingsFile =
    effective !== null
      ? effective.file
      : jsonBroken && !localBroken
        ? "settings.local.json"
        : "settings.json";

  if (effective === null) {
    if (state.copy === "owned") {
      notes.push(
        `the copy loads as ${KANBAN_PLUGIN_ID} by itself; choosing yes adds the enabledPlugins entry`,
      );
    } else {
      notes.push(
        `there is no copy under ${KANBAN_DIR} and no entry in either settings file; choosing yes installs both`,
      );
    }
    return { install: true, file, notes };
  }

  if (effective.value) {
    if (
      json.state === "ok" &&
      json.value === true &&
      local.state === "ok" &&
      local.value === true
    ) {
      notes.push(
        `${local.path} wins over ${json.path}; the project entry is redundant in this clone`,
      );
    }
    if (state.copy !== "owned") {
      notes.push(`the entry has no copy under ${KANBAN_DIR}; choosing yes installs it`);
    }
    return { install: true, file, notes };
  }

  notes.push(
    `the plugin is disabled in ${state.files[file].path}; choosing yes re-enables it in the chosen file, with a backup`,
  );
  if (state.copy !== "owned") notes.push(`there is no copy under ${KANBAN_DIR}`);
  return { install: false, file, notes };
}

/**
 * The wizard's defaults with the preflight applied: `yes` only when init would accept the chosen file.
 * It never writes; it reuses `kanbanPreflight`, the same gate `run()` uses.
 */
export function kanbanAskDefaults(
  state: IKanbanState,
  project: string,
  force: boolean,
): IKanbanDefaults {
  const base = kanbanDefaults(state);
  if (!base.install) return base;

  const other: TSettingsFile =
    base.file === "settings.json" ? "settings.local.json" : "settings.json";
  for (const file of [base.file, other]) {
    const pre = kanbanPreflight(project, { requested: true, force, file });
    if (pre.refusals.length === 0) {
      const notes =
        file === base.file
          ? base.notes
          : [...base.notes, `${base.file} cannot take the entry; the default file is ${file}`];
      return { ...base, file, notes };
    }
  }

  const pre = kanbanPreflight(project, { requested: true, force, file: base.file });
  return {
    ...base,
    install: false,
    notes: [
      ...base.notes,
      `${pre.refusals.join("; ")}; choosing yes would exit 3, so the default is no`,
    ],
  };
}

export interface IKanbanWarning {
  code: "kanban_settings_overridden" | "kanban_settings_duplicate" | "kanban_settings_unreadable";
  message: string;
}

export interface IKanbanPreflight {
  /** Why nothing may be written (exit 3). */
  refusals: string[];
  /** What the run says when it goes on; a warning never changes the exit code. */
  warnings: IKanbanWarning[];
  state: IKanbanState;
}

/** Every managed path that exists on disk and is not a regular file. */
function nonRegularManaged(project: string): string[] {
  const dir = join(project, KANBAN_DIR);
  return Object.keys(KANBAN_MOD)
    .filter((key) => {
      const stat = lstatSync(join(dir, key), { throwIfNoEntry: false });
      return stat !== undefined && !stat.isFile();
    })
    .map((key) => `${KANBAN_DIR}/${key}`);
}

/**
 * What a run would refuse and warn about, before any write: the copy's path and mark, the managed paths when it
 * syncs without `--force`, and the chosen settings file's JSON. The other settings file is read only to warn.
 */
export function kanbanPreflight(
  project: string,
  options: { requested: boolean; force: boolean; file?: TSettingsFile },
): IKanbanPreflight {
  const state = kanbanState(project);
  const refusals: string[] = [];
  const warnings: IKanbanWarning[] = [];
  const requested = options.requested;
  const file = options.file ?? "settings.json";

  if (requested) {
    if (state.copy === "not-dir") refusals.push(`${state.copyProblem}; nothing written`);
    else if (state.copy === "foreign") refusals.push(`${state.copyProblem}; nothing written`);
    else if (!options.force) {
      const bad = nonRegularManaged(project);
      if (bad.length > 0) {
        refusals.push(
          `${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not a regular file; run with --force to replace the folder, or move it away`,
        );
      }
    }
  }

  if (requested) {
    const chosen = state.files[file];
    if (isBroken(chosen)) {
      refusals.push(`${chosen.path} cannot take the entry: ${chosen.problem}; nothing written`);
    }
    const other =
      file === "settings.json" ? state.files["settings.local.json"] : state.files["settings.json"];
    if (isBroken(other)) {
      warnings.push({
        code: "kanban_settings_unreadable",
        message: `kanban_settings_unreadable: ${other.path} cannot be read (${other.problem}); the entry's precedence over ${state.files[file].path} could not be checked`,
      });
    } else if (file === "settings.json" && other.state === "ok" && other.value === false) {
      warnings.push({
        code: "kanban_settings_overridden",
        message: `kanban_settings_overridden: ${KANBAN_PLUGIN_ID} is false in ${other.path}, which Claude applies over ${state.files[file].path}: the entry this run writes stays disabled in this clone; run \`claude plugin enable ${KANBAN_PLUGIN_ID} --scope local\` or remove that key by hand`,
      });
    } else if (file === "settings.local.json" && other.state === "ok" && other.value !== true) {
      warnings.push({
        code: "kanban_settings_duplicate",
        message: `kanban_settings_duplicate: ${KANBAN_PLUGIN_ID} is false in ${other.path} while ${state.files[file].path} sets it to true, and the local file wins in this clone; the project file still tells the team the opposite; run \`claude plugin enable ${KANBAN_PLUGIN_ID} --scope project\` or remove that key by hand`,
      });
    }
  }

  return { refusals, warnings, state };
}

export class KanbanCopyFailed extends Error {
  constructor(
    message: string,
    /** Project-relative path of the backup the folder was restored from. */
    public readonly backup: string | null,
  ) {
    super(message);
  }
}

/** Every file and symbolic link under `dir`, relative with `/`, sorted; directories are not listed. */
function listTree(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listTree(dir, rel) : [rel];
    })
    .sort();
}

function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(files).sort()) {
    const file = join(dir, key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, files[key] as string);
  }
}

/** A free backup folder for the whole previous copy. */
function backupDir(project: string, stamp: string): string {
  mkdirSync(join(project, KANBAN_BACKUPS), { recursive: true });
  const base = `${KANBAN_BACKUPS}/wip-kanban.${stamp}`;
  let rel = base;
  for (let n = 2; existsSync(join(project, rel)); n++) rel = `${base}-${n}`;
  return rel;
}

/** A free sibling temp folder for the new copy. */
function tempDir(project: string, stamp: string): string {
  const skills = join(project, KANBAN_DIR, "..");
  const base = `.wip-kanban.${stamp}.tmp`;
  let name = base;
  for (let n = 2; existsSync(join(skills, name)); n++) name = `${base}-${n}`;
  return name;
}

export type TCopyAction = "created" | "updated" | "replaced" | "exists";

export interface IKanbanCopyResult {
  action: TCopyAction;
  /** Project-relative path of the previous folder, or null. */
  backup: string | null;
  /** Files the replacement removed, project-relative. */
  removed: string[];
  /** Managed files that differ on disk (no `--force`). */
  differ: string[];
  /** Whether bytes changed. */
  touched: boolean;
}

/** Whether every managed file matches and no extra file is present (generated types excepted). */
function sameCopy(dir: string, files: Readonly<Record<string, string>>): boolean {
  for (const [key, text] of Object.entries(files)) {
    const abs = join(dir, key);
    const stat = lstatSync(abs, { throwIfNoEntry: false });
    if (!stat?.isFile() || readFileSync(abs, "utf8") !== text) return false;
  }
  const managed = new Set(Object.keys(files));
  return listTree(dir).every(
    (rel) => managed.has(rel) || rel === KANBAN_TYPES || rel.startsWith(`${KANBAN_TYPES}/`),
  );
}

/** Replaces the whole folder: backup, write a sibling temp, swap, and keep the generated types. */
function replaceCopy(
  project: string,
  files: Readonly<Record<string, string>>,
  stamp: string,
): IKanbanCopyResult {
  const dest = join(project, KANBAN_DIR);
  const managed = new Set(Object.keys(files));
  const removed = listTree(dest)
    .filter((rel) => !managed.has(rel) && !rel.startsWith(`${KANBAN_TYPES}/`))
    .map((rel) => `${KANBAN_DIR}/${rel}`);
  const backup = backupDir(project, stamp);
  cpSync(dest, join(project, backup), { recursive: true, dereference: false });

  const skills = join(project, KANBAN_DIR, "..");
  const tempName = tempDir(project, stamp);
  const temp = join(skills, tempName);
  try {
    mkdirSync(temp, { recursive: true });
    writeFiles(temp, files);
    rmSync(dest, { recursive: true, force: true });
    renameSync(temp, dest);
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(join(project, backup), dest, { recursive: true, dereference: false });
    throw new KanbanCopyFailed(
      `replacing ${KANBAN_DIR} failed (${(err as Error).message}); the previous folder was restored`,
      backup,
    );
  }

  const typesFrom = join(project, backup, KANBAN_TYPES);
  if (existsSync(typesFrom)) {
    cpSync(typesFrom, join(dest, KANBAN_TYPES), { recursive: true, dereference: false });
  }
  return { action: "replaced", backup, removed, differ: [], touched: true };
}

/**
 * Brings the copy in line with the embedded mod: `null` when the run has nothing to do with it, otherwise the
 * action. Without `--force` only missing files are created; with it the whole folder is replaced and backed up.
 */
export function syncKanban(
  project: string,
  options: {
    requested: boolean;
    force: boolean;
    stamp: string;
    files?: Readonly<Record<string, string>>;
  },
): IKanbanCopyResult | null {
  const files = options.files ?? KANBAN_MOD;
  const state = copyState(project);
  const dest = join(project, KANBAN_DIR);
  if (!options.requested && state.state !== "owned") return null;
  if (options.requested && state.state !== "missing" && state.state !== "owned") {
    throw new KanbanCopyFailed(state.problem ?? `${KANBAN_DIR} is not wip's`, null);
  }

  if (options.force) {
    if (state.state === "missing") {
      mkdirSync(dest, { recursive: true });
      writeFiles(dest, files);
      return { action: "created", backup: null, removed: [], differ: [], touched: true };
    }
    if (sameCopy(dest, files)) {
      return { action: "exists", backup: null, removed: [], differ: [], touched: false };
    }
    return replaceCopy(project, files, options.stamp);
  }

  if (state.state === "missing") {
    mkdirSync(dest, { recursive: true });
    writeFiles(dest, files);
    return { action: "created", backup: null, removed: [], differ: [], touched: true };
  }

  let created = 0;
  const differ: string[] = [];
  for (const [key, text] of Object.entries(files)) {
    const abs = join(dest, key);
    const stat = lstatSync(abs, { throwIfNoEntry: false });
    if (!stat) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
      created++;
      continue;
    }
    if (!stat.isFile()) {
      throw new KanbanCopyFailed(
        `${KANBAN_DIR}/${key} is not a regular file; run with --force`,
        null,
      );
    }
    if (readFileSync(abs, "utf8") !== text) differ.push(`${KANBAN_DIR}/${key}`);
  }
  return {
    action: created > 0 ? "updated" : "exists",
    backup: null,
    removed: [],
    differ,
    touched: created > 0,
  };
}
