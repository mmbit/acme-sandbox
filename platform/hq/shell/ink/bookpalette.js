// The book's tools on their island (bookstrip.js): the pen (the marker the same tool: one button, showing the one in
// use), shapes, the eraser, Select and Text, and beside the island the tool's own card: what draws (the pen, the pencil, the brush or the marker), its colours, its line's width, the eraser's
// size, a shape's kind and whether it's filled, the pen's smoothing. The pencil and the brush are the pen's nibs, in
// its colours. The tool in use pressed again opens its card, the marker's way in from the pen (no long press on a
// tool); the keys a drawing app has do the same on a desktop. Every setting is remembered in this browser, and the book
// opens on the pen or the marker, whichever was last in use. (the pen one tool; the nibs and the card in lines. The
// card by a press again)
//
// st: booktools.js's state; this keeps st.mode and the settings on it, and calls st.changedTool(mode) when the tool
// changes.
import { store } from '../../util.js';
import { button, island, setPressed, hide, beside } from './bookui.js';
import { MARKERS, MARKER_ALPHA, PENCIL_ALPHA, SHAPES, WIDTHS } from './bookinkmath.js';
import { word } from './bookscope.js';
import { ICONS, INK_WORDS, swatch, widthIcon, ringIcon, cursorIcon } from './bookpaletteart.js';
// The pens' inks, from the book's own Night: review mode's pin offers the same
import { PENS } from '/__review/ink.js';

// The eraser's sizes (across, on screen: a fine one for a letter, a wide one for a line of them)
const ERASERS = [12, 28, 56];
// The pen's smoothing: how far each point goes towards the pointer (ink.js's follow): steady, or as the hand went
const SMOOTH = { on: 0.42, off: 0.75 };

