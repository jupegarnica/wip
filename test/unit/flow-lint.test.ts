import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/errors.ts";
import { type ILiveItem, lintFlow } from "../../src/flow/lint.ts";
import {
  agentsDir,
  fixture,
  flowFile,
  minimalFlow,
  putAgent,
  putFlow,
  putItems,
  putValidAgents,
} from "../helpers/defs.ts";
import { type IProject, makeProject, scratch } from "../helpers/project.ts";
import { loadSchema, validate } from "../helpers/schema.ts";

let dir = "";
let p: IProject | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
  p?.cleanup();
  p = null;
});

function lint(name: string, text: string = fixture("flows", name), liveItems: ILiveItem[] = []) {
  dir ||= scratch("flow-lint");
  return lintFlow({ name, text, agentsDir: agentsDir(dir), liveItems }).problems;
}

function lintWithAgents(name: string, text?: string, liveItems: ILiveItem[] = []) {
  dir = scratch("flow-lint");
  putValidAgents(dir);
  return lint(name, text, liveItems);
}

describe("flow lint rules (F-FLU-12)", () => {
  test("the valid fixture passes, its phase table that differs from the block included (D5)", () => {
    expect(lintWithAgents("valid")).toEqual([]);
  });

  test("schema: unknown keys and invalid values", () => {
    expect(lint("bad-schema").length).toBeGreaterThanOrEqual(7);
    expect(lint("bad-schema")).toContain(
      "unknown key 'schedule' (version, color, id_pattern, fields, links, phases, seed, polling)",
    );
  });

  test("an unreachable phase", () => {
    expect(lint("unreachable")).toEqual(["unreachable from todo: orphan (no next leads there)"]);
  });

  test("no terminal phase", () => {
    expect(lint("no-terminal")).toEqual([
      "no terminal phase: at least one phase has kind terminal",
    ]);
  });

  test("two terminal phases are valid, each non-terminal phase reaching one of them", () => {
    expect(lint("two-terminals")).toEqual([]);
  });

  test("a next cycle with no way to a terminal phase", () => {
    expect(lint("no-exit")).toEqual(["phases loop, spin: never reach a terminal phase"]);
    const one = [
      "```wip-flow",
      "phases:",
      "  - name: todo",
      "    next: [done, trap]",
      "  - name: trap",
      "    next: [sink]",
      "  - name: sink",
      "  - name: done",
      "    kind: terminal",
      "```",
    ].join("\n");
    expect(lint("x", one)).toEqual([
      "phase sink: no next, the item could never leave it",
      "phase trap: never reaches a terminal phase",
    ]);
  });

  test("the same cycle with a from_any phase that reaches a terminal is clean", () => {
    const text = [
      "```wip-flow",
      "phases:",
      "  - name: todo",
      "    next: [done, loop]",
      "  - name: loop",
      "    next: [spin]",
      "  - name: spin",
      "    next: [loop]",
      "  - name: hub",
      "    from_any: true",
      "    next: [done]",
      "  - name: done",
      "    kind: terminal",
      "```",
    ].join("\n");
    expect(lint("x", text)).toEqual([]);
  });

  test("a from_any terminal phase is clean: every phase reaches it", () => {
    const text = [
      "```wip-flow",
      "phases:",
      "  - name: todo",
      "    next: [loop]",
      "  - name: loop",
      "    next: [todo]",
      "  - name: done",
      "    kind: terminal",
      "    from_any: true",
      "```",
    ].join("\n");
    expect(lint("x", text)).toEqual([]);
  });

  test("a phase with no next, or unreachable, is not repeated as never reaching a terminal", () => {
    const text = [
      "```wip-flow",
      "phases:",
      "  - name: todo",
      "    next: [a, done]",
      "  - name: a",
      "  - name: x",
      "    next: [done]",
      "  - name: done",
      "    kind: terminal",
      "```",
    ].join("\n");
    expect(lint("x", text)).toEqual([
      "phase a: no next, the item could never leave it",
      "unreachable from todo: x (no next leads there)",
    ]);
  });

  test("next to a phase that does not exist", () => {
    expect(lint("next-missing")).toEqual(["phase todo: next 'review' is not a phase"]);
  });

  test("next to the phase itself", () => {
    expect(lint("x", minimalFlow("next: [todo, done]").replace("    next: [done]\n", ""))).toEqual([
      "phase todo: next names the phase itself",
    ]);
  });

  test("an invalid waiting_default", () => {
    expect(lint("bad-waiting")).toEqual([
      "phase todo: waiting_default: 'human-reviewer' is not one of agent | user | external | none",
    ]);
  });

  test("waiting_default none outside the terminal, and a terminal that waits or has next", () => {
    const text = [
      "```wip-flow",
      "phases:",
      "  - name: todo",
      "    next: [done]",
      "    waiting_default: none",
      "  - name: done",
      "    kind: terminal",
      "    waiting_default: user",
      "    next: [todo]",
      "```",
    ].join("\n");
    expect(lint("x", text)).toEqual([
      "phase todo: waiting_default none is only for a terminal phase",
      "phase done: a terminal phase has no next",
      "phase done: a terminal phase waits on none",
    ]);
  });

  test("from_any makes a phase reachable and may sit on the terminal or repeat next", () => {
    const flow = (extra: string, doneKeys = "") =>
      [
        "```wip-flow",
        "phases:",
        "  - name: todo",
        "    next: [done]",
        "  - name: plan",
        "    from_any: true",
        "    next: [review]",
        "  - name: review",
        `    next: [${extra}]`,
        "  - name: done",
        "    kind: terminal",
        ...(doneKeys ? [`    ${doneKeys}`] : []),
        "```",
        "",
      ].join("\n");
    // plan has no incoming next; review is reachable only from the next of a from_any phase
    expect(lint("x", flow("done"))).toEqual([]);
    expect(lint("x", flow("done", "from_any: true"))).toEqual([]);
    expect(lint("x", flow("plan, done"))).toEqual([]);
  });

  test("a non-terminal phase without next", () => {
    const text = "```wip-flow\nphases:\n  - name: todo\n  - name: done\n    kind: terminal\n```\n";
    expect(lint("x", text)).toEqual([
      "phase todo: no next, the item could never leave it",
      "unreachable from todo: done (no next leads there)",
    ]);
  });

  test("links with an invalid regular expression or a non-http url", () => {
    expect(lint("bad-links")[0]).toStartWith("links[0].pattern is not a valid regular expression");
    const text = minimalFlow().replace(
      "phases:",
      "links:\n  - pattern: x\n    url: ftp://a\nphases:",
    );
    expect(lint("x", text)).toEqual(["links[0].url must start with http(s)://"]);
  });

  test("an invalid id_pattern", () => {
    const text = minimalFlow().replace("phases:", 'id_pattern: "T[0-9"\nphases:');
    expect(lint("x", text)[0]).toStartWith("id_pattern is not a valid regular expression");
  });

  test("writes outside artifacts | project", () => {
    expect(lint("bad-writes")).toEqual([
      "phase todo: writes: 'everything' is not one of artifacts | project",
    ]);
  });

  test("stages that are not contiguous when every phase declares one", () => {
    const text = [
      "```wip-flow",
      "phases:",
      "  - {name: a, next: [b], stage: one}",
      "  - {name: b, next: [c], stage: two}",
      "  - {name: c, next: [d], stage: one}",
      "  - {name: d, kind: terminal, stage: two}",
      "```",
    ].join("\n");
    expect(lint("x", text)).toEqual([
      "stages must be contiguous in phase order: one → two → one → two",
    ]);
  });

  test("stage on some phases only is allowed", () => {
    expect(lint("x", minimalFlow("stage: doing"))).toEqual([]);
  });

  test("a missing or broken wip-flow block", () => {
    expect(lint("no-block")).toEqual(["no ```wip-flow block"]);
    expect(lint("bad-yaml")[0]).toStartWith("the wip-flow block is not valid YAML");
  });
});

