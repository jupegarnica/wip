/** ANSI styling for the init prompts: on only for a terminal without NO_COLOR, so piped output stays plain. */
export interface IStyle {
  on: boolean;
  bold(t: string): string;
  dim(t: string): string;
  cyan(t: string): string;
  green(t: string): string;
  red(t: string): string;
  yellow(t: string): string;
}

export const PLAIN: IStyle = makeStyle(false);

export function colorEnabled(isTTY: boolean | undefined, env: Record<string, string | undefined>) {
  return isTTY === true && (env.NO_COLOR === undefined || env.NO_COLOR === "");
}

export function makeStyle(on: boolean): IStyle {
  const wrap = (open: number, close: number) => (t: string) =>
    on ? `\x1b[${open}m${t}\x1b[${close}m` : t;
  return {
    on,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    cyan: wrap(36, 39),
    green: wrap(32, 39),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
  };
}

/** Length of a text without its ANSI sequences. */
export function visibleLength(t: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escapes
  return t.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Lines inside a rounded box, sized to the widest line. */
export function box(title: string, rows: readonly string[], s: IStyle): string[] {
  const width = Math.max(visibleLength(title) + 2, ...rows.map(visibleLength));
  const pad = (t: string) => t + " ".repeat(width - visibleLength(t));
  const top = `╭─ ${title} ${"─".repeat(Math.max(0, width - visibleLength(title) - 1))}╮`;
  return [
    s.dim(top),
    ...rows.map((r) => `${s.dim("│")} ${pad(r)} ${s.dim("│")}`),
    s.dim(`╰${"─".repeat(width + 2)}╯`),
  ];
}
