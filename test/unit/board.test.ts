import { describe, expect, test } from "bun:test";
import {
  boardFlows,
  composite,
  flowColumns,
  type IColumn,
  NO_PAINT,
  paintOf,
  STAGE_ALPHA_FIRST,
  STAGE_ALPHA_LAST,
  STAGE_TONE,
  SURFACE_DARK,
  SURFACE_LIGHT,
  stageAlpha,
  stageColor,
  stagePaint,
  textOn,
} from "../../src/board.ts";
import type { IFlow } from "../../src/flow/parse.ts";
import { parseFlow } from "../../src/flow/parse.ts";
import type { IFlowEntry, IFlowSet, TFlowSource } from "../../src/flow/registry.ts";

function flow(name: string, text: string): IFlow {
  const parsed = parseFlow(name, text);
  expect(parsed.problems).toEqual([]);
  return parsed.flow as IFlow;
}

function flowSet(
  entries: readonly { name: string; text: string; source?: TFlowSource }[],
): IFlowSet {
  const map = new Map<string, IFlowEntry>();
  for (const e of entries) {
    map.set(e.name, {
      name: e.name,
      path: `.claude/skills/wip-flow-${e.name}/SKILL.md`,
      problems: [],
      source: e.source ?? "file",
      flow: flow(e.name, e.text),
      stored: null,
    });
  }
  return { entries: map, warnings: [], disabled: new Map(), defsDir: ".claude" };
}

const THREE_STAGES = [
  "```wip-flow",
  "version: 1",
  "phases:",
  "  - name: intake",
  "    stage: todo",
  "  - name: plan",
  "    stage: doing",
  "  - name: execute",
  "    stage: doing",
  "  - name: done",
  "    stage: closed",
  "    kind: terminal",
  "```",
  "",
].join("\n");

const NO_STAGES = [
  "```wip-flow",
  "version: 1",
  "phases:",
  "  - name: todo",
  "  - name: done",
  "    kind: terminal",
  "```",
  "",
].join("\n");

