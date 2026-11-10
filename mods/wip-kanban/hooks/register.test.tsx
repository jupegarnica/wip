import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

const PANE_ID = "wip-kanban";
const ROOT = "/projects/demo";

type TJson = Record<string, unknown>;

interface IRunReply {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface IWorld {
  root: string;
  config: string | null;
  env: Record<string, string>;
  reply: () => Promise<IRunReply>;
  /** The answer of `wip web status --json`; exit 1 means no server of this project runs. */
  status: () => Promise<IRunReply>;
  calls: { argv: string[]; init?: { cwd?: string; timeoutMs?: number } }[];
  opens: TJson[];
  /** The `isPlaced` of each `ui.open`, in order; absent means placed. */
  openReplies: boolean[];
  commands: TJson[];
  closes: TJson[];
  store: Record<string, unknown>;
}

function world(overrides: Partial<IWorld> = {}): IWorld {
  return {
    root: ROOT,
    config: null,
    env: {},
    reply: async () => ({ exitCode: 0, stdout: stateJson(), stderr: "" }),
    status: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "wip web is not running for /projects/demo",
    }),
    calls: [],
    opens: [],
    openReplies: [],
    commands: [],
    closes: [],
    store: {},
    ...overrides,
  };
}

function column(key: string, phases: string[], alpha: number | null): TJson {
  return {
    key,
    label: key.replace(/^stage:|^phase:/, ""),
    stage: key.startsWith("stage:") ? key.slice(6) : null,
    phases,
    alpha,
    color: alpha === null ? "" : `rgba(37, 99, 235, ${alpha})`,
    color_light: alpha === null ? "" : "#2563EB",
    color_dark: alpha === null ? "" : "#223051",
    text: alpha === null ? "" : "#FFFFFF",
    text_dark: alpha === null ? "" : "#FFFFFF",
  };
}

function flow(
  name: string,
  phases: string[],
  columns: TJson[] = [
    column("stage:doing", phases, 1),
    column("stage:closed", [phases.at(-1) as string], 0.25),
  ],
): TJson {
  return { name, source: "file", phases, columns };
}

interface IItem {
  id: string;
  flow: string;
  phase: string;
  attention?: boolean;
}

function stateJson(
  items: IItem[] = [],
  flows: TJson[] = [flow("development", ["intake", "plan", "execute", "done"])],
): string {
  return JSON.stringify({
    ok: true,
    item: null,
    events: [],
    warnings: [],
    message: null,
    data: {
      items: items.map((i) => ({
        id: i.id,
        flow: i.flow,
        phase: i.phase,
        signals: { attention: i.attention === true, incoherent: [] },
      })),
      board: { flows },
    },
  });
}

/** A `wip web status --json` answer for a running server on `port`. */
function running(port: number): IRunReply {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      ok: true,
      data: { state: "running", url: `http://localhost:${port}/` },
    }),
    stderr: "",
  };
}

/** The hooks beneath the plugin: the engine's own answers for every call it makes. */
function bottom(on: On, w: IWorld): void {
  on("command.register", (_$, e) => {
    w.commands.push(e as unknown as TJson);
    return { value: { command: e.name } };
  });
  on("ui.open", (_$, e) => {
    w.opens.push(e as unknown as TJson);
    const placed = w.openReplies.length === 0 ? true : (w.openReplies.shift() as boolean);
    return {
      value: {
        isPlaced: placed,
        ...(!placed && { reason: "unasked below 144 columns (120 now)" }),
      },
    };
  });
  on("ui.close", (_$, e) => {
    w.closes.push(e as unknown as TJson);
    return { value: undefined };
  });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("prompt.submit", (_$, e) => ({ text: (e as { text?: string }).text ?? "" }));
  on("session.root", () => ({ value: w.root }));
  on("fs.exists", () => ({ value: w.config !== null }));
  on("fs.read", () => ({ value: w.config ?? "" }));
  on("process.run", async (_$, e) => {
    w.calls.push({ argv: [...e.argv], init: e.init });
    try {
      return { value: await (e.argv[1] === "web" ? w.status() : w.reply()) };
    } catch (err) {
      return { deny: err instanceof Error ? err.message : String(err) };
    }
  });
  on("store.get", (_$, e) => ({ value: w.store[e.key] }));
  on("store.set", (_$, e) => {
    w.store[e.key] = e.value;
    return { value: undefined };
  });
  on("store.delete", (_$, e) => {
    delete w.store[e.key];
    return { value: undefined };
  });
  on("store.keys", () => ({ value: Object.keys(w.store) }));
  on("env.get", (_$, e) => ({ value: w.env[e.name] }));
}

