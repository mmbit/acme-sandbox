// The Notebook's paper feel: quick stationery effects that play on a copy over everything, never on the thing itself.
// The change they show is already made underneath before they start, each returns at once, nothing waits on one, and
// no press is ever taken by one (bookpaper.css: the layer takes none). Each is over within about a third of a second,
// and with reduced motion each is a short crossfade.
//   crumple(rect, picture): what was deleted balls up and drops off
//   fold(rect, picture, to): a page folds in half as it's shared, and goes into where it was shared (to, a box)
//   tear(sheet, fibres, ear): a page torn out of the book at its spine, the tear running down its edge
//   stamp(node, words): a rubber stamp pressed onto node ("Sent", "Approved"), its ink a little uneven
//   writing(node): node's words appear as if written letter by letter
// rect and to are boxes on the screen (getBoundingClientRect()); picture an element (a canvas, a copy of a page),
// taken over and removed once it has played.
import { crumpleOutline, letterStep, tornOutline } from './bookpapermath.js';

// how long each takes (ms): a crumple, a fold, a tear, a stamp, a letter's ink coming up, reduced motion's crossfade
const CRUMPLE_MS = 340,
  FOLD_MS = 330,
  TEAR_MS = 260,
  STAMP_MS = 230,
  INK_MS = 90,
  FADE_MS = 140;
// the ball a crumple ends as, at most this across (px), and how far it drops
const BALL_PX = 64,
  DROP_PX = 90;

export function crumple(rect, picture) {
  if (!shows(rect)) return;
  const sheet = sheetAt(rect, picture);
  sheet.classList.add('bk-fx-scrap'); // (what's deleted torn out on its bit of paper)
  if (still()) return gone(sheet, fadeOut(sheet));
  const seed = Math.floor(Math.random() * 2 ** 31),
    outline = t => polygon(crumpleOutline(t, seed)),
    k = Math.min(1, BALL_PX / (0.46 * Math.max(rect.width, rect.height))),
    turn = Math.random() < 0.5 ? -1 : 1;
  sheet.insertAdjacentHTML('beforeend', `<svg class="bk-fx-creases" viewBox="0 0 100 100">${creases()}</svg>`);
  sheet.lastChild.animate([{ opacity: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 1 }], CRUMPLE_MS);
  const ball = sheet.animate(
    [
      { clipPath: outline(0), transform: 'none', easing: 'cubic-bezier(.3,.6,.5,1)' },
      { clipPath: outline(0.6), transform: `scale(${(1 + k) / 2}) rotate(${turn * 6}deg)`, offset: 0.25 },
      { clipPath: outline(1), transform: `scale(${k}) rotate(${turn * -10}deg)`, offset: 0.5, easing: 'ease-in' },
      {
        clipPath: outline(1),
        transform: `translateY(${DROP_PX}px) scale(${k * 0.9}) rotate(${turn * 40}deg)`,
        opacity: 0,
      },
    ],
    { duration: CRUMPLE_MS, fill: 'forwards' },
  );
  gone(sheet, ball);
}

export function fold(rect, picture, to = null) {
  if (!shows(rect)) return;
  const sheet = sheetAt(rect, picture);
  if (still()) return gone(sheet, fadeOut(sheet));
  // (its top half folds down over its bottom: the front shrinking to the crease, then its back coming down past it)
  sheet.insertAdjacentHTML('beforeend', '<i class="bk-fx-flap"></i>');
  picture.animate(
    [
      { clipPath: 'inset(0 0 0 0)', easing: 'ease-in' },
      { clipPath: 'inset(50% 0 0 0)', offset: 0.4 },
      { clipPath: 'inset(50% 0 0 0)' },
    ],
    { duration: FOLD_MS, fill: 'forwards' },
  );
  sheet.lastChild.animate(
    [
      { scale: '1 0' },
      { scale: '1 0', offset: 0.4, easing: 'ease-out' },
      { scale: '1 1', offset: 0.65 },
      { scale: '1 1' },
    ],
    { duration: FOLD_MS, fill: 'forwards' },
  );
  // (then the folded half goes into where it was shared, or up off the paper)
  const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.75 },
    end = to ? { x: to.left + to.width / 2, y: to.top + to.height / 2 } : { x: from.x, y: from.y - 80 },
    k = to ? Math.min(1, (to.width * 0.8) / rect.width) : 0.6,
    away = `translate(${end.x - from.x}px, ${end.y - from.y}px) scale(${k}) rotate(-6deg)`;
  sheet.style.transformOrigin = `50% 75%`;
  const flight = sheet.animate(
    [
      { transform: 'none' },
      { transform: 'none', offset: 0.6, easing: 'cubic-bezier(.5,0,.8,.6)' },
      { transform: away, opacity: 1, offset: 0.92 },
      { transform: away, opacity: 0 },
    ],
    { duration: FOLD_MS, fill: 'forwards' },
  );
  gone(sheet, flight);
}

