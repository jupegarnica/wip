import type { EngineInterface, Register, RenderElement, RenderInput } from "claude-code";
import { atom, read, update } from "claude-code";

import type { QuietCategory, QuietPrefs } from "../types";
import { ALL_CATEGORIES, originCategory, parseCategories, rowCategory } from "./classify";
import { formatStamp, stampOf } from "./timestamps";

const enabled = atom({ plugin: "wip-quiet", key: "enabled" } as const, true);
const hidden = atom(
  { plugin: "wip-quiet", key: "hidden" } as const,
  [...ALL_CATEGORIES] as QuietCategory[],
);
const counts = atom(
  { plugin: "wip-quiet", key: "counts" } as const,
  {} as Partial<Record<QuietCategory, number>>,
);
const errors = atom({ plugin: "wip-quiet", key: "errors" } as const, 0);
const showHidden = atom({ plugin: "wip-quiet", key: "showHidden" } as const, false);
const unfolded = atom({ plugin: "wip-quiet", key: "unfolded" } as const, [] as string[]);
const timestamps = atom({ plugin: "wip-quiet", key: "timestamps" } as const, true);

const PREFS_KEY = "prefs";
const HIDDEN_MODE_WORD = "hidden";
const USAGE =
  "Usage: /wip-quiet on | off | status | show <cat…|all> | hide <cat…|all> | show hidden | hide hidden | time on | time off | ack\n" +
  `Categories: ${ALL_CATEGORIES.join(", ")}`;

const isPrefs = (value: unknown): value is QuietPrefs =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as QuietPrefs).enabled === "boolean" &&
  Array.isArray((value as QuietPrefs).hidden);

// Render hooks read only `enabled` and `hidden`: reading the counters there would redraw every
// hooked row of the transcript on each tool call.
const shouldHide = async ($: EngineInterface, category: QuietCategory | null) => {
  if (category === null) return false;
  if (!(await read($, enabled))) return false;
  return (await read($, hidden)).includes(category);
};

const hiddenTree = ($: EngineInterface, e: RenderInput) => {
  const { Box } = $.ui.resolve(e);
  return <Box display="none" />;
};

const foldKey = (toolUseId: string) => `quiet-fold:${toolUseId}`;

const toggleUnfolded = ($: EngineInterface, toolUseId: string) =>
  update($, unfolded, (current) =>
    current.includes(toolUseId)
      ? current.filter((id) => id !== toolUseId)
      : [...current, toolUseId],
  );

const isUnfolded = async ($: EngineInterface, toolUseId: string) =>
  (await read($, showHidden)) && (await read($, unfolded)).includes(toolUseId);

// Read only once the row is already hidden, so `showHidden` and `unfolded` redraw hidden rows alone.
const hiddenToolUse = async (
  $: EngineInterface,
  e: RenderInput<"ToolUse">,
  drawRow: () => Promise<RenderElement>,
) => {
  if (!(await read($, showHidden))) return hiddenTree($, e);
  const { tool_use_id: toolUseId, tool } = e.props;
  const isOpen = (await read($, unfolded)).includes(toolUseId);
  const { Box, Button } = $.ui.resolve(e);
  return (
    <Box flexDirection="column">
      <Button
        key={foldKey(toolUseId)}
        plain
        dimColor
        onPress={() => void toggleUnfolded($, toolUseId)}
      >
        {`${isOpen ? "▾" : "▸"} ${tool}`}
      </Button>
      {isOpen ? await drawRow() : null}
    </Box>
  );
};

// Drawing only: the stored message and what the model reads are untouched. Below the engine's row,
// left-aligned and dim, so the markdown and its width stay the engine's own.
const withStamp = async (
  $: EngineInterface,
  e: RenderInput<"UserMessage" | "AssistantMessage">,
  row: RenderElement,
) => {
  const { Box, Text } = $.ui.resolve(e);
  const stamp = formatStamp(await stampOf($, e.requestId));
  return (
    <Box flexDirection="column">
      {row}
      <Box justifyContent="flex-start">
        <Text dimColor>{stamp}</Text>
      </Box>
    </Box>
  );
};

const recordHidden = async ($: EngineInterface, category: QuietCategory) => {
  await update($, counts, (current) => ({
    ...current,
    [category]: (current[category] ?? 0) + 1,
  }));
  if (category === "errors") await update($, errors, (n) => n + 1);
};

const savePrefs = async ($: EngineInterface) => {
  const prefs: QuietPrefs = {
    enabled: await read($, enabled),
    hidden: await read($, hidden),
    showHidden: await read($, showHidden),
    timestamps: await read($, timestamps),
  };
  await $.store.set(PREFS_KEY, prefs);
};

const describeStatus = async ($: EngineInterface) => {
  const isOn = await read($, enabled);
  const hiddenNow = await read($, hidden);
  const shown = ALL_CATEGORIES.filter((category) => !hiddenNow.includes(category));
  const perCategory = Object.entries(await read($, counts))
    .map(([category, n]) => `${category} ${n}`)
    .join(", ");
  return [
    `wip-quiet: ${isOn ? "on" : "off"}`,
    `hidden tools: ${(await read($, showHidden)) ? "folded line (show hidden)" : "nothing"}`,
    `message times: ${(await read($, timestamps)) ? "on" : "off"}`,
    `hidden: ${hiddenNow.join(", ") || "none"}`,
    `visible: ${shown.join(", ") || "none"}`,
    `rows hidden this session: ${perCategory || "none"}`,
    `⚠ hidden errors not reviewed: ${await read($, errors)}`,
  ].join("\n");
};

