import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter, readAgent } from "../../src/agents.ts";
import { COMMANDS } from "../../src/commands/help.ts";
import { GENERIC_AGENTS, RESERVED_AGENTS, TEMPLATES } from "../../src/embedded/templates.ts";
import { EXIT } from "../../src/errors.ts";
import { lintFlow } from "../../src/flow/lint.ts";
import { extractBlocks, extractSections, parseFlow } from "../../src/flow/parse.ts";
import { type IProject, makeProject } from "../helpers/project.ts";

const CAPABILITIES = ["read", "write", "shell", "spawn", "ask-user"];
const RUNTIME_SECTION = "## Runtime interface";

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
      ["efficient", "fast", "thinker", "wip-coordinator", "wise"].map((n) => `agents/${n}.md`),
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

  test("the coordinator has every capability and no model: it uses the session's", () => {
    const fm = frontmatter("agents/wip-coordinator.md");
    expect(fm.role).toBe("coordinator");
    expect(fm.capabilities).toEqual(CAPABILITIES);
    expect(fm).not.toHaveProperty("model");
    expect(fm).not.toHaveProperty("wip");
  });

  test("the coordinator definition is short and points to the wip-coordinate skill", () => {
    const text = template("agents/wip-coordinator.md");
    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(80);
    expect(text).toContain("wip-coordinate");
    expect(text).toContain("wip session start");
    expect(text).toContain("wip state --attention");
    expect(text).toContain("wip check");
    expect(text).toContain("models_unset");
    expect(text).toContain("Never relaunch on your own");
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
    const coordinator = readAgent(join(project.dir, ".agents", "agents", "wip-coordinator.md"));
    expect(coordinator.problems).toEqual([]);
    expect(coordinator.generic).toBe(false);
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

  test("every agent body asks for the output contract and respects Writes:", () => {
    for (const name of GENERIC_AGENTS) {
      const text = template(`agents/${name}.md`);
      for (const token of ["STATUS:", "ARTIFACTS:", "SUMMARY:", "QUESTIONS:", "`Writes:`"]) {
        expect(text).toContain(token);
      }
      expect(text).toContain(".agents/rules/subagents.md");
    }
  });
});

describe("rules and skills (F-AGE-15, F-AGE-16, F-AGE-20, F-SKL-01, F-NEW-05)", () => {
  test("every skill has a name equal to its folder and a description", () => {
    const skills = entries("skills/");
    expect(skills.map(([key]) => key).sort()).toEqual([
      "skills/wip-coordinate/SKILL.md",
      "skills/wip-new-agent/SKILL.md",
      "skills/wip-new-flow/SKILL.md",
    ]);
    for (const [key] of skills) {
      const fm = frontmatter(key);
      expect(fm.name).toBe(key.split("/")[1]);
      expect(String(fm.description).length).toBeGreaterThan(40);
    }
  });

  test("rules/subagents.md holds the shared contract", () => {
    const rules = template("rules/subagents.md");
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
      "What next?",
      RUNTIME_SECTION,
      "**Without subagents**",
      "Edit each definition in the language it is already written in.",
    ]) {
      expect(skill).toContain(clause);
    }
    for (const icon of ["🟦", "🟩", "🟨", "🟧", "🟥"]) expect(skill).toContain(icon);
  });

  test("the escalation order is the generics' order, cheapest first", () => {
    const skill = template("skills/wip-coordinate/SKILL.md");
    expect(skill).toContain("`fast` →\n   `efficient` → `thinker` → `wise`");
    expect(GENERIC_AGENTS).toEqual(["fast", "efficient", "thinker", "wise"]);
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
      ".wip/backups/defs/flows/<flow>.md.<timestamp>",
      "wip flow lint <flow>",
      "restore the backup",
      "wip state --flow <flow>",
      "--force --reason",
      "copy of `.agents/flows/wip.md`",
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
});

describe("the wip flow template (F-NEW-03, F-FLC-03, F-FLU-15)", () => {
  test("wip flow lint passes on what init writes", () => {
    const project = initProject();
    const out = project.wip(["flow", "lint"]);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(EXIT.OK);
    expect(out.stdout).toContain("OK wip");
  });

  test("its phases carry the agents and writes of the plan", () => {
    const { flow, problems } = parseFlow("wip", template("flows/wip.md"));
    expect(problems).toEqual([]);
    if (!flow) throw new Error("no flow");
    const shape = flow.phases.map((ph) => [ph.name, ph.gate, ph.agent ?? null, ph.writes, ph.next]);
    expect(shape).toEqual([
      ["intake", "none", null, "artifacts", ["plan"]],
      ["plan", "ask", "thinker", "artifacts", ["execute"]],
      ["execute", "auto", "efficient", "project", ["verify"]],
      ["verify", "ask", "efficient", "artifacts", ["plan", "execute", "done"]],
      ["done", "none", null, "artifacts", []],
    ]);
    expect(flow.phases.at(-1)?.kind).toBe("terminal");
    expect(Object.keys(flow.fields)).toEqual(["title"]);
  });

  test("## Subagents and a ### section for every phase are filled; there is no phase table", () => {
    const text = template("flows/wip.md");
    const sections = extractSections(text, ["intake", "plan", "execute", "verify", "done"]);
    expect((sections.subagents ?? "").length).toBeGreaterThan(200);
    for (const phase of ["intake", "plan", "execute", "verify", "done"]) {
      expect((sections.phaseNotes[phase] ?? "").length).toBeGreaterThan(80);
    }
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
      if (subs.length > 0 && !subs.includes(tokens[2] ?? "")) {
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
