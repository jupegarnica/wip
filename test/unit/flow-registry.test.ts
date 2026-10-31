import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ICommandSpec } from "../../src/commands/help.ts";
import type { IHandler } from "../../src/context.ts";
import { openDb } from "../../src/db.ts";
import { findRoot } from "../../src/env.ts";
import { EXIT, WipError } from "../../src/errors.ts";
import { checkItemId, flowFiles, getFlow, loadFlows } from "../../src/flow/registry.ts";
import {
  asFlowSkill,
  fixture,
  flowFile,
  minimalFlow,
  putFlow,
  putItems,
  skillsDir,
} from "../helpers/defs.ts";
import { type IProject, makeProject } from "../helpers/project.ts";

let p: IProject | null = null;

afterEach(() => {
  p?.cleanup();
  p = null;
});

function project(name: string): IProject {
  p = makeProject(name);
  return p;
}

function load(proj: IProject, write = false) {
  const db = openDb(proj.dbPath);
  try {
    if (write) db.exec("BEGIN IMMEDIATE");
    const set = loadFlows(findRoot(proj.dir, {}), db, { write });
    if (write) db.exec("COMMIT");
    return set;
  } finally {
    db.close();
  }
}

function storedFlows(
  proj: IProject,
): { name: string; hash: string; loaded_at: string; json: string }[] {
  const db = proj.db();
  try {
    return db.query("SELECT name, hash, loaded_at, json FROM flows ORDER BY name").all() as {
      name: string;
      hash: string;
      loaded_at: string;
      json: string;
    }[];
  } finally {
    db.close();
  }
}

function code(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof WipError ? err.code : -1;
  }
}

// A write command that loads one flow the way H3's `wip phase` will.
const probeFlow: { spec: ICommandSpec; handler: IHandler } = {
  spec: {
    name: "probe-flow",
    summary: "test probe",
    usage: ["wip probe-flow <flow>"],
    options: [],
    flags: [],
  },
  handler: {
    db: "write",
    run: (ctx, args) => {
      const set = loadFlows(ctx.root, ctx.db, { write: true });
      ctx.result.warnings.push(...set.warnings);
      const flow = getFlow(set, args.pos[0] ?? "");
      ctx.result.data = { hash: flow.hash, phases: flow.phases.map((ph) => ph.name) };
    },
  },
};

const probe = (proj: IProject, flow: string) =>
  JSON.parse(proj.wip(["probe-flow", flow, "--json"], { extra: [probeFlow] }).stdout) as {
    ok: boolean;
    warnings: { code: string; using: string | null }[];
    data: { hash: string; phases: string[]; code?: number };
  };

describe("discovery (F-FLU-03, F-FLU-13)", () => {
  test("flows are the skills wip-flow-<name>/SKILL.md; other skills, bare files and examples aside", () => {
    const proj = project("discover");
    const skills = skillsDir(proj.dir);
    expect(flowFiles(skills)).toEqual([]);
    putFlow(proj.dir, "minimal", fixture("flows", "minimal"));
    mkdirSync(join(skills, "wip-coordinate"), { recursive: true });
    writeFileSync(join(skills, "wip-coordinate", "SKILL.md"), asFlowSkill("x", minimalFlow()));
    mkdirSync(join(skills, "wip-new-flow"), { recursive: true });
    writeFileSync(join(skills, "wip-new-flow", "example.md"), asFlowSkill("review", minimalFlow()));
    mkdirSync(join(skills, "wip-flow-"), { recursive: true });
    writeFileSync(join(skills, "wip-flow-", "SKILL.md"), minimalFlow());
    mkdirSync(join(skills, "wip-flow-empty"), { recursive: true });
    writeFileSync(join(skills, "wip-flow-notes.md"), minimalFlow());
    expect(flowFiles(skills).map((f) => f.name)).toEqual(["minimal"]);
    expect([...load(proj).entries.keys()]).toEqual(["minimal"]);
  });

  test("a new flow appears as soon as its file exists", () => {
    const proj = project("discover-new");
    putFlow(proj.dir, "minimal", fixture("flows", "minimal"));
    expect(probe(proj, "minimal").ok).toBe(true);
    expect(probe(proj, "review").data.code).toBe(EXIT.NOT_FOUND);
    putFlow(proj.dir, "review", minimalFlow());
    expect(probe(proj, "review").data.phases).toEqual(["todo", "done"]);
  });
});

