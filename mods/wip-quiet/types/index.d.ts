export type QuietCategory =
  | "bash"
  | "agent"
  | "cron"
  | "files"
  | "msg"
  | "mcp"
  | "misc"
  | "errors"
  | "group"
  | "turn"
  | "peer"
  | "tasknote"
  | "cronfire"
  | "toolprogress"
  | "notice";

/** How one category's rows are drawn: in full, with no trace, or as one clickable line. */
export type QuietMode = "show" | "hide" | "fold";

/** One mode per category; a stored partial map fills from `DEFAULT_MODES` when read. */
export type QuietModes = Record<QuietCategory, QuietMode>;

/**
 * Version 2: one mode per category. `timestamps` is optional, so a prefs written before
 * `/wip-quiet time` existed still loads (absent reads as on).
 *
 * A version 1 prefs (`hidden` + `showHidden`, no `version`) is migrated when it is read; see
 * `modesFromPrefs` in `hooks/register.tsx`.
 */
export type QuietPrefs = {
  version: 2;
  enabled: boolean;
  modes: QuietModes;
  timestamps?: boolean;
};

declare module "claude-code" {
  interface PluginState {
    "wip-quiet": {
      enabled: boolean;
      /** One mode per category, tagged `modes-1`: a value under another tag reads as absent. */
      modes: Shaped<QuietModes>;
      counts: Partial<Record<QuietCategory, number>>;
      /** Errors folded or hidden since the last `/wip-quiet ack`; never reset by a mode command. */
      errors: number;
      /** Fold keys (`quiet-fold:<Component>:<id>`) the person unfolded; session-only, never stored. */
      unfolded: string[];
      /** Message rows draw their send time (`HH:MM YYYY-MM-DD`, Europe/Madrid), dimmed. */
      timestamps: boolean;
    };
  }
}
