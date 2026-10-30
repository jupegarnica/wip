# wip

Per-project workflow state for coding agents.

> Work in progress: this repository only contains the skeleton (build, launcher and `wip --version`).

## Install

`@garndev/wip` is not published yet. It ships as one npm package per platform
(`@garndev/wip-<os>-<arch>`), installed as an optional dependency of `@garndev/wip`, which only
contains a small Node launcher. Supported platforms: `darwin-arm64`, `darwin-x64`, `linux-x64`,
`linux-arm64`, `windows-x64`.

If `wip` says it cannot find its platform package, it was installed with `--omit=optional`
(or `--no-optional`): reinstall without it, or point `WIP_BINARY_PATH` to a `wip` binary. The binary
inside the platform package runs on its own, without Node or Bun.

## Development

Requires the Bun version in `.bun-version`.

```sh
bun install
bun test
bunx tsc --noEmit
bunx biome check .
bun src/cli.ts --version
bun scripts/build.ts --targets host --out dist --pack   # or --targets all
```
