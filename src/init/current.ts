import { join } from "node:path";
import { listAgents } from "../agents.ts";
import { readStart } from "../config.ts";

/** Agent name to the `model:` it has now, for wip's own agents in a definitions folder. */
export function currentModels(defsRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of listAgents(join(defsRoot, "agents"))) {
    if ((a.generic || a.coordinator) && a.model !== null) out[a.name] = a.model;
  }
  return out;
}

/** The saved `start`, or null when there is none or it is invalid. */
export function savedStart(project: string): string[] | null {
  try {
    return readStart(project);
  } catch {
    return null;
  }
}
