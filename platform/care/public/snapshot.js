// The bug report's picture and bundle: the app's own page as it looks now, drawn in the browser from the page
// itself (not getDisplayMedia: works on phones, needs no system dialog, can't capture other tabs). Only the visible
// viewport; anything marked [data-no-snapshot] left out (the chat panel marks itself, widget.js); every form field (inputs,
// textareas, selects, contenteditable) a hatched box, never its value; only same-origin content: an image from another
// origin is a plain box, and nothing is fetched (inline SVGs are drawn through data: URLs, a font face the page hasn't
// loaded is never asked for). Drawn to a canvas element by element: backgrounds, gradients, rounded corners, borders,
// shadows, transforms, the page's loaded images and inline SVGs, and its text word by word in its own fonts, so lines
// wrap where they wrap on screen. The widget imports this statically: a lazy import would be a request before the tap.
import { events, where } from './telemetry.js';

const PICTURE_MAX = 180_000; // characters of the data URL: with 100 events the bundle stays well under the server's 256 KB
const CLEAR = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
const FIELD = 'input:not([type=hidden]), textarea, select, [contenteditable]:not([contenteditable=false])';
const SKIP = new Set(['HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'TITLE', 'DIALOG', 'OPTION', 'DATALIST']);
const BOXES = new Set(['IFRAME', 'VIDEO', 'OBJECT', 'EMBED', 'AUDIO']); // drawn as plain boxes: their content isn't ours to copy

// The bundle the consent card shows and sends: exactly what was built, nothing added later (the widget freezes it).
export async function bundle() {
  const at = new Date().toISOString(), log = events(), page = { path: where().slice(0, 300), w: document.documentElement.clientWidth || innerWidth, h: innerHeight };
  // a page this can't draw still gets its log: the preview says there's no picture, and none goes
  const picture = await snapshot().then((s) => s.picture, (err) => { console.warn('care: no picture of this page:', err?.name); return null; });
  return { v: 1, at, page, events: log, picture };
}

// The picture: a JPEG data URL of the viewport, at most PICTURE_MAX characters (quality, then size, give way)
export async function snapshot() {
  const W = document.documentElement.clientWidth || innerWidth, H = innerHeight;
  await document.fonts?.ready;
  const svgs = await inlineSvgs(W, H);
  let scale = Math.min(2, Math.max(1, devicePixelRatio || 1), 1600 / W), images = true;
  for (let i = 0; i < 8; i++) {
    const canvas = draw(W, H, scale, svgs, images);
    let url;
    try { url = canvas.toDataURL('image/jpeg', 0.8); } catch { images = false; continue; } // an image tainted it after all: boxes instead
    for (const q of [0.68, 0.55]) if (url.length > PICTURE_MAX) url = canvas.toDataURL('image/jpeg', q);
    if (url.length <= PICTURE_MAX) return { picture: url };
    scale *= 0.75;
  }
  return { picture: draw(W, H, 0.5, svgs, false).toDataURL('image/jpeg', 0.5) };
}

// ---- the walk
function draw(W, H, scale, svgs, images) {
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(W * scale), height: Math.round(H * scale) });
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  // the page's background: the root's, or the body's (CSS propagates it to the canvas), else white
  const bg = [document.documentElement, document.body].map((e) => e && getComputedStyle(e).backgroundColor).find((c) => !CLEAR(c));
  ctx.fillStyle = bg || '#fff'; ctx.fillRect(0, 0, W, H);
  const later = []; // positioned layers with a z-index, fixed and sticky ones: painted over the flow, lowest first
  const top = { m: new DOMMatrix(), alpha: 1, clips: [], filter: 'none', root: true };
  walk(document.body ?? document.documentElement, top, { ctx, W, H, svgs, images, later, fonts: new Map() });
  for (let i = 0; i < later.length; i++) { // a layer's own layers join the list as it's painted
    const rest = later.slice(i).sort((a, b) => a.z - b.z); later.splice(i, later.length - i, ...rest);
    const { el, st } = later[i];
    walk(el, { ...st, layer: el }, { ctx, W, H, svgs, images, later, fonts: new Map() });
  }
  return canvas;
}

