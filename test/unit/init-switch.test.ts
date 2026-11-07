import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEMPLATES } from "../../src/embedded/templates.ts";
import { definitionKeys, leftBehind, uncoveredFlows } from "../../src/init/switch.ts";
import { scratch } from "../helpers/project.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = scratch("init-switch");
  dirs.push(d);
  return d;
}

function put(root: string, rel: string, text = "x\n"): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe("definitionKeys", () => {
  test("lists agent files and skill folders with a SKILL.md, sorted, relative", () => {
    const root = tmp();
    put(root, "agents/zed.md");
    put(root, "agents/alpha.md");
    put(root, "agents/notes.txt");
    put(root, "skills/wip-flow-zzz/SKILL.md");
    put(root, "skills/no-skill/other.md");
    expect(definitionKeys(root)).toEqual([
      "agents/alpha.md",
      "agents/zed.md",
      "skills/wip-flow-zzz/SKILL.md",
    ]);
    expect(definitionKeys(join(root, "absent"))).toEqual([]);
  });
});

describe("leftBehind", () => {
  test("lists custom agents and skills the new folder lacks, never wip's templates", () => {
    const old = tmp();
    const next = tmp();
    for (const key of Object.keys(TEMPLATES)) put(old, key, TEMPLATES[key] as string);
    put(old, "agents/mine.md");
    put(old, "skills/wip-flow-zzz/SKILL.md");
    put(old, "agents/shared.md");
    put(next, "agents/shared.md");
    expect(leftBehind(old, next)).toEqual(["agents/mine.md", "skills/wip-flow-zzz/SKILL.md"]);
  });

  test("an empty or absent old folder leaves nothing behind", () => {
    expect(leftBehind(join(tmp(), "absent"), tmp())).toEqual([]);
  });
});

describe("uncoveredFlows", () => {
  test("a flow is covered by its skill in the new folder or by a template; the rest name their first item", () => {
    const next = tmp();
    put(next, "skills/wip-flow-mine/SKILL.md");
    const live = new Map([
      ["tasks", [{ id: "T1", phase: "todo" }]],
      ["mine", [{ id: "M1", phase: "todo" }]],
      [
        "zzz",
        [
          { id: "Z1", phase: "todo" },
          { id: "Z2", phase: "todo" },
        ],
      ],
      ["empty", []],
    ]);
    expect(uncoveredFlows(live, next)).toEqual([{ flow: "zzz", id: "Z1", more: 1 }]);
    expect(uncoveredFlows(new Map(), next)).toEqual([]);
  });
});
