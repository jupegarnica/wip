import type { IHandler } from "../context.ts";
import { EXIT, notFound, usage } from "../errors.ts";
import { loadFlows } from "../flow/registry.ts";

export const flowCmd: IHandler = {
  db: "read",
  run: (ctx, args) => {
    const [sub, only, extra] = args.pos;
    if (sub !== "lint" || extra !== undefined) throw usage("usage: wip flow lint [<flow>]");
    const set = loadFlows(ctx.root, ctx.readDb);
    if (only !== undefined && !set.entries.has(only)) {
      throw notFound(`flow not found: ${only} (no .agents/flows/${only}.md)`);
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
    if (flows.length === 0) ctx.result.lines.push("no flows in .agents/flows/");
    ctx.result.warnings.push(
      ...set.warnings.filter((w) => selected.some((e) => e.name === w.flow)),
    );
    ctx.result.data = { flows };
    if (flows.some((f) => !f.ok)) {
      ctx.result.ok = false;
      ctx.result.code = EXIT.FINDINGS;
    }
  },
};
