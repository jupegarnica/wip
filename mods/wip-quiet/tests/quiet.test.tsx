import type { On, RenderComponent, RenderPropsOf, RenderSurface } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";

import { ALL_CATEGORIES, DEFAULT_MODES } from "../hooks/classify";

const PLUGIN = "wip-quiet";
const EVERY_SURFACE = ["terminal", "desktop", "vscode", "mobile"] as const;
const TERMINAL_AND_DESKTOP = ["terminal", "desktop"] as const;
const TERMINAL_ONLY = ["terminal"] as const;

type TCapture = { toasts: string[] };

// The fold key of each component: `ToolUse` and `ToolResult` share the call's key.
const foldKey = (component: string, id: string) => `quiet-fold:${component}:${id}`;
const TOOL_KEY = foldKey("ToolUse", "toolu_1");

// The test's hooks stand for the engine: whatever reaches them is drawn as the engine's own row.
const engineBeneath = (on: On, store: Record<string, unknown> = {}): TCapture => {
  const capture: TCapture = { toasts: [] };
  mock.store(on, store);
  mock.clock(on, { now: Date.parse("2026-10-27T11:00:00Z") });
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

describe("folded by default, on every surface", () => {
  for (const [category, tool] of TOOL_CATEGORIES) {
    test(`${category}: the ${tool} row is one folded line and its result is hidden`, async ($, on) => {
      engineBeneath(on);
      for (const surface of EVERY_SURFACE) {
        const row = await $.ui.mount({
          plugin: PLUGIN,
          surface,
          component: "ToolUse",
          props: toolUse(tool),
        });
        expect((await row.find({ key: TOOL_KEY }))?.text).toBe(`▸ ${tool}`);
        expect(await row.find({ text: "engine" })).toBeUndefined();
        await row.unmount();
        expect(await isEngineDrawn($, surface, "ToolResult", toolResult(tool))).toBe(false);
      }
    });
  }

  test("errors: failed and interrupted rows are drawn whole by default", async ($, on) => {
    engineBeneath(on);
    for (const surface of EVERY_SURFACE) {
      expect(await isEngineDrawn($, surface, "ToolUse", toolUse("Bash", { isErrored: true }))).toBe(
        true,
      );
      expect(
        await isEngineDrawn($, surface, "ToolUse", toolUse("Edit", { isInterrupted: true })),
      ).toBe(true);
      expect(await isEngineDrawn($, surface, "ToolResult", toolResult("Bash", true))).toBe(true);
    }
  });

  test("group: one folded line; a click unfolds the per-call rows", async ($, on) => {
    engineBeneath(on);
    const key = foldKey("ToolGroup", "g1");
    for (const surface of EVERY_SURFACE) {
      const group = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: "ToolGroup",
        props: groupOf("Read", "Bash"),
        requestId: "g1",
      });
      expect((await group.find({ key }))?.text).toBe("▸ 2 calls · Read, Bash");
      expect(await group.find({ text: "per-call rows" })).toBeUndefined();

      await group.press({ key });
      expect((await group.find({ key }))?.text).toBe("▾ 2 calls · Read, Bash");
      expect(await group.find({ text: "per-call rows" })).toBeDefined();
      await group.press({ key });
      expect((await group.find({ key }))?.text).toBe("▸ 2 calls · Read, Bash");
      await group.unmount();
    }
  });

  test("peer, tasknote, cronfire: folded lines with a preview", async ($, on) => {
    engineBeneath(on);
    const kindAndLabel = [
      ["peer", "peer message"],
      ["task-notification", "task notification"],
      ["scheduled-trigger", "scheduled trigger"],
    ] as const;
    for (const surface of EVERY_SURFACE) {
      for (const [kind, label] of kindAndLabel) {
        const row = await $.ui.mount({
          plugin: PLUGIN,
          surface,
          component: "UserMessage",
          props: userMessage(kind),
          requestId: "u1",
        });
        expect((await row.find({ key: foldKey("UserMessage", "u1") }))?.text).toBe(
          `▸ ${label} · hola`,
        );
        expect(await row.find({ text: "engine" })).toBeUndefined();
        await row.unmount();
      }
    }
  });

  test("turn and notice: one folded line each", async ($, on) => {
    engineBeneath(on);
    for (const surface of TERMINAL_ONLY) {
      const turn = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: "TurnDuration",
        props: { word: "Baked", durationMs: 3000 },
        requestId: "t1",
      });
      expect((await turn.find({ key: foldKey("TurnDuration", "t1") }))?.text).toBe(
        "▸ turn · Baked",
      );
      expect(await turn.find({ text: "engine" })).toBeUndefined();
      await turn.unmount();

      const notice = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: "InfoNotice",
        props: { text: "aviso", command: null },
        requestId: "n1",
      });
      expect((await notice.find({ key: foldKey("InfoNotice", "n1") }))?.text).toBe(
        "▸ info notice · aviso",
      );
      expect(await notice.find({ text: "engine" })).toBeUndefined();
      await notice.unmount();
    }
  });

  test("toolprogress: the background pill is one folded line", async ($, on) => {
    engineBeneath(on);
    const key = foldKey("ToolProgress", "p1");
    const progress = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolProgress",
      props: {
        tool_use_id: "toolu_1",
        kind: "background_hint",
        hint: "(ctrl+b to run in background)",
      },
      requestId: "p1",
    });
    expect((await progress.find({ key }))?.text).toBe("▸ background hint");
    expect(await progress.find({ text: /engine:/ })).toBeUndefined();

    await progress.press({ key });
    expect((await progress.find({ text: /^engine:/ }))?.text).toBe(
      "engine:(ctrl+b to run in background)",
    );
    await progress.press({ key });
    expect(await progress.find({ text: /^engine:/ })).toBeUndefined();
    await progress.unmount();
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

  test("ctrl+o shows a folded hand-back in full", async ($, on) => {
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

describe("fold mode", () => {
  test("a click toggles the line and the engine row; the result follows the same key", async ($, on) => {
    engineBeneath(on);
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
      expect((await row.find({ key: TOOL_KEY }))?.text).toBe("▸ Bash");
      expect(await row.find({ text: "engine" })).toBeUndefined();
      expect(await result.find({ text: "engine" })).toBeUndefined();

      await row.press({ key: TOOL_KEY });
      expect((await row.find({ key: TOOL_KEY }))?.text).toBe("▾ Bash");
      expect(await row.find({ text: "engine" })).toBeDefined();
      expect(await result.find({ text: "engine" })).toBeDefined();

      await row.press({ key: TOOL_KEY });
      expect(await row.find({ text: "engine" })).toBeUndefined();
      expect(await result.find({ text: "engine" })).toBeUndefined();
      await row.unmount();
      await result.unmount();
    }
  });

  test("the folded line is drawn plain and dim", async ($, on) => {
    engineBeneath(on);
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

  test("a folded message unfolds with its click, on its own key", async ($, on) => {
    engineBeneath(on);
    const key = foldKey("UserMessage", "u1");
    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "UserMessage",
      props: userMessage("peer"),
      requestId: "u1",
    });
    expect((await row.find({ key }))?.text).toBe("▸ peer message · hola");
    await row.press({ key });
    expect(await row.find({ text: "engine" })).toBeDefined();
    await row.unmount();
  });

  test("a turn and a notice unfold with their clicks, on their own keys", async ($, on) => {
    engineBeneath(on);
    const turn = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "TurnDuration",
      props: { word: "Baked", durationMs: 3000 },
      requestId: "t1",
    });
    await turn.press({ key: foldKey("TurnDuration", "t1") });
    expect(await turn.find({ text: "engine" })).toBeDefined();
    await turn.unmount();

    const notice = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "InfoNotice",
      props: { text: "aviso", command: null },
      requestId: "n1",
    });
    await notice.press({ key: foldKey("InfoNotice", "n1") });
    expect(await notice.find({ text: "engine" })).toBeDefined();
    await notice.unmount();
  });

  test("the preview is the first line, collapsed and cut to 59 characters plus an ellipsis", async ($, on) => {
    engineBeneath(on);
    const long = `primera    linea con   espacios\nsegunda linea`;
    const cut = `▸ peer message · ${"x".repeat(59)}…`;
    const longRow = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "UserMessage",
      props: { text: long, origin: { kind: "peer" }, isExpanded: false },
      requestId: "u2",
    });
    expect((await longRow.find({ key: foldKey("UserMessage", "u2") }))?.text).toBe(
      "▸ peer message · primera linea con espacios",
    );
    await longRow.unmount();

    const cutRow = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "UserMessage",
      props: { text: "x".repeat(80), origin: { kind: "peer" }, isExpanded: false },
      requestId: "u3",
    });
    expect((await cutRow.find({ key: foldKey("UserMessage", "u3") }))?.text).toBe(cut);
    await cutRow.unmount();

    const empty = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "InfoNotice",
      props: { text: "  \n ", command: null },
      requestId: "n2",
    });
    expect((await empty.find({ key: foldKey("InfoNotice", "n2") }))?.text).toBe("▸ info notice");
    await empty.unmount();
  });

  test("the group's line counts its calls and names up to three distinct tools", async ($, on) => {
    engineBeneath(on);
    const one = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolGroup",
      props: groupOf("Read"),
      requestId: "g2",
    });
    expect((await one.find({ key: foldKey("ToolGroup", "g2") }))?.text).toBe("▸ 1 call · Read");
    await one.unmount();

    const four = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolGroup",
      props: groupOf("Read", "Grep", "Bash", "Edit"),
      requestId: "g3",
    });
    expect((await four.find({ key: foldKey("ToolGroup", "g3") }))?.text).toBe(
      "▸ 4 calls · Read, Grep, Bash…",
    );
    await four.unmount();
  });
});

