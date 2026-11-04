// The select tool's cut, copy, paste, duplicate and delete (bookselect.js), and its keys: Delete or Backspace, ⌘ or
// Ctrl with X, C, V, D (a duplicate a little down and right) and A (all on the page shown), Escape to let go, and the
// arrow keys to nudge (Shift: ten times as far). The bar beside the selection duplicates, moves to another page and
// deletes with a Pencil or a finger; a tap on bare paper brings the Paste bubble for what a key copied
// (bookselectpaste.js).
//
// The clip is the book's own: what was copied, kept as it was. The system's clipboard gets a word that names it, so a
// paste takes the clip only while that word is still there: a picture copied since is booktape.js's to paste, and
// other words copied since are no paste here. A picture is on its page once (pagescraps.ts), so a pasted one is
// uploaded again for its page (booktape.js keepAgain), unless it was cut from that page and isn't back on it.
import { button, MOD } from './bookui.js';
import { icon } from '../icons.js';
import { carried } from './bookbrought.js';
import { sfx } from '../audio.js';
import { keepAgain } from './booktape.js';
import { mountTapPaste } from './bookselectpaste.js';
// (what's deleted balls up and falls away)
import { crumple } from './bookpaper.js';
import { thingsPicture } from './bookpaperdraw.js';
import { said, shut } from './booksave.js';
import { word } from './bookscope.js';
import { mapBox, moveBy, movedScrap, movedStroke, movedText, movedThings, pasteAt, union } from './bookselectmath.js';
import { bounds, boxOfText, changed, choose, current, framed, letGo, redrawn } from './bookselect.js';
import { swapIn } from './bookedit.js';
import { newCut } from './bookstrokes.js';

// a duplicate lands this far (screen px) down and right of what it copies, as does a paste again on the same spot
const STEP_PX = 16;
// an arrow key nudges this far (page px; with Shift, BIG); a burst of nudges is one step, ended this long after the last
const NUDGE = 1,
  BIG = 10,
  NUDGE_MS = 700;
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const FIELD = 'input, textarea, select, [contenteditable], review-mode';

// sel: bookselect.js's. Returns { bar() (the bar beside a frame), fit() (the bar fitted to what's picked), offer([clientX,
// clientY]) (the Paste bubble there: bookselectpaste.js), settle() (a burst of nudges ended) }
export function mountClip(sel) {
  const clip = { sel, held: null, word: '', again: null, nudging: null, key: null, last: null };
  keys(clip);
  clipboard(clip);
  following(clip);
  // (the bubble's Paste: the clip where the clipboard's words still name it, its middle on a point of the page shown)
  const tapped = mountTapPaste(sel, {
    named: got => named(clip, got),
    pasteAt: at => paste(clip, clip.held, null, at),
  });
  return {
    bar: () => barOf(clip),
    fit: () => fit(clip),
    offer: tapped.offer,
    settle: () => settle(clip),
  };
}

// ---- the actions

// What's picked kept in the clip as it is now (a picture with its file, words with their measured box)
function copy(clip) {
  const { sel } = clip;
  if (!current(sel)) return false;
  clip.held = { ...snapshot(sel), cut: false };
  clip.word = `book-selection-${Date.now().toString(36)}`;
  clip.again = null;
  return true;
}
const snapshot = sel => ({
  page: sel.view.page,
  ink: sel.ink.slice(),
  scraps: sel.scraps.map(s => ({ ...s })),
  // (a box of words is kept as a copy: booktexts.js changes its own in place as it's edited)
  texts: sel.texts.map(t => ({ ...t })),
  boxes: sel.texts.map(t => boxOfText(sel, t)),
  bounds: bounds(sel),
});
function cut(clip) {
  if (!copy(clip)) return false;
  clip.held.cut = true;
  return remove(clip, false);
}
// A copy or cut from a key, heard as it's taken
function taken(clip, cutting) {
  if (!(cutting ? cut(clip) : copy(clip))) return false;
  sfx.tick();
  return true;
}
// (deleted: it crumples; cut: it's kept in the clip. One whole group of a Notebook page goes as its clip's Delete does,
// Undo in a toast too: bookgroups.js)
function remove(clip, crumpled = true) {
  const { sel } = clip;
  if (!current(sel)) return false;
  const one = crumpled && lone(sel);
  if (one) {
    letGo(sel);
    one.remove();
    return true;
  }
  const out = new Set([...sel.ink, ...sel.scraps, ...sel.texts]);
  if (crumpled) crumple(...thingsPicture(sel.view, sel, bounds(sel), sel.book.scale));
  changed(sel, sel.view, page => {
    for (const k of ['ink', 'scraps', 'texts']) page[k].splice(0, page[k].length, ...page[k].filter(x => !out.has(x)));
    return {};
  });
  return true;
}
// One whole group of a Notebook page picked: what its clip's menu does (bookgroups.js lone); else null
const lone = sel => sel.book.groups?.lone(sel.view, sel) ?? null;
// What's picked moved to another page, from the menu of pages at the bar's button (from: bookgroups.js)
function move(clip, from) {
  const { sel } = clip,
    groups = sel.book.groups;
  if (!current(sel) || !groups?.movable(sel.view)) return false;
  groups.move(
    sel.view,
    { ink: sel.ink.slice(), scraps: sel.scraps.slice(), texts: sel.texts.slice(), box: bounds(sel) },
    from,
  );
  letGo(sel);
  return true;
}
// What's picked copied a step down and right, picked in its place
function duplicate(clip) {
  const { sel } = clip;
  if (!current(sel)) return false;
  const d = STEP_PX / sel.book.scale;
  paste(clip, { ...snapshot(sel), cut: false }, moveBy(d, d));
  return true;
}
function all(clip) {
  const { sel } = clip,
    view = sel.book.view(),
    page = view?.page;
  if (!page?.ink) return false;
  choose(sel, view, { ink: page.ink.slice(), scraps: page.scraps.slice(), texts: page.texts.slice() });
  return true;
}

