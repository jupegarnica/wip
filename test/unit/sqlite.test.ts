import { Database as BunDatabase } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION, userVersion } from "../../src/db.ts";
import { Database, isBusyError, sleepSync } from "../../src/sqlite.ts";
import { scratch } from "../helpers/project.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshPath(name: string): string {
  const dir = scratch(name);
  dirs.push(dir);
  return join(dir, "db.sqlite");
}

function table(path: string): Database {
  const db = new Database(path);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, flag INTEGER)");
  return db;
}

describe("the node:sqlite wrapper", () => {
  test("get() answers null when there is no row, the row otherwise", () => {
    const db = table(freshPath("sqlite-get"));
    expect(db.query("SELECT v FROM t WHERE id = ?").get(1)).toBeNull();
    db.query("INSERT INTO t (id, v) VALUES (?, ?)").run(1, "a");
    expect(db.query("SELECT v FROM t WHERE id = ?").get(1)).toEqual({ v: "a" });
    expect(db.query("SELECT v FROM t").all()).toEqual([{ v: "a" }]);
    db.close();
  });

  test("query() caches the statement by its SQL", () => {
    const db = table(freshPath("sqlite-cache"));
    expect(db.query("SELECT 1")).toBe(db.query("SELECT 1"));
    db.close();
  });

  test("booleans bind as 1 and 0", () => {
    const db = table(freshPath("sqlite-bool"));
    db.query("INSERT INTO t (id, flag) VALUES (?, ?)").run(1, true);
    db.query("INSERT INTO t (id, flag) VALUES (?, ?)").run(2, false);
    expect(db.query("SELECT id, flag FROM t ORDER BY id").all()).toEqual([
      { id: 1, flag: 1 },
      { id: 2, flag: 0 },
    ]);
    expect(db.query("UPDATE t SET flag = ? WHERE flag = ?").run(false, true).changes).toBe(1);
    db.close();
  });

  test("undefined binds as NULL", () => {
    const db = table(freshPath("sqlite-undefined"));
    db.query("INSERT INTO t (id, v) VALUES (?, ?)").run(1, undefined as unknown as null);
    expect(db.query("SELECT v FROM t WHERE id = ?").get(1)).toEqual({ v: null });
    db.close();
  });

  test("transaction(fn) commits and returns fn's value; a throw rolls back", () => {
    const db = table(freshPath("sqlite-tx"));
    const insert = db.transaction((id: number) => {
      db.query("INSERT INTO t (id) VALUES (?)").run(id);
      return id * 10;
    });
    expect(insert(1)).toBe(10);
    expect(insert.immediate(2)).toBe(20);
    expect(db.inTransaction).toBe(false);
    const failing = db.transaction(() => {
      db.query("INSERT INTO t (id) VALUES (3)").run();
      throw new Error("boom");
    });
    expect(() => failing.immediate()).toThrow("boom");
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT id FROM t ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
    db.close();
  });

  test("a nested transaction is a savepoint: its rollback keeps the outer work", () => {
    const db = table(freshPath("sqlite-nested"));
    const outer = db.transaction(() => {
      db.query("INSERT INTO t (id) VALUES (1)").run();
      const inner = db.transaction(() => {
        db.query("INSERT INTO t (id) VALUES (2)").run();
        throw new Error("inner");
      });
      expect(() => inner()).toThrow("inner");
      return db.transaction(() => "nested value")();
    });
    expect(outer.immediate()).toBe("nested value");
    expect(db.query("SELECT id FROM t").all()).toEqual([{ id: 1 }]);
    db.close();
  });

  test("a write lock held by another connection is a busy error", () => {
    const path = freshPath("sqlite-busy");
    const a = table(path);
    a.exec("PRAGMA journal_mode = WAL");
    const b = new Database(path);
    b.exec("PRAGMA busy_timeout = 0");
    a.exec("BEGIN IMMEDIATE");
    let caught: unknown = null;
    try {
      b.exec("BEGIN IMMEDIATE");
    } catch (err) {
      caught = err;
    }
    expect(isBusyError(caught)).toBe(true);
    expect(isBusyError(new Error("other"))).toBe(false);
    expect(isBusyError({ code: "SQLITE_BUSY_SNAPSHOT" })).toBe(true);
    a.exec("COMMIT");
    a.close();
    b.close();
  });

  test("readOnly never creates the file and refuses writes, also after the WAL files are gone", () => {
    const path = freshPath("sqlite-ro");
    expect(() => new Database(path, { readOnly: true })).toThrow();
    expect(existsSync(path)).toBe(false);
    openDb(path).close();
    const ro = new Database(path, { readOnly: true });
    expect(userVersion(ro)).toBe(SCHEMA_VERSION);
    expect(() => ro.exec("DELETE FROM items")).toThrow();
    ro.close();
  });

  test("sleepSync blocks for about the time asked", () => {
    const start = performance.now();
    sleepSync(20);
    expect(performance.now() - start).toBeGreaterThanOrEqual(15);
  });
});

describe("files are shared with bun:sqlite", () => {
  test("a database written by bun:sqlite opens through the wrapper", () => {
    const path = freshPath("sqlite-from-bun");
    const bun = new BunDatabase(path, { create: true });
    bun.exec("PRAGMA journal_mode = WAL");
    bun.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('from bun')");
    bun.close();
    const db = new Database(path);
    expect(db.query("SELECT v FROM t").get()).toEqual({ v: "from bun" });
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
  });

  test("a database written by openDb opens in bun:sqlite with its schema", () => {
    const path = freshPath("sqlite-to-bun");
    const db = openDb(path);
    db.query("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run(
      "s1",
      "2026-11-05T00:00:00Z",
    );
    db.close();
    const bun = new BunDatabase(path);
    expect(bun.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(bun.query("SELECT id FROM sessions").all()).toEqual([{ id: "s1" }]);
    expect(bun.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    bun.close();
  });
});
