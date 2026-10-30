import type { IArgs } from "../args.ts";
import type { ICtx, IHandler } from "../context.ts";
import { EXIT } from "../errors.ts";
import { loadFlows } from "../flow/registry.ts";
import { checkFindings } from "../invariants.ts";
import { noExtra } from "./phase.ts";

function run(ctx: ICtx, args: IArgs): void {
  noExtra(args, 1);
  const id = args.pos[0];
  const db = ctx.readDb;
  const flows = loadFlows(ctx.root, db);
  ctx.result.warnings.push(...flows.warnings);
  const findings = checkFindings(db, flows, id);
  ctx.result.data = { findings };
  if (findings.length === 0) {
    ctx.result.lines.push("OK: no findings");
    return;
  }
  for (const f of findings) ctx.result.lines.push(`${f.code} · ${f.item} · ${f.text}`);
  ctx.result.ok = false;
  ctx.result.code = EXIT.FINDINGS;
}

export const checkCmd: IHandler = { db: "read", run };
