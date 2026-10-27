// The mark being made following HQ's page (pencil.js): drawn again as the page scrolls or resizes under it, its lines on
// what they were drawn on (marks.js openLines). Only that mark: nothing of a note in the book is ever drawn on the page
// (rule zero, marks.js paint).
import * as marks from './marks.js';

export function followPage(r) {
  let queued = false;
  const again = () => {
    if (queued || (r.mode !== 'note' && !r.nextLines?.length)) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      marks.paint(r);
    });
  };
  addEventListener('scroll', again, { capture: true, passive: true });
  addEventListener('resize', again);
  // (what was done on another page stays there: its undo too)
  let url = location.pathname + location.search;
  setInterval(() => {
    const now = location.pathname + location.search;
    if (now === url) return;
    url = now;
    r.steps = [];
  }, 1000);
}
