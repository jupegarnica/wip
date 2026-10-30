import type { TDatabase } from "./db.ts";
import type { IFlow } from "./flow/parse.ts";
import { itemFindings, type TInvariant } from "./invariants.ts";
import { type IItemRow, openGates } from "./items.ts";

export interface ISignals {
  /** The user has something to do on this item now: it waits on them with an open gate or a next step. */
  attention: boolean;
  /** Invariants the stored item breaks, in the order `wip check` reports them. */
  incoherent: TInvariant[];
}

export function itemSignals(db: TDatabase, item: IItemRow, flow: IFlow | null): ISignals {
  const asks = openGates(db, item.id).length > 0 || (item.next ?? "").trim() !== "";
  return {
    attention: item.status === "open" && item.waiting_on === "user" && asks,
    incoherent: [...new Set(itemFindings(db, item, flow).map((f) => f.code))],
  };
}
