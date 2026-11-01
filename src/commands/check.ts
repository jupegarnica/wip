import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { hasCoordinatorMark, hasGenericMark, listAgents, modelsUnset } from "../agents.ts";
import type { IArgs } from "../args.ts";
import { now } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import { GENERIC_AGENTS } from "../embedded/templates.ts";
import type { IRoot } from "../env.ts";
import { EXIT } from "../errors.ts";
import { loadFlows } from "../flow/registry.ts";
import { checkFindings } from "../invariants.ts";
import { pollRows } from "../poll.ts";
import { noExtra } from "./phase.ts";

interface IAgentFinding {
  code: "agent_invalid";
  agent: string;
  path: string;
  text: string;
}

const genericNames = new Set<string>(GENERIC_AGENTS);

// The coordinator counts only by its mark: a foreign `wip.md` is not wip's to judge.
function isOwnAgent(name: string, source: string): boolean {
  return genericNames.has(name) || hasGenericMark(source) || hasCoordinatorMark(source);
}

function agentFindings(root: IRoot): IAgentFinding[] {
  return listAgents(root.agents)
    .filter((a) => a.problems.length > 0)
    .filter((a) => isOwnAgent(a.name, readFileSync(a.file, "utf8")))
    .map((a) => ({
      code: "agent_invalid",
      agent: a.name,
      path: relative(root.project, a.file).split("\\").join("/"),
      text: a.problems.join("; "),
    }));
}

function run(ctx: ICtx, args: IArgs): void {
  noExtra(args, 1);
  const id = args.pos[0];
  const db = ctx.readDb;
  const flows = loadFlows(ctx.root, db);
  ctx.result.warnings.push(...flows.warnings);
  const unset = modelsUnset(ctx.root.agents);
  if (unset.length > 0) {
    ctx.result.warnings.push({
      code: "models_unset",
      message: `agents without model: ${unset.join(", ")}; the coordinator asks for them on its first run`,
      agents: unset,
    });
  }
  // An overdue poll is a scheduler problem, not an item invariant: a warning, never a finding.
  if (id === undefined) {
    for (const p of pollRows(db, flows, now()).filter((r) => r.overdue)) {
      ctx.result.warnings.push({
        code: "poll_overdue",
        message: `poll ${p.flow}/${p.poll} is overdue since ${p.overdue_at} (last pass ${p.last_run ?? "never"}, every ${p.cadence})`,
        flow: p.flow,
        poll: p.poll,
        last_run: p.last_run,
        overdue_at: p.overdue_at,
      });
    }
  }
  const findings = [
    ...checkFindings(db, flows, id),
    ...(id === undefined ? agentFindings(ctx.root) : []),
  ];
  ctx.result.data = { findings };
  if (findings.length === 0) {
    ctx.result.lines.push("OK: no findings");
    return;
  }
  for (const f of findings) {
    ctx.result.lines.push(`${f.code} · ${"item" in f ? f.item : f.path} · ${f.text}`);
  }
  ctx.result.ok = false;
  ctx.result.code = EXIT.FINDINGS;
}

export const checkCmd: IHandler = { db: "read", run };
