// The tips book: what Ink can do (booktipslist.js), in a real book of its own that the Tips button among the
// notebook's controls opens. Nothing pops up by itself and there's nothing to dismiss: the board opens it when it
// wants, and a tap outside it (the Tips button too) or Escape puts it away. It comes up shut in the middle of the
// screen, a hard cover, and the cover swings open by itself onto the first spread: the title inside the cover, the
// index on the right. Every tip after it is a spread in the Ink deck's look: its chapter's chip, plain title and words
// on the left page, the deck's picture or motion study of it on the right (drawn the deck's way where it had none).
// The corners' ‹ and ›, a swipe or the arrow keys turn a leaf, printed on both sides, over the spine; an index line
// turns straight to its tip, and Contents back to the index. Back from the first spread the cover closes. On a phone
// the book is one page wide: a spread's two pages stand one above the other and a leaf turns over the spine just off
// the screen's left. Nothing waits for a turn: a new one finishes the last at once. Reduced motion: crossfades, and
// every film still on its poster.
import { esc, stylesheet } from '../util.js';
import { names } from './brand.js';
import { foley } from './audio.js';
import { button, island, lineIcon, setPressed } from './ink/bookui.js';
import { PARTS, TIPS } from './booktipslist.js';

// a small open book, its pages lined
const ICON = lineIcon(
  '<path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5c-3.5-.5-6.5 0-8.5 1.5z"/><path d="M12 6.5v13"/>',
);
// The book coming up from the button and put away, a leaf's turn and the cover's (heavier, slower), and reduced
// motion's crossfade: quick, and never in the way
const RISE_MS = 220,
  PUT_AWAY_MS = 180,
  TURN = { ms: 460, easing: 'cubic-bezier(.45,.05,.3,1)' },
  COVER = { ms: 640, easing: 'cubic-bezier(.5,.08,.25,1)' },
  FADE_MS = 140,
  EASE = 'cubic-bezier(.3,.7,.25,1)';
// a swipe: this far across, more across than down
const SWIPE_PX = 36;
// One page wide (a phone): the same width as the stylesheet's
const NARROW = '(max-width: 639px)';

// at: the spread shown (-1: shut, its cover; 0: the title and the index; 1 on: a tip each). turning: the turn's
// animation under way, which the next turn or putting the book away finishes at once
let control, root, book, spreads, at, turning;
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrow = () => matchMedia(NARROW).matches;
const LAST = TIPS.length;

// The Tips button in the notebook's island, under the pin
export function mountTips() {
  stylesheet('shell/booktips.css');
  stylesheet('shell/booktipsturn.css');
  control = button({ icon: ICON, label: 'Tips', onClick: () => (root ? close() : open()), pressed: false });
  control.classList.add('bk-tips');
  island('book').append(control);
}

function open() {
  root = document.createElement('div');
  root.className = 'tb';
  root.innerHTML = `<div class="tb-book tb-shut" role="dialog" aria-modal="true" aria-label="Tips" tabindex="-1">
      <div class="tb-spreads">${first()}${TIPS.map(spread).join('')}</div>
      ${cover()}
      <div class="tb-foot">
        <button type="button" class="tb-back" aria-label="Turn back">‹</button>
        <button type="button" class="tb-home">Contents</button>
        <span class="tb-count"></span>
        <button type="button" class="tb-on" aria-label="Turn on">›</button>
      </div>
    </div>`;
  document.getElementById('book').append(root);
  book = root.querySelector('.tb-book');
  spreads = [...root.querySelectorAll('.tb-spread')];
  show(-1);
  setPressed(control, true);
  wire();
  book.focus({ preventScroll: true });
  const rise = still()
    ? book.animate({ opacity: [0, 1] }, FADE_MS)
    : book.animate(
        { opacity: [0, 1], translate: ['0 18px', '0 0'], scale: [0.94, 1] },
        { duration: RISE_MS, easing: EASE },
      );
  // up, the cover opens by itself (anything pressed first turns it at once)
  rise.finished.then(() => root && at === -1 && turn(0));
}
function close() {
  if (!root) return;
  const going = root,
    shut = going.querySelector('.tb-book');
  root = null;
  turning?.finish();
  setPressed(control, false);
  removeEventListener('keydown', keys, true);
  shut.getAnimations({ subtree: true }).forEach(a => a.finish());
  const out = still()
    ? shut.animate({ opacity: [1, 0] }, FADE_MS)
    : shut.animate(
        { opacity: [1, 0], translate: ['0 0', '0 14px'], scale: [1, 0.94] },
        { duration: PUT_AWAY_MS, easing: EASE },
      );
  going.style.pointerEvents = 'none';
  out.onfinish = () => going.remove();
  control.focus({ preventScroll: true });
}

