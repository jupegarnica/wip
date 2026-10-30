import { describe, expect, test } from "bun:test";
import { blockHash, extractSections, parseFlow } from "../../src/flow/parse.ts";
import { fixture, minimalFlow } from "../helpers/defs.ts";

function flowOf(name: string, text: string = fixture("flows", name)) {
  const parsed = parseFlow(name, text);
  if (!parsed.flow) throw new Error(`no flow: ${parsed.problems.join("; ")}`);
  return parsed;
}

describe("the wip-flow block (F-FLU-01, F-FLU-04, F-FLU-07, F-FLU-10)", () => {
  test("the valid fixture parses with no problems", () => {
    const { flow, problems } = flowOf("valid");
    expect(problems).toEqual([]);
    expect(flow?.name).toBe("valid");
    expect(flow?.version).toBe(1);
    expect(flow?.idPattern).toBe("T[0-9]+");
    expect(flow?.phases.map((p) => p.name)).toEqual([
      "intake",
      "plan",
      "execute",
      "verify",
      "done",
    ]);
  });

  test("phases keep kind, gate, next, waiting_default, stage, agent and writes", () => {
    const phases = flowOf("valid").flow?.phases ?? [];
    expect(phases[0]).toEqual({
      name: "intake",
      kind: "work",
      gate: "none",
      next: ["plan"],
      waitingDefault: "user",
      stage: "todo",
      agent: null,
      writes: "artifacts",
    });
    expect(phases[2]).toMatchObject({
      name: "execute",
      kind: "work",
      agent: "efficient",
      writes: "project",
    });
    expect(phases[3]?.next).toEqual(["plan", "execute", "done"]);
  });

  test("a phase without writes is artifacts (D18)", () => {
    const phases = flowOf("valid").flow?.phases ?? [];
    expect(phases.find((p) => p.name === "verify")?.writes).toBe("artifacts");
    expect(flowOf("minimal").flow?.phases.every((p) => p.writes === "artifacts")).toBe(true);
  });

  test("defaults: kind work, gate none, waiting agent, and none for the terminal", () => {
    const [todo, done] = flowOf("minimal").flow?.phases ?? [];
    expect(todo).toMatchObject({
      kind: "work",
      gate: "none",
      waitingDefault: "agent",
      stage: null,
    });
    expect(done).toMatchObject({ kind: "terminal", waitingDefault: "none", next: [] });
  });

  test("fields keep their types, enum with its values", () => {
    expect(flowOf("valid").flow?.fields).toEqual({
      title: { type: "string" },
      attempts: { type: "int" },
      tags: { type: "list" },
      due: { type: "ts" },
      size: { type: "enum", values: ["s", "m", "l"] },
    });
  });

  test("links are a list of {pattern, url}", () => {
    expect(flowOf("valid").flow?.links).toEqual([
      { pattern: "^T([0-9]+)$", url: "https://tracker.example.com/t/$1" },
    ]);
  });

  test("id_pattern is optional", () => {
    expect(flowOf("minimal").flow?.idPattern).toBeNull();
  });
});

