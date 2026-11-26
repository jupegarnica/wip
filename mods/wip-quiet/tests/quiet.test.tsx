import type { On, RenderComponent, RenderPropsOf, RenderSurface } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";

const PLUGIN = "wip-quiet";
const EVERY_SURFACE = ["terminal", "desktop", "vscode", "mobile"] as const;
const TERMINAL_AND_DESKTOP = ["terminal", "desktop"] as const;
const TERMINAL_ONLY = ["terminal"] as const;

type TCapture = { toasts: string[] };

// The test's hooks stand for the engine: whatever reaches them is drawn as the engine's own row.
const engineBeneath = (on: On, store: Record<string, unknown> = {}): TCapture => {
  const capture: TCapture = { toasts: [] };
  mock.store(on, store);
  on("ui.render", ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    if (e.component === "ToolProgress") return <Text>{`engine:${e.props.hint}`}</Text>;
    if (e.component === "ToolGroup" && e.props.isExpanded) {
      return (
        <Box>
          <Text>engine</Text>
          <Text>per-call rows</Text>
        </Box>
      );
    }
    return <Text>engine</Text>;
  });
  on("ui.toast", (_$, e) => {
    capture.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.log", () => ({ value: undefined }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  return capture;
};

const isEngineDrawn = async <C extends RenderComponent>(
  $: Engine,
  surface: RenderSurface,
  component: C,
  props: RenderPropsOf[C],
) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component, props });
  const found = await ui.find({ text: "engine" });
  await ui.unmount();
  return found !== undefined;
};

const quiet = ($: Engine, args: string) =>
  $.command.run({
    command: "wip-quiet",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: 120 },
  });

const toolUse = (
  tool: string,
  flags: Partial<RenderPropsOf["ToolUse"]> = {},
): RenderPropsOf["ToolUse"] => ({
  tool_use_id: "toolu_1",
  tool,
  input: {},
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: "",
  ...flags,
});

const toolResult = (tool: string, isErrored = false): RenderPropsOf["ToolResult"] => ({
  tool_use_id: "toolu_1",
  tool,
  output: "",
  isErrored,
});

const userMessage = (
  kind:
    | "composer"
    | "bridge"
    | "peer"
    | "peer-send-message"
    | "task-notification"
    | "scheduled-trigger",
  isExpanded = false,
): RenderPropsOf["UserMessage"] => ({ text: "hola", origin: { kind }, isExpanded });

const groupOf = (...tools: string[]): RenderPropsOf["ToolGroup"] => ({
  calls: tools.map((tool) => ({
    tool,
    input: {},
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  })),
  isActive: false,
  isExpanded: false,
});

const TOOL_CATEGORIES: ReadonlyArray<[string, string]> = [
  ["bash", "Bash"],
  ["agent", "Agent"],
  ["cron", "CronCreate"],
  ["files", "Write"],
  ["msg", "SendMessage"],
  ["mcp", "mcp__mongodb__count"],
  ["misc", "ToolSearch"],
];

describe("hidden by default, on every surface", () => {
  for (const [category, tool] of TOOL_CATEGORIES) {
    test(`${category}: the ${tool} row and its result`, async ($, on) => {
      engineBeneath(on);
      for (const surface of EVERY_SURFACE) {
        expect(await isEngineDrawn($, surface, "ToolUse", toolUse(tool))).toBe(false);
        expect(await isEngineDrawn($, surface, "ToolResult", toolResult(tool))).toBe(false);
      }
    });
  }

  test("errors: errored and interrupted rows, whatever the tool", async ($, on) => {
    engineBeneath(on);
    for (const surface of EVERY_SURFACE) {
      expect(await isEngineDrawn($, surface, "ToolUse", toolUse("Bash", { isErrored: true }))).toBe(
        false,
      );
      expect(
        await isEngineDrawn($, surface, "ToolUse", toolUse("Edit", { isInterrupted: true })),
      ).toBe(false);
      expect(await isEngineDrawn($, surface, "ToolResult", toolResult("Bash", true))).toBe(false);
    }
  });

  test("group: a folded line whose calls are all hidden", async ($, on) => {
    engineBeneath(on);
    for (const surface of EVERY_SURFACE) {
      expect(await isEngineDrawn($, surface, "ToolGroup", groupOf("Read", "Bash"))).toBe(false);
    }
  });

  test("peer, tasknote, cronfire: hand-backs, notifications and cron fires", async ($, on) => {
    engineBeneath(on);
    for (const surface of EVERY_SURFACE) {
      for (const kind of [
        "peer",
        "peer-send-message",
        "task-notification",
        "scheduled-trigger",
      ] as const) {
        expect(await isEngineDrawn($, surface, "UserMessage", userMessage(kind))).toBe(false);
      }
    }
  });

  test("turn and notice: terminal-only rows", async ($, on) => {
    engineBeneath(on);
    for (const surface of TERMINAL_ONLY) {
      expect(
        await isEngineDrawn($, surface, "TurnDuration", { word: "Baked", durationMs: 3000 }),
      ).toBe(false);
      expect(await isEngineDrawn($, surface, "InfoNotice", { text: "aviso", command: null })).toBe(
        false,
      );
    }
  });

  test("toolprogress: the background pill draws an empty hint", async ($, on) => {
    engineBeneath(on);
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolProgress",
      props: {
        tool_use_id: "toolu_1",
        kind: "background_hint",
        hint: "(ctrl+b to run in background)",
      },
    });
    expect((await ui.find({ text: "engine:" }))?.text).toBe("engine:");
    await ui.unmount();
  });
});

