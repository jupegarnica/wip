import type { On, RenderComponent, RenderPropsOf, RenderSurface } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";

import { formatStamp, parseIndex } from "../hooks/timestamps";

const PLUGIN = "wip-quiet";
const EVERY_SURFACE = ["terminal", "desktop", "vscode", "mobile"] as const;
const HOME = "/home/juan";
const ROOT = "/work/repo";
const PROJECT_DIR = `${HOME}/.claude/projects/-work-repo`;

const USER_UUID = "11111111-1111-4111-8111-111111111111";
const ASSISTANT_UUID = "22222222-2222-4222-8222-222222222222";
const SECOND_BLOCK_UUID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "msg_01ABCdef";

// 06:30 UTC on 2026-10-27 is 07:30 in Madrid (CET, after the October change).
const USER_ISO = "2026-10-27T06:30:00.000Z";
const ASSISTANT_ISO = "2026-10-27T06:31:05.000Z";
// Hours later: a stamp drawn from the clock would read 12:00, not the stored time.
const NOW = Date.parse("2026-10-27T11:00:00Z");

const transcriptGrep = [
  `3:"uuid":"${USER_UUID}","timestamp":"${USER_ISO}"`,
  `4:"id":"${MESSAGE_ID}"`,
  `4:"uuid":"${ASSISTANT_UUID}","timestamp":"${ASSISTANT_ISO}"`,
  `5:"id":"${MESSAGE_ID}"`,
  `5:"uuid":"${SECOND_BLOCK_UUID}","timestamp":"2026-10-27T06:31:09.000Z"`,
].join("\n");

type TWorld = { grepRuns: number };

// The engine beneath: draws `engine`, and answers the session, files and grep of a fake home.
const engineBeneath = (
  on: On,
  sessionId: string,
  store: Record<string, unknown> = {},
  hasTranscript = true,
): TWorld => {
  const world: TWorld = { grepRuns: 0 };
  const transcript = `${PROJECT_DIR}/${sessionId}.jsonl`;
  mock.store(on, store);
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  on("ui.log", () => ({ value: undefined }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("session.id", () => ({ value: sessionId }));
  on("session.root", () => ({ value: ROOT }));
  on("session.cwd", () => ({ value: ROOT }));
  on("env.get", (_$, e) => ({ value: e.name === "HOME" ? HOME : undefined }));
  on("fs.exists", (_$, e) => ({ value: hasTranscript && e.path === transcript }));
  on("fs.list", () => ({ value: [] }));
  on("fs.stat", () => ({
    value: { kind: "file" as const, size: 1000, mtimeMs: 0, isLink: false },
  }));
  on("process.run", (_$, e) => {
    world.grepRuns += 1;
    const isOurs = e.argv[0] === "grep" && e.argv.at(-1) === transcript;
    return {
      value: {
        exitCode: isOurs ? 0 : 2,
        stdout: isOurs ? transcriptGrep : "",
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  return world;
};

const drawnText = async <C extends RenderComponent>(
  $: Engine,
  surface: RenderSurface,
  component: C,
  props: RenderPropsOf[C],
  requestId: string,
) => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component, props, requestId });
  const engine = await ui.find({ text: "engine" });
  const stamp = await ui.find({ text: /^\d{2}:\d{2} \d{4}-\d{2}-\d{2}$/ });
  await ui.unmount();
  return { isEngineDrawn: engine !== undefined, stamp: stamp?.text };
};

const prompt = (kind: "composer" | "peer" = "composer"): RenderPropsOf["UserMessage"] => ({
  text: "hola",
  origin: { kind },
  isExpanded: false,
});

const quiet = ($: Engine, args: string) =>
  $.command.run({
    command: "wip-quiet",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: 120 },
  });

describe("date format", () => {
  test("HH:MM YYYY-MM-DD in Europe/Madrid, across both DST changes", () => {
    expect(formatStamp(Date.parse("2026-10-27T07:30:00Z"))).toBe("08:30 2026-10-27");
    expect(formatStamp(Date.parse("2026-10-25T00:59:00Z"))).toBe("02:59 2026-10-25");
    expect(formatStamp(Date.parse("2026-10-25T01:00:00Z"))).toBe("02:00 2026-10-25");
    expect(formatStamp(Date.parse("2026-03-29T00:59:00Z"))).toBe("01:59 2026-03-29");
    expect(formatStamp(Date.parse("2026-03-29T01:00:00Z"))).toBe("03:00 2026-03-29");
    expect(formatStamp(Date.parse("2026-12-31T23:05:00Z"))).toBe("00:05 2027-01-01");
  });

  test("the index maps row uuids, and a message id to its first row", () => {
    const byId = parseIndex(transcriptGrep);
    expect(byId.get(USER_UUID)).toBe(Date.parse(USER_ISO));
    expect(byId.get(ASSISTANT_UUID)).toBe(Date.parse(ASSISTANT_ISO));
    expect(byId.get(MESSAGE_ID)).toBe(Date.parse(ASSISTANT_ISO));
    expect(parseIndex('noise\n9:"id":"msg_x"\n').size).toBe(0);
  });
});

describe("stamp from the saved transcript", () => {
  test("the user's message and a reply's first block carry their stored time", async ($, on) => {
    engineBeneath(on, "session-a");
    mock.clock(on, { now: Date.parse("2026-10-27T11:00:00Z") });
    for (const surface of EVERY_SURFACE) {
      expect(await drawnText($, surface, "UserMessage", prompt(), USER_UUID)).toEqual({
        isEngineDrawn: true,
        stamp: "07:30 2026-10-27",
      });
      const reply = { text: "hola", isFirstOfReply: true };
      expect(await drawnText($, surface, "AssistantMessage", reply, ASSISTANT_UUID)).toEqual({
        isEngineDrawn: true,
        stamp: "07:31 2026-10-27",
      });
      expect((await drawnText($, surface, "AssistantMessage", reply, MESSAGE_ID)).stamp).toBe(
        "07:31 2026-10-27",
      );
    }
  });

  test("the transcript is grepped once and cached across rows", async ($, on) => {
    const world = engineBeneath(on, "session-b");
    mock.clock(on, { now: Date.parse("2026-10-27T11:00:00Z") });
    await drawnText($, "terminal", "UserMessage", prompt(), USER_UUID);
    await drawnText(
      $,
      "terminal",
      "AssistantMessage",
      { text: "x", isFirstOfReply: true },
      ASSISTANT_UUID,
    );
    await drawnText($, "terminal", "UserMessage", prompt(), USER_UUID);
    expect(world.grepRuns).toBe(1);
  });

  test("a later block of the reply, and a summary that does not open it, get no stamp", async ($, on) => {
    engineBeneath(on, "session-c");
    const later = await drawnText(
      $,
      "terminal",
      "AssistantMessage",
      { text: "x", isFirstOfReply: false },
      SECOND_BLOCK_UUID,
    );
    expect(later).toEqual({ isEngineDrawn: true, stamp: undefined });
    const summary = { text: "x", isFirstOfReply: false, isSummary: true as const };
    expect(
      (await drawnText($, "terminal", "AssistantMessage", summary, SECOND_BLOCK_UUID)).stamp,
    ).toBeUndefined();
  });

  test("the stamp is drawn dim, below the engine row, left-aligned", async ($, on) => {
    engineBeneath(on, "session-d");
    mock.clock(on, { now: NOW });
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: "terminal",
      component: "UserMessage",
      props: prompt(),
      requestId: USER_UUID,
    });
    expect(await ui.drawn()).toMatchObject({
      type: "Box",
      props: { flexDirection: "column" },
      children: [
        { type: "Text", children: ["engine"] },
        {
          type: "Box",
          props: { justifyContent: "flex-start" },
          children: [{ type: "Text", props: { dimColor: true } }],
        },
      ],
    });
    await ui.unmount();
  });
});

