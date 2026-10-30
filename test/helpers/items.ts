import { afterEach } from "bun:test";
import { setClockForTests } from "../../src/clock.ts";
import { fixture, putAgent, putFlow } from "./defs.ts";
import { type IProject, makeProject } from "./project.ts";

export const T0 = "2026-10-30T10:00:00Z";

export function agentText(name: string): string {
  return `---\nname: ${name}\ndescription: test agent ${name}\nrole: subagent\n---\n\nBody.\n`;
}

/**
 * A project with the `valid` flow (intake → plan → execute → verify → done, id_pattern T[0-9]+) and the
 * agents thinker, efficient and fast. The clock starts pinned at T0.
 */
export function itemsProject(name: string): IProject {
  const p = makeProject(name);
  putFlow(p.dir, "valid", fixture("flows", "valid"));
  putAgent(p.dir, "thinker");
  putAgent(p.dir, "efficient");
  putAgent(p.dir, "fast", agentText("fast"));
  setClockForTests(new Date(T0));
  return p;
}

/** Moves the pinned clock forward by `seconds`. */
export function tick(seconds: number, from: string = T0): void {
  setClockForTests(new Date(new Date(from).getTime() + seconds * 1000));
}

export function at(iso: string): void {
  setClockForTests(new Date(iso));
}

/** One project per test, cleaned after it. */
export function useProject(): { get: () => IProject; set: (p: IProject) => IProject } {
  let current: IProject | null = null;
  afterEach(() => {
    current?.cleanup();
    current = null;
  });
  return {
    get: () => {
      if (!current) throw new Error("no project in this test");
      return current;
    },
    set: (p) => {
      current = p;
      return p;
    },
  };
}

export interface IJson {
  ok: boolean;
  item: Record<string, unknown> | null;
  events: Record<string, unknown>[];
  warnings: { code: string; message: string; [k: string]: unknown }[];
  message: string | null;
  data: Record<string, unknown> | null;
}

/** Runs `wip … --json` and returns the exit code with the parsed envelope. */
export function wipJson(p: IProject, argv: readonly string[]): { code: number; body: IJson } {
  const out = p.wip([...argv, "--json"]);
  return { code: out.code, body: JSON.parse(out.stdout) as IJson };
}

/** Runs a command that must succeed and returns its envelope. */
export function ok(p: IProject, argv: readonly string[]): IJson {
  const { code, body } = wipJson(p, argv);
  if (code !== 0) throw new Error(`wip ${argv.join(" ")} → ${code}: ${body.message}`);
  return body;
}

/** A list under `data` (`items`, `agent_runs`, `gates`…), empty when it is missing. */
export function rows(body: IJson, key: string): Record<string, unknown>[] {
  const value = body.data?.[key];
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** The item `T1` in `plan` with no agent running: intake → plan. */
export function itemInPlan(p: IProject, id = "T1"): void {
  ok(p, ["phase", id, "intake", "--flow", "valid"]);
  ok(p, ["phase", id, "plan"]);
}
