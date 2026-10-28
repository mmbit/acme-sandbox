// An answer written in by a small pen once it's first seen: its words letter by letter, then its drawing stroke by
// stroke, the nib riding the line. Quick, and never in the way: it runs on animation frames, the page takes the pen
// and the fingers as ever, and an answer seen once (this tab's visit) is shown whole. Reduced motion: a crossfade.
import { NIB } from './bookanswerart.js';
import { lettersAt, writingMs } from './bookanswerpace.js';

// How long a drawing's strokes take all told, and one stroke at least
const DRAWING_MS = 1100,
  STROKE_MS = 90;
const SEEN_KEY = 'hq.ink.written';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// The answers written this visit, by id
const seen = new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]'));
const remember = id => {
  seen.add(String(id));
  sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
};

// An answer's element (.bk-answer) written in when it first shows on screen, or at once if it was seen before. Its
// words are .bk-answer-words's text; its drawing .bk-answer-ink's paths. data-written once the pen is done.
export function writeWhenSeen(el, id) {
  if (seen.has(String(id))) return written(el);
  hold(el);
  const watch = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    watch.disconnect();
    remember(id);
    if (reduced.matches) {
      el.classList.add('bk-answer-fade');
      return written(el);
    }
    write(el);
  });
  watch.observe(el);
}

// Whole, as written
function written(el) {
  const words = el.querySelector('.bk-answer-words');
  if (words?.dataset.text) words.querySelector('.bk-written').textContent = words.dataset.text;
  if (words) words.querySelector('.bk-rest').textContent = '';
  for (const path of el.querySelectorAll('.bk-answer-ink path')) path.style.strokeDashoffset = '0';
  el.querySelector('.bk-answer-pen')?.remove();
  el.toggleAttribute('data-written', true);
}
// Not yet written: its words kept as room (so nothing jumps), its strokes undrawn
function hold(el) {
  const words = el.querySelector('.bk-answer-words');
  if (words) {
    words.querySelector('.bk-written').textContent = '';
    words.querySelector('.bk-rest').textContent = words.dataset.text;
  }
  for (const path of el.querySelectorAll('.bk-answer-ink path')) {
    path.setAttribute('pathLength', '1');
    Object.assign(path.style, { strokeDasharray: '1', strokeDashoffset: '1' });
  }
}

// The pen at work: the words, then the strokes
function write(el) {
  el.insertAdjacentHTML('beforeend', NIB);
  const nib = el.querySelector('.bk-answer-pen'),
    words = el.querySelector('.bk-answer-words'),
    paths = [...el.querySelectorAll('.bk-answer-ink path')];
  const text = words?.dataset.text ?? '',
    wordsMs = writingMs([...text].length),
    lengths = paths.map(p => p.getTotalLength()),
    total = lengths.reduce((a, b) => a + b, 0),
    strokeMs = lengths.map(l => (total ? Math.max(STROKE_MS, (l / total) * DRAWING_MS) : 0));
  const start = performance.now();
  const frame = now => {
    if (!el.isConnected) return;
    const ms = now - start;
    if (words && ms <= wordsMs) letters(words, nib, el, lettersAt(ms, [...text].length));
    else if (words && !words.dataset.done) {
      letters(words, nib, el, [...text].length);
      words.dataset.done = '';
    }
    let left = ms - wordsMs,
      drawing = false;
    for (const [i, path] of paths.entries()) {
      const f = Math.min(1, Math.max(0, left / strokeMs[i]));
      path.style.strokeDashoffset = String(1 - f);
      if (f > 0 && f < 1 && !drawing) {
        drawing = true;
        nibOn(nib, el, path, path.getPointAtLength(f * lengths[i]));
      }
      left -= strokeMs[i];
    }
    if (left < 0 || drawing) return void requestAnimationFrame(frame);
    written(el);
  };
  requestAnimationFrame(frame);
}
// The first n letters written, the rest held as room, and the nib at the caret
function letters(words, nib, el, n) {
  const chars = [...words.dataset.text];
  words.querySelector('.bk-written').textContent = chars.slice(0, n).join('');
  words.querySelector('.bk-rest').textContent = chars.slice(n).join('');
  const caret = words.querySelector('.bk-caret'),
    at = el.getBoundingClientRect(),
    c = caret.getBoundingClientRect(),
    k = at.width / el.offsetWidth || 1;
  place(nib, (c.left - at.left) / k, (c.bottom - at.top) / k - 4);
}
// The nib on a stroke being drawn, at a point in the drawing's px
function nibOn(nib, el, path, point) {
  const svg = path.ownerSVGElement,
    box = svg.getBoundingClientRect(),
    at = el.getBoundingClientRect(),
    k = at.width / el.offsetWidth || 1;
  place(nib, (box.left - at.left) / k + point.x, (box.top - at.top) / k + point.y);
}
const place = (nib, x, y) => (nib.style.translate = `${x}px ${y - nib.clientHeight}px`);
