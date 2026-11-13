import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../../src/embedded/migrations.ts";
import { EXIT } from "../../src/errors.ts";
import { localMinute } from "../../src/when.ts";
import { wipIn, wipJsonIn } from "../helpers/bin.ts";
import { fixture, putFlow } from "../helpers/defs.ts";
import { scratch } from "../helpers/project.ts";
import { loadSchema, validate } from "../helpers/schema.ts";

// The clock cannot be pinned in a child process: times are relative, and TZ is fixed for both sides.
const TZ = "Europe/Madrid";
const ENV = { TZ };
const LIST = loadSchema("cron-list");
const dirs: string[] = [];
let tz: string | undefined;

beforeAll(() => {
  tz = process.env.TZ;
  process.env.TZ = TZ;
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(name: string): string {
  const dir = scratch(`cron-${name}`);
  dirs.push(dir);
  expect(wipJsonIn(dir, ["init"], ENV).code).toBe(EXIT.OK);
  return dir;
}

type TJob = Record<string, unknown>;

function okIn(dir: string, argv: string[]) {
  const out = wipJsonIn(dir, argv, ENV);
  if (out.code !== 0) throw new Error(`wip ${argv.join(" ")} → ${out.code}: ${out.body.message}`);
  return out.body;
}

function jobs(dir: string, argv: string[] = []): TJob[] {
  const body = okIn(dir, ["cron", "list", ...argv]);
  expect(validate(LIST, body)).toEqual([]);
  return (body.data?.jobs ?? []) as TJob[];
}

/** Local `YYYY-MM-DD` of today plus `days`. */
function localDay(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localMinute(d).at_local.slice(0, 10);
}

describe("wip cron (e2e)", () => {
  test("add, list, done of a repeating one, cancel and snooze", () => {
    const dir = project("cycle");
    const added = okIn(dir, ["cron", "add", "probe", "--at", "+2h"]);
    const probe = added.data?.cron as TJob;
    expect(probe).toMatchObject({ id: "c1", kind: "reminder", due: false, status: "open" });
    expect(probe.key).toBe(`cron:c1@${probe.at}`);

    const day = localDay(2);
    okIn(dir, ["cron", "add", "weekly", "--at", `${day} 14:00`, "--every", "7d"]);
    const reminders = (): TJob[] => jobs(dir).filter((j) => j.kind === "reminder");
    const listed = reminders();
    expect(listed.map((j) => j.text)).toEqual(["probe", "weekly"]);
    expect(listed[1]).toMatchObject({ at_local: `${day} 14:00`, every: "7d" });
    expect(reminders().map((j) => j.key)).toEqual(listed.map((j) => j.key));

    const next = okIn(dir, ["cron", "done", "c2"]).data?.cron as TJob;
    expect(next).toMatchObject({ status: "open", at_local: `${localDay(9)} 14:00` });

    const cancelled = okIn(dir, ["cron", "cancel", "c1"]).data?.cron as TJob;
    expect(cancelled.status).toBe("cancelled");
    expect(reminders().map((j) => j.id)).toEqual([]);
    expect(okIn(dir, ["cron", "list"]).data?.beyond).toBe(1);
    expect(
      jobs(dir, ["--horizon", "14d"])
        .filter((j) => j.kind === "reminder")
        .map((j) => j.id),
    ).toEqual(["c2"]);
    expect(
      jobs(dir, ["--all", "--horizon", "14d"])
        .filter((j) => j.kind === "reminder")
        .map((j) => j.id),
    ).toEqual(["c1", "c2"]);

    const snoozed = okIn(dir, ["cron", "snooze", "c2", "--at", "+3h"]).data?.cron as TJob;
    expect(Date.parse(snoozed.at as string)).toBeLessThan(Date.now() + 4 * 3600_000);
    expect(wipJsonIn(dir, ["cron", "add", "x", "--at", "+0h"], ENV).code).toBe(EXIT.USAGE);
    expect(wipJsonIn(dir, ["cron", "done", "c1"], ENV).code).toBe(EXIT.REJECTED);
    expect(wipJsonIn(dir, ["cron", "done", "c7"], ENV).code).toBe(EXIT.NOT_FOUND);
    expect(wipIn(dir, ["cron", "list"], ENV).stdout).toContain(" · c2 · weekly · every 7d");
  });

  test("--poll on the polls fixture, next to the flow poll it names", () => {
    const dir = project("poll");
    putFlow(dir, "review", fixture("flows", "polls"));
    okIn(dir, ["cron", "add", "--poll", "review/discover", "--at", "+1h"]);
    const listed = jobs(dir);
    expect(listed.some((j) => `${j.flow},${j.poll},${j.source}` === "tasks,due,flow")).toBe(true);
    expect(
      listed.filter((j) => j.poll === "discover").map((j) => [j.source, j.poll, j.due]),
    ).toEqual([
      ["flow", "discover", true],
      ["cron", "discover", false],
    ]);
    const cronDiscover = listed.find((j) => j.source === "cron");
    expect((cronDiscover?.pass as TJob | undefined)?.agent).toBe("fast");
    expect(wipJsonIn(dir, ["cron", "add", "--poll", "review/nope", "--at", "+1h"], ENV).code).toBe(
      EXIT.NOT_FOUND,
    );
  });

  test("a v3 database is migrated by the first command, after its v3 copy", () => {
    const dir = project("v3");
    const path = join(dir, ".wip", "wip.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    const old = new Database(path, { create: true, strict: true });
    for (const [, sql] of MIGRATIONS.slice(0, 3)) old.exec(sql);
    old.exec("PRAGMA user_version = 3");
    old.exec(`INSERT INTO items (id, flow, phase, created_at, updated_at)
              VALUES ('a', 'tasks', 'todo', '2026-10-30T10:00:00Z', '2026-10-30T10:00:00Z')`);
    old.close();
    expect(jobs(dir).filter((j) => j.kind === "reminder")).toEqual([]);
    const copies = readdirSync(join(dir, ".wip", "backups", "db"));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^wip\.sqlite\.v3\.\d{8}T\d{6}Z\.\d+$/);
    const db = new Database(path);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(db.query("SELECT count(*) AS n FROM items").get()).toEqual({ n: 1 });
    db.close();
  });
});
