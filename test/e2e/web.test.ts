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
import { join } from "node:path";
import { setClockForTests } from "../../src/clock.ts";
import { commandHelp, findCommand, type ICommandSpec } from "../../src/commands/help.ts";
import {
  browserCommand,
  type IWebMainOptions,
  NOT_RUNNING,
  openBrowser,
  probe,
  urlLines,
  webMain,
} from "../../src/commands/web.ts";
import { MARKDOWN_LIB, WEB } from "../../src/embedded/web.ts";
import { rootAt } from "../../src/env.ts";
import { EXIT } from "../../src/errors.ts";
import { fileLog, rotateIfNeeded, webLogPath } from "../../src/web/log.ts";
import { readWebPid, webPidPath } from "../../src/web/pidfile.ts";
import {
  ARTIFACT_CSP,
  allowedHosts,
  type IWebServer,
  PAGE_CSP,
  privateIPv4s,
  privateRank,
  startWeb,
} from "../../src/web/server.ts";
import { itemLinks, openReadOnly, PALETTE, textOn } from "../../src/web/state.ts";
import { WIP_BIN } from "../helpers/bin.ts";
import { minimalFlow, putFlow } from "../helpers/defs.ts";
import { at, itemInPlan, itemsProject, ok, T0, tick, useProject } from "../helpers/items.ts";
import { type IProject, makeProject, scratch } from "../helpers/project.ts";

const REPO = join(import.meta.dir, "..", "..");
const ctx = useProject();
let web: IWebServer | null = null;
let other: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  web?.stop();
  web = null;
  other?.stop(true);
  other = null;
});

// biome-ignore lint/suspicious/noExplicitAny: JSON bodies of the API under test
type TJson = any;

function serve(p: IProject): IWebServer {
  web = startWeb({ port: 0, root: rootAt(p.dir), local: true });
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
    serve(p);
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
    // F-WEB-11: the colour follows the column order, the same for every flow.
    for (const flow of body.flows) {
      flow.columns.forEach((c: TJson, i: number) => {
        expect(c.color).toBe(PALETTE[i % PALETTE.length]);
        expect(c.text).toBe(textOn(c.color));
      });
    }
    const t1 = body.items.find((i: TJson) => i.id === "T1");
    expect(t1).toMatchObject({ column: "stage:doing", stage: "doing", color: PALETTE[1] });
  });

  test("items, «your turn» and signals are what `wip state` and `wip state --attention` compute", async () => {
    const p = board();
    serve(p);
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
    serve(p);
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
    serve(p);
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
    serve(p);
    const body = await getJson("/api/kanban");
    expect(body.items).toEqual([]);
    expect(body.flows.map((f: TJson) => f.name)).toEqual(["minimal"]);
    expect(existsSync(p.dbPath)).toBe(false);
  });

  test("a flow file that breaks keeps its last valid version, with the warning", async () => {
    const p = board();
    putFlow(p.dir, "minimal", "# broken\n");
    serve(p);
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

  test("cards, history and the item panel carry the links", async () => {
    const p = board();
    serve(p);
    const link = { label: "T1", url: "https://tracker.example.com/t/1", source: "id" };
    const kanban = await getJson("/api/kanban");
    expect(kanban.items.find((i: TJson) => i.id === "T1").links).toEqual([link]);
    const history = await getJson("/api/history");
    expect(history.items.find((i: TJson) => i.id === "T1").links).toEqual([link]);
    expect((await getJson("/api/item/valid/T1")).links).toEqual([link]);
    expect(kanban.items.find((i: TJson) => i.id === "A1").links).toEqual([]);
  });
});