function walk(el, parent, g) {
  if (SKIP.has(el.tagName) || el.hasAttribute('data-no-snapshot')) return;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.contentVisibility === 'hidden') return;
  const alpha = parent.alpha * Number(cs.opacity);
  if (alpha <= 0.01) return;
  // a positioned layer above the flow waits its turn (the fixed header over the scrolled page)
  const z = cs.zIndex === 'auto' ? 0 : Number(cs.zIndex);
  if (parent.layer !== el && !parent.root && (cs.position === 'fixed' || cs.position === 'sticky' || (cs.position !== 'static' && z !== 0))) {
    g.later.push({ el, z, st: parent });
    return;
  }
  // transforms: the element is drawn about its own centre with its transform's linear part (rotations, scales)
  let m = parent.m;
  if (cs.transform && cs.transform !== 'none') { const t = new DOMMatrix(cs.transform); m = m.multiply(new DOMMatrix([t.a, t.b, t.c, t.d, 0, 0])); }
  const flat = m.isIdentity;
  const r = el.getBoundingClientRect();
  const box = flat || !(el instanceof HTMLElement) ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height }
    : { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: el.offsetWidth, h: el.offsetHeight };
  const visible = cs.visibility === 'visible';
  const onScreen = r.right > 0 && r.bottom > 0 && r.left < g.W && r.top < g.H && r.width > 0 && r.height > 0;
  const st = { m, alpha, clips: parent.clips, filter: cs.filter !== 'none' ? cs.filter : parent.filter };
  const { ctx } = g;
  const at = (s = st) => { // the drawing state for this element: its clips, its centre, its transform
    ctx.save();
    applyClips(ctx, s.clips);
    ctx.globalAlpha = s.alpha;
    if (s.filter !== 'none' && /^(drop-shadow|blur)\(/.test(s.filter)) ctx.filter = s.filter;
    place(ctx, box, s.m);
  };

  if (visible && onScreen) {
    const radii = cornerRadii(cs, box.w, box.h);
    if (el.matches(FIELD)) { at(); hatched(ctx, box, radii); ctx.restore(); return; } // never a value, never its children
    at();
    paintBox(ctx, cs, box, radii);
    if (el.tagName === 'IMG') image(ctx, el, box, radii, g.images, cs);
    else if (el instanceof SVGSVGElement) { const img = g.svgs.get(el); if (img) ctx.drawImage(img, -box.w / 2, -box.h / 2, box.w, box.h); }
    else if (el.tagName === 'CANVAS' && g.images) { try { ctx.drawImage(el, -box.w / 2, -box.h / 2, box.w, box.h); } catch { plain(ctx, box, radii); } }
    else if (BOXES.has(el.tagName)) plain(ctx, box, radii);
    ctx.restore();
  } else if (el.matches?.(FIELD)) return;
  if (el instanceof SVGElement || BOXES.has(el.tagName) || el.tagName === 'IMG' || el.tagName === 'CANVAS') return;

  // what's inside: clipped to this box when it hides its overflow (screen-reader-only text stays hidden, as on screen)
  const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.clipPath === 'inset(50%)' || /rect\(0px,? 0px,? 0px,? 0px\)/.test(cs.clip)
    ? [...st.clips, { ...box, m, radii: cornerRadii(cs, box.w, box.h) }] : st.clips;
  if (clips !== st.clips && !onScreen) return;
  const inner = { ...st, clips };
  for (const n of el.childNodes) {
    if (n.nodeType === 1) walk(n, inner, g);
    else if (n.nodeType === 3 && visible && onScreen && n.data.trim()) text(n, cs, inner, g);
  }
  if (el.shadowRoot) for (const n of el.shadowRoot.children) walk(n, inner, g);
}

