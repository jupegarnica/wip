import { type IArgs, need } from "../args.ts";
import { iso } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import { usage } from "../errors.ts";
import type { IFieldDef } from "../flow/parse.ts";
import { assertItem } from "../invariants.ts";
import { addEvent, getItem, itemFields, openItem, publicItem, updateItem } from "../items.ts";

const NONE = "none";
/** `title` is an item column: every flow accepts it as a string. */
const TITLE: IFieldDef = { type: "string" };

function splitList(text: string): string[] {
  return text
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** The typed value of one `key=value`; `current` is the stored value, for `+N` and list edits. */
export function coerce(key: string, def: IFieldDef, value: string, current: unknown): unknown {
  if (value === NONE) return def.type === "list" ? [] : null;
  switch (def.type) {
    case "string":
      return value;
    case "int": {
      const rel = value.match(/^([+-])(\d+)$/);
      if (rel) {
        const base = typeof current === "number" ? current : 0;
        return base + (rel[1] === "+" ? 1 : -1) * Number(rel[2]);
      }
      if (!/^-?\d+$/.test(value)) throw usage(`${key}: an integer, +N or -N`);
      return Number(value);
    }
    case "ts":
      if (value !== "now") throw usage(`${key}: only now or none (the CLI sets the time)`);
      return iso();
    case "list": {
      const list = Array.isArray(current) ? (current as string[]) : [];
      if (value.startsWith("+")) return [...new Set([...list, ...splitList(value.slice(1))])];
      if (value.startsWith("-")) {
        const drop = new Set(splitList(value.slice(1)));
        return list.filter((v) => !drop.has(v));
      }
      return [...new Set(splitList(value))];
    }
    case "enum":
      if (!(def.values ?? []).includes(value)) {
        throw usage(`${key}: one of ${(def.values ?? []).join(" | ")}`);
      }
      return value;
  }
}

function show(value: unknown): string {
  if (Array.isArray(value)) return value.join(",");
  return value === null || value === undefined ? NONE : String(value);
}

function run(ctx: ICtx, args: IArgs): void {
  const id = need(args.pos[0], "the item ID");
  const pairs = args.pos.slice(1);
  if (pairs.length === 0) throw usage("missing at least one key=value");
  const { item, flow } = openItem(ctx, id);
  const fields = itemFields(item);
  const changes: Record<string, unknown> = {};
  let title: unknown = item.title;
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw usage(`'${pair}' is not key=value`);
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key in changes) throw usage(`key given twice: ${key}`);
    const def = key === "title" ? TITLE : flow.fields[key];
    if (!def) {
      const known = ["title", ...Object.keys(flow.fields).filter((k) => k !== "title")];
      throw usage(`unknown field of ${flow.name}: ${key} (fields: ${known.join(", ")})`);
    }
    const v = coerce(key, def, value, key === "title" ? title : fields[key]);
    if (key === "title") title = v;
    else fields[key] = v;
    changes[key] = v;
  }
  updateItem(ctx.db, id, { title: title as string | null, fields: JSON.stringify(fields) });
  const text = Object.entries(changes)
    .map(([k, v]) => `${k}=${show(v)}`)
    .join(" · ");
  ctx.result.events.push(
    addEvent(ctx.db, {
      itemId: id,
      phase: item.phase,
      kind: "set",
      text: `set ${text}`,
      data: { set: changes },
    }),
  );
  assertItem(ctx.db, id, flow);
  ctx.result.item = publicItem(getItem(ctx.db, id));
  ctx.result.lines.push(`${id} · ${text}`);
}

export const setCmd: IHandler = { db: "write", run };
