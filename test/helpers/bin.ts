import { type IRunOutput, run } from "../../src/cli.ts";
import type { TEnv } from "../../src/env.ts";
import type { TExitCode } from "../../src/errors.ts";

/**
 * `WIP_TEST_BIN` points the e2e tests at a compiled binary or at the npm package's `bin/wip.mjs`; without it they run
 * the CLI in-process.
 */
export const WIP_BIN = process.env.WIP_TEST_BIN ?? null;

/** The argv prefix that runs WIP_BIN: a `.mjs` runs under node, as npm's Windows shim does; null in-process. */
export const WIP_CMD: string[] | null =
  WIP_BIN === null
    ? null
    : /\.m?js$/.test(WIP_BIN)
      ? [Bun.which("node") ?? "node", WIP_BIN]
      : [WIP_BIN];

export function wipIn(cwd: string, argv: readonly string[], env: TEnv = {}): IRunOutput {
  if (WIP_BIN === null) return run(argv, { cwd, env });
  const proc = Bun.spawnSync([...(WIP_CMD as string[]), ...argv], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(env as Record<string, string>) },
  });
  return {
    code: (proc.exitCode ?? 10) as TExitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

export interface IEnvelopeOut {
  code: number;
  body: {
    ok: boolean;
    item?: Record<string, unknown> | null;
    warnings: { code: string; message: string; [k: string]: unknown }[];
    message: string | null;
    data: Record<string, unknown> | null;
  };
}

export function wipJsonIn(cwd: string, argv: readonly string[], env: TEnv = {}): IEnvelopeOut {
  const out = wipIn(cwd, [...argv, "--json"], env);
  return { code: out.code, body: JSON.parse(out.stdout) as IEnvelopeOut["body"] };
}

/** Runs `wip … --json` where it must exit 0, and returns the envelope. */
export function wipOkIn(cwd: string, argv: readonly string[]): IEnvelopeOut["body"] {
  const out = wipJsonIn(cwd, argv);
  if (out.code !== 0) throw new Error(`wip ${argv.join(" ")} → ${out.code}: ${out.body.message}`);
  return out.body;
}
