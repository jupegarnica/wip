import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  composite,
  flowColumns,
  STAGE_ALPHA_FIRST,
  STAGE_ALPHA_LAST,
  STAGE_TONE,
  SURFACE_DARK,
  SURFACE_LIGHT,
  stageAlpha,
  stageColor,
  textOn,
} from "../../src/board.ts";
import { setClockForTests } from "../../src/clock.ts";
import { commandHelp, findCommand, type ICommandSpec } from "../../src/commands/help.ts";
import {
  browserCommand,
  type IWebMainOptions,
  NOT_RUNNING,
  openBrowser,
  portInUse,
  probe,
  urlLines,
  webMain,
} from "../../src/commands/web.ts";
import { SCHEMA_VERSION } from "../../src/db.ts";
import { MARKDOWN_LIB, WEB } from "../../src/embedded/web.ts";
import { rootAt, type TEnv } from "../../src/env.ts";
import { EXIT } from "../../src/errors.ts";
import { parseFlow } from "../../src/flow/parse.ts";
import { fileLog, rotateIfNeeded, webLogPath } from "../../src/web/log.ts";
import {
  legacyWebPidPath,
  readWebServers,
  webServerPath,
  webServersDir,
} from "../../src/web/pidfile.ts";
import {
  ARTIFACT_CSP,
  allowedHosts,
  type IWebServer,
  PAGE_CSP,
  privateIPv4s,
  privateRank,
  startWeb,
} from "../../src/web/server.ts";
import { fieldLinks, itemLinks, openReadOnly } from "../../src/web/state.ts";
import { WIP_CMD } from "../helpers/bin.ts";
import { fixture, minimalFlow, putFlow } from "../helpers/defs.ts";
import { at, itemInPlan, itemsProject, ok, T0, tick, useProject } from "../helpers/items.ts";
import { type IProject, makeProject, scratch } from "../helpers/project.ts";

const REPO = join(import.meta.dir, "..", "..");
const ctx = useProject();
let web: IWebServer | null = null;
let other: ReturnType<typeof Bun.serve> | null = null;
const occupied: { stop: () => void }[] = [];

afterEach(async () => {
  await web?.stop();
  web = null;
  other?.stop(true);
  other = null;
  for (const o of occupied.splice(0)) o.stop();
});

/** Another program listening on host:port until the test ends. */
function occupy(port: number, hostname = "127.0.0.1"): void {
  const s = Bun.serve({ hostname, port, fetch: () => new Response("busy") });
  occupied.push({ stop: () => s.stop(true) });
}

// Far from the real wip web ports (33333-33352, 39100-39102), which may be serving on this machine.
const RANGE_FLOOR = 41000;
const RANGE_SPAN = 18000;

/** The first of `n` consecutive ports nothing accepts on, on 127.0.0.1 nor [::1]. */
async function freeRange(n: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = RANGE_FLOOR + Math.floor(Math.random() * RANGE_SPAN);
    let free = true;
    for (let port = base; port < base + n && free; port++) free = !(await portInUse(port));
    if (free) return base;
  }
  throw new Error(`no ${n} free consecutive ports`);
}

// biome-ignore lint/suspicious/noExplicitAny: JSON bodies of the API under test
type TJson = any;

async function serve(p: IProject): Promise<IWebServer> {
  web = await startWeb({ port: 0, root: rootAt(p.dir), local: true });
  return web;
}

function get(path: string, init?: RequestInit): Promise<Response> {
  if (!web) throw new Error("no server");
  return fetch(`http://127.0.0.1:${web.port}${path}`, init);
}

