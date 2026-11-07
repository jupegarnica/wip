import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { compact } from "./clock.ts";
import { MIGRATIONS } from "./embedded/migrations.ts";
import { dbError, WipError } from "./errors.ts";
import { Database, isBusyError, sleepSync } from "./sqlite.ts";

export const SCHEMA_VERSION = MIGRATIONS.length;
export const MIN_SQLITE_VERSION = "3.37.0";
export const BUSY_TIMEOUT_MS = 5000;
const WAL_RETRY_MS = 10;

export type TDatabase = Database;

export interface IOpenOptions {
  /** Replaces the `sqlite_version()` probe (tests simulate an old library). */
  sqliteVersion?: () => string;
}

export function sqliteLibraryVersion(): string {
  const probe = new Database(":memory:");
  try {
    return (probe.query("SELECT sqlite_version() AS v").get() as { v: string }).v;
  } finally {
    probe.close();
  }
}

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

export function isSupportedSqlite(version: string): boolean {
  const have = versionParts(version);
  const need = versionParts(MIN_SQLITE_VERSION);
  for (let i = 0; i < need.length; i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

// macOS links the system SQLite, whose version follows the OS: an old one fails here, not mid-command.
function assertSqlite(options: IOpenOptions): void {
  const version = (options.sqliteVersion ?? sqliteLibraryVersion)();
  if (!isSupportedSqlite(version)) {
    throw dbError(`SQLite ${version} is too old: wip needs ${MIN_SQLITE_VERSION} or later`);
  }
}

function journalMode(db: Database): string {
  return (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
}

// Switching a new file to WAL needs an exclusive lock, and SQLite answers SQLITE_BUSY at once
// without calling the busy handler when another process is creating it too: retried by hand.
function enableWal(db: Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      if (journalMode(db) === "wal") return;
      db.exec("PRAGMA journal_mode = WAL");
    } catch (err) {
      if (!isBusyError(err)) throw err;
    }
    if (Date.now() >= deadline) {
      throw dbError(
        `cannot switch the database to WAL within ${BUSY_TIMEOUT_MS} ms: it stays locked`,
      );
    }
    sleepSync(WAL_RETRY_MS);
  }
}

function configure(db: Database): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  enableWal(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
}

export function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

export function migrate(db: Database): number {
  const current = userVersion(db);
  if (current > SCHEMA_VERSION) {
    throw dbError(
      `the database is at schema ${current}; this wip only knows up to ${SCHEMA_VERSION}`,
    );
  }
  for (let version = current; version < SCHEMA_VERSION; version++) {
    const [, sql] = MIGRATIONS[version] as readonly [string, string];
    db.transaction(() => {
      // Re-checked inside the write lock: another process may have migrated meanwhile.
      if (userVersion(db) !== version) return;
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    }).immediate();
  }
  return userVersion(db);
}

/**
 * Before a migration, a copy of the database as it is (`VACUUM INTO`) goes to `.wip/backups/db/`, named after its
 * schema, the time and the process, so a rollback to the older wip can restore it. A new database is not copied.
 * Returns the copy's path, or null when nothing was migrated.
 */
export function backupBeforeMigrate(db: Database, path: string): string | null {
  const current = userVersion(db);
  if (current === 0 || current >= SCHEMA_VERSION) return null;
  const dir = join(dirname(path), "backups", "db");
  const target = join(dir, `wip.sqlite.v${current}.${compact()}.${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } catch (err) {
    // VACUUM INTO leaves a partial target on failure; it must never pass for a backup.
    try {
      rmSync(target, { force: true });
    } catch {}
    const { code, message } = err as { code?: unknown; message: string };
    const suffix = typeof code === "string" ? ` (${code})` : "";
    throw dbError(
      `cannot back up the database before migrating it to ${target}: ${message}${suffix}; free disk space or remove ${dir}`,
    );
  }
  return target;
}

/** Opens the database at `path`, creating and migrating it when needed. */
export function openDb(path: string, options: IOpenOptions = {}): Database {
  assertSqlite(options);
  let db: Database | null = null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    db = new Database(path);
    configure(db);
    backupBeforeMigrate(db, path);
    migrate(db);
    return db;
  } catch (err) {
    db?.close();
    if (err instanceof WipError) throw err;
    const { code, message } = err as { code?: unknown; message: string };
    const suffix = typeof code === "string" ? ` (${code})` : "";
    throw dbError(`cannot open the database ${path}: ${message}${suffix}`);
  }
}

/** For readers: `null` when the database does not exist yet, which is never created here. */
export function openForRead(path: string, options: IOpenOptions = {}): Database | null {
  if (!existsSync(path)) return null;
  const db = openDb(path, options);
  db.exec("PRAGMA query_only = ON");
  return db;
}
