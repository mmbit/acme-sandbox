// The select tool's cut, copy, paste, duplicate and delete (bookselect.js), and its keys: Delete or Backspace, ⌘ or
// Ctrl with X, C, V, D (a duplicate a little down and right) and A (all on the page shown), Escape to let go, and the
// arrow keys to nudge (Shift: ten times as far). The bar beside the selection does the same with a Pencil or a finger,
// and a Pencil's tap on bare paper offers Paste.
//
// The clip is the book's own: what was copied, kept as it was. The system's clipboard gets a word that names it, so a
// paste takes the clip only while that word is still there: a picture copied since is booktape.js's to paste, and
// other words copied since are no paste here. A picture is on its page once (pagescraps.ts), so a pasted one is
// uploaded again for its page (booktape.js keepAgain), unless it was cut from that page and isn't back on it.
import { button, MOD } from './bookui.js';
import { sfx } from './audio.js';
import { keepAgain } from './booktape.js';
import { said } from './booksave.js';
import { mapBox, moveBy, movedScrap, movedStroke, movedText, movedThings, pasteAt, union } from './bookselectmath.js';
import { bounds, boxOfText, changed, choose, current, framed, letGo, redrawn, swapIn } from './bookselect.js';

// a duplicate lands this far (screen px) down and right of what it copies, as does a paste again on the same spot
const STEP_PX = 16;
// the Paste bubble goes after this long
const BUBBLE_MS = 5000;
// an arrow key nudges this far (page px; with Shift, BIG); a burst of nudges is one step, ended this long after the last
const NUDGE = 1,
  BIG = 10,
  NUDGE_MS = 700;
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const FIELD = 'input, textarea, select, [contenteditable], review-mode';

// sel: bookselect.js's. Returns { bar() (the bar beside a frame), offer([clientX, clientY]) (Paste there, when the
// clip holds something), away() (before a press: the bubble gone, a burst of nudges ended), settle() (the nudges ended) }
export function mountClip(sel) {
  const clip = { sel, held: null, word: '', again: null, nudging: null, bubble: null, key: null, last: null };
  keys(clip);
  clipboard(clip);
  following(clip);
  return {
    bar: () => barOf(clip),
    offer: at => offer(clip, at),
    away: () => {
      gone(clip);
      settle(clip);
    },
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
  sfx.tick();
  offered(clip);
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
  return remove(clip);
}
function remove(clip) {
  const { sel } = clip;
  if (!current(sel)) return false;
  const out = new Set([...sel.ink, ...sel.scraps, ...sel.texts]);
  changed(sel, sel.view, page => {
    for (const k of ['ink', 'scraps', 'texts']) page[k].splice(0, page[k].length, ...page[k].filter(x => !out.has(x)));
    return {};
  });
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
    const ink = from.ink.map(s => movedStroke(s, move)),
      scraps = from.scraps.map((s, i) => ({ ...movedScrap(s, move), ...files[i] })),
      texts = from.texts.map((t, i) => movedText(t, move, from.boxes[i]));
    p.ink.push(...ink);
    p.scraps.push(...scraps);
    p.texts.push(...texts);
    return { ink, scraps, texts };
  });
  sfx.land();
  return true;
}
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
    if (!(e.type === 'cut' ? cut(clip) : copy(clip))) return;
    e.clipboardData.setData('text/plain', clip.word);
    e.preventDefault();
  };
  document.addEventListener('copy', took);
  document.addEventListener('cut', took);
  document.addEventListener('paste', e => {
    if (!ours(clip, e)) return;
    clip.key = null;
    const pictures = [...(e.clipboardData?.files ?? [])].some(f => f.type.startsWith('image/'));
    if (pictures || !clip.held || e.clipboardData?.getData('text/plain') !== clip.word) return;
    e.preventDefault();
    paste(clip);
  });
}
// Safari fires no copy or cut while no words are selected, and no paste outside a field: a key whose event didn't come
// does its work itself, the clip's word put on the clipboard as it can
function later(clip, k) {
  clip.key = k;
  setTimeout(() => {
    if (clip.key !== k) return;
    clip.key = null;
    if (k === 'v') return paste(clip);
    if (k === 'c' ? copy(clip) : cut(clip)) copied(clip);
  });
}
// Where the pointer was last over the paper, for a paste
function following(clip) {
  const desk = clip.sel.book.desk;
  const seen = e => e.pointerType !== 'touch' && (clip.last = [e.clientX, e.clientY]);
  desk.addEventListener('pointermove', seen);
  desk.addEventListener('pointerdown', seen);
  // (a press anywhere but the Paste bubble sends it away)
  addEventListener('pointerdown', e => clip.bubble && e.target !== clip.bubble && gone(clip), true);
}

