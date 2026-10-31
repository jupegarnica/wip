import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ILiveDeps, liveWebServers, pidAlive, type TProbe } from "../../src/commands/web.ts";
import { type IRoot, rootAt } from "../../src/env.ts";
import {
  clearWebServer,
  legacyWebPidPath,
  readWebServers,
  webServerPath,
  webServersDir,
  writeWebServer,
} from "../../src/web/pidfile.ts";
import { APP, DEFAULT_PORT, type IHealth, PORT_TRIES } from "../../src/web/server.ts";
import { scratch } from "../helpers/project.ts";

function project(name: string): IRoot {
  const dir = scratch(name);
  mkdirSync(join(dir, ".wip"));
  return rootAt(dir);
}

function put(root: IRoot, port: number, pid: number, project = root.project): void {
  mkdirSync(webServersDir(root), { recursive: true });
  writeFileSync(
    webServerPath(root, port),
    JSON.stringify({ pid, port, project, started_at: "2026-10-31T10:00:00Z", version: "0.1.0" }),
  );
}

const health = (port: number, pid: number, project: string): IHealth => ({
  app: APP,
  pid,
  port,
  project,
  version: "0.1.0",
  lan: null,
  local: true,
});

/** Only the registered ports may be asked: any other port fails the test. */
function deps(
  answers: Record<number, TProbe>,
  alive: readonly number[],
  accepting: readonly number[] = [],
): ILiveDeps & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    probe: async (port) => {
      asked.push(port);
      const answer = answers[port];
      if (!answer) throw new Error(`asked unregistered port ${port}`);
      return answer;
    },
    isAlive: (pid) => alive.includes(pid),
    accepts: async (port) => accepting.includes(port),
  };
}

describe("wip web · registry (.wip/web/<port>.json)", () => {
  test("the defaults: 33333 and twenty tries", () => {
    expect(DEFAULT_PORT).toBe(33333);
    expect(PORT_TRIES).toBe(20);
  });

  test("write names this process; clear removes it only while it names that pid", () => {
    const root = project("web-reg-write");
    const entry = writeWebServer(root, 40001);
    expect(entry).toMatchObject({ pid: process.pid, port: 40001, project: root.project });
    const saved = JSON.parse(readFileSync(webServerPath(root, 40001), "utf8"));
    expect(Object.keys(saved).sort()).toEqual(["pid", "port", "project", "started_at", "version"]);
    clearWebServer(root, 40001, process.pid + 1);
    expect(existsSync(webServerPath(root, 40001))).toBe(true);
    clearWebServer(root, 40001, process.pid);
    expect(existsSync(webServerPath(root, 40001))).toBe(false);
  });

  test("read: by port, broken files ignored, the legacy .wip/web.pid as one more entry", () => {
    const root = project("web-reg-read");
    put(root, 40005, 11);
    put(root, 40002, 12);
    writeFileSync(join(webServersDir(root), "40003.json"), "{not json");
    writeFileSync(join(webServersDir(root), "notes.txt"), "x");
    put(root, 40004, 13);
    writeFileSync(
      webServerPath(root, 40004),
      JSON.stringify({ pid: 13, port: 49999, project: root.project }),
    );
    writeFileSync(
      legacyWebPidPath(root),
      JSON.stringify({ pid: 14, port: 40001, project: root.project, started_at: "x" }),
    );
    expect(readWebServers(root).map((e) => [e.port, e.pid, e.legacy])).toEqual([
      [40001, 14, true],
      [40002, 12, false],
      [40005, 11, false],
    ]);
    expect(readWebServers(project("web-reg-empty"))).toEqual([]);
  });

  test("a legacy entry on a port that has its own file is not read twice", () => {
    const root = project("web-reg-dup");
    put(root, 40002, 12);
    writeFileSync(legacyWebPidPath(root), JSON.stringify({ pid: 99, port: 40002 }));
    expect(readWebServers(root).map((e) => e.pid)).toEqual([12]);
  });
});

describe("wip web · liveWebServers asks only the registered ports", () => {
  test("dead, running, stale and unresponsive", async () => {
    const root = project("web-live");
    put(root, 40001, 101); // dead
    put(root, 40002, 102); // running
    put(root, 40003, 103); // another pid answers
    put(root, 40004, 104); // another project answers
    put(root, 40005, 105); // another program
    put(root, 40006, 106); // accepts, no /health
    put(root, 40007, 107); // nothing accepts
    writeFileSync(legacyWebPidPath(root), JSON.stringify({ pid: 108, port: 40008 }));
    const d = deps(
      {
        40002: { kind: "wip", health: health(40002, 102, root.project) },
        40003: { kind: "wip", health: health(40003, 999, root.project) },
        40004: { kind: "wip", health: health(40004, 104, "/elsewhere") },
        40005: { kind: "other" },
        40006: { kind: "none" },
        40007: { kind: "none" },
      },
      [102, 103, 104, 105, 106, 107],
      [40006],
    );
    const { servers, removed } = await liveWebServers(root, d);
    expect(servers.map((s) => [s.port, s.pid, s.state])).toEqual([
      [40002, 102, "running"],
      [40006, 106, "unresponsive"],
    ]);
    expect(removed).toBe(6);
    expect(d.asked.sort()).toEqual([40002, 40003, 40004, 40005, 40006, 40007]);
    expect(readWebServers(root).map((e) => e.port)).toEqual([40002, 40006]);
    expect(existsSync(legacyWebPidPath(root))).toBe(false);
  });

  test("no registry: nothing asked, nothing running", async () => {
    const d = deps({}, []);
    expect(await liveWebServers(project("web-live-empty"), d)).toEqual({ servers: [], removed: 0 });
    expect(d.asked).toEqual([]);
  });

  test("pidAlive: this process is alive, a pid that does not exist is not", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
