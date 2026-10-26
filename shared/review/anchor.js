// Where a mark is on a page, found again on any width: the element under it and its lines, in document CSS px. Plain
// JS for a browser and Node: review mode writes it with each note, the note's store keeps it, the watch-along's ink and
// the book read it.
//
//   { v: 1, url, el: { selector, tag, text, box: { x, y, w, h } } | null, view: { w, h, x, y, dpr }, ink: [strokes] }
//
// url: the page, its fragment's values left out (noKeys). el: the element marked (null: a note about the whole page);
// its text at most TEXT_MAX characters, empty inside [data-private]; a field's value is never read. view: the viewport's
// size and scroll as it was drawn. box and every ink point (ink.js's strokes) are document px.

export const V = 1;
export const TEXT_MAX = 200;

// A shop keeps an order's key in the fragment (?order=42#t=<key>): a page keeps the fragment's names and a plain anchor
// (#faq, a deck's #7), never a value
export function noKeys(path) {
  const at = path.indexOf('#');
  if (at < 0) return path;
  const kept = path
    .slice(at + 1)
    .split('&')
    .map(p => (p.includes('=') ? `${p.slice(0, p.indexOf('='))}=…` : /^[a-z0-9-]{0,40}$/.test(p) ? p : '…'));
  return `${path.slice(0, at + 1)}${kept.join('&')}`;
}

// CSS.escape's rules, for Node (a browser has its own)
function cssEscape(value) {
  const s = String(value);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) out += '�';
    else if ((c >= 1 && c <= 31) || c === 127 || (/\d/.test(s[i]) && (i === 0 || (i === 1 && s[0] === '-'))))
      out += `\\${c.toString(16)} `;
    else if (i === 0 && s[i] === '-' && s.length === 1) out += '\\-';
    else if (c >= 128 || /[-_a-zA-Z0-9]/.test(s[i])) out += s[i];
    else out += `\\${s[i]}`;
  }
  return out;
}
const escape = s => (globalThis.CSS?.escape ? globalThis.CSS.escape(s) : cssEscape(s));

// A CSS-ish path an agent can find the element by: up to five steps, stopping at an id. One in an open shadow root
// (a chat's panel) starts with its host's path, then a space
export function selector(el) {
  const host = el.getRootNode?.()?.host,
    parts = [];
  for (
    let e = el;
    e && e.nodeType === 1 && e !== el.ownerDocument?.documentElement && parts.length < 5;
    e = e.parentElement
  ) {
    if (e.id) {
      parts.unshift(`${e.localName}#${escape(e.id)}`);
      break;
    }
    let s =
      e.localName +
      [...e.classList]
        .slice(0, 2)
        .map(c => `.${escape(c)}`)
        .join('');
    const same = e.parentElement ? [...e.parentElement.children].filter(x => x.localName === e.localName) : [];
    if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
    parts.unshift(s);
  }
  const path = parts.join(' > ');
  return host ? `${selector(host)} ${path}` : path;
}

// A selector's steps from the document into each open shadow root. The space that ends a hex escape (CSS.escape of an
// id like 123 gives \31 23) is part of its step, not that boundary
export const steps = sel => sel.match(/(?:\\[0-9a-fA-F]{1,6} ?|\\.|[^\\ ]| > )+/g) ?? [];

// Where an element is now, by its selector (doc: the document, or anything with querySelector), or null
export function found(sel, doc) {
  let el = null;
  try {
    for (const part of steps(sel)) if (!(el = (el ? el.shadowRoot : doc)?.querySelector(part))) return null;
  } catch {
    return null;
  }
  return el;
}

// Whether an element is private: [data-private] on it or around it, through shadow roots' hosts
export function isPrivate(el) {
  for (let e = el; e; e = e.getRootNode?.()?.host) if (e.closest?.('[data-private]')) return true;
  return false;
}
// An element's words for a note, unless it's private
export function textOf(el) {
  if (isPrivate(el)) return '';
  const words = el.innerText || el.getAttribute?.('aria-label') || el.getAttribute?.('alt') || '';
  return words.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
}

// A box in whole px; client rects come with left/top/width/height
export const box = r => ({
  x: Math.round(r.left ?? r.x),
  y: Math.round(r.top ?? r.y),
  w: Math.round(r.width ?? r.w),
  h: Math.round(r.height ?? r.h),
});

// An element's box in document px (scroll: the page's scroll now)
export const boxOf = (el, scroll) => {
  const r = el.getBoundingClientRect();
  return box({ x: r.left + scroll.x, y: r.top + scroll.y, w: r.width, h: r.height });
};

