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

/**
 * `showHidden` and `timestamps` are optional: prefs stored before `/wip-quiet show hidden` or
 * `/wip-quiet time` existed still load (`timestamps` absent reads as on).
 */
export type QuietPrefs = {
  enabled: boolean;
  hidden: QuietCategory[];
  showHidden?: boolean;
  timestamps?: boolean;
};

declare module "claude-code" {
  interface PluginState {
    "wip-quiet": {
      enabled: boolean;
      hidden: QuietCategory[];
      counts: Partial<Record<QuietCategory, number>>;
      /** Errors hidden since the last `/wip-quiet ack`; never reset by `/wip-quiet show`. */
      errors: number;
      /** Hidden tool rows draw a folded, clickable line instead of nothing. */
      showHidden: boolean;
      /** tool_use_ids the person unfolded; session-only, never stored. */
      unfolded: string[];
      /** Message rows draw their send time (`HH:MM YYYY-MM-DD`, Europe/Madrid), dimmed. */
      timestamps: boolean;
    };
  }
}
