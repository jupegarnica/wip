import { lstatSync } from "node:fs";
import { join } from "node:path";
import { KANBAN_MOD } from "../embedded/kanban.ts";
import { QUIET_MOD } from "../embedded/quiet.ts";
import { rejected } from "../errors.ts";
import {
  applySettings,
  settingsRel,
  type TSettingsAction,
  type TSettingsFile,
} from "../init/claude-settings.ts";
import { KANBAN_SPEC, kanbanPreflight, kanbanState, syncKanban } from "../init/kanban.ts";
import type {
  IModCopyResult,
  IModPreflight,
  IModSpec,
  IModState,
  IModWarning,
} from "../init/mod-copy.ts";
import { QUIET_SPEC, quietPreflight, quietState, syncQuiet } from "../init/quiet.ts";

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
  warnings: IModWarning[];
}

export interface IApplyModOptions {
  /** `--kanban`/`--quiet`: install the copy and the `enabledPlugins` entry where missing or disabled. */
  install: boolean;
  /** `compact()` of the clock: names the backups. */
  stamp: string;
  /** The settings file `--kanban`/`--quiet` writes; the one that already wins the entry by default. */
  file?: TSettingsFile;
  /** The embedded copy; the spec's files by default (tests pass another). */
  files?: Readonly<Record<string, string>>;
}

/** Everything the upgrade applies for one mod: its spec and the copy engine bound to it. */
export interface IModOps {
  spec: IModSpec;
  files: Readonly<Record<string, string>>;
  state: (project: string) => IModState;
  preflight: (
    project: string,
    options: { requested: boolean; force: boolean; file?: TSettingsFile },
  ) => IModPreflight;
  sync: (
    project: string,
    options: {
      requested: boolean;
      force: boolean;
      stamp: string;
      files?: Readonly<Record<string, string>>;
    },
  ) => IModCopyResult | null;
}

export const kanbanOps: IModOps = {
  spec: KANBAN_SPEC,
  files: KANBAN_MOD,
  state: kanbanState,
  preflight: kanbanPreflight,
  sync: syncKanban,
};

export const quietOps: IModOps = {
  spec: QUIET_SPEC,
  files: QUIET_MOD,
  state: quietState,
  preflight: quietPreflight,
  sync: syncQuiet,
};

/** The file Claude applies the entry from: the local one when it has it, else the project one, else settings.json. */
export function preferredSettingsFile(state: IModState): TSettingsFile {
  const local = state.files["settings.local.json"];
  if (local.state === "ok" && local.value !== null) return "settings.local.json";
  const project = state.files["settings.json"];
  if (project.state === "ok" && project.value !== null) return "settings.json";
  return "settings.json";
}

function emptyResult(ops: IModOps, reason: IModResult["reason"] = null): IModResult {
  return {
    action: "skipped",
    path: `${ops.spec.dir}/`,
    backup: null,
    removed: [],
    settings: null,
    reason,
    warnings: [],
  };
}

/** Every managed path that exists on disk and is not a regular file. */
function nonRegularManaged(
  project: string,
  dir: string,
  files: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(files)
    .filter((key) => {
      const stat = lstatSync(join(project, dir, key), { throwIfNoEntry: false });
      return stat !== undefined && !stat.isFile();
    })
    .map((key) => `${dir}/${key}`);
}

/**
 * Refreshes the project's mod with the embedded copy. Without `install` it replaces only a copy wip owns and reports
 * `skipped` (reason `not-owned`) for a missing or foreign one; with it, a foreign folder, a non-regular managed
 * file, or settings that cannot take the entry throw exit 3 with nothing written. A previous folder is backed up
 * under the mod's `.wip/backups/<mod>/`; there is no merge.
 */
export function applyMod(ops: IModOps, project: string, options: IApplyModOptions): IModResult {
  const files = options.files ?? ops.files;
  const state = ops.state(project);

  if (!options.install) {
    const copy = ops.sync(project, {
      requested: false,
      force: true,
      stamp: options.stamp,
      files,
    });
    if (copy === null) return emptyResult(ops, "not-owned");
    return {
      ...emptyResult(ops),
      action:
        copy.action === "replaced" ? "updated" : copy.action === "created" ? "installed" : "exists",
      backup: copy.backup,
      removed: copy.removed,
    };
  }

  const file = options.file ?? preferredSettingsFile(state);
  const preflight = ops.preflight(project, { requested: true, force: true, file });
  const refusals = [...preflight.refusals];
  const bad = nonRegularManaged(project, ops.spec.dir, files);
  if (bad.length > 0) {
    refusals.push(
      `${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not a regular file; move it away and run again`,
    );
  }
  if (refusals.length > 0) throw rejected(`nothing written: ${refusals.join("; ")}`);

  const copy = ops.sync(project, {
    requested: true,
    force: true,
    stamp: options.stamp,
    files,
  });
  if (copy === null) throw rejected(`${ops.spec.dir} could not be installed; nothing written`);

  const chosen = state.files[file];
  const settings =
    chosen.state === "ok" && chosen.value === true
      ? { file: settingsRel(file), action: "exists" as const }
      : {
          file: settingsRel(file),
          action: applySettings(project, file, { stamp: options.stamp, id: ops.spec.pluginId })
            .action,
        };

  return {
    ...emptyResult(ops),
    action:
      copy.action === "created" ? "installed" : copy.action === "exists" ? "exists" : "updated",
    backup: copy.backup,
    removed: copy.removed,
    settings,
    warnings: preflight.warnings,
  };
}
