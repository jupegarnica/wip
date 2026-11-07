import type { TDatabase } from "./db.ts";
import { rejected } from "./errors.ts";
import type { IFlow } from "./flow/parse.ts";
import type { IFlowSet } from "./flow/registry.ts";
import {
  getItem,
  type IItemRow,
  isTerminal,
  openGates,
  phaseOf,
  runningRuns,
  terminalPhases,
  WAITING_RE,
  waitingAgents,
} from "./items.ts";

export type TInvariant = "I1" | "I2f" | "I2" | "I3" | "I4";

export interface IFinding {
  code: TInvariant;
  item: string;
  text: string;
}

/** I1, I2f, I2, I3 and I4 of one item against its flow (`null`: the flow has no valid version). */
export function itemFindings(db: TDatabase, item: IItemRow, flow: IFlow | null): IFinding[] {
  const out: IFinding[] = [];
  const add = (code: TInvariant, text: string): void => {
    out.push({ code, item: item.id, text });
  };
  if (!flow) add("I1", `flow ${item.flow} has no valid version`);
  else if (!phaseOf(flow, item.phase)) {
    add("I1", `phase ${item.phase} is not in flow ${flow.name}`);
  }
  const waiting = item.waiting_on ?? "";
  if (!WAITING_RE.test(waiting)) {
    add("I2f", `waiting_on '${waiting}' is not user | external | none | agent:<a>[,<b>]`);
  }
  const running = runningRuns(db, item.id);
  const agents = waitingAgents(item.waiting_on);
  for (const name of agents) {
    if (!running.some((r) => r.agent === name)) {
      add("I2", `waiting_on agent:${name} without a running run of ${name}`);
    }
  }
  for (const name of new Set(running.map((r) => r.agent))) {
    if (!agents.includes(name))
      add("I2", `a run of ${name} is running but waiting_on is ${waiting}`);
  }
  if (waiting === "user" && !(item.next ?? "").trim() && openGates(db, item.id).length === 0) {
    add("I3", "waiting_on user without an open gate nor a next step (--next or gate open)");
  }
  if (waiting === "none" && item.status !== "archived" && flow) {
    if (!isTerminal(flow, item.phase)) {
      const terminals = terminalPhases(flow).map((p) => p.name);
      add("I4", `waiting_on none outside a terminal phase (${terminals.join(", ") || "none"})`);
    }
  }
  return out;
}

/** Rejects the command (exit 3, the transaction rolls back) when the item it leaves breaks an invariant. */
export function assertItem(db: TDatabase, id: string, flow: IFlow): void {
  const findings = itemFindings(db, getItem(db, id), flow);
  if (findings.length > 0) {
    throw rejected(findings.map((f) => `${f.code} · ${f.text}`).join("; "));
  }
}

export function checkFindings(db: TDatabase | null, flows: IFlowSet, id?: string): IFinding[] {
  const one = id === undefined ? null : getItem(db, id);
  if (!db) return [];
  const items =
    one !== null
      ? [one]
      : (db.query("SELECT * FROM items WHERE status = 'open' ORDER BY id").all() as IItemRow[]);
  return items
    .filter((item) => !flows.disabled.has(item.flow))
    .flatMap((item) => itemFindings(db, item, flows.entries.get(item.flow)?.flow ?? null));
}
