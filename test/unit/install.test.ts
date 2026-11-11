import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  binPathOf,
  detectInstall,
  installKind,
  isBunInstall,
  npmPrefixOf,
  packageInfo,
  packageRoot,
  quoteWin,
} from "../../src/install.ts";
import { scratch } from "../helpers/project.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = scratch(`install-${name}`);
  dirs.push(dir);
  return dir;
}

/** An npm global layout under `<base>/<name>`: the package and its bundle, or its bin. */
function installTree(
  name: string,
  options: { file?: "dist" | "bin"; packageJson?: Record<string, unknown> } = {},
): { base: string; root: string; file: string } {
  const base = tmp(name);
  const prefix = join(base, "prefix");
  const root = join(prefix, "lib", "node_modules", "@garndev", "wip");
  const dir = join(root, options.file ?? "dist");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      options.packageJson ?? {
        name: "@garndev/wip",
        version: "1.2.3",
        bin: { wip: "bin/wip.mjs" },
      },
    ),
  );
  const file = join(dir, "wip.mjs");
  writeFileSync(file, "// bundle\n");
  return { base, root, file };
}

describe("installKind", () => {
  test("npm and binary come from the build; anything else is a source run", () => {
    expect(installKind("npm")).toBe("npm");
    expect(installKind("binary")).toBe("binary");
    expect(installKind(undefined)).toBe("source");
    expect(installKind("anything")).toBe("source");
  });

  test("a source test run reports source", () => {
    expect(detectInstall({ kind: "source", env: {} }).kind).toBe("source");
  });
});

describe("packageRoot", () => {
  test("walks two levels up from dist/wip.mjs", () => {
    const tree = installTree("dist");
    expect(packageRoot({ file: pathToFileURL(tree.file).href })).toBe(tree.root);
  });

  test("walks two levels up from bin/wip.mjs too", () => {
    const tree = installTree("bin", { file: "bin" });
    expect(packageRoot({ file: pathToFileURL(tree.file).href })).toBe(tree.root);
  });

  test("a package.json of another package is not wip's root", () => {
    const tree = installTree("other", {
      packageJson: { name: "@garndev/wip-dev", version: "9.9.9" },
    });
    expect(packageRoot({ file: pathToFileURL(tree.file).href })).toBeNull();
  });

  test("a missing tree gives null", () => {
    expect(packageRoot({ file: pathToFileURL(join(tmp("missing"), "dist", "wip.mjs")).href })).toBe(
      null,
    );
  });

  test("the launch shim's realpath is a candidate when the bundle's is not", () => {
    const tree = installTree("launch", { file: "bin" });
    const shim = join(tree.base, "bin", "wip");
    mkdirSync(join(tree.base, "bin"), { recursive: true });
    symlinkSync(tree.file, shim);
    const elsewhere = join(tmp("elsewhere"), "dist", "wip.mjs");
    expect(packageRoot({ file: pathToFileURL(elsewhere).href, launch: shim })).toBe(tree.root);
  });
});

describe("npmPrefixOf", () => {
  test("POSIX: <prefix>/lib/node_modules/@garndev/wip", () => {
    expect(npmPrefixOf("/usr/local/lib/node_modules/@garndev/wip", "darwin")).toBe("/usr/local");
    expect(
      npmPrefixOf("/home/u/.nvm/versions/node/v24/lib/node_modules/@garndev/wip", "linux"),
    ).toBe("/home/u/.nvm/versions/node/v24");
  });

  test("Windows: <prefix>/node_modules/@garndev/wip, with backslashes", () => {
    expect(
      npmPrefixOf("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@garndev\\wip", "win32"),
    ).toBe("C:/Users/u/AppData/Roaming/npm");
  });

  test("another layout is null", () => {
    expect(npmPrefixOf("/opt/wip", "darwin")).toBeNull();
    expect(npmPrefixOf("/usr/local/lib/node_modules/@garndev/wip/dist", "win32")).toBeNull();
  });
});

