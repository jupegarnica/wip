import { createInterface } from "node:readline/promises";
import { colorEnabled, type IStyle, makeStyle, PLAIN, visibleLength } from "./style.ts";

export interface ISelectOption {
  value: string;
  label: string;
  hint?: string;
}

export interface ISelectSpec {
  question: string;
  options: readonly ISelectOption[];
  /** Index highlighted at the start; Enter takes it. */
  initial: number;
}

export interface IInputSpec {
  label: string;
  /** What Enter takes; `null` is no default (an empty answer is returned as ""). */
  def: string | null;
  /** What to show in place of the default (for example `Y/n`). */
  show?: string;
}

/** The terminal side of the questions; `null` is Ctrl+C or the end of input. Injected in tests. */
export interface IAsker {
  style: IStyle;
  /** A closed list: the answer is the `value` of one option. */
  select(spec: ISelectSpec): Promise<string | null>;
  /** Free text; an empty answer takes `def`. */
  input(spec: IInputSpec): Promise<string | null>;
  say(line: string): void;
  close(): void;
}

export class Aborted extends Error {
  constructor() {
    super("aborted");
  }
}

/** Index of the option a typed text names (its number, value or label, any case), or -1. */
export function resolveOption(text: string, options: readonly ISelectOption[]): number {
  const t = text.trim().toLowerCase();
  if (t === "") return -1;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= options.length ? n - 1 : -1;
  }
  return options.findIndex((o) => o.value.toLowerCase() === t || o.label.toLowerCase() === t);
}

export function optionsError(options: readonly ISelectOption[]): string {
  return `not an option: choose 1-${options.length} or type ${options.map((o) => o.value).join(" / ")}`;
}

// ----- pure key handling (the terminal asker only does the I/O) -----

export interface ISelectState {
  cursor: number;
  buffer: string;
  error: string | null;
}

export type TStep<S, R> = { state: S } | { done: R } | { abort: true };

/** Splits a chunk of raw input into keys: escape sequences stay whole. */
export function keysOf(data: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escapes
  return data.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b[\s\S]?|[\s\S]/gu) ?? [];
}

const UP = ["\x1b[A", "\x1bOA"];
const DOWN = ["\x1b[B", "\x1bOB"];

export function selectStep(
  st: ISelectState,
  key: string,
  options: readonly ISelectOption[],
): TStep<ISelectState, number> {
  const n = options.length;
  if (key === "\x03" || (key === "\x04" && st.buffer === "")) return { abort: true };
  if (UP.includes(key))
    return { state: { cursor: (st.cursor + n - 1) % n, buffer: "", error: null } };
  if (DOWN.includes(key))
    return { state: { cursor: (st.cursor + 1) % n, buffer: "", error: null } };
  if (key === "\r" || key === "\n") {
    if (st.buffer === "") return { done: st.cursor };
    const i = resolveOption(st.buffer, options);
    if (i >= 0) return { done: i };
    return { state: { cursor: st.cursor, buffer: "", error: optionsError(options) } };
  }
  if (key === "\x7f" || key === "\b") {
    const buffer = st.buffer.slice(0, -1);
    const i = resolveOption(buffer, options);
    return { state: { cursor: i >= 0 ? i : st.cursor, buffer, error: null } };
  }
  if (key === "\x15") return { state: { ...st, buffer: "", error: null } };
  if (key.length === 1 && key >= " ") {
    const buffer = st.buffer + key;
    const i = resolveOption(buffer, options);
    return { state: { cursor: i >= 0 ? i : st.cursor, buffer, error: null } };
  }
  return { state: st };
}

export function inputStep(buffer: string, key: string): TStep<string, string> {
  if (key === "\x03" || (key === "\x04" && buffer === "")) return { abort: true };
  if (key === "\r" || key === "\n") return { done: buffer };
  if (key === "\x7f" || key === "\b") return { state: buffer.slice(0, -1) };
  if (key === "\x15") return { state: "" };
  if (key.length >= 1 && !key.startsWith("\x1b") && [...key].every((c) => c >= " ")) {
    return { state: buffer + key };
  }
  return { state: buffer };
}

// ----- rendering -----

export function renderSelect(spec: ISelectSpec, st: ISelectState, s: IStyle): string[] {
  const lines = [`${s.cyan("?")} ${s.bold(spec.question)}`];
  spec.options.forEach((o, i) => {
    const on = i === st.cursor;
    const mark = on ? s.cyan("❯") : " ";
    const label = `${i + 1}) ${o.label}`;
    const hint = o.hint ? `  ${s.dim(o.hint)}` : "";
    lines.push(`  ${mark} ${on ? s.cyan(s.bold(label)) : label}${hint}`);
  });
  const typed = st.buffer === "" ? "" : `  ${s.cyan("›")} ${st.buffer}`;
  lines.push(
    st.error
      ? `  ${s.red(st.error)}`
      : `  ${s.dim(`↑/↓ move · 1-${spec.options.length} or type · Enter confirm`)}${typed}`,
  );
  return lines;
}

export function renderInput(spec: IInputSpec, buffer: string, s: IStyle): string[] {
  const shown = spec.show ?? spec.def;
  const placeholder = buffer === "" && shown ? s.dim(shown) : "";
  return [`${s.cyan("?")} ${s.bold(spec.label)}`, `  ${s.cyan("❯")} ${buffer}${placeholder}`];
}

// ----- redrawing in place -----

/**
 * Rows the lines take on a terminal `columns` wide: a line longer than the width wraps onto more rows. Without a
 * width (not a terminal) each line is one row.
 */
export function screenRows(lines: readonly string[], columns: number | undefined): number {
  const w = columns !== undefined && columns > 0 ? columns : Number.POSITIVE_INFINITY;
  return lines.reduce((n, l) => n + Math.max(1, Math.ceil(visibleLength(l) / w)), 0);
}

