import { describe, expect, test } from "bun:test";
import { EXIT } from "../../src/errors.ts";
import { itemInPlan, itemsProject, ok, T0, tick, useProject, wipJson } from "../helpers/items.ts";

const ctx = useProject();

function fields(body: { item: Record<string, unknown> | null }): Record<string, unknown> {
  return body.item?.fields as Record<string, unknown>;
}

describe("wip set (F-EST-10)", () => {
  test("string, enum and title; title is a column", () => {
    const p = ctx.set(itemsProject("set-string"));
    itemInPlan(p);
    const body = ok(p, ["set", "T1", "title=Add a README", "size=m"]);
    expect(body.item).toMatchObject({ title: "Add a README" });
    expect(fields(body)).toEqual({ size: "m" });
    expect(body.events[0]).toMatchObject({
      kind: "set",
      text: "set title=Add a README · size=m",
      data: { set: { title: "Add a README", size: "m" } },
    });
  });

  test("int: a number, +N and -N on the stored value", () => {
    const p = ctx.set(itemsProject("set-int"));
    itemInPlan(p);
    expect(fields(ok(p, ["set", "T1", "attempts=+1"]))).toEqual({ attempts: 1 });
    expect(fields(ok(p, ["set", "T1", "attempts=+2"]))).toEqual({ attempts: 3 });
    expect(fields(ok(p, ["set", "T1", "attempts=-1"]))).toEqual({ attempts: 2 });
    expect(fields(ok(p, ["set", "T1", "attempts=7"]))).toEqual({ attempts: 7 });
    expect(p.wip(["set", "T1", "attempts=many"]).code).toBe(EXIT.USAGE);
  });

  test("list: a,b replaces, +a adds without repeating, -a removes, none empties", () => {
    const p = ctx.set(itemsProject("set-list"));
    itemInPlan(p);
    expect(fields(ok(p, ["set", "T1", "tags=a,b"]))).toEqual({ tags: ["a", "b"] });
    expect(fields(ok(p, ["set", "T1", "tags=+b,c"]))).toEqual({ tags: ["a", "b", "c"] });
    expect(fields(ok(p, ["set", "T1", "tags=-a"]))).toEqual({ tags: ["b", "c"] });
    expect(fields(ok(p, ["set", "T1", "tags=none"]))).toEqual({ tags: [] });
  });

  test("ts: now takes the CLI's clock and none clears it; anything else is a usage error", () => {
    const p = ctx.set(itemsProject("set-ts"));
    itemInPlan(p);
    tick(42);
    expect(fields(ok(p, ["set", "T1", "due=now"]))).toEqual({ due: "2026-10-30T10:00:42Z" });
    expect(fields(ok(p, ["set", "T1", "due=none"]))).toEqual({ due: null });
    expect(p.wip(["set", "T1", `due=${T0}`]).code).toBe(EXIT.USAGE);
  });

  test("enum outside its values, an unknown key, a repeated key or no key=value: usage errors", () => {
    const p = ctx.set(itemsProject("set-errors"));
    itemInPlan(p);
    expect(p.wip(["set", "T1", "size=xl"]).code).toBe(EXIT.USAGE);
    const unknown = wipJson(p, ["set", "T1", "colour=red"]);
    expect(unknown.code).toBe(EXIT.USAGE);
    expect(unknown.body.message).toContain("fields: title, attempts, tags, due, size");
    expect(p.wip(["set", "T1", "size=s", "size=m"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["set", "T1", "size"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["set", "T1"]).code).toBe(EXIT.USAGE);
  });

  test("an unknown item is not found and an archived one is rejected", () => {
    const p = ctx.set(itemsProject("set-missing"));
    itemInPlan(p);
    expect(p.wip(["set", "T9", "size=s"]).code).toBe(EXIT.NOT_FOUND);
    ok(p, ["archive", "T1"]);
    expect(p.wip(["set", "T1", "size=s"]).code).toBe(EXIT.REJECTED);
  });

  test("a failing pair leaves the earlier pairs unwritten", () => {
    const p = ctx.set(itemsProject("set-atomic"));
    itemInPlan(p);
    expect(p.wip(["set", "T1", "size=s", "attempts=x"]).code).toBe(EXIT.USAGE);
    expect(fields(ok(p, ["show", "T1"]))).toEqual({});
  });
});
