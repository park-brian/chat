// The whole page of a same-origin frame, not just its viewport, for run_app's full: true (docs/specs/2026-10-13-capture.md,
// E23). Three ways, each answering a sheet: the page as canvas strips, top to bottom, at one pixel per CSS pixel.
//  - snapshot: the document cloned with its live state frozen, its stylesheets as text and its resources as data URLs,
//    drawn as XHTML in an SVG foreignObject. No permission, no dependency; a re-render, so approximate.
//  - htmlInCanvas: the same frozen clone painted by Chrome itself (HTML-in-Canvas, behind a flag in 2026).
//  - stitch: real pixels from tab capture, scrolled a viewport at a time.
// pagesOf cuts a sheet into pages of up to two viewports, labelled, that a model can read.

const STRIP = 4096;  // a strip's height: well inside every browser's canvas limits
const nextFrame = win => new Promise(resolve => win.requestAnimationFrame(() => resolve()));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const kebab = p => (p.startsWith("--") ? p : p === "cssFloat" ? "float" : p.replace(/[A-Z]/g, c => "-" + c.toLowerCase()));

function canvas(doc, width, height) {
  return Object.assign(doc.createElement("canvas"), { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });
}

// The page's size: its layout width (no scrollbar) and its full scroll height.
function extent(doc) {
  const root = doc.documentElement;
  return { width: root.clientWidth || 1, height: Math.max(root.scrollHeight, doc.body?.scrollHeight ?? 0, root.clientHeight) || 1 };
}

// What paints behind the page where the root has nothing: the root's background, else the body's (it propagates).
function backgroundOf(doc) {
  const win = doc.defaultView, clear = c => !c || c === "transparent" || /^rgba\(.*,\s*0\)$/.test(c);
  const root = win.getComputedStyle(doc.documentElement).backgroundColor, body = doc.body && win.getComputedStyle(doc.body).backgroundColor;
  return !clear(root) ? root : !clear(body) ? body : "#ffffff";
}

// Strips drawn by paint(ctx, top, height); a sheet keeps them in order.
async function stripsOf(doc, width, height, background, paint) {
  const strips = [];
  for (let top = 0; top < height; top += STRIP) {
    const c = canvas(doc, width, Math.min(STRIP, height - top)), ctx = c.getContext("2d");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, c.width, c.height);
    await paint(ctx, top, c.height);
    strips.push({ top, canvas: c });
  }
  return { width, height, strips };
}

// Draws rows [top, top + height) of a sheet into ctx at (0, y), scaled by k.
export function drawRows(sheet, ctx, top, height, y = 0, k = 1) {
  for (const s of sheet.strips) {
    const from = Math.max(top, s.top), to = Math.min(top + height, s.top + s.canvas.height);
    if (to > from) ctx.drawImage(s.canvas, 0, from - s.top, sheet.width, to - from, 0, y + (from - top) * k, sheet.width * k, (to - from) * k);
  }
}

// One canvas of the whole sheet (for comparing; pagesOf never needs it).
export function flatten(sheet, doc = document) {
  const c = canvas(doc, sheet.width, sheet.height);
  drawRows(sheet, c.getContext("2d"), 0, sheet.height);
  return c;
}

// Pages for a model: each up to two viewports tall, split evenly so the last isn't a sliver, at most `widest` pixels
// wide (text stays readable; one tall strip scaled to fit would not be), with a band on top saying which page it is.
export function pagesOf(sheet, viewportHeight, { widest = 1024, doc = document } = {}) {
  const count = Math.max(1, Math.ceil(sheet.height / (2 * Math.max(1, viewportHeight))));
  const each = Math.ceil(sheet.height / count), k = Math.min(1, widest / sheet.width), band = 24;
  return Array.from({ length: count }, (_, i) => {
    const top = i * each, rows = Math.min(each, sheet.height - top);
    const label = `page ${i + 1} of ${count}`;
    const c = canvas(doc, sheet.width * k, rows * k + band), ctx = c.getContext("2d");
    ctx.fillStyle = "#3a3a3a";
    ctx.fillRect(0, 0, c.width, band);
    ctx.fillStyle = "#ffffff";
    ctx.font = "14px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(`${label}  (page rows ${top}-${top + rows} of ${sheet.height} px)`, 8, band / 2);
    drawRows(sheet, ctx, top, rows, band, k);
    return { canvas: c, label, top, rows, count };
  });
}

// #region Freezing a document

