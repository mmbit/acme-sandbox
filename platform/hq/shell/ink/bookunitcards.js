// A notebook page's cards as bookunits.js lays them: the page's title with its first day, its later days' dates, and a card for every unit (the
// scrap's paper, its room to write and the handle at its foot to drag that room taller or shorter), what hangs under
// each moved to its foot. The board's own drawings get no paper and no handle.
import { bodyIn, drawing, heightOf, partsOf, wordsOf } from './bookunits.js';
import { heightFor } from './scrapunit.js';
import { ask } from './notebookdata.js';
import { PENCIL, nameOf } from './bookhead.js';
import { esc } from '../../util.js';
// (bookLang and companyFormats write a page's day in the book's language)
import { bookLang, word } from './bookscope.js';
import { companyFormats } from '../../world/clock.js';
import { hangUnder } from './bookunder.js';

// Words the board reads (a heading, a date), marked so a minimised call covers as little of them as it can: by their own
// box, not the page-wide line.
const seen = words => `<span data-keep-in-sight>${esc(words)}</span>`;
// The page's title with its first day, its later days' dates, and a card for every unit (the scrap's paper, its room to write and the handle
// at its foot), what hangs under each moved to its foot
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
    // (a press on the title is the title's: no stroke, no pan)
    handles.addEventListener('pointerdown', e => e.target.closest('.bk-title-tap') && e.stopPropagation());
  }
  const open = !(page.sending || page.sent || page.readonly);
  layer.style.height = `${page.h}px`;
  layer.innerHTML = `${headDay(page)}${page.headers
    .map(h => `<p class="bk-day" style="top:${h.y}px;width:${page.w}px">${seen(dayWords(h.day))}</p>`)
    .join('')}${page.places
    .map(p => {
      const body = bodyIn(page, p.id) + wordsOf(page, p.id),
        roomy = body > 0 && p.h - body > 8,
        room = roomy ? `<div class="bk-room" style="top:${body}px"></div>` : '',
        // (the board's own drawing is ink on the page: no paper. Else the note's paper, as tall as its body, plain
        // page under it to write on.)
        ink = drawing(page, p.id),
        paper = ink ? '' : `<div class="bk-unit-paper" style="height:${roomy ? body : p.h}px"></div>`;
      // (what the board reads: a minimised call covers as little of it as it can.)
      return `<div class="bk-unit"${ink ? ' data-drawing' : ''} data-keep-in-sight data-unit="${p.id}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px">${paper}${room}</div>`;
    })
    .join('')}`;
  titleIn(handles, page);
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
// The page's title in its head, over the paper with the handles so a tap on it, a finger's or the Pencil's, is its own:
// it opens the notebook's pages with the title to write in (bookcontrols.js), a pencil by it saying it can be changed
function titleIn(layer, page) {
  if (!layer) return;
  let head = layer.querySelector(':scope > .bk-page-title');
  if (!head) {
    head = document.createElement('h2');
    head.className = 'bk-page-title';
    layer.prepend(head);
  }
  head.style.width = `${page.w}px`;
  head.innerHTML = `<button type="button" class="bk-title-tap" title="${esc(word('changeTitle'))}">${seen(nameOf(page))}${PENCIL}</button>`;
}
// The page's title in its head as it's named now (booksave.js named)
export const retitle = view => titleIn(view.el.querySelector(':scope > .bk-handles'), view.page);
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
// The page's first day in its head, under its title and kept with it: none on a call's page, whose title starts with
// the call's date and time (the store's callnotes.ts)
const headDay = page =>
  page.day && page.kind !== 'call'
    ? `<p class="bk-day bk-head-day" style="width:${page.w}px">${seen(dayWords(page.day))}</p>`
    : '';
// A page's day in the book's language, no comma: "Sat 31 Oct", "za 31 okt"
const dayWords = day => companyFormats().day(day, bookLang(), { weekday: true, short: true }).replace(',', '');

// A unit's handle dragged: its height follows (never into what's drawn: heightFor), the masonry laid again as it goes,
// and saved as it's let go (/api/notebooks/groups/resize)
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
      y0 = e.clientY,
      pointer = e.pointerId,
      scale = view.el.getBoundingClientRect().width / view.el.offsetWidth;
    b.setPointerCapture(pointer);
    const move = m => {
      if (m.pointerId !== pointer) return;
      // (in the store's terms: the words drawn in its body aside)
      const h = heightFor(partsOf(page, id), Math.round(from + (m.clientY - y0) / scale)) - wordsOf(page, id);
      page.resizing = { id, h: Math.max(1, h) };
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
    h = page.resizing?.h;
  if (h === undefined) return;
  if (!unmade)
    try {
      // (after a save of its ink under way, as the store has it then: drawn on and dragged at once, the resize goes
      // with the group the save left, never one it changed since.)
      await page.saving?.catch(() => {});
      const now = page.groups.get(id) ?? g,
        done = await ask(view.dev, '/api/notebooks/groups/resize', null, { id, since: now.updated, h });
      Object.assign(now, { h: done.h ?? h, updated: done.updated ?? now.updated });
    } catch (err) {
      view.refuse?.(err.message);
    }
  page.resizing = null;
  view.relay?.();
}
