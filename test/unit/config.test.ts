import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, readConfig, readFlowOrder, writeConfig } from "../../src/config.ts";

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "wip-config-"));
  mkdirSync(join(project, ".wip"));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const put = (obj: unknown) => writeFileSync(configPath(project), JSON.stringify(obj));
const raw = () => JSON.parse(readFileSync(configPath(project), "utf8")) as Record<string, unknown>;

test("wip_bin defaults to null", () => {
  put({ defs_dir: ".claude" });
  expect(readConfig(project)?.wip_bin).toBeNull();
});

test("wip_bin is read and round-trips through writeConfig", () => {
  put({ defs_dir: ".claude", wip_bin: "node_modules/.bin/wip" });
  const cfg = readConfig(project);
  expect(cfg?.wip_bin).toBe("node_modules/.bin/wip");
  if (cfg) writeConfig(project, cfg);
  expect(readConfig(project)?.wip_bin).toBe("node_modules/.bin/wip");
});

test("a null wip_bin is not written", () => {
  writeConfig(project, { defs_dir: ".claude", wip_bin: null });
  expect(Object.keys(raw())).not.toContain("wip_bin");
});

test("an empty or non-string wip_bin is rejected", () => {
  put({ defs_dir: ".claude", wip_bin: "  " });
  expect(() => readConfig(project)).toThrow(/wip_bin/);
  put({ defs_dir: ".claude", wip_bin: 3 });
  expect(() => readConfig(project)).toThrow(/wip_bin/);
});

test("the default definitions folder is .claude", () => {
  writeConfig(project, {});
  expect(readConfig(project)?.defs_dir).toBe(".claude");
  expect(raw().defs_dir).toBe(".claude");
});

test("a legacy harness key is ignored by readConfig and dropped by writeConfig", () => {
  put({ defs_dir: ".agents", harness: "codex", wip_bin: null });
  expect(readConfig(project)).toEqual({ defs_dir: ".agents", wip_bin: null });
  writeConfig(project, { defs_dir: ".agents", wip_bin: null });
  expect(raw()).toEqual({ defs_dir: ".agents" });
});

test("flow_order is absent by default, and an empty array or null is the same as absent", () => {
  expect(readFlowOrder(project)).toEqual({ order: [], problem: null });
  put({ defs_dir: ".claude", flow_order: [] });
  expect(readFlowOrder(project)).toEqual({ order: [], problem: null });
  put({ defs_dir: ".claude", flow_order: null });
  expect(readFlowOrder(project)).toEqual({ order: [], problem: null });
});

test("flow_order round-trips through writeConfig, and null removes the key", () => {
  writeConfig(project, { flow_order: ["tasks", "development"] });
  expect(readFlowOrder(project)).toEqual({ order: ["tasks", "development"], problem: null });
  writeConfig(project, { flow_order: null });
  expect(readFlowOrder(project).order).toEqual([]);
  expect(Object.keys(raw())).not.toContain("flow_order");
});

test("a malformed flow_order is not an error: an empty order plus a problem", () => {
  for (const bad of ["tasks", [""], [1], ["a", "a"], {}]) {
    put({ defs_dir: ".claude", flow_order: bad });
    const read = readFlowOrder(project);
    expect(read.order).toEqual([]);
    expect(read.problem).toContain("flow_order");
  }
});

test("writeConfig keeps flow_order and the other keys of the config", () => {
  put({ defs_dir: ".claude", wip_bin: "node_modules/.bin/wip", flow_order: ["tasks"] });
  writeConfig(project, { start: ["claude"] });
  expect(raw()).toEqual({
    defs_dir: ".claude",
    wip_bin: "node_modules/.bin/wip",
    flow_order: ["tasks"],
    start: ["claude"],
  });
});