// Each <canvas> and <video> as an image of its current frame. Read in the frame after next: by then the page's own
// frame callback has drawn (it was asked for first), and a WebGL buffer is still whole until the frame is presented.
async function frameImages(doc) {
  const win = doc.defaultView, els = [...doc.querySelectorAll("canvas, video")];
  const out = new Map();
  if (!els.length) return out;
  await Promise.race([new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve))), sleep(200)]);
  for (const el of els) {
    try {
      if (el.tagName === "CANVAS") {
        // Empty is either drawn so or unreadable: a WebGL canvas without preserveDrawingBuffer drawn in an earlier
        // frame reads back empty however it is read (toDataURL, drawImage, createImageBitmap all did in E23).
        const url = el.toDataURL();
        if (el.width * el.height && url === canvas(doc, el.width, el.height).toDataURL()) out.blank = [...(out.blank ?? []), el];
        out.set(el, url);
      }
      else if (el.videoWidth) {
        const c = canvas(doc, el.videoWidth, el.videoHeight);
        c.getContext("2d").drawImage(el, 0, 0);
        out.set(el, c.toDataURL());
      }
    } catch { /* tainted: left as it is, so it renders empty */ }
  }
  return out;
}

const readAsDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// url -> data URL, fetched once per capture; one that fails stays a URL (and renders as missing).
function inliner() {
  const seen = new Map();
  return url => {
    if (!url || /^(data|blob|about|javascript):/i.test(url) || url.startsWith("#")) return Promise.resolve(url);
    if (!seen.has(url)) seen.set(url, fetch(url).then(r => (r.ok ? r.blob() : Promise.reject())).then(readAsDataUrl).catch(() => url));
    return seen.get(url);
  };
}

// Every url(...) in css, resolved against base, then mapped (to a data URL) when map is given.
async function rewriteUrls(css, base, map) {
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g, found = [...css.matchAll(re)];
  if (!found.length) return css;
  const abs = u => { try { return u.startsWith("#") ? u : new URL(u, base).href; } catch { return u; } };
  const done = await Promise.all(found.map(m => (map ? map(abs(m[2])) : abs(m[2]))));
  let i = 0;
  return css.replace(re, (m, q, u) => (u.startsWith("#") ? (i++, m) : `url("${done[i++]}")`));
}

// The clone is laid out in a viewport as tall as the page, where 100vh would be the whole page: viewport heights
// become the live viewport's pixels, as in Playwright's full-page capture (60vh hero stays 60% of a screen).
function fixViewport(css, vw, vh) {
  const unit = { vh: vh / 100, vmin: Math.min(vw, vh) / 100, vmax: Math.max(vw, vh) / 100 };
  return css.replace(/(-?\d*\.?\d+)[sld]?(vh|vmin|vmax)\b/g, (_, n, u) => `${+(n * unit[u]).toFixed(3)}px`);
}

// State selectors become attributes the freeze puts where the state is, so the clone shows what the page did.
const STATES = /:(focus-visible|focus-within|hover|focus|active)(?![\w-])/g;
const stateAttr = s => `[data-snap-${s}]`;

async function sheetText(doc, map) {
  const parts = [];
  const rulesOf = async (sheet, base) => {
    let rules;
    try { rules = [...sheet.cssRules]; }
    catch {
      // A cross-origin sheet (a CDN's) can't be read in the CSSOM; its text can be fetched.
      const text = sheet.href ? await fetch(sheet.href).then(r => r.text()).catch(() => "") : "";
      return rewriteUrls(text, sheet.href, map);
    }
    const out = [];
    for (const r of rules) out.push(r.styleSheet ? await rulesOf(r.styleSheet, r.styleSheet.href || base) : await rewriteUrls(r.cssText, base, map));
    return out.join("\n");
  };
  for (const sheet of [...doc.styleSheets, ...(doc.adoptedStyleSheets ?? [])]) {
    if (sheet.disabled) continue;
    const text = await rulesOf(sheet, sheet.href || doc.baseURI);
    const media = sheet.media?.mediaText;
    parts.push(media && media !== "all" ? `@media ${media} {\n${text}\n}` : text);
  }
  return parts.join("\n").replace(STATES, (_, s) => stateAttr(s));
}

