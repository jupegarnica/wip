import { iso } from "../../src/clock.ts";
import type { ICommandSpec } from "../../src/commands/help.ts";
import type { IHandler } from "../../src/context.ts";
import { rejected } from "../../src/errors.ts";

// Stand-in commands for the core: H1 ships no command that touches the database yet.

const spec = (name: string, options: string[] = [], flags: string[] = []): ICommandSpec => ({
  name,
  summary: `test probe ${name}`,
  usage: [`wip ${name}`],
  options,
  flags,
});

/** Writes one session (and its event) per call; `--fail rejected|crash` throws after writing. */
export const probeWrite = {
  spec: spec("probe-write", ["fail"], ["warn"]),
  handler: {
    db: "write",
    run: (ctx, args) => {
      const id = args.pos[0] ?? "s1";
      const ts = iso();
      ctx.db.query("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run(id, ts);
      ctx.db
        .query("INSERT INTO events (ts, kind, text) VALUES (?, 'session', ?)")
        .run(ts, `session ${id}`);
      ctx.result.events.push({ kind: "session", ts, text: `session ${id}` });
      if (args.flags.has("warn")) ctx.result.warnings.push({ code: "probe", message: "careful" });
      if (args.opts.fail === "rejected") throw rejected("probe rejected the write");
      if (args.opts.fail === "crash") throw new Error("probe crashed");
      ctx.result.message = `session ${id} started`;
      ctx.result.data = { id, ts };
    },
  } satisfies IHandler,
};

export const probeRead = {
  spec: spec("probe-read"),
  handler: {
    db: "read",
    run: (ctx) => {
      const db = ctx.readDb;
      const sessions = db
        ? (db.query("SELECT count(*) AS n FROM sessions").get() as { n: number }).n
        : null;
      ctx.result.data = { exists: db !== null, sessions };
    },
  } satisfies IHandler,
};

export const probeRoot = {
  spec: spec("probe-root"),
  handler: {
    db: "none",
    run: (ctx) => {
      ctx.result.data = { project: ctx.root.project, db: ctx.root.db };
    },
  } satisfies IHandler,
};

export const PROBES = [probeWrite, probeRead, probeRoot];
