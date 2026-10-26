// The answers on a sheet's notes in the book: each slip clipped on under its note (review mode's slip.js draws it, as
// on HQ's page), its tick box, the reply written under it, and a tick written over it with the Pencil. booksheet.js
// puts them in its notes.
import { CSS, isTick, slipHtml, slipUnder, tickBox, wireSlips } from '/__review/slip.js';
import { refreshRail } from './bookrail.js';
import { replySlip, tickSlip } from './booksheetdata.js';

// The slip's look, once in HQ's document (review mode's own copy lives in its shadow root)
const style = Object.assign(document.createElement('style'), { textContent: CSS });
document.head.append(style);

// A note's slips, under its words
export const slipsHtml = n => (n.slips ?? []).map(s => slipHtml(s, n)).join('');

// The slips on a page view wired to the store; a tick, or a reply, reads the sheets again (the faces' dot, the page)
export function wire(sh, slot) {
  wireSlips(slot, handlers(sh));
}
const handlers = sh => ({
  tick: async (id, ticked) => {
    await tickSlip(sh.dev, id, ticked);
    refreshRail();
  },
  reply: async (id, words) => {
    const answer = await replySlip(sh.dev, id, words);
    refreshRail();
    return answer;
  },
});

// A line drawn with the Pencil over a slip on a sheet page: a tick ticks it (taken back by Undo), and the sheet takes
// the line rather than keeping it as ink. Anything else stays ink.
export function tickLine(sh, v, stroke) {
  if (v.page.kind !== 'sheet' || !isTick(stroke.points)) return false;
  const at = v.el.getBoundingClientRect();
  const slips = [...v.el.querySelectorAll('.answer-slip')].map(el => {
    const r = el.getBoundingClientRect();
    return { el, x: r.left - at.left, y: r.top - at.top, w: r.width, h: r.height };
  });
  const hit = slipUnder(stroke.points, slips);
  if (!hit || hit.el.hasAttribute('data-ticked')) return false;
  const on = handlers(sh);
  const told = e => sh.tell(v.page, e);
  sh.book.steps.push({ undo: () => tickBox(hit.el, on, false).catch(told) });
  tickBox(hit.el, on, true).catch(told);
  return true;
}
