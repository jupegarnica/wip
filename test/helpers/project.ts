import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IRunOptions, type IRunOutput, run } from "../../src/cli.ts";
import { setClockForTests } from "../../src/clock.ts";
import type { TEnv } from "../../src/env.ts";

/** A scratch directory under the OS temp dir; never a real project nor `~/.agents`. */
export function scratch(name: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `wip-test-${name}-`)));
}

export interface IProject {
  dir: string;
  dbPath: string;
  wip: (argv: readonly string[], options?: IRunOptions) => IRunOutput;
  json: (argv: readonly string[], options?: IRunOptions) => Record<string, unknown>;
  db: () => Database;
  cleanup: () => void;
}

/** A project with an empty `.wip/`, run in-process with its own cwd and an empty environment. */
export function makeProject(name: string, env: TEnv = {}): IProject {
  const dir = scratch(name);
  mkdirSync(join(dir, ".wip"));
  setClockForTests(null);
  const wip = (argv: readonly string[], options: IRunOptions = {}): IRunOutput =>
    run(argv, { cwd: dir, env, ...options });
  return {
    dir,
    dbPath: join(dir, ".wip", "wip.sqlite"),
    wip,
    json: (argv, options) =>
      JSON.parse(wip([...argv, "--json"], options).stdout) as Record<string, unknown>,
    db: () => new Database(join(dir, ".wip", "wip.sqlite"), { readonly: true }),
    cleanup: () => {
      setClockForTests(null);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function count(db: Database, sql: string): number {
  return (db.query(sql).get() as { n: number }).n;
}
