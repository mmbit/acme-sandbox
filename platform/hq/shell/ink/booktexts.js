// Words typed on a page of the book: a box placed at a point (the text tool, or a double click on the paper) with the
// caret in it, typed, kept as it's left, edited again by a click or by the pen (bookamend.js), moved by Select
// (bookselect.js), and gone once it's emptied. Each change is one step Undo takes back (book.steps). A page keeps them as texts: [{ x, y, w, text, color }],
// x and y the words' top-left and w the width they wrap at, in the page's px, saved with its ink (booksave.js) and set
// in its picture by the store (bookrender.ts: the same size, line and wrap). The boxes are the page's own elements, so
// the book's pan and zoom carry them.
//
// booktools.js routes a press to them: press(box, e) for a press on a box, place(at) for a new one.
import { wandered } from '/__review/tap.js';
import { followPress } from './bookpress.js';
import { button } from './bookui.js';
import { boxesOf } from './bookwords.js';
import { word } from './bookscope.js';
import { landing } from './bookgroupmath.js';
import { arrive } from './bookarrive.js';
import { footOf, pointUnit } from './bookunits.js';
import { UNIT_W } from './scrapunit.js';

// The words' size and line in page px (bookrender.ts TEXT), and the room round them inside the box, for the caret
export const TEXT = { size: 18, line: 1.4 };
const PAD = 4;
// a new box wraps at this width, or less where the paper shown ends sooner, never less than NARROW
const WIDE = 360,
  NARROW = 160;
// typed words keep this far in from their scrap's sides (page px)
const UNIT_PAD = 12;
// a press on a box draws once it has moved this far (screen px): less is a click, which edits it (a Pencil's: once it
// has gone past a tap, tap.js wandered)
const DRAG_PX = 3;

// book: bookpages.js's; hooks: { changed(page), color() (the pen's colour now) }
export function mountTexts(book, hooks) {
  const tx = { book, hooks, editing: null };
  return {
    // A view's boxes made again from its page's texts (the page shown, or read)
    added: view => drawAll(tx, view),
    // A press on a box not being edited: a drag over it draws, a click edits it. True: the box took it.
    press: (box, e) => pressed(tx, box, e),
    // A new box at a point of a page ({ view, x, y } in its px), the caret in it, its words wrapping before right
    place: (at, right) => place(tx, at, right),
    // Words put on a page whole, never opened for typing (pasted, dropped, heard): the first line at a point of a page
    // as place() takes it, or the boxes' middle there (centre), wrapping at a readable width before right (page px),
    // long words a box per run of paragraphs. One step Undo takes back. Returns the texts added.
    put: (at, words, right, { centre = false } = {}) => put(tx, at, words, right, centre),
    // A box edited, the caret at a point on screen ([clientX, clientY]), or at an index of its words
    edit: (box, at, index) => edit(tx, box, { at, index }),
    // A box's words made others (the pen's edits, bookamend.js): one step Undo takes back; emptied, the box goes.
    rewrite: (box, words) => rewrite(tx, box, words),
    // The box being typed in kept as it is (a press elsewhere, a key)
    done: () => tx.editing?.words.blur(),
    editing: () => !!tx.editing,
    // The colour picked while a box is being typed in is that box's
    recolor(color) {
      if (!tx.editing) return;
      tx.editing.el.style.color = color;
      tx.editing.color = color;
    },
  };
}

// ---- the boxes on a page

function drawAll(tx, view) {
  view.el.querySelectorAll(':scope > .bk-typed').forEach(el => el.remove());
  for (const t of view.page.texts) boxFor(tx, view, t);
}
// A box for one of a page's texts, in its place on the page
function boxFor(tx, view, t) {
  const el = document.createElement('div');
  el.className = 'bk-typed';
  el.innerHTML = '<div class="bk-typed-words"></div>';
  el.append(fixes(el));
  el.words = el.firstElementChild;
  el.typed = t;
  el.view = view;
  el.classList.toggle('bk-landing', landing(view.page, t));
  // (words stacked as a note, a call's promise or review mode's general note: a post-it, as a scrap's words are.
  if (view.page.groups?.get(t.g)?.kind === 'note') el.dataset.note = '';
  setBox(el, t);
  view.el.append(el);
  return el;
}
function setBox(el, t) {
  Object.assign(el.style, {
    left: `${t.x - PAD}px`,
    top: `${t.y - PAD}px`,
    width: `${t.w + 2 * PAD}px`,
    padding: `${PAD}px`,
    color: t.color,
  });
  el.words.textContent = t.text;
}

// ---- typing

