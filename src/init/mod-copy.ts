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
import { readSettings, type TSettingsFile } from "./claude-settings.ts";

/** What makes a mod's copy wip's own, whatever the mod: its paths, its settings id and its embedded files. */
export interface IModSpec {
  /** Where `wip init` writes the mod: always the project's own Claude skills folder. */
  dir: string;
  /** Where a previous copy is backed up, under `.wip/backups/`. */
  backups: string;
  /** The folder Claude Code generates beside the copy; a replacement keeps it. */
  typesDir: string;
  /** The ownership mark's owner. */
  owner: string;
  /** The ownership mark's plugin, and the copy's folder name under `.wip/backups/`. */
  plugin: string;
  /** The `enabledPlugins` id: `<plugin>@skills-dir`. */
  pluginId: string;
  /** The prefix of the settings warnings: `kanban` or `quiet`. */
  warningPrefix: string;
  /** The name the wizard and the settings use: `Kanban` or `Quiet`. */
  label: string;
  /** The files to write, keyed by their path under `dir`. */
  files: Readonly<Record<string, string>>;
}

const MARK_FILE = ".claude-plugin/wip.json";
const MARK_FORMAT = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type TCopyState = "missing" | "owned" | "foreign" | "not-dir";

/** Whether the folder at the mod's path is absent, wip's own copy, another tool's, or not a folder at all. */
export interface ICopyState {
  state: TCopyState;
  /** Why it is `foreign` or `not-dir`. */
  problem: string | null;
}

export interface ISettingsState {
  file: TSettingsFile;
  /** As shown: `.claude/settings.json`. */
  path: string;
  state: "missing" | "ok" | "invalid" | "not-file";
  value: boolean | null;
  problem: string | null;
}

export interface IModState {
  copy: TCopyState;
  copyProblem: string | null;
  files: { "settings.json": ISettingsState; "settings.local.json": ISettingsState };
}

export interface IModDefaults {
  /** The wizard's first answer: install the mod, or leave it as it is. */
  install: boolean;
  /** The wizard's second answer: where the `enabledPlugins` entry goes. */
  file: TSettingsFile;
  /** What the step shows beside the two answers. */
  notes: string[];
}

export interface IModWarning {
  code: string;
  message: string;
}

export interface IModPreflight {
  /** Why nothing may be written (exit 3). */
  refusals: string[];
  /** What the run says when it goes on; a warning never changes the exit code. */
  warnings: IModWarning[];
  state: IModState;
}

export type TCopyAction = "created" | "updated" | "replaced" | "exists";

