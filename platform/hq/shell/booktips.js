// The tips book: the book's hidden things (symbols, gestures, answers, controls), in a small black book of their own
// that the Tips button among the book's controls opens. Nothing pops up by itself and there's nothing to dismiss: the
// board opens it when it wants, and a tap anywhere outside it (the Tips button too) or Escape puts it away. It opens on
// its cover, the book's name with its flowing line under it, which swings open onto the contents; a page a tip, each
// with a little scene that plays it (booktipslist.js). Pages turn by a swipe, a tap on the page's outer half, the
// arrows or the arrow keys, and a contents line goes straight to its tip. Every turn and swing can be overtaken at
// once: nothing waits for an animation. Reduced motion: a crossfade, and each scene still.
import { esc, stylesheet } from '../util.js';
import { names } from './brand.js';
import { button, island, lineIcon, setPressed } from './ink/bookui.js';
import { PARTS, TIPS } from './booktipslist.js';
import { LOOP_S, STILL } from './booktipscene.js';

// a small open book, its pages lined
const ICON = lineIcon(
  '<path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5c-3.5-.5-6.5 0-8.5 1.5z"/><path d="M12 6.5v13"/>',
);
// The cover's swing and a page's turn, quick (the book's own flip is about this). The cover shows COVER_MS first: long
// enough to see whose book it is, never in the way (it takes no input).
const COVER_MS = 260,
  SWING_MS = 420,
  TURN_MS = 300,
  FADE_MS = 140,
  RISE_MS = 200,
  PUT_AWAY_MS = 180,
  EASE = 'cubic-bezier(.3,.7,.25,1)';
// a swipe: this far across, more across than down
const SWIPE_PX = 36;

let control, root, leaves, at; // at: the leaf shown (0: the contents)
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// The Tips button in the book's island, under the pin
export function mountTips() {
  stylesheet('shell/booktips.css');
  control = button({ icon: ICON, label: 'Tips', onClick: () => (root ? close() : open()), pressed: false });
  control.classList.add('bk-tips');
  island('book').append(control);
}

function open() {
  root = document.createElement('div');
  root.className = 'tb';
  root.innerHTML = `<div class="tb-book" role="dialog" aria-modal="true" aria-label="Tips">
      <div class="tb-leaves">${contents()}${TIPS.map(leaf).join('')}</div>
      <div class="tb-cover" aria-hidden="true">${COVER}</div>
      <div class="tb-turns"><button type="button" class="tb-back" aria-label="Previous tip">‹</button>
        <span class="tb-count"></span><button type="button" class="tb-on" aria-label="Next tip">›</button></div>
    </div>`;
  document.getElementById('book').append(root);
  leaves = [...root.querySelectorAll('.tb-leaf')];
  at = 0;
  show(0);
  setPressed(control, true);
  wire();
  swing();
  root.querySelector('.tb-on').focus({ preventScroll: true });
}
function close() {
  if (!root) return;
  const going = root;
  root = null;
  setPressed(control, false);
  removeEventListener('keydown', keys, true);
  const book = going.querySelector('.tb-book');
  book.getAnimations({ subtree: true }).forEach(a => a.finish());
  const out = still()
    ? book.animate({ opacity: [1, 0] }, FADE_MS)
    : book.animate(
        { opacity: [1, 0], transform: ['none', 'translateY(12px) scale(.94)'] },
        { duration: PUT_AWAY_MS, easing: EASE },
      );
  going.style.pointerEvents = 'none';
  out.onfinish = () => going.remove();
  control.focus({ preventScroll: true });
}

// ---- the leaves

// The contents: the four parts, each tip a line that turns to it
const contents = () =>
  `<section class="tb-leaf tb-contents"><h2 class="tb-logo-small">${LOGO}<span>Tips</span></h2>${PARTS.map(
    part =>
      `<h3>${esc(part)}</h3><ol>${TIPS.map((t, i) => (t.part === part ? `<li><button type="button" data-to="${i + 1}">${esc(t.title)}</button></li>` : '')).join('')}</ol>`,
  ).join('')}</section>`;
const leaf = t =>
  `<section class="tb-leaf"><p class="tb-part">${esc(t.part)}</p>${t.scene}<h3>${esc(t.title)}</h3><p class="tb-words">${esc(t.words)}</p></section>`;

// The book's name (brand.yaml's names: book), the flowing line through its foot. A book without one has Tips for its
// name on the cover, and no name over its contents.
const NAME = names.book;
const logo = word =>
  `<svg class="tb-logo" viewBox="0 0 300 150" role="img" aria-label="${esc(word)}"><text x="150" y="98" text-anchor="middle">${esc(word)}</text>
  <path d="M40 112C70 86 104 136 150 106S226 80 262 114" /></svg>`;
