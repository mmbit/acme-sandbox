// A notebook page's cards as bookunits.js lays them: its later days' dates, and a card for every unit (the scrap's
// paper, its room to write and the handle at its foot to drag that room taller or shorter), what hangs under each moved
// to its foot. The board's own drawings get no paper and no handle. (The title and the day of what's showing are the
// view's, bookviewhead.js)
import { bodyIn, drawing, heightOf, partsOf, wordsOf } from './bookunits.js';
import { heightFor } from './scrapunit.js';
import { isCanvas, isPush, pushedDown } from './sketchcanvas.js';
import { ask } from './notebookdata.js';
import { dayWords } from './bookhead.js';
import { esc } from '../../util.js';
import { word } from './bookscope.js';
import { hangUnder } from './bookunder.js';

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
  }
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
      if (isCanvas(page.chapter) && at) {
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