describe("last valid version in flows (F-FLU-11)", () => {
  test("a write command records each valid flow with its hash and block", () => {
    const proj = project("record");
    putFlow(proj.dir, "minimal", fixture("flows", "minimal"));
    const set = load(proj, true);
    const [row] = storedFlows(proj);
    expect(row?.name).toBe("minimal");
    expect(row?.hash).toBe(set.entries.get("minimal")?.flow?.hash ?? "");
    const json = JSON.parse(row?.json ?? "{}") as { block: string; flow: { phases: unknown[] } };
    expect(json.block).toContain("name: todo");
    expect(json.flow.phases).toHaveLength(2);
  });

  test("a reader never writes flows", () => {
    const proj = project("record-read");
    putFlow(proj.dir, "minimal", fixture("flows", "minimal"));
    load(proj, false);
    expect(storedFlows(proj)).toEqual([]);
  });

  test("an unchanged block is not rewritten", () => {
    const proj = project("record-same");
    putFlow(proj.dir, "minimal", fixture("flows", "minimal"));
    load(proj, true);
    const before = storedFlows(proj);
    putFlow(proj.dir, "minimal", `${fixture("flows", "minimal")}\nMore prose.\n`);
    load(proj, true);
    expect(storedFlows(proj)).toEqual(before);
  });
});

