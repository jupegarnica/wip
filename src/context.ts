import type { IArgs } from "./args.ts";
import type { TDatabase } from "./db.ts";
import type { IRoot, TEnv } from "./env.ts";
import type { TExitCode } from "./errors.ts";

export interface IWarning {
  code: string;
  message: string;
  [key: string]: unknown;
}

/** The post-upgrade definitions question main() asks with the installed build; never part of the JSON envelope. */
export interface IDefsAfterInstall {
  project: string;
  root: string | null;
  entry: string | null;
}

/** A main()-level step a handler leaves for after its output; never part of the JSON envelope. */
export interface IAfterRun {
  defsAfterInstall?: IDefsAfterInstall;
}

export interface IResult {
  ok: boolean;
  code: TExitCode;
  item: Record<string, unknown> | null;
  events: Record<string, unknown>[];
  warnings: IWarning[];
  message: string | null;
  data: unknown;
  /** Text-mode output; `--json` prints the envelope instead. */
  lines: string[];
  /** A step main() runs after writing the output; never in `envelope()`. */
  after?: IAfterRun;
}

export interface IEnvelope {
  ok: boolean;
  item: Record<string, unknown> | null;
  events: Record<string, unknown>[];
  warnings: IWarning[];
  message: string | null;
  data: unknown;
}

/** `write`: one IMMEDIATE transaction, database created on first use · `read`: never creates it. */
export type TDbMode = "write" | "read" | "none";

export interface ICtx {
  readonly result: IResult;
  readonly cwd: string;
  readonly env: TEnv;
  /** Throws exit 4 when there is no `.wip/`. Resolved on first access, after argument validation. */
  readonly root: IRoot;
  /** Only for `write` commands. */
  readonly db: TDatabase;
  /** Only for `read` commands; `null` while the database does not exist. */
  readonly readDb: TDatabase | null;
  /** main() has a terminal and has not asked the definitions question: a handler may leave it to main(). */
  readonly interactive: boolean;
}

export interface IHandler {
  db: TDbMode;
  run: (ctx: ICtx, args: IArgs) => void;
}

export function newResult(): IResult {
  return {
    ok: true,
    code: 0,
    item: null,
    events: [],
    warnings: [],
    message: null,
    data: null,
    lines: [],
  };
}

export function envelope(result: IResult): IEnvelope {
  const { ok, item, events, warnings, message, data } = result;
  return { ok, item, events, warnings, message, data };
}
