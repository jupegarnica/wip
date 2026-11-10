// wip web: polls /api/kanban every 5 s and repaints only when the text changed; the item panel polls
// /api/item/<flow>/<ID> while it is open, and the History view polls /api/history while it is shown. The DOM is built
// with textContent only: nothing from the server becomes HTML. The one exception is the .md preview, built in
// markdown.js (WipMd): the highlighter's HTML is parsed inert and only whitelisted div/span are rebuilt. The panel
// compares a stable key that ignores the clock-derived total, so an open gate's wait only repaints Totals, and the
// preview keeps its own scroll across a repaint.

const POLL_MS = 5000;
const TIMEOUT_MS = 5000;
const INCOHERENT = {
  I1: "I1: the phase is not in the flow",
  I2f: "I2f: waiting_on has an invalid format",
  I2: "I2: waits on agents with no running run, or runs without waiting on them",
  I3: "I3: more than one open gate",
  I4: "I4: waiting_on none outside a terminal phase",
};

const VIEW_KEY = "wip-web.view";
const VIEWS = ["grouped", "expanded", "history"];
const REMEMBERED_VIEWS = ["grouped", "expanded"];
const HISTORY_PAGE = 50;
const HISTORY_KEY = "wip-web.history";
const HISTORY_INCLUDE = ["active", "archived", "discarded"];
const HISTORY_DEFAULT = { active: true, archived: true, discarded: false };
const COLLAPSE_KEY = "wip-web.collapsed";

const titleEl = document.getElementById("title");
const board = document.getElementById("board");
const statusEl = document.getElementById("status");
const viewButtons = document.querySelectorAll("[data-view]");
const gatesBox = document.getElementById("gates");
const gatesList = document.getElementById("gates-list");
const envTetoca = document.getElementById("env-tetoca");
const envAgents = document.getElementById("env-agents");
const envPolling = document.getElementById("env-polling");
const envScheduled = document.getElementById("env-scheduled");
const panel = document.getElementById("panel");
const panelTitle = document.getElementById("panel-title");
const panelBody = document.getElementById("panel-body");
const panelClose = document.getElementById("panel-close");
const historyBox = document.getElementById("history");
const historyRows = document.getElementById("history-rows");
const historyFlow = document.getElementById("history-flow");
const historyQ = document.getElementById("history-q");
const historyActive = document.getElementById("history-active");
const historyArchived = document.getElementById("history-archived");
const historyDiscarded = document.getElementById("history-discarded");
const historyCount = document.getElementById("history-count");
const historyPrev = document.getElementById("history-prev");
const historyNext = document.getElementById("history-next");

let view = initialView();
let lastData = null;
let lastText = null;
let lastOk = null;
let state = { kind: "wait", error: "" };
let prevCards = new Map();
let timer = null;
let inFlight = false;
let openRef = null; // { flow, id } of the item in the panel
let panelText = null; // stable key: the item body with totals.user_wait_seconds zeroed
let panelRaw = null; // last body, to repaint Totals only when the wait moved
let panelTimer = null;
let viewer = null; // { name, text, md?, lineStarts?, refs?, notice? } of the artifact shown in the panel
const hist = { flow: "", q: "", include: initialInclude(), offset: 0 };
let historyText = null;
let historyFlows = "";
let historyTimer = null;
const collapsed = initialCollapsed();

// Collapsed flows by name; a bad or unknown value leaves every flow expanded.
function initialCollapsed() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) || "[]");
    if (Array.isArray(stored)) {
      return new Set(stored.filter((n) => typeof n === "string" && n.length > 0 && n.length <= 64));
    }
  } catch (_) {
    // no storage or bad JSON
  }
  return new Set();
}

