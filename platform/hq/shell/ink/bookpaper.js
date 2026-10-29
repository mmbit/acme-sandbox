// The Notebook's paper feel: quick stationery effects that play on a copy over everything, never on the thing itself.
// The change they show is already made underneath before they start, each returns at once, nothing waits on one (but
// what land() holds back till it's down), and no press is ever taken by one (bookpaper.css: the layer takes none). Each
// is over within about a third of a second, and with reduced motion each is a short crossfade.
//   crumple(rect, picture): what was deleted balls up and drops off
//   land(rect, picture, delay): what arrives is set down on the paper from just above, turning flat as it presses on
//     (a promise: done once it's down, its copy gone.)
//   fold(rect, picture, to): a page folds in half as it's shared, and goes into where it was shared (to, a box)
//   plane(rect, picture): a page sent folds into a paper plane and flies off
//   tear(sheet, fibres, ear): a page torn out of the book at its spine, the tear running down its edge
//   stamp(node, words): a rubber stamp pressed onto node ("Sent", "Approved"), its ink a little uneven
//   writing(node): node's words appear as if written letter by letter
// rect and to are boxes on the screen (getBoundingClientRect()); picture an element (a canvas, a copy of a page),
// taken over and removed once it has played.
import { crumpleOutline, letterStep, tornOutline } from './bookpapermath.js';

// how long each takes (ms): a crumple, a fold, a tear, a stamp, a letter's ink coming up, reduced motion's crossfade,
// and a landing (what's landing waits on it: bookarrive.js)
const CRUMPLE_MS = 340,
  FOLD_MS = 330,
  TEAR_MS = 260,
  STAMP_MS = 230,
  INK_MS = 90,
  FADE_MS = 140,
  PLANE_MS = 1000;
const FOLD_EASE = 'cubic-bezier(.4,0,.3,1)';
export const LAND_MS = 380;
// the ball a crumple ends as, at most this across (px), and how far it drops
const BALL_PX = 64,
  DROP_PX = 90;
// how far above the paper a landing starts (px), and its turn then at most (deg)
const LIFT_PX = 16,
  LAND_TURN = 3;

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

export function land(rect, picture, delay = 0) {
  if (!shows(rect)) return Promise.resolve();
  const shade = shadeOf(picture),
    sheet = sheetAt(rect, picture);
  sheet.classList.add('bk-fx-land');
  sheet.prepend(shade);
  if (still())
    return gone(
      sheet,
      sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, delay, fill: 'backwards' }),
    );
  const turn = (Math.random() < 0.5 ? -1 : 1) * LAND_TURN * (0.6 + 0.4 * Math.random()),
    timing = { duration: LAND_MS, delay, fill: 'backwards' };
  // (it comes down as a stamp is pressed, a touch too far, and back; its shadow under it closing in as it nears the paper)
  sheet.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 1 }], timing);
  shade.animate(
    [
      { translate: `0 ${LIFT_PX + 6}px`, opacity: 0.2, easing: 'cubic-bezier(.5,0,.9,.5)' },
      { translate: '0 2px', opacity: 0.3, offset: 0.55 },
      { translate: '0 0', opacity: 0 },
    ],
    timing,
  );
  const down = sheet.animate(
    [
      { transform: `translateY(${-LIFT_PX}px) scale(1.06) rotate(${turn}deg)`, easing: 'cubic-bezier(.5,0,.9,.5)' },
      { transform: `scale(0.985) rotate(${turn * -0.2}deg)`, offset: 0.55, easing: 'cubic-bezier(.3,.6,.5,1)' },
      { transform: `scale(1.004) rotate(${turn * 0.06}deg)`, offset: 0.8, easing: 'ease-in-out' },
      { transform: 'none' },
    ],
    timing,
  );
  return gone(sheet, down);
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