// Unlike the others this one plays on the copy where it is (sheet, the page's copy, and fibres, a layer under it in
// the same box; ear: the px of its top-right corner turned down): it stays torn as it's carried, and never shows on
// the page itself, which stays whole in the book.
export function tear(sheet, fibres, ear = 0) {
  const { offsetWidth: w, offsetHeight: h } = sheet,
    seed = Math.floor(Math.random() * 2 ** 31),
    outline = (t, along) => polygon(tornOutline(w, h, { t, seed, ear, fibres: along === fibres }));
  for (const el of [sheet, fibres]) {
    el.style.clipPath = outline(1, el);
    if (!still())
      el.animate(
        [0, 0.35, 0.7, 1].map(t => ({ clipPath: outline(t, el) })),
        { duration: TEAR_MS, easing: 'ease-out' },
      );
  }
}

export function stamp(node, words) {
  if (words != null) node.textContent = words;
  node.classList.add('bk-stamped');
  if (still()) return void node.animate([{ opacity: 0 }, { opacity: 1 }], FADE_MS);
  // (pressed down from above at a slight turn, a touch too far, and back)
  node.animate(
    [
      { scale: '1.7', rotate: '-7deg', opacity: 0, easing: 'cubic-bezier(.5,0,.9,.5)' },
      { scale: '0.94', rotate: '0.5deg', opacity: 1, offset: 0.6 },
      { scale: '1', rotate: '0deg', opacity: 1 },
    ],
    STAMP_MS,
  );
}

export function writing(node) {
  if (still()) return void node.animate([{ opacity: 0 }, { opacity: 1 }], FADE_MS);
  const runs = [...textsIn(node)].map(text => ({ text, letters: lettersOf(text.data) })),
    step = letterStep(runs.reduce((n, r) => n + r.letters.filter(l => l.trim()).length, 0));
  if (!step) return;
  let i = 0;
  for (const run of runs) {
    run.spans = run.letters.map(letter => {
      const span = document.createElement('span');
      span.className = 'bk-writ';
      span.textContent = letter;
      if (letter.trim()) span.style.animationDelay = `${Math.round(i++ * step)}ms`;
      return span;
    });
    run.text.replaceWith(...run.spans);
  }
  // (written: the words are plain text again, as they were, wherever they still are)
  setTimeout(
    () => {
      for (const { text, spans } of runs) {
        const first = spans.find(s => s.isConnected);
        if (!first) continue;
        first.before(text);
        spans.forEach(s => s.remove());
      }
    },
    i * step + INK_MS,
  );
}

// ---- the layer the copies play on

// A copy laid over the screen at rect, picture filling it
function sheetAt(rect, picture) {
  const sheet = document.createElement('div');
  sheet.className = 'bk-fx-sheet';
  Object.assign(sheet.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  Object.assign(picture.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', margin: '0' });
  picture.style.removeProperty('left');
  picture.style.removeProperty('top');
  picture.style.removeProperty('rotate');
  sheet.append(picture);
  layer().append(sheet);
  return sheet;
}
// The layer over everything (the book's, or the page's without one), made once
function layer() {
  const home = document.getElementById('book') ?? document.body;
  let fx = home.querySelector(':scope > .bk-fx');
  if (!fx) {
    fx = document.createElement('div');
    fx.className = 'bk-fx';
    fx.setAttribute('aria-hidden', 'true');
    home.append(fx);
  }
  return fx;
}
const gone = (sheet, animation) =>
  animation.finished.then(
    () => sheet.remove(),
    () => sheet.remove(),
  );
const fadeOut = sheet => sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: 'forwards' });
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const shows = rect => rect && rect.width > 0 && rect.height > 0 && !document.hidden;
const polygon = points => `polygon(${points.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(', ')})`;
// A crumpled sheet's creases: a few straight folds across it, light beside dark
function creases() {
  return Array.from({ length: 9 }, () => {
    const at = () => (15 + Math.random() * 70).toFixed(1),
      line = `M${at()} ${at()}L${at()} ${at()}`;
    return `<path d="${line}" class="bk-fx-crease-light"/><path d="${line}" transform="translate(.8 .8)"/>`;
  }).join('');
}

// ---- writing's letters

// The text nodes under node that hold words
function* textsIn(node) {
  const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walk.nextNode()) if (walk.currentNode.data.trim()) texts.push(walk.currentNode);
  yield* texts;
}
// Words as the letters a reader sees (a symbol of several code points is one)
const letters =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const lettersOf = words => (letters ? [...letters.segment(words)].map(s => s.segment) : [...words]);