describe("wip web · item panel (F-WEB-07, F-WEB-10)", () => {
  test("/api/item/<flow>/<ID> is `wip show --json` plus links and artifacts", async () => {
    const p = board();
    at("2026-10-30T12:00:00Z");
    serve(p);
    const body = await getJson("/api/item/valid/T1");
    const shown = ok(p, ["show", "T1"]);
    expect(body.item).toEqual(shown.item);
    expect(body.events).toEqual(shown.events);
    expect({
      agent_runs: body.agent_runs,
      gates: body.gates,
      signals: body.signals,
      totals: body.totals,
    }).toEqual(shown.data as TJson);
    expect(body.totals.user_wait_seconds).toBe(7200);
  });

  test("an unknown item, another flow or a bad segment is 404", async () => {
    const p = board();
    serve(p);
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
    serve(p);
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
    serve(p);
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
  test("open, archived in the terminal phase, and discarded; newest first, filtered and paged", async () => {
    const p = board();
    serve(p);
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
});

describe("wip web · security (F-WEB-02, F-WEB-14)", () => {
  test("Host check, GET only, and the page CSP on every response", async () => {
    const p = board();
    serve(p);
    const port = web?.port;
    expect((await get("/api/kanban", { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await get("/", { headers: { Host: `evil.example:${port}` } })).status).toBe(403);
    expect((await get("/", { headers: { Host: `localhost:${port}` } })).status).toBe(200);
    expect((await get("/api/kanban", { method: "POST" })).status).toBe(405);
    for (const path of [
      "/",
      "/index.html",
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
    web = startWeb({ port: 0, root: rootAt(p.dir), local: false, interfaces: {} });
    expect(web.lanServer).toBeNull();
    expect(web.server.hostname).toBe("127.0.0.1");
    expect((await getJson("/health")).lan).toBeNull();
  });

  test("the database is opened read-only; a schema this build does not read is a 503", async () => {
    const p = board();
    const db = openReadOnly(p.dbPath);
    expect(() => db?.exec("DELETE FROM items")).toThrow();
    db?.close();
    serve(p);
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

describe("wip web · page and embedded files (F-WEB-10, F-WEB-13, D15)", () => {
  test("the page files and @garndev/markdown are served as embedded, with their types", async () => {
    const p = board();
    serve(p);
    const index = await get("/");
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toBe(WEB["index.html"] as string);
    for (const [path, key, type] of [
      ["/app.js", "app.js", "text/javascript; charset=utf-8"],
      ["/app.css", "app.css", "text/css; charset=utf-8"],
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
    const port = await freePort();
    let release = (): void => {};
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const c = capture(stopped, openFails);
    let served: IWebServer | null = null;
    const done = webMain(["--port", String(port), ...argv], {
      ...c.io,
      cwd: p.dir,
      env: {},
      onListen: (w) => {
        served = w;
      },
    });
    for (let i = 0; i < 50 && !served; i++) await Bun.sleep(10);
    expect(served).not.toBeNull();
    return {
      c,
      port,
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
    expect(await stop()).toBe(EXIT.OK);
    expect(c.lines).toContain(`  Local: http://localhost:${port}/`);
    expect(c.lines).toContain("  LAN:   off (--local)");
    expect(c.opened).toEqual([`http://localhost:${port}/`]);
    expect(c.errors).toEqual([]);
    expect((await probe(port)).kind).toBe("none");
    expect(existsSync(webPidPath(rootAt(p.dir)))).toBe(false);
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

  test("already running for this project: says so and exits 0; for another project: exit 3", async () => {
    const p = board();
    serve(p);
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
    test("start → status 0 → stop → status 1; the pidfile names the port and goes away", async () => {
      const p = board();
      const { port, stop } = await serving(p, ["--local"]);
      const root = rootAt(p.dir);
      expect(readWebPid(root)).toMatchObject({ pid: process.pid, port, project: p.dir });
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
        data: { state: "stopped", port, project: p.dir, pid: process.pid },
      });
      expect(await (stopping as unknown as Promise<number>)).toBe(EXIT.OK);
      expect(existsSync(webPidPath(root))).toBe(false);
      const after = await webSub(["status", "--port", String(port)], p.dir);
      expect(after.code).toBe(NOT_RUNNING);
    });

    test("nothing running is exit 1 and clears a stale pidfile; another project or program is exit 3, untouched", async () => {
      const p = board();
      const root = rootAt(p.dir);
      const free = await freePort();
      writeFileSync(
        webPidPath(root),
        JSON.stringify({ pid: 999999, port: free, project: p.dir, started_at: T0 }),
      );
      const kill = (): void => {
        throw new Error("must not signal");
      };
      const none = await webSub(["stop"], p.dir, { kill });
      expect(none.code).toBe(NOT_RUNNING);
      expect(none.out).toEqual([
        `wip web is not running on port ${free} (removed a stale .wip/web.pid)`,
      ]);
      expect(existsSync(webPidPath(root))).toBe(false);

      serve(p);
      const elsewhere = scratch("web-stop-other");
      mkdirSync(join(elsewhere, ".wip"));
      const foreign = await webSub(["stop", "--port", String(web?.port)], elsewhere, { kill });
      expect(foreign.code).toBe(EXIT.REJECTED);
      expect(foreign.out).toEqual([`port ${web?.port} serves wip web for ${p.dir}: not stopped`]);
      expect((await probe(web?.port as number)).kind).toBe("wip");

      other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hello") });
      const program = await webSub(["stop", "--port", String(other.port)], p.dir, { kill });
      expect(program.code).toBe(EXIT.REJECTED);
      expect((await webSub(["stop", "extra"], p.dir)).code).toBe(EXIT.USAGE);
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

  test("this project's wip web on the port: exit 0 with its URL, in text and in --json", async () => {
    const p = board();
    serve(p);
    const port = web?.port as number;
    const text = await status(["--port", String(port)], p.dir);
    expect(text.code).toBe(EXIT.OK);
    expect(text.out).toEqual([
      `wip web is running for ${p.dir} (PID ${process.pid})`,
      `  Local: http://localhost:${port}/`,
      "  LAN:   off (--local)",
    ]);
    const json = await status(["--port", String(port), "--json"], p.dir);
    expect(json.code).toBe(EXIT.OK);
    expect(JSON.parse(json.out.join(""))).toMatchObject({
      ok: true,
      data: {
        state: "running",
        port,
        project: p.dir,
        pid: process.pid,
        url: `http://localhost:${port}/`,
        lan_url: null,
      },
    });
  });

  test("nothing on the port is exit 1; another project or another program is exit 3", async () => {
    const p = board();
    const free = await freePort();
    const stopped = await status(["--port", String(free), "--json"], p.dir);
    expect(stopped.code).toBe(NOT_RUNNING);
    expect(NOT_RUNNING).toBe(1);
    expect(JSON.parse(stopped.out.join(""))).toMatchObject({
      ok: false,
      message: `wip web is not running on port ${free}`,
      data: { state: "not-running", port: free },
    });

    serve(p);
    const elsewhere = scratch("web-status-other");
    mkdirSync(join(elsewhere, ".wip"));
    const foreign = await status(["--port", String(web?.port)], elsewhere);
    expect(foreign.code).toBe(EXIT.REJECTED);
    expect(foreign.out).toEqual([`port ${web?.port} serves wip web for ${p.dir}`]);

    other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hello") });
    const program = await status(["--port", String(other.port), "--json"], p.dir);
    expect(program.code).toBe(EXIT.REJECTED);
    expect(JSON.parse(program.out.join("")).data.state).toBe("other-program");

    other.stop(true);
    other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ app: "wip-web", pid: 1, port: 1 }),
    });
    const older = await status(["--port", String(other.port)], p.dir);
    expect(older.code).toBe(EXIT.REJECTED);
    expect(older.out).toEqual([`port ${other.port} serves wip web for an unknown project`]);
  });

  test("usage errors and a missing .wip/", async () => {
    const p = board();
    expect((await status(["extra"], p.dir)).code).toBe(EXIT.USAGE);
    expect((await status(["--open"], p.dir)).code).toBe(EXIT.USAGE);
    expect((await status(["--local"], p.dir)).code).toBe(EXIT.USAGE);
    expect((await status(["--port", "nope"], p.dir)).code).toBe(EXIT.USAGE);
    const missing = await status(["--json"], scratch("web-status-nowip"));
    expect(missing.code).toBe(EXIT.NOT_FOUND);
    expect(JSON.parse(missing.out.join(""))).toMatchObject({ ok: false, data: { code: 4 } });
  });

  test("`wip web --help` documents status and its exit codes", () => {
    const help = commandHelp(findCommand("web") as ICommandSpec);
    expect(help).toContain("wip web status [--port N]");
    expect(help).toContain("--open opens http://localhost:<port>/");
    expect(help).toContain("status exit codes: 0 this project's wip web answers on the port");
    expect(help).toContain("1 nothing answers");
    expect(help).toContain("3 another project's wip web or another program holds the port");
  });
});

describe("wip web · entry point (binary with WIP_BIN, else bun src/cli.ts)", () => {
  test("serves the embedded files and stops on SIGTERM with exit 0", async () => {
    const p = board();
    setClockForTests(null);
    const port = await freePort();
    const cmd = WIP_BIN
      ? [WIP_BIN, "web", "--port", String(port), "--local"]
      : [process.execPath, join(REPO, "src", "cli.ts"), "web", "--port", String(port), "--local"];
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
    expect(existsSync(webPidPath(rootAt(p.dir)))).toBe(false);
  }, 20000);

  test("start → status 0 → stop 0 → status 1, with the log and no pidfile left", async () => {
    const p = board();
    setClockForTests(null);
    const port = await freePort();
    const wip = WIP_BIN ? [WIP_BIN] : [process.execPath, join(REPO, "src", "cli.ts")];
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
      expect(JSON.parse(up.stdout).data).toMatchObject({ state: "running", port });
      const stopped = cli(["web", "stop"]);
      expect(stopped.code).toBe(0);
      expect(stopped.stdout).toContain(`wip web stopped for ${p.dir}`);
      expect(cli(["web", "status", "--port", String(port)]).code).toBe(NOT_RUNNING);
    } finally {
      if ((await probe(port, 200)).kind !== "none") proc.kill("SIGTERM");
    }
    expect(await proc.exited).toBe(0);
    expect(existsSync(webPidPath(rootAt(p.dir)))).toBe(false);
    const log = cli(["web", "log"]);
    expect(log.code).toBe(0);
    expect(log.stdout).toContain(`start · pid`);
    expect(log.stdout).toContain("info  stop");
  }, 30000);
});