/** One drawing of the pane, as plain data, for the assertions. */
function drawnText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(drawnText).join("");
  if (node !== null && typeof node === "object") {
    const children = (node as { children?: unknown[] }).children ?? [];
    return children.map(drawnText).join("");
  }
  return "";
}

interface INode {
  type: string;
  props: TJson;
  children: unknown[];
}

function nodes(node: unknown, out: INode[] = []): INode[] {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) nodes(child, out);
    return out;
  }
  if (typeof node !== "object") return out;
  const element = node as INode;
  out.push(element);
  for (const child of element.children ?? []) nodes(child, out);
  return out;
}

function styleOf(node: INode | undefined): TJson {
  return (node?.props ?? {}) as TJson;
}

const PANE = {
  title: "wip Kanban",
  isFocused: false,
  placement: "dock",
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const;

async function mount(
  $: Parameters<Parameters<typeof test>[1]>[0],
  surface: "terminal" | "desktop",
  bodyColumns: number,
  placement: "dock" | "inline" = "dock",
) {
  return $.ui.mount({
    plugin: PANE_ID,
    surface,
    component: "Pane",
    requestId: PANE_ID,
    props: { ...PANE, bodyColumns, placement },
  } as never);
}

/** Starts a session on the harness and returns its world. */
async function start($: Parameters<Parameters<typeof test>[1]>[0], w: IWorld): Promise<void> {
  await $.session.start({ cwd: w.root, surface: "terminal", isInteractive: true });
}

type TPromptSubmit = (input: { text: string; asUser: boolean }) => Promise<unknown>;

/** The kit's `prompt.submit`, which dispatches the hooks as a person's action. */
function submit($: Parameters<Parameters<typeof test>[1]>[0]): TPromptSubmit {
  return ($ as unknown as { prompt: { submit: TPromptSubmit } }).prompt.submit;
}

function textNodes(tree: unknown): INode[] {
  return nodes(tree).filter((n) => n.type === "Text");
}

/** The Text of one item's row: the one whose text ends with the label the row shows. */
function rowText(tree: unknown, id: string): INode | undefined {
  return textNodes(tree).find((n) => drawnText(n).includes(id));
}

test("the session opens the pane, registers the command and loads the first board", async ($, on) => {
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson([{ id: "K1", flow: "development", phase: "plan" }]),
      stderr: "",
    }),
  });
  bottom(on, w);
  mock.clock(on);

  await start($, w);

  expect(w.commands).toEqual([
    {
      name: "wip-kanban",
      description: "Show a read-only board of the project's open wip items",
      argumentHint: "on|off",
    },
  ]);
  expect(w.opens).toHaveLength(1);
  expect(w.opens[0]).toMatchObject({ id: PANE_ID, title: "wip Kanban", columns: 48, rows: 16 });
  expect(w.opens[0]).not.toHaveProperty("focus");
  expect(w.opens[0]).not.toHaveProperty("holdToasts");
  expect(w.opens[0]).not.toHaveProperty("closeOnEscape");
  expect(w.calls).toEqual([
    { argv: ["wip", "state", "--json"], init: { cwd: ROOT, timeoutMs: 4000 } },
    { argv: ["wip", "web", "status", "--json"], init: { cwd: ROOT, timeoutMs: 4000 } },
  ]);

  const ui = await mount($, "terminal", 40);
  const tree = await ui.drawn();
  expect(rowText(tree, "K1")?.type).toBe("Text");
});

test("an unplaced pane reopens once on the first prompt and stays open after", async ($, on) => {
  const w = world({ openReplies: [false, true] });
  bottom(on, w);
  mock.clock(on);

  await start($, w);
  expect(w.opens).toHaveLength(1);

  await submit($)({ text: "hi", asUser: true });
  expect(w.opens).toHaveLength(2);
  expect(w.opens[1]).toMatchObject({ id: PANE_ID, title: "wip Kanban", columns: 48, rows: 16 });

  await submit($)({ text: "again", asUser: true });
  expect(w.opens).toHaveLength(2);
});

test("a placed pane opens no extra pane on a prompt", async ($, on) => {
  const w = world({ openReplies: [true] });
  bottom(on, w);
  mock.clock(on);

  await start($, w);
  expect(w.opens).toHaveLength(1);

  await submit($)({ text: "hi", asUser: true });
  expect(w.opens).toHaveLength(1);
});