// (its top corners folded in to the middle, its sides in again to a dart, then it lifts, dips and flies off up and
// away; the folded paper shows its blank back, and a crease runs down its middle.)
export function plane(rect, picture) {
  if (!shows(rect)) return;
  const sheet = sheetAt(rect, picture);
  sheet.classList.add('bk-fx-plane');
  if (still()) return gone(sheet, fadeOut(sheet));
  const { width: w, height: h } = rect,
    // (where the folded corners meet the sides: as far down as the page is half wide, in % of its height)
    sy = Math.min(48, (w / 2 / h) * 100),
    // (the dart about 110 px long, and where it goes: off past the top right, along a curve)
    k = Math.min(0.5, 110 / h),
    to = { x: innerWidth + 80 - (rect.left + w / 2), y: -80 - (rect.top + h / 2) },
    heading = (Math.atan2(to.x, -to.y) * 180) / Math.PI;
  const page = points(0, 0, 50, 0, 100, 0, 100, 100, 50, 100, 0, 100),
    house = points(0, sy, 50, 0, 100, sy, 100, 100, 50, 100, 0, 100),
    dart = points(32, 50, 50, 0, 68, 50, 84, 100, 50, 92, 16, 100);
  const T = { duration: PLANE_MS, fill: 'forwards' },
    folds = [0.2, 0.4];
  const paper = creased(sheet, sy, T, folds);
  paper.animate(
    [
      { clipPath: page, easing: FOLD_EASE },
      { clipPath: house, offset: folds[0], easing: FOLD_EASE },
      { clipPath: dart, offset: folds[1] },
      { clipPath: dart },
    ],
    T,
  );
  const flight = (x, y, scale, turn) => `translate(${x}px, ${y}px) scale(${scale}) rotate(${turn}deg)`;
  const flown = sheet.animate(
    [
      { transform: 'none', easing: FOLD_EASE },
      { transform: flight(0, 0, (1 + k) / 2, 0), offset: folds[0], easing: 'ease-in-out' },
      { transform: flight(0, 0, k, 0), offset: folds[1], easing: 'ease-in-out' },
      // (it draws back a little, nose down, as a hand would before letting go)
      { transform: flight(-6, 14, k, heading - 20), offset: 0.52, easing: 'ease-in' },
      { transform: flight(to.x * 0.35, to.y * 0.2, k * 0.95, heading + 6), offset: 0.75 },
      { transform: flight(to.x, to.y, k * 0.75, heading), opacity: 1, offset: 0.97 },
      { transform: flight(to.x, to.y, k * 0.75, heading), opacity: 0 },
    ],
    T,
  );
  gone(sheet, flown);
}
// A plane's paper as it's made, the page's picture on it, which the folds clip (→ it): each top corner's flap, the
// page's back, from the fold line to the middle, then narrowed with the dart; the crease down its middle once it's a
// dart (T: the plane's timing, folds: when each fold's done)
function creased(sheet, sy, T, folds) {
  const paper = document.createElement('div');
  paper.className = 'bk-fx-paper';
  paper.append(...sheet.childNodes);
  paper.insertAdjacentHTML(
    'beforeend',
    '<i class="bk-fx-wing"></i><i class="bk-fx-wing"></i><svg class="bk-fx-keel" viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M50 2V90"/></svg>',
  );
  sheet.append(paper);
  const [left, right, keel] = paper.querySelectorAll('.bk-fx-wing, .bk-fx-keel');
  [left, right].forEach((wing, i) => {
    const x = v => (i ? 100 - v : v),
      narrow = points(50, 0, x(32), 50, 50, 92);
    wing.animate(
      [
        { clipPath: points(50, 0, x(0), sy, x(25), sy / 2), easing: FOLD_EASE },
        { clipPath: points(50, 0, x(0), sy, 50, sy), offset: folds[0], easing: FOLD_EASE },
        { clipPath: narrow, offset: folds[1] },
        { clipPath: narrow },
      ],
      T,
    );
  });
  keel.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1, offset: folds[1] }, { opacity: 1 }], T);
  return paper;
}
// A polygon of x, y pairs (in %)
const points = (...xy) => polygon(xy.flatMap((v, i) => (i % 2 ? [] : [[v, xy[i + 1]]])));

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
// A landing's shadow: its picture's shape, dark and soft
function shadeOf(picture) {
  const shade = Object.assign(document.createElement('canvas'), { width: picture.width, height: picture.height });
  shade.className = 'bk-fx-shade';
  shade.getContext('2d').drawImage(picture, 0, 0);
  return shade;
}
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
