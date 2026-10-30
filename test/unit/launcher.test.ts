import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";

interface IResolveInput {
  platform: string;
  arch: string;
  env: Record<string, string | undefined>;
  resolve: (id: string) => string;
}

interface ILauncher {
  packageName: (platform: string, arch: string) => string | null;
  resolveBinary: (input: IResolveInput) => { path?: string; error?: string };
}

const LAUNCHER = join(import.meta.dir, "..", "..", "npm", "wip", "bin", "wip.js");
const launcher = createRequire(import.meta.url)(LAUNCHER) as ILauncher;
const NODE = Bun.which("node") ?? process.execPath;

const resolveFrom = (paths: Record<string, string>) => (id: string) => {
  const found = paths[id];
  if (!found) throw new Error(`Cannot find module '${id}'`);
  return found;
};

describe("platform package", () => {
  test.each([
    ["darwin", "arm64", "@garndev/wip-darwin-arm64"],
    ["darwin", "x64", "@garndev/wip-darwin-x64"],
    ["linux", "x64", "@garndev/wip-linux-x64"],
    ["linux", "arm64", "@garndev/wip-linux-arm64"],
    ["win32", "x64", "@garndev/wip-windows-x64"],
  ])("%s/%s → %s", (platform, arch, name) => {
    expect(launcher.packageName(platform, arch)).toBe(name);
  });

  test.each([
    ["win32", "arm64"],
    ["linux", "ia32"],
    ["freebsd", "x64"],
  ])("%s/%s is not supported", (platform, arch) => {
    expect(launcher.packageName(platform, arch)).toBeNull();
    const found = launcher.resolveBinary({ platform, arch, env: {}, resolve: resolveFrom({}) });
    expect(found.error).toContain("is not supported");
  });

  test("resolves the binary inside the platform package, with .exe on Windows", () => {
    const resolve = resolveFrom({
      "@garndev/wip-linux-arm64/bin/wip": "/p/linux/wip",
      "@garndev/wip-windows-x64/bin/wip.exe": "C:\\p\\wip.exe",
    });
    expect(launcher.resolveBinary({ platform: "linux", arch: "arm64", env: {}, resolve })).toEqual({
      path: "/p/linux/wip",
    });
    expect(launcher.resolveBinary({ platform: "win32", arch: "x64", env: {}, resolve })).toEqual({
      path: "C:\\p\\wip.exe",
    });
  });

  test("WIP_BINARY_PATH wins over the platform package", () => {
    const resolve = resolveFrom({ "@garndev/wip-darwin-arm64/bin/wip": "/p/darwin/wip" });
    const env = { WIP_BINARY_PATH: "/custom/wip" };
    expect(launcher.resolveBinary({ platform: "darwin", arch: "arm64", env, resolve })).toEqual({
      path: "/custom/wip",
    });
  });

  test("a missing platform package explains --omit=optional", () => {
    const found = launcher.resolveBinary({
      platform: "darwin",
      arch: "x64",
      env: {},
      resolve: resolveFrom({}),
    });
    expect(found.error).toContain("@garndev/wip-darwin-x64");
    expect(found.error).toContain("--omit=optional");
  });
});

describe("launcher process", () => {
  const runLauncher = (args: string[], env: Record<string, string | undefined>) =>
    Bun.spawnSync([NODE, LAUNCHER, ...args], { env: { ...process.env, ...env } });

  test("passes the arguments and stdio through and propagates the exit code", () => {
    const result = runLauncher(
      ["-e", "console.log('hello ' + process.argv.length); process.exit(7)"],
      {
        WIP_BINARY_PATH: process.execPath,
      },
    );
    expect(result.exitCode).toBe(7);
    expect(result.stdout.toString()).toContain("hello");
  });

  test.skipIf(process.platform === "win32")("propagates the signal of the binary", () => {
    const result = runLauncher(["-e", "process.kill(process.pid, 'SIGTERM')"], {
      WIP_BINARY_PATH: process.execPath,
    });
    expect(result.signalCode).toBe("SIGTERM");
  });

  test("without a platform package it exits 2 and explains --omit=optional", () => {
    const result = runLauncher(["--version"], { WIP_BINARY_PATH: undefined });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("--omit=optional");
  });
});
