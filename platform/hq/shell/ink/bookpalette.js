// The book's tools on the rail (bookstrip.js): Select, the pen and the marker (one tool split in two, the half last
// used remembered), the eraser, shapes and Text, and over the rail the tool's own card: its colours, its line's width,
// the eraser's size, a shape's kind and whether it's filled, the pen's smoothing. The tool in use pressed again opens
// its card; the keys a drawing app has do the same on a desktop. Every setting is remembered in this browser, and the
// book opens on the pen or the marker, whichever was last in use.
//
// st: booktools.js's state; this keeps st.mode and the settings on it, and calls st.changedTool(mode) when the tool
// changes.
import { store } from '../../util.js';
import { button, island, setPressed, hide, overRail } from './bookui.js';
import { MARKERS, MARKER_ALPHA, SHAPES, WIDTHS } from './bookinkmath.js';
import { word } from './bookscope.js';
import { ERASER_PATHS } from '/__review/eraser.js';
// The pens' inks, from the book's own Night: review mode's pin offers the same
import { PENS } from '/__review/ink.js';

// The eraser's sizes (across, on screen: a fine one for a letter, a wide one for a line of them)
const ERASERS = [12, 28, 56];
// The pen's smoothing: how far each point goes towards the pointer (ink.js's follow): steady, or as the hand went
const SMOOTH = { on: 0.42, off: 0.75 };

