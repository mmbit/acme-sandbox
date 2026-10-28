// The tips book: the book's hidden things (symbols, gestures, answers, controls), in a small black book of their own
// that the Tips button among the book's controls opens. Nothing pops up by itself and there's nothing to dismiss: the
// board opens it when it wants, and a tap anywhere outside it (the Tips button too) or Escape puts it away. It opens
// flat in the middle of the screen, open at its first tip: the contents on the left page, every tip by its part, and
// the tip chosen on the right, with a little scene that plays it (booktipslist.js). A contents line goes straight to
// its tip; the arrows, the arrow keys or a swipe go to the next or the one before. No page turns: the right page
// changes at once, its tip fading in, so nothing ever waits for an animation. On a phone the two pages take turns: the
// contents first, a tip on its own page, and Contents back. Reduced motion: each scene still. (the open book, no cover
// or turns)
import { esc, stylesheet } from '../util.js';
import { names } from './brand.js';
import { button, island, lineIcon, setPressed } from './ink/bookui.js';
import { PARTS, TIPS } from './booktipslist.js';
import { LOOP_S, STILL } from './booktipscene.js';

// a small open book, its pages lined
const ICON = lineIcon(
  '<path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5c-3.5-.5-6.5 0-8.5 1.5z"/><path d="M12 6.5v13"/>',
);
// The book coming up from the button and put away, and a tip fading in on its page: quick, and never in the way
const FADE_MS = 120,
  RISE_MS = 200,
  PUT_AWAY_MS = 180,
  EASE = 'cubic-bezier(.3,.7,.25,1)';
// a swipe: this far across, more across than down
const SWIPE_PX = 36;

let control, root, leaves, at; // at: the tip shown (0: the first)
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
      ${contents()}
      <div class="tb-page tb-tip">
        <button type="button" class="tb-home">‹ Contents</button>
        <div class="tb-leaves">${TIPS.map(leaf).join('')}</div>
        <div class="tb-turns"><button type="button" class="tb-back" aria-label="Previous tip">‹</button>
          <span class="tb-count"></span><button type="button" class="tb-on" aria-label="Next tip">›</button></div>
      </div>
    </div>`;
  document.getElementById('book').append(root);
  leaves = [...root.querySelectorAll('.tb-leaf')];
  show(0);
  setPressed(control, true);
  wire();
  const book = root.querySelector('.tb-book');
  if (still()) book.animate({ opacity: [0, 1] }, FADE_MS);
  else
    book.animate(
      { opacity: [0, 1], transform: ['translateY(16px) scale(.94)', 'none'] },
      { duration: RISE_MS, easing: EASE },
    );
  root.querySelector('.tb-contents [data-to]').focus({ preventScroll: true });
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

// ---- the pages

// The left page, the contents: the book's name, then the four parts, each tip a line that opens it on the right
const contents = () =>
  `<nav class="tb-page tb-contents" aria-label="Contents"><h2 class="tb-logo-small">${LOGO}<span>Tips</span></h2>${PARTS.map(
    part =>
      `<h3>${esc(part)}</h3><ol>${TIPS.map((t, i) => (t.part === part ? `<li><button type="button" data-to="${i}">${esc(t.title)}</button></li>` : '')).join('')}</ol>`,
  ).join('')}</nav>`;
const leaf = t =>
  `<section class="tb-leaf" hidden><p class="tb-part">${esc(t.part)}</p>${t.scene}<h3>${esc(t.title)}</h3><p class="tb-words">${esc(t.words)}</p></section>`;

// The book's name (brand.yaml's names: book) over the contents, the flowing line through its foot. A book without one
// has only Tips there.
const NAME = names.book;
const LOGO = NAME
  ? `<svg class="tb-logo" viewBox="0 0 300 150" role="img" aria-label="${esc(NAME)}"><text x="150" y="98" text-anchor="middle">${esc(NAME)}</text>
  <path d="M40 112C70 86 104 136 150 106S226 80 262 114" /></svg>`
  : '';

// A tip on the right page, its line in the contents marked, the others hidden
function show(n) {
  at = n;
  root.querySelector('.tb-count').textContent = `${n + 1} / ${TIPS.length}`;
  root.querySelector('.tb-back').disabled = n === 0;
  root.querySelector('.tb-on').disabled = n === leaves.length - 1;
  root.querySelectorAll('.tb-contents [data-to]').forEach(b => b.toggleAttribute('aria-current', +b.dataset.to === n));
  leaves.forEach((el, i) => {
    el.hidden = i !== n;
    play(el, i === n);
  });
}
// A tip's scene from its start, or held while its tip is hidden (reduced motion: still, done)
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

// To another tip, at once: the one going hides, the one coming fades in (a quick click overtakes the fade)
function turn(to) {
  if (!root || to < 0 || to >= leaves.length) return;
  reading(true);
  if (to === at) return;
  leaves[at].getAnimations().forEach(a => a.cancel());
  show(to);
  leaves[to].animate({ opacity: [0, 1] }, FADE_MS);
  leaves[to].scrollTop = 0;
}
// (a phone's book: the tip's page instead of the contents, or the contents back)
const reading = on => root.classList.toggle('tb-reading', on);

// ---- input: never held up by a fade under way

function wire() {
  const page = root.querySelector('.tb-tip');
  // (a click, not a press: a tap outside that lands on the Tips button under it only puts the book away)
  root.addEventListener('click', e => e.target === root && close());
  root.querySelector('.tb-back').addEventListener('click', () => turn(at - 1));
  root.querySelector('.tb-on').addEventListener('click', () => turn(at + 1));
  root.querySelector('.tb-home').addEventListener('click', home);
  root.querySelector('.tb-contents').addEventListener('click', e => {
    const to = e.target.closest('[data-to]');
    if (to) turn(+to.dataset.to);
  });
  // a swipe across the tip's page goes on or back. A tap on its outer half goes on, its inner half back
  let down = null;
  page.addEventListener('pointerdown', e => {
    down = e.target.closest('button') ? null : { x: e.clientX, y: e.clientY };
    // (a swipe ending outside the book is still this book's: its release is no tap on the backdrop)
    if (down) page.setPointerCapture(e.pointerId);
  });
  page.addEventListener('pointerup', e => {
    if (!down) return;
    const dx = e.clientX - down.x,
      dy = e.clientY - down.y;
    down = null;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) return turn(at + (dx < 0 ? 1 : -1));
    if (Math.hypot(dx, dy) > SWIPE_PX) return;
    const box = page.getBoundingClientRect();
    turn(at + (e.clientX > box.left + box.width / 2 ? 1 : -1));
  });
  page.addEventListener('pointercancel', () => (down = null));
  addEventListener('keydown', keys, true);
}
// Back to the contents: a phone's book shows them again, and the tip's line takes the focus
function home() {
  reading(false);
  root.querySelector(`.tb-contents [data-to="${at}"]`).focus({ preventScroll: false });
}
function keys(e) {
  if (e.key === 'Escape') close();
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') turn(at + 1);
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') turn(at - 1);
  else if (e.key === 'Home') home();
  else if (e.key === 'Tab') round(e.shiftKey ? -1 : 1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}
// Tab and Shift+Tab go round the book's own live controls, those showing (a modal: never onto the Notebook behind it)
function round(by) {
  const stops = [...root.querySelectorAll('button:enabled')].filter(el => el.offsetParent),
    i = stops.indexOf(document.activeElement);
  stops.at(i < 0 ? Math.min(by, 0) : (i + by) % stops.length).focus({ preventScroll: true });
}
