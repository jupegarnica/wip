/** One open item of the board: what `wip state --json` lists, reduced to what the pane draws. */
export type TKanbanItem = {
  id: string;
  flow: string;
  phase: string;
  /** `signals.attention`: the row that gets the stage's solid background. */
  attention: boolean;
};

/** A column of the flow's stage ramp, as `src/board.ts` computes it for the web. */
export type TKanbanColumn = {
  key: string;
  label: string;
  stage: string | null;
  phases: string[];
  alpha: number | null;
  /** CSS `rgba()`; the pane reads its RGB as the flow's tone at full opacity. */
  color: string;
  /** The tone composited over a white surface, and the text that contrasts with it; the attention rows use them. */
  color_light: string;
  text: string;
  /** The tone composited over the dark surface, and the text that contrasts with it; the attention rows use them. */
  color_dark: string;
  text_dark: string;
};

/** A flow and its columns; `phases` is the flow's declared order, which places each row. */
export type TKanbanFlow = {
  name: string;
  source: string | null;
  phases: string[];
  columns: TKanbanColumn[];
};

/** The last board read: the items, the flows and the error of the latest read, if any. */
export type TKanbanSnapshot = {
  items: TKanbanItem[];
  flows: TKanbanFlow[];
  error: string | null;
  lastGoodAt: number | null;
};

/** The last `wip web status --json` read: this project's Local URL, or null while none answers. */
export type TKanbanWeb = {
  url: string | null;
  at: number | null;
};

declare module "claude-code" {
  interface PluginState {
    "wip-kanban": {
      snapshot: Shaped<TKanbanSnapshot>;
      hiddenFlows: Shaped<string[]>;
      web: Shaped<TKanbanWeb>;
    };
  }
}