// ---- drawing helpers. place(): the origin at a box's centre, with the transform's linear part
function place(ctx, box, m) { ctx.translate(box.cx, box.cy); if (!m.isIdentity) ctx.transform(m.a, m.b, m.c, m.d, 0, 0); }
function applyClips(ctx, clips) {
  for (const c of clips) {
    const t = ctx.getTransform();
    place(ctx, c, c.m); ctx.beginPath(); rounded(ctx, -c.w / 2, -c.h / 2, c.w, c.h, c.radii); ctx.setTransform(t); ctx.clip();
  }
}
function rounded(ctx, x, y, w, h, radii) { if (radii && ctx.roundRect) ctx.roundRect(x, y, w, h, radii); else ctx.rect(x, y, w, h); }
function cornerRadii(cs, w, h) {
  const r = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map((k) => {
    const v = cs[k]; return v.endsWith('%') ? (parseFloat(v) / 100) * Math.min(w, h) : parseFloat(v) || 0; });
  const k = Math.min(1, w / Math.max(1e-6, r[0] + r[1]), w / Math.max(1e-6, r[2] + r[3]), h / Math.max(1e-6, r[0] + r[3]), h / Math.max(1e-6, r[1] + r[2]));
  return r.some((x) => x > 0) ? r.map((x) => x * k) : null;
}

function paintBox(ctx, cs, box, radii) {
  const x = -box.w / 2, y = -box.h / 2;
  const shadow = /^(rgba?\([^)]*\)|#\w+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/.exec(cs.boxShadow); // the first one, outside only
  const fill = (style) => {
    ctx.save();
    if (shadow && !cs.boxShadow.includes('inset')) Object.assign(ctx, { shadowColor: shadow[1], shadowOffsetX: +shadow[2], shadowOffsetY: +shadow[3], shadowBlur: +shadow[4] });
    ctx.beginPath(); rounded(ctx, x, y, box.w, box.h, radii); ctx.fillStyle = style; ctx.fill();
    ctx.restore();
  };
  if (!CLEAR(cs.backgroundColor)) fill(cs.backgroundColor);
  for (const layer of splitTop(cs.backgroundImage).reverse()) { const grad = gradient(ctx, layer, box); if (grad) fill(grad); }
  // borders: one stroke when all four sides match (rounded corners kept), else each side as a strip
  const sides = ['Top', 'Right', 'Bottom', 'Left'].map((s) => ({ w: cs[`border${s}Style`] === 'none' || cs[`border${s}Style`] === 'hidden' ? 0 : parseFloat(cs[`border${s}Width`]) || 0, c: cs[`border${s}Color`] }));
  if (sides.every((s) => !s.w || CLEAR(s.c))) return;
  if (sides.every((s) => s.w === sides[0].w && s.c === sides[0].c)) {
    const b = sides[0].w;
    ctx.beginPath(); rounded(ctx, x + b / 2, y + b / 2, box.w - b, box.h - b, radii?.map((r) => Math.max(0, r - b / 2)));
    ctx.lineWidth = b; ctx.strokeStyle = sides[0].c; ctx.stroke();
    return;
  }
  const [t, rr, bb, l] = sides;
  const strip = (s, sx, sy, sw, sh) => { if (s.w && !CLEAR(s.c)) { ctx.fillStyle = s.c; ctx.fillRect(sx, sy, sw, sh); } };
  strip(t, x, y, box.w, t.w); strip(bb, x, y + box.h - bb.w, box.w, bb.w); strip(l, x, y, l.w, box.h); strip(rr, x + box.w - rr.w, y, rr.w, box.h);
}