/** What to write to replace the `rows` rows drawn last with `lines`: up to the first of them, clear down, draw. */
export function redraw(rows: number, lines: readonly string[]): string {
  const up = rows > 0 ? `\x1b[${rows}A` : "";
  return `${up}\r\x1b[J${lines.join("\n")}\n`;
}

// ----- the terminal asker -----

type TStdin = NodeJS.ReadStream;

/** Runs a key-driven block on a raw stdin; always restores the terminal. */
function drive<S, R>(
  stdin: TStdin,
  out: NodeJS.WriteStream,
  init: S,
  render: (st: S) => string[],
  step: (st: S, key: string) => TStep<S, R>,
  summary: (r: R, st: S) => string,
): Promise<R | null> {
  return new Promise((resolve) => {
    let st = init;
    let rows = 0;
    const draw = (lines: string[]) => {
      out.write(redraw(rows, lines));
      rows = screenRows(lines, out.columns);
    };
    const restore = () => {
      stdin.off("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {}
      stdin.pause();
    };
    const finish = (value: R | null, lines: string[]) => {
      restore();
      draw(lines);
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const key of keysOf(chunk.toString())) {
        const r = step(st, key);
        if ("abort" in r) return finish(null, []);
        if ("done" in r) return finish(r.done, [summary(r.done, st)]);
        st = r.state;
      }
      draw(render(st));
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    draw(render(st));
  });
}

/**
 * Questions and messages go to stderr: stdout stays for the result. On a terminal the questions are drawn with
 * arrow-key selection on a raw stdin (restored when each question ends); otherwise they are plain lines read with
 * readline, so a pipe or a script keeps working.
 */
export function terminalAsker(): IAsker {
  const stdin = process.stdin;
  const out = process.stderr;
  const raw = stdin.isTTY === true && typeof stdin.setRawMode === "function" && out.isTTY === true;
  const style = colorEnabled(out.isTTY, process.env) ? makeStyle(true) : PLAIN;
  const say = (line: string) => {
    out.write(`${line}\n`);
  };
  const safe = () => {
    try {
      stdin.setRawMode?.(false);
    } catch {}
  };
  if (raw) process.once("exit", safe);

  if (raw) {
    return {
      style,
      say,
      close: () => {
        process.off("exit", safe);
        safe();
      },
      select: (spec) =>
        drive<ISelectState, number>(
          stdin,
          out,
          { cursor: spec.initial, buffer: "", error: null },
          (st) => renderSelect(spec, st, style),
          (st, key) => selectStep(st, key, spec.options),
          (i) =>
            `${style.green("✔")} ${style.bold(spec.question)} ${style.cyan((spec.options[i] as ISelectOption).value)}`,
        ).then((i) => (i === null ? null : (spec.options[i] as ISelectOption).value)),
      input: (spec) =>
        drive<string, string>(
          stdin,
          out,
          "",
          (b) => renderInput(spec, b, style),
          inputStep,
          (v) => {
            const taken = v.trim() === "" ? (spec.def ?? "") : v.trim();
            return `${style.green("✔")} ${style.bold(spec.label)} ${taken === "" ? style.dim("(none)") : style.cyan(taken)}`;
          },
        ).then((v) => (v === null ? null : v.trim() === "" ? (spec.def ?? "") : v.trim())),
    };
  }

  const rl = createInterface({ input: stdin, output: out });
  let closed = false;
  const gone = new Promise<null>((resolve) => {
    rl.once("close", () => {
      closed = true;
      resolve(null);
    });
  });
  rl.on("SIGINT", () => rl.close());
  const ask = (question: string): Promise<string | null> =>
    closed ? Promise.resolve(null) : Promise.race([rl.question(question).catch(() => null), gone]);
  return {
    style,
    say,
    close: () => rl.close(),
    select: async (spec) => {
      say(spec.question);
      spec.options.forEach((o, i) => {
        say(`  ${i + 1}) ${o.label}${o.hint ? `  (${o.hint})` : ""}`);
      });
      for (;;) {
        const a = await ask(`  choose [${spec.initial + 1}] `);
        if (a === null) return null;
        if (a.trim() === "") return (spec.options[spec.initial] as ISelectOption).value;
        const i = resolveOption(a, spec.options);
        if (i >= 0) return (spec.options[i] as ISelectOption).value;
        say(`  ${optionsError(spec.options)}`);
      }
    },
    input: async (spec) => {
      const shown = spec.show ?? spec.def;
      const a = await ask(`${spec.label}${shown ? ` [${shown}]` : ""} `);
      return a === null ? null : a.trim() === "" ? (spec.def ?? "") : a.trim();
    },
  };
}

async function need<T>(p: Promise<T | null>): Promise<T> {
  const v = await p;
  if (v === null) throw new Aborted();
  return v;
}

/** Free text; Enter takes `def` (or "" when there is none). `check` returns an error message to ask again, or null. */
export async function askText(
  asker: IAsker,
  label: string,
  def: string | null,
  check: (answer: string) => string | null = () => null,
): Promise<string> {
  for (;;) {
    const value = await need(asker.input({ label, def }));
    const problem = check(value);
    if (problem === null) return value;
    asker.say(`  ${asker.style.red(problem)}`);
  }
}

/** A closed list; returns the `value` of the chosen option. */
export async function askSelect(asker: IAsker, spec: ISelectSpec): Promise<string> {
  return need(asker.select(spec));
}

export async function askYesNo(asker: IAsker, label: string, def: boolean): Promise<boolean> {
  for (;;) {
    const a = (
      await need(asker.input({ label, def: def ? "y" : "n", show: def ? "Y/n" : "y/N" }))
    ).toLowerCase();
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
  }
}
