import type { IFlow } from "./flow/parse.ts";
import type { IFlowSet, TFlowSource } from "./flow/registry.ts";

/** A column without a stage has no colour: `alpha` null and the colour and text fields empty. */
export interface IStagePaint {
  alpha: number | null;
  /** CSS `rgba()`. */
  color: string;
  /** Solid colour over `SURFACE_LIGHT`: what a terminal with a light theme paints. */
  color_light: string;
  /** Solid colour over `SURFACE_DARK`: what a terminal with a dark theme paints. */
  color_dark: string;
  /** Text on `color_light`. */
  text: string;
  /** Text on `color_dark`. */
  text_dark: string;
}

export const NO_PAINT: IStagePaint = {
  alpha: null,
  color: "",
  color_light: "",
  color_dark: "",
  text: "",
  text_dark: "",
};

export interface IColumn extends IStagePaint {
  key: string;
  label: string;
  stage: string | null;
  phases: string[];
}

/** A flow of the board: `phases` keeps the flow's declared order; `columns` groups them by stage. */
export interface IBoardFlow {
  name: string;
  source: TFlowSource;
  /** The phases as the flow declares them, in order. A phase only items use is not here. */
  phases: string[];
  columns: IColumn[];
}

/** The part of an item the board groups by. */
export interface IBoardPhase {
  flow: string;
  phase: string;
}

/** Default tone of a flow without `color`; each stage is more transparent the later it comes in the flow. */
export const STAGE_TONE = "#2563EB";
export const STAGE_ALPHA_FIRST = 1;
export const STAGE_ALPHA_LAST = 0.25;
/** `--surface` of each theme in web/app.css: the stage colour is composited over it to choose the text. */
export const SURFACE_LIGHT = "#FFFFFF";
export const SURFACE_DARK = "#211F1D";
const DARK_TEXT = "#111111";
const LIGHT_TEXT = "#FFFFFF";

/** Opacity of the stage at `index` of `count`: the first one opaque, the last one at `STAGE_ALPHA_LAST`. */
export function stageAlpha(index: number, count: number): number {
  if (count <= 1) return STAGE_ALPHA_FIRST;
  const step = (STAGE_ALPHA_FIRST - STAGE_ALPHA_LAST) / (count - 1);
  return Math.round((STAGE_ALPHA_FIRST - step * index) * 100) / 100;
}

function rgbOf(hex: string): [number, number, number] {
  const at = (i: number): number => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return [at(0), at(1), at(2)];
}

export function stageColor(alpha: number, tone: string = STAGE_TONE): string {
  const [r, g, b] = rgbOf(tone);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The solid colour `tone` at `alpha` shows over `surface`. */
export function composite(tone: string, alpha: number, surface: string): string {
  const under = rgbOf(surface);
  const mixed = rgbOf(tone).map((c, i) =>
    Math.round(c * alpha + (under[i] as number) * (1 - alpha)),
  );
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

function luminance(hex: string): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgbOf(hex).map(channel) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Dark or white text, whichever has the higher WCAG contrast on `hex`. */
export function textOn(hex: string): string {
  const l = luminance(hex);
  const onDark = (luminance(LIGHT_TEXT) + 0.05) / (l + 0.05);
  const onLight = (l + 0.05) / (luminance(DARK_TEXT) + 0.05);
  return onDark >= onLight ? LIGHT_TEXT : DARK_TEXT;
}

/** The paint of a stage at `alpha` in `tone`: each theme's solid colour and the text that contrasts with it. */
export function stagePaint(alpha: number, tone: string = STAGE_TONE): IStagePaint {
  const colorLight = composite(tone, alpha, SURFACE_LIGHT);
  const colorDark = composite(tone, alpha, SURFACE_DARK);
  return {
    alpha,
    color: stageColor(alpha, tone),
    color_light: colorLight,
    color_dark: colorDark,
    text: textOn(colorLight),
    text_dark: textOn(colorDark),
  };
}

export function paintOf(column: IStagePaint | undefined): IStagePaint {
  if (!column) return { ...NO_PAINT };
  const { alpha, color, color_light, color_dark, text, text_dark } = column;
  return { alpha, color, color_light, color_dark, text, text_dark };
}

/**
 * One column per `stage`, in the order each stage first appears; a phase without a stage is its own column.
 * Phases of live items that the flow lacks go last, one column each.
 */
export function flowColumns(flow: IFlow | null, extraPhases: readonly string[] = []): IColumn[] {
  const columns: IColumn[] = [];
  const add = (key: string, label: string, stage: string | null, phase: string): void => {
    const found = columns.find((c) => c.key === key);
    if (found) found.phases.push(phase);
    else columns.push({ key, label, stage, phases: [phase], ...NO_PAINT });
  };
  for (const p of flow?.phases ?? []) {
    if (p.stage) add(`stage:${p.stage}`, p.stage, p.stage, p.name);
    else add(`phase:${p.name}`, p.name, null, p.name);
  }
  for (const name of extraPhases) {
    if (!columns.some((c) => c.phases.includes(name))) add(`phase:${name}`, name, null, name);
  }
  const staged = columns.filter((c) => c.stage !== null);
  const tone = flow?.color ?? STAGE_TONE;
  staged.forEach((c, i) => {
    Object.assign(c, stagePaint(stageAlpha(i, staged.length), tone));
  });
  return columns;
}

/**
 * Every enabled flow, plus any flow an item names, sorted by name: its declared phases and its columns.
 * `flowColumns` also gets the phases the items use, so an unknown one is a colourless extra column.
 */
export function boardFlows(flows: IFlowSet, items: readonly IBoardPhase[]): IBoardFlow[] {
  const names = [...new Set([...flows.entries.keys(), ...items.map((i) => i.flow)])].sort();
  return names.map((name) => {
    const flow = flows.entries.get(name)?.flow ?? null;
    const used = [...new Set(items.filter((i) => i.flow === name).map((i) => i.phase))];
    return {
      name,
      source: flows.entries.get(name)?.source ?? null,
      phases: (flow?.phases ?? []).map((p) => p.name),
      columns: flowColumns(flow, used),
    };
  });
}
