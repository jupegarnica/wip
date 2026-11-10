import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/errors.ts";
import { minimalFlow, putFlow } from "../helpers/defs.ts";
import { ok, useProject, wipJson } from "../helpers/items.ts";
import { type IProject, makeProject } from "../helpers/project.ts";

const ctx = useProject();

function flowProject(name = "flow-order"): IProject {
  const p = ctx.set(makeProject(name));
  for (const flow of ["tasks", "development", "alpha"]) putFlow(p.dir, flow, minimalFlow());
  return p;
}

const configFile = (p: IProject): string => join(p.dir, ".wip", "config.json");

const putConfig = (p: IProject, value: Record<string, unknown>): void =>
  writeFileSync(configFile(p), `${JSON.stringify(value, null, 2)}\n`);

const raw = (p: IProject): Record<string, unknown> =>
  JSON.parse(readFileSync(configFile(p), "utf8")) as Record<string, unknown>;

describe("wip flow order", () => {
  test("it prints the current order; without flow_order the board is alphabetical", () => {
    const p = flowProject();
    expect(p.wip(["flow", "order"]).stdout).toBe("no flow_order: the board is alphabetical\n");
    const { code, body } = wipJson(p, ["flow", "order"]);
    expect(code).toBe(EXIT.OK);
    expect(body.data).toEqual({ flow_order: [] });
  });

  test("it sets the order, first = first on the board, and keeps the rest of the config", () => {
    const p = flowProject();
    putConfig(p, {
      defs_dir: ".claude",
      wip_bin: "node_modules/.bin/wip",
      start: ["claude", "--agent", "wip"],
    });
    const body = ok(p, ["flow", "order", "tasks", "development"]);
    expect(body.data).toEqual({ flow_order: ["tasks", "development"] });
    expect(p.wip(["flow", "order"]).stdout).toBe("flow order: tasks development\n");
    expect(raw(p)).toEqual({
      defs_dir: ".claude",
      wip_bin: "node_modules/.bin/wip",
      start: ["claude", "--agent", "wip"],
      flow_order: ["tasks", "development"],
    });
  });

  test("an unknown name exits 4 and writes nothing", () => {
    const p = flowProject();
    const { code, body } = wipJson(p, ["flow", "order", "tasks", "nope"]);
    expect(code).toBe(EXIT.NOT_FOUND);
    expect(body.message).toContain("flow not found: nope");
    expect(existsSync(configFile(p))).toBe(false);
  });

  test("a repeated name exits 2", () => {
    const p = flowProject();
    expect(wipJson(p, ["flow", "order", "tasks", "tasks"]).code).toBe(EXIT.USAGE);
    expect(existsSync(configFile(p))).toBe(false);
  });

  test("a disabled flow or one failing lint still counts as a flow", () => {
    const p = flowProject();
    putFlow(p.dir, "broken", "```wip-flow\nversion: 1\nphases: []\n```\n");
    ok(p, ["flow", "disable", "tasks"]);
    const body = ok(p, ["flow", "order", "tasks", "broken"]);
    expect(body.data).toEqual({ flow_order: ["tasks", "broken"] });
  });

  test("--reset removes the key and the order is empty", () => {
    const p = flowProject();
    ok(p, ["flow", "order", "tasks", "development"]);
    const body = ok(p, ["flow", "order", "--reset"]);
    expect(body.data).toEqual({ flow_order: [] });
    expect(p.wip(["flow", "order", "--reset"]).stdout).toBe(
      "flow order reset: the board is alphabetical\n",
    );
    expect(Object.keys(raw(p))).not.toContain("flow_order");
    expect(raw(p)).toEqual({ defs_dir: ".claude" });
  });

  test("--reset takes no flow names", () => {
    const p = flowProject();
    expect(wipJson(p, ["flow", "order", "--reset", "tasks"]).code).toBe(EXIT.USAGE);
  });

  test("reading warns about a configured name that is not a flow, and prints it", () => {
    const p = flowProject();
    putConfig(p, { defs_dir: ".claude", flow_order: ["tasks", "ghost"] });
    const { code, body } = wipJson(p, ["flow", "order"]);
    expect(code).toBe(EXIT.OK);
    expect(body.data).toEqual({ flow_order: ["tasks", "ghost"] });
    expect(body.warnings.map((w) => w.code)).toContain("flow_order_unknown");
    expect(p.wip(["flow", "order"]).stdout).toContain("flow order: tasks ghost");
  });

  test("a malformed flow_order warns and --reset repairs it", () => {
    const p = flowProject();
    putConfig(p, { defs_dir: ".claude", flow_order: "tasks" });
    const { code, body } = wipJson(p, ["flow", "order"]);
    expect(code).toBe(EXIT.OK);
    expect(body.data).toEqual({ flow_order: [] });
    expect(body.warnings.map((w) => w.code)).toContain("flow_order_invalid");
    ok(p, ["flow", "order", "--reset"]);
    expect(Object.keys(raw(p))).not.toContain("flow_order");
  });
});