test("/wip-kanban on opens the same pane and closes it with off; a bad argument only shows usage", async ($, on) => {
  const w = world();
  bottom(on, w);
  mock.clock(on);
  await start($, w);

  const onRun = await $.command.run({ command: "wip-kanban", args: "on" });
  expect(onRun.text).toBe("wip Kanban opened.");
  expect(w.opens.at(-1)).toMatchObject({ id: PANE_ID, title: "wip Kanban" });

  const offRun = await $.command.run({ command: "wip-kanban", args: "off" });
  expect(offRun.text).toBe("wip Kanban closed.");
  expect(w.closes).toMatchObject([{ id: PANE_ID }]);

  for (const args of ["", "toggle", "on off"]) {
    const bad = await $.command.run({ command: "wip-kanban", args });
    expect(bad).toEqual({ text: "Usage: /wip-kanban on|off" });
  }
  // A second open is the same id: the engine retitles an open pane, never a second instance.
  expect(new Set(w.opens.map((o) => o.id))).toEqual(new Set([PANE_ID]));
});

test("wip_bin: absolute as is, relative under the root, ~/ under HOME, absent or null as wip from the PATH", async ($, on) => {
  const w = world();
  bottom(on, w);
  mock.clock(on);
  const cases: { config: string | null; env: Record<string, string>; bin: string }[] = [
    { config: JSON.stringify({ wip_bin: "/opt/wip/bin/wip" }), env: {}, bin: "/opt/wip/bin/wip" },
    { config: JSON.stringify({ wip_bin: "./bin/wip" }), env: {}, bin: `${ROOT}/bin/wip` },
    {
      config: JSON.stringify({ wip_bin: "~/tools/wip" }),
      env: { HOME: "/home/me" },
      bin: "/home/me/tools/wip",
    },
    { config: JSON.stringify({ wip_bin: null }), env: {}, bin: "wip" },
    { config: null, env: {}, bin: "wip" },
  ];
  for (const c of cases) {
    w.config = c.config;
    w.env = c.env;
    w.calls = [];
    await start($, w);
    expect({ config: c.config, bin: w.calls[0]?.argv[0] }).toEqual({
      config: c.config,
      bin: c.bin,
    });
  }
});

test("an unusable config shows its error and runs no command", async ($, on) => {
  const w = world();
  bottom(on, w);
  mock.clock(on);
  const cases: [string, string][] = [
    ["{not json", ".wip/config.json is not valid JSON"],
    ["[1,2]", ".wip/config.json is not a JSON object"],
    [JSON.stringify({ wip_bin: 5 }), "wip_bin in .wip/config.json is not a string"],
    [JSON.stringify({ wip_bin: "~/wip" }), "wip_bin uses ~ but HOME is not set"],
  ];
  for (const [config, message] of cases) {
    w.config = config;
    w.env = {};
    w.calls = [];
    await start($, w);
    expect({ config, calls: w.calls }).toEqual({ config, calls: [] });
    const ui = await mount($, "terminal", 40);
    expect(drawnText(await ui.drawn())).toContain(`wip state failed: ${message}`);
    await ui.unmount();
  }
});

test("one read at a time: a tick during a held read is skipped, the next tick after it runs", async ($, on) => {
  let held = false;
  let release: ((reply: IRunReply) => void) | null = null;
  const w = world({
    reply: () =>
      held
        ? new Promise<IRunReply>((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ exitCode: 0, stdout: stateJson(), stderr: "" }),
  });
  bottom(on, w);
  const clock = mock.clock(on);
  await start($, w);
  const stateCalls = () => w.calls.filter((call) => call.argv[1] === "state");
  expect(stateCalls()).toHaveLength(1);

  held = true;
  await clock.advance(5000);
  expect(stateCalls()).toHaveLength(2);
  await clock.advance(5000);
  expect(stateCalls()).toHaveLength(2);

  (release as ((reply: IRunReply) => void) | null)?.({
    exitCode: 0,
    stdout: stateJson(),
    stderr: "",
  });
  await clock.settle();
  held = false;
  await clock.advance(5000);
  expect(stateCalls()).toHaveLength(3);
});

