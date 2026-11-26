import type {
  EngineInterface,
  Register,
  RenderComponent,
  RenderElement,
  RenderInput,
} from "claude-code";
import { atom, read, update } from "claude-code";

import type { QuietCategory, QuietMode, QuietModes, QuietPrefs } from "../types";
import {
  ALL_CATEGORIES,
  DEFAULT_MODES,
  isCategory,
  normalizeModes,
  originCategory,
  parseCategories,
  rowCategory,
} from "./classify";
import { formatStamp, stampOf } from "./timestamps";

const enabled = atom({ plugin: "wip-quiet", key: "enabled" } as const, true);
const modes = atom({ plugin: "wip-quiet", key: "modes" } as const, DEFAULT_MODES, {
  shape: "modes-1",
});
const counts = atom(
  { plugin: "wip-quiet", key: "counts" } as const,
  {} as Partial<Record<QuietCategory, number>>,
);
const errors = atom({ plugin: "wip-quiet", key: "errors" } as const, 0);
const unfolded = atom({ plugin: "wip-quiet", key: "unfolded" } as const, [] as string[]);
const timestamps = atom({ plugin: "wip-quiet", key: "timestamps" } as const, true);

const PREFS_KEY = "prefs";
const USAGE =
  "Usage: /wip-quiet on | off | status | show <cat…|all> | hide <cat…|all> | fold <cat…|all> | time on | time off | ack\n" +
  `Categories: ${ALL_CATEGORIES.join(", ")}\n` +
  "Modes: show (in full) | hide (no trace) | fold (one line, click to unfold)";

const MESSAGE_LABELS: Partial<Record<QuietCategory, string>> = {
  peer: "peer message",
  tasknote: "task notification",
  cronfire: "scheduled trigger",
};

const PREVIEW_LENGTH = 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Render hooks read only `enabled` and `modes`: reading the counters there would redraw every
// hooked row of the transcript on each tool call.
const modeFor = async ($: EngineInterface, category: QuietCategory | null): Promise<QuietMode> => {
  if (category === null) return "show";
  if (!(await read($, enabled))) return "show";
  const stored = await read($, modes);
  return stored[category] ?? DEFAULT_MODES[category];
};

const hiddenTree = ($: EngineInterface, e: RenderInput) => {
  const { Box } = $.ui.resolve(e);
  return <Box display="none" />;
};

const foldKey = (
  component:
    | "ToolUse"
    | "ToolGroup"
    | "UserMessage"
    | "TurnDuration"
    | "ToolProgress"
    | "InfoNotice",
  id: string,
) => `quiet-fold:${component}:${id}`;

const toggleUnfolded = ($: EngineInterface, key: string) =>
  update($, unfolded, (current) =>
    current.includes(key) ? current.filter((open) => open !== key) : [...current, key],
  );

// The first non-empty line of the row's text, trimmed and with its whitespace collapsed; past 60
// characters it is cut to 59 plus an ellipsis. Empty text has no preview at all.
const previewOf = (text: string): string => {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
  if (line === undefined) return "";
  const collapsed = line.trim().replace(/\s+/g, " ");
  return collapsed.length > PREVIEW_LENGTH
    ? `${collapsed.slice(0, PREVIEW_LENGTH - 1)}…`
    : collapsed;
};

const withPreview = (label: string, text: string): string => {
  const preview = previewOf(text);
  return preview === "" ? label : `${label} · ${preview}`;
};

const groupLabel = (calls: ReadonlyArray<{ tool: string }>): string => {
  const names: string[] = [];
  for (const call of calls) if (!names.includes(call.tool)) names.push(call.tool);
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? "…" : "";
  return `${calls.length} call${calls.length === 1 ? "" : "s"}${shown === "" ? "" : ` · ${shown}${more}`}`;
};