// The keys a Pencil has no keyboard for, beside the box being typed in: delete the letter before the caret (or what's
// selected), and a space. Pressed, the words keep the focus and the caret.
function fixes(el) {
  const keys = document.createElement('span');
  keys.className = 'bk-typed-keys';
  const key = (label, icon, command, value) =>
    button({
      label,
      icon: svg(icon),
      onClick: () => el.words.isContentEditable && document.execCommand(command, false, value),
    });
  keys.append(key(word('Delete the letter before'), BACKSPACE, 'delete'), key(word('Space'), SPACE, 'insertText', ' '));
  // (their press is theirs: never the words' blur, the paper's pan or its ink)
  for (const type of ['pointerdown', 'mousedown', 'touchstart'])
    keys.addEventListener(type, e => {
      e.stopPropagation();
      if (type !== 'touchstart') e.preventDefault();
    });
  return keys;
}
const svg = body =>
  `<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const BACKSPACE = '<path d="M7 5h9v10H7l-4-5z"/><path d="m9.5 8 4 4m0-4-4 4"/>',
  SPACE = '<path d="M4 9v3h12V9"/>';

// A new box at the point: its first line's middle there, wrapping before right (page px), anywhere on the endless
// paper
function place(tx, { view, x, y }, right) {
  const w = Math.round(Math.max(NARROW, Math.min(WIDE, right - x)));
  const t = { x: round(x - 2), y: round(y - (TEXT.size * TEXT.line) / 2), w, text: '', color: '' };
  t.color = tx.hooks.color();
  edit(tx, boxFor(tx, view, t), { fresh: true });
}
// The box made editable with the caret in it (at a point on screen, else at its end); left, it's kept (commit)
function edit(tx, el, { fresh = false, at = null, index = null } = {}) {
  if (tx.editing?.el === el) return;
  tx.editing?.words.blur();
  const words = el.words,
    t = el.typed;
  const ed = (tx.editing = { el, words, fresh, color: t.color, was: { text: t.text, color: t.color } });
  el.dataset.editing = '';
  words.contentEditable = 'plaintext-only';
  // (a browser without plain-text editing still edits; its pasted styles are dropped as it's kept: innerText)
  if (words.contentEditable !== 'plaintext-only') words.contentEditable = 'true';
  words.focus({ preventScroll: true });
  caretAt(words, at, index);
  const keys = e => {
    // (the book's own keys never hear what's typed here)
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) words.blur();
  };
  words.addEventListener('keydown', keys);
  words.addEventListener(
    'blur',
    () => {
      words.removeEventListener('keydown', keys);
      words.removeAttribute('contenteditable');
      delete el.dataset.editing;
      if (tx.editing === ed) tx.editing = null;
      commit(tx, el, ed);
    },
    { once: true },
  );
}
function caretAt(words, at, index) {
  const sel = getSelection(),
    range = document.createRange();
  const pos = at && document.caretPositionFromPoint?.(at[0], at[1]);
  if (index !== null) range.setStart(words.firstChild ?? words, index);
  else if (pos && words.contains(pos.offsetNode)) range.setStart(pos.offsetNode, pos.offset);
  else {
    range.selectNodeContents(words);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
// What was typed kept: a new box with words joins its page, an emptied one leaves it, a changed one changes; each one
// step Undo takes back. Nothing changed: no step.
function commit(tx, el, ed) {
  const t = el.typed,
    page = el.view.page,
    text = el.words.innerText.replace(/\s+$/, '');
  if (ed.fresh && !text) return el.remove();
  if (!ed.fresh && text === ed.was.text && ed.color === ed.was.color) return setBox(el, t);
  Object.assign(t, { text, color: ed.color });
  const texts = page.texts;
  if (ed.fresh) {
    const { g, edge } = inUnit(page, t.x, t.y);
    // (under what's in its scrap already: never over another box)
    Object.assign(t, { g, w: Math.min(t.w, edge - t.x), y: Math.max(t.y, footOf(page, g)) });
    setBox(el, t);
    texts.push(t);
    page.blank = false;
    return step(tx, el.view, () => texts.splice(texts.indexOf(t), 1));
  }
  if (!text) {
    const i = texts.indexOf(t);
    texts.splice(i, 1);
    el.remove();
    return step(tx, el.view, () => texts.splice(i, 0, Object.assign(t, ed.was)));
  }
  setBox(el, t);
  step(tx, el.view, () => Object.assign(t, ed.was));
}
// A box's words made others, kept as a typed change is
function rewrite(tx, el, words) {
  const t = el.typed;
  el.words.textContent = words;
  commit(tx, el, { fresh: false, color: t.color, was: { text: t.text, color: t.color } });
}
// A change made: the page saved soon, and its step for Undo, after which the page's boxes are made again from its texts
function step(tx, view, undo) {
  tx.hooks.changed(view.page);
  tx.book.steps.push({
    undo: () => {
      tx.editing?.words.blur();
      undo();
      drawAll(tx, view);
      tx.hooks.changed(view.page);
    },
  });
}

// ---- a press

// A press on a box not being typed in: a click without a move edits it, the caret where it was clicked (a Pencil's
// tap); a drag over its words writes over them instead, as on the paper. (Select moves boxes: one way to move things.)
function pressed(tx, el, e) {
  if (el.dataset.editing !== undefined) return true; // (the words' own: the caret, a selection)
  e.preventDefault();
  let moved = false;
  const move = m => {
    if (moved || !far(e, m)) return;
    moved = true;
    inkFrom(tx, e, m);
  };
  const up = u => {
    if (!moved && u.type !== 'pointercancel') edit(tx, el, { at: [u.clientX, u.clientY] });
  };
  followPress(e, { move, up });
  return true;
}

// A drag over a box's words as a line on its page (the board's "Left mouse: draw", and the Pencil's): from where it
// pressed, so a line through the words strikes them out or slices them open (bookamend.js), and any other is ink. Not
// with Select, whose presses move what they pick.
function inkFrom(tx, down, m) {
  const { book } = tx,
    hit = book.at(down.clientX, down.clientY);
  if (!hit?.view.page.ink || book.desk.dataset.tool === 'select') return false;
  Object.assign(book, { target: hit.i, inking: book.tools.ink(), pointer: down.pointerType, waited: down });
  const started = book.ink.start(down);
  book.waited = null;
  if (started) book.ink.move(m);
  return started;
}

// (a Pencil's tap wobbles further than a mouse's click)
const far = (down, e) =>
  down.pointerType === 'pen'
    ? wandered(down, e)
    : Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) >= DRAG_PX;
const round = n => Math.round(n * 100) / 100;

// ---- words put on a page whole

// words put on a page wrap at most this wide (about 65 letters of the book's face at TEXT.size): longer lines are hard
// to read back
export const READ = 560;

function put(tx, { view, x, y }, words, right, centre) {
  const page = view.page,
    color = tx.hooks.color(),
    // (into the scrap the writing started on, or a new one, wrapped inside it: bookunits.js. job #14672)
    { g, left, edge } = inUnit(page, x, y);
  x = Math.max(left, Math.min(centre ? x - (edge - left) / 2 : x, edge - NARROW));
  right = edge;
  centre = false;
  const room = Math.max(NARROW, Math.min(READ, right - x));
  const texts = boxesOf(words).map(text => ({ x, y, w: room, text, color, g }));
  if (!texts.length) return texts;
  tx.editing?.words.blur();
  const boxes = texts.map(t => boxFor(tx, view, t)),
    w = Math.round(Math.min(room, Math.max(NARROW, widest(boxes[0].words, texts)))),
    line = TEXT.size * TEXT.line;
  // (each box's height as it wraps at w, a line apart, then the stack placed)
  const heights = boxes.map((el, i) => {
    setBox(el, Object.assign(texts[i], { w }));
    return Math.max(line, el.words.offsetHeight);
  });
  const tall = heights.reduce((sum, h) => sum + h, 0) + line * (texts.length - 1);
  // (under what's in its scrap already, a line apart: never over another box. job #14672)
  let top = Math.max(
    centre ? y - tall / 2 : y - line / 2,
    footOf(page, g) + (page.texts.some(t => t.g === g) ? line / 2 : 0),
  );
  texts.forEach((t, i) => {
    Object.assign(t, { x: round(centre ? x - w / 2 : x - 2), y: round(top) });
    setBox(boxes[i], t);
    top += heights[i] + line;
  });
  const shown = held => {
    page.texts.splice(0, page.texts.length, ...held);
    drawAll(tx, view);
    tx.hooks.changed(page);
  };
  const before = page.texts.slice();
  page.texts.push(...texts);
  page.blank = false;
  const after = page.texts.slice();
  tx.hooks.changed(page);
  tx.book.steps.push({ page, undo: () => shown(before), redo: () => shown(after) });
  arrive(tx.book, view, texts);
  return texts;
}
// The scrap a box written at x, y goes to (the one there, else a new one) and the room across it for words (page px)
function inUnit(page, x, y) {
  const g = pointUnit(page, x, y),
    o = page.origins?.get(g) ?? { x: 0 };
  return { g, left: o.x + UNIT_PAD, edge: o.x + UNIT_W - UNIT_PAD };
}
// The widest line of the words in a box's face (page px)
function widest(words, texts) {
  const g = document.createElement('canvas').getContext('2d');
  g.font = getComputedStyle(words).font;
  const lines = texts.flatMap(t => t.text.split('\n'));
  return Math.ceil(Math.max(...lines.map(l => g.measureText(l).width))) + 1;
}