describe("binPathOf, quoteWin and isBunInstall", () => {
  test("the shim follows the platform", () => {
    expect(binPathOf("/usr/local", "darwin")).toBe("/usr/local/bin/wip");
    expect(binPathOf("C:/npm", "win32")).toBe("C:/npm/wip.cmd");
  });

  test("quoteWin wraps whitespace and command characters, and refuses a double quote", () => {
    expect(quoteWin("plain")).toBe("plain");
    expect(quoteWin("with space")).toBe('"with space"');
    expect(quoteWin("a&b")).toBe('"a&b"');
    expect(() => quoteWin('a"b')).toThrow("double quote");
  });

  test("a path under BUN_INSTALL or .bun/install/global is Bun's", () => {
    expect(isBunInstall("/home/u/.bun/install/global/node_modules/@garndev/wip", {})).toBe(true);
    expect(
      isBunInstall("/custom/bun/install/global/node_modules/@garndev/wip", {
        BUN_INSTALL: "/custom/bun",
      }),
    ).toBe(true);
    expect(isBunInstall("/usr/local/lib/node_modules/@garndev/wip", {})).toBe(false);
  });
});

describe("detectInstall", () => {
  test("an npm global layout: prefix, shim and entry", () => {
    const tree = installTree("detect");
    const info = detectInstall({
      kind: "npm",
      env: {},
      platform: "darwin",
      file: pathToFileURL(tree.file).href,
    });
    expect(info).toMatchObject({
      kind: "npm",
      root: tree.root,
      prefix: join(tree.base, "prefix"),
      bin: join(tree.base, "prefix", "bin", "wip"),
      version: "0.2.1",
      problem: null,
      entry: "bin/wip.mjs",
    });
  });

  test("a renamed package is refused with both ways out", () => {
    const tree = installTree("renamed", {
      packageJson: { name: "@garndev/wip", version: "1.2.3", bin: { wip2: "bin/wip.mjs" } },
    });
    const info = detectInstall({
      kind: "npm",
      env: {},
      platform: "darwin",
      file: pathToFileURL(tree.file).href,
    });
    expect(info.problem).toContain('"wip2"');
    expect(info.problem).toContain("--bin-name");
    expect(info.problem).toContain("wip_bin");
  });

  test("a Bun global store is refused pointing at bun add", () => {
    const base = tmp("bun");
    const root = join(base, ".bun", "install", "global", "node_modules", "@garndev", "wip");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@garndev/wip", version: "1.2.3", bin: { wip: "bin/wip.mjs" } }),
    );
    writeFileSync(join(root, "dist", "wip.mjs"), "");
    const info = detectInstall({
      kind: "npm",
      env: {},
      platform: "darwin",
      file: pathToFileURL(join(root, "dist", "wip.mjs")).href,
    });
    expect(info.problem).toContain("Bun global install");
    expect(info.problem).toContain("bun add -g");
  });

  test("outside npm's global layout is refused", () => {
    const base = tmp("outside");
    mkdirSync(join(base, "dist"), { recursive: true });
    writeFileSync(
      join(base, "package.json"),
      JSON.stringify({ name: "@garndev/wip", version: "1.2.3", bin: { wip: "bin/wip.mjs" } }),
    );
    writeFileSync(join(base, "dist", "wip.mjs"), "");
    const info = detectInstall({
      kind: "npm",
      env: {},
      platform: "darwin",
      file: pathToFileURL(join(base, "dist", "wip.mjs")).href,
    });
    expect(info.problem).toContain("not installed by npm");
  });

  test("packageInfo reads only a JSON object of wip's package", () => {
    const tree = installTree("info");
    expect(packageInfo(tree.root)).toEqual({
      name: "@garndev/wip",
      version: "1.2.3",
      bin: { wip: "bin/wip.mjs" },
    });
    expect(packageInfo(join(tree.base, "nowhere"))).toBeNull();
  });
});