// One folded line for every category: a plain, dim Button toggling its key in `unfolded`, and the
// engine row drawn by `drawFull` only while open. The key stays stable for the row's lifetime.
const foldedRow = async <C extends RenderComponent>(
  $: EngineInterface,
  e: RenderInput<C>,
  key: string,
  label: string,
  drawFull: () => Promise<RenderElement>,
): Promise<RenderElement> => {
  const isOpen = (await read($, unfolded)).includes(key);
  const { Box, Button } = $.ui.resolve(e);
  return (
    <Box flexDirection="column">
      <Button key={key} plain dimColor onPress={() => void toggleUnfolded($, key)}>
        {`${isOpen ? "▾" : "▸"} ${label}`}
      </Button>
      {isOpen ? await drawFull() : null}
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

const stamped = async (
  $: EngineInterface,
  e: RenderInput<"UserMessage">,
  row: RenderElement,
): Promise<RenderElement> => ((await read($, timestamps)) ? withStamp($, e, row) : row);

const recordCovered = async ($: EngineInterface, category: QuietCategory) => {
  await update($, counts, (current) => ({
    ...current,
    [category]: (current[category] ?? 0) + 1,
  }));
  if (category === "errors") await update($, errors, (n) => n + 1);
};

const savePrefs = async ($: EngineInterface) => {
  const prefs: QuietPrefs = {
    version: 2,
    enabled: await read($, enabled),
    modes: await read($, modes),
    timestamps: await read($, timestamps),
  };
  await $.store.set(PREFS_KEY, prefs);
};

// A version 1 prefs carries `hidden` and `showHidden`; the old default (every category hidden, no
// folded line) is indistinguishable from "no choice" and gets the new defaults. Any other old
// value is mapped faithfully: hidden → fold when the folded line was on, hide otherwise.
const modesFromPrefs = (stored: Record<string, unknown>): QuietModes => {
  if (isRecord(stored.modes)) return normalizeModes(stored.modes);
  if (!Array.isArray(stored.hidden)) return { ...DEFAULT_MODES };
  const hidden = stored.hidden.filter(
    (value): value is QuietCategory => typeof value === "string" && isCategory(value),
  );
  const isOldDefault =
    stored.showHidden !== true && ALL_CATEGORIES.every((category) => hidden.includes(category));
  if (isOldDefault) return { ...DEFAULT_MODES };
  const modes = { ...DEFAULT_MODES };
  for (const category of ALL_CATEGORIES) {
    modes[category] = hidden.includes(category)
      ? stored.showHidden === true
        ? "fold"
        : "hide"
      : "show";
  }
  return modes;
};

const describeStatus = async ($: EngineInterface) => {
  const isOn = await read($, enabled);
  const modesNow = await read($, modes);
  const perCategory = Object.entries(await read($, counts))
    .map(([category, n]) => `${category} ${n}`)
    .join(", ");
  return [
    `wip-quiet: ${isOn ? "on" : "off"}`,
    `message times: ${(await read($, timestamps)) ? "on" : "off"}`,
    `rows folded or hidden this session: ${perCategory || "none"}`,
    `errors not reviewed: ${await read($, errors)}`,
    ...ALL_CATEGORIES.map(
      (category) => `${category}: ${modesNow[category] ?? DEFAULT_MODES[category]}`,
    ),
  ].join("\n");
};

const runCommand = async ($: EngineInterface, args: string): Promise<string> => {
  const [verb = "", ...rest] = args.trim().split(/\s+/);

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
    case "fold": {
      const categories = parseCategories(rest.join(" "));
      if (categories === null) return USAGE;
      const mode: QuietMode = verb === "show" ? "show" : verb === "hide" ? "hide" : "fold";
      await update($, modes, (current) => {
        const next = { ...current };
        for (const category of categories) next[category] = mode;
        return next;
      });
      await savePrefs($);
      const askedAll = rest
        .join(" ")
        .split(/[\s,]+/)
        .includes("all");
      return `${verb === "show" ? "Shown" : verb === "hide" ? "Hidden" : "Folded"}: ${
        askedAll ? "all" : categories.join(", ")
      }`;
    }
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
        description: "Choose how each transcript category is drawn: show, hide or fold",
        argumentHint: "on|off|status|show <cat>|hide <cat>|fold <cat>|time on|time off|ack",
        immediate: true,
      });
    } catch (error) {
      $.ui.log(`wip-quiet: /wip-quiet registration failed: ${String(error)}`, { to: "debug" });
    }
    // A read-time migration: nothing is written here; the first command that changes something
    // saves v2. A prefs that is not an object, or a field of the wrong type, keeps its default.
    try {
      const stored = await $.store.get(PREFS_KEY);
      if (isRecord(stored)) {
        const storedEnabled = stored.enabled;
        if (typeof storedEnabled === "boolean") {
          await update($, enabled, () => storedEnabled);
        }
        const storedTimestamps = stored.timestamps;
        if (typeof storedTimestamps === "boolean") {
          await update($, timestamps, () => storedTimestamps);
        }
        await update($, modes, () => modesFromPrefs(stored));
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
      if (category === null) return result;
      const mode = await modeFor($, category);
      if (mode === "show") return result;
      await recordCovered($, category);
      if (category === "errors") {
        const reason = (result.deny ?? result.text ?? "").split("\n")[0]?.slice(0, 80) ?? "";
        $.ui.toast(`⚠ ${e.tool} failed (${mode === "fold" ? "folded" : "hidden"} row): ${reason}`);
      }
    } catch (error) {
      $.ui.log(`wip-quiet: tool.call bookkeeping failed: ${String(error)}`, { to: "debug" });
    }
    return result;
  });

  on("prompt.submit", async ($, e, next) => {
    try {
      const category = originCategory(e.origin.kind);
      if (category !== null && (await modeFor($, category)) !== "show") {
        await recordCovered($, category);
      }
    } catch (error) {
      $.ui.log(`wip-quiet: prompt.submit bookkeeping failed: ${String(error)}`, { to: "debug" });
    }
    return next(e);
  });

  // ctrl+o (`isExpanded`) draws the full row before the mode is consulted, for fold and hide alike.
  on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
    if (e.props.isExpanded === true) return next(e);
    const mode = await modeFor($, rowCategory(e.props));
    if (mode === "show") return next(e);
    if (mode === "hide") return hiddenTree($, e);
    const key = foldKey("ToolUse", e.props.tool_use_id);
    return foldedRow($, e, key, e.props.tool, () => next(e));
  });

  // The result follows the ToolUse's key; a result whose ToolUse is not mounted has no control.
  on("ui.render", { component: "ToolResult" }, async ($, e, next) => {
    if (e.props.isExpanded === true) return next(e);
    const mode = await modeFor($, rowCategory(e.props));
    if (mode === "show") return next(e);
    if (
      mode === "fold" &&
      (await read($, unfolded)).includes(foldKey("ToolUse", e.props.tool_use_id))
    ) {
      return next(e);
    }
    return hiddenTree($, e);
  });

  on("ui.render", { component: "ToolGroup" }, async ($, e, next) => {
    // The engine already expanded this group (ctrl+o, --verbose, a rewritten group): the engine
    // draws the line and one ToolUse row per call, each hooked by the row hooks above.
    if (e.props.isExpanded) return next(e);
    // A shown call must never disappear behind a group's fold or hide.
    const callModes = await Promise.all(e.props.calls.map((call) => modeFor($, rowCategory(call))));
    if (callModes.includes("show")) return next(e);
    const mode = await modeFor($, "group");
    if (mode === "show") return next(e);
    if (mode === "hide") return hiddenTree($, e);
    // Unfolding asks for the expanded group; each per-call row then obeys its own category.
    return foldedRow($, e, foldKey("ToolGroup", e.requestId), groupLabel(e.props.calls), () =>
      next({ ...e, props: { ...e.props, isExpanded: true } }),
    );
  });

  on("ui.render", { component: "UserMessage" }, async ($, e, next) => {
    if (e.props.isExpanded) return stamped($, e, await next(e));
    const category = originCategory(e.props.origin.kind);
    const mode = await modeFor($, category);
    if (mode === "show") return stamped($, e, await next(e));
    if (mode === "hide") return hiddenTree($, e);
    const label = withPreview(MESSAGE_LABELS[category ?? "misc"] ?? "message", e.props.text);
    return foldedRow($, e, foldKey("UserMessage", e.requestId), label, async () =>
      stamped($, e, await next(e)),
    );
  });

  // Only the block that opens a reply. Wrapping leaves `props` (and `isSummary`) as received.
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) =>
    e.props.isFirstOfReply && (await read($, timestamps))
      ? withStamp($, e, await next(e))
      : next(e),
  );

  // Raised on the terminal only; other surfaces draw their own footer and never reach this hook.
  on("ui.render", { component: "TurnDuration" }, async ($, e, next) => {
    if (e.props.isExpanded === true) return next(e);
    const mode = await modeFor($, "turn");
    if (mode === "show") return next(e);
    if (mode === "hide") return hiddenTree($, e);
    return foldedRow($, e, foldKey("TurnDuration", e.requestId), `turn · ${e.props.word}`, () =>
      next(e),
    );
  });

  // No `isExpanded` on this component: the mode applies in every view. `hide` rewrites the hint to
  // the empty string, which the engine documents as drawing nothing.
  on("ui.render", { component: "ToolProgress" }, async ($, e, next) => {
    const mode = await modeFor($, "toolprogress");
    if (mode === "show") return next(e);
    if (mode === "hide") return next({ ...e, props: { ...e.props, hint: "" } });
    return foldedRow($, e, foldKey("ToolProgress", e.requestId), "background hint", () => next(e));
  });

  // No `isExpanded` either.
  on("ui.render", { component: "InfoNotice" }, async ($, e, next) => {
    const mode = await modeFor($, "notice");
    if (mode === "show") return next(e);
    if (mode === "hide") return hiddenTree($, e);
    return foldedRow(
      $,
      e,
      foldKey("InfoNotice", e.requestId),
      withPreview("info notice", e.props.text),
      () => next(e),
    );
  });
};