// ---- the bar and the bubble

// The bar beside the selection: Cut, Copy, Paste (once the clip holds something: copied, it shows), Duplicate and
// Delete, for a Pencil or a finger (a mouse has them too). Its touches are its own: never the paper's pan or ink,
// which would take their click. (Paste, its own touches)
function barOf(clip) {
  const bar = document.createElement('div');
  bar.className = 'bk-sel-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Selection');
  for (const type of ['pointerdown', 'touchstart', 'touchmove']) bar.addEventListener(type, e => e.stopPropagation());
  const acts = [
    ['Cut', `${MOD}+X`, () => cut(clip) && copied(clip)],
    ['Copy', `${MOD}+C`, () => copy(clip) && copied(clip)],
    ['Paste', `${MOD}+V`, () => pasteBeside(clip)],
    ['Duplicate', `${MOD}+D`, () => duplicate(clip)],
    ['Delete', 'Delete', () => remove(clip)],
  ];
  for (const [text, keys, act] of acts)
    bar.append(
      button({
        text,
        keys,
        onClick: () => {
          settle(clip);
          act();
        },
      }),
    );
  clip.pasting = bar.children[2];
  clip.pasting.hidden = !clip.held;
  return bar;
}
// Paste shown in the bar, coming in as Copy or Cut fills the clip
function offered(clip) {
  const b = clip.pasting;
  if (!b?.hidden) return;
  b.hidden = false;
  b.animate(
    [
      { opacity: 0, scale: 0.6 },
      { opacity: 1, scale: 1 },
    ],
    {
      duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180,
      easing: 'cubic-bezier(.2,.8,.3,1.3)',
    },
  );
}
// The clip pasted from the bar: a step down and right of what's picked, as Duplicate does
function pasteBeside(clip) {
  const { sel } = clip;
  if (!current(sel)) return paste(clip);
  const b = bounds(sel),
    d = STEP_PX / sel.book.scale;
  return paste(clip, clip.held, null, [(b.x0 + b.x1) / 2 + d, (b.y0 + b.y1) / 2 + d]);
}
// (copied by the bar or a key with no event: the clip's word on the system's clipboard too, so ⌘V knows it; a clipboard
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

// Paste offered where a Pencil tapped bare paper, when the clip holds something (booktape.js's bubble)
function offer(clip, [x, y]) {
  if (!clip.held) return;
  gone(clip);
  const { book } = clip.sel,
    box = book.paper.getBoundingClientRect(),
    on = book.at(x, y);
  const bubble = Object.assign(document.createElement('button'), {
    type: 'button',
    className: 'bk-paste',
    textContent: 'Paste',
  });
  Object.assign(bubble.style, { left: `${x - box.left}px`, top: `${y - box.top}px` });
  book.paper.append((clip.bubble = bubble));
  bubble.onclick = () => {
    gone(clip);
    paste(clip, clip.held, null, on && [on.x, on.y]);
  };
  bubble.timer = setTimeout(() => gone(clip), BUBBLE_MS);
}
function gone(clip) {
  clearTimeout(clip.bubble?.timer);
  clip.bubble?.remove();
  clip.bubble = null;
}