// The clip on the page shown, moved by tr (else its middle where the pointer was last on the paper, else the middle of
// what the paper shows): one step once its pictures are kept for the page, and picked
async function paste(clip, from = clip.held, tr = null, at = null) {
  const { sel } = clip,
    { book } = sel,
    view = book.view(),
    page = view?.page;
  if (!from || !page?.ink) return false;
  const move = tr ?? placed(clip, from, at);
  let files;
  try {
    files = await Promise.all(from.scraps.map(s => fileFor(book, view, from, s)));
  } catch (e) {
    said(book, page, `That picture didn’t stay: ${e.message}`);
    return true;
  }
  // (the book turned to another page or day meanwhile)
  if (book.view() !== view) return true;
  settle(clip);
  changed(sel, view, p => {
    // (a copy is new: it finds its own group as it's saved, booksave.js. The copied pieces of a see-through stroke are
    // filled as one with each other, never with what they were copied from: a number of their own, bookstrokes.js.
    const cuts = new Map(),
      recut = s => (s.cut ? { ...s, cut: cuts.get(s.cut) ?? cuts.set(s.cut, newCut()).get(s.cut) } : s);
    const ink = from.ink.map(s => fresh(recut(movedStroke(s, move)))),
      scraps = from.scraps.map((s, i) => fresh({ ...movedScrap(s, move), ...files[i] })),
      texts = from.texts.map((t, i) => fresh(movedText(t, move, from.boxes[i])));
    p.ink.push(...ink);
    p.scraps.push(...scraps);
    p.texts.push(...texts);
    return { ink, scraps, texts };
  });
  sfx.land();
  return true;
}
const fresh = x => {
  const copy = { ...x };
  delete copy.g;
  return copy;
};
// Where a paste goes: its middle on the point asked, else where the pointer was last on the paper, else the paper's
// middle; a step on for each paste on the same spot
function placed(clip, from, at) {
  const { book } = clip.sel,
    last = clip.last && book.at(...clip.last),
    shown = book.shown(),
    p = at ?? (last ? [last.x, last.y] : [(shown.x0 + shown.x1) / 2, (shown.y0 + shown.y1) / 2]);
  const same = clip.again && Math.hypot(p[0] - clip.again.at[0], p[1] - clip.again.at[1]) < 1;
  clip.again = { at: p, n: same ? clip.again.n + 1 : 0 };
  return pasteAt(from.bounds, p, clip.again.n, STEP_PX / book.scale);
}
// A pasted picture's file: its own, cut from this page and not on it again; else a new one for the page
function fileFor(book, view, from, s) {
  if (!from.cut || from.page !== view.page || view.page.scraps.some(x => x.file === s.file))
    return keepAgain(book, view, s.url);
  from.cut = false;
  return { file: s.file, url: s.url };
}

// What's picked nudged by [dx, dy] page px, at once; a burst of nudges is one step, ended NUDGE_MS after the last or
// by anything else done
function nudge(clip, [dx, dy]) {
  const { sel } = clip;
  if (!current(sel)) return false;
  const view = sel.view,
    b = bounds(sel),
    tr = moveBy(dx, dy); // (anywhere)
  if (clip.nudging?.view !== view) settle(clip);
  clip.nudging ??= { view, change: sel.hooks.begin(view) };
  const swap = movedThings(sel, tr, t => boxOfText(sel, t));
  swapIn(view.page, swap);
  redrawn(sel, view, union(b, mapBox(tr, b)));
  for (const k of ['ink', 'scraps', 'texts']) sel[k] = sel[k].map(x => swap.get(x));
  framed(sel);
  clearTimeout(clip.nudging.timer);
  clip.nudging.timer = setTimeout(() => settle(clip), NUDGE_MS);
  return true;
}
function settle(clip) {
  const n = clip.nudging;
  if (!n) return;
  clearTimeout(n.timer);
  clip.nudging = null;
  n.change.end();
}

// ---- the keys and the clipboard