describe("seed of a flow (F-NEW-08)", () => {
  const seeded = (seed: string, phaseKeys = "waiting_default: user"): string =>
    minimalFlow(phaseKeys).replace(/```\n$/, `seed:\n${seed}\n\`\`\`\n`);

  test("a seed in a phase that waits on the user passes", () => {
    expect(lint("x", seeded("  - {id: hello, phase: todo, title: Hi, next: read it}"))).toEqual([]);
  });

  test("unknown keys, a missing id or phase, and a list that is not one", () => {
    expect(lint("x", seeded("  - {id: a, phase: todo, owner: me}"))).toEqual([
      "seed[0]: unknown key 'owner'",
    ]);
    expect(lint("x", seeded("  - {title: Hi}"))).toEqual([
      "seed[0]: missing id",
      "seed[0]: missing phase",
    ]);
    expect(lint("x", seeded("  hello: todo"))).toEqual([
      "seed: must be a list of {id, phase, title, next, files}",
    ]);
  });

  test("a phase that does not exist, a repeated or invalid ID, and a phase that waits on an agent", () => {
    expect(lint("x", seeded("  - {id: a, phase: nope}"))).toEqual([
      "seed a: phase 'nope' is not a phase",
    ]);
    expect(lint("x", seeded("  - {id: a, phase: todo}\n  - {id: a, phase: todo}"))).toEqual([
      "seed ids repeat: a",
    ]);
    expect(lint("x", seeded("  - {id: '-a', phase: todo}"))).toEqual([
      "seed -a: not a valid item ID for this flow",
    ]);
    expect(lint("x", seeded("  - {id: a, phase: todo}", ""))).toEqual([
      "seed a: phase todo waits on agent; a seeded item starts in a phase whose waiting_default is user or external",
    ]);
    expect(lint("x", seeded("  - {id: a, phase: done}"))).toEqual([
      "seed a: phase done waits on none; a seeded item starts in a phase whose waiting_default is user or external",
    ]);
  });

  describe("files", () => {
    const lintIn = (skillDir: string, seed: string): string[] => {
      dir ||= scratch("flow-lint");
      return lintFlow({
        name: "x",
        text: seeded(seed),
        agentsDir: agentsDir(dir),
        skillDir,
        liveItems: [],
      }).problems;
    };
    const skillDir = (): string => {
      dir ||= scratch("flow-lint");
      const skills = join(dir, ".claude", "skills", "wip-flow-x");
      mkdirSync(skills, { recursive: true });
      writeFileSync(join(skills, "guide.md"), "# guide\n");
      return skills;
    };

    test("a file present in the flow's skill folder passes", () => {
      expect(lintIn(skillDir(), "  - {id: a, phase: todo, files: [guide.md]}")).toEqual([]);
    });

    test("a missing file names the flow's skill folder", () => {
      expect(lintIn(skillDir(), "  - {id: a, phase: todo, files: [guide.md, missing.md]}")).toEqual(
        ["seed a: file 'missing.md' is missing from .claude/skills/wip-flow-x/"],
      );
    });

    test("invalid and repeated names", () => {
      const skills = skillDir();
      expect(
        lintIn(
          skills,
          "  - {id: a, phase: todo, files: ['../x', .hidden, a/b, x..md, guide.md, guide.md]}",
        ),
      ).toEqual([
        "seed a: file '../x' is not a valid artifact name",
        "seed a: file '.hidden' is not a valid artifact name",
        "seed a: file 'a/b' is not a valid artifact name",
        "seed a: file 'x..md' is not a valid artifact name",
        "seed a: files repeat: guide.md",
      ]);
    });

    test("a link that leaves the skill folder is rejected", () => {
      const skills = skillDir();
      const outside = join(dir, "outside.md");
      writeFileSync(outside, "secret\n");
      symlinkSync(outside, join(skills, "link.md"));
      expect(lintIn(skills, "  - {id: a, phase: todo, files: [link.md]}")).toEqual([
        "seed a: file 'link.md' is missing from .claude/skills/wip-flow-x/",
      ]);
    });

    test("without a skill folder only the names are checked", () => {
      expect(lint("x", seeded("  - {id: a, phase: todo, files: [nowhere.md]}"))).toEqual([]);
    });
  });
});

