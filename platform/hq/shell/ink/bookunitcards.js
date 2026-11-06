// A notebook page's cards as bookunits.js lays them: its later days' dates, and a card for every scrap, each its
// paper as tall as its card, what hangs under each moved to its foot. (The title and the day of what's showing are the
// view's, bookviewhead.js)
import { bodyIn, onCard } from './bookunits.js';
import { meets } from './bookselectmath.js';
import { dayWords } from './bookhead.js';
import { esc } from '../../util.js';
import { hangUnder } from './bookunder.js';

// (the room between the seen mark and what was read, page px.)
const SEEN_GAP = 10;
// Words the board reads (a heading, a date), marked so a minimised call covers as little of them as it can: by their own
// box, not the page-wide line.
const seen = words => `<span data-keep-in-sight>${esc(words)}</span>`;
// The page's later days' dates, and a card for every scrap, what hangs under each moved to its foot.
export function drawCards(view) {
  const page = view.page;
  let layer = view.el.querySelector(':scope > .bk-units');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'bk-units';
    view.el.prepend(layer);
  }
  // (one kind of scrap: every unit its paper, as tall as its card, no room under it to drag. An opened scrap is its own
  // sheet: bookscrapopen.js.)
  layer.style.height = `${page.h}px`;
  // (a unit 0 tall has nothing on it but what hangs under it, and no card: bookunits.js.)
  layer.innerHTML = `${page.headers.map(h => dayHtml(page, h)).join('')}${page.places
    .filter(p => p.h)
    .map(p => {
      const g = page.groups?.get(p.id),
        asked = g?.question ? ` data-question="${g.question.answered ? 'answered' : 'open'}"` : '';
      // (a question gathered from another page says which: it stays there)
      const from = g?.elsewhere ? `<span class="bk-unit-from">${esc(g.elsewhere.label ?? '')}</span>` : '';
      return `<div class="bk-unit"${asked} data-keep-in-sight data-unit="${p.id}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px"><div class="bk-unit-paper" style="height:${p.h}px"></div>${from}</div>`;
    })
    .join('')}`;
  for (const p of page.places) {
    const words = view.el.querySelector(`:scope > .bk-groups > .bk-words[data-g="${p.id}"]`),
      fit = page.fits?.get(p.id);
    if (words) {
      const at = fit && !fit.plain ? onCard(fit, p, 0, bodyIn(page, p.id)) : { x: p.x, y: p.y + bodyIn(page, p.id) };
      Object.assign(words.style, {
        left: `${at.x}px`,
        top: `${at.y}px`,
        transform: fit && !fit.plain ? `scale(${fit.k})` : '',
        transformOrigin: '0 0',
      });
    }
    hangUnder(view, p);
    // (whom it went to, at its corner: bookassignlist.js.)
    const tags = view.el.querySelector(`:scope > .bk-groups > .bk-tags[data-g="${p.id}"]`);
    if (tags) Object.assign(tags.style, { left: `${p.x + p.w}px`, top: `${p.y + p.h}px` });
    // (who read it, beside what they read.)
    const seen = view.el.querySelector(`:scope > .bk-groups > .bk-seen[data-g="${p.id}"]`);
    if (seen) Object.assign(seen.style, seenAt(page, p, seen));
  }
}
// Where the seen mark goes (its left and top, page px): beside the card its agent read, everything on it read with it
// (a scrap is one unit). Right of it at its foot, else under it, left of it or over it: the first that stays on the page
// and covers no other unit's paper or ink, nor what hangs under one; else in its own box's corner.
function seenAt(page, p, mark) {
  const r = { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h },
    [w, h] = [mark.offsetWidth, mark.offsetHeight],
    at = (x, y) => ({ x0: x, y0: y, x1: x + w, y1: y + h }),
    sheet = { x0: page.x ?? 0, y0: page.y ?? 0, x1: (page.x ?? 0) + page.w, y1: (page.y ?? 0) + page.h },
    others = page.places.flatMap(q => [
      ...(q.id === p.id ? [] : [{ x0: q.x, y0: q.y, x1: q.x + q.w, y1: q.y + q.h }]),
      ...(q.hung?.h ? [{ x0: q.hung.x, y0: q.hung.y, x1: q.hung.x + q.hung.w, y1: q.hung.y + q.hung.h }] : []),
    ]),
    clear = b =>
      b.x0 >= sheet.x0 &&
      b.y0 >= sheet.y0 &&
      b.x1 <= sheet.x1 &&
      b.y1 <= sheet.y1 &&
      !others.some(o => o && meets(o, b)),
    beside = [
      at(r.x1 + SEEN_GAP, r.y1 - h),
      at(r.x1 - w, r.y1 + SEEN_GAP),
      at(r.x0 - SEEN_GAP - w, r.y1 - h),
      at(r.x1 - w, r.y0 - SEEN_GAP - h),
    ],
    b = beside.find(clear) ?? at(Math.max(r.x0, r.x1 - w), Math.max(r.y0, r.y1 - h));
  return { left: `${b.x0}px`, top: `${b.y0}px` };
}
// A later day's date where its units start, across the page.
function dayHtml(page, h) {
  return `<p class="bk-day" style="top:${h.y}px;width:${page.w}px">${seen(dayWords(h.day))}</p>`;
}
