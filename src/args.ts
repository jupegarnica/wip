import { usage } from "./errors.ts";

export interface IArgs {
  pos: string[];
  opts: Record<string, string>;
  flags: Set<string>;
}

/** `booleans` are the options that never take a value; `--json` always is one. */
export function parseArgs(argv: readonly string[], booleans: readonly string[] = []): IArgs {
  const flagNames = new Set([...booleans, "json"]);
  const pos: string[] = [];
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      pos.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    if (flagNames.has(key)) {
      if (eq > 0) throw usage(`--${key} takes no value`);
      flags.add(key);
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) throw usage(`--${key} needs a value`);
    if (key in opts) throw usage(`--${key} given twice`);
    opts[key] = value;
  }
  return { pos, opts, flags };
}

/** Fail on options the command does not know, so a typo never passes silently. */
export function allow(args: IArgs, known: readonly string[]): void {
  const ok = new Set([...known, "json"]);
  for (const key of [...Object.keys(args.opts), ...args.flags]) {
    if (!ok.has(key)) throw usage(`unknown option --${key}`);
  }
}

export function need(value: string | undefined, what: string): string {
  if (value === undefined || value === "") throw usage(`missing ${what}`);
  return value;
}

/** `--force` only with a `--reason`: the correction event carries it. */
export function forceReason(args: IArgs): string | null {
  if (!args.flags.has("force")) {
    if (args.opts.reason !== undefined) throw usage("--reason only goes with --force");
    return null;
  }
  return need(args.opts.reason, "--reason with --force");
}
