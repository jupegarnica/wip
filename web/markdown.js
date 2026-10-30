// Shared by the item panel (app.js) and the /view page (view.js): fetches an artifact and, for .md, highlights it with
// @garndev/markdown served from /lib/garndev-markdown/. The highlighter's HTML is parsed inert and only div/span
// with whitelisted classes are rebuilt (mdImport). One IIFE and one global, WipMd: classic scripts share the global
// lexical scope, so a const repeated in app.js would stop it from loading.
// biome-ignore lint/correctness/noUnusedVariables: the global app.js and view.js read
const WipMd = (() => {
  const MD_MODULE = "/lib/garndev-markdown/index.js";
  const MD_MAX_BYTES = 512 * 1024; // above this the highlighter would block the main thread: plain text
  const MD_CLASS_RE = /^(rline|r-[a-z0-9-]+|tok-[a-z0-9-]+)$/;
  const NOTICE_MS = 3000;
  const TIMEOUT_MS = 5000;

  let mdLib = null;
  let mdLoading = null;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const itemPath = (flow, id) => `${encodeURIComponent(flow)}/${encodeURIComponent(id)}`;
  const artifactApiUrl = (flow, id, name) =>
    `/api/item/${itemPath(flow, id)}/artifact/${encodeURIComponent(name)}`;
  const artifactViewUrl = (flow, id, name) =>
    `/view/item/${itemPath(flow, id)}/artifact/${encodeURIComponent(name)}`;

  // Over the LAN the page is plain http (no secure context): navigator.clipboard fails and execCommand is the fallback.
  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {
      const ta = el("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (_) {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  const isMarkdown = (name) => /\.md$/i.test(name);

  function loadMarkdown() {
    if (!mdLoading) {
      mdLoading = import(MD_MODULE).then(
        (lib) => {
          mdLib = lib;
          return lib;
        },
        () => null,
      );
    }
    return mdLoading;
  }

  // Rebuilds the highlighter's HTML from an inert document: only div/span whose sole attribute is a whitelisted class.
  // Anything else and the preview falls back to plain text (null).
  function mdImport(src) {
    if (src.nodeType === Node.TEXT_NODE) return document.createTextNode(src.data);
    if (src.nodeType !== Node.ELEMENT_NODE) return null;
    if (src.tagName !== "DIV" && src.tagName !== "SPAN") return null;
    if (src.attributes.length !== 1 || src.attributes[0].name !== "class") return null;
    const classes = src.getAttribute("class").split(/\s+/).filter(Boolean);
    if (classes.length === 0 || !classes.every((c) => MD_CLASS_RE.test(c))) return null;
    const node = document.createElement(src.tagName.toLowerCase());
    node.className = classes.join(" ");
    for (const child of src.childNodes) {
      const copy = mdImport(child);
      if (!copy) return null;
      node.appendChild(copy);
    }
    return node;
  }

  // Without `width` each div.rline is one document line; with it (columns) the highlighter wraps and each div.rline is
  // one visual line, lineStart[i] being the document offset where lines[i] starts.
  function mdBuild(text, width) {
    if (!mdLib) return null;
    try {
      const { html, lines, realBreaks } = mdLib.highlightDocument(text, width ? { width } : {});
      const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
      const pre = el("pre", "md");
      pre.setAttribute("title", "Cmd/Ctrl+click opens a link");
      for (const child of doc.body.childNodes) {
        const copy = mdImport(child);
        if (copy?.tagName !== "DIV") return null;
        pre.appendChild(copy);
      }
      if (pre.children.length !== lines.length) return null;
      const lineStart = [];
      let at = 0;
      for (let i = 0; i < lines.length; i++) {
        lineStart.push(at);
        at += lines[i].length + (realBreaks[i] || 0);
      }
      return at === text.length ? { pre, lines, lineStart } : null;
    } catch (_) {
      return null;
    }
  }

  function mdNode(text) {
    const built = mdBuild(text);
    return built ? built.pre : null;
  }

  function lineStartsOf(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
    return starts;
  }

  async function loadPreview(flow, id, name) {
    let next;
    try {
      const res = await fetch(artifactApiUrl(flow, id, name), {
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      next = { name, text: res.ok ? await res.text() : `Cannot read it (HTTP ${res.status}).` };
      if (
        res.ok &&
        isMarkdown(name) &&
        next.text.length <= MD_MAX_BYTES &&
        (await loadMarkdown())
      ) {
        next.md = mdNode(next.text);
        if (next.md) {
          next.lineStarts = lineStartsOf(next.text);
          next.refs = mdLib.collectRefs(next.text);
        }
      }
    } catch (_) {
      next = { name, text: "Cannot read it (offline)." };
    }
    return next;
  }

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
    }
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      return range ? { node: range.startContainer, offset: range.startOffset } : null;
    }
    return null;
  }

  // Without `width` each div.rline is exactly one document line, so offset = line start + column.
  function mdOffsetAt(e, preview) {
    const caret = caretAt(e.clientX, e.clientY);
    if (!caret) return null;
    const start = caret.node.nodeType === Node.ELEMENT_NODE ? caret.node : caret.node.parentElement;
    const line = start?.closest("pre.md > .rline");
    if (!line) return null;
    const index = Array.prototype.indexOf.call(line.parentElement.children, line);
    if (index < 0 || !preview.lineStarts || index >= preview.lineStarts.length) return null;
    const range = document.createRange();
    range.setStart(line, 0);
    range.setEnd(caret.node, caret.offset);
    return preview.lineStarts[index] + range.toString().length;
  }

  async function openLink(e, preview, notify) {
    if (!preview?.md || !mdLib) return;
    const offset = mdOffsetAt(e, preview);
    if (offset === null) return;
    const url = mdLib.linkAtOffset(preview.text, offset, preview.refs);
    if (!url) return;
    e.preventDefault();
    await openUrl(url, notify);
  }

  // http(s) opens in another tab; file:// or an absolute path is copied; any other scheme (javascript:…) is ignored.
  async function openUrl(url, notify) {
    if (/^https?:\/\//i.test(url)) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    if (/^file:\/\//i.test(url) || url.startsWith("/")) {
      let path = url.replace(/^file:\/\//i, "");
      try {
        path = decodeURIComponent(path);
      } catch (_) {
        // malformed escape: copy it as written
      }
      const ok = await copyText(path);
      notify(
        ok ? `path copied: ${path} (browsers do not open file://)` : `could not copy: ${path}`,
      );
    }
  }

  function trackModKey() {
    const markModKey = (e) =>
      document.body.classList.toggle("mod-key", Boolean(e.metaKey || e.ctrlKey));
    window.addEventListener("keydown", markModKey);
    window.addEventListener("keyup", markModKey);
    window.addEventListener("blur", () => document.body.classList.remove("mod-key"));
  }

  // /view: the document is re-highlighted wrapped to the columns that fit (measured grid), so the package's link hover
  // (underline + URL tooltip + Cmd/Ctrl+click) maps the pointer to a document offset. Re-wraps on resize and zoom.
  // Without the package or on any failure the unwrapped preview.md stays, without hover.
  function mountGrid(scroller, preview, notify) {
    if (!preview?.md || !mdLib) return;
    let hover = null;
    let cols = 0;
    let timer = 0;
    function layout() {
      const pre = scroller.querySelector(":scope > pre.md");
      if (!pre) return;
      const grid = mdLib.measureGrid(pre);
      const padRight = parseFloat(getComputedStyle(pre).paddingRight) || 0;
      const next = Math.max(
        20,
        Math.floor((pre.clientWidth - grid.padLeft - padRight) / grid.charWidth),
      );
      if (hover && next === cols) {
        hover.update(grid);
        return;
      }
      const built = mdBuild(preview.text, next);
      if (!built) return;
      built.pre.removeAttribute("title");
      if (hover) hover.destroy();
      pre.replaceWith(built.pre);
      cols = next;
      hover = mdLib.attachLinkHover({
        container: built.pre,
        text: preview.text,
        lines: built.lines,
        lineStart: built.lineStart,
        ...grid,
        onOpen: (url) => openUrl(url, notify),
      });
    }
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(layout, cols ? 100 : 0);
    };
    new ResizeObserver(schedule).observe(scroller);
    window.addEventListener("resize", schedule);
    schedule();
  }

  return {
    NOTICE_MS,
    artifactApiUrl,
    artifactViewUrl,
    copyText,
    loadPreview,
    mountGrid,
    openLink,
    trackModKey,
  };
})();
