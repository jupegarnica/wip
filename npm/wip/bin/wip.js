#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const EXIT_USAGE = 2;

const SUPPORTED = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
]);

function platformKey(platform, arch) {
  return `${platform === "win32" ? "windows" : platform}-${arch}`;
}

function packageName(platform, arch) {
  const key = platformKey(platform, arch);
  return SUPPORTED.has(key) ? `@garndev/wip-${key}` : null;
}

function resolveBinary({ platform, arch, env, resolve }) {
  if (env.WIP_BINARY_PATH) return { path: env.WIP_BINARY_PATH };
  const name = packageName(platform, arch);
  const key = platformKey(platform, arch);
  if (!name) {
    return {
      error: `wip: platform ${key} is not supported (supported: ${[...SUPPORTED].join(", ")}).`,
    };
  }
  const file = `${name}/bin/wip${platform === "win32" ? ".exe" : ""}`;
  try {
    return { path: resolve(file) };
  } catch {
    return {
      error:
        `wip: could not find the package ${name} for ${key}.\n` +
        "It is an optional dependency of @garndev/wip: reinstall without --omit=optional " +
        "(or --no-optional), or set WIP_BINARY_PATH to a wip binary.",
    };
  }
}

function main() {
  const found = resolveBinary({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    resolve: require.resolve,
  });
  if (found.error) {
    process.stderr.write(`${found.error}\n`);
    return EXIT_USAGE;
  }
  const result = spawnSync(found.path, process.argv.slice(2), { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`wip: could not run ${found.path}: ${result.error.message}\n`);
    return EXIT_USAGE;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return 1;
  }
  return result.status ?? 1;
}

module.exports = { packageName, resolveBinary, SUPPORTED };

if (require.main === module) {
  process.exitCode = main();
}
