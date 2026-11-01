import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BUSY_TIMEOUT_MS,
  isSupportedSqlite,
  openDb,
  openForRead,
  SCHEMA_VERSION,
  sqliteLibraryVersion,
  userVersion,
} from "../../src/db.ts";
import { MIGRATIONS } from "../../src/embedded/migrations.ts";
import { EXIT, WipError } from "../../src/errors.ts";
import { PROBES } from "../helpers/probes.ts";
import { count, type IProject, makeProject, scratch } from "../helpers/project.ts";
import type { IWriterResult } from "../helpers/writer.ts";

const TABLES = [
  "agent_runs",
  "events",
  "flows",
  "gates",
  "items",
  "poll_run_items",
  "poll_runs",
  "poll_seen",
  "sessions",
];
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "src", "migrations");

let p: IProject | null = null;
const dirs: string[] = [];
afterEach(() => {
  p?.cleanup();
  p = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshPath(name: string): string {
  const dir = scratch(name);
  dirs.push(dir);
  return join(dir, ".wip", "wip.sqlite");
}

describe("schema", () => {
  test("a new database has the six tables, the schema version and its pragmas", () => {
    const db = openDb(freshPath("schema"));
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => (row as { name: string }).name)
      .sort();
    expect(tables).toEqual(TABLES);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: BUSY_TIMEOUT_MS });
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.close();
  });

  test("items keep the core columns and everything else in a JSON object `fields`", () => {
    const db = openDb(freshPath("items"));
    const columns = db
      .query("PRAGMA table_info(items)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual([
      "id",
      "flow",
      "title",
      "phase",
      "waiting_on",
      "next",
      "status",
      "artifact_dir",
      "fields",
      "created_at",
      "updated_at",
      "archived_at",
    ]);
    const insert = (fields: string) =>
      db
        .query(
          "INSERT INTO items (id, flow, phase, fields, created_at, updated_at) VALUES (?, 'wip', 'intake', ?, 'x', 'x')",
        )
        .run(`T${Math.random()}`, fields);
    insert('{"title":"a"}');
    expect(() => insert("[1]")).toThrow();
    expect(() => insert("not json")).toThrow();
    db.close();
  });

  test("tables are STRICT: a wrong type is refused", () => {
    const db = openDb(freshPath("strict"));
    expect(() =>
      db.query("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run("s", new Uint8Array(1)),
    ).toThrow();
    db.close();
  });

  test("migrating twice is a no-op", () => {
    const path = freshPath("twice");
    openDb(path).close();
    const db = openDb(path);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  test("a database from a newer wip is exit 10", () => {
    const path = freshPath("newer");
    const db = openDb(path);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    try {
      openDb(path);
      throw new Error("expected a failure");
    } catch (err) {
      expect((err as WipError).code).toBe(EXIT.DB);
    }
  });

  test("a database built at schema 1 migrates to 2 and keeps every row", () => {
    const path = freshPath("v1-to-v2");
    mkdirSync(dirname(path), { recursive: true });
    const old = new Database(path, { create: true, strict: true });
    old.exec(MIGRATIONS[0]?.[1] as string);
    old.exec("PRAGMA user_version = 1");
    old.exec(`INSERT INTO items (id, flow, phase, created_at, updated_at)
              VALUES ('a', 'f', 'p', '2026-10-30T10:00:00Z', '2026-10-30T10:00:00Z')`);
    old.exec(`INSERT INTO events (item_id, ts, kind) VALUES ('a', '2026-10-30T10:00:00Z', 'note')`);
    old.close();
    const db = openDb(path);
    expect(userVersion(db)).toBe(2);
    expect(count(db, "SELECT count(*) AS n FROM items")).toBe(1);
    expect(count(db, "SELECT count(*) AS n FROM events")).toBe(1);
    for (const table of ["poll_runs", "poll_run_items", "poll_seen"]) {
      expect(count(db, `SELECT count(*) AS n FROM ${table}`)).toBe(0);
    }
    db.close();
  });

  test("the migration manifest has every .sql file, in order", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(MIGRATIONS.map(([name]) => name)).toEqual(files);
    expect(SCHEMA_VERSION).toBe(files.length);
  });
});

describe("SQLite version (D2)", () => {
  test("the linked library is supported", () => {
    expect(isSupportedSqlite(sqliteLibraryVersion())).toBe(true);
  });

  test("3.37.0 and later pass, older ones do not", () => {
    expect(isSupportedSqlite("3.37.0")).toBe(true);
    expect(isSupportedSqlite("3.37.2")).toBe(true);
    expect(isSupportedSqlite("3.45.1")).toBe(true);
    expect(isSupportedSqlite("4.0.0")).toBe(true);
    expect(isSupportedSqlite("3.36.9")).toBe(false);
    expect(isSupportedSqlite("3.9.0")).toBe(false);
  });

  test("a simulated 3.36 is exit 10 and creates nothing", () => {
    const path = freshPath("old-sqlite");
    try {
      openDb(path, { sqliteVersion: () => "3.36.0" });
      throw new Error("expected a failure");
    } catch (err) {
      expect(err).toBeInstanceOf(WipError);
      expect((err as WipError).code).toBe(EXIT.DB);
      expect((err as WipError).message).toContain("3.37.0");
    }
    expect(existsSync(path)).toBe(false);
  });

  test("through the CLI a simulated 3.36 is exit 10", () => {
    p = makeProject("cli-old-sqlite");
    const out = p.wip(["probe-write"], { extra: PROBES, sqliteVersion: () => "3.36.0" });
    expect(out.code).toBe(EXIT.DB);
    expect(out.stderr).toContain("too old");
    expect(existsSync(p.dbPath)).toBe(false);
  });
});