// ---- the pages

// The cover: black cloth, the book's name and Tips pressed in gold, a ribbon out at its foot (a book without a name:
// Tips alone)
const cover = () =>
  `<button type="button" class="tb-cover" aria-label="Open the tips book"><span class="tb-cover-frame">
    ${NAME ? `<span class="tb-cover-kicker">${esc(NAME)}</span>` : ''}<span class="tb-cover-title">Tips</span>
    <svg class="tb-cover-line" viewBox="0 0 220 24" aria-hidden="true"><path d="M8 16C40 4 70 22 110 12S180 4 212 14"/></svg>
    ${NAME ? `<span class="tb-cover-sub">What ${esc(NAME)} can do</span>` : ''}</span><i class="tb-ribbon"></i></button>`;

// The first spread: the title inside the cover, the index on the right, every tip by its chapter with its spread's
// number
function first() {
  const index = PARTS.map(
    p =>
      `<h3 style="--tb-accent:${p.accent}">${esc(p.name)}</h3><ol>${TIPS.map((t, i) =>
        t.part === p.name
          ? `<li><button type="button" data-to="${i + 1}"><span>${esc(t.title)}</span><b>${i + 1}</b></button></li>`
          : '',
      ).join('')}</ol>`,
  ).join('');
  return `<section class="tb-spread" data-n="0">
    <div class="tb-page tb-l tb-title">${LOGO}<h2>Tips</h2><p class="tb-intro">${NAME ? `What ${esc(NAME)} can do, one` : 'One'} thing a spread.</p>
      <p class="tb-how">Turn a page by its corner, a swipe or the arrow keys. Tap a line of the index to go straight to it.</p></div>
    <nav class="tb-page tb-r tb-index" aria-label="Index"><h2>Index</h2>${index}</nav></section>`;
}
// A tip's spread: its chapter, title and words on the left, its picture or film on the right (theme/hq/tips/: the
// deck's, booktipslist.js)
const spread = (t, i) => {
  const part = PARTS.find(p => p.name === t.part);
  return `<section class="tb-spread" data-n="${i + 1}" style="--tb-accent:${part.accent}" hidden>
    <div class="tb-page tb-l tb-words-page"><p class="tb-kicker">${esc(t.part)}</p><h2>${esc(t.title)}</h2>
      <p class="tb-words">${esc(t.words)}</p></div>
    <div class="tb-page tb-r tb-shot-page"><figure class="tb-shot">${shot(t)}</figure></div></section>`;
};
// (a picture never dragged: a swipe across it turns the leaf)
const shot = t =>
  t.film
    ? `<video src="tips/${t.film}.mp4" poster="tips/${t.film}.jpg" muted loop playsinline preload="none" aria-label="${esc(t.alt)}"></video>`
    : `<img src="tips/${t.picture}.jpg" alt="${esc(t.alt)}" loading="lazy" decoding="async" draggable="false">`;

// The book's name (brand.yaml's names: book) on the cover and over the title, the flowing line through its foot, and
// in both their lines under Tips. A book without one has only Tips there.
const NAME = names.book;
const LOGO = NAME
  ? `<svg class="tb-logo" viewBox="0 0 300 150" role="img" aria-label="${esc(NAME)}"><text x="150" y="98" text-anchor="middle">${esc(NAME)}</text>
  <path d="M40 112C70 86 104 136 150 106S226 80 262 114" /></svg>`
  : '';

