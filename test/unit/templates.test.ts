import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hasWipMark, parseFrontmatter, readAgent } from "../../src/agents.ts";
import { COMMANDS } from "../../src/commands/help.ts";
import {
  COORDINATOR_AGENT,
  DEFAULT_FLOW,
  DEFAULT_FLOWS,
  flowNames,
  flowOfKey,
  GENERIC_AGENTS,
  RESERVED_AGENTS,
  selectTemplates,
  TEMPLATES,
} from "../../src/embedded/templates.ts";
import { EXIT } from "../../src/errors.ts";
import { lintFlow } from "../../src/flow/lint.ts";
import { extractBlocks, extractSections, parseFlow } from "../../src/flow/parse.ts";
import { foreignFiles, scaffold } from "../../src/init/scaffold.ts";
import { type IProject, makeProject } from "../helpers/project.ts";

/** The 19 official subagent keys of Claude Code, in the order of its documentation. */
const OFFICIAL_KEYS = [
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "permissionMode",
  "maxTurns",
  "autoCompactWindow",
  "skills",
  "mcpServers",
  "hooks",
  "memory",
  "background",
  "omitClaudeMd",
  "effort",
  "isolation",
  "color",
  "initialPrompt",
  "experimental",
];
/** The model line of each generic, and the tone of its row in the panes. */
const GENERIC_MODELS: Record<string, string> = {
  efficient: "sonnet",
  fast: "haiku",
  thinker: "opus",
  wise: "fable",
};
const GENERIC_COLORS: Record<string, string> = {
  efficient: "blue",
  fast: "blue",
  thinker: "yellow",
  wise: "red",
};
const RUNTIME_SECTION = "## Runtime interface";
const PROTOCOL_SKILL = "wip-subagent-protocol";
/** What `flow lint` prints after init with every shipped flow, in the registry's alphabetical order. */
const LINT_ALL = `${DEFAULT_FLOWS.map((name) => `OK ${name}`).join("\n")}\n`;
/** The coordinator's body stays short: the v2 onboarding line takes it from 90 to at most 95. */
const MAX_BODY_LINES = 95;

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

/** A project whose `.claude/` holds every template, as `wip init` will write it. */
function initProject(): IProject {
  p = makeProject("templates");
  for (const [key, text] of Object.entries(TEMPLATES)) {
    const file = join(p.dir, ".claude", key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return p;
}

/** The text after the frontmatter. */
function bodyOf(text: string): string {
  return text.slice(text.indexOf("\n---\n", 4) + 5);
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
    // An agent's frontmatter names the tools it may not use; its body is what talks to the runtime.
    const body = key.startsWith("agents/") ? text.replace(/^---\n[\s\S]*?\n---\n/, "") : text;
    if (key !== "skills/wip-coordinate/SKILL.md") return [key, body];
    return [key, body.replace(section(body, RUNTIME_SECTION), "")];
  });
}