describe("/wip-quiet on demand", () => {
  test("show, fold and hide redraw a row already on screen", async ($, on) => {
    engineBeneath(on);
    for (const surface of EVERY_SURFACE) {
      await quiet($, "fold bash");
      const ui = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: "ToolUse",
        props: toolUse("Bash"),
      });
      expect(await ui.find({ text: "engine" })).toBeUndefined();
      expect(await ui.find({ key: TOOL_KEY })).toBeDefined();

      await quiet($, "show bash");
      expect(await ui.find({ text: "engine" })).toBeDefined();

      await quiet($, "fold bash");
      expect(await ui.find({ key: TOOL_KEY })).toBeDefined();
      expect(await ui.find({ text: "engine" })).toBeUndefined();

      await quiet($, "hide bash");
      expect(await ui.find({ key: TOOL_KEY })).toBeUndefined();
      expect(await ui.find({ text: "engine" })).toBeUndefined();
      await ui.unmount();
    }
  });

  test("show of one category leaves the others folded", async ($, on) => {
    engineBeneath(on);
    await quiet($, "show bash");
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash"))).toBe(true);
    const agent = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Agent"),
    });
    expect(await agent.find({ key: TOOL_KEY })).toBeDefined();
    await agent.unmount();
    expect(await isEngineDrawn($, "terminal", "ToolGroup", groupOf("Read", "Grep"))).toBe(false);
    expect(await isEngineDrawn($, "terminal", "ToolGroup", groupOf("Read", "Bash"))).toBe(true);
  });

  test("off draws everything; on applies the modes again", async ($, on) => {
    engineBeneath(on);
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Bash"),
    });
    expect(await ui.find({ key: TOOL_KEY })).toBeDefined();

    await quiet($, "off");
    expect(await ui.find({ text: "engine" })).toBeDefined();
    expect(await ui.find({ key: TOOL_KEY })).toBeUndefined();

    await quiet($, "on");
    expect(await ui.find({ key: TOOL_KEY })).toBeDefined();
    expect(await ui.find({ text: "engine" })).toBeUndefined();
    await ui.unmount();
  });

  test("off keeps the modes, so show all and off are not the same", async ($, on) => {
    engineBeneath(on);
    await quiet($, "show all");
    await quiet($, "off");
    const text = (await quiet($, "status")).text;
    expect(text).toContain("wip-quiet: off");
    expect(text).toContain("bash: show");
  });

  test("status prints the exact default block", async ($, on) => {
    engineBeneath(on);
    const expected = [
      "wip-quiet: on",
      "message times: on",
      "rows folded or hidden this session: none",
      "errors not reviewed: 0",
      ...ALL_CATEGORIES.map(
        (category) => `${category}: ${category === "errors" ? "show" : "fold"}`,
      ),
    ].join("\n");
    expect((await quiet($, "status")).text).toBe(expected);
  });

  test("status follows the modes, the counter and the errors", async ($, on) => {
    engineBeneath(on);
    on("tool.call", () => ({ isError: true as const, result: "boom", text: "boom" }));
    await quiet($, "show bash");
    await quiet($, "fold errors");
    await $.tool.call({ tool: "Bash", command: "false" });
    const text = (await quiet($, "status")).text;
    expect(text).toContain("bash: show");
    expect(text).toContain("errors: fold");
    expect(text).toContain("rows folded or hidden this session: errors 1");
    expect(text).toContain("errors not reviewed: 1");
  });

  test("status keeps the mode lines while off", async ($, on) => {
    engineBeneath(on);
    await quiet($, "off");
    const text = (await quiet($, "status")).text;
    expect(text).toContain("wip-quiet: off");
    expect(text).toContain("bash: fold");
    expect(text).toContain("errors: show");
  });
});

