import type { QuietCategory } from "../types";

export const ALL_CATEGORIES: readonly QuietCategory[] = [
  "bash",
  "agent",
  "cron",
  "files",
  "msg",
  "mcp",
  "misc",
  "errors",
  "group",
  "turn",
  "peer",
  "tasknote",
  "cronfire",
  "toolprogress",
  "notice",
];

// Questions to the user stay visible whatever the settings: hiding one would hide a decision.
const ALWAYS_VISIBLE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"]);
const BASH_TOOLS = new Set(["Bash", "BashOutput", "KillShell"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);

export const isCategory = (value: string): value is QuietCategory =>
  (ALL_CATEGORIES as readonly string[]).includes(value);

export const toolCategory = (tool: string): QuietCategory | null => {
  if (ALWAYS_VISIBLE_TOOLS.has(tool)) return null;
  if (BASH_TOOLS.has(tool)) return "bash";
  if (AGENT_TOOLS.has(tool)) return "agent";
  if (tool.startsWith("Cron")) return "cron";
  if (FILE_TOOLS.has(tool)) return "files";
  if (tool === "SendMessage") return "msg";
  if (tool.startsWith("mcp__")) return "mcp";
  return "misc";
};

export const rowCategory = (row: {
  tool: string;
  isErrored: boolean;
  isInterrupted?: boolean;
}): QuietCategory | null => {
  const category = toolCategory(row.tool);
  if (category === null) return null;
  return row.isErrored || row.isInterrupted ? "errors" : category;
};

const PEER_ORIGINS = new Set([
  "peer",
  "peer-send-message",
  "coordinator",
  "projects-relay",
  "observer",
  "observer-activity",
]);

// `composer`, `bridge`, `sdk`, `channel`, `auto-continuation` and `unclassified` are the user's
// side of the conversation or unknown: they stay visible.
export const originCategory = (kind: string): QuietCategory | null => {
  if (PEER_ORIGINS.has(kind)) return "peer";
  if (kind === "task-notification") return "tasknote";
  if (kind === "scheduled-trigger") return "cronfire";
  return null;
};

export const parseCategories = (arg: string): QuietCategory[] | null => {
  const words = arg.split(/[\s,]+/).filter((word) => word.length > 0);
  if (words.length === 0) return null;
  if (words.includes("all")) return [...ALL_CATEGORIES];
  const categories = words.filter(isCategory);
  return categories.length === words.length ? categories : null;
};
