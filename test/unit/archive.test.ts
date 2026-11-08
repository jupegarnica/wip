import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/errors.ts";
import { itemInPlan, itemsProject, ok, rows, tick, useProject, wipJson } from "../helpers/items.ts";
import { fakeTrash, files, fixture, KEPT, withTrash } from "../helpers/prune-fixture.ts";

const ctx = useProject();

describe("wip archive (F-ARC-01)", () => {
  test("an idle item is archived, waits on none and leaves the open list", () => {
    const p = ctx.set(itemsProject("archive-ok"));
    itemInPlan(p);
    const body = ok(p, ["archive", "T1"]);
    expect(body.item).toMatchObject({
      status: "archived",
      waiting_on: "none",
      next: null,
      archived_at: "2026-10-30T10:00:00Z",
    });
    expect(body.events[0]).toMatchObject({ kind: "archive", phase: "plan" });
    expect(ok(p, ["state"]).data).toMatchObject({ items: [] });
    expect(rows(ok(p, ["state", "--archived"]), "items")).toHaveLength(1);
    expect(ok(p, ["check"]).data).toEqual({ findings: [] });
    expect(p.wip(["archive", "T1"]).stdout).toContain("already archived");
  });

  test("it is rejected with a running agent or an open gate", () => {
    const p = ctx.set(itemsProject("archive-busy"));
    itemInPlan(p);
    ok(p, ["agent", "start", "T1", "thinker"]);
    expect(wipJson(p, ["archive", "T1"]).body.message).toContain("1 running agents");
    ok(p, ["agent", "stop", "T1", "thinker", "--status", "done"]);
    ok(p, ["gate", "open", "T1", "--question", "Q"]);
    expect(p.wip(["archive", "T1"]).code).toBe(EXIT.REJECTED);
  });

  test("--force --reason stops the runs, closes the gates and records a correction", () => {
    const p = ctx.set(itemsProject("archive-force"));
    itemInPlan(p);
    ok(p, ["gate", "open", "T1", "--question", "Q"]);
    ok(p, ["gate", "close", "T1", "--answer", "go", "--next", "plan again"]);
    ok(p, ["agent", "start", "T1", "thinker"]);
    tick(30);
    const body = ok(p, ["archive", "T1", "--force", "--reason", "dropped"]);
    expect(body.events.map((e) => e.kind)).toEqual(["correction", "archive"]);
    const show = ok(p, ["show", "T1"]);
    expect(rows(show, "agent_runs")[0]).toMatchObject({
      status: "stopped",
      duration_s: 30,
    });
    expect(p.wip(["archive", "T9"]).code).toBe(EXIT.NOT_FOUND);
  });
});

describe("wip archive prunes by default", () => {
  test("it sends the item's scratch to the trash, and --no-prune keeps the folder whole", () => {
    const p = ctx.set(itemsProject("archive-prune"));
    const t = fakeTrash(p.dir);
    itemInPlan(p);
    itemInPlan(p, "T2");
    const one = join(p.dir, ".wip", "items", "valid", "T1");
    const two = join(p.dir, ".wip", "items", "valid", "T2");
    fixture(one);
    fixture(two);
    const kept = files(two);
    const out = withTrash(p, t.ok, ["archive", "T1"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("T1 · archived in plan · pruned");
    expect(files(one)).toEqual(KEPT);
    expect(readdirSync(t.trash).length).toBe(1);
    const skipped = withTrash(p, t.ok, ["archive", "T2", "--no-prune"]);
    expect(skipped.code).toBe(0);
    expect(files(two)).toEqual(kept);
    expect(readdirSync(t.trash).length).toBe(1);
  });

  test("with no trash command the archive succeeds with a warning and moves nothing", () => {
    const p = ctx.set(itemsProject("archive-no-trash"));
    itemInPlan(p);
    const dir = join(p.dir, ".wip", "items", "valid", "T1");
    fixture(dir);
    const before = files(dir);
    const out = withTrash(p, join(p.dir, "missing"), ["archive", "T1"]);
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("no prune: no trash command (set WIP_TRASH_CMD)");
    expect(files(dir)).toEqual(before);
    expect(rows(ok(p, ["state", "--archived"]), "items")).toHaveLength(1);
  });

  test("a failing trash never fails the archive: warning, exit 0, the pruned files stay in .wip/tmp", () => {
    const p = ctx.set(itemsProject("archive-trash-fails"));
    const t = fakeTrash(p.dir);
    itemInPlan(p);
    fixture(join(p.dir, ".wip", "items", "valid", "T1"));
    const out = withTrash(p, t.fail, ["archive", "T1"]);
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("the trash failed");
    expect(out.stderr).toContain("repeat with wip prune T1");
    expect(readdirSync(join(p.dir, ".wip", "tmp")).length).toBe(1);
    expect(out.stdout).toContain("not pruned");
    expect(out.stdout).toContain("the trash failed");
    expect(out.stdout).not.toContain("(trash)");
    const db = p.db();
    expect(
      db
        .query("SELECT count(*) AS n FROM events WHERE json_extract(data, '$.name') = 'pruned'")
        .get(),
    ).toEqual({ n: 0 });
    db.close();
    expect(withTrash(p, t.ok, ["prune", "T1"]).code).toBe(0);
    expect(readdirSync(join(p.dir, ".wip", "tmp"))).toEqual([]);
    expect(ok(p, ["check"]).data).toEqual({ findings: [] });
  });
});