describe("always visible", () => {
  // The AskUserQuestion dialog itself is not mounted: only the engine may draw it (a test's tree
  // is refused), and the mod has no hook on it, as `claude plugin validate` lists.
  test("assistant text, the AskUserQuestion row, and command output", async ($, on) => {
    engineBeneath(on);
    for (const surface of EVERY_SURFACE) {
      expect(
        await isEngineDrawn($, surface, "AssistantMessage", {
          text: "hola",
          isFirstOfReply: true,
        }),
      ).toBe(true);
      expect(await isEngineDrawn($, surface, "ToolUse", toolUse("AskUserQuestion"))).toBe(true);
      expect(await isEngineDrawn($, surface, "ToolUse", toolUse("ExitPlanMode"))).toBe(true);
      expect(
        await isEngineDrawn($, surface, "CommandOutput", {
          command: "usage",
          args: "",
          text: "x",
          isErrored: false,
        }),
      ).toBe(true);
    }
  });

  test("the user's own messages, typed or through Remote Control", async ($, on) => {
    engineBeneath(on);
    for (const surface of EVERY_SURFACE) {
      expect(await isEngineDrawn($, surface, "UserMessage", userMessage("composer"))).toBe(true);
      expect(await isEngineDrawn($, surface, "UserMessage", userMessage("bridge"))).toBe(true);
    }
  });

  test("the spinner is left to the engine", async ($, on) => {
    engineBeneath(on);
    for (const surface of TERMINAL_AND_DESKTOP) {
      expect(
        await isEngineDrawn($, surface, "Spinner", {
          word: "Baking",
          message: null,
          suffix: "…",
          mode: "thinking",
        }),
      ).toBe(true);
    }
  });

  test("ctrl+o shows a hidden hand-back in full", async ($, on) => {
    engineBeneath(on);
    for (const surface of EVERY_SURFACE) {
      expect(await isEngineDrawn($, surface, "UserMessage", userMessage("peer", true))).toBe(true);
    }
  });

  test("the mod draws no AbovePrompt row", async ($, on) => {
    engineBeneath(on);
    const props: RenderPropsOf["AbovePrompt"] = {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    };
    for (const surface of EVERY_SURFACE) {
      expect(await isEngineDrawn($, surface, "AbovePrompt", props)).toBe(true);
    }
  });
});

describe("/wip-quiet on demand", () => {
  test("show and hide redraw a row already on screen", async ($, on) => {
    engineBeneath(on);
    for (const surface of EVERY_SURFACE) {
      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: "ToolUse",
        props: toolUse("Bash"),
      });
      expect(await ui.find({ text: "engine" })).toBeUndefined();

      await quiet($, "show bash");
      expect(await ui.find({ text: "engine" })).toBeDefined();

      await quiet($, "hide bash");
      expect(await ui.find({ text: "engine" })).toBeUndefined();
      await ui.unmount();
    }
  });

  test("show of one category leaves the others hidden", async ($, on) => {
    engineBeneath(on);
    await quiet($, "show bash");
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash"))).toBe(true);
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Agent"))).toBe(false);
    expect(await isEngineDrawn($, "terminal", "ToolGroup", groupOf("Read", "Grep"))).toBe(false);
    expect(await isEngineDrawn($, "terminal", "ToolGroup", groupOf("Read", "Bash"))).toBe(true);
  });

  test("off draws everything; on hides again", async ($, on) => {
    engineBeneath(on);
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Bash"),
    });

    await quiet($, "off");
    expect(await ui.find({ text: "engine" })).toBeDefined();

    await quiet($, "on");
    expect(await ui.find({ text: "engine" })).toBeUndefined();
    await ui.unmount();
  });

  test("status reports the configuration on demand", async ($, on) => {
    engineBeneath(on);
    const answer = await quiet($, "status");
    expect(answer.text).toContain("wip-quiet: on");
    expect(answer.text).toContain("visible:");
    expect(answer.text).toContain("message times:");
  });

  test("an unknown category answers the usage and changes nothing", async ($, on) => {
    engineBeneath(on);
    const answer = await quiet($, "show nonsense");
    expect(answer.text).toContain("Usage: /wip-quiet");
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash"))).toBe(false);
  });

  test("the choice persists in the store and comes back at session start", async ($, on) => {
    engineBeneath(on, { prefs: { enabled: true, hidden: ["agent"] } });
    await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash"))).toBe(true);
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Agent"))).toBe(false);
  });
});

