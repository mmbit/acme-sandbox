// The screenshot: the viewport as it is, drawn by the browser itself through an SVG <foreignObject>: every visible
// element is copied with its computed style inlined (copy.js), images, backgrounds and web fonts become data URLs
// (same-origin or CORS-enabled ones; the rest are left out), fixed and sticky elements are pinned where they are on
// screen. The pin and the lines go on a copy of it (expose), each time they change, and the note takes that copy as a
// JPEG (photo).
import { ACCENT } from './base.js';
import * as inkjs from './ink.js';
import { openPopups } from './layer.js';
import { copy } from './copy.js';
import { drawn } from './pictures.js';

// The page's open popups over it all, in the order they opened, in a box the screen's size (the one they're sized and
// placed in); each with its backdrop in a stacking context of its own, the popup over its backdrop (the top layer
// ignores a popup's own z-index, which its copy keeps)
function popupsOver(r, waits, v) {
  const overPage = document.createElement('div');
  overPage.setAttribute(
    'style',
    `position:absolute;left:${v.sx}px;top:${v.sy}px;width:${v.W}px;height:${v.H}px;z-index:2147483647`,
  );
  for (const popup of openPopups(r)) {
    const b = getComputedStyle(popup, '::backdrop'),
      layer = document.createElement('div'),
      backdrop = document.createElement('div'),
      above = document.createElement('div');
    layer.setAttribute('style', 'position:absolute;inset:0;isolation:isolate');
    backdrop.setAttribute(
      'style',
      `position:absolute;inset:0;background-color:${b.backgroundColor};background-image:${b.backgroundImage};` +
        `opacity:${b.opacity};backdrop-filter:${b.backdropFilter || 'none'}`,
    );
    above.setAttribute('style', 'position:absolute;inset:0;z-index:1');
    const copied = copy(r, popup, waits, { ...v, cb: { x: v.sx, y: v.sy }, popup });
    if (copied) above.append(copied);
    layer.append(backdrop, above);
    overPage.append(layer);
  }
  return overPage;
}

// The page as it is now: { c: a canvas, k: its pixels per CSS px }, or null if the browser won't play along. masked:
// what the watch-along keeps out painted over (a call's snip, which goes to the call's agent)
export async function snapshot(r, { masked = false } = {}) {
  try {
    const W = innerWidth,
      H = innerHeight,
      sx = scrollX,
      sy = scrollY,
      de = document.documentElement,
      waits = [],
      hidden = masked ? masks() : [];
    // what copy() keeps track of for fixed and sticky boxes, and for faces that turn in 3D: the 3D context a box sits
    // in, whether its parent keeps it 3D, and whether what it's painted on is turned away
    const v = {
      sx,
      sy,
      W,
      H,
      top: null,
      cb: { x: 0, y: 0 },
      clear: true,
      cut: false,
      cuts: false,
      scroller: false,
      context3d: null,
      preserved: false,
      turnedAway: false,
    };
    const clone = copy(r, de, waits, v);
    clone.append(popupsOver(r, waits, v));
    // (WebKit paints no box placed against the image's own initial containing block: the root holds them instead)
    if (getComputedStyle(de).position === 'static') clone.style.position = 'relative';
    const fonts = await Promise.race([fontFaces(), new Promise(res => setTimeout(() => res(''), 3000))]);
    await Promise.race([Promise.all(waits), new Promise(res => setTimeout(res, 4000))]);
    const style = document.createElement('style');
    style.textContent = fonts;
    clone.prepend(style);
    const dw = Math.max(de.scrollWidth, W),
      dh = Math.max(de.scrollHeight, H);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="${-sx}" y="${-sy}" width="${dw}" height="${dh}">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const k = Math.min(devicePixelRatio || 1, 2, 2000 / Math.max(W, H)),
      c = document.createElement('canvas');
    c.width = Math.round(W * k);
    c.height = Math.round(H * k);
    const g = c.getContext('2d');
    g.scale(k, k);
    g.fillStyle = bg();
    g.fillRect(0, 0, W, H);
    g.drawImage(img, 0, 0, W, H);
    await new Promise(res => setTimeout(res, 60));
    g.drawImage(img, 0, 0, W, H); // Safari paints images late: a second pass
    g.fillStyle = MASK;
    for (const b of hidden) g.fillRect(b.left, b.top, b.width, b.height);
    c.toDataURL('image/jpeg', 0.1); // (a page that tainted it says so here, not at the send)
    return { c, k };
  } catch (err) {
    console.info('[review] no screenshot:', err?.message || err);
    return null;
  }
}
// What a masked snapshot paints over, as the watch-along keeps it out of what it records (shared/watchalong/
// watchalong.js PRIVATE and HIDE): a person's private details (their words, fields and pictures) and what never leaves
// the page (the call's own controls, a card's key fields). Every box and line of text in them, shadow roots' too, in
// the screen's px as they are now.
const MASKED = '[data-private], [data-watchalong-hide]',
  MASK = '#8c8c8c';