describe("agent templates (F-AGE-01, F-AGE-02, F-AGE-14)", () => {
  test("every agent has a valid frontmatter: name equal to its file and a description", () => {
    const agents = entries("agents/");
    expect(agents.map(([key]) => key).sort()).toEqual(
      ["efficient", "fast", "thinker", "wip", "wise"].map((n) => `agents/${n}.md`),
    );
    for (const [key] of agents) {
      const fm = frontmatter(key);
      expect(fm.name).toBe(key.slice("agents/".length, -".md".length));
      expect(typeof fm.description).toBe("string");
      expect(String(fm.description).length).toBeGreaterThan(40);
      expect(fm).not.toHaveProperty("role");
      expect(fm).not.toHaveProperty("capabilities");
    }
  });

  test("the coordinator is `wip`: no tools line, writing tools denied, wip: coordinator, an initialPrompt and inherit", () => {
    const fm = frontmatter("agents/wip.md");
    expect(fm.name).toBe(COORDINATOR_AGENT);
    expect(fm.tools).toBeUndefined();
    expect(fm.disallowedTools).toBe("Write, Edit, NotebookEdit");
    expect(fm.model).toBe("inherit");
    expect(fm.wip).toBe("coordinator");
    expect(String(fm.initialPrompt)).toContain("run the start of every session");
  });

  test("the coordinator runs only wip by Bash, writes no file, and no template allows running without subagents", () => {
    const body = bodyOf(template("agents/wip.md"));
    expect(body).toContain('By Bash you run only `"$WIP_BIN" …` commands');
    expect(body).toContain("goes to a `fast` subagent");
    expect(body).not.toContain("Without subagents");
    expect(body).not.toContain("do it yourself");
    for (const [key, text] of Object.entries(TEMPLATES)) {
      expect({ key, found: /without subagents/i.test(text) }).toEqual({ key, found: false });
    }
  });

  test("the coordinator definition is short and points to the wip-coordinate skill", () => {
    const text = template("agents/wip.md");
    expect(bodyOf(text).trimEnd().split("\n").length).toBeLessThanOrEqual(MAX_BODY_LINES);
    expect(text).toContain("wip-coordinate");
    expect(text).toContain('"$WIP_BIN" session start');
    expect(text).toContain('"$WIP_BIN" state --attention');
    expect(text).toContain('"$WIP_BIN" check');
    expect(text).toContain("models_unset");
    expect(text).toContain("Never relaunch on your own");
  });

  test("the start protocol runs on the first message, whatever it says, and a request waits for it", () => {
    const start = section(template("agents/wip.md"), "## Start of every session");
    expect(start).toContain("sends this file's `initialPrompt` as the first message");
    expect(start).toContain("The first message\nof the session, whatever it says");
    expect(start).toContain("If the first message carried a request, handle it after that message");
    const skill = template("skills/wip-coordinate/SKILL.md");
    expect(skill).toContain("the first message of the session, whatever it says");
    expect(skill).toContain("`<defs>/agents/wip.md` as your role");
    const runtime = section(skill, RUNTIME_SECTION);
    expect(runtime).toContain("`wip start` (or bare `wip`) in the project, after");
    expect(runtime).toContain("`initialPrompt` is the session's first message");
    expect(runtime).not.toContain('"start"');
  });

  test("the start brings up the kanban through fast without waiting; later checks only warn", () => {
    const coordinator = template("agents/wip.md");
    const start = section(coordinator, "## Start of every session");
    for (const clause of [
      'Delegate to `fast`, in the background, this task: run `"$WIP_BIN" web status`. Exit 0',
      "start nothing and return its first `Local:` URL and port",
      'Exit 1: start\n   `"$WIP_BIN" web --open`, detached so it outlives the agent',
      '`nohup "$WIP_BIN" web --open >/dev/null 2>&1 &`',
      "it takes the first free port from 33333, records itself in `.wip/web/`",
      "until it exits 0, for 30 s at most",
      "The answer is one line: `<URL> · port <N>`",
      'run `"$WIP_BIN" web log -n 20` and return its error',
      "do not wait for it: give its line when it arrives, a 🟨 only for its error",
    ]) {
      expect({ clause, found: start.includes(clause) }).toEqual({ clause, found: true });
    }
    for (const gone of ["39100", "39109", "--port <N>", "for each port", ".wip/web.pid"]) {
      expect({ gone, found: coordinator.includes(gone) }).toEqual({ gone, found: false });
    }
    expect(start).not.toContain("return that line");
    const kanban = section(coordinator, "## The kanban");
    expect(kanban).toContain("The watcher of step 4");
    expect(start).toContain("**4b, watcher.**");
    expect(start).toContain("once for the PID and the URL, then waits on that PID");
    expect(start).toContain("kanban down · restart it by hand");
    expect(kanban).toContain(
      'Never start it again, nor `"$WIP_BIN" web stop`, unless the user asks',
    );
  });

  test("the coordinator knows wip web's features, the artifact page and how to build a link", () => {
    const kanban = section(template("agents/wip.md"), "## The kanban");
    for (const clause of [
      "«Your turn», open gates, the history (`?view=history`)",
      "panel of an item (`?item=<flow>/<ID>`) with its runs, gates and artifacts",
      "`view/item/<flow>/<ID>/artifact/<name>`",
      '**Links:** run `"$WIP_BIN" web status`; on exit 0 append these to its first `Local:`',
      "URL (the `LAN:` one only if the user asks), never another host or port",
      "otherwise give the artifact's file path",
    ]) {
      expect({ clause, found: kanban.includes(clause) }).toEqual({ clause, found: true });
    }
  });

  test("the four generic agents carry wip: generic, spawn and questions denied, a model per level and the protocol", () => {
    for (const name of GENERIC_AGENTS) {
      const fm = frontmatter(`agents/${name}.md`);
      expect(fm.wip).toBe("generic");
      expect(fm.tools).toBeUndefined();
      expect(fm.disallowedTools).toBe("Agent, AskUserQuestion, NotebookEdit");
      expect(fm.model).toBe(GENERIC_MODELS[name] as string);
      expect(fm.effort).toBe("medium");
      expect(fm.color).toBe(GENERIC_COLORS[name] as string);
      expect(fm.skills).toEqual([PROTOCOL_SKILL]);
    }
  });

  test("no agent template writes a key without a value; the valued ones are present", () => {
    for (const [key, text] of entries("agents/")) {
      const block = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
      const lines = block.split("\n");
      lines.forEach((line, i) => {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m === null) return;
        const value = m[2] ?? "";
        const hasList = (lines[i + 1] ?? "").startsWith("  - ");
        expect({ key, name: m[1], empty: value === "" && !hasList }).toEqual({
          key,
          name: m[1],
          empty: false,
        });
        expect({ key, name: m[1], value }).not.toEqual({ key, name: m[1], value: "[]" });
        expect({ key, name: m[1], value }).not.toEqual({ key, name: m[1], value: "{}" });
      });
      const fm = frontmatter(key);
      for (const name of Object.keys(fm)) {
        expect([...OFFICIAL_KEYS, "wip"]).toContain(name);
      }
      expect(fm.name).toBe(key.replace(/^agents\/|\.md$/g, ""));
      expect(typeof fm.description).toBe("string");
      expect(["generic", "coordinator"]).toContain(fm.wip as string);
    }
    for (const name of GENERIC_AGENTS) {
      const fm = frontmatter(`agents/${name}.md`);
      expect(fm.model).toBe(GENERIC_MODELS[name] as string);
      expect(fm.disallowedTools).toBe("Agent, AskUserQuestion, NotebookEdit");
      expect(fm.skills).toEqual([PROTOCOL_SKILL]);
    }
    const coordinator = frontmatter("agents/wip.md");
    expect(coordinator.omitClaudeMd).toBe(true);
    expect(typeof coordinator.initialPrompt).toBe("string");
  });

  test("the wip-new-agent skill documents the 19 keys and its example writes only valued keys", () => {
    const skill = template("skills/wip-new-agent/SKILL.md");
    const rows = [...skill.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1] ?? "");
    expect(rows).toEqual(OFFICIAL_KEYS);
    const block = skill.match(/```markdown\n---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
    for (const line of block.split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m !== null && m[1] !== "skills")
        expect({ line, empty: m[2] === "" }).toEqual({ line, empty: false });
    }
    expect(block).toContain("  - wip-subagent-protocol");
    expect(skill).toContain("a key without a value is not written");
  });

  test("the CLI reads them as generics with their level's model", () => {
    const project = initProject();
    for (const name of GENERIC_AGENTS) {
      const def = readAgent(join(project.dir, ".claude", "agents", `${name}.md`));
      expect(def.problems).toEqual([]);
      expect(def.generic).toBe(true);
      expect(def.model).toBe(GENERIC_MODELS[name] as string);
    }
    const coordinator = readAgent(join(project.dir, ".claude", "agents", "wip.md"));
    expect(coordinator.problems).toEqual([]);
    expect(coordinator.generic).toBe(false);
    expect(coordinator.coordinator).toBe(true);
    expect(coordinator.model).toBe("inherit");
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
    expect(frontmatter("agents/wip.md").skills).toBeUndefined();
  });
});

describe("skills (F-AGE-15, F-AGE-16, F-AGE-20, F-SKL-01, F-NEW-05)", () => {
  test("every skill has a name equal to its folder, a description and a wip: mark; no rules/ or flows/", () => {
    const skills = entries("skills/").filter(([key]) => key.endsWith("/SKILL.md"));
    expect(skills.map(([key]) => key).sort()).toEqual([
      "skills/wip-coordinate/SKILL.md",
      "skills/wip-flow-development/SKILL.md",
      "skills/wip-flow-ideas/SKILL.md",
      "skills/wip-flow-reports/SKILL.md",
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
      "Edit each definition in the language it is already written in.",
    ]) {
      expect(skill).toContain(clause);
    }
    for (const icon of ["🟦", "🟩", "🟨", "🟧", "🟥"]) expect(skill).toContain(icon);
  });

  test("wip-coordinate lets the coordinator run only wip by Bash and sends definition changes to a run without item", () => {
    const skill = template("skills/wip-coordinate/SKILL.md");
    expect(skill).toContain("## Writing and Bash");
    expect(skill).toContain('By Bash you run only `"$WIP_BIN" …`');
    expect(skill).not.toContain("init --models");
    const changing = section(skill, "## Changing the definitions");
    expect(changing).toContain("**The run without item.**");
    expect(changing).toContain("`ID: none`");
    expect(changing).toContain(".wip/defs-runs/<stamp>/");
    expect(changing).not.toContain("No item is needed");
  });

  test("wip-coordinate carries the polling protocol, and the coordinator points to it", () => {
    const skill = template("skills/wip-coordinate/SKILL.md");
    const polling = section(skill, "## Polling");
    expect(polling).toContain("«The read» («Cron»)");
    expect(polling).toContain('`"$WIP_BIN" poll record <flow> <poll>');
    expect(polling).toContain('`"$WIP_BIN" poll seen <flow> <poll> <key>`');
    expect(polling).toContain("`last_seen`");
    expect(polling).toContain('no `"$WIP_BIN" agent start`');
    expect(polling).toContain("Skip a poll whose pass is still running");
    expect(polling).toContain("«overdue: no session was open»");
    // `poll due` stays for scripts and CI: no step of the pass runs it
    expect(polling).not.toMatch(/^\d\. .*poll due --json/m);
    // the Polling section never starts a run for a pass
    expect(polling).not.toMatch(/`"\$WIP_BIN" agent start <ID>/);
    expect(section(skill, RUNTIME_SECTION)).toContain(
      "| 6 | `schedule(prompt, at)`, `scheduled()`, `unschedule(id)` | «Cron» | `CronCreate`, `CronList`, `CronDelete` |",
    );
    const wip = template("agents/wip.md");
    expect(wip).toContain("«The read» of «Cron» in `wip-coordinate`");
    expect(wip).not.toContain("poll due");
    expect(bodyOf(wip).trimEnd().split("\n").length).toBeLessThanOrEqual(MAX_BODY_LINES);
  });

  test("wip-coordinate carries «Cron»: one reader, five moments, one-shot jobs", () => {
    const skill = template("skills/wip-coordinate/SKILL.md");
    const cron = section(skill, "## Cron");
    expect(cron).toContain('`"$WIP_BIN" cron list --json` is the only reader');
    expect(cron).toContain("`[wip-job");
    for (const moment of ["R1", "R2", "R3", "R4", "R5"]) expect(cron).toContain(`| ${moment} |`);
    expect(cron).toContain("never the user's words");
    expect(cron).toContain("a reminder, not an alarm");
    const runtime = section(skill, RUNTIME_SECTION);
    expect(runtime).toContain("`CronCreate` with `recurring: false`");
    expect(runtime).toContain("`CronList`");
    expect(runtime).toContain("`CronDelete`");
    expect(runtime).not.toContain("/loop");
    const protocol = template(`skills/${PROTOCOL_SKILL}/SKILL.md`);
    for (const cmd of [
      "cron add",
      "cron done",
      "cron cancel",
      "cron snooze",
      "poll record",
      "poll seen",
    ]) {
      expect(protocol).toContain(`\`${cmd}\``);
    }
  });

  test("the escalation order is the generics' order, cheapest first", () => {
    const skill = template("skills/wip-coordinate/SKILL.md");
    expect(skill).toContain("`fast` →\n   `efficient` → `thinker` → `wise`");
    expect(GENERIC_AGENTS).toEqual(["fast", "efficient", "thinker", "wise"]);
  });

  test("wip-coordinate carries the model change: unset fallback, backup, one-line diff, validation", () => {
    const section_ = section(template("skills/wip-coordinate/SKILL.md"), "## Changing a model");
    for (const clause of [
      "`models_unset`",
      "do not block the session",
      "`inherit`",
      "`.wip/backups/defs/agents/<name>.md.<timestamp>`",
      "right after\n   `description:`",
      "exactly that line",
      '`"$WIP_BIN" flow lint` exits 0',
      "restore the backup",
      "a subagent in a run without item",
      "never asks for or changes a model",
    ]) {
      expect({ clause, found: section_.includes(clause) }).toEqual({ clause, found: true });
    }
    expect(section_).not.toContain("init --models");
    expect(template("skills/wip-coordinate/SKILL.md")).not.toContain("## Model onboarding");
    const runtime = section(template("skills/wip-coordinate/SKILL.md"), RUNTIME_SECTION);
    expect(runtime).toContain("reads `model:`");
    expect(runtime).toContain("`/agents`");
  });

  test("the model change covers the coordinator's model too and says it applies on restart", () => {
    const skill = template("skills/wip-coordinate/SKILL.md");
    const change = section(skill, "## Changing a model");
    for (const clause of [
      "the coordinator (`wip: coordinator`)",
      "or of the coordinator",
      "for the coordinator,\n   the model Claude Code is started with",
      "to restart the session to apply it",
    ]) {
      expect({ clause, found: change.includes(clause) }).toEqual({ clause, found: true });
    }
    const runtime = section(skill, RUNTIME_SECTION);
    expect(runtime).toContain(
      "`wip start` runs `claude --agent wip --name wip-{stamp}` by default",
    );
    expect(runtime).toContain(
      "with `inherit`, the coordinator runs on the model `claude` is started with",
    );
  });

  test("the coordinator no longer asks the model or start questions at startup", () => {
    const wip = template("agents/wip.md");
    expect(wip).toContain("do not ask the model questions yourself");
    expect(wip).not.toContain("Model onboarding");
    const start = section(template("skills/wip-coordinate/SKILL.md"), "## Start command");
    expect(start).toContain("only when the user asks to change how wip starts Claude Code");
    expect(start).not.toContain("at the next startup");
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
      '"$WIP_BIN" flow lint <flow>',
      "restore the backup",
      '"$WIP_BIN" state --flow <flow>',
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
      agentsDir: join(project.dir, ".claude", "agents"),
      liveItems: [],
    });
    expect(result.problems).toEqual([]);
  });

  test("example.md is a whole flow skill that passes lint, and init never makes it a flow", () => {
    const project = initProject();
    const result = lintFlow({
      name: "review",
      text: template("skills/wip-new-flow/example.md"),
      agentsDir: join(project.dir, ".claude", "agents"),
      skill: true,
      liveItems: [],
    });
    expect(result.problems).toEqual([]);
    expect(frontmatter("skills/wip-new-flow/example.md").name).toBe("wip-flow-review");
    expect(project.wip(["flow", "lint"]).stdout).toBe(LINT_ALL);
  });
});