// The keys while the book is open in select mode and has the pointer or the focus, never while a field has the keyboard
// nor on a locked page
function keys(clip) {
  document.addEventListener('keydown', e => {
    if (e.altKey || !ours(clip, e)) return;
    const mod = e.metaKey || e.ctrlKey,
      k = e.key.toLowerCase(),
      { sel } = clip;
    if (mod && 'cxv'.includes(k) && k.length === 1) return later(clip, k);
    let done = false;
    if (mod && k === 'a') done = all(clip);
    else if (mod && k === 'd') done = duplicate(clip);
    else if (mod) return;
    else if (e.key === 'Escape') done = escape(sel);
    else if (e.key === 'Delete' || e.key === 'Backspace') done = remove(clip);
    else if (ARROWS[e.key])
      done = nudge(
        clip,
        ARROWS[e.key].map(d => d * (e.shiftKey ? BIG : NUDGE)),
      );
    if (!done) return;
    if (!ARROWS[e.key]) settle(clip);
    e.preventDefault();
  });
}
function escape(sel) {
  if (!sel.view) return false;
  letGo(sel);
  return true;
}
function ours(clip, e) {
  const desk = clip.sel.book.desk;
  if (desk.dataset.tool !== 'select' || !['open', 'spread'].includes(document.documentElement.dataset.book))
    return false;
  const page = clip.sel.book.view()?.page;
  if (!page || shut(page)) return false;
  if (e.composedPath()[0]?.closest?.(FIELD)) return false;
  const book = desk.closest('#book') ?? desk;
  return book.matches(':hover') || book.contains(document.activeElement);
}
// Copy, cut and paste as the document's own events, so the system's clipboard carries the clip's word, and a picture
// on it stays booktape.js's to paste
function clipboard(clip) {
  const took = e => {
    if (!ours(clip, e)) return;
    clip.key = null;
    if (!taken(clip, e.type === 'cut')) return;
    e.clipboardData.setData('text/plain', clip.word);
    e.preventDefault();
  };
  document.addEventListener('copy', took);
  document.addEventListener('cut', took);
  document.addEventListener('paste', e => {
    if (!ours(clip, e)) return;
    clip.key = null;
    if (!named(clip, carried(e.clipboardData))) return;
    e.preventDefault();
    paste(clip);
  });
}
// Whether what the clipboard holds ({ files, text }) is the clip: its word still there, and no picture copied since.
// ⌘V and the Paste bubble both ask this.
const named = (clip, { files, text }) =>
  !!clip.held && text === clip.word && !files.some(f => f.type.startsWith('image/'));
// Safari fires no copy or cut while no words are selected, and no paste outside a field: a key whose event didn't come
// does its work itself, the clip's word put on the clipboard as it can
function later(clip, k) {
  clip.key = k;
  setTimeout(() => {
    if (clip.key !== k) return;
    clip.key = null;
    if (k === 'v') return paste(clip);
    if (taken(clip, k !== 'c')) copied(clip);
  });
}
// Where the pointer was last over the paper, for a paste
function following(clip) {
  const desk = clip.sel.book.desk;
  const seen = e => e.pointerType !== 'touch' && (clip.last = [e.clientX, e.clientY]);
  desk.addEventListener('pointermove', seen);
  desk.addEventListener('pointerdown', seen);
}

// ---- the bar

// The bar beside the selection, one line of icons named for screen readers and tipped with their keys: Duplicate,
// Move to page… (on an open Notebook page: bookgroups.js) and Delete, for a Pencil or a finger (a mouse has them too).
// Duplicate is the copy and paste, Move to page and a drag the cut. Its
// touches are its own: never the paper's pan or ink, which would take their click.
function barOf(clip) {
  const bar = document.createElement('div');
  bar.className = 'bk-sel-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', word('selection'));
  for (const type of ['pointerdown', 'touchstart', 'touchmove']) bar.addEventListener(type, e => e.stopPropagation());
  const acts = [
    [icon('duplicate'), word('duplicate'), `${MOD}+D`, () => duplicate(clip)],
    [icon('move-to'), word('moveToPage'), '', b => move(clip, b)],
    [icon('bin'), word('delete'), 'Delete', () => remove(clip)],
  ];
  for (const [icon, label, keys, act] of acts)
    bar.append(
      button({
        icon,
        label,
        keys,
        onClick: e => {
          settle(clip);
          act(e.currentTarget);
        },
      }),
    );
  clip.moving = bar.children[1];
  return bar;
}
// Move to page… in the bar while what's picked can go to another page
function fit(clip) {
  clip.moving.hidden = !clip.sel.book.groups?.movable(clip.sel.view);
}
// (copied by a key with no event: the clip's word on the system's clipboard too, so ⌘V knows it; a clipboard
// that refuses it, the page says so, as ⌘V may then find other words there.)
const copied = clip =>
  navigator.clipboard
    ?.writeText(clip.word)
    .catch(e =>
      said(
        clip.sel.book,
        clip.held.page,
        `The copy didn’t reach the clipboard, so ${MOD}+V may not paste it: ${e.message}`,
      ),
    );
