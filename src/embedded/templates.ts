import efficient from "../../templates/agents/efficient.md" with { type: "text" };
import fast from "../../templates/agents/fast.md" with { type: "text" };
import thinker from "../../templates/agents/thinker.md" with { type: "text" };
import wipCoordinator from "../../templates/agents/wip.md" with { type: "text" };
import wise from "../../templates/agents/wise.md" with { type: "text" };
import skillCoordinate from "../../templates/skills/wip-coordinate/SKILL.md" with { type: "text" };
import flowTasksGuide from "../../templates/skills/wip-flow-tasks/guide.md" with { type: "text" };
import flowTasks from "../../templates/skills/wip-flow-tasks/SKILL.md" with { type: "text" };
import skillNewAgent from "../../templates/skills/wip-new-agent/SKILL.md" with { type: "text" };
import newFlowExample from "../../templates/skills/wip-new-flow/example.md" with { type: "text" };
import skillNewFlow from "../../templates/skills/wip-new-flow/SKILL.md" with { type: "text" };
import skillSubagentProtocol from "../../templates/skills/wip-subagent-protocol/SKILL.md" with {
  type: "text",
};

/** What `wip init` writes in the definitions folder, keyed by its path there (forward slashes). */
export const TEMPLATES: Readonly<Record<string, string>> = {
  "agents/efficient.md": efficient,
  "agents/fast.md": fast,
  "agents/thinker.md": thinker,
  "agents/wip.md": wipCoordinator,
  "agents/wise.md": wise,
  "skills/wip-coordinate/SKILL.md": skillCoordinate,
  "skills/wip-flow-tasks/SKILL.md": flowTasks,
  "skills/wip-flow-tasks/guide.md": flowTasksGuide,
  "skills/wip-new-agent/SKILL.md": skillNewAgent,
  "skills/wip-new-flow/SKILL.md": skillNewFlow,
  "skills/wip-new-flow/example.md": newFlowExample,
  "skills/wip-subagent-protocol/SKILL.md": skillSubagentProtocol,
};

/** The flow `wip init` writes. */
export const DEFAULT_FLOW = "tasks";

/** The generic agents, cheapest first: the order the coordinator escalates in. */
export const GENERIC_AGENTS = ["fast", "efficient", "thinker", "wise"] as const;

/** The coordinator's agent: `claude --agent wip`. Its `wip: coordinator` mark, not this name, makes it wip's. */
export const COORDINATOR_AGENT = "wip";

/** Names `wip-new-agent` never gives to a project agent. */
export const RESERVED_AGENTS = [COORDINATOR_AGENT, ...GENERIC_AGENTS] as const;