function saveCollapsed() {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed].sort()));
  } catch (_) {
    // no storage: the choice lasts until reload
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(text, href, cls) {
  if (typeof href === "string" && /^https?:\/\//.test(href)) {
    const a = el("a", cls, text);
    a.setAttribute("href", href);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    return a;
  }
  return el("span", cls, text);
}

const sameRef = (a, b) => Boolean(a && b && a.flow === b.flow && a.id === b.id);
const refKey = (flow, id) => `${flow}/${id}`;

/** The item's ID, linked to its first `links` match; the other matches as small links after it. */
function idWithLinks(item, cls) {
  const frag = document.createDocumentFragment();
  const links = item.links || [];
  const own = links.find((l) => l.source === "id");
  const id = link(item.id, own ? own.url : null, cls);
  if (own) id.setAttribute("title", own.url);
  frag.appendChild(id);
  for (const l of links) {
    if (l === own) continue;
    const a = link(l.label, l.url, "ext");
    a.setAttribute("title", `${l.source}: ${l.url}`);
    frag.appendChild(a);
  }
  return frag;
}

function waitingText(w) {
  if (!w || w === "none") return "";
  if (w === "user") return "⏳you";
  if (w.startsWith("agent:")) return "⏳agent";
  return `⏳${w.length > 12 ? `${w.slice(0, 11)}…` : w}`;
}

// A card opens the item panel (click, Enter or Space); its links keep opening their pages.
function openable(node, item) {
  node.dataset.flow = item.flow;
  node.dataset.id = item.id;
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.setAttribute("aria-label", `${item.id}: details`);
  if (sameRef(openRef, item)) node.classList.add("card--open");
}

function cardKey(item) {
  return JSON.stringify([
    item.phase,
    item.waiting_on,
    item.next,
    item.signals.attention,
    item.signals.incoherent,
    item.open_gates.length,
    item.agents.length,
    item.cron_at,
  ]);
}

// An empty value removes the property, so a phase without a stage falls back to the uncoloured look.
function paintStage(node, paint) {
  node.style.setProperty("--stage", paint.color || "");
  node.style.setProperty("--on-stage", paint.text || "");
  node.style.setProperty("--on-stage-dark", paint.text_dark || "");
}

function paintCard(node, item, changed) {
  openable(node, item);
  paintStage(node, item);
  if (item.signals.attention) node.classList.add("card--attention");
  if (changed) node.classList.add("changed");
}

function incoherentTitle(codes) {
  return codes.map((code) => INCOHERENT[code] || code).join("\n");
}

// Local time of a cron: HH:MM today, or "D Mon HH:MM" another day.
function cronTime(isoText) {
  const d = new Date(isoText);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${hm}`;
}

function cronBadge(item) {
  const badge = el("span", "cron-badge", `⏰ ${cronTime(item.cron_at)}`);
  badge.setAttribute("title", `scheduled: ${item.cron_at}`);
  return badge;
}

function card(item, changed) {
  const node = el("div", "card");
  paintCard(node, item, changed);
  node.appendChild(idWithLinks(item, "id"));
  node.appendChild(el("span", "ph", item.phase));
  const w = waitingText(item.waiting_on);
  if (w) {
    const ws = el("span", "wait", w);
    ws.setAttribute("title", `waiting_on: ${item.waiting_on}`);
    node.appendChild(ws);
  }
  if (item.signals.incoherent.length) {
    const inc = el("span", "incoherent", `! ${item.signals.incoherent.join(" ")}`);
    inc.setAttribute("title", incoherentTitle(item.signals.incoherent));
    node.appendChild(inc);
  }
  if (item.cron_at) node.appendChild(cronBadge(item));
  if (item.title) node.appendChild(el("span", "title", item.title));
  return node;
}

// Expanded view: everything the board has for the item.
function fullCard(item, changed) {
  const node = el("div", "card card--full");
  paintCard(node, item, changed);
  const head = el("div", "row");
  head.appendChild(idWithLinks(item, "id"));
  node.appendChild(head);
  if (item.cron_at) head.appendChild(cronBadge(item));
  if (item.title) node.appendChild(el("div", "row", item.title));
  const where = el("div", "row detail");
  where.appendChild(el("span", "ph-full", item.phase));
  if (item.stage) where.appendChild(el("span", null, item.stage));
  node.appendChild(where);
  if (item.waiting_on && item.waiting_on !== "none") {
    node.appendChild(el("div", "row wait", `⏳ ${item.waiting_on}`));
  }
  if (item.next) node.appendChild(el("div", "row detail", `next: ${item.next}`));
  for (const g of item.open_gates) {
    node.appendChild(el("div", "row flag", `✋ ${g.question || "(no question)"}`));
  }
  for (const a of item.agents) node.appendChild(el("div", "row detail", `▶ ${a.agent}`));
  for (const code of item.signals.incoherent) {
    node.appendChild(el("div", "row incoherent", `! ${INCOHERENT[code] || code}`));
  }
  return node;
}

function sortById(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function track(item, nextCards) {
  const key = cardKey(item);
  const k = refKey(item.flow, item.id);
  nextCards.set(k, key);
  return lastText !== null && prevCards.get(k) !== key;
}

// Grouped: one column per stage (or per phase when the flow has no stages), the phases inside it.
function groupedColumns(flow, items, nextCards, stages) {
  for (const column of flow.columns) {
    const col = el("div", "stage");
    paintStage(col, column);
    const inColumn = items.filter((i) => column.phases.includes(i.phase));
    const h = el("h3", null, column.label);
    h.appendChild(el("span", "count", String(inColumn.length)));
    col.appendChild(h);
    if (!inColumn.length) col.appendChild(el("div", "empty", "—"));
    for (const phase of column.phases) {
      const cards = inColumn.filter((i) => i.phase === phase).sort(sortById);
      if (!cards.length) continue;
      if (column.phases.length > 1) col.appendChild(el("div", "phase", phase));
      for (const item of cards) col.appendChild(card(item, track(item, nextCards)));
    }
    stages.appendChild(col);
  }
}

// Expanded: one column per phase, coloured by its stage column.
function expandedColumns(flow, items, nextCards, stages) {
  for (const column of flow.columns) {
    for (const phase of column.phases) {
      const col = el("div", "stage stage--phase");
      paintStage(col, column);
      const cards = items.filter((i) => i.phase === phase).sort(sortById);
      const h = el("h3", null, phase);
      h.appendChild(el("span", "count", String(cards.length)));
      col.appendChild(h);
      if (column.stage) col.appendChild(el("div", "phase", column.stage));
      if (!cards.length) col.appendChild(el("div", "empty", "—"));
      for (const item of cards) col.appendChild(fullCard(item, track(item, nextCards)));
      stages.appendChild(col);
    }
  }
}

/** A flow whose columns are one phase each looks the same in both views. */
function perPhase(flow) {
  return flow.columns.every((c) => c.phases.length <= 1);
}

const SOURCE_NOTE = {
  stored: " · file invalid: last valid version",
  null: " · file invalid: no valid version",
};

// Collapse one flow in place: the header stays, its .stages disappear, nothing else is repainted.
function setCollapsed(name, next) {
  if (next) collapsed.add(name);
  else collapsed.delete(name);
  saveCollapsed();
  const toggle = board.querySelector(`[data-flow-toggle="${CSS.escape(name)}"]`);
  const section = toggle ? toggle.closest(".flow") : null;
  const stages = toggle ? document.getElementById(toggle.getAttribute("aria-controls")) : null;
  if (!toggle || !section || !stages) return;
  stages.hidden = next;
  section.classList.toggle("flow--collapsed", next);
  toggle.setAttribute("aria-expanded", String(!next));
  toggle.setAttribute("title", next ? `Expand flow ${name}` : `Collapse flow ${name}`);
  const chev = toggle.querySelector(".chev");
  if (chev) chev.textContent = next ? "▸" : "▾";
}

function render(data) {
  const scroll = { x: window.scrollX, y: window.scrollY, flows: {} };
  for (const s of board.querySelectorAll(".stages")) scroll.flows[s.dataset.flow] = s.scrollLeft;
  const focused = document.activeElement?.closest("[data-flow-toggle]");
  const focusedFlow = focused && board.contains(focused) ? focused.dataset.flowToggle : null;
  const nextCards = new Map();
  const frag = document.createDocumentFragment();
  for (const flow of data.flows) {
    const items = data.items.filter((i) => i.flow === flow.name);
    const isCollapsed = collapsed.has(flow.name);
    const stagesId = `flow-${flow.name}-stages`;
    const section = el("section", "flow");
    section.dataset.flow = flow.name;
    section.classList.toggle("flow--collapsed", isCollapsed);
    const h = el("h2");
    const toggle = el("button", "flow-toggle");
    toggle.type = "button";
    toggle.dataset.flowToggle = flow.name;
    toggle.setAttribute("aria-expanded", String(!isCollapsed));
    toggle.setAttribute("aria-controls", stagesId);
    toggle.setAttribute(
      "title",
      isCollapsed ? `Expand flow ${flow.name}` : `Collapse flow ${flow.name}`,
    );
    const chev = el("span", "chev", isCollapsed ? "▸" : "▾");
    chev.setAttribute("aria-hidden", "true");
    toggle.appendChild(chev);
    toggle.appendChild(el("span", "flow-name", flow.name));
    toggle.appendChild(
      el("span", "flow-count", items.length ? `${items.length} open` : "no open items"),
    );
    const attention = items.filter((i) => i.signals.attention).length;
    if (attention) {
      const warn = el("span", "flow-attention", `· ${attention} waiting on you`);
      warn.setAttribute("title", `${attention} items waiting on you`);
      toggle.appendChild(warn);
    }
    h.appendChild(toggle);
    const note = SOURCE_NOTE[String(flow.source)];
    if (note) h.appendChild(el("span", "incoherent", note));
    section.appendChild(h);
    const expanded = view === "expanded" && !perPhase(flow);
    const stages = el("div", expanded ? "stages stages--expanded" : "stages");
    stages.dataset.flow = flow.name;
    stages.id = stagesId;
    stages.hidden = isCollapsed;
    (expanded ? expandedColumns : groupedColumns)(flow, items, nextCards, stages);
    section.appendChild(stages);
    frag.appendChild(section);
  }
  if (!data.flows.length) {
    frag.appendChild(el("p", "empty", "No flows in `<defs>/skills/wip-flow-*/`: run `wip init`."));
  } else if (!data.items.length) {
    frag.appendChild(el("p", "empty", "No open items."));
  }
  board.replaceChildren(frag);
  prevCards = nextCards;
  if (focusedFlow) {
    const again = board.querySelector(`[data-flow-toggle="${CSS.escape(focusedFlow)}"]`);
    if (again) again.focus();
  }
  for (const s of board.querySelectorAll(".stages")) {
    if (scroll.flows[s.dataset.flow] !== undefined) s.scrollLeft = scroll.flows[s.dataset.flow];
  }
  window.scrollTo(scroll.x, scroll.y);
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 120) return `${s} s`;
  return `${Math.round(s / 60)} min`;
}

function paintStatus() {
  let text;
  let cls;
  if (state.kind === "ok") {
    text = `updated ${ago(lastOk)} ago`;
    cls = "ok";
  } else if (state.kind === "off") {
    text = `offline${lastOk ? ` · last data ${ago(lastOk)} ago` : ""}`;
    cls = "off";
  } else if (state.kind === "error") {
    text = `error: ${state.error}`;
    cls = "error";
  } else {
    text = "loading…";
    cls = "wait";
  }
  statusEl.textContent = text;
  statusEl.className = `status status--${cls}`;
}

async function poll() {
  if (inFlight) return;
  inFlight = true;
  clearTimeout(timer);
  try {
    const res = await fetch("/api/kanban", {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const text = await res.text();
      lastOk = Date.now();
      state = { kind: "ok", error: "" };
      if (text !== lastText) {
        lastData = JSON.parse(text);
        render(lastData);
        renderTetoca(lastData.your_turn);
        lastText = text;
      }
      // Every round: the ages move even when the board does not.
      renderGates(lastData.open_gates);
      renderPolling(lastData.polling);
      renderScheduled(lastData.crons);
      renderAgents(lastData.running);
    } else {
      let message = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch (_) {
        // keep the status code
      }
      state = { kind: "error", error: message };
    }
  } catch (_) {
    state = { kind: "off", error: "" };
  }
  if (view === "history") await loadHistory();
  inFlight = false;
  paintStatus();
  timer = setTimeout(poll, POLL_MS);
}

function detailButton(flow, id) {
  const b = el("button", "btn btn--small", "details");
  b.type = "button";
  b.dataset.flow = flow;
  b.dataset.open = id;
  b.setAttribute("aria-label", `Show ${id}`);
  return b;
}

function since(isoText, nowIso) {
  if (!isoText) return "";
  const s = Math.max(0, Math.round((new Date(nowIso) - new Date(isoText)) / 1000));
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

function clockTime(isoText) {
  if (!isoText) return "—";
  return new Date(isoText).toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---- Open gates: one line per gate above «Your turn»; hidden when there is none --------------------------------

function renderGates(gates) {
  const list = Array.isArray(gates) ? gates : [];
  gatesBox.hidden = !list.length;
  const frag = document.createDocumentFragment();
  const nowIso = new Date().toISOString();
  for (const g of list) {
    const li = el("li", "gate");
    li.appendChild(detailButton(g.flow, g.item_id));
    li.appendChild(idWithLinks({ id: g.item_id, links: g.links }, "gate-id"));
    li.appendChild(el("span", "gate-phase", `${g.flow} · ${g.phase}`));
    li.appendChild(el("span", "gate-q", g.question || "(no question)"));
    const age = el("span", "gate-age", `open for ${since(g.opened_at, nowIso)}`);
    age.setAttribute("title", `opened ${clockTime(g.opened_at)}`);
    li.appendChild(age);
    frag.appendChild(li);
  }
  gatesList.replaceChildren(frag);
}

// ---- «Your turn»: what `wip state --attention` lists -------------------------------------------------------------

function renderTetoca(items) {
  const frag = document.createDocumentFragment();
  if (!items?.length) frag.appendChild(el("li", "muted", "nothing waits on you"));
  for (const t of items || []) {
    const li = el("li");
    li.appendChild(detailButton(t.flow, t.id));
    const strong = el("strong");
    strong.appendChild(idWithLinks(t));
    li.appendChild(strong);
    li.appendChild(document.createTextNode(` · ${t.flow} · ${t.phase}`));
    if (t.title) li.appendChild(document.createTextNode(` · ${t.title}`));
    for (const q of t.questions) li.appendChild(el("div", null, `✋ ${q}`));
    if (t.next) li.appendChild(el("div", "next", `→ ${t.next}`));
    frag.appendChild(li);
  }
  envTetoca.replaceChildren(frag);
}

// ---- Footer: polling ---------------------------------------------------------------------------------------------

function pollAgo(isoText) {
  return `${ago(Date.parse(isoText))} ago`;
}

function pollIn(isoText) {
  const ms = Date.parse(isoText) - Date.now();
  if (ms <= 0) return "now";
  const s = Math.round(ms / 1000);
  return s < 120 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
}

// One summary line when some flow declares polling, then a row per overdue and per due poll. Nothing otherwise.
function renderPolling(polling) {
  const polls = Array.isArray(polling?.polls) ? polling.polls : [];
  envPolling.hidden = !polls.length;
  if (!polls.length) {
    envPolling.replaceChildren();
    return;
  }
  const label = (p) => `${p.flow}/${p.poll}`;
  const ran = polls.filter((p) => p.last_run).sort((a, b) => b.last_run.localeCompare(a.last_run));
  const next = polls
    .filter((p) => p.applies && p.next_at)
    .sort((a, b) => a.next_at.localeCompare(b.next_at));
  const last = ran.length
    ? `last pass ${pollAgo(ran[0].last_run)} (${label(ran[0])})`
    : "no pass yet";
  const upcoming = next.length
    ? `next ${pollIn(next[0].next_at)} (${label(next[0])})`
    : "nothing to check";
  const frag = document.createDocumentFragment();
  frag.appendChild(el("span", "foot-poll", `⟳ Polling · ${last} · ${upcoming}`));
  for (const p of polls.filter((x) => x.status === "overdue")) {
    const when = p.last_run ? `last ${pollAgo(p.last_run)}` : "never run";
    frag.appendChild(el("span", "foot-poll foot-overdue", `OVERDUE ${label(p)} · ${when}`));
  }
  for (const p of polls.filter((x) => x.status === "due")) {
    const when = p.last_run ? `last ${pollAgo(p.last_run)}` : "never run";
    frag.appendChild(el("span", "foot-poll", `DUE ${label(p)} · ${when}`));
  }
  envPolling.replaceChildren(frag);
}

// ---- Footer: scheduled ------------------------------------------------------------------------------------------

// «Scheduled»: the open crons and the next pass of each flow poll in the next 7 days, earliest first. Hidden when empty.
function renderScheduled(crons) {
  const list = Array.isArray(crons) ? crons : [];
  envScheduled.hidden = !list.length;
  if (!list.length) {
    envScheduled.replaceChildren();
    return;
  }
  const frag = document.createDocumentFragment();
  frag.appendChild(el("span", "foot-poll", `⏰ Scheduled · ${list.length}`));
  for (const j of list.slice(0, 8)) {
    const what =
      j.kind === "reminder"
        ? j.text
        : `${j.flow}/${j.poll}${j.source === "flow" ? " · next pass" : ""}${j.text ? ` · ${j.text}` : ""}`;
    const tag = j.due ? "DUE " : "";
    const item = j.item ? ` · ${j.item}` : "";
    const row = el(
      "span",
      j.due ? "foot-poll foot-due" : "foot-poll",
      `${tag}${cronTime(j.at)} · ${j.id ? `${j.id} · ` : ""}${what}${item}`,
    );
    frag.appendChild(row);
  }
  if (list.length > 8) frag.appendChild(el("span", "foot-poll muted", `… ${list.length - 8} more`));
  envScheduled.replaceChildren(frag);
}

// ---- Footer: running agents --------------------------------------------------------------------------------------

function renderAgents(running) {
  const frag = document.createDocumentFragment();
  const list = Array.isArray(running) ? running : [];
  const nowIso = new Date().toISOString();
  if (!list.length) frag.appendChild(el("span", "muted", "no running agents"));
  else {
    const label = list.length === 1 ? "running agent" : "running agents";
    frag.appendChild(el("strong", "foot-count", `▶ ${list.length} ${label}`));
  }
  for (const a of list) {
    const row = el("span", "foot-run");
    const b = el("button", "linkish", a.item_id);
    b.type = "button";
    b.dataset.flow = a.flow;
    b.dataset.open = a.item_id;
    row.appendChild(b);
    const handle = a.handle ? ` (${a.handle})` : "";
    const took = since(a.started_at, nowIso);
    row.appendChild(document.createTextNode(` · ${a.agent}${handle} · ${a.phase} · ${took}`));
    frag.appendChild(row);
  }
  envAgents.replaceChildren(frag);
  envAgents.classList.toggle("muted", !list.length);
}

// ---- Item panel ---------------------------------------------------------------------------------------------------

function copyButton(value, label) {
  const text = label || "copy";
  const b = el("button", "btn btn--small", text);
  b.type = "button";
  b.setAttribute("title", `Copy: ${value}`);
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await WipMd.copyText(value);
    b.textContent = ok ? "copied" : "could not copy";
    setTimeout(() => {
      b.textContent = text;
    }, 1500);
  });
  return b;
}

function kv(parent, key, value, copy) {
  const row = el("div", "kv");
  row.appendChild(el("span", "k", key));
  if (value === null || value === undefined || value === "") {
    row.appendChild(el("span", "v muted", "—"));
  } else if (value instanceof Node) {
    row.appendChild(value);
  } else {
    row.appendChild(el("code", "v", String(value)));
    if (copy) row.appendChild(copyButton(String(value)));
  }
  parent.appendChild(row);
}

function section(title) {
  const s = el("section", "psec");
  s.appendChild(el("h3", null, title));
  return s;
}

function duration(seconds) {
  if (seconds === null || seconds === undefined) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

// Short age of an artifact: "now", "5 min ago", "2 h ago" (same day), "yesterday 14:30", else the date.
function artAge(isoText, now) {
  const d = new Date(isoText);
  if (!isoText || Number.isNaN(d.getTime())) return "";
  const min = Math.max(0, Math.floor((now - d) / 60000));
  if (min < 1) return "now";
  if (min < 60) return `${min} min ago`;
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86400000);
  if (days <= 0) return `${Math.floor(min / 60)} h ago`;
  if (days === 1) return `yesterday ${hm}`;
  return clockTime(isoText);
}

function panelState(data) {
  const item = data.item;
  const head = section("State");
  if (item.title) head.appendChild(el("p", "title", item.title));
  kv(head, "phase", item.phase);
  kv(head, "waiting on", item.waiting_on || "none");
  if (item.next) kv(head, "next", item.next);
  kv(head, "status", item.status + (item.archived_at ? ` · ${clockTime(item.archived_at)}` : ""));
  for (const [k, v] of Object.entries(item.fields || {})) {
    if (k !== "title") kv(head, k, Array.isArray(v) ? v.join(", ") : v);
  }
  if (data.signals.incoherent.length) {
    kv(head, "incoherent", el("span", "incoherent", incoherentTitle(data.signals.incoherent)));
  }
  return head;
}

function panelTotals(t) {
  const tot = section("Totals");
  tot.dataset.panel = "totals";
  const agents = duration(t.agent_seconds) || "0s";
  const waiting = duration(t.user_wait_seconds) || "0s";
  tot.appendChild(el("p", "big", `agents ${agents} · waiting on you ${waiting}`));
  tot.appendChild(el("p", "muted", `${t.runs} runs (${t.running} running) · ${t.gates} gates`));
  return tot;
}

// The only section that moves when nothing but the clock changed: swap it without touching the rest of the panel.
function updatePanelTotals(totals) {
  const old = panelBody.querySelector('[data-panel="totals"]');
  if (old) old.replaceWith(panelTotals(totals));
}

function panelLinks(data) {
  const links = section("Links");
  const seen = new Set();
  const rows = [];
  for (const l of [...(data.links || []), ...(data.field_links || [])]) {
    if (!l || typeof l.url !== "string" || seen.has(l.url)) continue;
    seen.add(l.url);
    rows.push(l);
  }
  if (!rows.length) links.appendChild(el("p", "muted", "none"));
  for (const l of rows) {
    const a = link(l.label, l.url);
    a.setAttribute("title", `${l.source}: ${l.url}`);
    kv(links, l.source, a);
  }
  kv(links, "artifacts", data.item.artifact_dir, true);
  return links;
}

function panelArtifacts(data) {
  const item = data.item;
  const arts = section(`Artifacts (${data.artifacts.length})`);
  if (!data.artifacts.length) arts.appendChild(el("p", "muted", "none"));
  const list = el("ul", "arts");
  const artNow = Date.now();
  // Newest first by modification time (name breaks ties).
  const sorted = data.artifacts
    .slice()
    .sort(
      (x, y) =>
        (Date.parse(y.mtime) || 0) - (Date.parse(x.mtime) || 0) || x.name.localeCompare(y.name),
    );
  for (const a of sorted) {
    const li = el("li");
    li.dataset.art = a.name;
    const open = el("button", "linkish", a.name);
    open.type = "button";
    open.dataset.artifact = a.name;
    open.setAttribute("title", `Show here (${a.size} bytes · ${clockTime(a.mtime)})`);
    li.appendChild(open);
    const raw = el("a", "small", "open");
    raw.setAttribute("href", WipMd.artifactViewUrl(item.flow, item.id, a.name));
    raw.setAttribute("title", "Open in another tab");
    raw.setAttribute("target", "_blank");
    raw.setAttribute("rel", "noopener");
    li.appendChild(raw);
    li.appendChild(copyButton(a.path, "copy path"));
    const age = el("span", "art-age", artAge(a.mtime, artNow));
    age.setAttribute("title", clockTime(a.mtime));
    li.appendChild(age);
    if (viewer && viewer.name === a.name) {
      const box = el("div", "viewer");
      li.appendChild(box);
      paintViewer(box);
    }
    list.appendChild(li);
  }
  arts.appendChild(list);
  return arts;
}

function runTook(r) {
  if (r.duration_s !== null && r.duration_s !== undefined) return duration(r.duration_s);
  return r.status === "running" ? "running" : "";
}

function panelRuns(data) {
  const runs = section(`Agents (${data.agent_runs.length})`);
  const rl = el("ul", "timeline");
  for (const r of data.agent_runs.slice().reverse()) {
    const li = el("li");
    li.appendChild(el("span", "ts", clockTime(r.started_at)));
    li.appendChild(el("span", "tag", r.phase));
    li.appendChild(el("strong", null, r.agent));
    const took = runTook(r);
    const tail = `${took ? ` · ${took}` : ""}${r.summary ? ` · ${r.summary}` : ""}`;
    li.appendChild(document.createTextNode(` · ${r.status}${tail}`));
    rl.appendChild(li);
  }
  if (!data.agent_runs.length) runs.appendChild(el("p", "muted", "none"));
  runs.appendChild(rl);
  return runs;
}

function panelGates(data) {
  const gates = section(`Gates (${data.gates.length})`);
  const gl = el("ul", "timeline");
  for (const g of data.gates.slice().reverse()) {
    const li = el("li", g.closed_at ? null : "open-gate");
    li.appendChild(el("span", "ts", clockTime(g.opened_at)));
    li.appendChild(el("span", "tag", g.phase));
    const answer = g.closed_at
      ? `closed ${clockTime(g.closed_at)}${g.answer ? ` · ${g.answer}` : ""}`
      : "open";
    li.appendChild(document.createTextNode(answer + (g.question ? ` · ${g.question}` : "")));
    gl.appendChild(li);
  }
  if (!data.gates.length) gates.appendChild(el("p", "muted", "none"));
  gates.appendChild(gl);
  return gates;
}

function panelLog(data) {
  const log = section(`Timeline (${data.events.length} events)`);
  const ll = el("ul", "timeline");
  let phase = null;
  for (const e of data.events.slice().reverse()) {
    if (e.phase !== phase) {
      phase = e.phase;
      ll.appendChild(el("li", "phase-sep", phase || "—"));
    }
    const li = el("li", `ev ev--${e.kind}`);
    li.appendChild(el("span", "ts", clockTime(e.ts)));
    li.appendChild(el("span", "tag", e.kind));
    li.appendChild(document.createTextNode(e.text || ""));
    ll.appendChild(li);
  }
  log.appendChild(ll);
  return log;
}

// The preview scrolls inside its own <pre> (max-height: 50vh, app.css); the panel repaint replaces it.
function capturePanelScroll() {
  const pre = panelBody.querySelector(".arts .viewer pre");
  return { panel: panelBody.scrollTop, viewer: pre ? pre.scrollTop : 0 };
}

function restorePanelScroll(scroll) {
  panelBody.scrollTop = scroll.panel;
  const pre = panelBody.querySelector(".arts .viewer pre");
  if (pre) pre.scrollTop = scroll.viewer;
}

// The only clock-derived field of the item view: an open gate's wait grows on every poll and must not repaint.
function panelKey(data) {
  return JSON.stringify({ ...data, totals: { ...data.totals, user_wait_seconds: 0 } });
}

function renderPanel(data) {
  const scroll = capturePanelScroll();
  panelTitle.replaceChildren();
  panelTitle.appendChild(idWithLinks({ id: data.item.id, links: data.links }));
  panelTitle.appendChild(el("span", "muted", ` · ${data.item.flow}`));
  const frag = document.createDocumentFragment();
  frag.appendChild(panelState(data));
  frag.appendChild(panelTotals(data.totals));
  frag.appendChild(panelLinks(data));
  frag.appendChild(panelArtifacts(data));
  frag.appendChild(panelRuns(data));
  frag.appendChild(panelGates(data));
  frag.appendChild(panelLog(data));
  panelBody.replaceChildren(frag);
  restorePanelScroll(scroll);
}

// The preview box inside the artifact's row (li[data-art]); any other preview box goes first.
function viewerBox() {
  for (const v of panelBody.querySelectorAll(".arts .viewer")) v.remove();
  if (!viewer) return null;
  const row = panelBody.querySelector(`.arts li[data-art="${CSS.escape(viewer.name)}"]`);
  if (!row) return null;
  const box = el("div", "viewer");
  row.appendChild(box);
  return box;
}

function paintViewer(box) {
  const target = box || viewerBox();
  if (!target || !viewer) return;
  const head = el("div", "viewer-head");
  head.appendChild(el("strong", null, viewer.name));
  const close = el("button", "btn btn--small", "close");
  close.type = "button";
  close.addEventListener("click", () => {
    viewer = null;
    target.remove();
  });
  if (viewer.notice) head.appendChild(el("span", "viewer-notice", viewer.notice));
  head.appendChild(close);
  // The panel repaints on every change: the highlighted tree is built once and cloned.
  const body = viewer.md ? viewer.md.cloneNode(true) : el("pre", null, viewer.text);
  target.replaceChildren(head, body);
}

async function showArtifact(name) {
  if (!openRef) return;
  viewer = await WipMd.loadPreview(openRef.flow, openRef.id, name);
  paintViewer();
}

function setViewerNotice(notice) {
  if (!viewer) return;
  const shown = viewer;
  shown.notice = notice;
  const scroll = capturePanelScroll();
  paintViewer();
  restorePanelScroll(scroll);
  setTimeout(() => {
    if (shown.notice !== notice) return;
    shown.notice = null;
    if (viewer === shown) {
      const later = capturePanelScroll();
      paintViewer();
      restorePanelScroll(later);
    }
  }, WipMd.NOTICE_MS);
}

function itemUrl(ref) {
  return `/api/item/${encodeURIComponent(ref.flow)}/${encodeURIComponent(ref.id)}`;
}

async function loadPanel() {
  clearTimeout(panelTimer);
  const ref = openRef;
  if (!ref) return;
  try {
    const res = await fetch(itemUrl(ref), {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!sameRef(ref, openRef)) return;
    if (res.ok) {
      const text = await res.text();
      const data = JSON.parse(text);
      const key = panelKey(data);
      if (key !== panelText) {
        renderPanel(data);
        panelText = key;
      } else if (text !== panelRaw) {
        updatePanelTotals(data.totals);
      }
      panelRaw = text;
    } else {
      panelText = null;
      panelRaw = null;
      panelTitle.textContent = ref.id;
      const why =
        res.status === 404 ? `No item ${ref.id} in ${ref.flow}.` : `HTTP error ${res.status}`;
      panelBody.replaceChildren(el("p", "muted", why));
    }
  } catch (_) {
    // keep the last panel; the next round retries
  }
  if (sameRef(ref, openRef)) panelTimer = setTimeout(loadPanel, POLL_MS);
}

function setItemParam(ref) {
  try {
    const url = new URL(window.location.href);
    if (ref) url.searchParams.set("item", refKey(ref.flow, ref.id));
    else url.searchParams.delete("item");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch (_) {
    // keep the URL
  }
}

function markOpenCard() {
  for (const c of board.querySelectorAll(".card")) {
    c.classList.toggle("card--open", sameRef(openRef, c.dataset));
  }
  for (const r of historyRows.querySelectorAll(".hrow")) {
    r.classList.toggle("row--open", sameRef(openRef, r.dataset));
  }
}

function openPanel(flow, id) {
  if (!flow || !id) return;
  const ref = { flow, id };
  if (!sameRef(ref, openRef)) {
    viewer = null;
    panelText = null;
    panelRaw = null;
    panelTitle.textContent = id;
    panelBody.replaceChildren(el("p", "muted", "loading…"));
  }
  openRef = ref;
  panel.hidden = false;
  document.body.classList.add("with-panel");
  setItemParam(ref);
  markOpenCard();
  loadPanel();
  panelClose.focus();
}

function closePanel() {
  if (!openRef) return;
  const ref = openRef;
  openRef = null;
  clearTimeout(panelTimer);
  panel.hidden = true;
  document.body.classList.remove("with-panel");
  setItemParam(null);
  markOpenCard();
  const scope = view === "history" ? historyRows : board;
  const card = scope.querySelector(
    `[data-flow="${CSS.escape(ref.flow)}"][data-id="${CSS.escape(ref.id)}"]`,
  );
  const hidden = card?.closest(".stages[hidden]");
  if (card && !hidden) {
    card.focus();
    return;
  }
  if (hidden && view !== "history") {
    const toggle = board.querySelector(`[data-flow-toggle="${CSS.escape(ref.flow)}"]`);
    if (toggle) toggle.focus();
  }
}

board.addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-flow-toggle]");
  if (toggle) {
    const name = toggle.dataset.flowToggle;
    setCollapsed(name, !collapsed.has(name));
    return;
  }
  if (e.target.closest("a")) return;
  const c = e.target.closest(".card[data-id]");
  if (c) openPanel(c.dataset.flow, c.dataset.id);
});
board.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const c = e.target.closest(".card[data-id]");
  if (c && e.target === c) {
    e.preventDefault();
    openPanel(c.dataset.flow, c.dataset.id);
  }
});
document.body.addEventListener("click", (e) => {
  if (!e.target.closest("#gates, #env, #foot")) return;
  const b = e.target.closest("[data-open]");
  if (b) openPanel(b.dataset.flow, b.dataset.open);
});
panelBody.addEventListener("click", (e) => {
  const b = e.target.closest("[data-artifact]");
  if (b) showArtifact(b.dataset.artifact);
  // A plain click never navigates: the preview is for reading and selecting.
  if ((e.metaKey || e.ctrlKey) && e.target.closest(".viewer pre.md") && viewer) {
    WipMd.openLink(e, viewer, setViewerNotice);
  }
});
WipMd.trackModKey();
panelClose.addEventListener("click", closePanel);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openRef) closePanel();
});

// ---- History: every item of every flow (/api/history), newest first -----------------------------------------------

function initialInclude() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || "null");
    if (stored && HISTORY_INCLUDE.every((k) => typeof stored[k] === "boolean")) {
      return { active: stored.active, archived: stored.archived, discarded: stored.discarded };
    }
  } catch (_) {
    // no storage or bad JSON
  }
  return { ...HISTORY_DEFAULT };
}

function historyUrl() {
  const include = HISTORY_INCLUDE.filter((k) => hist.include[k]);
  if (!include.length) return null;
  const p = new URLSearchParams();
  if (hist.flow) p.set("flow", hist.flow);
  if (hist.q) p.set("q", hist.q);
  p.set("include", include.join(","));
  p.set("limit", String(HISTORY_PAGE));
  p.set("offset", String(hist.offset));
  return `/api/history?${p.toString()}`;
}

function longTime(isoText) {
  if (!isoText) return "—";
  return new Date(isoText).toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function messageRow(text) {
  const tr = el("tr");
  const td = el("td", "muted", text);
  td.colSpan = 6;
  tr.appendChild(td);
  return tr;
}

const ROW_CLASS = { active: " hrow--active", archived: "", discarded: " hrow--discarded" };

function historyRow(h) {
  const tr = el("tr", `hrow${ROW_CLASS[h.category] || ""}`);
  tr.dataset.flow = h.flow;
  tr.dataset.id = h.id;
  tr.tabIndex = 0;
  tr.setAttribute("role", "button");
  tr.setAttribute("aria-label", `${h.id}: details`);
  if (sameRef(openRef, h)) tr.classList.add("row--open");
  tr.appendChild(el("td", "hid", h.id));
  tr.appendChild(el("td", null, h.flow));
  tr.appendChild(el("td", "htitle", h.title || "—"));
  const phase = el("td");
  if (h.category === "active") {
    paintStage(tr, h);
    phase.appendChild(el("span", "hphase", h.phase));
  } else {
    phase.textContent = h.phase + (h.category === "discarded" ? " · discarded" : "");
  }
  tr.appendChild(phase);
  const date = el("td", "hdate", longTime(h.date));
  date.setAttribute("title", (h.category === "active" ? "last activity " : "archived ") + h.date);
  tr.appendChild(date);
  const links = el("td");
  if (!h.links.length) links.appendChild(el("span", "muted", "—"));
  for (const l of h.links) {
    links.appendChild(link(l.label, l.url));
    links.appendChild(document.createTextNode(" "));
  }
  tr.appendChild(links);
  return tr;
}

function renderHistory(data) {
  const names = data.flows.join(",");
  if (names !== historyFlows) {
    const opts = document.createDocumentFragment();
    for (const [value, text] of [["", "all"], ...data.flows.map((f) => [f, f])]) {
      const o = el("option", null, text);
      o.value = value;
      opts.appendChild(o);
    }
    historyFlow.replaceChildren(opts);
    historyFlows = names;
  }
  historyFlow.value = hist.flow;
  const frag = document.createDocumentFragment();
  for (const h of data.items) frag.appendChild(historyRow(h));
  if (!data.items.length) frag.appendChild(messageRow("No item matches these filters."));
  historyRows.replaceChildren(frag);
  const to = data.offset + data.items.length;
  historyCount.textContent = `${data.items.length ? data.offset + 1 : 0}–${to} of ${data.total}`;
  historyPrev.disabled = data.offset === 0;
  historyNext.disabled = to >= data.total;
}

async function loadHistory() {
  const url = historyUrl();
  if (!url) {
    historyText = null;
    historyRows.replaceChildren(messageRow("Tick at least one box."));
    historyCount.textContent = "";
    historyPrev.disabled = true;
    historyNext.disabled = true;
    return;
  }
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (url !== historyUrl()) return; // the filters changed meanwhile: that request repaints
    if (!res.ok) {
      historyText = null;
      historyRows.replaceChildren(messageRow(`HTTP error ${res.status}`));
      return;
    }
    const text = await res.text();
    if (text === historyText) return;
    historyText = text;
    renderHistory(JSON.parse(text));
  } catch (_) {
    // the status line already says «offline»
  }
}

function historyChanged(patch) {
  Object.assign(hist, patch);
  loadHistory();
}

historyRows.addEventListener("click", (e) => {
  if (e.target.closest("a")) return;
  const r = e.target.closest(".hrow[data-id]");
  if (r) openPanel(r.dataset.flow, r.dataset.id);
});
historyRows.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const r = e.target.closest(".hrow[data-id]");
  if (r && e.target === r) {
    e.preventDefault();
    openPanel(r.dataset.flow, r.dataset.id);
  }
});
document.getElementById("history-filters").addEventListener("submit", (e) => e.preventDefault());
historyFlow.addEventListener("change", () =>
  historyChanged({ flow: historyFlow.value, offset: 0 }),
);
historyQ.addEventListener("input", () => {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => historyChanged({ q: historyQ.value.trim(), offset: 0 }), 300);
});
const includeBoxes = {
  active: historyActive,
  archived: historyArchived,
  discarded: historyDiscarded,
};
for (const [key, box] of Object.entries(includeBoxes)) {
  box.checked = hist.include[key];
  box.addEventListener("change", () => {
    const include = { ...hist.include, [key]: box.checked };
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(include));
    } catch (_) {
      // no storage: the choice lasts until reload
    }
    historyChanged({ include, offset: 0 });
  });
}
historyPrev.addEventListener("click", () =>
  historyChanged({ offset: Math.max(0, hist.offset - HISTORY_PAGE) }),
);
historyNext.addEventListener("click", () => historyChanged({ offset: hist.offset + HISTORY_PAGE }));

// View: ?view= first, then localStorage (grouped or expanded only), else grouped.
function initialView() {
  const fromUrl = new URLSearchParams(window.location.search).get("view");
  if (VIEWS.includes(fromUrl)) return fromUrl;
  try {
    const stored = window.localStorage.getItem(VIEW_KEY);
    if (REMEMBERED_VIEWS.includes(stored)) return stored;
  } catch (_) {
    // no storage
  }
  return "grouped";
}

function setViewParam() {
  try {
    const url = new URL(window.location.href);
    if (view === "grouped") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch (_) {
    // keep the URL
  }
}

function paintView() {
  for (const b of viewButtons) b.setAttribute("aria-pressed", String(b.dataset.view === view));
  board.hidden = view === "history";
  historyBox.hidden = view !== "history";
}

function setView(next) {
  if (!VIEWS.includes(next) || next === view) return;
  view = next;
  if (REMEMBERED_VIEWS.includes(view)) {
    try {
      window.localStorage.setItem(VIEW_KEY, view);
    } catch (_) {
      // no storage
    }
  }
  setViewParam();
  paintView();
  if (view === "history") loadHistory();
  else if (lastData) render(lastData);
}

async function loadProject() {
  try {
    const res = await fetch("/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const health = await res.json();
    const name = String(health.name || "");
    if (name) {
      titleEl.textContent = name;
      document.title = name;
    }
  } catch (_) {
    // keep the default title
  }
}

for (const b of viewButtons) b.addEventListener("click", () => setView(b.dataset.view));
paintView();
setViewParam();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") poll();
});
setInterval(paintStatus, 1000);
loadProject();
poll();
// ?item=<flow>/<ID> opens its panel, so a panel can be linked.
const linked = (new URLSearchParams(window.location.search).get("item") || "").split("/");
if (linked.length === 2) openPanel(linked[0], linked[1]);
