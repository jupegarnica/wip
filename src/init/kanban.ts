import { KANBAN_MOD } from "../embedded/kanban.ts";
import { KANBAN_PLUGIN_ID } from "./claude-settings.ts";
import {
  createMod,
  type ICopyState,
  type IModCopyResult,
  type IModDefaults,
  type IModPreflight,
  type IModSpec,
  type IModState,
  type IModWarning,
  ModCopyFailed,
  type TCopyAction,
  type TCopyState,
} from "./mod-copy.ts";

/** Where `wip init` writes the mod: always the project's own Claude skills folder, never the definitions folder. */
export const KANBAN_DIR = ".claude/skills/wip-kanban";
export const KANBAN_BACKUPS = ".wip/backups/kanban";
export const KANBAN_TYPES = ".claude-plugin/types";

export const KANBAN_SPEC: IModSpec = {
  dir: KANBAN_DIR,
  backups: KANBAN_BACKUPS,
  typesDir: KANBAN_TYPES,
  owner: "@garndev/wip",
  plugin: "wip-kanban",
  pluginId: KANBAN_PLUGIN_ID,
  warningPrefix: "kanban",
  label: "Kanban",
  files: KANBAN_MOD,
};

const mod = createMod(KANBAN_SPEC);

export type { ICopyState, TCopyAction, TCopyState };
export type IKanbanState = IModState;
export type IKanbanDefaults = IModDefaults;
export type IKanbanWarning = IModWarning;
export type IKanbanPreflight = IModPreflight;
export type IKanbanCopyResult = IModCopyResult;

/** The ownership mark of a copy: exactly `{format: 1, owner: "@garndev/wip", plugin: "wip-kanban"}`. */
export const markProblem = mod.markProblem;

export const copyState = mod.copyState;

/** Reads the copy and both settings files, writing nothing. */
export const kanbanState = mod.state;

/** The wizard's two defaults, derived from what is on disk. */
export const kanbanDefaults = mod.defaults;

/** The wizard's defaults with the preflight applied: `yes` only when init would accept the chosen file. */
export const kanbanAskDefaults = mod.askDefaults;

/** What a run would refuse and warn about, before any write. */
export const kanbanPreflight = mod.preflight;

/**
 * Brings the copy in line with the embedded mod: `null` when the run has nothing to do with it, otherwise the
 * action. Without `--force` only missing files are created; with it the whole folder is replaced and backed up.
 */
export const syncKanban = mod.sync;

export { ModCopyFailed as KanbanCopyFailed };