// linear-gradient(…) as the computed style writes it: an angle or "to <side>", then colour stops with optional %
function gradient(ctx, layer, box) {
  const m = /^(repeating-)?linear-gradient\((.*)\)$/s.exec(layer.trim());
  if (!m || m[1]) return null;
  const parts = splitTop(m[2]);
  let angle = 180;
  const head = parts[0].trim();
  const SIDES = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to right top': 45, 'to bottom right': 135, 'to right bottom': 135, 'to bottom left': 225, 'to left bottom': 225, 'to top left': 315, 'to left top': 315 };
  if (/^-?[\d.]+(deg|turn|rad)$/.test(head)) { angle = head.endsWith('turn') ? parseFloat(head) * 360 : head.endsWith('rad') ? (parseFloat(head) * 180) / Math.PI : parseFloat(head); parts.shift(); }
  else if (head in SIDES) { angle = SIDES[head]; parts.shift(); }
  const a = (angle * Math.PI) / 180, dx = Math.sin(a), dy = -Math.cos(a);
  const half = (Math.abs(box.w * dx) + Math.abs(box.h * dy)) / 2;
  const g = ctx.createLinearGradient(-dx * half, -dy * half, dx * half, dy * half);
  const stops = parts.map((p) => { const s = /^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(p.trim()); return { c: s[1], at: s[2] == null ? null : parseFloat(s[2]) / 100 }; });
  stops.forEach((s, i) => { if (s.at == null) s.at = i === 0 ? 0 : i === stops.length - 1 ? 1 : null; });
  for (let i = 1; i < stops.length - 1; i++) if (stops[i].at == null) { let j = i; while (stops[j].at == null) j++; const k = (stops[j].at - stops[i - 1].at) / (j - i + 1); for (; i < j; i++) stops[i].at = stops[i - 1].at + k; }
  try { for (const s of stops) g.addColorStop(Math.min(1, Math.max(0, s.at)), s.c); } catch { return null; }
  return g;
}
// split on commas outside brackets: "rgb(1, 2, 3) 10%, rgb(…)" → two
function splitTop(s) {
  if (!s || s === 'none') return [];
  const out = []; let depth = 0, cur = '';
  for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { out.push(cur); cur = ''; } else cur += ch; }
  return [...out, cur].filter((x) => x.trim());
}

// an <img>: drawn only if it's ours (same origin, or a data:/blob: URL of this page) and already loaded; else a box
function image(ctx, el, box, radii, images, cs) {
  const src = el.currentSrc || el.src;
  let ours = false;
  try { const u = new URL(src, location.href); ours = u.protocol === 'data:' || u.origin === location.origin; } catch { /* no source */ }
  if (!images || !ours || !el.complete || !el.naturalWidth) return plain(ctx, box, radii);
  ctx.save();
  if (radii) { ctx.beginPath(); rounded(ctx, -box.w / 2, -box.h / 2, box.w, box.h, radii); ctx.clip(); }
  const fit = cs.objectFit, iw = el.naturalWidth, ih = el.naturalHeight;
  if (fit === 'cover' || fit === 'contain') {
    const k = (fit === 'cover' ? Math.max : Math.min)(box.w / iw, box.h / ih);
    ctx.drawImage(el, -iw * k / 2, -ih * k / 2, iw * k, ih * k);
  } else ctx.drawImage(el, -box.w / 2, -box.h / 2, box.w, box.h);
  ctx.restore();
}
// another site's image, a video, a frame: a quiet box with a picture mark, nothing of its content
function plain(ctx, box, radii) {
  const x = -box.w / 2, y = -box.h / 2;
  ctx.save();
  ctx.beginPath(); rounded(ctx, x, y, box.w, box.h, radii ?? [4, 4, 4, 4]); ctx.fillStyle = '#e7e3dc'; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = '#c9c2b6'; ctx.stroke();
  const s = Math.min(box.w, box.h) * 0.28;
  if (s > 6) {
    ctx.strokeStyle = '#a69d8f'; ctx.lineWidth = Math.max(1, s / 10); ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(-s, s * 0.6); ctx.lineTo(-s * 0.3, -s * 0.2); ctx.lineTo(s * 0.15, s * 0.3); ctx.lineTo(s * 0.45, 0); ctx.lineTo(s, s * 0.6); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(s * 0.45, -s * 0.5, s * 0.16, 0, 7); ctx.stroke();
  }
  ctx.restore();
}
// a form field: diagonal hatching and a small lock, in its own shape; what was typed or chosen never reaches the canvas
function hatched(ctx, box, radii) {
  const x = -box.w / 2, y = -box.h / 2;
  ctx.save();
  ctx.beginPath(); rounded(ctx, x, y, box.w, box.h, radii); ctx.fillStyle = '#efebe4'; ctx.fill(); ctx.clip();
  ctx.strokeStyle = '#d3cbbd'; ctx.lineWidth = 3;
  ctx.beginPath();
  for (let d = -box.h; d < box.w; d += 9) { ctx.moveTo(x + d, y + box.h); ctx.lineTo(x + d + box.h, y); }
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.beginPath(); rounded(ctx, x + 0.5, y + 0.5, box.w - 1, box.h - 1, radii); ctx.strokeStyle = '#8f8576'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.stroke();
  if (box.h >= 16 && box.w >= 24) { // the lock, at the start of the field
    const s = Math.min(7, box.h * 0.22), lx = x + Math.min(12, box.w / 4) + s, ly = 0;
    ctx.setLineDash([]); ctx.fillStyle = '#8f8576'; ctx.strokeStyle = '#8f8576'; ctx.lineWidth = Math.max(1.2, s / 4);
    ctx.fillRect(lx - s, ly - s * 0.2, s * 2, s * 1.5);
    ctx.beginPath(); ctx.arc(lx, ly - s * 0.2, s * 0.65, Math.PI, 0); ctx.stroke();
  }
  ctx.restore();
}