const runCommand = async ($: EngineInterface, args: string): Promise<string> => {
  const [verb = "", ...rest] = args.trim().split(/\s+/);
  const categories = parseCategories(rest.join(" "));

  switch (verb) {
    case "":
    case "status":
      return describeStatus($);
    case "on":
    case "off":
      await update($, enabled, () => verb === "on");
      await savePrefs($);
      return `wip-quiet ${verb}`;
    case "show":
    case "hide":
      if (rest.length === 1 && rest[0] === HIDDEN_MODE_WORD) {
        await update($, showHidden, () => verb === "show");
        await savePrefs($);
        return verb === "show"
          ? "Hidden tools: one folded line per call; click to unfold it."
          : "Hidden tools: no trace.";
      }
      if (categories === null) return USAGE;
      await update($, hidden, (current) =>
        verb === "show"
          ? current.filter((category) => !categories.includes(category))
          : [...new Set([...current, ...categories])],
      );
      await savePrefs($);
      return `${verb === "show" ? "Visible" : "Hidden"}: ${categories.join(", ")}`;
    case "time":
      if (rest.length !== 1 || (rest[0] !== "on" && rest[0] !== "off")) return USAGE;
      await update($, timestamps, () => rest[0] === "on");
      await savePrefs($);
      return `Message times: ${rest[0]}`;
    case "ack":
      await update($, errors, () => 0);
      return "Error counter reset to 0.";
    default:
      return USAGE;
  }
};

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    // Separate from the restore below: a refused registration must not leave last session's prefs unapplied.
    try {
      await $.command.register({
        name: "wip-quiet",
        description: "Show or hide the transcript rows wip-quiet hides",
        argumentHint: "on|off|status|show <cat>|hide <cat>|time on|time off|ack",
        immediate: true,
      });
    } catch (error) {
      $.ui.log(`wip-quiet: /wip-quiet registration failed: ${String(error)}`, { to: "debug" });
    }
    try {
      const stored = await $.store.get(PREFS_KEY);
      if (isPrefs(stored)) {
        await update($, enabled, () => stored.enabled);
        await update($, hidden, () => stored.hidden);
        await update($, showHidden, () => stored.showHidden === true);
        await update($, timestamps, () => stored.timestamps !== false);
      }
    } catch (error) {
      $.ui.log(`wip-quiet: prefs restore failed: ${String(error)}`, { to: "debug" });
    }
    return next(e);
  });

  on("command.run", { command: "wip-quiet" }, async ($, e) => ({
    text: await runCommand($, e.args),
  }));

  // Observes only: the call and its result go through untouched, so permissions are the engine's.
  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined) return result;
    try {
      const hasFailed = result.deny !== undefined || result.isError === true;
      const category = rowCategory({ tool: e.tool, isErrored: hasFailed });
      if (category !== null && (await shouldHide($, category))) {
        await recordHidden($, category);
        if (category === "errors") {
          const reason = (result.deny ?? result.text ?? "").split("\n")[0]?.slice(0, 80) ?? "";
          $.ui.toast(`⚠ ${e.tool} failed (hidden row): ${reason}`);
        }
      }
    } catch (error) {
      $.ui.log(`wip-quiet: tool.call bookkeeping failed: ${String(error)}`, { to: "debug" });
    }
    return result;
  });

  on("prompt.submit", async ($, e, next) => {
    try {
      const category = originCategory(e.origin.kind);
      if (category !== null && (await shouldHide($, category))) await recordHidden($, category);
    } catch (error) {
      $.ui.log(`wip-quiet: prompt.submit bookkeeping failed: ${String(error)}`, { to: "debug" });
    }
    return next(e);
  });

  on("ui.render", { component: "ToolUse" }, async ($, e, next) =>
    (await shouldHide($, rowCategory(e.props))) ? hiddenToolUse($, e, () => next(e)) : next(e),
  );

  on("ui.render", { component: "ToolResult" }, async ($, e, next) =>
    !(await shouldHide($, rowCategory(e.props))) || (await isUnfolded($, e.props.tool_use_id))
      ? next(e)
      : hiddenTree($, e),
  );

  on("ui.render", { component: "ToolGroup" }, async ($, e, next) => {
    if (!(await shouldHide($, "group"))) return next(e);
    for (const call of e.props.calls) {
      if (!(await shouldHide($, rowCategory(call)))) return next(e);
    }
    // Expanded, the group draws one `ToolUse` row per call, each folded by the hook above.
    if (await read($, showHidden)) return next({ ...e, props: { ...e.props, isExpanded: true } });
    return hiddenTree($, e);
  });

  // ctrl+o (`isExpanded`) always shows the full row. A hidden row stays hidden: no stamp either.
  on("ui.render", { component: "UserMessage" }, async ($, e, next) => {
    if (!e.props.isExpanded && (await shouldHide($, originCategory(e.props.origin.kind)))) {
      return hiddenTree($, e);
    }
    return (await read($, timestamps)) ? withStamp($, e, await next(e)) : next(e);
  });

  // Only the block that opens a reply. Wrapping leaves `props` (and `isSummary`) as received.
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) =>
    e.props.isFirstOfReply && (await read($, timestamps))
      ? withStamp($, e, await next(e))
      : next(e),
  );

  // Raised on the terminal only; other surfaces draw their own footer and never reach this hook.
  on("ui.render", { component: "TurnDuration" }, async ($, e, next) =>
    (await shouldHide($, "turn")) ? hiddenTree($, e) : next(e),
  );

  on("ui.render", { component: "ToolProgress" }, async ($, e, next) =>
    (await shouldHide($, "toolprogress"))
      ? next({ ...e, props: { ...e.props, hint: "" } })
      : next(e),
  );

  on("ui.render", { component: "InfoNotice" }, async ($, e, next) =>
    (await shouldHide($, "notice")) ? hiddenTree($, e) : next(e),
  );
};