describe("agent: of a phase (D6)", () => {
  test("an agent with no file", () => {
    expect(lint("x", minimalFlow("agent: ghost"))).toEqual([
      "phase todo: agent ghost: no agent file .claude/agents/ghost.md",
    ]);
  });

  test("an agent without name", () => {
    dir = scratch("flow-lint");
    putAgent(dir, "no-name");
    expect(lint("x", minimalFlow("agent: no-name"))).toEqual([
      "phase todo: agent no-name: frontmatter has no name",
    ]);
  });

  test("an agent whose name differs from its file", () => {
    dir = scratch("flow-lint");
    putAgent(dir, "other-name");
    expect(lint("x", minimalFlow("agent: other-name"))).toEqual([
      "phase todo: agent other-name: frontmatter name 'someone-else' differs from the file name 'other-name'",
    ]);
  });

  test("an agent without description", () => {
    dir = scratch("flow-lint");
    putAgent(dir, "no-description");
    expect(lint("x", minimalFlow("agent: no-description"))).toEqual([
      "phase todo: agent no-description: frontmatter has no description",
    ]);
  });

  test("an agent with model and unknown keys passes", () => {
    dir = scratch("flow-lint");
    putAgent(dir, "thinker");
    expect(lint("x", minimalFlow("agent: thinker"))).toEqual([]);
  });

  test("unknown keys of a phase (runtime keys such as model) are tolerated", () => {
    expect(lint("x", minimalFlow("model: big\ntimeout: 30"))).toEqual([]);
  });
});

