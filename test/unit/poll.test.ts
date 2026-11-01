import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/errors.ts";
import { putAgent, putFlow } from "../helpers/defs.ts";
import { agentText, at, ok, useProject, wipJson } from "../helpers/items.ts";
import { makeProject } from "../helpers/project.ts";
import { loadSchema, validate } from "../helpers/schema.ts";

const ctx = useProject();
const T = "2026-11-01T10:00:00Z";

const FLOW = [
  "```wip-flow",
  "phases:",
  "  - name: intake",
  "    next: [waiting]",
  "    waiting_default: user",
  "  - name: waiting",
  "    kind: wait",
  "    waiting_default: external",
  "    next: [done]",
  "  - name: done",
  "    kind: terminal",
  "polling:",
  "  - name: waiting",
  "    phases: [waiting]",
  "    agent: fast",
  "    cadence: 1h",
  "  - name: discover",
  "    agent: fast",
  "    cadence: 30m",
  "```",
  "",
].join("\n");

const NO_POLLING = FLOW.replace(/polling:[\s\S]*```/, "```");

function setup(name: string, flow = FLOW) {
  const p = ctx.set(makeProject(name));
  putFlow(p.dir, "review", flow);
  putAgent(p.dir, "fast", agentText("fast"));
  at(T);
  return p;
}

/** q1 and q2 enter `waiting` at T. */
function withItems(name: string) {
  const p = setup(name);
  for (const id of ["q1", "q2"]) {
    ok(p, ["phase", id, "intake", "--flow", "review"]);
    ok(p, ["phase", id, "waiting", "--next", "wait for the answer"]);
  }
  return p;
}

const plus = (seconds: number): string =>
  new Date(Date.parse(T) + seconds * 1000).toISOString().replace(".000Z", "Z");

function rowOf(p: ReturnType<typeof setup>, poll: string, argv: string[] = []) {
  const body = ok(p, ["poll", "due", ...argv]);
  const polls = (body.data?.polls ?? []) as Record<string, unknown>[];
  return polls.find((r) => r.poll === poll) as Record<string, unknown>;
}

describe("wip poll due", () => {
  test("never run: due, with its items, and no next time before the first pass", () => {
    const p = withItems("poll-never");
    const row = rowOf(p, "waiting");
    expect(row).toMatchObject({
      flow: "review",
      status: "due",
      due: true,
      overdue: false,
      applies: true,
      last_run: null,
      next_at: T,
      agent: "fast",
      cadence: "1h",
      cadence_s: 3600,
      phases: ["waiting"],
    });
    expect(row.items).toEqual([
      { id: "q1", phase: "waiting", last_seen: null },
      { id: "q2", phase: "waiting", last_seen: null },
    ]);
    const text = p.wip(["poll", "due"]);
    expect(text.code).toBe(EXIT.OK);
    expect(text.stdout).toContain(
      "DUE      review/waiting · fast · every 1h · items: q1, q2 · never run",
    );
  });

  test("within the cadence it is ok with next_at; a pass resets it", () => {
    const p = withItems("poll-ok");
    ok(p, ["poll", "record", "review", "waiting", "--result", "no answer"]);
    at(plus(600));
    const row = rowOf(p, "waiting");
    expect(row).toMatchObject({ status: "ok", due: false, last_run: T, next_at: plus(3600) });
    expect(p.wip(["poll", "due"]).stdout).toContain(
      `OK       review/waiting · fast · every 1h · next ${plus(3600)}`,
    );
  });

  test("at exactly 1.5 cadences it is due; one second more it is overdue", () => {
    const p = withItems("poll-overdue");
    ok(p, ["poll", "record", "review", "waiting"]);
    at(plus(5400));
    expect(rowOf(p, "waiting")).toMatchObject({ status: "due", overdue: false });
    at(plus(5401));
    const row = rowOf(p, "waiting");
    expect(row).toMatchObject({ status: "overdue", due: true, overdue: true });
    expect(row.overdue_at).toBe(plus(5400));
    expect(p.wip(["poll", "due"]).stdout).toContain(
      `OVERDUE  review/waiting · fast · every 1h · items: q1, q2 · last ${T} · overdue since ${plus(5400)}`,
    );
  });

  test("a never-run poll with items for over 1.5 cadences is overdue", () => {
    const p = withItems("poll-never-overdue");
    at(plus(5401));
    expect(rowOf(p, "waiting").status).toBe("overdue");
  });

  test("idle without items; an item entering resets the overdue clock", () => {
    const p = setup("poll-idle");
    expect(rowOf(p, "waiting")).toMatchObject({
      status: "idle",
      applies: false,
      next_at: null,
      overdue_at: null,
      items: [],
    });
    expect(p.wip(["poll", "due"]).stdout).toContain(
      "IDLE     review/waiting · fast · every 1h · no open items in waiting",
    );
    ok(p, ["poll", "record", "review", "waiting"]);
    at(plus(10 * 3600));
    ok(p, ["phase", "q9", "intake", "--flow", "review"]);
    ok(p, ["phase", "q9", "waiting", "--next", "x"]);
    // last pass 10 h ago, but the poll only applies since a moment ago: due, not overdue
    expect(rowOf(p, "waiting")).toMatchObject({ status: "due", overdue: false });
    at(plus(10 * 3600 + 5401));
    expect(rowOf(p, "waiting").status).toBe("overdue");
  });

  test("a flow-wide poll always applies", () => {
    const p = setup("poll-wide");
    const row = rowOf(p, "discover");
    expect(row).toMatchObject({ status: "due", applies: true, phases: [], items: [] });
    ok(p, ["poll", "record", "review", "discover"]);
    at(plus(1799));
    expect(rowOf(p, "discover").status).toBe("ok");
    at(plus(1800));
    expect(rowOf(p, "discover").status).toBe("due");
  });

  test("--flow, no polling declared, and a stored flow without polling", () => {
    const p = withItems("poll-flow");
    expect(
      ((ok(p, ["poll", "due", "--flow", "review"]).data?.polls ?? []) as unknown[]).length,
    ).toBe(2);
    expect(wipJson(p, ["poll", "due", "--flow", "nope"]).code).toBe(EXIT.NOT_FOUND);
    putFlow(p.dir, "review", NO_POLLING);
    expect(p.wip(["poll", "due"]).stdout).toBe("no polling declared\n");
    // an older stored version has no `polling` property at all
    const db = new Database(p.dbPath);
    const row = db.query("SELECT json FROM flows WHERE name = 'review'").get() as { json: string };
    const stored = JSON.parse(row.json) as { flow: Record<string, unknown> };
    delete stored.flow.polling;
    db.query("UPDATE flows SET json = ? WHERE name = 'review'").run(JSON.stringify(stored));
    db.close();
    // break the file so the stored version stands in
    putFlow(p.dir, "review", "```wip-flow\nnope: 1\n```\n");
    const out = wipJson(p, ["poll", "due"]);
    expect(out.code).toBe(EXIT.OK);
    expect(((out.body.data?.polls ?? []) as unknown[]).length).toBe(0);
  });

  test("the reader creates no database", () => {
    const p = setup("poll-nodb");
    expect(existsSync(p.dbPath)).toBe(false);
    const body = ok(p, ["poll", "due"]);
    expect(existsSync(p.dbPath)).toBe(false);
    expect(body.data?.now).toBe(T);
    expect(((body.data?.polls ?? []) as { status: string }[]).map((r) => r.status)).toEqual([
      "idle",
      "due",
    ]);
  });

  test("--json validates against the envelope schema", () => {
    const p = withItems("poll-envelope");
    const body = JSON.parse(p.wip(["poll", "due", "--json"]).stdout);
    expect(validate(loadSchema("envelope"), body)).toEqual([]);
  });

  test("--json shape", () => {
    const p = withItems("poll-json");
    ok(p, ["poll", "seen", "review", "waiting", "#7"]);
    const row = rowOf(p, "waiting");
    expect(Object.keys(row).sort()).toEqual(
      [
        "agent",
        "applies",
        "cadence",
        "cadence_s",
        "due",
        "flow",
        "items",
        "last_run",
        "next_at",
        "overdue",
        "overdue_at",
        "phases",
        "poll",
        "seen",
        "status",
      ].sort(),
    );
    expect(row.seen).toEqual([{ key: "#7", seen_at: T, until: null, note: null }]);
  });
});

describe("wip poll record", () => {
  test("by default it lists the items due, writes no event and last_seen follows", () => {
    const p = withItems("rec-default");
    const eventsBefore = (p.db().query("SELECT count(*) AS n FROM events").get() as { n: number })
      .n;
    const out = ok(p, ["poll", "record", "review", "waiting", "--result", "no answer"]);
    expect(out.data?.run).toMatchObject({
      flow: "review",
      poll: "waiting",
      agent: "fast",
      ts: T,
      items: ["q1", "q2"],
      result: "no answer",
    });
    expect(p.wip(["poll", "record", "review", "waiting", "--items", "q1"]).stdout).toBe(
      `review/waiting · pass ${T} · items: q1\n`,
    );
    const eventsAfter = (p.db().query("SELECT count(*) AS n FROM events").get() as { n: number }).n;
    expect(eventsAfter).toBe(eventsBefore);
    at(plus(60));
    const items = rowOf(p, "waiting").items as { id: string; last_seen: string }[];
    expect(items.map((i) => [i.id, i.last_seen])).toEqual([
      ["q1", T],
      ["q2", T],
    ]);
  });

  test("--items A,B, --items none and --agent", () => {
    const p = withItems("rec-items");
    ok(p, ["phase", "q3", "intake", "--flow", "review"]);
    const some = ok(p, [
      "poll",
      "record",
      "review",
      "waiting",
      "--items",
      "q1,q3",
      "--agent",
      "thinker",
    ]);
    expect(some.data?.run).toMatchObject({ items: ["q1", "q3"], agent: "thinker" });
    const none = ok(p, ["poll", "record", "review", "discover", "--items", "none"]);
    expect(none.data?.run).toMatchObject({ items: [] });
    expect(p.wip(["poll", "record", "review", "discover", "--items", "none"]).stdout).toContain(
      "items: none",
    );
  });

  test("errors: unknown flow or poll, archived or foreign item, bad agent", () => {
    const p = withItems("rec-errors");
    expect(wipJson(p, ["poll", "record", "nope", "waiting"]).code).toBe(EXIT.NOT_FOUND);
    const bad = wipJson(p, ["poll", "record", "review", "nope"]);
    expect(bad.code).toBe(EXIT.NOT_FOUND);
    expect(bad.body.message).toContain("polls: waiting, discover");
    expect(wipJson(p, ["poll", "record", "review", "waiting", "--items", "zz"]).code).toBe(
      EXIT.NOT_FOUND,
    );
    putFlow(p.dir, "other", NO_POLLING);
    ok(p, ["phase", "o1", "intake", "--flow", "other"]);
    expect(wipJson(p, ["poll", "record", "review", "waiting", "--items", "o1"]).code).toBe(
      EXIT.REJECTED,
    );
    ok(p, ["phase", "q1", "done"]);
    ok(p, ["archive", "q1"]);
    expect(wipJson(p, ["poll", "record", "review", "waiting", "--items", "q1"]).code).toBe(
      EXIT.REJECTED,
    );
    expect(wipJson(p, ["poll", "record", "review", "waiting", "--agent", "Bad Name"]).code).toBe(
      EXIT.USAGE,
    );
    expect(wipJson(p, ["poll", "record", "review"]).code).toBe(EXIT.USAGE);
    expect(wipJson(p, ["poll"]).code).toBe(EXIT.USAGE);
  });
});

describe("wip poll seen", () => {
  const list = (p: ReturnType<typeof setup>, ...extra: string[]) =>
    (ok(p, ["poll", "seen", "review", "waiting", ...extra]).data?.seen ?? []) as {
      key: string;
      until: string | null;
      note: string | null;
    }[];

  test("add, upsert, relative and ISO --until, note", () => {
    const p = setup("seen-add");
    ok(p, ["poll", "seen", "review", "waiting", "#1"]);
    ok(p, ["poll", "seen", "review", "waiting", "#2", "--until", "+2h", "--note", "later"]);
    ok(p, ["poll", "seen", "review", "waiting", "#3", "--until", "+1d"]);
    ok(p, ["poll", "seen", "review", "waiting", "#4", "--until", "2026-11-05T00:00:00Z"]);
    expect(list(p).map((s) => [s.key, s.until, s.note])).toEqual([
      ["#1", null, null],
      ["#2", plus(7200), "later"],
      ["#3", plus(86400), null],
      ["#4", "2026-11-05T00:00:00Z", null],
    ]);
    ok(p, ["poll", "seen", "review", "waiting", "#2"]);
    expect(list(p).find((s) => s.key === "#2")).toMatchObject({ until: null, note: null });
  });

  test("a past or malformed --until is exit 2; bad keys too", () => {
    const p = setup("seen-bad");
    const code = (...a: string[]) => wipJson(p, ["poll", "seen", "review", "waiting", ...a]).code;
    expect(code("#1", "--until", "2026-10-01T00:00:00Z")).toBe(EXIT.USAGE);
    expect(code("#1", "--until", "soon")).toBe(EXIT.USAGE);
    expect(code("#1", "--until", "+0h")).toBe(EXIT.USAGE);
    expect(code("x".repeat(201))).toBe(EXIT.USAGE);
    expect(code("a\nb")).toBe(EXIT.USAGE);
    expect(code("#1", "--remove", "--note", "x")).toBe(EXIT.USAGE);
    expect(code("--until", "+1h")).toBe(EXIT.USAGE);
    expect(code("#1", "--all")).toBe(EXIT.USAGE);
  });

  test("the list hides expired keys, --all shows them, --remove forgets and exits 4 when absent", () => {
    const p = setup("seen-list");
    ok(p, ["poll", "seen", "review", "waiting", "#1", "--until", "+1h"]);
    ok(p, ["poll", "seen", "review", "waiting", "#2"]);
    at(plus(3601));
    expect(list(p).map((s) => s.key)).toEqual(["#2"]);
    expect(list(p, "--all").map((s) => s.key)).toEqual(["#1", "#2"]);
    expect(ok(p, ["poll", "seen", "review", "waiting", "#2", "--remove"]).data).toEqual({
      removed: "#2",
    });
    expect(list(p)).toEqual([]);
    expect(wipJson(p, ["poll", "seen", "review", "waiting", "#2", "--remove"]).code).toBe(
      EXIT.NOT_FOUND,
    );
    expect(p.wip(["poll", "seen", "review", "waiting"]).stdout).toBe(
      "review/waiting · nothing seen\n",
    );
    expect(wipJson(p, ["poll", "seen", "review", "nope"]).code).toBe(EXIT.NOT_FOUND);
  });

  test("an expired key is not in `due --json`", () => {
    const p = setup("seen-due");
    ok(p, ["poll", "seen", "review", "waiting", "#1", "--until", "+1h"]);
    expect((rowOf(p, "waiting").seen as unknown[]).length).toBe(1);
    at(plus(3601));
    expect((rowOf(p, "waiting").seen as unknown[]).length).toBe(0);
  });
});

test("the join table keeps item rows with their pass", () => {
  const p = withItems("poll-rows");
  ok(p, ["poll", "record", "review", "waiting"]);
  const db = new Database(join(p.dir, ".wip", "wip.sqlite"), { readonly: true });
  expect(db.query("SELECT item_id FROM poll_run_items ORDER BY item_id").all()).toEqual([
    { item_id: "q1" },
    { item_id: "q2" },
  ]);
  db.close();
});
