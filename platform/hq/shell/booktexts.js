// Words typed on a page of the book: a box placed at a point (the text tool, or a double click on the paper) with the
// caret in it, typed, kept as it's left, edited again by a click, moved by its grip or a drag, and gone once it's
// emptied. Each change is one step Undo takes back (book.steps). A page keeps them as texts: [{ x, y, w, text, color }],
// x and y the words' top-left and w the width they wrap at, in the page's px, saved with its ink (booksave.js) and set
// in its picture by the store (bookrender.ts: the same size, line and wrap). The boxes are the page's own elements, so
// the book's pan and zoom carry them.
//
// booktools.js routes a press to them: press(box, e) for a press on a box, place(at) for a new one.
import { wandered } from '/__review/tap.js';
import { followPress } from './bookpress.js';
import { button } from './bookui.js';

// The words' size and line in page px (bookrender.ts TEXT), and the room round them inside the box, for the caret
export const TEXT = { size: 18, line: 1.4 };
const PAD = 4;
// a new box wraps at this width, or less where the paper shown ends sooner, never less than NARROW
const WIDE = 360,
  NARROW = 160;
// a press on a box moves it once it has moved this far (screen px): less is a click, which edits it (a Pencil's: once
// it has gone past a tap, tap.js wandered)
const DRAG_PX = 3;

// book: bookpages.js's; hooks: { changed(page), color() (the pen's colour now) }
export function mountTexts(book, hooks) {
  const tx = { book, hooks, editing: null };
  return {
    // A view's boxes made again from its page's texts (the page shown, or read)
    added: view => drawAll(tx, view),
    // A press on a box: its grip or a box not being edited moves it, a click edits it. True: the box took it.
    press: (box, e) => pressed(tx, box, e),
    // A new box at a point of a page ({ view, x, y } in its px), the caret in it, its words wrapping before right
    place: (at, right) => place(tx, at, right),
    // A box edited, the caret at a point on screen ([clientX, clientY]).
    edit: (box, at) => edit(tx, box, { at }),
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
  el.insertAdjacentHTML('beforeend', '<i class="bk-typed-grip" aria-hidden="true"></i>');
  // (a Pencil on the grip moves the box: Apple's handwriting never takes that touch for words in the box.)
  el.lastElementChild.addEventListener('touchstart', e => stylus(e) && e.preventDefault(), { passive: false });
  el.append(fixes(el));
  el.words = el.firstElementChild;
  el.typed = t;
  el.view = view;
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

const stylus = e => [...e.changedTouches].some(t => t.touchType === 'stylus');

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
  keys.append(key('Delete the letter before', BACKSPACE, 'delete'), key('Space', SPACE, 'insertText', ' '));
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
function edit(tx, el, { fresh = false, at = null } = {}) {
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
  caretAt(words, at);
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
function caretAt(words, at) {
  const sel = getSelection(),
    range = document.createRange();
  const pos = at && document.caretPositionFromPoint?.(at[0], at[1]);
  if (pos && words.contains(pos.offsetNode)) range.setStart(pos.offsetNode, pos.offset);
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

// ---- moving

// A press on a box. Its grip, or the box when it isn't being typed in: it follows the pointer once it moves, and lands
// where it's let go (one step), anywhere on the endless paper; a click without a move edits it, the caret where it was
// clicked. (a Pencil's tap, and no stop at the page's top-left)
function pressed(tx, el, e) {
  const grip = !!e.target.closest('.bk-typed-grip');
  if (!grip && el.dataset.editing !== undefined) return true; // (the words' own: the caret, a selection)
  e.preventDefault();
  const t = el.typed,
    from = { x: t.x, y: t.y },
    scale = tx.book.scale || 1;
  let moved = false;
  const move = m => {
    const dx = (m.clientX - e.clientX) / scale,
      dy = (m.clientY - e.clientY) / scale;
    if (!moved && !far(e, m)) return;
    if (!moved) {
      moved = true;
      el.dataset.lifted = '';
    }
    el.style.left = `${from.x + dx - PAD}px`;
    el.style.top = `${from.y + dy - PAD}px`;
  };
  const up = u => {
    delete el.dataset.lifted;
    if (!moved) return grip || u.type === 'pointercancel' ? null : edit(tx, el, { at: [u.clientX, u.clientY] });
    const to = {
      x: round(from.x + (u.clientX - e.clientX) / scale),
      y: round(from.y + (u.clientY - e.clientY) / scale),
    };
    if (u.type === 'pointercancel') return setBox(el, t);
    Object.assign(t, to);
    setBox(el, t);
    step(tx, el.view, () => Object.assign(t, from));
  };
  followPress(e, { move, up });
  return true;
}

// (a Pencil's tap wobbles further than a mouse's click)
const far = (down, e) =>
  down.pointerType === 'pen'
    ? wandered(down, e)
    : Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) >= DRAG_PX;
const round = n => Math.round(n * 100) / 100;
