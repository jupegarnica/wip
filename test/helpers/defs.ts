import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/db.ts";

export const FIXTURES = join(import.meta.dir, "..", "fixtures");

export function fixture(kind: "flows" | "agents", name: string): string {
  return readFileSync(join(FIXTURES, kind, `${name}.md`), "utf8");
}

export function flowsDir(project: string): string {
  return join(project, ".agents", "flows");
}

export function agentsDir(project: string): string {
  return join(project, ".agents", "agents");
}

export function putFlow(project: string, name: string, text: string): string {
  mkdirSync(flowsDir(project), { recursive: true });
  const file = join(flowsDir(project), `${name}.md`);
  writeFileSync(file, text);
  return file;
}

export function putAgent(
  project: string,
  name: string,
  text: string = fixture("agents", name),
): string {
  mkdirSync(agentsDir(project), { recursive: true });
  const file = join(agentsDir(project), `${name}.md`);
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