describe("fallback", () => {
  test("a row the transcript does not hold keeps the time of its first draw", async ($, on) => {
    engineBeneath(on, "session-e");
    const clock = mock.clock(on, { now: Date.parse("2026-10-27T07:30:00Z") });
    const unknown = "99999999-9999-4999-8999-999999999999";
    expect((await drawnText($, "terminal", "UserMessage", prompt(), unknown)).stamp).toBe(
      "08:30 2026-10-27",
    );
    await clock.advance(5 * 60_000);
    expect((await drawnText($, "terminal", "UserMessage", prompt(), unknown)).stamp).toBe(
      "08:30 2026-10-27",
    );
  });

  test("no transcript file at all: still a stamp, from the first draw", async ($, on) => {
    engineBeneath(on, "session-f", {}, false);
    mock.clock(on, { now: Date.parse("2026-07-01T10:15:00Z") });
    expect((await drawnText($, "terminal", "UserMessage", prompt(), `${USER_UUID}f`)).stamp).toBe(
      "12:15 2026-07-01",
    );
  });
});

describe("hidden rows and the toggle", () => {
  test("a hidden row stays hidden, with no stamp; ctrl+o shows it stamped", async ($, on) => {
    engineBeneath(on, "session-g");
    mock.clock(on, { now: NOW });
    for (const surface of EVERY_SURFACE) {
      expect(await drawnText($, surface, "UserMessage", prompt("peer"), USER_UUID)).toEqual({
        isEngineDrawn: false,
        stamp: undefined,
      });
      const expanded = { ...prompt("peer"), isExpanded: true };
      expect(await drawnText($, surface, "UserMessage", expanded, USER_UUID)).toEqual({
        isEngineDrawn: true,
        stamp: "07:30 2026-10-27",
      });
    }
  });

  test("/wip-quiet time off removes the stamp and persists; time on brings it back", async ($, on) => {
    const store: Record<string, unknown> = {};
    engineBeneath(on, "session-h", store);
    mock.clock(on, { now: NOW });
    const reply = { text: "x", isFirstOfReply: true };
    expect((await quiet($, "time off")).text).toBe("Message times: off");
    expect(
      (await drawnText($, "terminal", "AssistantMessage", reply, ASSISTANT_UUID)).stamp,
    ).toBeUndefined();
    expect(
      (await drawnText($, "terminal", "UserMessage", prompt(), USER_UUID)).stamp,
    ).toBeUndefined();
    expect((await quiet($, "status")).text).toContain("message times: off");
    await quiet($, "time on");
    expect((await drawnText($, "terminal", "AssistantMessage", reply, ASSISTANT_UUID)).stamp).toBe(
      "07:31 2026-10-27",
    );
    expect((await quiet($, "time maybe")).text).toContain("Usage: /wip-quiet");
  });

  test("stored off comes back at session start; prefs without the key read as on", async ($, on) => {
    engineBeneath(on, "session-i", { prefs: { enabled: true, hidden: [], timestamps: false } });
    await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
    expect(
      (await drawnText($, "terminal", "UserMessage", prompt(), USER_UUID)).stamp,
    ).toBeUndefined();
  });

  test("prefs stored before the toggle existed draw the stamp", async ($, on) => {
    engineBeneath(on, "session-j", { prefs: { enabled: true, hidden: ["bash"] } });
    mock.clock(on, { now: NOW });
    await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
    expect((await drawnText($, "terminal", "UserMessage", prompt(), USER_UUID)).stamp).toBe(
      "07:30 2026-10-27",
    );
  });
});