const LOGO = NAME ? logo(NAME) : '';
const COVER = `<div class="tb-cover-face">${NAME ? `${LOGO}<p>Tips</p>` : logo('Tips')}</div><div class="tb-cover-back"></div>`;

// A leaf shown, the others put by: those before it turned over (to the left), those after under it
function show(n) {
  at = n;
  stack();
  root.querySelector('.tb-count').textContent = n ? `${n} / ${TIPS.length}` : 'Contents';
  root.querySelector('.tb-back').disabled = n === 0;
  root.querySelector('.tb-on').disabled = n === leaves.length - 1;
  leaves.forEach((el, i) => play(el, i === n));
}
// The leaves turned over or under, as at says
function stack() {
  leaves.forEach((el, i) => {
    el.classList.toggle('tb-over', i < at);
    el.toggleAttribute('inert', i !== at);
    el.style.zIndex = String(i < at ? i : leaves.length - i);
  });
}
// A leaf's scene from its start, or held while its leaf is put by (reduced motion: still, done)
function play(el, on) {
  const svg = el.querySelector('svg.tb-scene');
  if (!svg) return;
  if (!on || still()) {
    svg.pauseAnimations();
    return svg.setCurrentTime(LOOP_S * STILL);
  }
  svg.setCurrentTime(0);
  svg.unpauseAnimations();
}

// To another leaf: the one leaving turns over the spine (forward) or the one coming back turns down onto the page
function turn(to) {
  if (!root || to < 0 || to >= leaves.length || to === at) return;
  // (an overtaken turn's finish must not restack under this one)
  leaves.forEach(el =>
    el.getAnimations().forEach(a => {
      a.onfinish = null;
      a.finish();
    }),
  );
  const from = at;
  show(to);
  if (still()) return void leaves[to].animate({ opacity: [0, 1] }, FADE_MS);
  // (one leaf moves however far it goes: the one nearest the spine of the two)
  const moving = to > from ? leaves[from] : leaves[to],
    forward = to > from;
  moving.style.zIndex = String(leaves.length + 1);
  moving.animate(
    {
      transform: forward ? ['rotateY(0)', 'rotateY(-180deg)'] : ['rotateY(-180deg)', 'rotateY(0)'],
      filter: ['brightness(1)', 'brightness(.88)', 'brightness(1)'],
    },
    { duration: TURN_MS, easing: EASE },
  ).onfinish = () => root && stack();
}

// The cover swinging open about the book's left edge, the book coming up from the button
function swing() {
  const cover = root.querySelector('.tb-cover'),
    book = root.querySelector('.tb-book');
  if (still()) {
    cover.classList.add('tb-open');
    return book.animate({ opacity: [0, 1] }, FADE_MS);
  }
  book.animate(
    { opacity: [0, 1], transform: ['translateY(16px) scale(.9)', 'none'] },
    { duration: RISE_MS, easing: EASE },
  );
  cover.animate(
    { transform: ['rotateY(0)', 'rotateY(-180deg)'] },
    { duration: SWING_MS, delay: COVER_MS, easing: EASE, fill: 'backwards' },
  ).onfinish = () => cover.classList.add('tb-open');
}

// ---- input: never held up by a turn under way

function wire() {
  const book = root.querySelector('.tb-book');
  // (a click, not a press: a tap outside that lands on the Tips button under it only puts the book away)
  root.addEventListener('click', e => e.target === root && close());
  root.querySelector('.tb-back').addEventListener('click', () => turn(at - 1));
  root.querySelector('.tb-on').addEventListener('click', () => turn(at + 1));
  root.querySelector('.tb-contents').addEventListener('click', e => {
    const to = e.target.closest('[data-to]');
    if (to) turn(+to.dataset.to);
  });
  // a swipe across turns. A tap on a tip's outer half turns on, its inner half back
  let down = null;
  book.addEventListener('pointerdown', e => {
    down = e.target.closest('button') ? null : { x: e.clientX, y: e.clientY };
    // (a swipe ending outside the book is still this book's: its release is no tap on the backdrop)
    if (down) book.setPointerCapture(e.pointerId);
  });
  book.addEventListener('pointerup', e => {
    if (!down) return;
    const dx = e.clientX - down.x,
      dy = e.clientY - down.y;
    down = null;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) return turn(at + (dx < 0 ? 1 : -1));
    if (Math.hypot(dx, dy) > SWIPE_PX || !at) return;
    const box = book.getBoundingClientRect();
    turn(at + (e.clientX > box.left + box.width / 2 ? 1 : -1));
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
// Tab and Shift+Tab go round the book's own live controls (a modal: never onto the Notebook behind it)
function round(by) {
  const stops = [...root.querySelectorAll('button:enabled')].filter(el => !el.closest('[inert]')),
    i = stops.indexOf(document.activeElement);
  stops.at(i < 0 ? Math.min(by, 0) : (i + by) % stops.length).focus({ preventScroll: true });
}
