import { QUIET_MOD } from "../embedded/quiet.ts";
import { QUIET_PLUGIN_ID } from "./claude-settings.ts";
import {
  createMod,
  type IModCopyResult,
  type IModDefaults,
  type IModPreflight,
  type IModPreview,
  type IModSpec,
  type IModState,
} from "./mod-copy.ts";

/** Where `wip init` writes the mod: always the project's own Claude skills folder, never the definitions folder. */
export const QUIET_DIR = ".claude/skills/wip-quiet";
export const QUIET_BACKUPS = ".wip/backups/quiet";
export const QUIET_TYPES = ".claude-plugin/types";

export const QUIET_SPEC: IModSpec = {
  dir: QUIET_DIR,
  backups: QUIET_BACKUPS,
  typesDir: QUIET_TYPES,
  owner: "@garndev/wip",
  plugin: "wip-quiet",
  pluginId: QUIET_PLUGIN_ID,
  warningPrefix: "quiet",
  label: "Quiet",
  files: QUIET_MOD,
};

const mod = createMod(QUIET_SPEC);

export type IQuietState = IModState;
export type IQuietDefaults = IModDefaults;
export type IQuietPreflight = IModPreflight;
export type IQuietPreview = IModPreview;
export type IQuietCopyResult = IModCopyResult;

export const quietMarkProblem = mod.markProblem;
export const quietCopyState = mod.copyState;
export const quietState = mod.state;
export const quietDefaults = mod.defaults;
export const quietAskDefaults = mod.askDefaults;
export const quietPreflight = mod.preflight;
export const quietPreview = mod.preview;
export const syncQuiet = mod.sync;