function masks(root = document, boxes = []) {
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) masks(el.shadowRoot, boxes);
    if (el.matches(MASKED)) covered(el, boxes);
  }
  return boxes;
}
function covered(node, boxes) {
  if (node.nodeType === 1) boxes.push(...node.getClientRects());
  else if (node.nodeType === 3) {
    const words = document.createRange();
    words.selectNodeContents(node);
    boxes.push(...words.getClientRects());
  }
  for (const kid of [...(node.shadowRoot?.childNodes ?? []), ...node.childNodes]) covered(kid, boxes);
}

// the screenshot with the mark on it, into `into` (a new canvas by default)
export function expose(r, { c, k }, m, into = document.createElement('canvas')) {
  into.width = c.width;
  into.height = c.height;
  const g = into.getContext('2d');
  g.drawImage(c, 0, 0);
  g.scale(k, k);
  annotate(r, g, m);
  return into;
}
// ...as it goes: the coordinator keeps a screenshot up to 1.5 MB (about 2 MB as a data URL)
export function photo(r, taken, m) {
  if (!taken) return null;
  try {
    const c = expose(r, taken, m);
    let url;
    for (const q of [0.85, 0.7, 0.55, 0.4]) if ((url = c.toDataURL('image/jpeg', q)).length < 2_000_000) break;
    return url.startsWith('data:image/jpeg') ? url : null;
  } catch {
    return null;
  }
}
function bg() {
  for (const e of [document.body, document.documentElement]) {
    const c = e && getComputedStyle(e).backgroundColor;
    if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
  }
  return '#fff';
}
// the pin, and the lines drawn as they are on screen (ink.js)
function annotate(r, g, m) {
  g.lineCap = g.lineJoin = 'round';
  const b = m.element.rect;
  if (m.kind !== 'circle') {
    g.setLineDash([7, 5]);
    g.strokeStyle = ACCENT;
    g.lineWidth = 2.5;
    g.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
    g.setLineDash([]);
    const { x, y } = m; // a pin: a round head on a short needle
    g.strokeStyle = '#2b2230';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + 8, y - 16);
    g.stroke();
    g.fillStyle = ACCENT;
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x + 11, y - 21, 9, 0, 7);
    g.fill();
    g.stroke();
  } // (a circle: its lines, below)
  inkjs.draw(g, r.strokes, { halo: true });
}
// a video's frame as it shows now, about the size it's shown at
export function drawnFrame(v) {
  const b = v.getBoundingClientRect(),
    k = Math.min(
      1,
      (Math.max(b.width, b.height) * Math.min(devicePixelRatio || 1, 2)) / Math.max(v.videoWidth, v.videoHeight),
    );
  return drawn(v, v.videoWidth * k, v.videoHeight * k, false);
}
const cache = new Map();
export function inline(url) {
  if (url.startsWith('data:')) return Promise.resolve(url);
  if (!cache.has(url))
    cache.set(
      url,
      fetch(url, { credentials: 'same-origin' })
        .then(res => (res.ok ? res.blob() : null))
        .then(
          b =>
            b &&
            new Promise(res => {
              const f = new FileReader();
              f.onload = () => res(f.result);
              f.onerror = () => res(null);
              f.readAsDataURL(b);
            }),
        )
        .catch(() => null),
    );
  return cache.get(url);
}
export async function inlineUrls(css, base) {
  const urls = [...css.matchAll(/url\((['"]?)(.*?)\1\)/g)];
  for (const [all, , u] of urls) {
    if (u.startsWith('data:')) continue;
    let abs;
    try {
      abs = new URL(u, base).href;
    } catch {
      continue;
    }
    const data = await inline(abs);
    css = css.replace(all, data ? `url("${data}")` : 'none');
  }
  return css;
}
async function fontFaces() {
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    } // cross-origin sheets can't be read
    for (const rule of rules)
      if (rule.constructor.name === 'CSSFontFaceRule')
        out.push(await inlineUrls(rule.cssText, sheet.href || location.href));
  }
  return out.join('\n');
}