describe("the tasks flow template (F-NEW-03, F-FLC-03, F-FLU-15)", () => {
  const FLOW_KEY = `skills/wip-flow-${DEFAULT_FLOW}/SKILL.md`;

  test("wip flow lint passes on what init writes", () => {
    const project = initProject();
    const out = project.wip(["flow", "lint"]);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(EXIT.OK);
    expect(out.stdout).toBe(LINT_ALL);
    expect(template(FLOW_KEY)).toContain('`"$WIP_BIN" phase <ID> todo --flow tasks`');
    expect(String(frontmatter(FLOW_KEY).description)).toContain("for the coordinator");
  });

  test("three phases, one per stage, each with its gate, agent, writes and next", () => {
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
      ["todo", "todo", "ask", "thinker", "artifacts", ["doing", "done"], true],
      ["doing", "doing", "ask", "efficient", "project", ["done"], false],
      ["done", "done", "none", null, "artifacts", [], false],
    ]);
    expect(flow.phases.map((ph) => ph.waitingDefault)).toEqual(["user", "agent", "none"]);
    expect(flow.phases.at(-1)?.kind).toBe("terminal");
    expect(Object.keys(flow.fields)).toEqual(["title"]);
    expect(flow.seed).toEqual([
      {
        id: "onboarding",
        phase: "todo",
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
      "the first suggestion of its `🟪 NEXT · …` line\n   is «You have an onboarding task (`onboarding`): tell me when you want to start». No other text about it beyond the\n   one line that «Start of every session» adds while it is still not started.",
      "**Step 1 · the guide.**",
      "«The kanban» in\n   `<defs>/agents/wip.md`",
      '`"$WIP_BIN" wait onboarding user --next "read the guide and find this task on the kanban"`',
      "**Step 2 · questions.**",
      "from `guide.md` and `<defs>/`, never from memory",
      '`"$WIP_BIN" wait onboarding user --next "close the onboarding at its gate"`',
      "**Step 3 · the gate.**",
      '`"$WIP_BIN" gate open onboarding todo --question "Close the onboarding?" --detail <guide.md path>`',
      '`"$WIP_BIN" phase onboarding done`, `"$WIP_BIN" archive onboarding`',
      "«try a task: ask for your first one»",
      "**Proactive:**",
    ];
    let at = -1;
    for (const step of steps) {
      const found = own.indexOf(step);
      expect({ step, found: found > at }).toEqual({ step, found: true });
      at = found;
    }
    expect(own).not.toMatch(/(?<![$"])wip agent start/);
    expect(own).not.toContain("launch");

    const flat = (text: string) => text.replace(/\s+/g, " ");
    const guideLine =
      "the flows and agents are yours to change — edit one, disable one you do not use, or create a new flow or agent by asking; «Your own flows and agents» in the guide says how.";
    const startLine =
      "If it is still not started (its `next` is the seeded one), add one line to that message: edit a flow or an agent, disable a flow you do not use, or create a new flow or agent by asking you; «Your own flows and agents» in the guide says how. Only while it is not started.";
    expect(flat(own)).toContain(guideLine);
    const templateStart = flat(section(template("agents/wip.md"), "## Start of every session"));
    expect(templateStart).toContain(startLine);
    const dogfood = readFileSync(join(import.meta.dir, "../../.claude/agents/wip.md"), "utf8");
    expect(flat(section(dogfood, "## Start of every session"))).toContain(startLine);
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
      "Edit a flow or an agent",
      "Disable a flow you do not use",
      "Create a new flow or agent",
      '`"$WIP_BIN" flow disable <flow>`',
      '`"$WIP_BIN" flow enable <flow>`',
      "`.wip/backups/defs/`",
      "`wip-new-flow`",
      "`wip-new-agent`",
      "`development`",
      "`ideas`",
      "`reports`",
    ];
    for (const name of names) {
      expect({ name, found: guide.includes(name) }).toEqual({ name, found: true });
    }
  });

  test("its stages pass the lint; a stage split in two does not", () => {
    const project = initProject();
    const agentsDir = join(project.dir, ".claude", "agents");
    const lint = (text: string): string[] =>
      lintFlow({ name: DEFAULT_FLOW, text, agentsDir, skill: true, liveItems: [] }).problems;
    expect(lint(template(FLOW_KEY))).toEqual([]);
    const split = template(FLOW_KEY).replace(
      "  - name: done\n    stage: done",
      "  - name: done\n    stage: todo",
    );
    expect(split).not.toBe(template(FLOW_KEY));
    expect(lint(split)).toEqual(["stages must be contiguous in phase order: todo → doing → todo"]);
  });

  test("## Subagents and a ### section for every phase are filled; there is no phase table", () => {
    const text = template(FLOW_KEY);
    const phases = ["todo", "doing", "done"];
    const sections = extractSections(text, phases);
    expect((sections.subagents ?? "").length).toBeGreaterThan(200);
    for (const phase of phases) {
      expect((sections.phaseNotes[phase] ?? "").length).toBeGreaterThan(80);
    }
    for (const phase of ["todo", "doing"]) {
      expect(sections.subagents).toContain(`\`${phase}\` uses`);
    }
    expect(sections.phaseNotes.todo).toContain(
      "the deliverable (code, a report, a document, a decision)",
    );
    expect(sections.phaseNotes.doing).toContain(
      "each question of an investigation has an answer and",
    );
    expect(text).not.toContain("verify");
    expect(text.split("\n").some((line) => line.startsWith("|"))).toBe(false);
  });
});

describe("the shipped flows (F-NEW-03)", () => {
  test("init ships four flows, all selected by default, and tasks stays the seeder", () => {
    expect(flowNames()).toEqual([...DEFAULT_FLOWS]);
    expect(DEFAULT_FLOW).toBe("tasks");
    for (const name of DEFAULT_FLOWS) {
      const key = `skills/wip-flow-${name}/SKILL.md`;
      expect(frontmatter(key).wip).toBe("flow");
      expect(frontmatter(key).name).toBe(`wip-flow-${name}`);
      expect(parseFlow(name, template(key)).problems).toEqual([]);
    }
  });

  test("every shipped flow passes lint with the shipped agents", () => {
    const project = initProject();
    const agentsDir = join(project.dir, ".claude", "agents");
    for (const name of DEFAULT_FLOWS) {
      const { problems } = lintFlow({
        name,
        text: template(`skills/wip-flow-${name}/SKILL.md`),
        agentsDir,
        skill: true,
        liveItems: [],
      });
      expect({ name, problems }).toEqual({ name, problems: [] });
    }
    expect(project.wip(["flow", "lint"]).stdout).toBe(LINT_ALL);
  });

  test("selectTemplates keeps every non-flow template and only the selected flows' folders", () => {
    const onlyTasks = Object.keys(selectTemplates(["tasks"])).sort();
    expect(onlyTasks).toEqual(
      Object.keys(TEMPLATES)
        .filter((key) => {
          const flow = flowOfKey(key);
          return flow === null || flow === "tasks";
        })
        .sort(),
    );
    expect(onlyTasks.some((key) => key.startsWith("skills/wip-flow-ideas/"))).toBe(false);
    expect(Object.keys(selectTemplates(DEFAULT_FLOWS)).sort()).toEqual(
      Object.keys(TEMPLATES).sort(),
    );
  });
});

describe("the templates and the dogfood copies", () => {
  test("the shipped flows and wip-coordinate are byte-identical in templates/ and .claude/", () => {
    const repo = join(import.meta.dir, "../..");
    const shipped = Object.keys(TEMPLATES).filter(
      (key) => key.startsWith("skills/wip-flow-") || key === "skills/wip-coordinate/SKILL.md",
    );
    for (const key of shipped) {
      expect({ key, text: readFileSync(join(repo, ".claude", key), "utf8") }).toEqual({
        key,
        text: template(key),
      });
    }
    // Agents stay out: the dogfood efficient runs `opus` and the template ships `sonnet`.
    expect(readFileSync(join(repo, ".claude/agents/efficient.md"), "utf8")).not.toBe(
      TEMPLATES["agents/efficient.md"],
    );
  });
});

describe("the templates target Claude Code and use the real CLI (D9, F-NEW-06)", () => {
  const FORBIDDEN_EVERYWHERE = [/\bHarbiz\b/i, /\bJira\b/i, /\btier\b/i, /\bSlack\b/i];
  // Claude and its model aliases may appear anywhere; the tool and API names stay in the runtime section.
  const RUNTIME_ONLY = [
    /AskUserQuestion/,
    /SendMessage/,
    /TaskStop/,
    /ToolSearch/,
    /subagent_type/,
    /run_in_background/,
  ];
  const ABSOLUTE_PATH =
    /(^|[\s`"'(])(\/(Users|home|tmp|var|private|etc|opt|root)\/|~\/(?![…`])|[A-Za-z]:\\)/m;

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
      for (const m of text.matchAll(/`((?:wip|"\$WIP_BIN") [^`\n]+)`/g))
        quoted.push(m[1] as string);
      for (const fence of text.matchAll(/^```[a-z-]*\n([\s\S]*?)^```$/gm)) {
        for (const m of (fence[1] ?? "").matchAll(/^\s*((?:wip|"\$WIP_BIN") [^\n]+)$/gm))
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

describe("the definitions folder in the user's home", () => {
  test("no template says <defs>/ is always versioned, and each that defines <defs> names ~/", () => {
    for (const [key, text] of Object.entries(TEMPLATES)) {
      expect(text).not.toContain("is versioned with the project:");
      if (key === "skills/wip-new-flow/SKILL.md") expect(text).toContain("A `~/…` folder is not");
    }
    for (const key of [
      "agents/wip.md",
      "skills/wip-coordinate/SKILL.md",
      "skills/wip-subagent-protocol/SKILL.md",
      "skills/wip-new-flow/SKILL.md",
      "skills/wip-new-agent/SKILL.md",
      "skills/wip-flow-tasks/guide.md",
    ]) {
      const text = TEMPLATES[key] ?? "";
      expect(text).toContain("`~/");
      expect(text).toContain("--global");
    }
  });
});

describe("the wip: mark of what init writes (guard)", () => {
  test("every file init writes carries a wip: mark init reads as its own", () => {
    const marks = Object.entries(TEMPLATES).map(([key, text]) => ({
      key,
      marked: hasWipMark(text),
    }));
    for (const mark of marks) expect(mark).toEqual({ key: mark.key, marked: true });
  });

  test("every .md under templates/ is a TEMPLATES key, so a new template cannot skip the check", () => {
    const dir = join(import.meta.dir, "../../templates");
    const md = readdirSync(dir, { recursive: true })
      .map((entry) => String(entry).replaceAll("\\", "/"))
      .filter((rel) => rel.endsWith(".md"))
      .sort();
    expect(md.length).toBeGreaterThan(0);
    for (const rel of md) expect(Object.keys(TEMPLATES)).toContain(rel);
  });

  test("what init writes is never a foreign file", () => {
    p = makeProject("templates-foreign");
    const defsRoot = join(p.dir, ".claude");
    scaffold(p.dir, {
      force: false,
      stamp: "guard",
      defsDir: ".claude",
      defsRoot,
    });
    expect(foreignFiles(defsRoot, ".claude")).toEqual([]);
  });
});
