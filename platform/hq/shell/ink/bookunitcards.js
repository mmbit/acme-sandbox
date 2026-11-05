// A notebook page's cards as bookunits.js lays them: its later days' dates, and a card for every unit (the scrap's
// paper, its room to write and the handle at its foot to drag that room taller or shorter), what hangs under each moved
// to its foot. The board's own drawings get no paper and no handle. (The title and the day of what's showing are the
// view's, bookviewhead.js)
import { bodyIn, drawing, drawnOn, heightOf, partsOf, reachOn, wordsOf } from './bookunits.js';
import { meets, union } from './bookselectmath.js';
import { UNIT_W, heightFor } from './scrapunit.js'; // (UNIT_W)
import { isCanvas, isPush, pushedDown } from './sketchcanvas.js';
import { ask } from './notebookdata.js';
import { dayWords } from './bookhead.js';
import { esc } from '../../util.js';
import { word } from './bookscope.js';
import { hangUnder } from './bookunder.js';

// (the room between the seen mark and what was read, page px.)
const SEEN_GAP = 10;
// Words the board reads (a heading, a date), marked so a minimised call covers as little of them as it can: by their own
// box, not the page-wide line.
const seen = words => `<span data-keep-in-sight>${esc(words)}</span>`;
// The page's later days' dates, and a card for every unit (the scrap's paper, its room to write and the handle at its
// foot), what hangs under each moved to its foot.
export function drawCards(view) {
  const page = view.page;
  let layer = view.el.querySelector(':scope > .bk-units'),
    handles = view.el.querySelector(':scope > .bk-handles');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'bk-units';
    view.el.prepend(layer);
  }
  // (the handles over the page, where a press reaches them: the cards' layer is behind the paper's own box.)
  if (!handles) {
    handles = document.createElement('div');
    handles.className = 'bk-handles';
    view.el.append(handles);
    dragged(view, handles);
  }
  const open = !(page.sending || page.sent || page.readonly);
  layer.style.height = `${page.h}px`;
  layer.innerHTML = `${page.headers.map(h => dayHtml(page, h)).join('')}${page.places
    .map(p => {
      const body = bodyIn(page, p.id) + wordsOf(page, p.id),
        roomy = body > 0 && p.h - body > 8,
        room = roomy ? `<div class="bk-room" style="top:${body}px"></div>` : '',
        // (the board's own drawing is ink on the page: no paper. Else the note's paper, as tall as its body, plain
        // page under it to write on.)
        ink = drawing(page, p.id),
        paper = ink ? '' : `<div class="bk-unit-paper" style="height:${roomy ? body : p.h}px"></div>`;
      // (what the board reads: a minimised call covers as little of it as it can.)
      // (a note's words written on it: its paper a margin round them, bookgroups.css.)
      const note = page.groups?.get(p.id)?.kind === 'note' ? ' data-note' : '';
      return `<div class="bk-unit"${ink ? ' data-drawing' : ''}${note} data-keep-in-sight data-unit="${p.id}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px">${paper}${room}</div>`;
    })
    .join('')}`;
  // (no room to drag on the board's own drawing)
  placeHandles(handles, open ? page.places.filter(p => !drawing(page, p.id)) : []);
  for (const p of page.places) {
    const words = view.el.querySelector(`:scope > .bk-groups > .bk-words[data-g="${p.id}"]`);
    if (words) Object.assign(words.style, { left: `${p.x}px`, top: `${p.y + bodyIn(page, p.id)}px` });
    hangUnder(view, p);
    // (whom it went to, at its corner: bookassignlist.js.)
    const tags = view.el.querySelector(`:scope > .bk-groups > .bk-tags[data-g="${p.id}"]`);
    if (tags) Object.assign(tags.style, { left: `${p.x + p.w}px`, top: `${p.y + p.h}px` });
    // (who read it, beside what they read.)
    const seen = view.el.querySelector(`:scope > .bk-groups > .bk-seen[data-g="${p.id}"]`);
    if (seen) Object.assign(seen.style, seenAt(page, p, seen));
  }
}
// Where the seen mark goes (its left and top, page px): beside what its agent read, the group's own ink, words and
// pictures wherever they are on the page, never its unit's corner (a drawing's unit is its slot in the masonry, its ink
// kept where it was drawn, maybe a note or two away: a tick at the slot would read as another note's). Right of it at
// its foot, else under it, left of it or over it: the first that stays on the page and covers no other unit's paper or
// ink, nor what hangs under one; else in its own box's corner.
function seenAt(page, p, mark) {
  const r = readBox(page, p.id) ?? { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h },
    [w, h] = [mark.offsetWidth, mark.offsetHeight],
    at = (x, y) => ({ x0: x, y0: y, x1: x + w, y1: y + h }),
    sheet = { x0: page.x ?? 0, y0: page.y ?? 0, x1: (page.x ?? 0) + page.w, y1: (page.y ?? 0) + page.h },
    others = page.places.flatMap(q => [
      ...(q.id === p.id ? [] : [drawing(page, q.id) ? readBox(page, q.id) : reachOn(page, q)]),
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
// What's on a group wherever it is on the page (page px), its post-it words too; null for nothing
function readBox(page, id) {
  const r = drawnOn(page, id),
    o = page.origins?.get(id),
    words = wordsOf(page, id);
  if (!o || !words) return r;
  const top = o.y + bodyIn(page, id),
    under = { x0: o.x, y0: top, x1: o.x + UNIT_W, y1: top + words };
  return r ? union(r, under) : under;
}
// A handle at every unit's foot, each kept as the page is laid again (the one held keeps its pointer)
function placeHandles(layer, places) {
  const had = new Map([...layer.querySelectorAll(':scope > .bk-room-handle')].map(b => [b.dataset.unit, b]));
  for (const p of places) {
    let b = had.get(String(p.id));
    had.delete(String(p.id));
    if (!b) {
      b = Object.assign(document.createElement('button'), { type: 'button', className: 'bk-room-handle' });
      b.dataset.unit = p.id;
      b.setAttribute('aria-label', word('roomHandle'));
      b.setAttribute('data-keep-clear', ''); // (a minimised call keeps clear of it.)
      layer.append(b);
    }
    Object.assign(b.style, { left: `${p.x + p.w / 2}px`, top: `${p.y + p.h}px` });
  }
  for (const b of had.values()) b.remove();
}
// A later day's date where its units start: across the page, or a sketch page's over its scrap (sketchcanvas.js daysOf)
function dayHtml(page, h) {
  const at = h.w === undefined ? `width:${page.w}px` : `left:${h.x}px;width:${h.w}px;text-align:left`;
  return `<p class="bk-day" style="top:${h.y}px;${at}">${seen(dayWords(h.day))}</p>`;
}

// A unit's handle dragged: its height follows (never into what's drawn: heightFor), the masonry laid again as it goes,
// and saved as it's let go (/api/notebooks/groups/resize). On a sketch page what's below its foot moves down as its room
// grows, so it only ever opens room between notes (sketchcanvas.js pushedDown; README, Our scraps)
function dragged(view, layer) {
  layer.addEventListener('pointerdown', e => {
    const b = e.target.closest('.bk-room-handle');
    // (a second finger is the page's pinch: bookpan.js)
    if (!b || (e.pointerType === 'touch' && !e.isPrimary)) return;
    e.stopPropagation();
    e.preventDefault();
    const page = view.page,
      id = Number(b.dataset.unit),
      g = page.groups.get(id);
    if (!g) return;
    // (the page's px on screen: its masonry's scale, or a sketch page's zoom.)
    const from = heightOf(page, id),
      at = page.places?.find(p => p.id === id),
      y0 = e.clientY,
      pointer = e.pointerId,
      scale = view.el.getBoundingClientRect().width / view.el.offsetWidth;
    b.setPointerCapture(pointer);
    const move = m => {
      if (m.pointerId !== pointer) return;
      // (in the store's terms: the words drawn in its body aside)
      const h = heightFor(partsOf(page, id), Math.round(from + (m.clientY - y0) / scale)) - wordsOf(page, id);
      page.resizing = { id, h: Math.max(1, h) };
      // (isCanvas takes the page)
      if (isCanvas(page) && at) {
        const by = Math.max(0, heightOf(page, id) - from);
        page.resizing.push = { top: at.y, from: at.y + from, x0: at.x, x1: at.x + at.w, by };
      }
      view.relay?.();
    };
    const up = u => {
      if (u.pointerId !== pointer) return;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      letGo(view, id, g, u.unmade);
    };
    // (followed on the window, wherever the pointer is as the masonry's laid again under it)
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
}
// A unit's handle let go: its height saved; let go unmade, as a second finger comes down to pinch, the room as it was
async function letGo(view, id, g, unmade) {
  const page = view.page,
    h = page.resizing?.h,
    push = isPush(page.resizing?.push) ? page.resizing.push : undefined;
  if (h === undefined) return;
  if (!unmade)
    try {
      // (after a save of its ink under way, as the store has it then: drawn on and dragged at once, the resize goes
      // with the group the save left, never one it changed since.)
      await page.saving?.catch(() => {});
      const now = page.groups.get(id) ?? g,
        done = await ask(view.dev, '/api/notebooks/groups/resize', null, { id, since: now.updated, h, push });
      Object.assign(now, { h: done.h ?? h, updated: done.updated ?? now.updated });
      // (what it pushed down kept there till the store's own are read again)
      const placed = [...page.groups.values()].map(u => ({ id: u.id, place: u.place ?? page.pins?.get(u.id) }));
      for (const u of pushedDown(placed, push)) Object.assign(page.groups.get(u.id), { place: u.place });
    } catch (err) {
      view.refuse?.(err.message);
    }
  page.resizing = null;
  view.relay?.();
}