export interface IModCopyResult {
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

export class ModCopyFailed extends Error {
  constructor(
    message: string,
    /** Project-relative path of the backup the folder was restored from. */
    public readonly backup: string | null,
  ) {
    super(message);
  }
}

const isBroken = (s: ISettingsState): boolean => s.state === "invalid" || s.state === "not-file";

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

/** Whether every managed file matches and no extra file is present (generated types excepted). */
function sameCopy(dir: string, spec: IModSpec): boolean {
  for (const [key, text] of Object.entries(spec.files)) {
    const abs = join(dir, key);
    const stat = lstatSync(abs, { throwIfNoEntry: false });
    if (!stat?.isFile() || readFileSync(abs, "utf8") !== text) return false;
  }
  const managed = new Set(Object.keys(spec.files));
  return listTree(dir).every(
    (rel) => managed.has(rel) || rel === spec.typesDir || rel.startsWith(`${spec.typesDir}/`),
  );
}

/**
 * The copy engine of one mod: everything `wip init` and `wip upgrade` do around `<dir>`, bound to the mod's
 * `IModSpec` so the Kanban and Quiet copies share it and their messages differ only in the paths and the id.
 */
export function createMod(spec: IModSpec) {
  /** The ownership mark of a copy: exactly `{format: 1, owner, plugin}`. */
  const markProblem = (text: string): string | null => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return `${spec.dir}/${MARK_FILE} is not valid JSON`;
    }
    if (!isRecord(raw)) return `${spec.dir}/${MARK_FILE} is not a JSON object`;
    const keys = Object.keys(raw).sort();
    if (keys.join(",") !== "format,owner,plugin") {
      return `${spec.dir}/${MARK_FILE} does not hold exactly format, owner and plugin`;
    }
    if (raw.format !== MARK_FORMAT || raw.owner !== spec.owner || raw.plugin !== spec.plugin) {
      return `${spec.dir}/${MARK_FILE} is not wip's mark (format ${MARK_FORMAT}, owner ${spec.owner}, plugin ${spec.plugin})`;
    }
    return null;
  };

  /** Whether the folder at the mod's path is absent, wip's own copy, another tool's, or not a folder at all. */
  const copyState = (project: string): ICopyState => {
    const abs = join(project, spec.dir);
    const stat = lstatSync(abs, { throwIfNoEntry: false });
    if (!stat) return { state: "missing", problem: null };
    if (!stat.isDirectory()) {
      return {
        state: "not-dir",
        problem: `${spec.dir} exists and is not a directory; move it away and run init again`,
      };
    }
    const mark = join(abs, MARK_FILE);
    if (!existsSync(mark)) {
      return {
        state: "foreign",
        problem: `${spec.dir} exists without wip's ${MARK_FILE} mark (another plugin's folder); move it away or restore the mark and run init again`,
      };
    }
    const problem = markProblem(readFileSync(mark, "utf8"));
    return problem === null
      ? { state: "owned", problem: null }
      : { state: "foreign", problem: `the copy is not wip's: ${problem}` };
  };

  /** Reads the copy and both settings files, writing nothing. */
  const state = (project: string): IModState => {
    const copy = copyState(project);
    const json = readSettings(project, "settings.json", spec.pluginId);
    const local = readSettings(project, "settings.local.json", spec.pluginId);
    return {
      copy: copy.state,
      copyProblem: copy.problem,
      files: {
        "settings.json": { file: "settings.json", path: json.path, ...json.entry },
        "settings.local.json": { file: "settings.local.json", path: local.path, ...local.entry },
      },
    };
  };

  /**
   * The wizard's two defaults, derived from what is on disk: `yes` when the plugin is enabled or has no entry
   * (a new project included), `no` only for an explicit `false` or a state `init` would refuse. The file is the
   * one that wins the entry, or the one that can take it when the other is unreadable.
   */
  const defaults = (mod: IModState): IModDefaults => {
    const notes: string[] = [];
    const json = mod.files["settings.json"];
    const local = mod.files["settings.local.json"];
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

    if (mod.copy === "foreign" || mod.copy === "not-dir") {
      notes.push(`${mod.copyProblem}; choosing yes makes init exit 3 without writing`);
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
      if (mod.copy === "owned") {
        notes.push(
          `the copy loads as ${spec.pluginId} by itself; choosing yes adds the enabledPlugins entry`,
        );
      } else {
        notes.push(
          `there is no copy under ${spec.dir} and no entry in either settings file; choosing yes installs both`,
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
      if (mod.copy !== "owned") {
        notes.push(`the entry has no copy under ${spec.dir}; choosing yes installs it`);
      }
      return { install: true, file, notes };
    }

    notes.push(
      `the plugin is disabled in ${mod.files[file].path}; choosing yes re-enables it in the chosen file, with a backup`,
    );
    if (mod.copy !== "owned") notes.push(`there is no copy under ${spec.dir}`);
    return { install: false, file, notes };
  };

  /** Every managed path that exists on disk and is not a regular file. */
  const nonRegularManaged = (project: string): string[] => {
    const dir = join(project, spec.dir);
    return Object.keys(spec.files)
      .filter((key) => {
        const stat = lstatSync(join(dir, key), { throwIfNoEntry: false });
        return stat !== undefined && !stat.isFile();
      })
      .map((key) => `${spec.dir}/${key}`);
  };

  /**
   * What a run would refuse and warn about, before any write: the copy's path and mark, the managed paths when it
   * syncs without `--force`, and the chosen settings file's JSON. The other settings file is read only to warn.
   */
  const preflight = (
    project: string,
    options: { requested: boolean; force: boolean; file?: TSettingsFile },
  ): IModPreflight => {
    const mod = state(project);
    const refusals: string[] = [];
    const warnings: IModWarning[] = [];
    const requested = options.requested;
    const file = options.file ?? "settings.json";

    if (requested) {
      if (mod.copy === "not-dir") refusals.push(`${mod.copyProblem}; nothing written`);
      else if (mod.copy === "foreign") refusals.push(`${mod.copyProblem}; nothing written`);
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
      const chosen = mod.files[file];
      if (isBroken(chosen)) {
        refusals.push(`${chosen.path} cannot take the entry: ${chosen.problem}; nothing written`);
      }
      const other =
        file === "settings.json" ? mod.files["settings.local.json"] : mod.files["settings.json"];
      if (isBroken(other)) {
        warnings.push({
          code: `${spec.warningPrefix}_settings_unreadable`,
          message: `${spec.warningPrefix}_settings_unreadable: ${other.path} cannot be read (${other.problem}); the entry's precedence over ${mod.files[file].path} could not be checked`,
        });
      } else if (file === "settings.json" && other.state === "ok" && other.value === false) {
        warnings.push({
          code: `${spec.warningPrefix}_settings_overridden`,
          message: `${spec.warningPrefix}_settings_overridden: ${spec.pluginId} is false in ${other.path}, which Claude applies over ${mod.files[file].path}: the entry this run writes stays disabled in this clone; run \`claude plugin enable ${spec.pluginId} --scope local\` or remove that key by hand`,
        });
      } else if (file === "settings.local.json" && other.state === "ok" && other.value !== true) {
        warnings.push({
          code: `${spec.warningPrefix}_settings_duplicate`,
          message: `${spec.warningPrefix}_settings_duplicate: ${spec.pluginId} is false in ${other.path} while ${mod.files[file].path} sets it to true, and the local file wins in this clone; the project file still tells the team the opposite; run \`claude plugin enable ${spec.pluginId} --scope project\` or remove that key by hand`,
        });
      }
    }

    return { refusals, warnings, state: mod };
  };

  /** The wizard's defaults with the preflight applied: `yes` only when init would accept the chosen file. */
  const askDefaults = (mod: IModState, project: string, force: boolean): IModDefaults => {
    const base = defaults(mod);
    if (!base.install) return base;

    const other: TSettingsFile =
      base.file === "settings.json" ? "settings.local.json" : "settings.json";
    for (const file of [base.file, other]) {
      const pre = preflight(project, { requested: true, force, file });
      if (pre.refusals.length === 0) {
        const notes =
          file === base.file
            ? base.notes
            : [...base.notes, `${base.file} cannot take the entry; the default file is ${file}`];
        return { ...base, file, notes };
      }
    }

    const pre = preflight(project, { requested: true, force, file: base.file });
    return {
      ...base,
      install: false,
      notes: [
        ...base.notes,
        `${pre.refusals.join("; ")}; choosing yes would exit 3, so the default is no`,
      ],
    };
  };

  /** A free backup folder for the whole previous copy. */
  const backupDir = (project: string, stamp: string): string => {
    mkdirSync(join(project, spec.backups), { recursive: true });
    const base = `${spec.backups}/${spec.plugin}.${stamp}`;
    let rel = base;
    for (let n = 2; existsSync(join(project, rel)); n++) rel = `${base}-${n}`;
    return rel;
  };

  /** A free sibling temp folder for the new copy. */
  const tempDir = (project: string, stamp: string): string => {
    const skills = join(project, spec.dir, "..");
    const base = `.${spec.plugin}.${stamp}.tmp`;
    let name = base;
    for (let n = 2; existsSync(join(skills, name)); n++) name = `${base}-${n}`;
    return name;
  };

  /** Replaces the whole folder: backup, write a sibling temp, swap, and keep the generated types. */
  const replaceCopy = (
    project: string,
    stamp: string,
    files: Readonly<Record<string, string>>,
  ): IModCopyResult => {
    const dest = join(project, spec.dir);
    const managed = new Set(Object.keys(files));
    const removed = listTree(dest)
      .filter((rel) => !managed.has(rel) && !rel.startsWith(`${spec.typesDir}/`))
      .map((rel) => `${spec.dir}/${rel}`);
    const backup = backupDir(project, stamp);
    cpSync(dest, join(project, backup), { recursive: true, dereference: false });

    const skills = join(project, spec.dir, "..");
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
      throw new ModCopyFailed(
        `replacing ${spec.dir} failed (${(err as Error).message}); the previous folder was restored`,
        backup,
      );
    }

    const typesFrom = join(project, backup, spec.typesDir);
    if (existsSync(typesFrom)) {
      cpSync(typesFrom, join(dest, spec.typesDir), { recursive: true, dereference: false });
    }
    return { action: "replaced", backup, removed, differ: [], touched: true };
  };

  /**
   * Brings the copy in line with the embedded mod: `null` when the run has nothing to do with it, otherwise the
   * action. Without `--force` only missing files are created; with it the whole folder is replaced and backed up.
   */
  const sync = (
    project: string,
    options: {
      requested: boolean;
      force: boolean;
      stamp: string;
      files?: Readonly<Record<string, string>>;
    },
  ): IModCopyResult | null => {
    const files = options.files ?? spec.files;
    const specWith = files === spec.files ? spec : { ...spec, files };
    const copy = copyState(project);
    const dest = join(project, spec.dir);
    if (!options.requested && copy.state !== "owned") return null;
    if (options.requested && copy.state !== "missing" && copy.state !== "owned") {
      throw new ModCopyFailed(copy.problem ?? `${spec.dir} is not wip's`, null);
    }

    if (options.force) {
      if (copy.state === "missing") {
        mkdirSync(dest, { recursive: true });
        writeFiles(dest, files);
        return { action: "created", backup: null, removed: [], differ: [], touched: true };
      }
      if (sameCopy(dest, specWith)) {
        return { action: "exists", backup: null, removed: [], differ: [], touched: false };
      }
      return replaceCopy(project, options.stamp, files);
    }

    if (copy.state === "missing") {
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
        throw new ModCopyFailed(`${spec.dir}/${key} is not a regular file; run with --force`, null);
      }
      if (readFileSync(abs, "utf8") !== text) differ.push(`${spec.dir}/${key}`);
    }
    return {
      action: created > 0 ? "updated" : "exists",
      backup: null,
      removed: [],
      differ,
      touched: created > 0,
    };
  };

  return { markProblem, copyState, state, defaults, askDefaults, preflight, sync, spec };
}
