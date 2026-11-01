import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter, readAgent } from "../../src/agents.ts";
import { COMMANDS } from "../../src/commands/help.ts";
import {
  COORDINATOR_AGENT,
  DEFAULT_FLOW,
  GENERIC_AGENTS,
  RESERVED_AGENTS,
  TEMPLATES,
} from "../../src/embedded/templates.ts";
import { EXIT } from "../../src/errors.ts";
import { lintFlow } from "../../src/flow/lint.ts";
import { extractBlocks, extractSections, parseFlow } from "../../src/flow/parse.ts";
import { type IProject, makeProject } from "../helpers/project.ts";

const CAPABILITIES = ["read", "write", "shell", "spawn", "ask-user"];
const RUNTIME_SECTION = "## Runtime interface";
const PROTOCOL_SKILL = "wip-subagent-protocol";

let p: IProject | null = null;

afterEach(() => {
  p?.cleanup();
  p = null;
});

function template(key: string): string {
  const text = TEMPLATES[key];
  if (text === undefined) throw new Error(`no template ${key}`);
  return text;
}

function entries(prefix: string): [string, string][] {
  return Object.entries(TEMPLATES).filter(([key]) => key.startsWith(prefix));
}

function frontmatter(key: string): Record<string, unknown> {
  const fm = parseFrontmatter(template(key));
  if (fm === null) throw new Error(`${key} has no frontmatter`);
  return fm;
}