test("a first failure shows only the reason; a later one keeps the rows; a success clears it", async ($, on) => {
  let step = 0;
  const replies: IRunReply[] = [
    { exitCode: 1, stdout: "", stderr: "wip: no .wip/ here" },
    {
      exitCode: 0,
      stdout: stateJson([{ id: "K1", flow: "development", phase: "plan" }]),
      stderr: "",
    },
    { exitCode: 0, stdout: "not json", stderr: "" },
    {
      exitCode: 0,
      stdout: stateJson([{ id: "K2", flow: "development", phase: "execute" }]),
      stderr: "",
    },
  ];
  const w = world({
    reply: async () => replies[Math.min(step++, replies.length - 1)] as IRunReply,
  });
  bottom(on, w);
  const clock = mock.clock(on);

  await start($, w);
  let ui = await mount($, "terminal", 40);
  let text = drawnText(await ui.drawn());
  expect(text).toContain("wip state failed: wip: no .wip/ here");
  expect(text).not.toContain("No open items.");
  await ui.unmount();

  await clock.advance(5000);
  ui = await mount($, "terminal", 40);
  text = drawnText(await ui.drawn());
  expect(text).toContain("K1");
  expect(text).not.toContain("wip state failed");
  await ui.unmount();

  await clock.advance(5000);
  ui = await mount($, "terminal", 40);
  text = drawnText(await ui.drawn());
  expect(text).toContain("K1");
  expect(text).toContain("wip state failed: wip state --json did not print JSON");
  await ui.unmount();

  await clock.advance(5000);
  ui = await mount($, "terminal", 40);
  text = drawnText(await ui.drawn());
  expect(text).toContain("K2");
  expect(text).not.toContain("K1");
  expect(text).not.toContain("wip state failed");
});

test("an envelope that breaks the contract is a failure, never invented rows", async ($, on) => {
  const w = world();
  bottom(on, w);
  mock.clock(on);
  const cases: [TJson, string][] = [
    [
      { ok: false, data: { items: [], board: { flows: [] } } },
      "the JSON is not a successful wip envelope",
    ],
    [{ ok: true, data: { board: { flows: [] } } }, "data.items is not an array"],
    [{ ok: true, data: { items: [] } }, "data.board.flows is not an array"],
  ];
  for (const [body, message] of cases) {
    w.reply = async () => ({ exitCode: 0, stdout: JSON.stringify(body), stderr: "" });
    await start($, w);
    const ui = await mount($, "terminal", 40);
    const tree = await ui.drawn();
    expect(drawnText(tree)).toContain(`wip state failed: ${message}`);
    expect(textNodes(tree).some((n) => drawnText(n).includes("K"))).toBe(false);
    await ui.unmount();
  }
});

test("a non-zero exit with empty stderr falls back to stdout, and a rejection to the timeout message", async ($, on) => {
  let mode: "exit" | "reject" = "exit";
  const w = world({
    reply: async () => {
      if (mode === "reject") throw new Error("process run timed out after 4000 ms");
      return { exitCode: 2, stdout: "usage: wip state", stderr: "  " };
    },
  });
  bottom(on, w);
  const clock = mock.clock(on);
  await start($, w);
  let ui = await mount($, "terminal", 40);
  expect(drawnText(await ui.drawn())).toContain("wip state failed: usage: wip state");
  await ui.unmount();

  mode = "reject";
  await clock.advance(5000);
  ui = await mount($, "terminal", 40);
  expect(drawnText(await ui.drawn())).toContain("process run timed out after 4000 ms");
});

test("rows: first phase at 0, last at the right edge, one phase at 0, unknown and stageless fallbacks", async ($, on) => {
  const flows = [
    flow(
      "development",
      ["intake", "plan", "execute", "done"],
      [
        column("stage:todo", ["intake"], 1),
        column("stage:doing", ["plan", "execute"], 0.63),
        column("stage:closed", ["done"], 0.25),
      ],
    ),
    flow("solo", ["only"], [column("stage:only", ["only"], 1)]),
    {
      name: "plain",
      source: "file",
      phases: ["todo", "later"],
      columns: [column("phase:todo", ["todo"], null), column("phase:later", ["later"], null)],
    },
  ];
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson(
        [
          { id: "K1", flow: "development", phase: "intake" },
          { id: "K2", flow: "development", phase: "done" },
          { id: "K3", flow: "solo", phase: "only" },
          { id: "K4", flow: "plain", phase: "todo" },
          { id: "K5", flow: "development", phase: "ghost" },
        ],
        flows,
      ),
      stderr: "",
    }),
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);
  const ui = await mount($, "terminal", 20);
  const tree = await ui.drawn();

  expect(drawnText(rowText(tree, "K1") as INode)).toBe("K1 intake");
  expect(drawnText(rowText(tree, "K2") as INode)).toBe(`${" ".repeat(13)}K2 done`);
  expect(drawnText(rowText(tree, "K3") as INode)).toBe("K3 only");
  expect(drawnText(rowText(tree, "K4") as INode)).toBe("K4 todo");
  const unknown = drawnText(rowText(tree, "K5") as INode);
  expect(unknown).toBe("! K5 ghost");
  expect(styleOf(rowText(tree, "K5")).color).toBeUndefined();
  expect(styleOf(rowText(tree, "K4")).color).toBeUndefined();
});