// The anchor for a mark on el (or none: a note about the page) drawn with view as it was: ink in document px
export function anchorOf(el, { url, view, ink = [] }) {
  const scroll = { x: view.x, y: view.y };
  return {
    v: V,
    url: noKeys(url),
    el: el ? { selector: selector(el), tag: el.localName, text: textOf(el), box: boxOf(el, scroll) } : null,
    view: { w: view.w, h: view.h, x: view.x, y: view.y, dpr: view.dpr },
    ink,
  };
}

// A point drawn on the box `was`, on that box as it is `now` (each axis scaled on its own); without a box now (gone, or
// nothing to see) it stays where it was
export function mapper(was, now) {
  if (!was || !now || !(now.w || now.h)) return ([x, y, ...rest]) => [x, y, ...rest];
  const kx = was.w ? now.w / was.w : 1,
    ky = was.h ? now.h / was.h : 1;
  return ([x, y, ...rest]) => [now.x + (x - was.x) * kx, now.y + (y - was.y) * ky, ...rest];
}

// Where an anchor's points are now, in document px: on its element where it's still there (live: the element itself,
// when the caller still holds it), else where they were drawn
export function placer(anchor, doc, scroll, live = null) {
  const el = live?.isConnected ? live : anchor.el?.selector ? found(anchor.el.selector, doc) : null;
  return mapper(anchor.el?.box, el ? boxOf(el, scroll) : null);
}

// ---- on another screen (a paired phone's ring on the desktop: handover.js, platform/hq/shell/pairink.js).
// A mark lands on another screen's layout only where its element there is the same one and the mark is about all of
// it: found by its selector, the same tag and words, an element laid out by its box (not one that draws its own picture
// inside it, nor the whole page), and its lines round it (their middle on it, their box covering at least COVERS of
// it). A ring round a word in a paragraph, a spot on a canvas or a few buttons in a row that wraps elsewhere lands
// anywhere but there: the mark goes as the first screen's own picture instead.
export const COVERS = 0.5;
const OWN_PICTURE = new Set(['canvas', 'video', 'iframe', 'embed', 'object', 'body', 'html']);

// Whether anchor's mark lands on the element as it is now ({ tag, text, box }: on this screen, in any px), or null;
// ink: its lines in the first screen's document px (the anchor's own by default)
export function lands(anchor, now, ink = anchor.ink ?? []) {
  const was = anchor.el;
  if (!was?.box || !now?.box || !(now.box.w > 0 && now.box.h > 0)) return false;
  if (now.tag !== was.tag || OWN_PICTURE.has(was.tag) || (now.text ?? '') !== (was.text ?? '')) return false;
  const pts = ink.flatMap(l => l.points ?? []);
  if (!pts.length) return true; // (a pin: its element alone)
  const xs = pts.map(p => p[0]),
    ys = pts.map(p => p[1]),
    lines = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) },
    b = was.box,
    mx = (lines.x0 + lines.x1) / 2,
    my = (lines.y0 + lines.y1) / 2;
  if (mx < b.x || mx > b.x + b.w || my < b.y || my > b.y + b.h) return false;
  const w = Math.max(0, Math.min(lines.x1, b.x + b.w) - Math.max(lines.x0, b.x)),
    h = Math.max(0, Math.min(lines.y1, b.y + b.h) - Math.max(lines.y0, b.y));
  return b.w > 0 && b.h > 0 && (w * h) / (b.w * b.h) >= COVERS;
}
// The element anchor's mark lands on here (doc: the document, scroll: its scroll now), or null
export function landing(anchor, doc, scroll, ink) {
  const el = anchor?.el?.selector ? found(anchor.el.selector, doc) : null;
  return el && lands(anchor, { tag: el.localName, text: textOf(el), box: boxOf(el, scroll) }, ink) ? el : null;
}
// What a mark is round, to find it by on another screen: from el (the element at its middle) up, the outermost element
// it covers at least COVERS of (area: the lines' box, client px), short of the page itself; null when it covers none
// (a word in a paragraph, a spot on a canvas). The Pencil's own pick (mark.js aim) is the element holding the ring,
// which is often the row or panel around what was ringed: laid out another way on another width.
export function roundOf(el, area) {
  let round = null;
  for (let e = el; e && e !== e.ownerDocument.body && e !== e.ownerDocument.documentElement; e = e.parentElement) {
    const r = e.getBoundingClientRect(),
      w = Math.max(0, Math.min(area.x + area.w, r.right) - Math.max(area.x, r.left)),
      h = Math.max(0, Math.min(area.y + area.h, r.bottom) - Math.max(area.y, r.top));
    if (!(r.width * r.height) || (w * h) / (r.width * r.height) < COVERS) break;
    round = e;
  }
  return round;
}