describe("one transaction per command", () => {
  test("a successful write commits", () => {
    p = makeProject("commit");
    expect(p.wip(["probe-write", "s1"], { extra: PROBES }).code).toBe(EXIT.OK);
    const db = p.db();
    expect(count(db, "SELECT count(*) AS n FROM sessions")).toBe(1);
    expect(count(db, "SELECT count(*) AS n FROM events")).toBe(1);
    db.close();
  });

  test("a rejected command leaves the database as it was", () => {
    p = makeProject("rollback");
    p.wip(["probe-write", "s1"], { extra: PROBES });
    const out = p.wip(["probe-write", "s2", "--fail", "rejected"], { extra: PROBES });
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.stderr).toContain("probe rejected the write");
    const db = p.db();
    expect(count(db, "SELECT count(*) AS n FROM sessions")).toBe(1);
    expect(count(db, "SELECT count(*) AS n FROM events")).toBe(1);
    db.close();
  });

  test("an unexpected error also rolls back", () => {
    p = makeProject("crash");
    p.wip(["probe-write", "s1"], { extra: PROBES });
    expect(p.wip(["probe-write", "s2", "--fail", "crash"], { extra: PROBES }).code).toBe(EXIT.DB);
    const db = p.db();
    expect(count(db, "SELECT count(*) AS n FROM sessions")).toBe(1);
    db.close();
  });

  test("invalid arguments fail before the database is opened", () => {
    p = makeProject("args-first");
    expect(p.wip(["probe-write", "--bogus", "x"], { extra: PROBES }).code).toBe(EXIT.USAGE);
    expect(p.wip(["probe-write", "--fail"], { extra: PROBES }).code).toBe(EXIT.USAGE);
    expect(p.wip(["probe-write", "--warn=1"], { extra: PROBES }).code).toBe(EXIT.USAGE);
    expect(existsSync(p.dbPath)).toBe(false);
  });
});

describe("readers", () => {
  test("never create the database", () => {
    p = makeProject("reader-none");
    const out = p.json(["probe-read"], { extra: PROBES });
    expect(out.ok).toBe(true);
    expect(out.data).toEqual({ exists: false, sessions: null });
    expect(existsSync(p.dbPath)).toBe(false);
    expect(readdirSync(join(p.dir, ".wip"))).toEqual([]);
  });

  test("read what the writers committed and cannot write", () => {
    p = makeProject("reader-some");
    p.wip(["probe-write", "s1"], { extra: PROBES });
    expect(p.json(["probe-read"], { extra: PROBES }).data).toEqual({ exists: true, sessions: 1 });
    const db = openForRead(p.dbPath);
    expect(db).not.toBeNull();
    expect(() => db?.exec("DELETE FROM sessions")).toThrow();
    db?.close();
  });
});

describe("concurrency", () => {
  async function writers(path: string, n: number, perWriter: number): Promise<IWriterResult[]> {
    const script = join(import.meta.dir, "..", "helpers", "writer.ts");
    const procs = Array.from({ length: n }, (_, w) =>
      Bun.spawn([process.execPath, script, path, String(perWriter), `w${w}`], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    return Promise.all(
      procs.map(async (proc) => {
        const text = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        const last = text.trim().split("\n").pop();
        if (!last) {
          return {
            failures: perWriter,
            errors: [{ index: -1, code: exitCode, message: stderr.trim() }],
          };
        }
        return JSON.parse(last) as IWriterResult;
      }),
    );
  }

  const NO_ERRORS: IWriterResult = { failures: 0, errors: [] };

  test("four processes writing 25 events each do not corrupt nor lose writes", async () => {
    const path = freshPath("concurrent");
    openDb(path).close();
    expect(await writers(path, 4, 25)).toEqual(Array(4).fill(NO_ERRORS));
    const db = new Database(path, { readonly: true });
    expect(count(db, "SELECT count(*) AS n FROM events")).toBe(100);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.close();
  }, 30_000);

  test("four processes racing to create the database migrate it once", async () => {
    const path = freshPath("concurrent-create");
    expect(await writers(path, 4, 5)).toEqual(Array(4).fill(NO_ERRORS));
    const db = new Database(path, { readonly: true });
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(count(db, "SELECT count(*) AS n FROM events")).toBe(20);
    db.close();
  }, 30_000);
});
