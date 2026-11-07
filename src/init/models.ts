import { COORDINATOR_AGENT, GENERIC_AGENTS } from "../embedded/templates.ts";

/** The agents `wip init` asks a model for, in the order it asks: the generics, then the coordinator. */
export const MODEL_AGENTS: readonly string[] = [...GENERIC_AGENTS, COORDINATOR_AGENT];

const MODEL_DEFAULTS: Readonly<Record<string, string>> = {
  fast: "haiku",
  efficient: "sonnet",
  thinker: "opus",
  wise: "fable",
  [COORDINATOR_AGENT]: "inherit",
};

export const INHERIT = "inherit";
export const SKIP = "skip";

/** What the questions suggest for an agent: one model per level for Claude Code. */
export function suggestedModel(agent: string): string {
  return MODEL_DEFAULTS[agent] ?? INHERIT;
}

/** What `--yes` writes: the suggestion, or `inherit` for an agent without one. */
export function defaultModel(agent: string): string {
  return MODEL_DEFAULTS[agent] ?? INHERIT;
}

/** The `model:` line to write: quoted when the value has a colon or a space (as the coordinator's skill says). */
export function modelLineFor(value: string): string {
  return /[:\s]/.test(value) ? `model: ${JSON.stringify(value)}` : `model: ${value}`;
}

/** `fast=haiku,efficient=sonnet` as a record; throws a message on an unknown agent or an empty value. */
export function parseModels(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(",")) {
    const eq = part.indexOf("=");
    const agent = (eq < 0 ? part : part.slice(0, eq)).trim();
    const value = eq < 0 ? "" : part.slice(eq + 1).trim();
    if (!MODEL_AGENTS.includes(agent)) {
      throw new Error(
        `unknown agent '${agent}' in --models; the agents are ${MODEL_AGENTS.join(", ")}`,
      );
    }
    if (value === "" || /[\r\n]/.test(value))
      throw new Error(`--models needs a model for ${agent}`);
    if (agent in out) throw new Error(`--models names ${agent} twice`);
    out[agent] = value;
  }
  return out;
}