describe("/wip-quiet commands", () => {
  test("the four responses", async ($, on) => {
    engineBeneath(on);
    expect((await quiet($, "fold bash")).text).toBe("Folded: bash");
    expect((await quiet($, "hide files")).text).toBe("Hidden: files");
    expect((await quiet($, "show bash files")).text).toBe("Shown: bash, files");
    expect((await quiet($, "fold all")).text).toBe("Folded: all");
  });

  test("show all writes show into every mode and the row is engine-drawn", async ($, on) => {
    engineBeneath(on);
    expect((await quiet($, "show all")).text).toBe("Shown: all");
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash"))).toBe(true);
    const status = (await quiet($, "status")).text;
    for (const category of ALL_CATEGORIES) expect(status).toContain(`${category}: show`);
  });

  test("hide all leaves no trace at all", async ($, on) => {
    engineBeneath(on);
    expect((await quiet($, "hide all")).text).toBe("Hidden: all");
    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Bash"),
    });
    expect(await row.find({ key: TOOL_KEY })).toBeUndefined();
    expect(await row.find({ text: "engine" })).toBeUndefined();
    await row.unmount();
  });

  test("an unknown category answers the usage and changes nothing", async ($, on) => {
    engineBeneath(on);
    expect((await quiet($, "show nonsense")).text).toBe(
      "Usage: /wip-quiet on | off | status | show <cat…|all> | hide <cat…|all> | fold <cat…|all> | time on | time off | ack\n" +
        `Categories: ${ALL_CATEGORIES.join(", ")}\n` +
        "Modes: show (in full) | hide (no trace) | fold (one line, click to unfold)",
    );
    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Bash"),
    });
    expect(await row.find({ key: TOOL_KEY })).toBeDefined();
    await row.unmount();
  });

  test("the removed word hidden answers the usage and changes nothing", async ($, on) => {
    engineBeneath(on);
    expect((await quiet($, "show hidden")).text).toContain("Usage: /wip-quiet");
    expect((await quiet($, "hide hidden")).text).toContain("Usage: /wip-quiet");
    expect((await quiet($, "status")).text).toContain("errors: show");
  });

  test("no arguments answer the usage; an empty verb is status", async ($, on) => {
    engineBeneath(on);
    expect((await quiet($, "show")).text).toContain("Usage: /wip-quiet");
    expect((await quiet($, "fold")).text).toContain("Usage: /wip-quiet");
    expect((await quiet($, "nonsense")).text).toContain("Usage: /wip-quiet");
    expect((await quiet($, "")).text).toContain("wip-quiet: on");
  });
});

