import type { IArgs } from "../args.ts";
import type { ICtx, IHandler } from "../context.ts";
import { FLOW_SKILL_PREFIX, flowPath } from "../env.ts";
import { EXIT, notFound, rejected, usage } from "../errors.ts";
import { disabledMessage, loadFlows } from "../flow/registry.ts";

function lint(ctx: ICtx, args: IArgs): void {
  const [, only, extra] = args.pos;
  if (extra !== undefined) throw usage("usage: wip flow lint [<flow>]");
  const set = loadFlows(ctx.root, ctx.readDb);
  if (only !== undefined && set.disabled.has(only)) throw rejected(disabledMessage(only));
  if (only !== undefined && !set.entries.has(only)) {
    throw notFound(`flow not found: ${only} (no ${flowPath(ctx.root.defsDir, only)})`);
  }
  const selected = [...set.entries.values()]
    .filter((e) => only === undefined || e.name === only)
    .sort((a, b) => a.name.localeCompare(b.name));
  const flows = selected.map((e) => ({
    name: e.name,
    path: e.path,
    ok: e.problems.length === 0,
    hash: e.source === "file" ? (e.flow?.hash ?? null) : null,
    using: e.source,
    stored: e.stored,
    problems: e.problems,
  }));
  for (const f of flows) {
    if (f.ok) ctx.result.lines.push(`OK ${f.name}`);
    else for (const problem of f.problems) ctx.result.lines.push(`${f.name} · ${problem}`);
  }
  if (flows.length === 0 && set.disabled.size === 0) {
    ctx.result.lines.push(`no flows in ${ctx.root.defsDir}/skills/${FLOW_SKILL_PREFIX}*/SKILL.md`);
  }
  const disabled = only === undefined ? [...set.disabled.keys()].sort() : [];
  for (const name of disabled) ctx.result.lines.push(`DISABLED ${name}`);
  ctx.result.warnings.push(...set.warnings.filter((w) => selected.some((e) => e.name === w.flow)));
  ctx.result.data = { flows, disabled };
  if (flows.some((f) => !f.ok)) {
    ctx.result.ok = false;
    ctx.result.code = EXIT.FINDINGS;
  }
}

function toggle(disabled: boolean): (ctx: ICtx, args: IArgs) => void {
  const verb = disabled ? "disable" : "enable";
  return (ctx, args) => {
    const [, name, extra] = args.pos;
    if (name === undefined || extra !== undefined) throw usage(`usage: wip flow ${verb} <flow>`);
    // A valid file is recorded as the flow's version first: only a flow with a stored version has a row to flag.
    loadFlows(ctx.root, ctx.db, { write: true });
    const changed = ctx.db
      .query("UPDATE flows SET disabled = ? WHERE name = ?")
      .run(disabled ? 1 : 0, name).changes;
    if (changed === 0) throw notFound(`flow not found: ${name} (no valid version recorded)`);
    ctx.result.data = { flow: name, disabled };
    ctx.result.lines.push(
      disabled
        ? `${name} · disabled · enable it with wip flow enable ${name}`
        : `${name} · enabled`,
    );
  };
}

/** `lint` reads; `disable` and `enable` write. cli.ts picks the handler by sub-command. */
export const FLOW_HANDLERS: Readonly<Record<string, IHandler>> = {
  lint: { db: "read", run: lint },
  disable: { db: "write", run: toggle(true) },
  enable: { db: "write", run: toggle(false) },
};

export const flowCmd: IHandler = {
  db: "none",
  run: () => {
    throw usage("usage: wip flow lint [<flow>] · wip flow disable <flow> · wip flow enable <flow>");
  },
};