// The book as it is at a spread: shut on its cover, or open at the spread, its film playing and the rest held
function show(n) {
  at = n;
  book.classList.toggle('tb-shut', n < 0);
  spreads.forEach((el, i) => {
    el.hidden = i !== n;
    play(el, i === n);
  });
  root.querySelector('.tb-count').textContent = n > 0 ? `${n} / ${LAST}` : '';
  root.querySelector('.tb-back').disabled = n < 0;
  root.querySelector('.tb-on').disabled = n === LAST;
  root.querySelector('.tb-back').setAttribute('aria-label', n === 0 ? 'Close the cover' : 'Turn back');
  root.querySelector('.tb-home').hidden = n <= 0;
  root.querySelector('.tb-cover').hidden = n >= 0;
  spreads[n]?.querySelectorAll('.tb-page').forEach(p => (p.scrollTop = 0));
  if (spreads[n]) spreads[n].scrollTop = 0;
}
// A tip's film from its start, or held while its spread is away (reduced motion: never started, its poster)
function play(el, on) {
  const film = el.querySelector('video');
  if (!film) return;
  film.autoplay = on && !still();
  if (film.autoplay) film.load();
  else film.pause();
}

// ---- turning

// To another spread: the book is there at once, and a picture of the leaf turns over it. Forward the right-hand
// leaf turns over the spine to the left, the next spread's left page printed on its back; back, the left-hand leaf
// turns the other way. A phone's one page: the leaf turns away over the spine off the screen, or back onto the page.
// Opening or closing the cover is the same turn, heavier, the book sliding to keep itself in the middle.
function turn(to) {
  if (!root || to < -1 || to > LAST || to === at) return;
  turning?.finish();
  const from = at,
    was = sides(from);
  show(to);
  const now = sides(to),
    cover = from < 0 || to < 0,
    t = { dir: to > from ? 1 : -1, pace: cover ? COVER : TURN, layers: [], anims: [], hidden: [] };
  t.add = (node, side) => (node.classList.add(`tb-over-${side}`), book.append(node), t.layers.push(node), node);
  foley('flip', { material: 'paper', dur: t.pace.ms / 1000 }, { vol: cover ? 0.4 : 0.3 });
  if (still()) {
    // the spread that was, fading out over the one that is
    const shown = narrow() ? { page: was.page } : { l: was.l, r: was.r };
    for (const [side, el] of Object.entries(shown)) if (el) t.anims.push(fade(t.add(copy(el), side)));
  } else if (narrow()) turnPage(t, was, now);
  else {
    turnLeaf(t, was, now);
    if (cover) slide(t, to);
  }
  const done = () => {
    t.layers.forEach(n => n.remove());
    t.hidden.forEach(el => (el.style.visibility = ''));
    if (turning === running) turning = null;
  };
  const running = { finish: () => (t.anims.forEach(a => a.finish()), done()) };
  turning = running;
  Promise.all(t.anims.map(a => a.finished)).finally(done);
}
// A spread's leaf: forward, the left page that was stays till the leaf lands on it; the leaf is the right page that
// was, the new left page on its back. Back: the mirror of it
function turnLeaf(t, was, now) {
  const [stay, lift] = t.dir > 0 ? ['l', 'r'] : ['r', 'l'],
    opts = { duration: t.pace.ms, easing: t.pace.easing, fill: 'both' };
  if (was[stay]) t.add(copy(was[stay]), stay);
  else if (now[stay]) {
    // (opening the cover: nothing on the left till the cover lands there)
    now[stay].style.visibility = 'hidden';
    t.hidden.push(now[stay]);
  }
  const leaf = t.add(leafOf(was[lift], now[stay]), lift);
  t.anims.push(
    leaf.animate([{ transform: 'rotateY(0deg)' }, { transform: `rotateY(${t.dir > 0 ? -180 : 180}deg)` }], opts),
    ...[...leaf.querySelectorAll('.tb-shade')].map((s, i) => s.animate({ opacity: i ? [0.45, 0] : [0, 0.45] }, opts)),
  );
}
// A phone's leaf: the page that was turning away over the spine; back, the page coming back onto the one that was
function turnPage(t, was, now) {
  if (t.dir < 0) t.add(copy(was.page), 'page');
  const leaf = t.add(leafOf(t.dir > 0 ? was.page : now.page), 'page');
  const frames = [
    { transform: 'rotateY(0deg)', opacity: 1 },
    { transform: 'rotateY(-100deg)', opacity: 0.2 },
  ];
  t.anims.push(
    leaf.animate(frames, {
      duration: t.pace.ms,
      easing: t.pace.easing,
      fill: 'both',
      direction: t.dir > 0 ? 'normal' : 'reverse',
    }),
  );
}
// Opening or closing the cover, the book sliding with it: shut, it's slid by half a page and the cover's board (the
// stylesheet's .tb-shut), so the cover alone is in the middle
function slide(t, to) {
  const shut = `${-(book.offsetWidth / 4 + parseFloat(getComputedStyle(book).getPropertyValue('--tb-board')) / 2)}px 0`;
  t.anims.push(book.animate({ translate: to < 0 ? ['0 0', shut] : [shut, '0 0'] }, t.pace));
}
// A spread's sides: its left and right pages (shut: the cover on the right), and on a phone the one page
function sides(n) {
  const cov = root.querySelector('.tb-cover');
  if (n < 0) return { l: null, r: cov, page: cov };
  const s = spreads[n];
  return { l: s.querySelector('.tb-l'), r: s.querySelector('.tb-r'), page: s };
}
// A picture of a page as it shows now: its parts copied, its film held at the frame it's at, taking no presses
function copy(el) {
  const c = el.cloneNode(true);
  c.hidden = false;
  c.style.visibility = '';
  c.removeAttribute('id');
  c.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  c.inert = true;
  c.setAttribute('aria-hidden', 'true');
  const films = el.querySelectorAll('video');
  c.querySelectorAll('video').forEach((film, i) => {
    film.autoplay = false;
    film.preload = 'auto';
    film.currentTime = films[i].currentTime;
  });
  if (el.scrollTop) queueMicrotask(() => (c.scrollTop = el.scrollTop));
  return c;
}
// A leaf: the page turning on its front, on its back the page it brings (none on a phone's), each shaded as it turns
// from the light
function leafOf(front, back) {
  const leaf = document.createElement('div');
  leaf.className = 'tb-leaf';
  for (const [el, side] of [
    [front, 'front'],
    [back, 'back'],
  ]) {
    if (!el) continue;
    const face = document.createElement('div');
    face.className = `tb-side tb-side-${side}`;
    face.append(copy(el), Object.assign(document.createElement('i'), { className: 'tb-shade' }));
    leaf.append(face);
  }
  return leaf;
}
const fade = el => el.animate({ opacity: [1, 0] }, { duration: FADE_MS, fill: 'both' });