// A fixed element inside a transformed (or filtered, or contained) ancestor is positioned by it, and scrolls with it.
const holdsFixed = s => s.transform !== "none" || s.filter !== "none" || s.perspective !== "none" || /paint|layout|strict|content/.test(s.contain) || /transform|filter/.test(s.willChange);
function containedFixed(el, win) {
  for (let p = el.parentElement; p && p !== el.ownerDocument.documentElement; p = p.parentElement) if (holdsFixed(win.getComputedStyle(p))) return true;
  return false;
}
// What an absolutely positioned element is placed against: the nearest positioned ancestor, else the page.
function positionedAncestor(el, win) {
  for (let p = el.parentElement; p && p !== el.ownerDocument.documentElement; p = p.parentElement) if (win.getComputedStyle(p).position !== "static") return p;
  return null;
}

// The document as markup that renders as it looks now: no scripts, each canvas and video as its frame, form values
// as attributes, animations stopped where they are, hover and focus as attributes the rewritten CSS selects,
// scrolled boxes shifted by their scroll. inline: resources become data URLs (an SVG image loads nothing).
export async function freeze(doc, { inline = false } = {}) {
  const win = doc.defaultView, root = doc.documentElement;
  // Lazy images below the fold load now, as a scroll would load them: one without a size grows the page.
  const pending = [...doc.images].filter(img => !img.complete);
  pending.forEach(img => { if (img.loading === "lazy") img.loading = "eager"; });
  if (pending.length) await Promise.race([Promise.all(pending.map(img => img.decode().catch(() => {}))), sleep(3000)]);
  const { width, height } = extent(doc), background = backgroundOf(doc);
  const map = inline ? inliner() : null;
  const frames = await frameImages(doc);
  const live = [root, ...root.querySelectorAll("*")];
  const copy = root.cloneNode(true), clone = [copy, ...copy.querySelectorAll("*")];
  const ids = new Map(), rules = [];
  const idOf = i => { if (!ids.has(i)) { ids.set(i, String(ids.size + 1)); clone[i].setAttribute("data-snap", ids.get(i)); } return `[data-snap="${ids.get(i)}"]`; };
  const index = new Map(live.map((el, i) => [el, i]));

  // Animations, CSS and scripted: each animated property as it is at this moment, the animation itself off.
  for (const a of doc.getAnimations()) {
    const target = a.effect?.target, i = index.get(target);
    if (i == null) continue;
    const pseudo = a.effect.pseudoElement ?? "";
    const props = new Set(a.effect.getKeyframes().flatMap(k => Object.keys(k)).filter(p => !["offset", "computedOffset", "easing", "composite"].includes(p)));
    const style = win.getComputedStyle(target, pseudo || null);
    const decls = [...props].map(kebab).map(p => `${p}: ${style.getPropertyValue(p)} !important;`).join(" ");
    rules.push(`${idOf(i)}${pseudo} { ${decls} animation: none !important; transition: none !important; }`);
  }
  // Hover and focus, and the focus ring the browser draws (its own stylesheet's, which the text below lacks).
  for (const el of doc.querySelectorAll(":hover")) clone[index.get(el)]?.setAttribute("data-snap-hover", "");
  const focused = doc.activeElement !== doc.body && doc.activeElement !== root ? doc.activeElement : null;
  if (focused && index.has(focused)) {
    const i = index.get(focused);
    clone[i].setAttribute("data-snap-focus", "");
    if (focused.matches(":focus-visible")) {
      clone[i].setAttribute("data-snap-focus-visible", "");
      const s = win.getComputedStyle(focused);
      rules.push(`${idOf(i)} { outline: ${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} !important; outline-offset: ${s.outlineOffset} !important; }`);
    }
    for (let p = focused; p; p = p.parentElement) clone[index.get(p)]?.setAttribute("data-snap-focus-within", "");
  }

  const drop = [], jobs = [];
  for (let i = 0; i < live.length; i++) {
    const el = live[i], c = clone[i], tag = el.tagName;
    if (tag === "SCRIPT" || tag === "NOSCRIPT" || (tag === "LINK" && /stylesheet/i.test(el.rel)) || tag === "STYLE" || tag === "BASE") { drop.push(c); continue; }
    for (const a of [...c.attributes]) if (/^on/i.test(a.name)) c.removeAttribute(a.name);
    // A canvas or video stays itself, so the page's selectors still find it, painted with its frame: the clone's
    // own bitmap is empty, and a video without a source shows nothing over its background.
    if (tag === "CANVAS" || tag === "VIDEO") {
      if (tag === "VIDEO") { for (const a of ["src", "poster", "autoplay", "controls"]) c.removeAttribute(a); c.replaceChildren(); }
      const fit = tag === "VIDEO" ? ({ cover: "cover", fill: "100% 100%", none: "auto" }[win.getComputedStyle(el).objectFit] ?? "contain") : "100% 100%";
      // Its size as laid out: a cloned canvas, never given a context, lost its width and height attributes' size.
      const cs = win.getComputedStyle(el);
      rules.push(`${idOf(i)} { width: ${cs.width} !important; height: ${cs.height} !important;${frames.has(el) ? ` background: url("${frames.get(el)}") center / ${fit} no-repeat !important;` : ""} }`);
      continue;
    }
    // Fixed, where Playwright's full-page capture puts it: where it is on the first screen, once.
    const s = win.getComputedStyle(el);
    if (s.position === "fixed" && !containedFixed(el, win)) {
      const r = el.getBoundingClientRect(), cb = positionedAncestor(el, win);
      const at = cb ? (b => ({ x: b.left + win.scrollX + cb.clientLeft, y: b.top + win.scrollY + cb.clientTop }))(cb.getBoundingClientRect()) : { x: 0, y: 0 };
      rules.push(`${idOf(i)} { position: absolute !important; left: ${r.left - at.x}px !important; top: ${r.top - at.y}px !important; right: auto !important; bottom: auto !important; width: ${r.width}px !important; height: ${r.height}px !important; box-sizing: border-box !important; margin: 0 !important; transform: none !important; translate: none !important; }`);
    }
    if (tag === "IMG") {
      const src = el.currentSrc || el.src;
      c.removeAttribute("srcset");
      c.removeAttribute("sizes");
      c.removeAttribute("loading");
      if (src) jobs.push((async () => c.setAttribute("src", map ? await map(src) : src))());
    }
    if (tag === "SOURCE" && el.parentElement?.tagName === "PICTURE") drop.push(c);
    if (tag === "IFRAME") c.removeAttribute("srcdoc");
    if (tag === "INPUT") {
      if (/^(checkbox|radio)$/i.test(el.type)) el.checked ? c.setAttribute("checked", "") : c.removeAttribute("checked");
      else if (!/^(file|password)$/i.test(el.type)) c.setAttribute("value", el.value);
      else if (el.type === "password") c.setAttribute("value", "•".repeat(el.value.length));
    }
    if (tag === "TEXTAREA") c.textContent = el.value;
    if (tag === "SELECT") [...el.options].forEach((o, k) => (o.selected ? c.options[k]?.setAttribute("selected", "") : c.options[k]?.removeAttribute("selected")));
    const inlineStyle = c.getAttribute?.("style");
    if (inlineStyle && /v(h|min|max)\b/.test(inlineStyle)) c.setAttribute("style", fixViewport(inlineStyle, width, root.clientHeight));
    if (map && inlineStyle?.includes("url(")) jobs.push((async () => c.setAttribute("style", await rewriteUrls(c.getAttribute("style"), doc.baseURI, map)))());
    if (map && el.namespaceURI === "http://www.w3.org/2000/svg" && tag.toLowerCase() === "image") {
      const href = el.href?.baseVal;
      if (href) jobs.push((async () => c.setAttribute("href", await map(new URL(href, doc.baseURI).href)))());
    }
    // A box scrolled inside the page: what it showed, shifted into place and clipped.
    if (i > 0 && el !== doc.body && (el.scrollTop || el.scrollLeft)) {
      const id = idOf(i);
      rules.push(`${id} { overflow: hidden !important; } ${id} > * { translate: ${-el.scrollLeft}px ${-el.scrollTop}px; }`);
    }
  }
  const css = fixViewport(await sheetText(doc, map), width, root.clientHeight);
  await Promise.all(jobs);
  drop.forEach(c => c.remove());
  const head = copy.querySelector("head") ?? copy.insertBefore(doc.createElement("head"), copy.firstChild);
  const style = doc.createElement("style");
  style.textContent = `${css}\n${rules.join("\n")}`;
  head.append(style);
  const name = el => el.tagName.toLowerCase() + (el.id ? "#" + el.id : el.classList[0] ? "." + el.classList[0] : "");
  const notes = frames.blank?.length ? [`${frames.blank.map(name).join(", ")} read back empty, so it is blank here. On screen it may not be: a WebGL canvas drawn in an earlier frame without preserveDrawingBuffer can't be read back; ask the user to share the tab for real pixels`] : [];
  return { root: copy, width, height, background, base: doc.baseURI, notes };
}

