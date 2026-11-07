import { existsSync } from "node:fs";
import * as sqlite from "node:sqlite";

/**
 * The one door to SQLite. It runs on Node (`node:sqlite`), on Bun (which implements `node:sqlite` too) and inside a
 * compiled Bun binary, and keeps the small bun:sqlite shape the code was written against: `query(sql)` with a
 * statement cache, `get()` that answers `null` with no row, booleans bound as 0/1, and `transaction(fn)` with
 * `.immediate()`. Only the long-standing subset of `node:sqlite` is used (`prepare`, `get`, `all`, `run`, `exec`,
 * `close`, `isTransaction`): its API still moves between Node lines.
 */

export type TBindValue = string | number | bigint | boolean | null | Uint8Array;
export type TRow = Record<string, unknown>;

type TNative = sqlite.DatabaseSync;
type TNativeStatement = sqlite.StatementSync;
type TInput = sqlite.SQLInputValue;

// Node 26.11 renamed DatabaseSync to Database and kept the old name as a deprecated alias.
const NativeDatabase: typeof sqlite.DatabaseSync =
  (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;

// Booleans are bindable only from Node 26.8: bound as integers everywhere, as SQLite stores them. A stray
// `undefined` (which node:sqlite refuses) binds as NULL, as it did in bun:sqlite.
function bind(params: readonly TBindValue[]): TInput[] {
  return params.map((p) => (p === true ? 1 : p === false ? 0 : p === undefined ? null : p));
}

/**
 * A read-only connection. A WAL database whose `-shm` file is gone (the last connection deletes it on close) does
 * not open read-only with the SQLite that macOS ships, which Bun uses: there it falls back to a read-write
 * connection that refuses writes (`query_only`). A missing file is never created.
 */
function openReadOnly(path: string): TNative {
  let db: TNative | null = null;
  try {
    db = new NativeDatabase(path, { readOnly: true });
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return db;
  } catch (err) {
    db?.close();
    if (!existsSync(path)) throw err;
  }
  const rw = new NativeDatabase(path);
  rw.exec("PRAGMA query_only = ON");
  return rw;
}

export interface IRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export class Statement {
  readonly #statement: TNativeStatement;

  constructor(statement: TNativeStatement) {
    this.#statement = statement;
  }

  /** The first row, or `null` when there is none. */
  get(...params: TBindValue[]): unknown {
    return this.#statement.get(...bind(params)) ?? null;
  }

  all(...params: TBindValue[]): unknown[] {
    return this.#statement.all(...bind(params));
  }

  run(...params: TBindValue[]): IRunResult {
    return this.#statement.run(...bind(params));
  }
}

export interface IDatabaseOptions {
  /** Opens an existing file without write access; it is never created. */
  readOnly?: boolean;
}

export interface ITransaction<A extends unknown[], R> {
  (...args: A): R;
  /** Takes the write lock at the start (`BEGIN IMMEDIATE`). */
  immediate(...args: A): R;
}

export class Database {
  readonly #db: TNative;
  readonly #cache = new Map<string, Statement>();
  #savepoints = 0;

  /** Creates the file when it does not exist, unless `readOnly`. */
  constructor(path: string, options: IDatabaseOptions = {}) {
    this.#db = options.readOnly ? openReadOnly(path) : new NativeDatabase(path);
  }

  /** A prepared statement, cached by its SQL for the life of the connection. */
  query(sql: string): Statement {
    let statement = this.#cache.get(sql);
    if (!statement) {
      statement = new Statement(this.#db.prepare(sql));
      this.#cache.set(sql, statement);
    }
    return statement;
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  get inTransaction(): boolean {
    return this.#db.isTransaction;
  }

  close(): void {
    this.#cache.clear();
    this.#db.close();
  }

  /**
   * Wraps `fn` in a transaction: committed when it returns, rolled back when it throws. Called inside another
   * transaction it uses a savepoint, as bun:sqlite does.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): ITransaction<A, R> {
    const run = (begin: string, args: A): R => {
      if (this.#db.isTransaction) return this.#savepoint(fn, args);
      this.#db.exec(begin);
      try {
        const value = fn(...args);
        this.#db.exec("COMMIT");
        return value;
      } catch (err) {
        if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
        throw err;
      }
    };
    const tx = ((...args: A) => run("BEGIN", args)) as ITransaction<A, R>;
    tx.immediate = (...args: A) => run("BEGIN IMMEDIATE", args);
    return tx;
  }

  #savepoint<A extends unknown[], R>(fn: (...args: A) => R, args: A): R {
    const name = `wip_sp_${++this.#savepoints}`;
    this.#db.exec(`SAVEPOINT ${name}`);
    try {
      const value = fn(...args);
      this.#db.exec(`RELEASE ${name}`);
      return value;
    } catch (err) {
      this.#db.exec(`ROLLBACK TO ${name}`);
      this.#db.exec(`RELEASE ${name}`);
      throw err;
    } finally {
      this.#savepoints--;
    }
  }
}

/** SQLITE_BUSY and its extended codes, as `node:sqlite` reports them (`errcode`), or bun:sqlite's `code`. */
export function isBusyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { errcode, code } = err as { errcode?: unknown; code?: unknown };
  if (typeof errcode === "number") return (errcode & 0xff) === 5;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/** Blocks the thread for `ms` milliseconds (the WAL retry loop is synchronous by design). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