async function getJson(path: string): Promise<TJson> {
  const res = await get(path);
  expect({ path, status: res.status }).toEqual({ path, status: 200 });
  return res.json();
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

/** T1 waits on the user at a gate, T2 runs an agent, T3 is archived in done, T4 archived in plan, A1 is minimal. */
function board(): IProject {
  const p = ctx.set(itemsProject("web"));
  putFlow(p.dir, "minimal", minimalFlow());
  itemInPlan(p, "T1");
  ok(p, ["gate", "open", "T1", "--question", "Approve the plan?"]);
  ok(p, ["wait", "T1", "user", "--next", "read plan.md"]);
  tick(60);
  itemInPlan(p, "T2");
  ok(p, ["agent", "start", "T2", "thinker", "--handle", "h2"]);
  tick(120);
  itemInPlan(p, "T3");
  ok(p, ["phase", "T3", "execute"]);
  ok(p, ["phase", "T3", "verify"]);
  ok(p, ["phase", "T3", "done"]);
  ok(p, ["archive", "T3"]);
  tick(180);
  itemInPlan(p, "T4");
  ok(p, ["archive", "T4"]);
  tick(240);
  ok(p, ["phase", "A1", "todo", "--flow", "minimal", "--wait", "external"]);
  return p;
}

describe("wip web · /api/kanban (F-WEB-04, 05, 06, 09, 11, 12)", () => {
  test("columns by stage, or by phase when the flow declares none; every flow even without items", async () => {
    const p = board();
    putFlow(p.dir, "empty", minimalFlow());
    await serve(p);
    const body = await getJson("/api/kanban");
    expect(body.flows.map((f: TJson) => f.name)).toEqual(["empty", "minimal", "valid"]);
    const valid = body.flows.find((f: TJson) => f.name === "valid");
    expect(valid.columns.map((c: TJson) => [c.key, c.phases])).toEqual([
      ["stage:todo", ["intake"]],
      ["stage:doing", ["plan", "execute", "verify"]],
      ["stage:closed", ["done"]],
    ]);
    const minimal = body.flows.find((f: TJson) => f.name === "minimal");
    expect(minimal.columns.map((c: TJson) => [c.key, c.label])).toEqual([
      ["phase:todo", "todo"],
      ["phase:done", "done"],
    ]);
    // F-WEB-11: one tone, more transparent stage after stage; a column without a stage has no colour.
    expect(valid.columns.map((c: TJson) => [c.alpha, c.color])).toEqual([
      [1, stageColor(1)],
      [0.63, stageColor(0.63)],
      [0.25, stageColor(0.25)],
    ]);
    expect(valid.phases).toEqual(["intake", "plan", "execute", "verify", "done"]);
    expect(valid.columns[0]).toMatchObject({ text: "#FFFFFF", text_dark: "#FFFFFF" });
    expect(valid.columns[2]).toMatchObject({ text: "#111111", text_dark: "#FFFFFF" });
    expect(valid.columns.map((c: TJson) => c.color_light)).toEqual([
      composite(STAGE_TONE, 1, SURFACE_LIGHT),
      composite(STAGE_TONE, 0.63, SURFACE_LIGHT),
      composite(STAGE_TONE, 0.25, SURFACE_LIGHT),
    ]);
    expect(valid.columns.map((c: TJson) => c.color_dark)).toEqual([
      composite(STAGE_TONE, 1, SURFACE_DARK),
      composite(STAGE_TONE, 0.63, SURFACE_DARK),
      composite(STAGE_TONE, 0.25, SURFACE_DARK),
    ]);
    expect(valid.columns.map((c: TJson) => c.text)).toEqual(
      valid.columns.map((c: TJson) => textOn(c.color_light)),
    );
    for (const c of minimal.columns) {
      expect(c).toMatchObject({
        alpha: null,
        color: "",
        color_light: "",
        color_dark: "",
        text: "",
        text_dark: "",
      });
    }
    const t1 = body.items.find((i: TJson) => i.id === "T1");
    expect(t1).toMatchObject({
      column: "stage:doing",
      stage: "doing",
      alpha: 0.63,
      color: stageColor(0.63),
      color_light: composite(STAGE_TONE, 0.63, SURFACE_LIGHT),
      color_dark: composite(STAGE_TONE, 0.63, SURFACE_DARK),
      text: textOn(composite(STAGE_TONE, 0.63, SURFACE_LIGHT)),
      text_dark: textOn(composite(STAGE_TONE, 0.63, SURFACE_DARK)),
    });
    const a1 = body.items.find((i: TJson) => i.id === "A1");
    expect(a1).toMatchObject({ column: "phase:todo", stage: null, alpha: null, color: "" });
  });

  test("data.board.flows is the same model /api/kanban serves", async () => {
    const p = board();
    await serve(p);
    const kanban = await getJson("/api/kanban");
    const state = ok(p, ["state"]);
    expect((state.data as { board: TJson }).board.flows).toEqual(kanban.flows);
    expect(kanban.flows.map((f: TJson) => f.phases)).toEqual([
      ["todo", "done"],
      ["intake", "plan", "execute", "verify", "done"],
    ]);
  });

  test("a flow with `color` paints its stages in that tone and the others stay blue", async () => {
    const p = board();
    const valid = fixture("flows", "valid");
    expect(valid).toContain("\nversion: 1\n");
    putFlow(p.dir, "gold", valid.replace("\nversion: 1\n", '\nversion: 1\ncolor: "#eab308"\n'));
    await serve(p);
    const body = await getJson("/api/kanban");
    const gold = body.flows.find((f: TJson) => f.name === "gold");
    const blue = body.flows.find((f: TJson) => f.name === "valid");
    expect(gold.columns.map((c: TJson) => [c.alpha, c.color])).toEqual([
      [1, stageColor(1, "#EAB308")],
      [0.63, stageColor(0.63, "#EAB308")],
      [0.25, stageColor(0.25, "#EAB308")],
    ]);
    expect(gold.columns[0].color).toBe("rgba(234, 179, 8, 1)");
    expect(gold.columns[0]).toMatchObject({ text: "#111111", text_dark: "#111111" });
    expect(gold.columns[2]).toMatchObject({ text: "#111111", text_dark: "#FFFFFF" });
    expect(blue.columns.map((c: TJson) => c.color)).toEqual([
      stageColor(1),
      stageColor(0.63),
      stageColor(0.25),
    ]);
    expect(blue.columns[0].color).toBe("rgba(37, 99, 235, 1)");
  });

  test("stage opacity steps evenly for any number of stages, from opaque to the last step", () => {
    expect(stageAlpha(0, 1)).toBe(STAGE_ALPHA_FIRST);
    expect([0, 1].map((i) => stageAlpha(i, 2))).toEqual([1, 0.25]);
    expect([0, 1, 2, 3, 4].map((i) => stageAlpha(i, 5))).toEqual([1, 0.81, 0.63, 0.44, 0.25]);
    expect(stageAlpha(6, 7)).toBe(STAGE_ALPHA_LAST);
    expect(stageColor(0.5)).toBe("rgba(37, 99, 235, 0.5)");
    expect(STAGE_TONE).toBe("#2563EB");
    // Text follows the composite in each theme, so a faint stage keeps contrast in light and dark.
    expect(composite(STAGE_TONE, 0, SURFACE_DARK)).toBe(SURFACE_DARK);
    expect(textOn(composite(STAGE_TONE, 0.25, SURFACE_LIGHT))).toBe("#111111");
    expect(textOn(composite(STAGE_TONE, 0.25, SURFACE_DARK))).toBe("#FFFFFF");
  });

  test("the tasks flow paints its three stages and nothing else", () => {
    const text = readFileSync(
      join(REPO, "templates", "skills", "wip-flow-tasks", "SKILL.md"),
      "utf8",
    );
    const columns = flowColumns(parseFlow("tasks", text).flow);
    expect(columns.map((c) => [c.label, c.phases, c.alpha])).toEqual([
      ["preparation", ["intake", "research", "plan"], 1],
      ["execution", ["execute", "check"], 0.63],
      ["review", ["review", "deliver", "done"], 0.25],
    ]);
  });

  test("items, «your turn» and signals are what `wip state` and `wip state --attention` compute", async () => {
    const p = board();
    await serve(p);
    const body = await getJson("/api/kanban");
    const state = ok(p, ["state"]).data?.items as TJson[];
    const attention = ok(p, ["state", "--attention"]).data?.items as TJson[];
    expect(body.items.map((i: TJson) => i.id)).toEqual(state.map((i) => i.id));
    for (const s of state) {
      expect(body.items.find((i: TJson) => i.id === s.id)).toMatchObject(s);
    }
    expect(body.your_turn.map((i: TJson) => i.id)).toEqual(attention.map((i) => i.id));
    expect(body.your_turn).toEqual([
      {
        id: "T1",
        flow: "valid",
        title: null,
        phase: "plan",
        next: "read plan.md",
        questions: ["Approve the plan?"],
        links: [{ label: "T1", url: "https://tracker.example.com/t/1", source: "id" }],
      },
    ]);
  });

  test("open gates and running agents of open items, oldest first", async () => {
    const p = board();
    at("2026-10-30T11:00:00Z");
    ok(p, ["agent", "start", "A1", "fast"]);
    await serve(p);
    const body = await getJson("/api/kanban");
    expect(body.open_gates).toEqual([
      {
        item_id: "T1",
        flow: "valid",
        phase: "plan",
        question: "Approve the plan?",
        opened_at: T0,
        links: [{ label: "T1", url: "https://tracker.example.com/t/1", source: "id" }],
      },
    ]);
    expect(body.running.map((r: TJson) => [r.item_id, r.agent, r.handle])).toEqual([
      ["T2", "thinker", "h2"],
      ["A1", "fast", null],
    ]);
  });

  test("a write shows up in the next request; the same board is the same text", async () => {
    const p = board();
    await serve(p);
    const first = await (await get("/api/kanban")).text();
    tick(600);
    expect(await (await get("/api/kanban")).text()).toBe(first);
    ok(p, ["wait", "A1", "user", "--next", "look"]);
    const after = await getJson("/api/kanban");
    expect(after.your_turn.map((i: TJson) => i.id)).toEqual(["A1", "T1"]);
  });

  test("right after `wip init` (no database yet) the board answers with empty flows", async () => {
    const p = ctx.set(makeProject("web-nodb"));
    putFlow(p.dir, "minimal", minimalFlow());
    await serve(p);
    const body = await getJson("/api/kanban");
    expect(body.items).toEqual([]);
    expect(body.flows.map((f: TJson) => f.name)).toEqual(["minimal"]);
    expect(existsSync(p.dbPath)).toBe(false);
  });

  test("a flow file that breaks keeps its last valid version, with the warning", async () => {
    const p = board();
    putFlow(p.dir, "minimal", "# broken\n");
    await serve(p);
    const body = await getJson("/api/kanban");
    expect(body.flows.find((f: TJson) => f.name === "minimal").source).toBe("stored");
    expect(body.warnings.map((w: TJson) => [w.code, w.flow])).toEqual([
      ["flow_invalid", "minimal"],
    ]);
  });
});

describe("wip web · links (F-FLU-10, F-WEB-12)", () => {
  test("a pattern matches the ID or a field value and fills $1…", () => {
    const flow = {
      links: [
        { pattern: "^T([0-9]+)$", url: "https://tracker.example.com/t/$1" },
        { pattern: "^PR-([0-9]+)$", url: "https://git.example.com/pull/$1" },
      ],
    } as Parameters<typeof itemLinks>[0];
    expect(itemLinks(flow, "T7", { pr: "PR-12", tags: ["x", "PR-13"], n: 3 })).toEqual([
      { label: "T7", url: "https://tracker.example.com/t/7", source: "id" },
      { label: "PR-12", url: "https://git.example.com/pull/12", source: "pr" },
      { label: "PR-13", url: "https://git.example.com/pull/13", source: "tags" },
    ]);
    expect(itemLinks(null, "T7", {})).toEqual([]);
  });

  test("fieldLinks lists every absolute http(s) URL of the fields, once", () => {
    expect(fieldLinks({})).toEqual([]);
    expect(
      fieldLinks({
        pr: "https://github.com/acme/wip/pull/7",
        prs: [
          "https://github.com/acme/wip/pull/8",
          "https://github.com/acme/wip/pull/9",
          "not a url",
          7,
          "",
        ],
      }),
    ).toEqual([
      {
        label: "https://github.com/acme/wip/pull/7",
        url: "https://github.com/acme/wip/pull/7",
        source: "pr",
      },
      {
        label: "https://github.com/acme/wip/pull/8",
        url: "https://github.com/acme/wip/pull/8",
        source: "prs",
      },
      {
        label: "https://github.com/acme/wip/pull/9",
        url: "https://github.com/acme/wip/pull/9",
        source: "prs",
      },
    ]);
  });

  test("fieldLinks normalizes the scheme, keeps the text and drops what is not a URL", () => {
    expect(fieldLinks({ docs: "HTTPS://Example.com/x" })).toEqual([
      { label: "HTTPS://Example.com/x", url: "https://example.com/x", source: "docs" },
    ]);
    expect(
      fieldLinks({
        pr: "https://github.com/acme/wip/pull/7",
        mirror: "https://github.com/acme/wip/pull/7",
      }),
    ).toEqual([
      {
        label: "https://github.com/acme/wip/pull/7",
        url: "https://github.com/acme/wip/pull/7",
        source: "pr",
      },
    ]);
    expect(
      fieldLinks({
        n: 3,
        empty: "",
        ftp: "ftp://x/y",
        mail: "mailto:a@b.c",
        proto: "//x/y",
        prose: "see https://x",
        num: "#7",
        nested: { url: "https://x/y" },
      }),
    ).toEqual([]);
  });

  test("cards, history and the item panel carry the links", async () => {
    const p = board();
    await serve(p);
    const link = { label: "T1", url: "https://tracker.example.com/t/1", source: "id" };
    const kanban = await getJson("/api/kanban");
    expect(kanban.items.find((i: TJson) => i.id === "T1").links).toEqual([link]);
    const history = await getJson("/api/history");
    expect(history.items.find((i: TJson) => i.id === "T1").links).toEqual([link]);
    expect((await getJson("/api/item/valid/T1")).links).toEqual([link]);
    expect(kanban.items.find((i: TJson) => i.id === "A1").links).toEqual([]);
  });

  test("/api/item carries the URLs of the fields as field_links, and only there", async () => {
    const p = ctx.set(makeProject("web-field-links"));
    putFlow(
      p.dir,
      "prs",
      [
        "```wip-flow",
        "version: 1",
        "fields:",
        "  pr: string",
        "  prs: list",
        "  note: string",
        "phases:",
        "  - name: todo",
        "    next: [done]",
        "  - name: done",
        "    kind: terminal",
        "```",
        "",
      ].join("\n"),
    );
    ok(p, ["phase", "P1", "todo", "--flow", "prs", "--wait", "external"]);
    ok(p, [
      "set",
      "P1",
      "pr=https://github.com/acme/wip/pull/7",
      "prs=https://github.com/acme/wip/pull/8,https://github.com/acme/wip/pull/9",
      "note=#7",
    ]);
    await serve(p);
    const body = await getJson("/api/item/prs/P1");
    expect(body.field_links).toEqual([
      {
        label: "https://github.com/acme/wip/pull/7",
        url: "https://github.com/acme/wip/pull/7",
        source: "pr",
      },
      {
        label: "https://github.com/acme/wip/pull/8",
        url: "https://github.com/acme/wip/pull/8",
        source: "prs",
      },
      {
        label: "https://github.com/acme/wip/pull/9",
        url: "https://github.com/acme/wip/pull/9",
        source: "prs",
      },
    ]);
    expect(body.links).toEqual([]);
    expect(body.item.fields.pr).toBe("https://github.com/acme/wip/pull/7");
    expect(body.item.fields.note).toBe("#7");
    const card = (await getJson("/api/kanban")).items.find((i: TJson) => i.id === "P1");
    expect(card.links).toEqual([]);
    expect("field_links" in card).toBe(false);
    const row = (await getJson("/api/history")).items.find((i: TJson) => i.id === "P1");
    expect(row.links).toEqual([]);
    expect("field_links" in row).toBe(false);
  });
});

describe("wip web · item panel (F-WEB-07, F-WEB-10)", () => {
  test("/api/item/<flow>/<ID> is `wip show --json` plus links, field_links and artifacts", async () => {
    const p = board();
    at("2026-10-30T12:00:00Z");
    await serve(p);
    const body = await getJson("/api/item/valid/T1");
    const shown = ok(p, ["show", "T1"]);
    expect(body.item).toEqual(shown.item);
    expect(body.events).toEqual(shown.events);
    expect({
      agent_runs: body.agent_runs,
      gates: body.gates,
      signals: body.signals,
      totals: body.totals,
      crons: body.crons,
    }).toEqual(shown.data as TJson);
    expect(body.totals.user_wait_seconds).toBe(7200);
    expect(body.field_links).toEqual([]);
  });

  test("an unknown item, another flow or a bad segment is 404", async () => {
    const p = board();
    await serve(p);
    for (const path of [
      "/api/item/valid/NOPE1",
      "/api/item/minimal/T1",
      "/api/item/valid",
      "/api/item/valid/T1/x",
      "/api/item/valid/..",
      "/api/item/valid/%2e%2e",
      "/api/item/Valid/T1",
      "/api/item/valid/T1%2F..",
      "/api/item/valid/%E0%A4%A",
    ]) {
      expect({ path, status: (await get(path)).status }).toEqual({ path, status: 404 });
    }
  });

  test("artifacts: regular files of .wip/items/<flow>/<ID>/ only, as text with the sandbox CSP", async () => {
    const p = board();
    const dir = join(p.dir, ".wip", "items", "valid", "T1");
    mkdirSync(join(dir, "sub"), { recursive: true });
    const plan = "# Plan\n<script>alert(1)</script>\n";
    writeFileSync(join(dir, "plan.md"), plan);
    writeFileSync(join(dir, "b.txt"), "b\n");
    writeFileSync(join(dir, ".hidden.md"), "hidden\n");
    writeFileSync(join(dir, "sub", "inner.md"), "inner\n");
    writeFileSync(join(p.dir, "outside.txt"), "outside\n");
    symlinkSync(join(p.dir, "outside.txt"), join(dir, "link-out"));
    symlinkSync(join(dir, "plan.md"), join(dir, "link-in.md"));
    writeFileSync(join(dir, "big.log"), "");
    truncateSync(join(dir, "big.log"), 2 * 1024 * 1024 + 1);
    utimesSync(join(dir, "plan.md"), new Date(T0), new Date(T0));
    await serve(p);
    const body = await getJson("/api/item/valid/T1");
    expect(body.artifacts.map((a: TJson) => a.name)).toEqual([
      "b.txt",
      "big.log",
      "link-in.md",
      "plan.md",
    ]);
    expect(body.artifacts.find((a: TJson) => a.name === "plan.md")).toEqual({
      name: "plan.md",
      size: plan.length,
      mtime: "2026-10-30T10:00:00.000Z",
      path: join(dir, "plan.md"),
    });
    const res = await get("/api/item/valid/T1/artifact/plan.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(plan);
    expect((await get("/api/item/valid/T1/artifact/link-in.md")).status).toBe(200);
    expect((await get("/api/item/valid/T1/artifact/big.log")).status).toBe(413);
    for (const name of [
      ".hidden.md",
      "sub",
      "sub%2Finner.md",
      "link-out",
      "..%2F..%2F..%2Foutside.txt",
      "%2e%2e",
      "..",
      "missing.md",
      "plan.md%00",
    ]) {
      const status = (await get(`/api/item/valid/T1/artifact/${name}`)).status;
      expect({ name, status }).toEqual({ name, status: 404 });
    }
    expect((await get("/api/item/valid/T2/artifact/plan.md")).status).toBe(404);
    expect((await get("/api/item/minimal/T1/artifact/plan.md")).status).toBe(404);
  });

  test("/view/item/<flow>/<ID>/artifact/<name> is the static page, 404 exactly where /api/… is", async () => {
    const p = board();
    writeFileSync(join(p.dir, ".wip", "items", "valid", "T1", "plan.md"), "# Plan\n");
    await serve(p);
    const page = await get("/view/item/valid/T1/artifact/plan.md");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(await page.text()).toBe(WEB["view.html"] as string);
    for (const path of [
      "/view/item/valid/T1/artifact/missing.md",
      "/view/item/valid/T1/artifact/..",
      "/view/item/minimal/T1/artifact/plan.md",
      "/view/item/valid/T1",
      "/view.html",
    ]) {
      expect({ path, status: (await get(path)).status }).toEqual({ path, status: 404 });
    }
  });
});

describe("wip web · history (F-WEB-04)", () => {
  test("open, archived in a terminal phase, and discarded; newest first, filtered and paged", async () => {
    const p = board();
    await serve(p);
    const all = await getJson("/api/history?include=active,archived,discarded");
    expect(all.items.map((h: TJson) => [h.id, h.category])).toEqual([
      ["A1", "active"],
      ["T4", "discarded"],
      ["T3", "archived"],
      ["T2", "active"],
      ["T1", "active"],
    ]);
    expect(all.flows).toEqual(["minimal", "valid"]);
    const byDefault = await getJson("/api/history");
    expect(byDefault.items.map((h: TJson) => h.id)).toEqual(["A1", "T3", "T2", "T1"]);
    const valid = await getJson("/api/history?flow=valid&include=archived,discarded");
    expect(valid.items.map((h: TJson) => h.id)).toEqual(["T4", "T3"]);
    const page = await getJson("/api/history?limit=2&offset=1");
    expect({ total: page.total, ids: page.items.map((h: TJson) => h.id) }).toEqual({
      total: 4,
      ids: ["T3", "T2"],
    });
    expect((await getJson("/api/history?q=t3")).items.map((h: TJson) => h.id)).toEqual(["T3"]);
    for (const bad of [
      "include=nope",
      "limit=0",
      "limit=x",
      "flow=Bad Flow",
      `q=${"x".repeat(101)}`,
    ]) {
      const res = await get(`/api/history?${bad}`);
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
    }
  });

  test("an item archived in any terminal phase is archived; archived elsewhere is discarded", async () => {
    const p = board();
    putFlow(p.dir, "two", fixture("flows", "two-terminals"));
    ok(p, ["phase", "D1", "todo", "--flow", "two"]);
    ok(p, ["phase", "D1", "dropped"]);
    ok(p, ["archive", "D1"]);
    ok(p, ["phase", "D2", "todo", "--flow", "two"]);
    ok(p, ["archive", "D2"]);
    await serve(p);
    const two = await getJson("/api/history?flow=two&include=archived,discarded");
    expect(two.items.map((h: TJson) => [h.id, h.category])).toEqual([
      ["D1", "archived"],
      ["D2", "discarded"],
    ]);
  });

  test("only an active item in a stage carries its colour", async () => {
    const p = board();
    await serve(p);
    const all = await getJson("/api/history?include=active,archived,discarded");
    const paint = (id: string): TJson[] => {
      const h = all.items.find((i: TJson) => i.id === id);
      return [h.alpha, h.color];
    };
    expect(paint("T1")).toEqual([0.63, stageColor(0.63)]);
    expect(paint("T3")).toEqual([null, ""]);
    expect(paint("T4")).toEqual([null, ""]);
    expect(paint("A1")).toEqual([null, ""]);
  });
});

describe("wip web · security (F-WEB-02, F-WEB-14)", () => {
  test("Host check, GET only, and the page CSP on every response", async () => {
    const p = board();
    await serve(p);
    const port = web?.port;
    expect((await get("/api/kanban", { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await get("/", { headers: { Host: `evil.example:${port}` } })).status).toBe(403);
    expect((await get("/", { headers: { Host: `localhost:${port}` } })).status).toBe(200);
    expect((await get("/api/kanban", { method: "POST" })).status).toBe(405);
    for (const path of [
      "/",
      "/index.html",
      "/icon.svg",
      "/app.js",
      "/app.css",
      "/markdown.js",
      "/view.js",
      "/lib/garndev-markdown/index.js",
      "/lib/garndev-markdown/tokens.css",
      "/api/kanban",
      "/api/history",
      "/api/item/valid/T1",
      "/health",
      "/nope",
    ]) {
      const res = await get(path);
      expect({ path, csp: res.headers.get("content-security-policy") }).toEqual({
        path,
        csp: PAGE_CSP,
      });
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await get("/nope")).status).toBe(404);
  });

  test("LAN: private IPv4 only, 192.168 before 10 before 172.16-31; --local listens on loopback only", async () => {
    expect(
      ["192.168.1.2", "10.0.0.1", "172.16.0.1", "172.32.0.1", "8.8.8.8"].map(privateRank),
    ).toEqual([0, 1, 2, null, null]);
    const iface = (address: string, internal = false) => ({
      address,
      family: "IPv4",
      internal,
      netmask: "",
      mac: "",
      cidr: null,
    });
    expect(
      privateIPv4s({
        en0: [iface("10.0.0.5"), iface("127.0.0.1", true)],
        en1: [iface("192.168.1.9"), iface("8.8.8.8")],
      } as TJson),
    ).toEqual(["192.168.1.9", "10.0.0.5"]);
    expect([...allowedHosts(80, ["10.0.0.5"])]).toEqual([
      "localhost:80",
      "127.0.0.1:80",
      "10.0.0.5:80",
    ]);
    const p = board();
    web = await startWeb({ port: 0, root: rootAt(p.dir), local: false, interfaces: {} });
    expect(web.lanServer).toBeNull();
    expect((web.server.address() as AddressInfo).address).toBe("127.0.0.1");
    expect((await getJson("/health")).lan).toBeNull();
  });

  test("the database is opened read-only; a schema this build does not read is a 503", async () => {
    const p = board();
    const db = openReadOnly(p.dbPath);
    expect(() => db?.exec("DELETE FROM items")).toThrow();
    db?.close();
    await serve(p);
    expect((await get("/api/kanban")).status).toBe(200);
    const raw = new Database(p.dbPath);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    const res = await get("/api/kanban");
    expect(res.status).toBe(503);
    expect(((await res.json()) as TJson).error).toContain("schema 99");
    expect((await get("/health")).status).toBe(200);
  });
});

describe("wip web · polling footer", () => {
  const POLLING_FLOW = [
    "```wip-flow",
    "phases:",
    "  - name: intake",
    "    next: [waiting]",
    "    waiting_default: user",
    "  - name: waiting",
    "    kind: wait",
    "    waiting_default: external",
    "    next: [done]",
    "  - name: done",
    "    kind: terminal",
    "polling:",
    "  - name: waiting",
    "    phases: [waiting]",
    "    agent: fast",
    "    cadence: 1h",
    "  - name: discover",
    "    agent: fast",
    "    cadence: 30m",
    "```",
    "",
  ].join("\n");

  test("/api/kanban has an empty polling list when no flow declares polling", async () => {
    const p = board();
    await serve(p);
    expect((await getJson("/api/kanban")).polling).toEqual({ polls: [] });
  });

  test("a due and an overdue row, without the seen keys nor the server clock", async () => {
    const p = ctx.set(itemsProject("web-polling"));
    putFlow(p.dir, "review", POLLING_FLOW);
    ok(p, ["phase", "q1", "intake", "--flow", "review"]);
    ok(p, ["phase", "q1", "waiting", "--next", "wait"]);
    ok(p, ["poll", "record", "review", "discover"]);
    ok(p, ["poll", "seen", "review", "waiting", "#1"]);
    await serve(p);
    tick(3601);
    let body = await getJson("/api/kanban");
    expect(Object.keys(body.polling)).toEqual(["polls"]);
    const rows = body.polling.polls as TJson[];
    expect(rows.map((r) => [r.poll, r.status])).toEqual([
      ["waiting", "due"],
      ["discover", "overdue"],
    ]);
    expect(rows.every((r) => !("seen" in r))).toBe(true);
    tick(5401);
    body = await getJson("/api/kanban");
    expect((body.polling.polls as TJson[]).map((r) => [r.poll, r.status])).toEqual([
      ["waiting", "overdue"],
      ["discover", "overdue"],
    ]);
    const first = await (await get("/api/kanban")).text();
    expect(await (await get("/api/kanban")).text()).toBe(first);
  });

  test("crons and the next flow-poll passes go to the board, and a card gets cron_at", async () => {
    const p = ctx.set(itemsProject("web-crons"));
    putFlow(p.dir, "review", POLLING_FLOW);
    ok(p, ["phase", "T1", "intake", "--flow", "valid"]);
    ok(p, ["poll", "record", "review", "discover"]);
    ok(p, ["cron", "add", "call X", "--at", "+2h", "--item", "T1"]);
    ok(p, ["cron", "add", "sooner", "--at", "+1h", "--item", "T1"]);
    ok(p, ["cron", "add", "far", "--at", "+30d"]);
    await serve(p);
    const body = await getJson("/api/kanban");
    const crons = body.crons as TJson[];
    expect(crons.map((c) => [c.source, c.id ?? c.poll])).toEqual([
      ["flow", "discover"],
      ["cron", "c2"],
      ["cron", "c1"],
    ]);
    expect(crons.every((c) => !("pass" in c))).toBe(true);
    const t1 = (body.items as TJson[]).find((i) => i.id === "T1") as TJson;
    expect(t1.cron_at).toBe(crons[1]?.at);
    expect(
      (body.items as TJson[]).filter((i) => i.id !== "T1").every((i) => i.cron_at === null),
    ).toBe(true);
  });

  test("the page has the footer line for it", () => {
    expect(WEB["index.html"]).toContain('id="env-scheduled"');
    expect(WEB["app.js"]).toContain("renderScheduled");
    expect(WEB["app.js"]).toContain("cronBadge");
    expect(WEB["index.html"]).toContain('id="env-polling"');
    expect(WEB["app.js"]).toContain("renderPolling");
    expect(WEB["app.css"]).toContain("--warn");
  });

  test("a database at schema 1 is migrated when wip web starts", async () => {
    const p = ctx.set(itemsProject("web-v1"));
    ok(p, ["phase", "T1", "intake", "--flow", "valid"]);
    const raw = new Database(p.dbPath);
    raw.exec(
      "DROP TABLE crons; DROP TABLE poll_run_items; DROP TABLE poll_runs; DROP TABLE poll_seen;",
    );
    raw.exec("ALTER TABLE flows DROP COLUMN disabled");
    raw.exec("PRAGMA user_version = 1");
    raw.close();
    await serve(p);
    const body = await getJson("/api/kanban");
    expect(body.items.map((i: TJson) => i.id)).toEqual(["T1"]);
    const after = new Database(p.dbPath);
    expect((after.query("PRAGMA user_version").get() as TJson).user_version).toBe(SCHEMA_VERSION);
    after.close();
  });
});

describe("wip web · a disabled flow", () => {
  test("the board and the history leave it out until it is enabled", async () => {
    const p = board();
    await serve(p);
    const full = await getJson("/api/kanban");
    expect(full.items.map((i: TJson) => i.id)).toContain("T1");
    ok(p, ["flow", "disable", "valid"]);
    const body = await getJson("/api/kanban");
    expect(body.items.map((i: TJson) => i.id)).toEqual(["A1"]);
    expect(JSON.stringify(body)).not.toContain("valid");
    const history = await getJson("/api/history");
    expect(history.items.map((i: TJson) => i.flow)).not.toContain("valid");
    ok(p, ["flow", "enable", "valid"]);
    expect((await getJson("/api/kanban")).items.map((i: TJson) => i.id)).toContain("T1");
    expect((await getJson("/api/history")).items.map((i: TJson) => i.flow)).toContain("valid");
  });
});

describe("wip web · page and embedded files (F-WEB-10, F-WEB-13, D15)", () => {
  test("the title is the project's folder name, with no wip prefix or placeholder", async () => {
    const p = board();
    await serve(p);
    const health = await getJson("/health");
    expect(health.name).toBe(String(p.dir).split(/[\\/]/).pop());
    expect(health.project).toBe(p.dir);

    const html = WEB["index.html"] as string;
    expect(html).toContain("<title></title>");
    expect(html).toContain('<h1 id="title"></h1>');
    expect(html).not.toContain(">wip<");

    const app = WEB["app.js"] as string;
    expect(app).toContain("health.name");
    expect(app).toContain("document.title = name");
    expect(app).not.toContain("wip · ");
  });

  test("the pages link the SVG favicon and the file is self-contained", async () => {
    const p = board();
    await serve(p);
    const link = '<link rel="icon" href="/icon.svg" type="image/svg+xml">';
    expect(WEB["index.html"]).toContain(link);
    expect(WEB["view.html"]).toContain(link);

    const res = await get("/icon.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(WEB["icon.svg"] as string);

    const svg = WEB["icon.svg"] as string;
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 64 64"');
    for (const forbidden of [
      "<script",
      "<style",
      "<text",
      "<image",
      "<foreignObject",
      "xlink:href",
      "font-family",
      "url(",
    ]) {
      expect({ forbidden, found: svg.includes(forbidden) }).toEqual({ forbidden, found: false });
    }
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toContain("http");
  });

  test("?item=<flow>%2F<id> serves the same page, and app.js opens and clears the parameter", async () => {
    const p = board();
    await serve(p);
    const linked = await get("/?item=development%2Fkanban-mod");
    expect(linked.status).toBe(200);
    expect(linked.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await linked.text()).toBe(WEB["index.html"] as string);

    const app = WEB["app.js"] as string;
    expect(app).toContain('new URLSearchParams(window.location.search).get("item")');
    expect(app).toContain("openPanel(linked[0], linked[1])");
    const from = app.indexOf("function setItemParam");
    const body = app.slice(from, from + 400);
    expect(body).toContain('url.searchParams.set("item"');
    expect(body).toContain('url.searchParams.delete("item")');
    expect(app).toContain("setItemParam(ref)");
    expect(app).toContain("setItemParam(null)");
  });

  test("the page files and @garndev/markdown are served as embedded, with their types", async () => {
    const p = board();
    await serve(p);
    const index = await get("/");
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toBe(WEB["index.html"] as string);
    for (const [path, key, type] of [
      ["/app.js", "app.js", "text/javascript; charset=utf-8"],
      ["/app.css", "app.css", "text/css; charset=utf-8"],
      ["/icon.svg", "icon.svg", "image/svg+xml"],
      ["/markdown.js", "markdown.js", "text/javascript; charset=utf-8"],
      ["/view.js", "view.js", "text/javascript; charset=utf-8"],
    ] as const) {
      const res = await get(path);
      expect(res.headers.get("content-type")).toBe(type);
      expect(await res.text()).toBe(readFileSync(join(REPO, "web", key), "utf8"));
    }
    for (const key of Object.keys(MARKDOWN_LIB)) {
      const path = `/lib/garndev-markdown/${key.replace(/^dist\//, "")}`;
      const res = await get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      const file = join(REPO, "node_modules", "@garndev", "markdown", key);
      expect(await res.text()).toBe(readFileSync(file, "utf8"));
    }
    expect((await get("/lib/garndev-markdown/dist/index.js")).status).toBe(404);
    expect((await get("/lib/garndev-markdown/package.json")).status).toBe(404);
  });

  test("the item panel merges the flow's links and the fields' URLs in Links", () => {
    const app = WEB["app.js"] as string;
    expect(app).toContain("function panelLinks");
    const from = app.indexOf("function panelLinks");
    const body = app.slice(from, app.indexOf("\n}\n", from));
    for (const needle of [
      "data.field_links",
      "data.links",
      "seen.has(l.url)",
      "link(l.label, l.url)",
      "l.source",
    ]) {
      expect(body).toContain(needle);
    }
  });

  test("the scripts build the DOM with textContent only and poll every 5 s", () => {
    for (const key of ["app.js", "markdown.js", "view.js"]) {
      const src = WEB[key] as string;
      for (const forbidden of [
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "eval(",
      ]) {
        expect({ key, forbidden, found: src.includes(forbidden) }).toEqual({
          key,
          forbidden,
          found: false,
        });
      }
    }
    const app = WEB["app.js"] as string;
    expect(app).toContain("const POLL_MS = 5000;");
    expect(app).toContain("if (text !== lastText)");
    for (const needle of ["/api/kanban", "/api/item/", "/api/history", "localStorage"]) {
      expect(app).toContain(needle);
    }
  });

  test("the page paints the stage colour with the text of each theme, and nothing without a stage", () => {
    const app = WEB["app.js"] as string;
    for (const needle of [
      '"--stage", paint.color',
      '"--on-stage", paint.text',
      "paint.text_dark",
    ]) {
      expect(app).toContain(needle);
    }
    expect(app).not.toContain("PALETTE");
    const css = (WEB["app.css"] as string).replace(/\s+/g, " ");
    expect(css).toContain(
      "@media (prefers-color-scheme: dark) { .card--attention { color: var(--on-stage-dark, var(--text)); } }",
    );
    expect(css).toContain(
      "@media (prefers-color-scheme: dark) { .hphase { color: var(--on-stage-dark, var(--text)); } }",
    );
    expect(css).toContain("border-top: 4px solid var(--stage, var(--border));");
    expect(css).toContain("background: var(--stage, var(--gate-bg));");
  });

  test("the board collapses a flow from its header and remembers it in localStorage", () => {
    const app = WEB["app.js"] as string;
    for (const needle of [
      'const COLLAPSE_KEY = "wip-web.collapsed";',
      "function initialCollapsed",
      "function saveCollapsed",
      "data-flow-toggle",
      'setAttribute("aria-expanded"',
      'setAttribute("aria-controls"',
      "stages.hidden = isCollapsed",
      "localStorage.setItem(COLLAPSE_KEY",
    ]) {
      expect(app).toContain(needle);
    }
    expect(app).not.toContain("innerHTML");
    const css = (WEB["app.css"] as string).replace(/\s+/g, " ");
    expect(css).toContain(".stages[hidden] { display: none; }");
    expect(css).toContain(".flow-toggle:focus-visible");
  });
});

describe("wip web · command (F-WEB-01)", () => {
  function capture(
    stop?: Promise<void>,
    openFails = false,
  ): {
    lines: string[];
    errors: string[];
    opened: string[];
    io: Parameters<typeof webMain>[1];
  } {
    const lines: string[] = [];
    const errors: string[] = [];
    const opened: string[] = [];
    return {
      lines,
      errors,
      opened,
      io: {
        io: {
          out: (l) => lines.push(l),
          err: (l) => {
            lines.push(l);
            errors.push(l);
          },
          stopped: () => stop ?? Promise.resolve(),
          open: async (url) => {
            opened.push(url);
            if (openFails) throw new Error("no launcher");
          },
        },
      },
    };
  }

  async function serving(
    p: IProject,
    argv: string[],
    openFails = false,
  ): Promise<{ c: ReturnType<typeof capture>; port: number; stop: () => Promise<number> }> {
    return listening(p, ["--port", String(await freePort()), ...argv], {}, openFails);
  }

  async function listening(
    p: IProject,
    argv: string[],
    env: TEnv,
    openFails = false,
  ): Promise<{ c: ReturnType<typeof capture>; port: number; stop: () => Promise<number> }> {
    let release = (): void => {};
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const c = capture(stopped, openFails);
    const served: { web: IWebServer | null } = { web: null };
    const done = webMain(argv, {
      ...c.io,
      cwd: p.dir,
      env,
      onListen: (w) => {
        served.web = w;
      },
    });
    for (let i = 0; i < 300 && !served.web; i++) await Bun.sleep(10);
    expect(served.web).not.toBeNull();
    return {
      c,
      port: served.web?.port ?? 0,
      stop: () => {
        release();
        return done;
      },
    };
  }

  test("serves until stopped, prints the addresses, and --open opens the local one", async () => {
    const p = board();
    const { c, port, stop } = await serving(p, ["--local", "--open"]);
    const found = await probe(port);
    expect(found).toMatchObject({ kind: "wip", health: { project: p.dir, local: true } });
    expect(readWebServers(rootAt(p.dir))).toMatchObject([
      { pid: process.pid, port, project: p.dir, legacy: false },
    ]);
    expect(await stop()).toBe(EXIT.OK);
    expect(c.lines).toContain(`  Local: http://localhost:${port}/`);
    expect(c.lines).toContain("  LAN:   off (--local)");
    expect(c.opened).toEqual([`http://localhost:${port}/`]);
    expect(c.errors).toEqual([]);
    expect((await probe(port)).kind).toBe("none");
    expect(existsSync(webServerPath(rootAt(p.dir), port))).toBe(false);
  });

  test("--open: a browser that cannot open is a warning on stderr and the server keeps serving", async () => {
    const p = board();
    const { c, port, stop } = await serving(p, ["--local", "--open"], true);
    for (let i = 0; i < 50 && c.errors.length === 0; i++) await Bun.sleep(10);
    expect(c.errors).toEqual([
      `warning: could not open a browser (no launcher); open http://localhost:${port}/`,
    ]);
    expect((await probe(port)).kind).toBe("wip");
    expect(await stop()).toBe(EXIT.OK);
  });

  test("the default opener: one command per platform, and a failing launcher rejects", async () => {
    const url = "http://localhost:1/";
    expect(browserCommand(url, "darwin")).toEqual(["open", url]);
    expect(browserCommand(url, "linux")).toEqual(["xdg-open", url]);
    expect(browserCommand(url, "win32")).toEqual(["cmd", "/c", "start", "", url]);
    await openBrowser(url, ["true"]);
    expect(openBrowser(url, ["false"])).rejects.toThrow("false exited with 1");
    expect(openBrowser(url, [join(scratch("web-opener"), "missing")])).rejects.toThrow();
  });

  test("a port taken by another program is a clear error, exit 3", async () => {
    const p = board();
    other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hello") });
    const c = capture();
    const code = await webMain(["--port", String(other.port), "--local"], {
      ...c.io,
      cwd: p.dir,
      env: {},
    });
    expect(code).toBe(EXIT.REJECTED);
    expect(c.lines.join("\n")).toContain(`port ${other.port} is in use by another program`);
  });

  test("--port N held by another program only on [::1] is exit 3 too", async () => {
    const p = board();
    const port = await freeRange(1);
    occupy(port, "::1");
    const c = capture();
    expect(
      await webMain(["--port", String(port), "--local"], { ...c.io, cwd: p.dir, env: {} }),
    ).toBe(EXIT.REJECTED);
    expect(c.lines.join("\n")).toContain(`port ${port} is in use by another program`);
    expect(readWebServers(rootAt(p.dir))).toEqual([]);
  });

  describe("without --port: reuse, or the first free port of the range", () => {
    test("serves on the first port of the range and records itself while it serves", async () => {
      const p = board();
      const base = await freeRange(1);
      const { port, stop } = await listening(p, ["--local"], { WIP_WEB_PORT: String(base) });
      expect(port).toBe(base);
      expect(existsSync(webServerPath(rootAt(p.dir), base))).toBe(true);
      expect(await stop()).toBe(EXIT.OK);
      expect(readWebServers(rootAt(p.dir))).toEqual([]);
    });

    test("a port taken by another program or another project's wip web is skipped, and logged", async () => {
      const p = board();
      const base = await freeRange(3);
      occupy(base);
      const elsewhere = scratch("web-retry-other");
      mkdirSync(join(elsewhere, ".wip"));
      web = await startWeb({ port: base + 1, root: rootAt(elsewhere), local: true });
      const { c, port, stop } = await listening(p, ["--local"], { WIP_WEB_PORT: String(base) });
      expect(port).toBe(base + 2);
      expect(c.lines).toContain(`  Local: http://localhost:${base + 2}/`);
      expect(await stop()).toBe(EXIT.OK);
      const log = readFileSync(webLogPath(rootAt(p.dir)), "utf8");
      expect(log).toContain(`info  port ${base} in use, trying ${base + 1}`);
      expect(log).toContain(`info  port ${base + 1} in use, trying ${base + 2}`);
      expect((await probe(base + 1)).kind).toBe("wip");
    });

    test("a port held only on [::1] is skipped: localhost would reach that program", async () => {
      const p = board();
      const base = await freeRange(2);
      occupy(base, "::1");
      const { port, stop } = await listening(p, ["--local"], { WIP_WEB_PORT: String(base) });
      expect(port).toBe(base + 1);
      expect(await stop()).toBe(EXIT.OK);
    });

    test("all twenty ports taken is exit 3, in the output and in the log", async () => {
      const p = board();
      const base = await freeRange(20);
      for (let port = base; port < base + 20; port++) occupy(port);
      const c = capture();
      const env = { WIP_WEB_PORT: String(base) };
      expect(await webMain(["--local"], { ...c.io, cwd: p.dir, env })).toBe(EXIT.REJECTED);
      const message = `no free port from ${base} to ${base + 19}; choose one with --port`;
      expect(c.errors).toEqual([`wip: ${message}`]);
      expect(readFileSync(webLogPath(rootAt(p.dir)), "utf8")).toContain(`error ${message}`);
      expect(readWebServers(rootAt(p.dir))).toEqual([]);
    });

    test("this project's running server is reused, whatever its port; --open opens it", async () => {
      const p = board();
      const base = await freeRange(4);
      const first = await listening(p, ["--local", "--port", String(base + 3)], {});
      const again = capture();
      const env = { WIP_WEB_PORT: String(base) };
      expect(await webMain(["--open"], { ...again.io, cwd: p.dir, env })).toBe(EXIT.OK);
      expect(again.lines).toEqual([
        `wip web is already running for ${p.dir} (PID ${process.pid})`,
        `  Local: http://localhost:${base + 3}/`,
        "  LAN:   off (--local)",
      ]);
      expect(again.opened).toEqual([`http://localhost:${base + 3}/`]);
      expect(readWebServers(rootAt(p.dir)).map((e) => e.port)).toEqual([base + 3]);
      expect((await probe(base)).kind).toBe("none");
      expect(await first.stop()).toBe(EXIT.OK);
    });
  });

  test("already running for this project: says so and exits 0; for another project: exit 3", async () => {
    const p = board();
    await serve(p);
    const port = String(web?.port);
    const same = capture();
    expect(await webMain(["--port", port, "--open"], { ...same.io, cwd: p.dir, env: {} })).toBe(
      EXIT.OK,
    );
    expect(same.lines.join("\n")).toContain("already running");
    expect(same.opened).toEqual([`http://localhost:${port}/`]);
    const elsewhere = scratch("web-other");
    mkdirSync(join(elsewhere, ".wip"));
    const diff = capture();
    expect(await webMain(["--port", port], { ...diff.io, cwd: elsewhere, env: {} })).toBe(
      EXIT.REJECTED,
    );
    expect(diff.lines.join("\n")).toContain(`serves wip web for ${p.dir}`);
  });

  test("usage errors and a missing .wip/", async () => {
    const p = board();
    const run = async (argv: string[], cwd = p.dir, env = {}): Promise<number> =>
      webMain(argv, { ...capture().io, cwd, env });
    expect(await run(["--port", "0x1"])).toBe(EXIT.USAGE);
    expect(await run(["--port", "70000"])).toBe(EXIT.USAGE);
    expect(await run(["extra"])).toBe(EXIT.USAGE);
    expect(await run(["--host", "0.0.0.0"])).toBe(EXIT.USAGE);
    expect(await run([], p.dir, { WIP_WEB_PORT: "nope" })).toBe(EXIT.USAGE);
    expect(await run(["--port", String(await freePort())], scratch("web-nowip"))).toBe(
      EXIT.NOT_FOUND,
    );
    expect(urlLines(8080, "10.0.0.5", false)).toEqual([
      "  Local: http://localhost:8080/",
      "  LAN:   http://10.0.0.5:8080/",
    ]);
  });

  describe("wip web log", () => {
    test("the log has the start, the addresses, responses ≥ 400 and the stop; -n shows the last lines", async () => {
      const p = board();
      const { port, stop } = await serving(p, ["--local"]);
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      expect(
        (await fetch(`${base}/api/kanban`, { headers: { Host: "evil.example" } })).status,
      ).toBe(403);
      expect(await stop()).toBe(EXIT.OK);
      const all = await webSub(["log"], p.dir);
      expect(all.code).toBe(EXIT.OK);
      expect(all.out).toHaveLength(4);
      expect(all.out[0]).toContain(
        `info  start · pid ${process.pid} · Local http://localhost:${port}/ · LAN off (--local)`,
      );
      expect(all.out[1]).toContain("warn  404 GET /nope");
      expect(all.out[2]).toContain("warn  403 GET /api/kanban (host evil.example)");
      expect(all.out[3]).toContain("info  stop");
      expect((await webSub(["log", "-n", "1"], p.dir)).out).toEqual([all.out[3] as string]);
      const json = await webSub(["log", "--lines", "2", "--json"], p.dir);
      expect(JSON.parse(json.out.join(""))).toMatchObject({
        ok: true,
        data: { path: webLogPath(rootAt(p.dir)), lines: all.out.slice(2) },
      });
    });

    test("no log yet is exit 4 with where it would be; bad -n and --follow --json are usage", async () => {
      const p = board();
      const missing = await webSub(["log"], p.dir);
      expect(missing.code).toBe(EXIT.NOT_FOUND);
      expect(missing.err.join("\n")).toContain(`no wip web log at ${webLogPath(rootAt(p.dir))}`);
      expect((await webSub(["log", "-n", "0"], p.dir)).code).toBe(EXIT.USAGE);
      expect((await webSub(["log", "--follow", "--json"], p.dir)).code).toBe(EXIT.USAGE);
      expect((await webSub(["log", "--port", "1"], p.dir)).code).toBe(EXIT.USAGE);
      expect((await webSub(["--follow"], p.dir)).code).toBe(EXIT.USAGE);
    });

    test("--follow prints the lines written after it starts, until stopped", async () => {
      const p = board();
      const log = fileLog(webLogPath(rootAt(p.dir)));
      log("info", "before");
      let release = (): void => {};
      const stopped = new Promise<void>((resolve) => {
        release = resolve;
      });
      const following = webSub(["log", "--follow"], p.dir, { stopped });
      await Bun.sleep(50);
      log("error", "after");
      await Bun.sleep(700);
      release();
      const { code, out } = await following;
      expect(code).toBe(EXIT.OK);
      expect(out).toHaveLength(2);
      expect(out[0]).toContain("info  before");
      expect(out[1]).toContain("error after");
    });

    test("past the cap the log moves to web.log.1", () => {
      const dir = scratch("web-log-rotate");
      const path = join(dir, "web.log");
      const log = fileLog(path, 120);
      for (let i = 0; i < 4; i++) log("info", `line ${i} ${"x".repeat(30)}`);
      expect(existsSync(`${path}.1`)).toBe(true);
      expect(readFileSync(path, "utf8").length).toBeLessThanOrEqual(120);
      rotateIfNeeded(path, 1000, 120);
      expect(existsSync(path)).toBe(false);
    });
  });

  describe("wip web stop", () => {
    test("start → status 0 → stop → status 1; the entry names the port and goes away", async () => {
      const p = board();
      const { port, stop } = await serving(p, ["--local"]);
      const root = rootAt(p.dir);
      expect(readWebServers(root)).toMatchObject([{ pid: process.pid, port, project: p.dir }]);
      expect((await webSub(["status"], p.dir)).code).toBe(EXIT.OK);
      let stopping: Promise<number> | null = null;
      const signals: string[] = [];
      const stopped = await webSub(["stop", "--json"], p.dir, {
        kill: (pid, signal) => {
          signals.push(`${pid} ${signal}`);
          stopping = stop();
        },
      });
      expect(signals).toEqual([`${process.pid} SIGTERM`]);
      expect(stopped.code).toBe(EXIT.OK);
      expect(JSON.parse(stopped.out.join(""))).toMatchObject({
        ok: true,
        data: {
          state: "stopped",
          port,
          project: p.dir,
          pid: process.pid,
          stopped: [{ port, pid: process.pid }],
          removed: 0,
        },
      });
      expect(await (stopping as unknown as Promise<number>)).toBe(EXIT.OK);
      expect(existsSync(webServerPath(root, port))).toBe(false);
      const after = await webSub(["status"], p.dir);
      expect(after.code).toBe(NOT_RUNNING);
    });

    test("without --port it stops every server of this project; --port N only that one", async () => {
      const p = board();
      const [a, b, c] = [
        await serving(p, ["--local"]),
        await serving(p, ["--local"]),
        await serving(p, ["--local"]),
      ].sort((x, y) => x.port - y.port);
      if (!a || !b || !c) throw new Error("three servers");
      const byPort = new Map([a, b, c].map((s) => [s.port, s]));
      const stopping: Promise<number>[] = [];
      const signalled: number[] = [];
      const killFor = (ports: number[]) => (): void => {
        const port = ports[signalled.length] as number;
        signalled.push(port);
        stopping.push(byPort.get(port)?.stop() ?? Promise.resolve(-1));
      };

      const one = await webSub(["stop", "--port", String(b.port)], p.dir, {
        kill: killFor([b.port]),
      });
      expect(one.code).toBe(EXIT.OK);
      expect(one.out).toEqual([
        `wip web stopped for ${p.dir} (PID ${process.pid}, port ${b.port})`,
      ]);
      expect(readWebServers(rootAt(p.dir)).map((e) => e.port)).toEqual([a.port, c.port]);

      const missing = await webSub(["stop", "--port", String(b.port)], p.dir, {
        kill: () => {
          throw new Error("must not signal");
        },
      });
      expect(missing.code).toBe(NOT_RUNNING);
      expect(missing.out).toEqual([`wip web is not running for ${p.dir} on port ${b.port}`]);

      signalled.length = 0;
      const all = await webSub(["stop"], p.dir, { kill: killFor([a.port, c.port]) });
      expect(all.code).toBe(EXIT.OK);
      expect(all.out).toEqual([
        `wip web stopped for ${p.dir} (PID ${process.pid}, port ${a.port})`,
        `wip web stopped for ${p.dir} (PID ${process.pid}, port ${c.port})`,
      ]);
      expect(await Promise.all(stopping)).toEqual([EXIT.OK, EXIT.OK, EXIT.OK]);
      expect(readWebServers(rootAt(p.dir))).toEqual([]);
      expect((await webSub(["status"], p.dir)).code).toBe(NOT_RUNNING);
    });

    test("nothing running is exit 1 and clears stale entries; it never signals a /health that is not its own", async () => {
      const p = board();
      const root = rootAt(p.dir);
      const free = await freePort();
      writeFileSync(
        legacyWebPidPath(root),
        JSON.stringify({ pid: 999999, port: free, project: p.dir, started_at: T0 }),
      );
      const elsewhere = scratch("web-stop-other");
      mkdirSync(join(elsewhere, ".wip"));
      web = await startWeb({ port: 0, root: rootAt(elsewhere), local: true });
      mkdirSync(webServersDir(root), { recursive: true });
      writeFileSync(
        webServerPath(root, web.port),
        JSON.stringify({ pid: process.pid, port: web.port, project: p.dir, started_at: T0 }),
      );
      const kill = (): void => {
        throw new Error("must not signal");
      };
      const none = await webSub(["stop", "--json"], p.dir, { kill });
      expect(none.code).toBe(NOT_RUNNING);
      expect(JSON.parse(none.out.join(""))).toMatchObject({
        ok: false,
        message: `wip web is not running for ${p.dir} (removed 2 stale entries)`,
        data: { state: "not-running", stopped: [], removed: 2 },
      });
      expect(existsSync(legacyWebPidPath(root))).toBe(false);
      expect(readWebServers(root)).toEqual([]);
      expect((await probe(web.port)).kind).toBe("wip");
      expect((await webSub(["stop", "extra"], p.dir)).code).toBe(EXIT.USAGE);
      expect((await webSub(["stop", "--port", "nope"], p.dir)).code).toBe(EXIT.USAGE);
    });
  });
});

async function webSub(
  argv: string[],
  cwd: string,
  extra: Partial<IWebMainOptions> & { stopped?: Promise<void> } = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const { stopped, ...rest } = extra;
  const code = await webMain(argv, {
    cwd,
    env: {},
    ...rest,
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      stopped: () => stopped ?? Promise.resolve(),
      open: async () => {
        throw new Error("never opens a browser");
      },
    },
  });
  return { code, out, err };
}

describe("wip web status", () => {
  const status = (argv: string[], cwd: string): ReturnType<typeof webSub> =>
    webSub(["status", ...argv], cwd);

  /** Real /health checks that fail the test when asked a port this project never recorded. */
  function onlyRecorded(cwd: string): { asked: number[]; live: IWebMainOptions["live"] } {
    const asked: number[] = [];
    return {
      asked,
      live: {
        probe: async (port) => {
          asked.push(port);
          const recorded = readWebServers(rootAt(cwd)).map((e) => e.port);
          if (!recorded.includes(port)) throw new Error(`asked unrecorded port ${port}`);
          return probe(port, 2000);
        },
      },
    };
  }

  test("nothing recorded is exit 1 and asks no port", async () => {
    const p = board();
    const { asked, live } = onlyRecorded(p.dir);
    const text = await webSub(["status"], p.dir, { live });
    expect(text.code).toBe(NOT_RUNNING);
    expect(NOT_RUNNING).toBe(1);
    expect(text.out).toEqual([`wip web is not running for ${p.dir}`]);
    const json = await webSub(["status", "--json"], p.dir, { live });
    expect(JSON.parse(json.out.join(""))).toMatchObject({
      ok: false,
      message: `wip web is not running for ${p.dir}`,
      data: {
        state: "not-running",
        project: p.dir,
        port: null,
        url: null,
        servers: [],
        removed: 0,
      },
    });
    expect(asked).toEqual([]);
  });

  test("this project's servers, one line each by port, the first one's URL in --json; another project's is not listed", async () => {
    const p = board();
    const base = await freeRange(1);
    const elsewhere = scratch("web-status-other");
    mkdirSync(join(elsewhere, ".wip"));
    web = await startWeb({ port: base, root: rootAt(elsewhere), local: true });
    const started: Promise<number>[] = [];
    const ports: number[] = [];
    for (let i = 0; i < 2; i++) {
      const port = await freePort();
      ports.push(port);
      let release = (): void => {};
      const stopped = new Promise<void>((resolve) => {
        release = resolve;
      });
      started.push(
        webMain(["--port", String(port), "--local"], {
          io: { out: () => {}, err: () => {}, stopped: () => stopped, open: async () => {} },
          cwd: p.dir,
          env: { WIP_WEB_PORT: String(base) },
        }),
      );
      for (let j = 0; j < 100 && (await probe(port, 200)).kind !== "wip"; j++) await Bun.sleep(10);
      occupied.push({ stop: release });
    }
    const [lo, hi] = ports.sort((x, y) => x - y) as [number, number];
    const { asked, live } = onlyRecorded(p.dir);
    const text = await webSub(["status"], p.dir, { live });
    expect(text.code).toBe(EXIT.OK);
    expect(text.out).toEqual([
      `wip web is running for ${p.dir}: 2 servers`,
      `  ${lo}  PID ${process.pid}  Local: http://localhost:${lo}/  LAN: off (--local)`,
      `  ${hi}  PID ${process.pid}  Local: http://localhost:${hi}/  LAN: off (--local)`,
    ]);
    const json = await webSub(["status", "--json"], p.dir, { live });
    expect(json.code).toBe(EXIT.OK);
    const body = JSON.parse(json.out.join(""));
    expect(body).toMatchObject({
      ok: true,
      data: {
        state: "running",
        project: p.dir,
        port: lo,
        pid: process.pid,
        url: `http://localhost:${lo}/`,
        lan_url: null,
        removed: 0,
      },
    });
    expect(body.data.servers.map((s: TJson) => [s.port, s.pid, s.url, s.state])).toEqual([
      [lo, process.pid, `http://localhost:${lo}/`, "running"],
      [hi, process.pid, `http://localhost:${hi}/`, "running"],
    ]);
    expect(text.out.join("\n")).not.toContain(`:${base}/`);
    expect([...new Set(asked)].sort((x, y) => x - y)).toEqual([lo, hi]);
    for (const o of occupied.splice(0)) o.stop();
    expect(await Promise.all(started)).toEqual([EXIT.OK, EXIT.OK]);
  });

  test("a dead PID's entry is removed and said; a legacy .wip/web.pid too", async () => {
    const p = board();
    const root = rootAt(p.dir);
    mkdirSync(webServersDir(root), { recursive: true });
    const free = await freePort();
    writeFileSync(
      webServerPath(root, free),
      JSON.stringify({ pid: 999999, port: free, project: p.dir, started_at: T0 }),
    );
    writeFileSync(
      legacyWebPidPath(root),
      JSON.stringify({ pid: 999998, port: free + 1, project: p.dir, started_at: T0 }),
    );
    const text = await status([], p.dir);
    expect(text.code).toBe(NOT_RUNNING);
    expect(text.out).toEqual([`wip web is not running for ${p.dir} (removed 2 stale entries)`]);
    expect(readWebServers(root)).toEqual([]);
    expect(existsSync(legacyWebPidPath(root))).toBe(false);
  });

  test("a live legacy .wip/web.pid server of this project is listed", async () => {
    const p = board();
    await serve(p);
    const port = web?.port as number;
    writeFileSync(
      legacyWebPidPath(rootAt(p.dir)),
      JSON.stringify({ pid: process.pid, port, project: p.dir, started_at: T0 }),
    );
    const text = await status(["--json"], p.dir);
    expect(text.code).toBe(EXIT.OK);
    expect(JSON.parse(text.out.join("")).data).toMatchObject({ state: "running", port });
  });

  test("usage errors and a missing .wip/", async () => {
    const p = board();
    expect((await status(["extra"], p.dir)).code).toBe(EXIT.USAGE);
    expect((await status(["--open"], p.dir)).code).toBe(EXIT.USAGE);
    expect((await status(["--local"], p.dir)).code).toBe(EXIT.USAGE);
    expect((await status(["--port", "1"], p.dir)).code).toBe(EXIT.USAGE);
    const missing = await status(["--json"], scratch("web-status-nowip"));
    expect(missing.code).toBe(EXIT.NOT_FOUND);
    expect(JSON.parse(missing.out.join(""))).toMatchObject({ ok: false, data: { code: 4 } });
  });

  test("`wip web --help` documents the port range, the registry, status and stop", () => {
    const help = commandHelp(findCommand("web") as ICommandSpec);
    expect(help).toContain("wip web status\n");
    expect(help).not.toContain("wip web status [--port N]");
    expect(help).toContain("first free port from 33333");
    expect(help).toContain(
      "to 33352 (WIP_WEB_PORT moves the first one); --port N serves on exactly N",
    );
    expect(help).toContain(".wip/web/<port>.json");
    expect(help).toContain("--open opens http://localhost:<port>/");
    expect(help).toContain("exit 0 at least one answers · 1 none");
    expect(help).toContain("0 stopped · 1 none was running · 3 one did not stop");
    expect(help).not.toContain("39100");
  });
});

describe("wip web · entry point (WIP_TEST_BIN when set, else bun src/main.ts)", () => {
  test("serves the embedded files and stops on SIGTERM with exit 0", async () => {
    const p = board();
    setClockForTests(null);
    const port = await freePort();
    const cmd = [
      ...(WIP_CMD ?? [process.execPath, join(REPO, "src", "main.ts")]),
      ...["web", "--port", String(port), "--local"],
    ];
    const proc = Bun.spawn(cmd, {
      cwd: p.dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let health: TJson = null;
      for (let i = 0; i < 100 && !health; i++) {
        const found = await probe(port, 200);
        if (found.kind === "wip") health = found.health;
        else await Bun.sleep(50);
      }
      // Through the npm launcher the server is the launcher's child, so its pid differs from proc.pid.
      expect(health).toMatchObject({ app: "wip-web", project: p.dir });
      expect(typeof health.pid).toBe("number");
      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/app.js`)).text()).toBe(WEB["app.js"] as string);
      const lib = await fetch(`${base}/lib/garndev-markdown/render.js`);
      expect(await lib.text()).toBe(MARKDOWN_LIB["dist/render.js"] as string);
      const kanban = (await (await fetch(`${base}/api/kanban`)).json()) as TJson;
      expect(kanban.items.map((i: TJson) => i.id)).toEqual(["A1", "T1", "T2"]);
      ok(p, ["wait", "A1", "user", "--next", "concurrent write"]);
      const after = (await (await fetch(`${base}/api/kanban`)).json()) as TJson;
      expect(after.your_turn.map((i: TJson) => i.id)).toEqual(["A1", "T1"]);
    } finally {
      proc.kill("SIGTERM");
    }
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain(`Local: http://localhost:${port}/`);
    expect(existsSync(webServerPath(rootAt(p.dir), port))).toBe(false);
  }, 20000);

  test("start → status 0 → stop 0 → status 1, with the log and no registry entry left", async () => {
    const p = board();
    setClockForTests(null);
    const port = await freePort();
    const wip = WIP_CMD ?? [process.execPath, join(REPO, "src", "main.ts")];
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const proc = Bun.spawn([...wip, "web", "--port", String(port), "--local"], {
      cwd: p.dir,
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    const cli = (args: string[]): { code: number; stdout: string } => {
      const r = Bun.spawnSync([...wip, ...args], { cwd: p.dir, env });
      return { code: r.exitCode, stdout: r.stdout.toString() };
    };
    try {
      for (let i = 0; i < 100 && (await probe(port, 200)).kind !== "wip"; i++) await Bun.sleep(50);
      const up = cli(["web", "status", "--json"]);
      expect(up.code).toBe(0);
      const data = JSON.parse(up.stdout).data;
      expect(data).toMatchObject({ state: "running", port });
      expect(data.servers.map((s: TJson) => s.port)).toEqual([port]);
      const stopped = cli(["web", "stop"]);
      expect(stopped.code).toBe(0);
      expect(stopped.stdout).toContain(`wip web stopped for ${p.dir}`);
      expect(cli(["web", "status"]).code).toBe(NOT_RUNNING);
    } finally {
      if ((await probe(port, 200)).kind !== "none") proc.kill("SIGTERM");
    }
    expect(await proc.exited).toBe(0);
    expect(readWebServers(rootAt(p.dir))).toEqual([]);
    const log = cli(["web", "log"]);
    expect(log.code).toBe(0);
    expect(log.stdout).toContain(`start · pid`);
    expect(log.stdout).toContain("info  stop");
  }, 30000);
});