// #endregion

// Ours: the frozen document drawn as an SVG image. Fast, needs nothing, and approximate: what CSS can't say (a
// cross-origin frame, a WebGL buffer gone after its frame, the browser's own form widgets) differs or is missing.
export async function snapshot(doc, { host = document } = {}) {
  const { root, width, height, background, notes } = await freeze(doc, { inline: true });
  root.style.setProperty("width", `${width}px`);
  const xhtml = new XMLSerializer().serializeToString(root);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  return { ...(await stripsOf(host, width, height, background, (ctx, top, rows) => ctx.drawImage(img, 0, top, width, rows, 0, 0, width, rows))), notes };
}

// HTML-in-Canvas (WICG): a canvas with layoutsubtree (content="drawable" since the rename) paints its children with
// drawElementImage. Behind --enable-blink-features=CanvasDrawElement in Chrome and Edge 153-156.
export function drawable(win = globalThis) {
  return typeof win.CanvasRenderingContext2D?.prototype?.drawElementImage === "function" && "layoutSubtree" in (win.HTMLCanvasElement?.prototype ?? {});
}

// The frozen clone in a frame as tall as the page, inside a drawable canvas the size of a strip, painted strip by
// strip. Chrome paints it, so text, form controls and the focus ring are its own; fixed elements sit where a page that
// tall puts them, as in Playwright's full-page capture.
export async function htmlInCanvas(doc, { host = document, timeout = 3000 } = {}) {
  if (!drawable(host.defaultView)) throw new Error("HTML-in-Canvas is not available in this browser");
  const { root, width, height, background, base, notes } = await freeze(doc, { inline: false });
  const head = root.querySelector("head");
  head.prepend(Object.assign(host.createElement("base"), { href: base }));
  const { surface, frame } = drawableSurface(host);
  surface.width = width;
  surface.height = Math.min(STRIP, height);
  Object.assign(surface.style, { width: `${surface.width}px`, height: `${surface.height}px` });
  Object.assign(frame.style, { width: `${width}px`, height: `${height}px` });
  try {
    const loaded = new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
    frame.srcdoc = "<!doctype html>" + root.outerHTML;
    await Promise.race([loaded, sleep(timeout)]);
    const inner = frame.contentDocument;
    await Promise.race([Promise.all([inner.fonts?.ready, ...[...inner.images].map(i => i.decode().catch(() => {}))]), sleep(timeout)]);
    const ctx = surface.getContext("2d");
    const paint = top => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the drawable canvas never painted")), timeout);
      surface.onpaint = () => {
        clearTimeout(timer);
        surface.onpaint = null;
        try { ctx.reset(); ctx.drawElementImage(frame, 0, -top); resolve(); } catch (e) { reject(e); }
      };
      surface.requestPaint();
    });
    const sheet = await stripsOf(host, width, height, background, async (out, top, rows) => {
      await paint(top);
      out.drawImage(surface, 0, 0, width, rows, 0, 0, width, rows);
    });
    return { ...sheet, notes };
  } finally {
    frame.srcdoc = "<!doctype html>";
    Object.assign(frame.style, { width: "1px", height: "1px" });
  }
}