describe("safe activation (F-NEW-04)", () => {
  test("a broken edit after a valid version loads the stored one with a warning", () => {
    const proj = project("fallback");
    putFlow(proj.dir, "minimal", fixture("flows", "minimal"));
    const valid = probe(proj, "minimal");
    expect(valid.warnings).toEqual([]);
    putFlow(proj.dir, "minimal", fixture("flows", "two-terminals"));
    const broken = probe(proj, "minimal");
    expect(broken.ok).toBe(true);
    expect(broken.data).toEqual({ hash: valid.data.hash, phases: ["todo", "done"] });
    expect(broken.warnings.map((w) => [w.code, w.using])).toEqual([
      ["flow_invalid", valid.data.hash],
    ]);
    expect(storedFlows(proj)[0]?.hash).toBe(valid.data.hash);
  });

  test("the stored version is in use and flow lint still fails on the file", () => {
    const proj = project("fallback-lint");
    putFlow(proj.dir, "minimal", fixture("flows", "minimal"));
    probe(proj, "minimal");
    putFlow(proj.dir, "minimal", fixture("flows", "bad-yaml"));
    const env = proj.json(["flow", "lint", "minimal"]);
    expect(env.ok).toBe(false);
    const [entry] = (env.data as { flows: { using: string; ok: boolean }[] }).flows;
    expect(entry).toMatchObject({ using: "stored", ok: false });
    expect((env.warnings as { code: string }[])[0]?.code).toBe("flow_invalid");
  });

  test("a broken file with no previous version makes commands on it exit 1", () => {
    const proj = project("fallback-none");
    putFlow(proj.dir, "minimal", fixture("flows", "no-terminal"));
    const out = proj.wip(["probe-flow", "minimal"], { extra: [probeFlow] });
    expect(out.code).toBe(EXIT.FINDINGS);
    expect(out.stderr).toContain("flow minimal does not pass lint and has no valid version");
    expect(code(() => getFlow(load(proj), "minimal"))).toBe(EXIT.FINDINGS);
  });

  test("an unknown flow is exit 4", () => {
    const proj = project("unknown");
    expect(code(() => getFlow(load(proj), "ghost"))).toBe(EXIT.NOT_FOUND);
  });

  test("fixing the file records the new version and the warning goes away", () => {
    const proj = project("fallback-fix");
    putFlow(proj.dir, "minimal", fixture("flows", "minimal"));
    const first = probe(proj, "minimal");
    putFlow(proj.dir, "minimal", fixture("flows", "unreachable"));
    expect(probe(proj, "minimal").warnings).toHaveLength(1);
    const fixed = fixture("flows", "minimal").replace(
      "next: [done]",
      "next: [done]\n    gate: ask",
    );
    putFlow(proj.dir, "minimal", fixed);
    const after = probe(proj, "minimal");
    expect(after.warnings).toEqual([]);
    expect(after.data.hash).not.toBe(first.data.hash);
    expect(storedFlows(proj)[0]?.hash).toBe(after.data.hash);
  });

  test("an open item in a phase the edit removes stays on the stored version, which has it", () => {
    const proj = project("fallback-items");
    putFlow(
      proj.dir,
      "work",
      minimalFlow().replace("next: [done]", "next: [review]\n  - name: review\n    next: [done]"),
    );
    expect(probe(proj, "work").data.phases).toEqual(["todo", "review", "done"]);
    putItems(proj.dbPath, "work", [{ id: "T1", phase: "review" }]);
    putFlow(proj.dir, "work", minimalFlow());
    const out = probe(proj, "work");
    expect(out.data.phases).toEqual(["todo", "review", "done"]);
    expect(out.warnings.map((w) => w.code)).toEqual(["flow_invalid"]);
    const entry = load(proj).entries.get("work");
    expect(entry?.problems).toEqual(["item T1 is in phase review, which the flow no longer has"]);
  });

  test("a deleted file with open items keeps its stored version; without items it is gone", () => {
    const proj = project("fallback-missing");
    putFlow(proj.dir, "minimal", fixture("flows", "minimal"));
    putFlow(proj.dir, "other", minimalFlow());
    probe(proj, "minimal");
    putItems(proj.dbPath, "minimal", [{ id: "T1", phase: "todo" }]);
    rmSync(flowFile(proj.dir, "minimal"));
    rmSync(flowFile(proj.dir, "other"));
    const set = load(proj);
    expect([...set.entries.keys()]).toEqual(["minimal"]);
    expect(set.entries.get("minimal")?.source).toBe("stored");
    expect(set.warnings.map((w) => w.code)).toEqual(["flow_missing"]);
  });
});

describe("item ID (F-EST-19, F-FLU-02)", () => {
  const flowWith = (idPattern: string | null) => {
    const proj = project("ids");
    const text = idPattern
      ? minimalFlow().replace("phases:", `id_pattern: "${idPattern}"\nphases:`)
      : minimalFlow();
    putFlow(proj.dir, "f", text);
    return getFlow(load(proj), "f");
  };

  test("without id_pattern the safe default applies and rejects paths", () => {
    const flow = flowWith(null);
    for (const ok of ["T1", "abc-1.2_x", "A", "x".repeat(64)])
      expect(code(() => checkItemId(flow, ok))).toBeNull();
    for (const bad of ["../x", "a/b", "a\\b", ".hidden", "", "-x", "x".repeat(65), "a b"]) {
      expect(code(() => checkItemId(flow, bad))).toBe(EXIT.USAGE);
    }
  });

  test("id_pattern validates the whole ID and never infers a flow", () => {
    const flow = flowWith("T[0-9]+");
    expect(code(() => checkItemId(flow, "T12"))).toBeNull();
    expect(code(() => checkItemId(flow, "X1"))).toBe(EXIT.USAGE);
    expect(code(() => checkItemId(flow, "T12x"))).toBe(EXIT.USAGE);
  });

  test("a permissive id_pattern does not let a path through", () => {
    expect(code(() => checkItemId(flowWith(".*"), "../x"))).toBe(EXIT.USAGE);
  });
});