describe("live items (F-FLU-12)", () => {
  test("an open item in a phase the flow no longer has", () => {
    expect(
      lint("minimal", undefined, [
        { id: "T1", phase: "review" },
        { id: "T2", phase: "todo" },
      ]),
    ).toEqual(["item T1 is in phase review, which the flow no longer has"]);
  });
});

describe("wip flow lint (command)", () => {
  test("with no flows it is exit 0 and says so", () => {
    p = makeProject("cmd-empty");
    const out = p.wip(["flow", "lint"]);
    expect(out.code).toBe(EXIT.OK);
    expect(out.stdout).toBe("no flows in .claude/skills/wip-flow-*/SKILL.md\n");
  });

  test("without an argument it lints every flow and is exit 1 if one fails", () => {
    p = makeProject("cmd-all");
    putValidAgents(p.dir);
    putFlow(p.dir, "valid", fixture("flows", "valid"));
    putFlow(p.dir, "minimal", fixture("flows", "minimal"));
    expect(p.wip(["flow", "lint"])).toEqual({
      code: EXIT.OK,
      stdout: "OK minimal\nOK valid\n",
      stderr: "",
    });
    putFlow(p.dir, "broken", fixture("flows", "no-terminal"));
    const out = p.wip(["flow", "lint"]);
    expect(out.code).toBe(EXIT.FINDINGS);
    expect(out.stdout).toBe(
      "broken · no terminal phase: at least one phase has kind terminal\nOK minimal\nOK valid\n",
    );
    expect(out.stderr).toContain("flow broken does not pass");
  });

  test("with a flow name it lints only that one", () => {
    p = makeProject("cmd-one");
    putFlow(p.dir, "minimal", fixture("flows", "minimal"));
    putFlow(p.dir, "broken", fixture("flows", "unreachable"));
    expect(p.wip(["flow", "lint", "minimal"]).code).toBe(EXIT.OK);
    expect(p.wip(["flow", "lint", "broken"]).code).toBe(EXIT.FINDINGS);
  });

  test("an unknown flow is exit 4, a bad subcommand or extra argument exit 2", () => {
    p = makeProject("cmd-usage");
    expect(p.wip(["flow", "lint", "ghost"]).code).toBe(EXIT.NOT_FOUND);
    expect(p.wip(["flow"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["flow", "check"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["flow", "lint", "a", "b"]).code).toBe(EXIT.USAGE);
  });

  test("--json is the envelope with one entry per flow", () => {
    p = makeProject("cmd-json");
    putFlow(p.dir, "minimal", fixture("flows", "minimal"));
    putFlow(p.dir, "broken", fixture("flows", "next-missing"));
    const env = p.json(["flow", "lint"]);
    expect(validate(loadSchema("envelope"), env)).toEqual([]);
    expect(env.ok).toBe(false);
    const flows = (env.data as { flows: Record<string, unknown>[] }).flows;
    expect(flows.map((f) => [f.name, f.ok, f.using])).toEqual([
      ["broken", false, null],
      ["minimal", true, "file"],
    ]);
    expect(flows[0]?.problems).toEqual(["phase todo: next 'review' is not a phase"]);
    expect(flows[1]?.path).toBe(".claude/skills/wip-flow-minimal/SKILL.md");
    expect(flows[1]?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect((env.warnings as { code: string }[]).map((w) => w.code)).toEqual(["flow_invalid"]);
  });

  test("it is a reader: it never creates the database", () => {
    p = makeProject("cmd-reader");
    putFlow(p.dir, "minimal", fixture("flows", "minimal"));
    p.wip(["flow", "lint"]);
    expect(existsSync(p.dbPath)).toBe(false);
  });

  test("it reports an open item in a phase the file no longer has", () => {
    p = makeProject("cmd-items");
    putFlow(p.dir, "minimal", fixture("flows", "minimal"));
    putItems(p.dbPath, "minimal", [{ id: "T1", phase: "review" }]);
    const out = p.wip(["flow", "lint", "minimal"]);
    expect(out.code).toBe(EXIT.FINDINGS);
    expect(out.stdout).toBe("minimal · item T1 is in phase review, which the flow no longer has\n");
  });

  test("it reads agents from the project's .claude/agents/", () => {
    p = makeProject("cmd-agents");
    putFlow(p.dir, "x", minimalFlow("agent: thinker"));
    expect(p.wip(["flow", "lint"]).code).toBe(EXIT.FINDINGS);
    putAgent(p.dir, "thinker");
    expect(p.wip(["flow", "lint"]).code).toBe(EXIT.OK);
  });

  test("a flow skill without its frontmatter, or with another name, does not pass", () => {
    p = makeProject("cmd-frontmatter");
    putFlow(p.dir, "bare", "---\ndescription: x\n---\n");
    writeFileSync(flowFile(p.dir, "bare"), minimalFlow());
    putFlow(p.dir, "named", `---\nname: wip-flow-other\ndescription: x\n---\n\n${minimalFlow()}`);
    putFlow(p.dir, "nodesc", `---\nname: wip-flow-nodesc\n---\n\n${minimalFlow()}`);
    const out = p.wip(["flow", "lint"]);
    expect(out.code).toBe(EXIT.FINDINGS);
    expect(out.stdout).toBe(
      [
        "bare · no frontmatter (--- block at the top with name and description)",
        "named · frontmatter name 'wip-flow-other' differs from the folder name 'wip-flow-named'",
        "nodesc · frontmatter has no description",
        "",
      ].join("\n"),
    );
  });

  test("with defs_dir .claude it lints .claude/skills/wip-flow-* against .claude/agents", () => {
    p = makeProject("cmd-claude");
    writeFileSync(
      join(p.dir, ".wip", "config.json"),
      '{"defs_dir": ".claude", "harness": "claude-code"}\n',
    );
    putFlow(p.dir, "ignored", minimalFlow(), ".agents");
    putFlow(p.dir, "x", minimalFlow("agent: thinker"), ".claude");
    putAgent(p.dir, "thinker", undefined, ".agents");
    const out = p.wip(["flow", "lint", "--json"]);
    const flows = JSON.parse(out.stdout).data.flows as {
      name: string;
      path: string;
      problems: string[];
    }[];
    expect(flows.map((f) => [f.name, f.path])).toEqual([
      ["x", ".claude/skills/wip-flow-x/SKILL.md"],
    ]);
    expect(flows[0]?.problems).toEqual([
      "phase todo: agent thinker: no agent file .claude/agents/thinker.md",
    ]);
    putAgent(p.dir, "thinker", undefined, ".claude");
    expect(p.wip(["flow", "lint"]).stdout).toBe("OK x\n");
    expect(p.wip(["flow", "lint", "ignored"]).stderr).toContain(
      ".claude/skills/wip-flow-ignored/SKILL.md",
    );
  });
});

describe("polling rules", () => {
  const flow = (polling: string) =>
    `${minimalFlow().replace("```\n", "")}polling:\n${polling}\n\`\`\`\n`;
  const entry = (extra = "", name = "waiting") =>
    `  - name: ${name}\n    agent: fast\n    cadence: 1h${extra ? `\n    ${extra}` : ""}`;

  function withFast(text: string, agent = "fast", body = agentBody("fast")) {
    dir = scratch("flow-lint");
    if (agent) putAgent(dir, agent, body);
    return lint("x", text);
  }
  const agentBody = (name: string) =>
    `---\nname: ${name}\ndescription: test agent ${name}\nrole: subagent\n---\n\nBody.\n`;

  test("a valid flow with polling passes", () => {
    expect(withFast(flow(`${entry("phases: [todo, done]")}\n${entry("", "discover")}`))).toEqual(
      [],
    );
  });

  test("an unknown phase, repeated names and a phase repeated in one entry", () => {
    expect(withFast(flow(entry("phases: [nope]")))).toEqual([
      "polling waiting: phase 'nope' is not a phase",
    ]);
    expect(withFast(flow(`${entry()}\n${entry()}`))).toEqual(["polling names repeat: waiting"]);
    expect(withFast(flow(entry("phases: [todo, todo]")))).toEqual([
      "polling waiting: phases repeat: todo",
    ]);
  });

  test("the agent must exist and have a description", () => {
    expect(withFast(flow(entry()), "")).toEqual([
      "polling waiting: agent fast: no agent file .claude/agents/fast.md",
    ]);
    const problems = withFast(
      flow(entry()),
      "fast",
      "---\nname: fast\nrole: subagent\n---\n\nBody.\n",
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((x) => x.startsWith("polling waiting: agent fast: "))).toBe(true);
  });
});
