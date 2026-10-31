import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "../../src/db.ts";

export const FIXTURES = join(import.meta.dir, "..", "fixtures");

export function fixture(kind: "flows" | "agents", name: string): string {
  return readFileSync(join(FIXTURES, kind, `${name}.md`), "utf8");
}

export function skillsDir(project: string, defs = ".agents"): string {
  return join(project, defs, "skills");
}

export function flowFile(project: string, name: string, defs = ".agents"): string {
  return join(skillsDir(project, defs), `wip-flow-${name}`, "SKILL.md");
}

export function agentsDir(project: string, defs = ".agents"): string {
  return join(project, defs, "agents");
}

/** The fixtures are bare flows; a flow skill needs its frontmatter, added here unless the text has one. */
export function asFlowSkill(name: string, text: string): string {
  if (text.startsWith("---")) return text;
  return `---\nname: wip-flow-${name}\ndescription: "Flow ${name} of the tests."\n---\n\n${text}`;
}

export function putFlow(project: string, name: string, text: string, defs = ".agents"): string {
  const file = flowFile(project, name, defs);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, asFlowSkill(name, text));
  return file;
}

export function putAgent(
  project: string,
  name: string,
  text: string = fixture("agents", name),
  defs = ".agents",
): string {
  mkdirSync(agentsDir(project, defs), { recursive: true });
  const file = join(agentsDir(project, defs), `${name}.md`);
  writeFileSync(file, text);
  return file;
}

/** The two agents the `valid` fixture names. */
export function putValidAgents(project: string): void {
  putAgent(project, "thinker");
  putAgent(project, "efficient");
}

export function minimalFlow(phaseKeys = ""): string {
  return [
    "```wip-flow",
    "phases:",
    "  - name: todo",
    "    next: [done]",
    ...(phaseKeys ? phaseKeys.split("\n").map((l) => `    ${l}`) : []),
    "  - name: done",
    "    kind: terminal",
    "```",
    "",
  ].join("\n");
}

/** Inserts open items straight into the database, as H3's `wip phase` will. */
export function putItems(
  dbPath: string,
  flow: string,
  items: { id: string; phase: string }[],
): void {
  const db = openDb(dbPath);
  try {
    const ts = "2026-10-30T10:00:00Z";
    for (const item of items) {
      db.query(
        "INSERT INTO items (id, flow, phase, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(item.id, flow, item.phase, ts, ts);
    }
  } finally {
    db.close();
  }
}