describe("prefs, persistence and migration", () => {
  const start = ($: Engine) =>
    $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

  test("a command persists v2 and the next session reads it", async ($, on) => {
    engineBeneath(on, {});
    await start($);
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash"))).toBe(false);
    await quiet($, "show bash");
    await start($);
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash"))).toBe(true);
  });

  test("a partial v2 modes map fills the rest from the defaults", async ($, on) => {
    engineBeneath(on, {
      prefs: { version: 2, enabled: true, modes: { agent: "show", bash: "hide" } },
    });
    await start($);
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Agent"))).toBe(true);
    const bash = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Bash"),
    });
    expect(await bash.find({ key: TOOL_KEY })).toBeUndefined();
    expect(await bash.find({ text: "engine" })).toBeUndefined();
    await bash.unmount();
    const files = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Write"),
    });
    expect(await files.find({ key: TOOL_KEY })).toBeDefined();
    await files.unmount();
  });

  test("a full v2 modes map is read as written", async ($, on) => {
    engineBeneath(on, {
      prefs: { version: 2, enabled: true, modes: { ...DEFAULT_MODES, bash: "show" } },
    });
    await start($);
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash"))).toBe(true);
    const agent = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Agent"),
    });
    expect(await agent.find({ key: TOOL_KEY })).toBeDefined();
    await agent.unmount();
  });

  test("an old default prefs gets the new defaults", async ($, on) => {
    engineBeneath(on, { prefs: { enabled: true, hidden: [...ALL_CATEGORIES] } });
    await start($);
    const bash = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Bash"),
    });
    expect(await bash.find({ key: TOOL_KEY })).toBeDefined();
    await bash.unmount();
    expect(
      await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash", { isErrored: true })),
    ).toBe(true);
  });

  test("an old prefs with the folded line maps hidden to fold", async ($, on) => {
    engineBeneath(on, { prefs: { enabled: true, hidden: ["agent"], showHidden: true } });
    await start($);
    const agent = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Agent"),
    });
    expect(await agent.find({ key: TOOL_KEY })).toBeDefined();
    await agent.unmount();
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash"))).toBe(true);
  });

  test("an old prefs without the folded line maps hidden to hide", async ($, on) => {
    engineBeneath(on, { prefs: { enabled: true, hidden: ["agent"] } });
    await start($);
    const agent = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Agent"),
    });
    expect(await agent.find({ key: TOOL_KEY })).toBeUndefined();
    expect(await agent.find({ text: "engine" })).toBeUndefined();
    await agent.unmount();
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash"))).toBe(true);
  });

  test("an invalid mode falls back to fold; an unknown key is ignored", async ($, on) => {
    engineBeneath(on, {
      prefs: { version: 2, enabled: true, modes: { bash: "bogus", nonsense: "show" } },
    });
    await start($);
    const bash = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Bash"),
    });
    expect((await bash.find({ key: TOOL_KEY }))?.text).toBe("▸ Bash");
    await bash.unmount();
  });

  test("a corrupt prefs and a non-boolean enabled keep the defaults", async ($, on) => {
    engineBeneath(on, { prefs: "nope" });
    await start($);
    const bash = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Bash"),
    });
    expect((await bash.find({ key: TOOL_KEY }))?.text).toBe("▸ Bash");
    await bash.unmount();
  });

  test("a non-boolean enabled is not applied", async ($, on) => {
    engineBeneath(on, {
      prefs: { version: 2, enabled: "no", modes: { ...DEFAULT_MODES, bash: "hide" } },
    });
    await start($);
    const bash = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolUse",
      props: toolUse("Bash"),
    });
    expect(await bash.find({ key: TOOL_KEY })).toBeUndefined();
    expect(await bash.find({ text: "engine" })).toBeUndefined();
    await bash.unmount();
  });
});