// ---- text: word by word where it sits on screen, in the page's font when that face is loaded (never asking for one)
function text(node, cs, st, g) {
  const { ctx } = g;
  const font = fontOf(cs, g.fonts);
  const color = cs.webkitTextFillColor && !CLEAR(cs.webkitTextFillColor) ? cs.webkitTextFillColor : cs.color;
  if (CLEAR(color)) return;
  const tt = cs.textTransform, underline = /underline/.test(cs.textDecorationLine);
  const range = document.createRange();
  const re = /\S+/g; let w;
  ctx.save();
  applyClips(ctx, st.clips);
  ctx.globalAlpha = st.alpha;
  if (st.filter !== 'none' && /^drop-shadow\(/.test(st.filter)) ctx.filter = st.filter;
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx && cs.letterSpacing !== 'normal') ctx.letterSpacing = cs.letterSpacing;
  const base = ctx.getTransform();
  while ((w = re.exec(node.data))) {
    range.setStart(node, w.index); range.setEnd(node, w.index + w[0].length);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    if (!rects.length) continue;
    if (rects[0].top > g.H && st.m.isIdentity) break; // the rest of this text is below the fold
    const pieces = rects.length === 1 ? [[w[0], rects[0]]] : chars(node, w.index, w[0]); // a word broken over lines
    for (const [word, r] of pieces) {
      if (r.bottom < 0 || r.top > g.H || r.right < 0 || r.left > g.W) continue;
      const shown = tt === 'uppercase' ? word.toUpperCase() : tt === 'lowercase' ? word.toLowerCase() : tt === 'capitalize' ? word[0].toUpperCase() + word.slice(1) : word;
      ctx.setTransform(base);
      place(ctx, { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }, st.m);
      const mt = ctx.measureText(shown);
      const asc = mt.fontBoundingBoxAscent ?? parseFloat(cs.fontSize) * 0.8, desc = mt.fontBoundingBoxDescent ?? parseFloat(cs.fontSize) * 0.2;
      const span = st.m.isIdentity ? r.width : mt.width;
      // the canvas's width for the same font can differ by a hair: squeeze to the width it has on screen
      const k = st.m.isIdentity && mt.width > 0 ? Math.min(1.15, Math.max(0.85, span / mt.width)) : 1;
      if (k !== 1) ctx.scale(k, 1);
      const y = (asc - desc) / 2;
      ctx.fillText(shown, 0, y);
      if (underline) ctx.fillRect(-mt.width / 2, y + Math.max(1, desc * 0.35), mt.width, Math.max(1, parseFloat(cs.fontSize) / 14));
    }
  }
  ctx.restore();
}
function chars(node, from, word) {
  const out = [], range = document.createRange();
  for (let i = 0; i < word.length; i++) {
    range.setStart(node, from + i); range.setEnd(node, from + i + 1);
    const r = range.getBoundingClientRect();
    const last = out.at(-1);
    if (last && Math.abs(last[1].top - r.top) < 2) { last[0] += word[i]; last[1] = DOMRect.fromRect({ x: last[1].left, y: last[1].top, width: r.right - last[1].left, height: last[1].height }); }
    else out.push([word[i], r]);
  }
  return out;
}
// The CSS font for the canvas. A web font the page declared but hasn't loaded would be fetched the moment the canvas
// drew with it, which is a request before the tap: then its families are dropped and the fallbacks draw it.
function fontOf(cs, cache) {
  const family = cs.fontFamily, key = `${cs.fontStyle}|${cs.fontWeight}|${cs.fontSize}|${family}`;
  if (cache.has(key)) return cache.get(key);
  let font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${family}`;
  if (document.fonts && !document.fonts.check(font)) {
    const webFonts = new Set([...document.fonts].map((f) => f.family.replace(/^["']|["']$/g, '').toLowerCase()));
    const kept = family.split(',').map((f) => f.trim()).filter((f) => !webFonts.has(f.replace(/^["']|["']$/g, '').toLowerCase()));
    font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${kept.join(', ') || 'sans-serif'}`;
  }
  cache.set(key, font);
  return font;
}

