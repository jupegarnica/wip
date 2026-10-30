import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { lintAgentRef, listAgents, modelsUnset, readAgent } from "../../src/agents.ts";
import { agentsDir, putAgent } from "../helpers/defs.ts";
import { scratch } from "../helpers/project.ts";

let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function read(name: string) {
  dir = scratch("agents");
  return readAgent(putAgent(dir, name));
}

describe("agent frontmatter", () => {
  test("a generic agent with model and unknown runtime keys has no problems", () => {
    const a = read("thinker");
    expect(a.problems).toEqual([]);
    expect(a.name).toBe("thinker");
    expect(a.description).toBe("Plans and decides");
    expect(a.generic).toBe(true);
    expect(a.model).toBe("some-model");
    expect(a.frontmatter?.color).toBe("purple");
  });

  test("a generic agent without model reads model as null", () => {
    const a = read("efficient");
    expect(a.problems).toEqual([]);
    expect(a.generic).toBe(true);
    expect(a.model).toBeNull();
  });

  test("an agent without wip: generic is not generic", () => {
    expect(read("custom").generic).toBe(false);
  });

  test("without name it is a problem", () => {
    expect(read("no-name").problems).toEqual(["frontmatter has no name"]);
  });

  test("a name different from the file name is a problem", () => {
    expect(read("other-name").problems).toEqual([
      "frontmatter name 'someone-else' differs from the file name 'other-name'",
    ]);
  });

  test("without description it is a problem", () => {
    expect(read("no-description").problems).toEqual(["frontmatter has no description"]);
  });

  test("YAML that does not parse is a problem and nothing is read", () => {
    const a = read("broken");
    expect(a.problems).toHaveLength(1);
    expect(a.problems[0]).toStartWith("invalid frontmatter:");
    expect(a.frontmatter).toBeNull();
    expect(a.generic).toBe(false);
  });

  test("a file without frontmatter is a problem", () => {
    expect(read("plain").problems).toEqual(["no frontmatter (--- block at the top)"]);
  });

  test("a frontmatter that is a list, not a mapping, is a problem", () => {
    dir = scratch("agents");
    const a = readAgent(putAgent(dir, "list", "---\n- a\n- b\n---\n"));
    expect(a.problems[0]).toContain("not a YAML mapping");
  });

  test("CRLF line endings parse the same", () => {
    dir = scratch("agents");
    const text =
      "---\r\nname: crlf\r\ndescription: Windows file\r\nwip: generic\r\n---\r\nBody\r\n";
    const a = readAgent(putAgent(dir, "crlf", text));
    expect(a.problems).toEqual([]);
    expect(a.generic).toBe(true);
  });
});

describe("agent referenced by a flow", () => {
  test("a missing file is a problem", () => {
    dir = scratch("agents");
    expect(lintAgentRef(agentsDir(dir), "ghost")).toEqual([
      "no agent file .agents/agents/ghost.md",
    ]);
  });

  test("an existing valid agent has no problems", () => {
    dir = scratch("agents");
    putAgent(dir, "thinker");
    expect(lintAgentRef(agentsDir(dir), "thinker")).toEqual([]);
  });
});

describe("models_unset", () => {
  test("lists generic agents without model in alphabetical order", () => {
    dir = scratch("agents");
    for (const name of ["thinker", "efficient", "custom", "broken", "plain"]) putAgent(dir, name);
    putAgent(dir, "wise", "---\nname: wise\ndescription: Careful\nwip: generic\n---\n");
    putAgent(dir, "fast", "---\nname: fast\ndescription: Quick\nwip: generic\nmodel: ''\n---\n");
    expect(modelsUnset(agentsDir(dir))).toEqual(["efficient", "fast", "wise"]);
  });

  test("no agents directory means no agents", () => {
    dir = scratch("agents");
    expect(listAgents(join(dir, "nope"))).toEqual([]);
    expect(modelsUnset(join(dir, "nope"))).toEqual([]);
  });

  test("listAgents reads every .md sorted by name", () => {
    dir = scratch("agents");
    putAgent(dir, "thinker");
    putAgent(dir, "custom");
    expect(listAgents(agentsDir(dir)).map((a) => a.name)).toEqual(["custom", "thinker"]);
  });
});