// (the line's attributes on a group, as bookui.js's lineIcon: HQ's own style fills every svg, and that beats an
// attribute on the svg itself.)
const svg = body =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
const ICONS = {
  // Select: a dashed box, its dashes meeting at the corners
  select: svg('<path d="M4 4h12v12H4z" stroke-dasharray="2.6 3.4" stroke-dashoffset="1.3"/>'),
  pen: svg('<path d="M4.2 15.8l.9-3.6 8.6-8.6a2 2 0 0 1 2.8 2.8l-8.6 8.6z"/><path d="M12.3 5l2.7 2.7"/>'),
  highlighter: svg(
    '<path d="M6.6 13.6l7.6-9.4 3 2.4-7.6 9.4z"/><path d="M6.6 13.6l-1.5 2.4 3.1.2 1.4-1.8"/><path d="M3 18.2h9" stroke-width="2.2" opacity=".45"/>',
  ),
  eraser: svg(ERASER_PATHS),
  ellipse: svg('<ellipse cx="10" cy="10" rx="6.6" ry="5.4"/>'),
  rect: svg('<rect x="3.6" y="5" width="12.8" height="10" rx="1.2"/>'),
  line: svg('<path d="M4.5 15.5l11-11"/>'),
  arrow: svg('<path d="M4.5 15.5l11-11"/><path d="M9.2 4.5h6.3v6.3"/>'),
  text: svg('<path d="M4.5 5.5V4h11v1.5"/><path d="M10 4v12"/><path d="M7.5 16h5"/>'),
  outline: svg('<rect x="4" y="4" width="12" height="12" rx="2"/>'),
  filled: svg('<rect x="4" y="4" width="12" height="12" rx="2" fill="currentColor"/>'),
  smooth: svg('<path d="M3 13c2.5-6 4.5-6 7-1.5S15 15 17 7"/>'),
};
// The tools along the rail, left to right (the pen and the marker side by side, one button split in two)
export const TOOLS = [
  { mode: 'select', label: 'Select', key: 'V' },
  { mode: 'pen', label: 'Pen', key: 'P' },
  { mode: 'highlighter', label: 'Marker', key: 'M' },
  { mode: 'eraser', label: 'Eraser', key: 'E' },
  { mode: 'shapes', label: 'Shapes', key: 'S' },
  { mode: 'text', label: 'Text', key: 'T' },
];
const INKS = ['pen', 'highlighter'];
const KINDS = {
  ellipse: { label: 'Ellipse', key: 'O' },
  rect: { label: 'Rectangle', key: 'R' },
  line: { label: 'Line', key: 'L' },
  arrow: { label: 'Arrow', key: 'A' },
};
const swatch = (color, alpha = 1) =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="#fffaf0"/><circle cx="10" cy="10" r="7" fill="${color}" fill-opacity="${alpha}" stroke="rgba(42,35,82,.28)" stroke-width="1"/></svg>`;
// a width as a short line of it, in the tool's colour (scaled so the widest fits)
const widthIcon = (w, most, color, alpha = 1) =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12" stroke="${color}" stroke-opacity="${alpha}" stroke-width="${Math.max(1.4, (w / most) * 9)}" stroke-linecap="round"/></svg>`;
// the eraser's size as a ring that size (at most the button's)
const ringIcon = (d, most) =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="${Math.max(2, (d / most) * 8)}" fill="#fffaf0" stroke="currentColor" stroke-width="1.4"/></svg>`;

// The palette's state on st, from what this browser remembers
export function mountPalette(st) {
  const kept = store.get('book.tools', {});
  const index = (n, list) => (Number.isInteger(n) && n >= 0 && n < list.length ? n : 1);
  const ink = INKS.includes(kept.ink) ? kept.ink : 'pen';
  Object.assign(st, {
    mode: ink,
    ink,
    pen: PENS.some(p => p.color === kept.pen) ? kept.pen : PENS[0].color,
    marker: MARKERS.some(p => p.color === kept.marker) ? kept.marker : MARKERS[0].color,
    widths: {
      pen: index(kept.widths?.pen, WIDTHS.pen),
      highlighter: index(kept.widths?.highlighter, WIDTHS.highlighter),
    },
    eraser: index(kept.eraser, ERASERS),
    shape: SHAPES.includes(kept.shape) ? kept.shape : 'rect',
    fill: kept.fill === true,
    smooth: kept.smooth !== false,
    buttons: {},
  });
  makeIsland(st);
  keys(st);
  setMode(st, st.mode);
}
// The ink the tool draws with now: { color, size, alpha?, follow? } (page px)
export function inkOf(st) {
  if (st.mode === 'highlighter')
    return { color: st.marker, size: WIDTHS.highlighter[st.widths.highlighter], alpha: MARKER_ALPHA };
  return { color: st.pen, size: WIDTHS.pen[st.widths.pen], follow: st.smooth ? SMOOTH.on : SMOOTH.off };
}
// The eraser's radius on screen
export const eraserRadius = st => ERASERS[st.eraser] / 2;

// ---- the rail's tools

// The tools put first on the rail, before Undo and Redo (bookrail.js); the pen and the marker in a pair of their own
function makeIsland(st) {
  const el = island('tools'),
    pair = document.createElement('div');
  pair.className = 'bk-pair';
  pair.setAttribute('role', 'group');
  pair.setAttribute('aria-label', word('Pen and marker'));
  const own = TOOLS.map(t => {
    const b = button({
      icon: ICONS[t.mode],
      label: word(t.label),
      keys: t.key,
      pressed: false,
      // (the tool in use pressed again opens its card)
      onClick: () => (st.mode === t.mode ? card(st) : setMode(st, t.mode)),
    });
    b.dataset.mode = t.mode;
    if (t.mode !== 'select') b.setAttribute('aria-haspopup', 'true');
    st.buttons[t.mode] = b;
    if (!INKS.includes(t.mode)) return b;
    pair.append(b);
    return t.mode === 'pen' ? pair : null;
  });
  el.prepend(...own.filter(Boolean), document.createElement('hr'));
}

// (keep: what's picked stays picked, a Ctrl-held Select's tool back: booktools.js.)
export function setMode(st, mode, { keep = false } = {}) {
  if (!TOOLS.some(t => t.mode === mode)) return;
  const was = st.mode;
  st.mode = mode;
  if (INKS.includes(mode)) st.ink = mode;
  for (const [m, b] of Object.entries(st.buttons)) setPressed(b, m === mode);
  st.book.desk.dataset.tool = mode;
  if (st.card) closeCard(st);
  show(st);
  remember(st);
  if (was !== mode && !keep) st.changedTool?.(mode);
}
const inksOf = st => (st.mode === 'highlighter' ? MARKERS : PENS);
const colourOf = st => (st.mode === 'highlighter' ? st.marker : st.pen);
const coloured = st => !['select', 'eraser'].includes(st.mode);
const widthsOf = st => (st.mode === 'highlighter' ? 'highlighter' : 'pen');

function setColour(st, color) {
  if (st.mode === 'highlighter') st.marker = color;
  else {
    st.pen = color;
    st.texts.recolor(color);
  }
  changed(st);
}
const changed = st => {
  show(st);
  remember(st);
  if (st.card) fillCard(st);
};
// One step through a list of settings (a width, the eraser's size): by from where it is, within the list
function stepSize(st, by) {
  if (st.mode === 'eraser') st.eraser = Math.max(0, Math.min(ERASERS.length - 1, st.eraser + by));
  else if (coloured(st) && st.mode !== 'text') {
    const k = widthsOf(st);
    st.widths[k] = Math.max(0, Math.min(WIDTHS[k].length - 1, st.widths[k] + by));
  } else return false;
  changed(st);
  return true;
}

// The shapes' button as the settings are, the pen's and the marker's colours on their halves (a dot under the icon,
// bookstrip.css), and the cursor in the tool's colour and size
function show(st) {
  st.buttons.shapes.innerHTML = ICONS[st.shape];
  st.buttons.shapes.setAttribute('aria-label', word(`Shapes: ${KINDS[st.shape].label.toLowerCase()}`));
  st.buttons.pen.style.setProperty('--bk-dot', st.pen);
  st.buttons.highlighter.style.setProperty('--bk-dot', st.marker);
  st.book.desk.style.setProperty('--bk-tool-cursor', cursorOf(st, colourOf(st)));
}
function cursorOf(st, color) {
  if (st.mode === 'eraser') {
    const d = ERASERS[st.eraser],
      s = d + 4,
      c = s / 2;
    const ring = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><circle cx="${c}" cy="${c}" r="${d / 2}" fill="rgba(255,250,240,.35)" stroke="#fffaf0" stroke-width="2.5"/><circle cx="${c}" cy="${c}" r="${d / 2}" fill="none" stroke="#2a2352" stroke-opacity=".7" stroke-width="1"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(ring)}") ${c} ${c}`;
  }
  const svgCursor =
    st.mode === 'highlighter'
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="22"><rect x="2" y="2" width="10" height="18" rx="2" fill="${color}" fill-opacity=".6" stroke="#2a2352" stroke-opacity=".5"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="#fffaf0" stroke-width="2"/><circle cx="8" cy="8" r="5.5" fill="none" stroke="${color}" stroke-opacity=".55"/><circle cx="8" cy="8" r="2.2" fill="${color}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svgCursor)}") ${st.mode === 'highlighter' ? '7 11' : '8 8'}`;
}
const remember = st =>
  store.set('book.tools', {
    ink: st.ink,
    pen: st.pen,
    marker: st.marker,
    widths: st.widths,
    eraser: st.eraser,
    shape: st.shape,
    fill: st.fill,
    smooth: st.smooth,
  });

// ---- the tool's card, over the rail

function card(st) {
  if (st.card) return closeCard(st);
  if (st.mode === 'select') return;
  hide();
  const el = document.createElement('div');
  el.className = 'bk-card bk-palette';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', word(st.mode === 'eraser' ? 'Eraser size' : 'Colour and width'));
  st.opener = st.buttons[st.mode];
  st.opener.setAttribute('aria-expanded', 'true');
  st.card = el;
  fillCard(st);
  overRail(el);
  el.querySelector('[aria-pressed=true]')?.focus({ preventScroll: true });
  // (a press anywhere else, or Escape, closes it)
  st.away = e => {
    const own = el.contains(e.target) || st.opener.contains(e.target);
    if (e.type === 'keydown' ? e.key === 'Escape' : !own) closeCard(st);
  };
  addEventListener('pointerdown', st.away, true);
  addEventListener('keydown', st.away, true);
}
// The card's rows for the tool: a shape's kind and fill, the colours, the widths (the eraser: its sizes), smoothing
function fillCard(st) {
  const rows = [];
  if (st.mode === 'shapes') rows.push(...shapeRows(st));
  if (st.mode === 'eraser') rows.push(eraserRow(st));
  else rows.push(...inkRows(st));
  st.card.replaceChildren(...rows.flatMap((r, i) => (i ? [document.createElement('hr'), r] : [r])));
}
// A row of choices, each a button pressed when it's the one in use
function row(name, items) {
  const r = document.createElement('div');
  r.className = 'bk-palette-row';
  r.setAttribute('role', 'group');
  r.setAttribute('aria-label', word(name));
  for (const { icon, label, keys = '', on, pick } of items) {
    const b = button({ icon, label: word(label), keys, pressed: on, onClick: pick });
    b.setAttribute('role', 'menuitemradio');
    r.append(b);
  }
  return r;
}
const shapeRows = st => [
  row(
    'Shape',
    SHAPES.map(k => ({ icon: ICONS[k], ...KINDS[k], on: st.shape === k, pick: () => pickShape(st, k) })),
  ),
  row('Fill', [
    { icon: ICONS.outline, label: 'Outline', keys: 'F', on: !st.fill, pick: () => setFill(st, false) },
    { icon: ICONS.filled, label: 'Filled', keys: 'F', on: st.fill, pick: () => setFill(st, true) },
  ]),
];
const eraserRow = st =>
  row(
    'Size',
    ERASERS.map((d, i) => ({
      icon: ringIcon(d, ERASERS.at(-1)),
      label: ['Fine eraser', 'Eraser', 'Wide eraser'][i],
      keys: ['[', '', ']'][i],
      on: st.eraser === i,
      pick: () => ((st.eraser = i), changed(st)),
    })),
  );
// The colours; the widths but for typed words; the pen's smoothing
function inkRows(st) {
  const marker = st.mode === 'highlighter',
    k = widthsOf(st);
  const colours = row(
    'Colour',
    inksOf(st).map((ink, i) => ({
      icon: swatch(ink.color, marker ? 0.75 : 1),
      label: ink.name,
      keys: String(i + 1),
      on: ink.color === colourOf(st),
      pick: () => setColour(st, ink.color),
    })),
  );
  const widths = row(
    'Width',
    WIDTHS[k].map((w, i) => ({
      icon: widthIcon(w, WIDTHS[k].at(-1), colourOf(st), marker ? 0.6 : 1),
      label: ['Fine', 'Medium', 'Bold'][i],
      keys: ['[', '', ']'][i],
      on: st.widths[k] === i,
      pick: () => ((st.widths[k] = i), changed(st)),
    })),
  );
  const smooth = row('Smoothing', [
    {
      icon: ICONS.smooth,
      label: 'Smooth the line',
      on: st.smooth,
      pick: () => ((st.smooth = !st.smooth), changed(st)),
    },
  ]);
  return [colours, ...(st.mode === 'text' ? [] : [widths]), ...(st.mode === 'pen' ? [smooth] : [])];
}
function pickShape(st, kind) {
  st.shape = kind;
  if (st.mode !== 'shapes') setMode(st, 'shapes');
  changed(st);
}
function setFill(st, fill) {
  st.fill = fill;
  changed(st);
}
function closeCard(st) {
  st.card?.remove();
  st.card = null;
  st.opener?.setAttribute('aria-expanded', 'false');
  removeEventListener('pointerdown', st.away, true);
  removeEventListener('keydown', st.away, true);
}

// ---- keys

// The tools' keys while the book is open and has the pointer or the focus, never while a field has the keyboard: a
// tool's letter (V, P, M, E, S, T; O, R, L and A a shape), 1–4 a colour, [ and ] the width or the eraser's size, F a
// shape filled or not
function keys(st) {
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || !open()) return;
    if (e.composedPath()[0]?.closest?.('input, textarea, select, [contenteditable], review-mode')) return;
    const book = st.book.desk.closest('#book') ?? st.book.desk;
    if (!(book.matches(':hover') || book.contains(document.activeElement))) return;
    const key = e.key.toLowerCase(),
      tool = TOOLS.find(t => t.key.toLowerCase() === key),
      kind = SHAPES.find(k => KINDS[k].key.toLowerCase() === key),
      ink = inksOf(st)[Number(e.key) - 1];
    if (tool) setMode(st, tool.mode);
    else if (kind) pickShape(st, kind);
    else if (ink && coloured(st)) setColour(st, ink.color);
    else if (key === 'f' && st.mode === 'shapes') setFill(st, !st.fill);
    else if (!((key === '[' || key === ']') && stepSize(st, key === ']' ? 1 : -1))) return;
    e.preventDefault();
  });
}
const open = () => ['open', 'spread'].includes(document.documentElement.dataset.book);