describe("group precedence", () => {
  test("show group with every call folded draws the engine line", async ($, on) => {
    engineBeneath(on);
    await quiet($, "show group");
    expect(await isEngineDrawn($, "terminal", "ToolGroup", groupOf("Read", "Grep"))).toBe(true);
  });

  test("hide group with every call folded draws nothing", async ($, on) => {
    engineBeneath(on);
    await quiet($, "hide group");
    const key = foldKey("ToolGroup", "g1");
    const group = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolGroup",
      props: groupOf("Read", "Grep"),
      requestId: "g1",
    });
    expect(await group.find({ key })).toBeUndefined();
    expect(await group.find({ text: "engine" })).toBeUndefined();
    await group.unmount();
  });

  test("a shown call draws the engine line whatever the group mode", async ($, on) => {
    engineBeneath(on);
    await quiet($, "show bash");
    await quiet($, "hide group");
    expect(await isEngineDrawn($, "terminal", "ToolGroup", groupOf("Read", "Bash"))).toBe(true);
    await quiet($, "fold group");
    expect(await isEngineDrawn($, "terminal", "ToolGroup", groupOf("Read", "Bash"))).toBe(true);
  });

  test("the engine's isExpanded draws the line and the per-call rows", async ($, on) => {
    engineBeneath(on);
    const group = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "ToolGroup",
      props: { ...groupOf("Read", "Grep"), isExpanded: true },
      requestId: "g1",
    });
    expect(await group.find({ text: "per-call rows" })).toBeDefined();
    await group.unmount();
  });
});