// One drawable canvas per document, kept: removing a frame from one crashes the renderer (Chrome 156, E23). On screen
// but clipped to nothing, since one parked off screen (or at opacity 0) paints its subtree blank.
const surfaces = new WeakMap();
function drawableSurface(host) {
  let found = surfaces.get(host);
  if (found?.surface.isConnected) return found;
  const surface = canvas(host, 1, 1);
  surface.setAttribute("layoutsubtree", "");
  surface.setAttribute("content", "drawable");
  surface.setAttribute("aria-hidden", "true");
  surface.style.cssText = "position:fixed;left:0;top:0;clip-path:inset(50%);pointer-events:none;z-index:-2147483647;";
  const frame = host.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("tabindex", "-1");
  frame.title = "Full-page capture";
  frame.style.cssText = "display:block;border:0;width:1px;height:1px;";
  surface.append(frame);
  host.body.append(surface);
  surfaces.set(host, found = { surface, frame });
  return found;
}

// A capture video's frames, watched: newer(t) resolves once the video shows a frame captured at or after t. Tab
// capture sends a frame only when the tab repaints, and the frame a scroll paints has usually arrived by the time two
// animation frames pass, so waiting for "the next frame" waited for a repaint that never came (500 ms a tile in E23).
export function latestFrame(video) {
  let last = -Infinity, waiting = [];
  const tick = (now, meta) => {
    last = meta.captureTime ?? now;
    waiting = waiting.filter(w => (last >= w.t ? (w.resolve(), false) : true));
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
  return {
    newer: (t, timeout = 50) => last >= t ? Promise.resolve() : new Promise(resolve => {
      waiting.push({ t, resolve });
      // No frame since: nothing repainted, so the one shown is current.
      setTimeout(resolve, timeout);
    }),
  };
}

// Scroll and stitch over real pixels. grab(after) answers the frame's viewport as it is on screen, from a frame
// captured after `after`: { source, sx, sy, sw, sh } (see latestFrame). Animations pause. Sticky elements sit in
// place; fixed ones show in the first tile only, where Playwright's full-page capture has them: a fixed footer at the
// first screen's bottom, not the page's. Each tile waits for its images to decode, then two frames; `after` is the
// first of them, whose paint has the scroll, the pause and the images (an earlier frame showed half-drawn photos).
// fixed: "first" as above, or "anchored" (a fixed element in the bottom half shows in the last tile instead).
export async function stitch(doc, grab, { host = document, fixed: rule = "first", onTile = null } = {}) {
  const win = doc.defaultView, root = doc.documentElement;
  const vw = root.clientWidth, vh = root.clientHeight, start = { x: win.scrollX, y: win.scrollY };
  const paused = doc.getAnimations().filter(a => a.playState === "running");
  paused.forEach(a => a.pause());
  const restyled = [], set = (el, prop, value) => { restyled.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]); el.style.setProperty(prop, value, "important"); };
  set(root, "scroll-behavior", "auto");
  const fixedEls = [];
  for (const el of doc.body?.querySelectorAll("*") ?? []) {
    const position = win.getComputedStyle(el).position;
    // Sticky, laid out where it is when nothing scrolls: the header at the top, a subheading at its section.
    if (position === "sticky") set(el, "position", "relative");
    else if (position === "fixed") {
      const r = el.getBoundingClientRect();
      fixedEls.push({ el, at: rule === "anchored" && r.top > vh / 2 ? "bottom" : "top" });
    }
  }
  for (const f of fixedEls) set(f.el, "visibility", win.getComputedStyle(f.el).visibility);
  const tiles = [], copies = [];
  try {
    let height = extent(doc).height;
    for (let y = 0, i = 0; y < height; y += vh, i++) {
      const tileStart = performance.now();
      let top, last, painted, grown = height;
      // An image that loads in a tile can grow the page: the last tile, placed by the old height, is placed again.
      for (let tries = 0; tries < 3; tries++) {
        top = Math.min(y, Math.max(0, grown - vh));
        last = y + vh >= grown;
        win.scrollTo(0, top);
        for (const f of fixedEls) {
          const show = f.at === "top" ? i === 0 : last;
          f.el.style.setProperty("visibility", show ? "visible" : "hidden", "important");
        }
        // Lazy images start loading once scrolled near; layout first, so they know.
        await nextFrame(win);
        const shown = [...doc.images].filter(img => { const r = img.getBoundingClientRect(); return r.bottom > 0 && r.top < vh; });
        await Promise.race([Promise.all(shown.map(img => img.decode().catch(() => {}))), sleep(1500)]);
        await nextFrame(win);
        painted = performance.now();
        await nextFrame(win);
        const now = extent(doc).height;
        if (now === grown || Math.min(y, Math.max(0, now - vh)) === top) { grown = now; break; }
        grown = now;
      }
      const { source, sx, sy, sw, sh } = await grab(painted);
      const ky = sh / vh, rows = Math.min(vh, grown - y), from = y - top;
      // The source (a video) moves on: the tile is copied now.
      const c = canvas(host, vw, rows);
      c.getContext("2d").drawImage(source, sx, sy + from * ky, sw, rows * ky, 0, 0, vw, rows);
      copies.push({ y, rows, canvas: c });
      tiles.push(performance.now() - tileStart);
      onTile?.({ index: i, top, rows, fixed: fixedEls.map(f => ({ el: f.el, at: f.at, shown: win.getComputedStyle(f.el).visibility !== "hidden" })) });
      height = grown;
    }
    const sheet = await stripsOf(host, vw, height, backgroundOf(doc), (ctx, stripTop, rows) => {
      for (const t of copies) if (t.y < stripTop + rows && t.y + t.rows > stripTop) ctx.drawImage(t.canvas, 0, t.y - stripTop);
    });
    return { ...sheet, tiles };
  } finally {
    for (const [el, prop, value, priority] of restyled.reverse()) value ? el.style.setProperty(prop, value, priority) : el.style.removeProperty(prop);
    win.scrollTo(start.x, start.y);
    paused.forEach(a => a.play());
  }
}
