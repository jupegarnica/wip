import { type IRunOutput, run } from "../../src/cli.ts";
import type { TExitCode } from "../../src/errors.ts";

/** `WIP_BIN` points the e2e tests at a compiled binary; without it they run the CLI in-process. */
export const WIP_BIN = process.env.WIP_BIN ?? null;

export function wipIn(cwd: string, argv: readonly string[]): IRunOutput {
  if (WIP_BIN === null) return run(argv, { cwd, env: {} });
  const proc = Bun.spawnSync([WIP_BIN, ...argv], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
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

export function wipJsonIn(cwd: string, argv: readonly string[]): IEnvelopeOut {
  const out = wipIn(cwd, [...argv, "--json"]);
  return { code: out.code, body: JSON.parse(out.stdout) as IEnvelopeOut["body"] };
}

/** Runs `wip … --json` where it must exit 0, and returns the envelope. */
export function wipOkIn(cwd: string, argv: readonly string[]): IEnvelopeOut["body"] {
  const out = wipJsonIn(cwd, argv);
  if (out.code !== 0) throw new Error(`wip ${argv.join(" ")} → ${out.code}: ${out.body.message}`);
  return out.body;
}