test("labels are truncated inside bodyColumns and the offset is recomputed for another width", async ($, on) => {
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson([{ id: "K1", flow: "development", phase: "execute" }]),
      stderr: "",
    }),
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);

  const wide = await mount($, "terminal", 20);
  const wideRow = rowText(await wide.drawn(), "K1") as INode;
  // execute is index 2 of 4: ratio 2/3 of the room the label leaves.
  const offset = Math.round((2 / 3) * (20 - "K1 execute".length));
  expect(drawnText(wideRow)).toBe(`${" ".repeat(offset)}K1 execute`);
  await wide.unmount();

  const narrow = await mount($, "terminal", 8);
  const narrowRow = rowText(await narrow.drawn(), "K1") as INode;
  expect(drawnText(narrowRow)).toBe("K1 exec…");
  expect(drawnText(narrowRow).length).toBeLessThanOrEqual(8);
});

test("attention paints the solid stage colour in the dark scheme; a normal row uses the flow tone at full opacity", async ($, on) => {
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson([
        { id: "K1", flow: "development", phase: "plan", attention: true },
        { id: "K2", flow: "development", phase: "execute" },
      ]),
      stderr: "",
    }),
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);

  const tree = await (await mount($, "terminal", 40)).drawn();
  expect(styleOf(rowText(tree, "K1"))).toMatchObject({
    backgroundColor: "#223051",
    color: "#FFFFFF",
  });
  expect(styleOf(rowText(tree, "K2"))).toMatchObject({ color: "rgb(37, 99, 235)" });
  expect(styleOf(rowText(tree, "K2")).backgroundColor).toBeUndefined();
  expect(styleOf(rowText(tree, "K2")).underline).toBeUndefined();
});

test(
  "the light scheme paints the attention background and every row uses the flow tone",
  { options: { colorScheme: "light" } },
  async ($, on) => {
    const w = world({
      reply: async () => ({
        exitCode: 0,
        stdout: stateJson([
          { id: "L1", flow: "development", phase: "plan", attention: true },
          { id: "L2", flow: "development", phase: "execute" },
        ]),
        stderr: "",
      }),
    });
    bottom(on, w);
    mock.clock(on);
    await start($, w);

    const tree = await (await mount($, "terminal", 40)).drawn();
    expect(styleOf(rowText(tree, "L1"))).toMatchObject({
      backgroundColor: "#2563EB",
      color: "#FFFFFF",
    });
    expect(styleOf(rowText(tree, "L2"))).toMatchObject({ color: "rgb(37, 99, 235)" });
  },
);

test("a late phase is not dimmed: the row paints the flow tone at full opacity", async ($, on) => {
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson([{ id: "K1", flow: "development", phase: "done" }]),
      stderr: "",
    }),
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);

  const tree = await (await mount($, "terminal", 40)).drawn();
  expect(styleOf(rowText(tree, "K1"))).toMatchObject({ color: "rgb(37, 99, 235)" });
  expect(styleOf(rowText(tree, "K1")).backgroundColor).toBeUndefined();
});

test("a flow with its own colour paints that tone at full opacity", async ($, on) => {
  const custom = column("stage:doing", ["intake", "plan", "execute", "done"], 0.25);
  custom.color = "rgba(168, 85, 247, 0.25)";
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson(
        [{ id: "K1", flow: "development", phase: "execute" }],
        [flow("development", ["intake", "plan", "execute", "done"], [custom])],
      ),
      stderr: "",
    }),
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);

  const tree = await (await mount($, "terminal", 40)).drawn();
  expect(styleOf(rowText(tree, "K1")).color).toBe("rgb(168, 85, 247)");
});

