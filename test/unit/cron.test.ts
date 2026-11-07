import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EXIT } from "../../src/errors.ts";
import { fixture, putAgent, putFlow } from "../helpers/defs.ts";
import {
  agentText,
  at,
  type IJson,
  itemInPlan,
  itemsProject,
  ok,
  useProject,
  wipJson,
} from "../helpers/items.ts";
import { makeProject } from "../helpers/project.ts";
import { loadSchema, validate } from "../helpers/schema.ts";

const LIST = loadSchema("cron-list");
const ctx = useProject();
/** Thursday 5 Nov 2026, 11:00 in Madrid. */
const T = "2026-11-05T10:00:00Z";

let tz: string | undefined;
beforeAll(() => {
  tz = process.env.TZ;
  process.env.TZ = "Europe/Madrid";
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

function setup(name: string) {
  const p = ctx.set(itemsProject(name));
  at(T);
  return p;
}

const plus = (seconds: number, from = T): string =>
  new Date(Date.parse(from) + seconds * 1000).toISOString().replace(".000Z", "Z");

type TJob = Record<string, unknown>;

function list(p: ReturnType<typeof setup>, argv: string[] = []): IJson & { jobs: TJob[] } {
  const body = ok(p, ["cron", "list", ...argv]);
  expect(validate(LIST, body)).toEqual([]);
  return { ...body, jobs: (body.data?.jobs ?? []) as TJob[] };
}

function cron(body: IJson): TJob {
  return body.data?.cron as TJob;
}

describe("wip cron add", () => {
  test("a reminder at a local time: stored in UTC, shown with its weekday", () => {
    const p = setup("cron-add");
    const out = p.wip(["cron", "add", "llamar a X", "--at", "2026-11-06 14:00"]);
    expect(out.code).toBe(EXIT.OK);
    expect(out.stdout).toBe("added c1 · Fri 2026-11-06 14:00 · llamar a X\n");
    const job = list(p).jobs[0] as TJob;
    expect(job).toEqual({
      key: "cron:c1@2026-11-06T13:00:00Z",
      kind: "reminder",
      source: "cron",
      id: "c1",
      status: "open",
      at: "2026-11-06T13:00:00Z",
      at_local: "2026-11-06 14:00",
      cron: "0 14 6 11 *",
      due: false,
      missed: false,
      every: null,
      text: "llamar a X",
      item: null,
      flow: null,
      poll: null,
      agent: null,
      pass: null,
    });
  });

  test("bad input: no text, a past or unreadable --at, a bad --every, a long text", () => {
    const p = setup("cron-add-bad");
    const code = (argv: string[]) => wipJson(p, ["cron", "add", ...argv]).code;
    expect(code(["--at", "+1h"])).toBe(EXIT.USAGE);
    expect(code(["x"])).toBe(EXIT.USAGE);
    expect(code(["x", "--at", "2026-11-05T09:00:00Z"])).toBe(EXIT.USAGE);
    expect(code(["x", "--at", "friday"])).toBe(EXIT.USAGE);
    expect(code(["x", "--at", "+1h", "--every", "1w"])).toBe(EXIT.USAGE);
    expect(code(["x".repeat(501), "--at", "+1h"])).toBe(EXIT.USAGE);
    expect(code(["two\nlines", "--at", "+1h"])).toBe(EXIT.USAGE);
    expect(code(["x", "--at", "+1h", "--horizon", "1d"])).toBe(EXIT.USAGE);
    expect(list(p).jobs).toEqual([]);
  });

  test("--item: open 0, archived 3, unknown 4", () => {
    const p = setup("cron-item");
    itemInPlan(p, "T1");
    itemInPlan(p, "T2");
    ok(p, ["archive", "T2", "--force", "--reason", "test", "--no-prune"]);
    const add = (id: string) => wipJson(p, ["cron", "add", "x", "--at", "+1h", "--item", id]);
    const added = add("T1");
    expect(added.code).toBe(EXIT.OK);
    expect(cron(added.body).item).toBe("T1");
    expect(add("T2").code).toBe(EXIT.REJECTED);
    expect(add("T9").code).toBe(EXIT.NOT_FOUND);
  });
});

describe("wip cron list", () => {
  test("sorted by time; keys do not change between two reads", () => {
    const p = setup("cron-list");
    ok(p, ["cron", "add", "later", "--at", "+3h"]);
    ok(p, ["cron", "add", "sooner", "--at", "+1h"]);
    const first = list(p);
    expect(first.jobs.map((j) => j.text)).toEqual(["sooner", "later"]);
    at(plus(600));
    const second = list(p);
    expect(second.jobs.map((j) => j.key)).toEqual(first.jobs.map((j) => j.key));
    expect(second.data?.now).toBe(plus(600));
    expect(second.data?.horizon_end).toBe(plus(600 + 7 * 86400));
    const text = p.wip(["cron", "list"]).stdout;
    expect(text).toBe(
      "OPEN      2026-11-05 12:00 · c2 · sooner\nOPEN      2026-11-05 14:00 · c1 · later\n",
    );
  });

  test("due from 120 s before its time, not at 121 s", () => {
    const p = setup("cron-grace");
    ok(p, ["cron", "add", "x", "--at", "+1h"]);
    at(plus(3600 - 121));
    expect(list(p).jobs[0]?.due).toBe(false);
    at(plus(3600 - 119));
    expect(list(p).jobs[0]?.due).toBe(true);
    expect(p.wip(["cron", "list"]).stdout).toStartWith("MISSED    2026-11-05 12:00 · c1 · x");
  });

  test("missed: due before the open session started; without a session, every due job", () => {
    const p = setup("cron-missed");
    ok(p, ["cron", "add", "before", "--at", "+1h"]);
    ok(p, ["cron", "add", "after", "--at", "+3h"]);
    at(plus(2 * 3600));
    ok(p, ["session", "start", "--id", "s1"]);
    at(plus(4 * 3600));
    const body = list(p);
    expect(body.data?.session).toBe("s1");
    expect(body.jobs.map((j) => [j.text, j.due, j.missed])).toEqual([
      ["before", true, true],
      ["after", true, false],
    ]);
  });

  test("horizon: later jobs are counted in beyond, with one rearm job", () => {
    const p = setup("cron-horizon");
    ok(p, ["cron", "add", "near", "--at", "+1d"]);
    ok(p, ["cron", "add", "far", "--at", "+10d"]);
    const body = list(p);
    expect(body.jobs.map((j) => j.text)).toEqual(["near"]);
    expect(body.data?.beyond).toBe(1);
    expect(body.data?.rearm).toEqual({
      key: "rearm",
      at: "2026-11-11T10:00:00Z",
      at_local: "2026-11-11 11:00",
      cron: "0 11 11 11 *",
    });
    const wide = list(p, ["--horizon", "14d"]);
    expect(wide.jobs.map((j) => j.text)).toEqual(["near", "far"]);
    expect(wide.data?.rearm).toBeNull();
    expect(wipJson(p, ["cron", "list", "--horizon", "soon"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["cron", "list"]).stdout).toContain("1 more after 2026-11-12 11:00");
  });

  test("an empty list, and no database yet", () => {
    const p = setup("cron-empty");
    expect(p.wip(["cron", "list"]).stdout).toBe("nothing scheduled\n");
    const body = list(p);
    expect(body.data).toMatchObject({ session: null, beyond: 0, rearm: null, jobs: [] });
  });
});

describe("wip cron done, cancel, snooze", () => {
  test("done on a one-off closes it; --all still lists it", () => {
    const p = setup("cron-done");
    ok(p, ["cron", "add", "x", "--at", "+1h"]);
    const done = ok(p, ["cron", "done", "c1"]);
    expect(cron(done)).toMatchObject({ status: "done", due: false });
    expect(list(p).jobs).toEqual([]);
    const all = list(p, ["--all"]);
    expect(all.jobs.map((j) => [j.id, j.status])).toEqual([["c1", "done"]]);
    expect(p.wip(["cron", "list", "--all"]).stdout).toStartWith("DONE      ");
    expect(wipJson(p, ["cron", "done", "c1"]).code).toBe(EXIT.REJECTED);
    expect(wipJson(p, ["cron", "snooze", "c1", "--at", "+1h"]).code).toBe(EXIT.REJECTED);
  });

  test("done on a repeating cron moves it past now, skipping missed occurrences, at the same local hour", () => {
    const p = setup("cron-repeat");
    at("2026-10-20T10:00:00Z");
    ok(p, ["cron", "add", "weekly", "--at", "2026-10-23 14:00", "--every", "7d"]);
    at(T);
    const body = ok(p, ["cron", "done", "1"]);
    expect(cron(body)).toMatchObject({
      status: "open",
      at: "2026-11-06T13:00:00Z",
      at_local: "2026-11-06 14:00",
      every: "7d",
      key: "cron:c1@2026-11-06T13:00:00Z",
    });
    expect(p.wip(["cron", "done", "c1"]).stdout).toBe(
      "next c1 · Fri 2026-11-13 14:00 · weekly · every 7d\n",
    );
  });

  test("cancel closes a repeating cron for good", () => {
    const p = setup("cron-cancel");
    ok(p, ["cron", "add", "x", "--at", "+1h", "--every", "1d"]);
    expect(cron(ok(p, ["cron", "cancel", "c1"])).status).toBe("cancelled");
    expect(list(p).jobs).toEqual([]);
    expect(wipJson(p, ["cron", "cancel", "c1"]).code).toBe(EXIT.REJECTED);
  });

  test("snooze moves at and keeps it open; its key changes", () => {
    const p = setup("cron-snooze");
    ok(p, ["cron", "add", "x", "--at", "+1h"]);
    const body = ok(p, ["cron", "snooze", "c1", "--at", "+3h"]);
    expect(cron(body)).toMatchObject({ status: "open", at: plus(3 * 3600) });
    expect(list(p).jobs[0]?.key).toBe(`cron:c1@${plus(3 * 3600)}`);
    expect(wipJson(p, ["cron", "snooze", "c1"]).code).toBe(EXIT.USAGE);
    expect(wipJson(p, ["cron", "snooze", "c1", "--at", "2026-11-01T00:00:00Z"]).code).toBe(
      EXIT.USAGE,
    );
  });

  test("ids: unknown 4, malformed 2, no sub-command 2", () => {
    const p = setup("cron-ids");
    ok(p, ["cron", "add", "x", "--at", "+1h"]);
    expect(wipJson(p, ["cron", "done", "c9"]).code).toBe(EXIT.NOT_FOUND);
    expect(wipJson(p, ["cron", "cancel", "x1"]).code).toBe(EXIT.USAGE);
    expect(wipJson(p, ["cron", "done"]).code).toBe(EXIT.USAGE);
    expect(wipJson(p, ["cron"]).code).toBe(EXIT.USAGE);
    expect(wipJson(p, ["cron", "frobnicate"]).code).toBe(EXIT.USAGE);
  });

  test("help lists the five sub-commands", () => {
    const p = setup("cron-help");
    for (const argv of [
      ["help", "cron"],
      ["cron", "--help"],
    ]) {
      const out = p.wip(argv).stdout;
      for (const sub of ["add", "list", "done", "cancel", "snooze"]) {
        expect(out).toContain(`wip cron ${sub}`);
      }
    }
  });
});

/** The `polls` fixture as flow `review`: `waiting` watches phase waiting every 1h, `discover` is flow-wide every 30m. */
function polls(name: string) {
  const p = ctx.set(makeProject(name));
  putFlow(p.dir, "review", fixture("flows", "polls"));
  putAgent(p.dir, "fast", agentText("fast"));
  at(T);
  return p;
}

const pollJobs = (body: { jobs: TJob[] }) => body.jobs.filter((j) => j.kind === "poll");

describe("wip cron list · polls", () => {
  test("a never-run flow-wide poll is due with no items; an idle phase poll has no job", () => {
    const p = polls("cron-poll-never");
    const jobs = pollJobs(list(p));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      key: `poll:review/discover@${T}`,
      kind: "poll",
      source: "flow",
      id: null,
      due: true,
      missed: true,
      every: "30m",
      flow: "review",
      poll: "discover",
      agent: "fast",
    });
    const pass = (jobs[0] as TJob).pass as TJob;
    expect(pass.items).toEqual([]);
    expect(pass.status).toBe("due");
  });

  test("after poll record the job moves to last_run + cadence, with a stable key", () => {
    const p = polls("cron-poll-record");
    ok(p, ["poll", "record", "review", "discover"]);
    at(plus(60));
    const first = pollJobs(list(p));
    at(plus(120));
    const second = pollJobs(list(p));
    expect(first[0]).toMatchObject({ key: `poll:review/discover@${plus(1800)}`, due: false });
    expect(second.map((j) => j.key)).toEqual(first.map((j) => j.key));
    at(plus(1800 - 90));
    expect(pollJobs(list(p))[0]?.due).toBe(true);
  });

  test("an item moved into a watched phase makes its poll appear, due", () => {
    const p = polls("cron-poll-phase");
    ok(p, ["poll", "record", "review", "discover"]);
    expect(pollJobs(list(p)).map((j) => j.poll)).toEqual(["discover"]);
    ok(p, ["phase", "q1", "intake", "--flow", "review"]);
    ok(p, ["phase", "q1", "waiting"]);
    const job = pollJobs(list(p)).find((j) => j.poll === "waiting") as TJob;
    expect(job).toMatchObject({ key: `poll:review/waiting@${T}`, due: true });
    expect((job.pass as { items: TJob[] }).items.map((i) => i.id)).toEqual(["q1"]);
  });

  test("a --poll cron is due at its time while its poll is ok, and carries the pass", () => {
    const p = polls("cron-poll-fixed");
    ok(p, ["poll", "record", "review", "discover"]);
    const added = ok(p, ["cron", "add", "--poll", "review/discover", "--at", "+10m"]);
    expect(cron(added)).toMatchObject({ kind: "poll", source: "cron", id: "c1", text: null });
    at(plus(600));
    const job = list(p).jobs.find((j) => j.id === "c1") as TJob;
    expect(job).toMatchObject({ due: true, agent: "fast", flow: "review", poll: "discover" });
    expect((job.pass as TJob).status).toBe("ok");
    expect(p.wip(["cron", "list"]).stdout).toContain("· c1 · poll review/discover");
  });

  test("--poll: unknown poll or flow 4, disabled flow 4, malformed 2, --item 2", () => {
    const p = polls("cron-poll-bad");
    const add = (target: string, extra: string[] = []) =>
      wipJson(p, ["cron", "add", "--poll", target, "--at", "+1h", ...extra]).code;
    expect(add("review/nope")).toBe(EXIT.NOT_FOUND);
    expect(add("nope/discover")).toBe(EXIT.NOT_FOUND);
    expect(add("review")).toBe(EXIT.USAGE);
    ok(p, ["phase", "q1", "intake", "--flow", "review"]);
    expect(add("review/discover", ["--item", "q1"])).toBe(EXIT.USAGE);
    ok(p, ["flow", "disable", "review"]);
    expect(add("review/discover")).toBe(EXIT.NOT_FOUND);
  });

  test("a --poll cron of a flow disabled later is left out of jobs, with a line and a warning", () => {
    const p = polls("cron-poll-disabled");
    ok(p, ["cron", "add", "--poll", "review/discover", "--at", "+1h", "weekly sweep"]);
    ok(p, ["flow", "disable", "review"]);
    const body = list(p);
    expect(body.jobs).toEqual([]);
    expect(body.warnings.map((w) => w.code)).toContain("cron_poll_inactive");
    expect(p.wip(["cron", "list"]).stdout).toContain("c1 · poll review/discover (flow disabled)");
  });

  test("wip poll due answers the same before and after crons are added and listed", () => {
    const p = polls("cron-poll-same");
    ok(p, ["phase", "q1", "intake", "--flow", "review"]);
    ok(p, ["phase", "q1", "waiting"]);
    const before = p.wip(["poll", "due", "--json"]).stdout;
    ok(p, ["cron", "add", "--poll", "review/waiting", "--at", "+1h"]);
    ok(p, ["cron", "add", "x", "--at", "+1h"]);
    list(p);
    expect(p.wip(["poll", "due", "--json"]).stdout).toBe(before);
  });
});