describe("schema problems", () => {
  test("unknown keys, bad version, reserved and unknown field types, bad kind, gate and next", () => {
    const { problems } = parseFlow("bad-schema", fixture("flows", "bad-schema"));
    expect(problems).toEqual([
      "unknown key 'polling' (version, id_pattern, fields, links, phases)",
      "version 2: only 1 is supported",
      "phase todo: kind: 'busy' is not one of work | wait | terminal",
      "phase todo: next must be a list of phase names",
      "phase todo: gate: 'maybe' is not one of ask | auto | none",
      "fields.phase: 'phase' is an item column",
      "fields.owner: unknown type 'person' (string | int | list | ts | enum(a|b))",
    ]);
  });

  test("waiting_default outside agent | user | external | none", () => {
    expect(parseFlow("bad-waiting", fixture("flows", "bad-waiting")).problems).toEqual([
      "phase todo: waiting_default: 'human-reviewer' is not one of agent | user | external | none",
    ]);
  });

  test("writes outside artifacts | project", () => {
    expect(parseFlow("bad-writes", fixture("flows", "bad-writes")).problems).toEqual([
      "phase todo: writes: 'everything' is not one of artifacts | project",
    ]);
  });

  test("a file without a wip-flow block", () => {
    const parsed = parseFlow("no-block", fixture("flows", "no-block"));
    expect(parsed.flow).toBeNull();
    expect(parsed.problems).toEqual(["no ```wip-flow block"]);
  });

  test("two blocks", () => {
    const text = `${minimalFlow()}\n${minimalFlow()}`;
    expect(parseFlow("twice", text).problems).toEqual([
      "2 wip-flow blocks: a flow has exactly one",
    ]);
  });

  test("YAML that does not parse", () => {
    const parsed = parseFlow("bad-yaml", fixture("flows", "bad-yaml"));
    expect(parsed.flow).toBeNull();
    expect(parsed.problems[0]).toStartWith("the wip-flow block is not valid YAML");
  });

  test("a block that is not a mapping, and empty phases", () => {
    expect(parseFlow("x", "```wip-flow\n- a\n```\n").problems).toEqual([
      "the wip-flow block must be a mapping",
    ]);
    expect(parseFlow("x", "```wip-flow\nphases: []\n```\n").problems).toEqual([
      "phases: must be a non-empty list",
    ]);
  });

  test("a phase name that is not a slug", () => {
    const text =
      "```wip-flow\nphases:\n  - name: Do It\n    next: [done]\n  - name: done\n    kind: terminal\n```\n";
    expect(parseFlow("x", text).problems).toEqual([
      "phases[0]: name 'Do It' must match ^[a-z][a-z0-9_-]*$",
    ]);
  });

  test("a flow file name that is not a slug", () => {
    expect(parseFlow("My Flow", minimalFlow()).problems[0]).toContain(
      "flow name 'My Flow' must match",
    );
  });

  test("links without url, with unknown keys or empty pattern", () => {
    const text = [
      "```wip-flow",
      "links:",
      "  - pattern: x",
      "  - pattern: ''",
      "    url: https://a.example",
      "    label: A",
      "phases:",
      "  - name: todo",
      "    next: [done]",
      "  - name: done",
      "    kind: terminal",
      "```",
    ].join("\n");
    expect(parseFlow("x", text).problems).toEqual([
      "links[0]: missing url",
      "links[1]: unknown key 'label'",
      "links[1].pattern: must be a non-empty string",
    ]);
  });

  test("an enum with no values or repeated values", () => {
    const text =
      "```wip-flow\nfields:\n  a: enum()\n  b: enum(x|x)\nphases:\n  - name: done\n    kind: terminal\n```\n";
    expect(parseFlow("x", text).problems).toEqual([
      "fields.a: enum() needs at least one value",
      "fields.b: enum values repeat",
    ]);
  });
});

describe("hash of the block (F-FLU-11)", () => {
  test("is 16 hex characters of the block, not of the whole file", () => {
    const { flow, block } = flowOf("valid");
    expect(flow?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(flow?.hash).toBe(blockHash(block ?? ""));
    const prose = fixture("flows", "valid").replace("Use `thinker`", "Prefer `thinker`");
    expect(flowOf("valid", prose).flow?.hash).toBe(flow?.hash ?? "");
  });

  test("changes when the block changes", () => {
    const changed = fixture("flows", "valid").replace("stage: closed", "stage: archived");
    expect(flowOf("valid", changed).flow?.hash).not.toBe(flowOf("valid").flow?.hash ?? "");
  });

  test("CRLF line endings give the same flow and hash", () => {
    const crlf = fixture("flows", "valid").replace(/\n/g, "\r\n");
    expect(flowOf("valid", crlf).flow).toEqual(flowOf("valid").flow);
  });
});

describe("sections for subagents (F-FLU-14)", () => {
  test("## Subagents and ### <phase> are extracted as text", () => {
    const flow = flowOf("valid").flow;
    expect(flow?.subagents).toBe("Use `thinker` to plan and `efficient` to execute.");
    expect(flow?.phaseNotes).toEqual({
      plan: "Write plan.md in the artifact directory.",
      execute: "Change the project as the plan says.",
    });
  });

  test("a flow without them has null and an empty map", () => {
    const flow = flowOf("minimal").flow;
    expect(flow?.subagents).toBeNull();
    expect(flow?.phaseNotes).toEqual({});
  });

  test("headings inside fenced code are not sections", () => {
    const text = "## Subagents\n\n```md\n## Other\n### todo\n```\n\nafter\n\n## Next\n";
    const sections = extractSections(text, ["todo"]);
    expect(sections.subagents).toBe("```md\n## Other\n### todo\n```\n\nafter");
    expect(sections.phaseNotes).toEqual({});
  });

  test("a ### section runs until the next heading of level 3 or less", () => {
    const text = "### todo\nline 1\n#### detail\nline 2\n### done\nend\n";
    expect(extractSections(text, ["todo", "done"]).phaseNotes).toEqual({
      todo: "line 1\n#### detail\nline 2",
      done: "end",
    });
  });
});