describe("/wip-quiet show hidden", () => {
  const FOLD_KEY = "quiet-fold:toolu_1";

  test("a hidden call is one folded line; a click unfolds it and a second folds it back", async ($, on) => {
    engineBeneath(on);
    await quiet($, "show hidden");
    for (const surface of EVERY_SURFACE) {
      const row = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: "ToolUse",
        props: toolUse("Bash"),
      });
      const result = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: "ToolResult",
        props: toolResult("Bash"),
      });
      expect((await row.find({ key: FOLD_KEY }))?.text).toBe("▸ Bash");
      expect(await row.find({ text: "engine" })).toBeUndefined();
      expect(await result.find({ text: "engine" })).toBeUndefined();

      await row.press({ key: FOLD_KEY });
      expect((await row.find({ key: FOLD_KEY }))?.text).toBe("▾ Bash");
      expect(await row.find({ text: "engine" })).toBeDefined();
      expect(await result.find({ text: "engine" })).toBeDefined();

      await row.press({ key: FOLD_KEY });
      expect(await row.find({ text: "engine" })).toBeUndefined();
      expect(await result.find({ text: "engine" })).toBeUndefined();
      await row.unmount();
      await result.unmount();
    }
  });

  test("the folded line is drawn plain and dim", async ($, on) => {
    engineBeneath(on);
    await quiet($, "show hidden");
    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Read"),
    });
    expect(await row.drawn()).toMatchObject({
      type: "Box",
      children: [{ type: "Button", props: { plain: true, dimColor: true } }],
    });
    await row.unmount();
  });

  test("a fully hidden group unfolds into per-call rows instead of vanishing", async ($, on) => {
    engineBeneath(on);
    expect(await isEngineDrawn($, "terminal", "ToolGroup", groupOf("Read", "Grep"))).toBe(false);
    await quiet($, "show hidden");
    const group = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolGroup",
      props: groupOf("Read", "Grep"),
    });
    expect(await group.find({ text: "per-call rows" })).toBeDefined();
    await group.unmount();
  });

  test("visible rows and other categories are untouched", async ($, on) => {
    engineBeneath(on);
    await quiet($, "show hidden");
    await quiet($, "show bash");
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash"))).toBe(true);
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("AskUserQuestion"))).toBe(true);
    expect(await isEngineDrawn($, "terminal", "UserMessage", userMessage("peer"))).toBe(false);
  });

  test("hide hidden goes back to no trace at all", async ($, on) => {
    engineBeneath(on);
    await quiet($, "show hidden");
    await quiet($, "hide hidden");
    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Bash"),
    });
    expect(await row.find({ key: FOLD_KEY })).toBeUndefined();
    expect(await row.find({ text: "engine" })).toBeUndefined();
    await row.unmount();
  });

  test("the mode persists in the store and comes back at session start", async ($, on) => {
    engineBeneath(on, { prefs: { enabled: true, hidden: ["bash"], showHidden: true } });
    await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Bash"),
    });
    expect(await row.find({ key: FOLD_KEY })).toBeDefined();
    await row.unmount();
  });
});

describe("⚠ hidden errors", () => {
  test("each hidden error counts and toasts until /wip-quiet ack", async ($, on) => {
    const capture = engineBeneath(on);
    on("tool.call", () => ({ isError: true as const, result: "boom", text: "boom: exit 1" }));

    await $.tool.call({ tool: "Bash", command: "false" });
    expect(capture.toasts.at(-1)).toContain("Bash");

    await $.tool.call({ tool: "Bash", command: "false" });
    expect((await quiet($, "status")).text).toContain("hidden errors not reviewed: 2");

    await quiet($, "ack");
    expect((await quiet($, "status")).text).toContain("hidden errors not reviewed: 0");
  });

  test("the result reaches the model untouched", async ($, on) => {
    engineBeneath(on);
    on("tool.call", () => ({ isError: true as const, result: "boom", text: "boom: exit 1" }));
    const result = await $.tool.call({ tool: "Bash", command: "false" });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("boom: exit 1");
  });

  test("a visible errors category is not counted as hidden", async ($, on) => {
    const capture = engineBeneath(on);
    on("tool.call", () => ({ isError: true as const, result: "boom", text: "boom" }));
    await quiet($, "show errors");
    await $.tool.call({ tool: "Bash", command: "false" });
    expect(capture.toasts).toEqual([]);
  });
});