test("a stageless phase with attention uses the dark amber fallback", async ($, on) => {
  const flows = [
    {
      name: "plain",
      source: "file",
      phases: ["todo"],
      columns: [column("phase:todo", ["todo"], null)],
    },
  ];
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson([{ id: "A1", flow: "plain", phase: "todo", attention: true }], flows),
      stderr: "",
    }),
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);
  const row = rowText(await (await mount($, "terminal", 20)).drawn(), "A1") as INode;
  expect(styleOf(row).backgroundColor).toBe("#352612");
  expect(styleOf(row).color).toBe("#FFFFFF");
});

test(
  "a stageless phase with attention uses the light amber fallback",
  { options: { colorScheme: "light" } },
  async ($, on) => {
    const flows = [
      {
        name: "plain",
        source: "file",
        phases: ["todo"],
        columns: [column("phase:todo", ["todo"], null)],
      },
    ];
    const w = world({
      reply: async () => ({
        exitCode: 0,
        stdout: stateJson([{ id: "A1", flow: "plain", phase: "todo", attention: true }], flows),
        stderr: "",
      }),
    });
    bottom(on, w);
    mock.clock(on);
    await start($, w);
    const row = rowText(await (await mount($, "terminal", 20)).drawn(), "A1") as INode;
    expect(styleOf(row).backgroundColor).toBe("#FFF1D6");
    expect(styleOf(row).color).toBe("#111111");
  },
);

test("the flow filters sit last, right-aligned, dim and one column apart", async ($, on) => {
  const flows = [flow("development", ["intake", "done"]), flow("tasks", ["intake", "done"])];
  const items = [
    { id: "K1", flow: "development", phase: "intake" },
    { id: "T1", flow: "tasks", phase: "intake" },
  ];
  const w = world({
    reply: async () => ({ exitCode: 0, stdout: stateJson(items, flows), stderr: "" }),
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);
  const ui = await mount($, "terminal", 40);

  const filters = await ui.find({ type: "Box", key: "filters" });
  expect(filters?.props).toMatchObject({
    flexDirection: "row",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    columnGap: 1,
    width: 40,
  });

  const buttons = await ui.findAll({ type: "Button" });
  expect(buttons).toHaveLength(2);
  expect(buttons.map((button) => button.key)).toEqual(["filter:development", "filter:tasks"]);
  expect(buttons.map((button) => button.text)).toEqual(["✓ development", "✓ tasks"]);
  for (const button of buttons) {
    expect(button.props.dimColor).toBe(true);
    expect(button.props.plain).toBe(true);
  }

  // The row's only children are the two Buttons: the one-column gap is layout, not a Text between them.
  const rows =
    filters?.children.filter((child) => typeof child === "object" && child !== null) ?? [];
  expect(rows.map((child) => (child as INode).type)).toEqual(["Button", "Button"]);

  // The row is the last thing in the tree: the buttons come after every item row.
  const text = drawnText(await ui.drawn());
  expect(text.indexOf("✓ development")).toBeGreaterThan(text.lastIndexOf("K1"));
  expect(text.indexOf("✓ tasks")).toBeGreaterThan(text.lastIndexOf("T1"));
});

test("the board prints no flow titles and a flow with no items is only its button", async ($, on) => {
  const flows = [flow("development", ["intake", "done"]), flow("tasks", ["intake", "done"])];
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson([{ id: "K1", flow: "development", phase: "intake" }], flows),
      stderr: "",
    }),
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);
  const ui = await mount($, "terminal", 40);

  const tree = await ui.drawn();
  expect(drawnText(tree)).toContain("K1");
  expect(drawnText(tree)).toContain("✓ tasks");
  expect(drawnText(tree)).not.toContain("No open items.");
  const titles = textNodes(tree).map((node) => drawnText(node));
  expect(titles).not.toContain("development");
  expect(titles).not.toContain("tasks");

  // Hiding the empty flow keeps the board's one item and draws no extra row for it.
  await ui.press({ key: "filter:tasks" });
  expect((await ui.find({ type: "Button", key: "filter:tasks" }))?.text).toBe("✗ tasks");
  expect(drawnText(await ui.drawn())).toContain("K1");
  await ui.unmount();

  // No items at all: `No open items.` appears once, above the button row.
  w.reply = async () => ({ exitCode: 0, stdout: stateJson(), stderr: "" });
  w.root = "/projects/empty";
  await start($, w);
  const empty = await mount($, "terminal", 40);
  const text = drawnText(await empty.drawn());
  expect(text.split("No open items.")).toHaveLength(2);
  expect(text.indexOf("No open items.")).toBeLessThan(text.indexOf("✓ development"));
});