// ---- input: never held up by a turn under way

function wire() {
  // (a click, not a press: a tap outside that lands on the Tips button under it only puts the book away)
  root.addEventListener('click', e => e.target === root && close());
  root.querySelector('.tb-back').addEventListener('click', () => turn(at - 1));
  root.querySelector('.tb-on').addEventListener('click', () => turn(at + 1));
  root.querySelector('.tb-home').addEventListener('click', () => turn(0));
  root.querySelector('.tb-cover').addEventListener('click', () => turn(0));
  root.querySelector('.tb-index').addEventListener('click', e => {
    const to = e.target.closest('[data-to]');
    if (to) turn(+to.dataset.to);
  });
  // a swipe across the book turns a leaf: right to left on, left to right back
  let down = null;
  book.addEventListener('pointerdown', e => {
    const cov = e.target.closest('.tb-cover');
    down = e.target.closest('button') && !cov ? null : { x: e.clientX, y: e.clientY, cov };
    // (a swipe ending outside the book is still this book's: its release is no tap on the backdrop)
    if (down) book.setPointerCapture(e.pointerId);
  });
  book.addEventListener('pointerup', e => {
    if (!down) return;
    const dx = e.clientX - down.x,
      dy = e.clientY - down.y,
      was = down;
    down = null;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) turn(at + (dx < 0 ? 1 : -1));
    // (the cover's tap: its click goes to the book, which holds the pointer)
    else if (was.cov) turn(0);
  });
  book.addEventListener('pointercancel', () => (down = null));
  addEventListener('keydown', keys, true);
}
function keys(e) {
  if (e.key === 'Escape') close();
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') turn(at + 1);
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') turn(at - 1);
  else if (e.key === 'Home') turn(0);
  else if (e.key === 'Tab') round(e.shiftKey ? -1 : 1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}
// Tab and Shift+Tab go round the book's own live controls, those showing (a modal: never onto the notebook behind it)
function round(by) {
  const stops = [...book.querySelectorAll('button:enabled')].filter(
      el => el.offsetParent && !el.closest('[inert], .tb-leaf') && getComputedStyle(el).visibility !== 'hidden',
    ),
    i = stops.indexOf(document.activeElement);
  stops.at(i < 0 ? Math.min(by, 0) : (i + by) % stops.length).focus({ preventScroll: true });
}
