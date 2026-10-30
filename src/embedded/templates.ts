import efficient from "../../templates/agents/efficient.md" with { type: "text" };
import fast from "../../templates/agents/fast.md" with { type: "text" };
import thinker from "../../templates/agents/thinker.md" with { type: "text" };
import wipCoordinator from "../../templates/agents/wip-coordinator.md" with { type: "text" };
import wise from "../../templates/agents/wise.md" with { type: "text" };
import flowWip from "../../templates/flows/wip.md" with { type: "text" };
import rulesSubagents from "../../templates/rules/subagents.md" with { type: "text" };
import skillCoordinate from "../../templates/skills/wip-coordinate/SKILL.md" with { type: "text" };
import skillNewAgent from "../../templates/skills/wip-new-agent/SKILL.md" with { type: "text" };
import skillNewFlow from "../../templates/skills/wip-new-flow/SKILL.md" with { type: "text" };

/** What `wip init` writes under `.agents/`, keyed by its path there (forward slashes). */
export const TEMPLATES: Readonly<Record<string, string>> = {
  "agents/efficient.md": efficient,
  "agents/fast.md": fast,
  "agents/thinker.md": thinker,
  "agents/wip-coordinator.md": wipCoordinator,
  "agents/wise.md": wise,
  "flows/wip.md": flowWip,
  "rules/subagents.md": rulesSubagents,
  "skills/wip-coordinate/SKILL.md": skillCoordinate,
  "skills/wip-new-agent/SKILL.md": skillNewAgent,
  "skills/wip-new-flow/SKILL.md": skillNewFlow,
};

/** The generic agents, cheapest first: the order the coordinator escalates in. */
export const GENERIC_AGENTS = ["fast", "efficient", "thinker", "wise"] as const;

/** Names `wip-new-agent` never gives to a project agent. */
export const RESERVED_AGENTS = ["wip-coordinator", ...GENERIC_AGENTS] as const;
