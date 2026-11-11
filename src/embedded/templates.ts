import efficient from "../../templates/agents/efficient.md" with { type: "text" };
import fast from "../../templates/agents/fast.md" with { type: "text" };
import thinker from "../../templates/agents/thinker.md" with { type: "text" };
import wipCoordinator from "../../templates/agents/wip.md" with { type: "text" };
import wise from "../../templates/agents/wise.md" with { type: "text" };
import skillCoordinate from "../../templates/skills/wip-coordinate/SKILL.md" with { type: "text" };
import flowDevelopment from "../../templates/skills/wip-flow-development/SKILL.md" with {
  type: "text",
};
import flowIdeas from "../../templates/skills/wip-flow-ideas/SKILL.md" with { type: "text" };
import flowReports from "../../templates/skills/wip-flow-reports/SKILL.md" with { type: "text" };
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
  "skills/wip-flow-development/SKILL.md": flowDevelopment,
  "skills/wip-flow-ideas/SKILL.md": flowIdeas,
  "skills/wip-flow-reports/SKILL.md": flowReports,
  "skills/wip-flow-tasks/SKILL.md": flowTasks,
  "skills/wip-flow-tasks/guide.md": flowTasksGuide,
  "skills/wip-new-agent/SKILL.md": skillNewAgent,
  "skills/wip-new-flow/SKILL.md": skillNewFlow,
  "skills/wip-new-flow/example.md": newFlowExample,
  "skills/wip-subagent-protocol/SKILL.md": skillSubagentProtocol,
};

/** The flow that seeds `onboarding`. */
export const DEFAULT_FLOW = "tasks";

/** The flows `wip init` writes when nothing says otherwise, in the order it names them. */
export const DEFAULT_FLOWS: readonly string[] = ["development", "ideas", "reports", "tasks"];

/** The flow a template key belongs to (`skills/wip-flow-<name>/…`), or `null` for any other template. */
export function flowOfKey(key: string): string | null {
  return /^skills\/wip-flow-([^/]+)\//.exec(key)?.[1] ?? null;
}

/** The shipped flow names, alphabetical. */
export function flowNames(): string[] {
  const names = new Set<string>();
  for (const key of Object.keys(TEMPLATES)) {
    const flow = flowOfKey(key);
    if (flow !== null) names.add(flow);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** The templates of the selected flows: every template that is not a flow, and only those flow folders. */
export function selectTemplates(flows: readonly string[]): Readonly<Record<string, string>> {
  const wanted = new Set(flows);
  return Object.fromEntries(
    Object.entries(TEMPLATES).filter(([key]) => {
      const flow = flowOfKey(key);
      return flow === null || wanted.has(flow);
    }),
  );
}

/** The generic agents, cheapest first: the order the coordinator escalates in. */
export const GENERIC_AGENTS = ["fast", "efficient", "thinker", "wise"] as const;

/** The coordinator's agent: `claude --agent wip`. Its `wip: coordinator` mark, not this name, makes it wip's. */
export const COORDINATOR_AGENT = "wip";

/** Names `wip-new-agent` never gives to a project agent. */
export const RESERVED_AGENTS = [COORDINATOR_AGENT, ...GENERIC_AGENTS] as const;