describe("the board model (data.board)", () => {
  test("three stages step 1, 0.63 and 0.25, grouping the phases of a stage in one column", () => {
    const columns = flowColumns(flow("dev", THREE_STAGES));
    expect(columns.map((c) => [c.key, c.phases, c.alpha])).toEqual([
      ["stage:todo", ["intake"], 1],
      ["stage:doing", ["plan", "execute"], 0.63],
      ["stage:closed", ["done"], 0.25],
    ]);
    expect(columns.map((c) => c.color)).toEqual([
      stageColor(1),
      stageColor(0.63),
      stageColor(0.25),
    ]);
  });

  test("a one-stage flow stays opaque; a flow without stages has no colour", () => {
    const one = flowColumns(
      flow(
        "one",
        "```wip-flow\nversion: 1\nphases:\n  - name: todo\n    stage: only\n  - name: done\n    stage: only\n    kind: terminal\n```\n",
      ),
    );
    expect(one.map((c) => [c.alpha, c.color])).toEqual([[STAGE_ALPHA_FIRST, stageColor(1)]]);

    const none = flowColumns(flow("plain", NO_STAGES));
    expect(none.map((c) => [c.key, c.label, c.stage])).toEqual([
      ["phase:todo", "todo", null],
      ["phase:done", "done", null],
    ]);
    for (const c of none) expect(c).toMatchObject(NO_PAINT);
  });

  test("a custom tone paints every stage in it", () => {
    const gold = flowColumns(
      flow("gold", THREE_STAGES.replace("version: 1\n", 'version: 1\ncolor: "#eab308"\n')),
    );
    expect(gold.map((c) => c.color)).toEqual([
      stageColor(1, "#EAB308"),
      stageColor(0.63, "#EAB308"),
      stageColor(0.25, "#EAB308"),
    ]);
    expect(STAGE_TONE).toBe("#2563EB");
  });

  test("each stage carries both themes' solid colour and the text that contrasts with it", () => {
    const columns = flowColumns(flow("dev", THREE_STAGES));
    for (const c of columns) {
      expect(c.color_light).toBe(composite(STAGE_TONE, c.alpha as number, SURFACE_LIGHT));
      expect(c.color_dark).toBe(composite(STAGE_TONE, c.alpha as number, SURFACE_DARK));
      expect(c.text).toBe(textOn(c.color_light));
      expect(c.text_dark).toBe(textOn(c.color_dark));
    }
    expect(columns[0]).toMatchObject({ color_light: "#2563EB", text: "#FFFFFF" });
    expect(columns[2]).toMatchObject({
      color_light: composite(STAGE_TONE, 0.25, SURFACE_LIGHT),
      text: "#111111",
    });
    const paint = stagePaint(0.5, "#EAB308");
    expect(paint).toEqual({
      alpha: 0.5,
      color: "rgba(234, 179, 8, 0.5)",
      color_light: composite("#EAB308", 0.5, SURFACE_LIGHT),
      color_dark: composite("#EAB308", 0.5, SURFACE_DARK),
      text: textOn(composite("#EAB308", 0.5, SURFACE_LIGHT)),
      text_dark: textOn(composite("#EAB308", 0.5, SURFACE_DARK)),
    });
  });

  test("paintOf copies a column's paint, and an absent column is NO_PAINT", () => {
    const column = flowColumns(flow("dev", THREE_STAGES))[1] as IColumn;
    expect(paintOf(column)).toEqual({
      alpha: column.alpha,
      color: column.color,
      color_light: column.color_light,
      color_dark: column.color_dark,
      text: column.text,
      text_dark: column.text_dark,
    });
    expect(paintOf(undefined)).toEqual(NO_PAINT);
    expect(NO_PAINT).toMatchObject({ alpha: null, color: "", color_light: "", color_dark: "" });
  });

  test("boardFlows lists every enabled flow plus item flows, sorted, with the declared phases", () => {
    const flows = flowSet([
      { name: "valid", text: THREE_STAGES },
      { name: "empty", text: NO_STAGES, source: "stored" },
    ]);
    const board = boardFlows(flows, [
      { flow: "valid", phase: "plan" },
      { flow: "ghost", phase: "todo" },
    ]);
    expect(board.map((f) => [f.name, f.source])).toEqual([
      ["empty", "stored"],
      ["ghost", null],
      ["valid", "file"],
    ]);
    expect(board.find((f) => f.name === "valid")?.phases).toEqual([
      "intake",
      "plan",
      "execute",
      "done",
    ]);
    expect(board.find((f) => f.name === "ghost")?.columns.map((c) => c.key)).toEqual([
      "phase:todo",
    ]);
  });

  test("a phase only an item uses is a colourless extra column, outside phases", () => {
    const flows = flowSet([{ name: "valid", text: THREE_STAGES }]);
    const board = boardFlows(flows, [
      { flow: "valid", phase: "plan" },
      { flow: "valid", phase: "retired" },
    ]);
    const valid = board[0];
    expect(valid?.phases).toEqual(["intake", "plan", "execute", "done"]);
    const extra = valid?.columns.at(-1);
    expect(extra).toMatchObject({ key: "phase:retired", stage: null, alpha: null, color: "" });
    expect(extra?.color_light).toBe("");
    expect(extra?.color_dark).toBe("");
  });

  test("stageAlpha steps evenly and stageColor renders the rgba", () => {
    expect(stageAlpha(0, 1)).toBe(1);
    expect([0, 1].map((i) => stageAlpha(i, 2))).toEqual([1, 0.25]);
    expect([0, 1, 2, 3, 4].map((i) => stageAlpha(i, 5))).toEqual([1, 0.81, 0.63, 0.44, 0.25]);
    expect(stageAlpha(6, 7)).toBe(STAGE_ALPHA_LAST);
    expect(stageColor(0.5)).toBe("rgba(37, 99, 235, 0.5)");
    expect(composite(STAGE_TONE, 0, SURFACE_DARK)).toBe(SURFACE_DARK);
  });
});