test("every flow is visible by default; a toggle hides its items and persists per project root", async ($, on) => {
  const flows = [flow("development", ["intake", "done"]), flow("tasks", ["intake", "done"])];
  const items = [
    { id: "K1", flow: "development", phase: "intake" },
    { id: "T1", flow: "tasks", phase: "intake" },
  ];
  const w = world({
    reply: async () => ({ exitCode: 0, stdout: stateJson(items, flows), stderr: "" }),
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);
  const ui = await mount($, "terminal", 40);
  let tree = await ui.drawn();
  expect(drawnText(tree)).toContain("K1");
  expect(drawnText(tree)).toContain("T1");
  expect((await ui.find({ type: "Button", key: "filter:development" }))?.text).toBe(
    "✓ development",
  );

  await ui.press({ key: "filter:development" });
  tree = await ui.drawn();
  expect(drawnText(tree)).not.toContain("K1");
  expect(drawnText(tree)).toContain("T1");
  expect((await ui.find({ type: "Button", key: "filter:development" }))?.text).toBe(
    "✗ development",
  );
  expect(w.store["hidden-flows-v1"]).toEqual({ [ROOT]: ["development"] });
  await ui.unmount();

  // Another project root reads its own list: the first root's hidden flow does not follow it.
  w.root = "/projects/other";
  await start($, w);
  const other = await mount($, "terminal", 40);
  expect((await other.find({ type: "Button", key: "filter:development" }))?.text).toBe(
    "✓ development",
  );
  expect(drawnText(await other.drawn())).toContain("K1");

  await other.press({ key: "filter:tasks" });
  expect(w.store["hidden-flows-v1"]).toEqual({
    [ROOT]: ["development"],
    "/projects/other": ["tasks"],
  });
  await other.unmount();
});

test("an invalid stored filter list reads as none; hiding every flow shows how to bring them back", async ($, on) => {
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson([{ id: "K1", flow: "development", phase: "intake" }]),
      stderr: "",
    }),
    store: { "hidden-flows-v1": { [ROOT]: "nope" } },
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);
  const ui = await mount($, "terminal", 40);
  expect(drawnText(await ui.drawn())).toContain("K1");

  await ui.press({ key: "filter:development" });
  const tree = await ui.drawn();
  expect(drawnText(tree)).toContain("All flows are hidden; press a ✗ flow below to show it.");
  expect(w.store["hidden-flows-v1"]).toEqual({ [ROOT]: ["development"] });
});

test("an item links to the wip web with the exact href", async ($, on) => {
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson([{ id: "kanban-mod", flow: "development", phase: "plan" }]),
      stderr: "",
    }),
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);
  const ui = await mount($, "terminal", 40);
  const link = await ui.find({ type: "Link" });
  expect(link?.props.href).toBe("http://localhost:33333/?item=development%2Fkanban-mod");
  expect(link?.text).toContain("kanban-mod plan");
});

test(
  "another webUrl keeps its host and replaces path, query and hash",
  { options: { webUrl: "https://wip.example.com/base?x=1#frag" } },
  async ($, on) => {
    const w = world({
      reply: async () => ({
        exitCode: 0,
        stdout: stateJson([{ id: "a b", flow: "development", phase: "plan" }]),
        stderr: "",
      }),
    });
    bottom(on, w);
    mock.clock(on);
    await start($, w);
    const link = await (await mount($, "terminal", 40)).find({ type: "Link" });
    expect(link?.props.href).toBe("https://wip.example.com/?item=development%2Fa+b");
  },
);

test(
  "an invalid webUrl leaves the IDs as text and says why",
  { options: { webUrl: "ftp://nope" } },
  async ($, on) => {
    const w = world({
      reply: async () => ({
        exitCode: 0,
        stdout: stateJson([{ id: "K1", flow: "development", phase: "plan" }]),
        stderr: "",
      }),
    });
    bottom(on, w);
    mock.clock(on);
    await start($, w);
    const ui = await mount($, "terminal", 40);
    expect(await ui.find({ type: "Link" })).toBeUndefined();
    expect(drawnText(await ui.drawn())).toContain(
      "webUrl is not a valid http(s) URL; items are not links.",
    );
    expect(drawnText(await ui.drawn())).toContain("K1 plan");
  },
);

test("a running wip web wins over webUrl: rows link to this project's Local URL", async ($, on) => {
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson([{ id: "kanban-mod", flow: "development", phase: "plan" }]),
      stderr: "",
    }),
    status: async () => running(34002),
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);
  const ui = await mount($, "terminal", 40);
  const link = await ui.find({ type: "Link" });
  expect(link?.props.href).toBe("http://localhost:34002/?item=development%2Fkanban-mod");
});