// The tools down their island, in order (README, The book's frame): the pen, one tool with its card for what
// draws, its colour and its width (the pen and the marker one key: the one in use shows), then shapes, the eraser,
// Select and Text (the mic after it: bookvoice.js). Every word here, and every row's name, is a key of the guest words
// (notebookwords.js).
export const TOOLS = [
  { mode: 'pen', word: 'toolPen', key: 'P' },
  { mode: 'highlighter', word: 'toolMarker', key: 'M' },
  { mode: 'shapes', word: 'toolShapes', key: 'S' },
  { mode: 'eraser', word: 'toolEraser', key: 'E' },
  { mode: 'select', word: 'toolSelect', key: 'V' },
  { mode: 'text', word: 'toolText', key: 'T' },
];
const INKS = ['pen', 'highlighter'];
// The pen's nibs, in its card's first row before the marker: each its own widths (bookinkmath.js WIDTHS), the
// pencil's see-through. Only the pen's own line is a gesture (a scratch-out, a circle carried out to assign): the
// pencil's hatching and the brush's back and forth are drawing.
const NIBS = {
  pen: { word: 'toolPen' },
  pencil: { word: 'toolPencil', alpha: PENCIL_ALPHA },
  brush: { word: 'toolBrush' },
};
// (shapes: the Shapes button's name with the shape in use)
const KINDS = {
  ellipse: { word: 'shapeEllipse', shapes: 'shapesEllipse', key: 'O' },
  rect: { word: 'shapeRectangle', shapes: 'shapesRectangle', key: 'R' },
  line: { word: 'shapeLine', shapes: 'shapesLine', key: 'L' },
  arrow: { word: 'shapeArrow', shapes: 'shapesArrow', key: 'A' },
};
// The palette's state on st, from what this browser remembers
export function mountPalette(st) {
  const kept = store.get('book.tools', {});
  const index = (n, list) => (Number.isInteger(n) && n >= 0 && n < list.length ? n : 1);
  const ink = INKS.includes(kept.ink) ? kept.ink : 'pen';
  Object.assign(st, {
    mode: ink,
    ink,
    nib: kept.nib in NIBS ? kept.nib : 'pen',
    pen: PENS.some(p => p.color === kept.pen) ? kept.pen : PENS[0].color,
    marker: MARKERS.some(p => p.color === kept.marker) ? kept.marker : MARKERS[0].color,
    widths: {
      pen: index(kept.widths?.pen, WIDTHS.pen),
      pencil: index(kept.widths?.pencil, WIDTHS.pencil),
      brush: index(kept.widths?.brush, WIDTHS.brush),
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
// The ink the tool draws with now: { color, size, alpha?, follow? } (page px). Shapes and Text draw in the pen's
// own, as their cards' widths are (the nib in pen mode only)
export function inkOf(st) {
  if (st.mode === 'highlighter')
    return { color: st.marker, size: WIDTHS.highlighter[st.widths.highlighter], alpha: MARKER_ALPHA };
  const nib = nibOf(st),
    alpha = NIBS[nib].alpha;
  return {
    color: st.pen,
    size: WIDTHS[nib][st.widths[nib]],
    ...(alpha ? { alpha } : {}),
    follow: st.smooth ? SMOOTH.on : SMOOTH.off,
  };
}
// Whether a line drawn now may be a gesture: the pen's own nib's alone
export const gestures = st => st.mode === 'pen' && st.nib === 'pen';
// The eraser's radius on screen
export const eraserRadius = st => ERASERS[st.eraser] / 2;

// ---- the island's tools

// The tools on their island
function makeIsland(st) {
  const own = TOOLS.map(t => {
    const b = button({ icon: ICONS[t.mode], label: word(t.word), keys: t.key, pressed: false });
    b.dataset.mode = t.mode;
    if (t.mode !== 'select') b.setAttribute('aria-haspopup', 'true');
    st.buttons[t.mode] = b;
    pressing(st, b, t.mode);
    return b;
  });
  island('tools').prepend(...own);
}
// A tap picks the tool, or opens its card when it's in use. Nothing waits on a hold (board, the Ink 1.1 deck.)
function pressing(st, b, mode) {
  // (a long press on a phone is no context menu here)
  b.addEventListener('contextmenu', e => e.preventDefault());
  b.addEventListener('click', () => (st.mode === mode ? card(st) : setMode(st, mode)));
}

// (keep: what's picked stays picked, a Ctrl-held Select's tool back: booktools.js.)
export function setMode(st, mode, { keep = false } = {}) {
  if (!TOOLS.some(t => t.mode === mode)) return;
  const was = st.mode;
  st.mode = mode;
  if (INKS.includes(mode)) st.ink = mode;
  for (const [m, b] of Object.entries(st.buttons)) setPressed(b, m === mode);
  // (the ink not in use: in the pen's card, bookstrip.css)
  for (const m of INKS) st.buttons[m].toggleAttribute('data-spare', m !== st.ink);
  st.book.desk.dataset.tool = mode;
  if (st.card) closeCard(st);
  show(st);
  remember(st);
  if (was !== mode && !keep) st.changedTool?.(mode);
}
const inksOf = st => (st.mode === 'highlighter' ? MARKERS : PENS);
const colourOf = st => (st.mode === 'highlighter' ? st.marker : st.pen);
const coloured = st => !['select', 'eraser'].includes(st.mode);
// the nib drawing now: the one picked in pen mode, the pen's own for the other tools
const nibOf = st => (st.mode === 'pen' ? st.nib : 'pen');
const widthsOf = st => (st.mode === 'highlighter' ? 'highlighter' : nibOf(st));
// a colour's key: 1 to 9, then 0 (the colours after the tenth have none)
const colourKey = i => (i < 9 ? String(i + 1) : i === 9 ? '0' : '');

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

// The shapes' button and the pen's (its nib) as the settings are, the pen's and the marker's colours on their buttons
// (a dot under the icon, bookstrip.css), and the cursor in the tool's colour and size
function show(st) {
  st.buttons.shapes.innerHTML = ICONS[st.shape];
  st.buttons.shapes.setAttribute('aria-label', word(KINDS[st.shape].shapes));
  st.buttons.pen.innerHTML = ICONS[st.nib];
  st.buttons.pen.setAttribute('aria-label', word(NIBS[st.nib].word));
  st.buttons.pen.style.setProperty('--bk-dot', st.pen);
  st.buttons.highlighter.style.setProperty('--bk-dot', st.marker);
  st.book.desk.style.setProperty('--bk-tool-cursor', cursorIcon(st.mode, colourOf(st), ERASERS[st.eraser]));
}
const remember = st =>
  store.set('book.tools', {
    ink: st.ink,
    nib: st.nib,
    pen: st.pen,
    marker: st.marker,
    widths: st.widths,
    eraser: st.eraser,
    shape: st.shape,
    fill: st.fill,
    smooth: st.smooth,
  });

// ---- the tool's card, beside the tools

function card(st) {
  if (st.card) return closeCard(st);
  if (st.mode === 'select') return;
  hide();
  const el = document.createElement('div');
  el.className = 'bk-card bk-palette';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', word(st.mode === 'eraser' ? 'eraserSize' : 'colourAndWidth'));
  st.opener = st.buttons[st.mode];
  st.opener.setAttribute('aria-expanded', 'true');
  st.card = el;
  fillCard(st);
  beside(el, st.opener);
  el.querySelector('[aria-pressed=true]')?.focus({ preventScroll: true });
  // (a press anywhere else, or Escape, closes it)
  st.away = e => {
    const own = el.contains(e.target) || st.opener.contains(e.target);
    if (e.type === 'keydown' ? e.key === 'Escape' : !own) closeCard(st);
  };
  addEventListener('pointerdown', st.away, true);
  addEventListener('keydown', st.away, true);
}
// The card's lines, one under another, for the tool: what draws (the pen's nibs and the marker), a shape's kind and
// fill, the colours (six to a line), the widths (the eraser: its sizes) and smoothing. A rule between lines, and
// between two rows on one line.
function fillCard(st) {
  const lines = [];
  if (INKS.includes(st.mode)) lines.push([inkChoice(st)]);
  if (st.mode === 'shapes') lines.push(shapeLine(st));
  if (st.mode === 'eraser') lines.push([eraserRow(st)]);
  else lines.push(...inkLines(st));
  st.card.replaceChildren(
    ...ruled(
      lines.map(rows => {
        const line = document.createElement('div');
        line.className = 'bk-palette-line';
        line.append(...ruled(rows));
        return line;
      }),
    ),
  );
}
// the elements with a rule between each two
const ruled = els => els.flatMap((el, i) => (i ? [document.createElement('hr'), el] : [el]));
// A row of choices, each a button pressed when it's the one in use
function row(name, items) {
  const r = document.createElement('div');
  r.className = 'bk-palette-row';
  r.setAttribute('role', 'group');
  r.setAttribute('aria-label', word(name));
  for (const { icon, word: label, keys = '', on, pick } of items) {
    const b = button({ icon, label: word(label), keys, pressed: on, onClick: pick });
    b.setAttribute('role', 'menuitemradio');
    r.append(b);
  }
  return r;
}
// The pen's nibs, then the marker (the card opened again for the marker or back from it, as its colours are its own)
const inkChoice = st =>
  row('drawWith', [
    ...Object.entries(NIBS).map(([nib, { word }]) => ({
      icon: ICONS[nib],
      word,
      on: st.mode === 'pen' && st.nib === nib,
      pick: () => pickNib(st, nib),
    })),
    {
      icon: ICONS.highlighter,
      word: 'toolMarker',
      keys: 'M',
      on: st.mode === 'highlighter',
      pick: () => st.mode !== 'highlighter' && (setMode(st, 'highlighter'), card(st)),
    },
  ]);
function pickNib(st, nib) {
  st.nib = nib;
  if (st.mode !== 'pen') {
    setMode(st, 'pen');
    return card(st);
  }
  changed(st);
}
// The shapes' line: a shape's kind, and filled or not
const shapeLine = st => [
  row(
    'shape',
    SHAPES.map(k => ({ icon: ICONS[k], ...KINDS[k], on: st.shape === k, pick: () => pickShape(st, k) })),
  ),
  row('fill', [
    { icon: ICONS.outline, word: 'outline', keys: 'F', on: !st.fill, pick: () => setFill(st, false) },
    { icon: ICONS.filled, word: 'filled', keys: 'F', on: st.fill, pick: () => setFill(st, true) },
  ]),
];
const eraserRow = st =>
  row(
    'eraserSizes',
    ERASERS.map((d, i) => ({
      icon: ringIcon(d, ERASERS.at(-1)),
      word: ['fineEraser', 'toolEraser', 'wideEraser'][i],
      keys: ['[', '', ']'][i],
      on: st.eraser === i,
      pick: () => ((st.eraser = i), changed(st)),
    })),
  );
// The colours' line, six to a row; the widths' but for typed words, the pen's smoothing beside them
function inkLines(st) {
  const marker = st.mode === 'highlighter',
    k = widthsOf(st);
  const colours = row(
    'colour',
    inksOf(st).map((ink, i) => ({
      icon: swatch(ink.color, marker ? 0.75 : 1),
      word: INK_WORDS[ink.name],
      keys: colourKey(i),
      on: ink.color === colourOf(st),
      pick: () => setColour(st, ink.color),
    })),
  );
  colours.dataset.colours = '';
  const widths = row(
    'width',
    WIDTHS[k].map((w, i) => ({
      icon: widthIcon(w, WIDTHS[k].at(-1), colourOf(st), marker ? 0.6 : (NIBS[k].alpha ?? 1)),
      word: ['widthFine', 'widthMedium', 'widthBold'][i],
      keys: ['[', '', ']'][i],
      on: st.widths[k] === i,
      pick: () => ((st.widths[k] = i), changed(st)),
    })),
  );
  const smooth = row('smoothing', [
    {
      icon: ICONS.smooth,
      word: 'smoothLine',
      on: st.smooth,
      pick: () => ((st.smooth = !st.smooth), changed(st)),
    },
  ]);
  if (st.mode === 'text') return [[colours]];
  return [[colours], st.mode === 'pen' ? [widths, smooth] : [widths]];
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
// (its tooltip with it, or one left open stays over the paper)
function closeCard(st) {
  hide();
  st.card?.remove();
  st.card = null;
  st.opener?.setAttribute('aria-expanded', 'false');
  removeEventListener('pointerdown', st.away, true);
  removeEventListener('keydown', st.away, true);
}

// ---- keys

// The tools' keys while the book is open and has the pointer or the focus, never while a field has the keyboard: a
// tool's letter (V, P, M, E, S, T; O, R, L and A a shape), 1–9 and 0 a colour, [ and ] the width or the eraser's size,
// F a shape filled or not
function keys(st) {
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || !open()) return;
    if (e.composedPath()[0]?.closest?.('input, textarea, select, [contenteditable], review-mode')) return;
    const book = st.book.desk.closest('#book') ?? st.book.desk;
    if (!(book.matches(':hover') || book.contains(document.activeElement))) return;
    const key = e.key.toLowerCase(),
      tool = TOOLS.find(t => t.key.toLowerCase() === key),
      kind = SHAPES.find(k => KINDS[k].key.toLowerCase() === key),
      ink = inksOf(st).find((_, i) => colourKey(i) === e.key);
    if (tool) setMode(st, tool.mode);
    else if (kind) pickShape(st, kind);
    else if (ink && coloured(st)) setColour(st, ink.color);
    else if (key === 'f' && st.mode === 'shapes') setFill(st, !st.fill);
    else if (!((key === '[' || key === ']') && stepSize(st, key === ']' ? 1 : -1))) return;
    e.preventDefault();
  });
}
const open = () => ['open', 'spread'].includes(document.documentElement.dataset.book);