describe("ctrl+o", () => {
  test("draws a folded and a hidden tool row in full", async ($, on) => {
    engineBeneath(on);
    expect(
      await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash", { isExpanded: true })),
    ).toBe(true);
    expect(
      await isEngineDrawn($, "terminal", "ToolResult", { ...toolResult("Bash"), isExpanded: true }),
    ).toBe(true);
    await quiet($, "hide bash");
    expect(
      await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash", { isExpanded: true })),
    ).toBe(true);
    expect(await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash"))).toBe(false);
  });

  test("draws a folded and a hidden turn and message in full", async ($, on) => {
    engineBeneath(on);
    expect(
      await isEngineDrawn($, "terminal", "TurnDuration", {
        word: "Baked",
        durationMs: 3000,
        isExpanded: true,
      }),
    ).toBe(true);
    await quiet($, "hide turn");
    expect(
      await isEngineDrawn($, "terminal", "TurnDuration", {
        word: "Baked",
        durationMs: 3000,
        isExpanded: true,
      }),
    ).toBe(true);
    await quiet($, "hide peer");
    expect(await isEngineDrawn($, "terminal", "UserMessage", userMessage("peer", true))).toBe(true);
  });
});

describe("errors", () => {
  test("errors: show is the default: no toast, no count, the row whole", async ($, on) => {
    const capture = engineBeneath(on);
    on("tool.call", () => ({ isError: true as const, result: "boom", text: "boom: exit 1" }));
    await $.tool.call({ tool: "Bash", command: "false" });
    expect(capture.toasts).toEqual([]);
    expect((await quiet($, "status")).text).toContain("errors not reviewed: 0");
    expect(
      await isEngineDrawn($, "terminal", "ToolUse", toolUse("Bash", { isErrored: true })),
    ).toBe(true);
  });

  test("fold errors toasts with the mode and counts until ack", async ($, on) => {
    const capture = engineBeneath(on);
    on("tool.call", () => ({ isError: true as const, result: "boom", text: "boom: exit 1" }));
    await quiet($, "fold errors");
    await $.tool.call({ tool: "Bash", command: "false" });
    expect(capture.toasts.at(-1)).toBe("⚠ Bash failed (folded row): boom: exit 1");
    expect((await quiet($, "status")).text).toContain("errors not reviewed: 1");
    await quiet($, "ack");
    expect((await quiet($, "status")).text).toContain("errors not reviewed: 0");
  });

  test("hide errors says hidden row", async ($, on) => {
    const capture = engineBeneath(on);
    on("tool.call", () => ({ isError: true as const, result: "boom", text: "boom: exit 1" }));
    await quiet($, "hide errors");
    await $.tool.call({ tool: "Bash", command: "false" });
    expect(capture.toasts.at(-1)).toBe("⚠ Bash failed (hidden row): boom: exit 1");
  });

  test("off neither toasts nor counts", async ($, on) => {
    const capture = engineBeneath(on);
    on("tool.call", () => ({ isError: true as const, result: "boom", text: "boom: exit 1" }));
    await quiet($, "fold errors");
    await quiet($, "off");
    await $.tool.call({ tool: "Bash", command: "false" });
    expect(capture.toasts).toEqual([]);
    expect((await quiet($, "status")).text).toContain("errors not reviewed: 0");
  });

  test("the result reaches the model untouched", async ($, on) => {
    engineBeneath(on);
    on("tool.call", () => ({ isError: true as const, result: "boom", text: "boom: exit 1" }));
    const result = await $.tool.call({ tool: "Bash", command: "false" });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("boom: exit 1");
  });
});