test(
  "a custom webUrl is only the fallback: a running server wins, no server leaves its host",
  { options: { webUrl: "https://wip.example.com/" } },
  async ($, on) => {
    const w = world({
      reply: async () => ({
        exitCode: 0,
        stdout: stateJson([{ id: "kanban-mod", flow: "development", phase: "plan" }]),
        stderr: "",
      }),
      status: async () => running(34002),
    });
    bottom(on, w);
    mock.clock(on);
    await start($, w);
    const live = await mount($, "terminal", 40);
    expect((await live.find({ type: "Link" }))?.props.href).toBe(
      "http://localhost:34002/?item=development%2Fkanban-mod",
    );
    await live.unmount();

    w.status = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "wip web is not running for /projects/demo",
    });
    await start($, w);
    const fallback = await mount($, "terminal", 40);
    expect((await fallback.find({ type: "Link" }))?.props.href).toBe(
      "https://wip.example.com/?item=development%2Fkanban-mod",
    );
  },
);

test("the link follows a server restart: the next poll after 15 s takes the new port", async ($, on) => {
  let port = 34002;
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson([{ id: "K1", flow: "development", phase: "plan" }]),
      stderr: "",
    }),
    status: async () => running(port),
  });
  bottom(on, w);
  const clock = mock.clock(on);
  await start($, w);
  const first = await mount($, "terminal", 40);
  expect((await first.find({ type: "Link" }))?.props.href).toBe(
    "http://localhost:34002/?item=development%2FK1",
  );
  await first.unmount();

  port = 34003;
  await clock.advance(15000);
  const second = await mount($, "terminal", 40);
  expect((await second.find({ type: "Link" }))?.props.href).toBe(
    "http://localhost:34003/?item=development%2FK1",
  );
});

test("a failed web status keeps the rows, links to the fallback and shows no error", async ($, on) => {
  const w = world({
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson([{ id: "K1", flow: "development", phase: "plan" }]),
      stderr: "",
    }),
  });
  bottom(on, w);
  mock.clock(on);
  const cases: (() => Promise<IRunReply>)[] = [
    async () => ({ exitCode: 2, stdout: "usage: wip web status", stderr: "" }),
    async () => {
      throw new Error("process run timed out after 4000 ms");
    },
    async () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
  ];
  for (const status of cases) {
    w.status = status;
    await start($, w);
    const ui = await mount($, "terminal", 40);
    const tree = await ui.drawn();
    expect((await ui.find({ type: "Link" }))?.props.href).toBe(
      "http://localhost:33333/?item=development%2FK1",
    );
    expect(drawnText(tree)).toContain("K1 plan");
    expect(drawnText(tree)).not.toContain("wip state failed");
    expect(drawnText(tree)).not.toContain("webUrl is not a valid");
    await ui.unmount();
  }
});

test("wip web status uses the same resolved wip_bin as wip state", async ($, on) => {
  const w = world({
    config: JSON.stringify({ wip_bin: "/opt/wip/bin/wip" }),
    reply: async () => ({
      exitCode: 0,
      stdout: stateJson([{ id: "K1", flow: "development", phase: "plan" }]),
      stderr: "",
    }),
    status: async () => running(34002),
  });
  bottom(on, w);
  mock.clock(on);
  await start($, w);
  expect(w.calls.map((call) => call.argv)).toEqual([
    ["/opt/wip/bin/wip", "state", "--json"],
    ["/opt/wip/bin/wip", "web", "status", "--json"],
  ]);
});

test("no items says so, and the tree validates in dock and inline on terminal and desktop", async ($, on) => {
  const w = world();
  bottom(on, w);
  mock.clock(on);
  await start($, w);

  for (const surface of ["terminal", "desktop"] as const) {
    for (const placement of ["dock", "inline"] as const) {
      const ui = await mount($, surface, 40, placement);
      const tree = await ui.drawn();
      const text = drawnText(tree);
      expect(text).toContain("No open items.");
      expect(text).toContain("✓ development");
      expect(text.indexOf("No open items.")).toBeLessThan(text.indexOf("✓ development"));
      expect(textNodes(tree).map((node) => drawnText(node))).not.toContain("development");
      expect(tree).toBeDefined();
      await ui.unmount();
    }
  }
});
