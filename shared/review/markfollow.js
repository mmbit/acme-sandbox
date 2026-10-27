// The Pencil's marks following HQ's page (pencil.js): drawn again as it scrolls, resizes or changes what it shows, and
// read again from the book when the page moves to another address or the book's sheets change.
import * as marks from './marks.js';
import { cutsWhenStill } from './markslips.js';

// On HQ one address shows many screens, and a mark shows only on its own (marks.js showsNow), so the marks are drawn
// again as soon as the page changes what it shows: what's in it, a part hidden or shown, a slide ending
export function followPage(r) {
  let queued = false;
  const again = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      marks.paint(r);
    });
  };
  const marked = () => r.marks.length || r.sent?.length;
  addEventListener('scroll', again, { capture: true, passive: true });
  addEventListener('resize', again);
  new MutationObserver(() => marked() && (again(), r.loaded())).observe(document.body, {
    ...{ childList: true, subtree: true },
    ...{ attributes: true, attributeFilter: ['hidden', 'class', 'open'] },
  });
  for (const type of ['transitionend', 'animationend']) addEventListener(type, () => marked() && again(), true);
  // an answer's place cut again once the page has settled, loaded, scrolled to it or shown its screen (markslips.js)
  r.loaded = cutsWhenStill(r);
  readAgain(r, marked, again);
}

// The page's notes read again: at another address, and whenever the book reads its sheets (a note moved, wiped or
// reordered there, a sheet sent, here or on another device: HQ's feed). Between marks: a read while one is being made
// waits for it to end (pencil.js unmark).
function readAgain(r, marked, again) {
  // (the book out of reach: the page keeps the marks it shows, and the console says why)
  const load = () => marks.load(r).catch(err => console.error("The Pencil: the book's marks", err));
  let url = location.pathname + location.search;
  setInterval(() => {
    const now = location.pathname + location.search;
    if (now !== url) {
      url = now;
      r.steps = []; // (what was done on the other page stays there)
      load();
    } else if (marked()) again(); // (HQ's own layout moves things too)
  }, 1000);
  load();
  addEventListener('pageshow', load);
  r.loadMarks = load;
  document.addEventListener('book:sheets', () => (r.mode === 'idle' ? load() : (r.marksStale = true)));
}
