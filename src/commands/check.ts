import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { hasCoordinatorMark, hasGenericMark, listAgents, modelsUnset } from "../agents.ts";
import type { IArgs } from "../args.ts";
import { now } from "../clock.ts";
import { readStart } from "../config.ts";
import type { ICtx, IHandler } from "../context.ts";
import { cronId, cronRows, GRACE_S } from "../cron.ts";
import { GENERIC_AGENTS } from "../embedded/templates.ts";
import type { IRoot } from "../env.ts";
import { EXIT } from "../errors.ts";
import { loadFlows } from "../flow/registry.ts";
import { checkFindings } from "../invariants.ts";
import { pollRows } from "../poll.ts";
import { localMinute } from "../when.ts";
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
      path: `${root.defsDir}/agents/${basename(a.file)}`,
      text: a.problems.join("; "),
    }));
}

/** `start_unset`: the coordinator proposes the start command; `start_invalid`: the key is there and is not valid. */
function startWarning(ctx: ICtx): void {
  try {
    if (readStart(ctx.root.project) === null) {
      ctx.result.warnings.push({
        code: "start_unset",
        message:
          "no start command in .wip/config.json: run `wip init` or `wip start --set -- <command>` (the default start command applies meanwhile)",
      });
    }
  } catch (err) {
    ctx.result.warnings.push({
      code: "start_invalid",
      message: err instanceof Error ? err.message : String(err),
    });
  }
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
      message: `agents without model: ${unset.join(", ")}; add a \`model:\` line to each agent file (ask the coordinator: «Changing a model» in wip-coordinate)`,
      agents: unset,
    });
  }
  startWarning(ctx);
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
  // A cron past its time nobody marked, or tied to an archived item: warnings too, the exit code does not change.
  if (id === undefined) {
    const late = now().getTime() - GRACE_S * 1000;
    for (const c of cronRows(db)) {
      const what = c.kind === "reminder" ? c.text : `poll ${c.flow}/${c.poll}`;
      const when = localMinute(new Date(c.at)).at_local;
      if (Date.parse(c.at) < late) {
        ctx.result.warnings.push({
          code: "cron_due",
          message: `cron ${cronId(c)} is due since ${when} · ${what}: \`wip cron done|cancel|snooze ${cronId(c)}\``,
          id: cronId(c),
          at: c.at,
        });
      }
      if (c.item_id !== null) {
        const item = db?.query("SELECT status FROM items WHERE id = ?").get(c.item_id) as {
          status: string;
        } | null;
        if (item?.status === "archived") {
          ctx.result.warnings.push({
            code: "cron_item_closed",
            message: `cron ${cronId(c)} (${when} · ${what}) is tied to ${c.item_id}, which is archived`,
            id: cronId(c),
            item: c.item_id,
          });
        }
      }
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