/** A project whose `.agents/` holds every template, as `wip init` will write it. */
function initProject(): IProject {
  p = makeProject("templates");
  for (const [key, text] of Object.entries(TEMPLATES)) {
    const file = join(p.dir, ".agents", key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return p;
}

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Every template's text, with the runtime interface section of wip-coordinate left out. */
function outsideRuntimeSection(): [string, string][] {
  return Object.entries(TEMPLATES).map(([key, text]) => {
    if (key !== "skills/wip-coordinate/SKILL.md") return [key, text];
    return [key, text.replace(section(text, RUNTIME_SECTION), "")];
  });
}

describe("agent templates (F-AGE-01, F-AGE-02, F-AGE-14)", () => {
  test("every agent has a valid frontmatter: name equal to its file, description, role and capabilities", () => {
    const agents = entries("agents/");
    expect(agents.map(([key]) => key).sort()).toEqual(
      ["efficient", "fast", "thinker", "wip", "wise"].map((n) => `agents/${n}.md`),
    );
    for (const [key] of agents) {
      const fm = frontmatter(key);
      expect(fm.name).toBe(key.slice("agents/".length, -".md".length));
      expect(typeof fm.description).toBe("string");
      expect(String(fm.description).length).toBeGreaterThan(40);
      expect(["coordinator", "subagent"]).toContain(fm.role as string);
      expect(Array.isArray(fm.capabilities)).toBe(true);
      for (const cap of fm.capabilities as unknown[]) expect(CAPABILITIES).toContain(cap as string);
    }
  });

  test("the coordinator is `wip`: every capability, wip: coordinator, an initialPrompt and no model", () => {
    const fm = frontmatter("agents/wip.md");
    expect(fm.name).toBe(COORDINATOR_AGENT);
    expect(fm.role).toBe("coordinator");
    expect(fm.capabilities).toEqual(CAPABILITIES);
    expect(fm).not.toHaveProperty("model");
    expect(fm.wip).toBe("coordinator");
    expect(String(fm.initialPrompt)).toContain("run the start of every session");
  });

  test("the coordinator definition is short and points to the wip-coordinate skill", () => {
    const text = template("agents/wip.md");
    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(90);
    expect(text).toContain("wip-coordinate");
    expect(text).toContain("wip session start");
    expect(text).toContain("wip state --attention");
    expect(text).toContain("wip check");
    expect(text).toContain("models_unset");
    expect(text).toContain("Never relaunch on your own");
  });

  test("the start protocol runs on the first message, whatever it says, and a request waits for it", () => {
    const start = section(template("agents/wip.md"), "## Start of every session");
    expect(start).toContain("sends this file's `initialPrompt` as the first message");
    expect(start).toContain("opens no\nturn until the user writes");
    expect(start).toContain("The first message of the session, whatever it says");
    expect(start).toContain("If the first message carried a request, handle it after that message");
    const skill = template("skills/wip-coordinate/SKILL.md");
    expect(skill).toContain("the first message of the session, whatever it says");
    expect(skill).toContain("`<defs>/agents/wip.md` as your role");
    const runtime = section(skill, RUNTIME_SECTION);
    expect(runtime).toContain("`claude --agent wip` after");
    expect(runtime).toContain("`initialPrompt` is the session's first message");
    expect(runtime).not.toContain('"start"');
  });

  test("the start brings up the kanban through fast without waiting; later checks only warn", () => {
    const coordinator = template("agents/wip.md");
    const start = section(coordinator, "## Start of every session");
    for (const clause of [
      "Delegate to `fast`, in the background if the runtime can, this task: run `wip web status`. Exit 0",
      "start nothing and return its first `Local:` URL and port",
      "Exit 1: start\n   `wip web --open`, detached so it outlives the agent",
      "`nohup wip web --open >/dev/null 2>&1 &`",
      "it takes the first free port from 33333, records itself in `.wip/web/`",
      "until it exits 0, for 30 s at most",
      "The answer is one line: `<URL> · port <N>`",
      "run `wip web log -n 20` and return its error",
      "Without\n   subagents, do it yourself",
      "do not wait for it: give its line when it arrives, a 🟨 only for its error",
    ]) {
      expect({ clause, found: start.includes(clause) }).toEqual({ clause, found: true });
    }
    for (const gone of ["39100", "39109", "--port <N>", "for each port", ".wip/web.pid"]) {
      expect({ gone, found: coordinator.includes(gone) }).toEqual({ gone, found: false });
    }
    expect(start).not.toContain("return that line");
    const kanban = section(coordinator, "## The kanban");
    expect(kanban).toContain("run `wip web status` and `wip web log -n 50`");
    expect(kanban).toContain("a\n🟨 with the line");
    expect(kanban).toContain("Never start it again, nor `wip web stop`, unless the user asks");
  });

  test("the coordinator knows wip web's features, the artifact page and how to build a link", () => {
    const kanban = section(template("agents/wip.md"), "## The kanban");
    for (const clause of [
      "«Your turn», open gates, the history (`?view=history`)",
      "panel of an item (`?item=<flow>/<ID>`) with its runs, gates and artifacts",
      "`view/item/<flow>/<ID>/artifact/<name>`",
      "**Links:** run `wip web status`; on exit 0 append these to its first `Local:`",
      "URL (the `LAN:` one only if the user asks), never another host or port",
      "otherwise give the artifact's file path",
    ]) {
      expect({ clause, found: kanban.includes(clause) }).toEqual({ clause, found: true });
    }
  });

  test("the four generic agents carry wip: generic, read/write/shell and no model", () => {
    for (const name of GENERIC_AGENTS) {
      const fm = frontmatter(`agents/${name}.md`);
      expect(fm.wip).toBe("generic");
      expect(fm.role).toBe("subagent");
      expect(fm.capabilities).toEqual(["read", "write", "shell"]);
      expect(fm).not.toHaveProperty("model");
    }
  });

  test("the CLI reads them as generics without model: the onboarding lists all four", () => {
    const project = initProject();
    for (const name of GENERIC_AGENTS) {
      const def = readAgent(join(project.dir, ".agents", "agents", `${name}.md`));
      expect(def.problems).toEqual([]);
      expect(def.generic).toBe(true);
      expect(def.model).toBeNull();
    }
    const coordinator = readAgent(join(project.dir, ".agents", "agents", "wip.md"));
    expect(coordinator.problems).toEqual([]);
    expect(coordinator.generic).toBe(false);
    expect(coordinator.coordinator).toBe(true);
    expect(coordinator.model).toBeNull();
  });

  test("the generics share one body; only their name and the Level paragraph differ", () => {
    const common = GENERIC_AGENTS.map((name) => {
      const text = template(`agents/${name}.md`);
      const body = text.slice(text.indexOf("\n---\n", 4) + 5);
      return body.replace(section(body, "## Level"), "").replace(`**${name}**`, "**<name>**");
    });
    for (const body of common) expect(body).toBe(common[0] as string);
  });

  test("each Level paragraph says its own level", () => {
    const level = (name: string) => section(template(`agents/${name}.md`), "## Level");
    expect(level("fast")).toContain("exactly what the prompt asks");
    expect(level("fast")).toContain("needs-input");
    expect(level("efficient")).toContain("from start to finish");
    expect(level("thinker")).toContain("compare them");
    expect(level("wise")).toContain("safest path");
  });

  test("every agent body asks for the output contract, respects Writes: and preloads the protocol", () => {
    for (const name of GENERIC_AGENTS) {
      const text = template(`agents/${name}.md`);
      for (const token of ["STATUS:", "ARTIFACTS:", "SUMMARY:", "QUESTIONS:", "`Writes:`"]) {
        expect(text).toContain(token);
      }
      expect(text).toContain("`skills/wip-subagent-protocol/SKILL.md` in the definitions folder");
      expect(text).toContain("the prompt's `Protocol:` gives its full\n   path");
      expect(frontmatter(`agents/${name}.md`).skills).toEqual([PROTOCOL_SKILL]);
      expect(text).not.toContain(".agents/");
    }
    expect(frontmatter("agents/wip.md")).not.toHaveProperty("skills");
  });
});

describe("skills (F-AGE-15, F-AGE-16, F-AGE-20, F-SKL-01, F-NEW-05)", () => {
  test("every skill has a name equal to its folder, a description and a wip: mark; no rules/ or flows/", () => {
    const skills = entries("skills/").filter(([key]) => key.endsWith("/SKILL.md"));
    expect(skills.map(([key]) => key).sort()).toEqual([
      "skills/wip-coordinate/SKILL.md",
      "skills/wip-flow-tasks/SKILL.md",
      "skills/wip-new-agent/SKILL.md",
      "skills/wip-new-flow/SKILL.md",
      "skills/wip-subagent-protocol/SKILL.md",
    ]);
    for (const [key] of skills) {
      const fm = frontmatter(key);
      expect(fm.name).toBe(key.split("/")[1]);
      expect(String(fm.description).length).toBeGreaterThan(40);
      expect(typeof fm.wip).toBe("string");
    }
    expect(Object.keys(TEMPLATES).filter((k) => /^(rules|flows)\//.test(k))).toEqual([]);
    for (const [key, text] of Object.entries(TEMPLATES)) {
      expect({ key, rules: /\brules\//.test(text) }).toEqual({ key, rules: false });
    }
  });

  test("the protocol is a skill for subagents only, and the coordinator passes its path", () => {
    const fm = frontmatter(`skills/${PROTOCOL_SKILL}/SKILL.md`);
    expect(String(fm.description)).toContain("Only for subagents");
    expect(String(fm.description)).toContain("The coordinator never applies it to itself");
    const skill = template("skills/wip-coordinate/SKILL.md");
    expect(skill).toContain(
      "Protocol: <absolute path of <defs>/skills/wip-subagent-protocol/SKILL.md> — read it first.",
    );
    expect(template("agents/wip.md")).toContain("never apply it to yourself");
    const newAgent = template("skills/wip-new-agent/SKILL.md");
    expect(newAgent).toContain("skills:\n  - wip-subagent-protocol");
    expect(newAgent).toContain("It always carries the subagent protocol");
  });

  test("wip-subagent-protocol holds the shared contract", () => {
    const rules = template(`skills/${PROTOCOL_SKILL}/SKILL.md`);
    for (const clause of [
      "STATUS: needs-input",
      "| `artifacts` (also when the line is missing) | files inside `ARTIFACT_DIR` only |",
      "| `project` |",
      "Only the coordinator changes the state of an item",
      "`APPROVED`",
      "Never read the value of a secret",
      "[REDACTED]",
      "Nothing irreversible or visible to others without a gate",
      "STATUS: done | blocked | needs-input",
    ]) {
      expect(rules).toContain(clause);
    }
    expect(rules).not.toContain("TIMING");
  });

  test("wip-coordinate carries the cycle, the launch prompt, the choice of agent and the gates", () => {
    const skill = template("skills/wip-coordinate/SKILL.md");
    for (const clause of [
      "**P1 · Next phase.**",
      "**P7 · Close.**",
      "Writes: <the phase's writes: artifacts | project>",
      "## Choosing the agent",
      "**Escalation.**",
      "Above `wise`, open a gate.",
      "**One gate = one item and one topic.**",
      "**Approval is only an explicit answer of the user in a new turn**",
      "is it irreversible, or will someone else see",
      "1. Approve",
      "2. Change (say what)",
      "3. Stop this item",
      "🟧 <ID> · <phase> → <next phase or action>",
      "🟪 NEXT ·",
      RUNTIME_SECTION,
      "**Without subagents**",
      "Edit each definition in the language it is already written in.",
    ]) {
      expect(skill).toContain(clause);
    }
    for (const icon of ["🟦", "🟩", "🟨", "🟧", "🟥"]) expect(skill).toContain(icon);
  });

  test("wip-coordinate carries the polling protocol, and the coordinator points to it", () => {
    const skill = template("skills/wip-coordinate/SKILL.md");
    const polling = section(skill, "## Polling");
    expect(polling).toContain("`wip poll due --json`");
    expect(polling).toContain("`wip poll record <flow> <poll>");
    expect(polling).toContain("`wip poll seen <flow> <poll> <key>`");
    expect(polling).toContain("`last_seen`");
    expect(polling).toContain("no `wip agent start`");
    // the Polling section never starts a run for a pass
    expect(polling).not.toMatch(/`wip agent start <ID>/);
    expect(section(skill, RUNTIME_SECTION)).toContain(
      "| 6 | `schedule(prompt, period)` (optional)",
    );
    const wip = template("agents/wip.md");
    expect(wip).toContain("`wip poll due --json`");
    expect(wip).toContain("«Polling» in `wip-coordinate`");
    expect(wip.trimEnd().split("\n").length).toBeLessThanOrEqual(90);
  });

  test("the escalation order is the generics' order, cheapest first", () => {
    const skill = template("skills/wip-coordinate/SKILL.md");
    expect(skill).toContain("`fast` →\n   `efficient` → `thinker` → `wise`");
    expect(GENERIC_AGENTS).toEqual(["fast", "efficient", "thinker", "wise"]);
  });

  test("wip-coordinate carries the model onboarding: when, question, backup, one-line diff, validation (F-NEW-07)", () => {
    const onboarding = section(template("skills/wip-coordinate/SKILL.md"), "## Model onboarding");
    for (const clause of [
      "`models_unset`",
      "before launching any subagent",
      "`inherit`",
      "«Later»",
      "`agent=model`",
      "`.wip/backups/defs/agents/<name>.md.<timestamp>`",
      "right after\n   `description:`",
      "exactly that line",
      "`wip flow lint` exits 0",
      "restore the backup",
      "without subagents, recommend `inherit` for the four",
    ]) {
      expect({ clause, found: onboarding.includes(clause) }).toEqual({ clause, found: true });
    }
    const runtime = section(template("skills/wip-coordinate/SKILL.md"), RUNTIME_SECTION);
    expect(runtime).toContain("reads `model:`");
    expect(runtime).toContain("`/agents`");
  });

  test("the onboarding asks the coordinator's model too and says it applies on restart", () => {
    const skill = template("skills/wip-coordinate/SKILL.md");
    const onboarding = section(skill, "## Model onboarding");
    for (const clause of [
      "the coordinator (`wip: coordinator`)",
      "the coordinator included",
      "for the coordinator, it is the",
      "The coordinator's model applies when the session restarts",
      "to restart the session to apply it",
    ]) {
      expect({ clause, found: onboarding.includes(clause) }).toEqual({ clause, found: true });
    }
    const runtime = section(skill, RUNTIME_SECTION);
    expect(runtime).toContain(
      "`claude --agent wip` reads the coordinator's `model:` when it starts",
    );
    expect(runtime).toContain(
      "with `inherit`, the coordinator runs on the model `claude` is started with",
    );
  });

  test("wip-new-agent reserves wip's names and never marks a project agent as generic", () => {
    const skill = template("skills/wip-new-agent/SKILL.md");
    for (const name of RESERVED_AGENTS) expect(skill).toContain(`\`${name}\``);
    const example = skill.slice(skill.indexOf("```markdown"), skill.indexOf("\n```\n"));
    expect(example).not.toContain("wip: generic");
    expect(example).toContain("model:");
    expect(skill).toContain("always; this skill never skips the gate");
  });

  test("wip-new-flow backs up, lints and restores", () => {
    const skill = template("skills/wip-new-flow/SKILL.md");
    for (const clause of [
      ".wip/backups/defs/skills/wip-flow-<flow>/SKILL.md.<timestamp>",
      "`<defs>/skills/wip-flow-<flow>/SKILL.md`",
      "wip flow lint <flow>",
      "restore the backup",
      "wip state --flow <flow>",
      "--force --reason",
      "start from a copy of `example.md`",
      "`<defs>/skills/wip-flow-tasks/SKILL.md`",
      "It is a reference, not a flow",
    ]) {
      expect(skill).toContain(clause);
    }
  });

  test("the example block in wip-new-flow passes lint with the generic agents", () => {
    const project = initProject();
    const [block] = extractBlocks(template("skills/wip-new-flow/SKILL.md"));
    const result = lintFlow({
      name: "example",
      text: `\`\`\`wip-flow\n${block}\`\`\`\n`,
      agentsDir: join(project.dir, ".agents", "agents"),
      liveItems: [],
    });
    expect(result.problems).toEqual([]);
  });

  test("example.md is a whole flow skill that passes lint, and init never makes it a flow", () => {
    const project = initProject();
    const result = lintFlow({
      name: "review",
      text: template("skills/wip-new-flow/example.md"),
      agentsDir: join(project.dir, ".agents", "agents"),
      skill: true,
      liveItems: [],
    });
    expect(result.problems).toEqual([]);
    expect(frontmatter("skills/wip-new-flow/example.md").name).toBe("wip-flow-review");
    expect(project.wip(["flow", "lint"]).stdout).toBe(`OK ${DEFAULT_FLOW}\n`);
  });
});

describe("the tasks flow template (F-NEW-03, F-FLC-03, F-FLU-15)", () => {
  const FLOW_KEY = `skills/wip-flow-${DEFAULT_FLOW}/SKILL.md`;

  test("wip flow lint passes on what init writes", () => {
    const project = initProject();
    const out = project.wip(["flow", "lint"]);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(EXIT.OK);
    expect(out.stdout).toContain("OK tasks");
    expect(template(FLOW_KEY)).toContain("`wip phase <ID> intake --flow tasks`");
    expect(String(frontmatter(FLOW_KEY).description)).toContain("for the coordinator");
  });

  test("three stages of generic phases, each with its gate, agent, writes and next", () => {
    const { flow, problems } = parseFlow(DEFAULT_FLOW, template(FLOW_KEY));
    expect(problems).toEqual([]);
    if (!flow) throw new Error("no flow");
    const shape = flow.phases.map((ph) => [
      ph.stage,
      ph.name,
      ph.gate,
      ph.agent ?? null,
      ph.writes,
      ph.next,
      ph.fromAny,
    ]);
    expect(shape).toEqual([
      ["preparation", "intake", "none", null, "artifacts", ["research", "done"], false],
      ["preparation", "research", "auto", "thinker", "artifacts", ["plan"], false],
      ["preparation", "plan", "ask", "thinker", "artifacts", ["execute"], true],
      ["execution", "execute", "auto", "efficient", "project", ["check"], false],
      ["execution", "check", "auto", "efficient", "artifacts", ["execute", "review"], false],
      ["review", "review", "ask", null, "artifacts", ["execute", "deliver", "done"], false],
      ["review", "deliver", "ask", "efficient", "artifacts", ["done"], false],
      ["review", "done", "none", null, "artifacts", [], false],
    ]);
    expect(flow.phases.map((ph) => ph.waitingDefault)).toEqual([
      "user",
      "agent",
      "agent",
      "agent",
      "agent",
      "user",
      "agent",
      "none",
    ]);
    expect(flow.phases.at(-1)?.kind).toBe("terminal");
    expect(Object.keys(flow.fields)).toEqual(["title"]);
    expect(flow.seed).toEqual([
      {
        id: "onboarding",
        phase: "intake",
        title: "Get to know wip",
        next: "tell the coordinator when you want to start the onboarding",
        files: ["guide.md"],
      },
    ]);
  });

  test("the coordinator mentions onboarding in one NEXT line, then guides it to a gate, done and archive", () => {
    expect(template("agents/wip.md")).toContain(
      "while\n`onboarding` is open, follow «Onboarding» in `wip-coordinate`",
    );
    const own = section(template("skills/wip-coordinate/SKILL.md"), "## Onboarding");
    const steps = [
      "with the artifact\n`guide.md`",
      "with no subagent",
      "the first suggestion of its `🟪 NEXT · …` line\n   is «You have an onboarding task (`onboarding`): tell me when you want to start». No other text about it.",
      "**Step 1 · the guide.**",
      "«The kanban» in\n   `<defs>/agents/wip.md`",
      '`wip wait onboarding user --next "read the guide and find this task on the kanban"`',
      "**Step 2 · questions.**",
      "from `guide.md` and `<defs>/`, never from memory",
      '`wip wait onboarding user --next "close the onboarding at its gate"`',
      "**Step 3 · the gate.**",
      '`wip gate open onboarding intake --question "Close the onboarding?" --detail <guide.md path>`',
      "`wip phase onboarding done`, `wip archive onboarding`",
      "«try a task: ask for your first one»",
      "**Proactive:**",
    ];
    let at = -1;
    for (const step of steps) {
      const found = own.indexOf(step);
      expect({ step, found: found > at }).toEqual({ step, found: true });
      at = found;
    }
    expect(own).not.toContain("wip agent start");
    expect(own).not.toContain("launch");
  });

  test("no template keeps the feature tour", () => {
    for (const [key, text] of Object.entries(TEMPLATES)) {
      expect({ key, tour: text.includes("INFO · onboarding ·") }).toEqual({ key, tour: false });
      expect({ key, old: text.includes("Feature onboarding") }).toEqual({ key, old: false });
    }
  });

  test("init writes the guide; it covers every stage, phase and generic agent and the artifact page", () => {
    const guide = template("skills/wip-flow-tasks/guide.md");
    expect(frontmatter("skills/wip-flow-tasks/guide.md").wip).toBe("guide");
    const h2 = [...guide.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(h2).toEqual([
      "What wip is",
      "This onboarding",
      "How to ask for things",
      "Flows and stages",
      "Agents and models",
      "Gates",
      "Messages",
      "The kanban",
      "Useful commands",
      "Your own flows and agents",
      "Sessions and restarts",
      "Where things live",
    ]);
    const { flow } = parseFlow(DEFAULT_FLOW, template(FLOW_KEY));
    if (!flow) throw new Error("no flow");
    const names = [
      ...flow.phases.map((ph) => `\`${ph.name}\``),
      ...new Set(flow.phases.map((ph) => `**${ph.stage}**`)),
      ...GENERIC_AGENTS.map((a) => `\`${a}\``),
      "`/view/item/<flow>/<ID>/artifact/<name>`",
      "`?item=<flow>/<ID>`",
      "`?view=history`",
      "«Close the onboarding?»",
    ];
    for (const name of names) {
      expect({ name, found: guide.includes(name) }).toEqual({ name, found: true });
    }
  });

  test("its stages pass the lint; a stage split in two does not", () => {
    const project = initProject();
    const agentsDir = join(project.dir, ".agents", "agents");
    const lint = (text: string): string[] =>
      lintFlow({ name: DEFAULT_FLOW, text, agentsDir, skill: true, liveItems: [] }).problems;
    expect(lint(template(FLOW_KEY))).toEqual([]);
    const split = template(FLOW_KEY).replace(
      "  - name: check\n    stage: execution",
      "  - name: check\n    stage: preparation",
    );
    expect(split).not.toBe(template(FLOW_KEY));
    expect(lint(split)).toEqual([
      "stages must be contiguous in phase order: preparation → execution → preparation → review",
    ]);
  });

  test("## Subagents and a ### section for every phase are filled; there is no phase table", () => {
    const text = template(FLOW_KEY);
    const phases = ["intake", "research", "plan", "execute", "check", "review", "deliver", "done"];
    const sections = extractSections(text, phases);
    expect((sections.subagents ?? "").length).toBeGreaterThan(200);
    for (const phase of phases) {
      expect((sections.phaseNotes[phase] ?? "").length).toBeGreaterThan(80);
    }
    for (const phase of ["research", "plan", "execute", "check", "deliver"]) {
      expect(sections.subagents).toContain(`\`${phase}\` uses`);
    }
    expect(sections.phaseNotes.plan).toContain(
      "the deliverable (code, a report, a document, a decision)",
    );
    expect(sections.phaseNotes.check).toContain(
      "each question of an investigation has an answer and",
    );
    expect(text).not.toContain("verify");
    expect(text.split("\n").some((line) => line.startsWith("|"))).toBe(false);
  });
});

describe("the templates are agnostic and use the real CLI (D9, F-NEW-06)", () => {
  const FORBIDDEN_EVERYWHERE = [/\bHarbiz\b/i, /\bJira\b/i, /\btier\b/i, /\bSlack\b/i];
  const RUNTIME_ONLY = [
    /\bhaiku\b/i,
    /\bsonnet\b/i,
    /\bopus\b/i,
    /\bClaude\b/i,
    /claude-code/,
    /\.claude\b/,
    /AskUserQuestion/,
    /SendMessage/,
    /TaskStop/,
    /ToolSearch/,
    /subagent_type/,
    /run_in_background/,
  ];
  const ABSOLUTE_PATH =
    /(^|[\s`"'(])(\/(Users|home|tmp|var|private|etc|opt|root)\/|~\/|[A-Za-z]:\\)/m;

  test("no template names a company, a tracker, a model tier or an absolute path", () => {
    for (const [key, text] of Object.entries(TEMPLATES)) {
      for (const re of [...FORBIDDEN_EVERYWHERE, ABSOLUTE_PATH]) {
        expect({ key, match: text.match(re)?.[0] ?? null }).toEqual({ key, match: null });
      }
    }
  });

  test("runtime vocabulary appears only in the runtime interface section of wip-coordinate", () => {
    const skill = template("skills/wip-coordinate/SKILL.md");
    expect(section(skill, RUNTIME_SECTION)).toContain("AskUserQuestion");
    for (const [key, text] of outsideRuntimeSection()) {
      for (const re of RUNTIME_ONLY) {
        expect({ key, match: text.match(re)?.[0] ?? null }).toEqual({ key, match: null });
      }
    }
  });

  test("every wip command they quote exists, with its subcommand and options", () => {
    const quoted: string[] = [];
    for (const text of Object.values(TEMPLATES)) {
      for (const m of text.matchAll(/`(wip [^`\n]+)`/g)) quoted.push(m[1] as string);
      for (const fence of text.matchAll(/^```[a-z-]*\n([\s\S]*?)^```$/gm)) {
        for (const m of (fence[1] ?? "").matchAll(/^\s*(wip [^\n]+)$/gm))
          quoted.push(m[1] as string);
      }
    }
    expect(quoted.length).toBeGreaterThan(30);
    const problems: string[] = [];
    for (const line of quoted) {
      const tokens = line.split(/\s+/);
      const name = tokens[1] ?? "";
      if (!/^[a-z]+$/.test(name)) continue;
      const spec = COMMANDS.find((c) => c.name === name);
      if (!spec) {
        problems.push(`${line}: no command ${name}`);
        continue;
      }
      const subs = spec.usage.map((u) => u.split(/\s+/)[2] ?? "").filter((t) => /^[a-z]+$/.test(t));
      const takesNone = spec.usage.some((u) => !/^[a-z]+$/.test(u.split(/\s+/)[2] ?? ""));
      const sub = tokens[2] ?? "";
      if (subs.length > 0 && !subs.includes(sub) && !(takesNone && !/^[a-z]+$/.test(sub))) {
        problems.push(`${line}: ${name} takes ${subs.join("|")}`);
      }
      const known = new Set([...spec.options, ...spec.flags, "json", "help"]);
      for (const t of tokens) {
        const opt = t.match(/^--([a-z][a-z-]*)/)?.[1];
        if (opt && !known.has(opt)) problems.push(`${line}: ${name} has no --${opt}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
