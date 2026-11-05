// A voice note's words on the page as they're heard (bookvoice.js): written on a slip of paper at the spot it was held,
// the slip a voice note lands as (booktexts.js, its text marked voice), placed and wrapped as they'll land (booktexts.js
// spotFor), so nothing moves when they do, in the pen's ink and the book's face. After the words, while the press is
// held, a few bars of the same ink move with the voice; let go, they settle low and breathe in turn till the last
// words are in (README, A voice note at a spot). Only the moment's: the words land as a page's own slip
// (book.tape.words) and this goes.
import { NARROW, PAD, setBox, spotFor } from './booktexts.js';

// the bars after the words, and how often they take the voice's level (ms): each a moment behind the one nearer the
// middle, so the voice runs out from it
const BARS = 5,
  STEP_MS = 70;
// each bar's share of the level, the middle one's whole
const SHAPE = [0.55, 0.8, 1, 0.8, 0.55];
// let go, the bars settle this long (ms: bookvoice.css's bars) before they breathe
const SETTLE_MS = 360;
const LOADER = `<span class="bk-bars" aria-hidden="true">${'<i></i>'.repeat(BARS)}</span>`;

// spot: { view, x, y }, a point on a view's page; color: the pen's. Returns { heard(words), level(lvl), held(), gone() }
export function heardAt({ view, x, y }, color) {
  const el = document.createElement('div');
  el.className = 'bk-heard';
  el.dataset.listening = '';
  el.dataset.voice = '';
  el.setAttribute('role', 'status');
  el.innerHTML = '<div class="bk-typed-words"></div>';
  el.words = el.firstElementChild;
  const at = spotFor(view.page, { x, y });
  setBox(el, { ...at, text: '', color });
  // (the slip as wide as its words, from the narrowest a box of them lands at up to where they wrap: booktexts.js put)
  Object.assign(el.style, { width: 'max-content', minWidth: `${NARROW + 2 * PAD}px`, maxWidth: `${at.w + 2 * PAD}px` });
  el.words.innerHTML = `<span></span>${LOADER}`;
  const said = el.words.firstElementChild,
    bars = barsOf(el);
  let over = false;
  view.el.append(el);
  return {
    // every word so far: the new ones ink in
    heard(words) {
      const was = said.textContent;
      if (over || words === was) return;
      if (words.startsWith(was) && was) {
        const fresh = document.createElement('span');
        fresh.className = 'bk-heard-new';
        fresh.textContent = words.slice(was.length);
        said.replaceChildren(was, fresh);
      } else said.textContent = words;
    },
    level: lvl => el.dataset.listening === undefined || bars.level(lvl),
    // the press let go: the bars settle, then wait on the last words
    held() {
      delete el.dataset.listening;
      bars.settle();
      setTimeout(() => over || (el.dataset.waiting = ''), SETTLE_MS);
    },
    gone() {
      over = true;
      el.remove();
    },
  };
}

// The slip's bars: level(lvl), the voice's level now (0 to 1, heard as the ear hears it: its root), taken by the middle
// bar, the others taking what the ones inside them had; settle(), all of them low
function barsOf(el) {
  const bars = [...el.querySelectorAll('.bk-bars i')],
    // (the levels taken, newest first, and when the last was)
    levels = Array(Math.ceil(BARS / 2)).fill(0);
  let took = 0;
  return {
    level(lvl) {
      const now = performance.now();
      if (now - took < STEP_MS) return;
      took = now;
      levels.unshift(0.4 * levels[0] + 0.6 * Math.sqrt(Math.min(1, Number(lvl) || 0)));
      levels.length = Math.ceil(BARS / 2);
      bars.forEach((b, i) => b.style.setProperty('--h', String(SHAPE[i] * levels[Math.abs(i - (BARS >> 1))])));
    },
    settle: () => bars.forEach(b => b.style.removeProperty('--h')),
  };
}
