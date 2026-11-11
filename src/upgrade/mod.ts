import { lstatSync } from "node:fs";
import { join } from "node:path";
import { KANBAN_MOD } from "../embedded/kanban.ts";
import { rejected } from "../errors.ts";
import {
  applySettings,
  settingsRel,
  type TSettingsAction,
  type TSettingsFile,
} from "../init/claude-settings.ts";
import {
  type IKanbanState,
  type IKanbanWarning,
  KANBAN_DIR,
  kanbanPreflight,
  kanbanState,
  syncKanban,
} from "../init/kanban.ts";

export type TModAction = "updated" | "installed" | "exists" | "skipped" | "failed";

export interface IModResult {
  action: TModAction;
  /** Project-relative, with a trailing slash: `.claude/skills/wip-kanban/`. */
  path: string;
  /** Project-relative path of the previous folder, or null. */
  backup: string | null;
  /** Project-relative files the replacement removed. */
  removed: string[];
  settings: { file: string; action: TSettingsAction } | null;
  reason: "no-project" | "not-owned" | null;
  /** The preflight's warnings, for the command's envelope. Not part of `data`. */
  warnings: IKanbanWarning[];
}

export interface IApplyModOptions {
  /** `--kanban`: install the copy and the `enabledPlugins` entry where missing or disabled. */
  install: boolean;
  /** `compact()` of the clock: names the backups. */
  stamp: string;
  /** The settings file `--kanban` writes; the one that already wins the entry by default. */
  file?: TSettingsFile;
  /** The embedded copy; `KANBAN_MOD` by default (tests pass another). */
  files?: Readonly<Record<string, string>>;
}

/** The file Claude applies the entry from: the local one when it has it, else the project one, else settings.json. */
export function preferredSettingsFile(state: IKanbanState): TSettingsFile {
  const local = state.files["settings.local.json"];
  if (local.state === "ok" && local.value !== null) return "settings.local.json";
  const project = state.files["settings.json"];
  if (project.state === "ok" && project.value !== null) return "settings.json";
  return "settings.json";
}

function emptyResult(reason: IModResult["reason"] = null): IModResult {
  return {
    action: "skipped",
    path: `${KANBAN_DIR}/`,
    backup: null,
    removed: [],
    settings: null,
    reason,
    warnings: [],
  };
}

/** Every managed path that exists on disk and is not a regular file. */
function nonRegularManaged(project: string, files: Readonly<Record<string, string>>): string[] {
  const dir = join(project, KANBAN_DIR);
  return Object.keys(files)
    .filter((key) => {
      const stat = lstatSync(join(dir, key), { throwIfNoEntry: false });
      return stat !== undefined && !stat.isFile();
    })
    .map((key) => `${KANBAN_DIR}/${key}`);
}

/**
 * Refreshes the project's Kanban mod with the embedded copy. Without `install` it replaces only a copy wip owns and
 * reports `skipped` (reason `not-owned`) for a missing or foreign one; with it, a foreign folder, a non-regular
 * managed file, or settings that cannot take the entry throw exit 3 with nothing written. A previous folder is
 * backed up under `.wip/backups/kanban/`; there is no merge.
 */
export function applyMod(project: string, options: IApplyModOptions): IModResult {
  const files = options.files ?? KANBAN_MOD;
  const state = kanbanState(project);

  if (!options.install) {
    const copy = syncKanban(project, {
      requested: false,
      force: true,
      stamp: options.stamp,
      files,
    });
    if (copy === null) return emptyResult("not-owned");
    return {
      ...emptyResult(),
      action:
        copy.action === "replaced" ? "updated" : copy.action === "created" ? "installed" : "exists",
      backup: copy.backup,
      removed: copy.removed,
    };
  }

  const file = options.file ?? preferredSettingsFile(state);
  const preflight = kanbanPreflight(project, { requested: true, force: true, file });
  const refusals = [...preflight.refusals];
  const bad = nonRegularManaged(project, files);
  if (bad.length > 0) {
    refusals.push(
      `${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not a regular file; move it away and run again`,
    );
  }
  if (refusals.length > 0) throw rejected(`nothing written: ${refusals.join("; ")}`);

  const copy = syncKanban(project, {
    requested: true,
    force: true,
    stamp: options.stamp,
    files,
  });
  if (copy === null) throw rejected(`${KANBAN_DIR} could not be installed; nothing written`);

  const chosen = state.files[file];
  const settings =
    chosen.state === "ok" && chosen.value === true
      ? { file: settingsRel(file), action: "exists" as const }
      : {
          file: settingsRel(file),
          action: applySettings(project, file, { stamp: options.stamp }).action,
        };

  return {
    ...emptyResult(),
    action:
      copy.action === "created" ? "installed" : copy.action === "exists" ? "exists" : "updated",
    backup: copy.backup,
    removed: copy.removed,
    settings,
    warnings: preflight.warnings,
  };
}