// ---- inline SVGs: each visible one copied with the page's computed paint written onto its shapes (the page's CSS
// doesn't travel with it), then loaded from a data: URL, which is no request. Images inside an SVG drawn this way load
// nothing (the browser won't fetch from an SVG used as an image), and an external <use> simply shows nothing.
const PAINT = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'stroke-dasharray', 'opacity', 'font-family', 'font-size', 'font-weight', 'stop-color', 'stop-opacity', 'visibility'];
const UNDRAWN = 'defs, symbol, clipPath, mask, pattern, marker, linearGradient, radialGradient, filter';
async function inlineSvgs(W, H) {
  const out = new Map(), jobs = [];
  for (const svg of document.querySelectorAll('svg')) {
    if (svg.ownerSVGElement || svg.closest('[data-no-snapshot]')) continue;
    const r = svg.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) continue;
    const copy = svg.cloneNode(true), from = [svg, ...svg.querySelectorAll('*')], to = [copy, ...copy.querySelectorAll('*')];
    // what the HTML walk leaves out stays out here too: [data-no-snapshot] shapes and those the page's CSS hides
    // (display none, unless only because it sits in <defs> or a gradient: those are drawn by reference)
    const drop = [];
    from.forEach((el, i) => {
      const cs = getComputedStyle(el);
      if (i && (el.hasAttribute('data-no-snapshot') || (cs.display === 'none' && !el.closest(UNDRAWN)))) return void drop.push(to[i]);
      for (const p of PAINT) { const v = cs.getPropertyValue(p); if (v) to[i].setAttribute(p, v); }
    });
    for (const el of drop) el.remove();
    for (const el of copy.querySelectorAll('image, foreignObject, script')) el.remove(); // nothing that could load or run
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', r.width); copy.setAttribute('height', r.height);
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
    jobs.push(img.decode().then(() => out.set(svg, img), () => { /* an SVG that won't draw is left out */ }));
  }
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 1500))]);
  return out;
}
