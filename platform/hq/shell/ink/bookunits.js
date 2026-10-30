// A notebook page as the deck draws it: paper-wide, scrolling down only, its scrap units laid as a masonry
// (masonry.js) at the page's width, each a sticky note at its place with its room to write under its body and a
// handle at its foot to drag that room taller or shorter. The page's title is at its top, a day's date across every
// column where its units start.
//
// The page's lists (page.ink, page.scraps, page.texts: what the tools work on) hold each unit's elements at its place
// on the page, in the page's px: a unit's own scrap px moved by its origin (page.origins: id → { x, y }). The store
// keeps them in the unit's own px (localOf undoes the move), so a unit's ink moves with it wherever the masonry puts it.
// A stroke goes to the unit it starts on; one started between units, or below the last, is a new unit of its own
// (page.pending, made in the store by booksave.js with `after` the unit above it). A unit grows to hold whatever goes
// past its foot (scrapunit.js heightFor).
import { GAP, MARGIN, layout, placeAt } from './masonry.js';
import { UNIT_W, bodyOf, resized } from './scrapunit.js';
import { ask } from './notebookdata.js';
import { nameOf } from './bookhead.js';
import { esc } from '../../util.js';
import { word } from './bookscope.js';

// the page's px above its grid, for its title
export const TITLE_H = 72;
// kept off the paper's left and right edges besides the masonry's margin (the close-swipe strip on the left takes
// 28 px: book.css), in CSS px
const INSET = 8;
// a new unit's own px start this far above and left of the stroke that makes it
const PAD = 12;
const LISTS = { ink: 'ink', texts: 'texts', pictures: 'scraps' };

// A page's units in their order: its top-level groups by pos, and the units drawn here not yet in the store right
// after the unit they were drawn under. [{ id, h, day }], h in its scrap px as the page draws it.
export function unitsOf(page) {
  const groups = [...(page.groups?.values() ?? [])].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.id - b.id),
    units = groups.map(g => ({ id: g.id, day: dayOf(g.created) }));
  for (const p of page.pending ?? []) {
    const at = units.findIndex(u => u.id === p.after);
    units.splice(at < 0 ? units.length : at + 1, 0, { id: p.id, day: units[at]?.day ?? units.at(-1)?.day });
  }
  // (a unit drawn between older ones is of their day: the days only go on down the page)
  for (let k = units.length - 2; k >= 0; k--)
    if (units[k + 1].day && units[k].day > units[k + 1].day) units[k].day = units[k + 1].day;
  return units.map(u => ({ ...u, h: heightOf(page, u.id) }));
}
// A unit's height in its scrap px: as the store or a drag set it, and never shorter than what's on it reaches
export function heightOf(page, id) {
  const set = page.resizing?.id === id ? page.resizing.h : (page.groups?.get(id)?.h ?? 0),
    o = page.origins?.get(id) ?? { x: 0, y: 0 };
  let foot = 0;
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) if (el.g === id) foot = Math.max(foot, bottomOf(kind, el) - o.y);
  return Math.max(set + wordsOf(page, id), Math.ceil(foot));
}
// How tall a scrap's post-it words are, drawn in its body under its picture (page px; 0 for none)
const wordsOf = (page, id) => page.words?.get(id) ?? 0;
// How far down the page (its px) what's on a unit reaches: its picture, words and ink, its post-it words too; its top
// when it has nothing
export function footOf(page, id) {
  const o = page.origins?.get(id) ?? { x: 0, y: 0 };
  let foot = o.y + bodyIn(page, id) + wordsOf(page, id);
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) if (el.g === id) foot = Math.max(foot, bottomOf(kind, el));
  return foot;
}
// A unit's body, where an agent's picture or words end (its room to write is below it), in its scrap px: its picture,
// or with none its first typed words (a promise); words the board writes later are in the room, never the body
function bodyIn(page, id) {
  const parts = { ink: [], texts: [], pictures: [] };
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) if (el.g === id) parts[kind].push(localOf(page, kind, el));
  if (parts.pictures.length) parts.texts = [];
  else parts.texts.splice(1);
  return page.groups?.has(id) && page.groups.get(id).kind !== 'drawing' ? bodyOf(parts) : 0;
}
// (a day as the board's clock has it, sortable: YYYY-MM-DD)
const dayOf = iso => (iso ? new Date(iso).toLocaleDateString('sv-SE') : undefined);

// The page laid at its width (CSS px): every unit's place, its elements moved with it, its cards drawn; the page's box
// and scale as the view shows them. Returns whether anything moved (its ink then wants drawing again).
export function layUnits(view, width) {
  const page = view.page;
  if (!page.groups || !width) return false;
  page.origins ??= new Map();
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) if (!homed(page, el)) home(page, kind, el);
  page.words = new Map(
    [...view.el.querySelectorAll(':scope > .bk-groups > .bk-words')].map(w => [
      Number(w.dataset.g),
      w.offsetHeight + 8,
    ]),
  );
  const units = unitsOf(page),
    laid = { units: units.map(u => ({ ...u, h: u.h + underOf(view, u.id) })), width: width - 2 * INSET },
    l = layout(laid.units, laid.width),
    s = l.scale,
    origins = new Map(l.places.map(p => [p.id, onPage(p, s)]));
  let moved = page.scale !== s;
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) {
      const was = page.origins.get(el.g) ?? { x: 0, y: 0 },
        now = origins.get(el.g);
      if (now && (now.x !== was.x || now.y !== was.y)) {
        shift(kind, el, now.x - was.x, now.y - was.y);
        moved = true;
      }
      // (typed words wrap inside their unit)
      if (now && kind === 'texts') inside(el, now);
    }
  for (const [id, o] of page.origins) if (!origins.has(id)) origins.set(id, o);
  const heights = new Map(units.map(u => [u.id, u.h]));
  page.origins = origins;
  page.places = l.places.map(p => ({ id: p.id, ...onPage(p, s), w: UNIT_W, h: heights.get(p.id) }));
  page.laid = laid;
  page.headers = l.headers.map(h => ({ day: h.day, y: h.y / s + TITLE_H }));
  page.columns = l.columns;
  Object.assign(page, { x: 0, y: 0, w: width / s, h: l.height / s + TITLE_H, scale: s });
  drawCards(view);
  return moved;
}
// Where a new unit h tall (its scrap px) goes as the page's last, today's, in the page's px as layUnits lays it:
// where a scrap lands (booklanding.js). null on a page not laid yet.
export function nextPlace(page, h) {
  if (!page.laid) return null;
  const { units, width } = page.laid,
    l = layout([...units, { id: null, h, day: dayOf(new Date().toISOString()) }], width);
  return onPage(l.places.at(-1), l.scale);
}
// A place in the masonry's px as the page's own, at the layout's scale
const onPage = (p, s) => ({ x: (p.x + INSET) / s, y: p.y / s + TITLE_H });
// Typed words kept inside their unit, PAD in from its sides
function inside(el, o) {
  el.x = Math.max(el.x, o.x + PAD);
  el.w = Math.max(40, Math.min(el.w, o.x + UNIT_W - PAD - el.x));
}
// Whether an element is in a unit the page knows (the store's, or one drawn here)
const homed = (page, el) => page.groups.has(el.g) || page.gone?.has(el.g) || page.pending?.some(p => p.id === el.g);
// An element with no unit yet (a picture taped in, words typed on the page): into the unit it starts on, else a new one
function home(page, kind, el) {
  const [x, y] = startOf(kind, el);
  el.g = unitAt(page, x, y) ?? newUnit(page, x, y);
}
// The unit a stroke starting at a point on the page (its px) goes to: the one there, else a new one drawn here
export const strokeUnit = (page, x, y) => unitAt(page, x, y) ?? newUnit(page, x, y);
// The unit at a point on the page (its px), or undefined in the space between units
export const unitAt = (page, x, y) => (page.places ? placeAt(page.places, x, y)?.id : undefined);
// A new unit drawn at a point between units: right after the unit above it in its column (at the end when none), its
// own px starting just above-left of the point at its column's edge
function newUnit(page, x, y) {
  const columns = page.columns ?? 1,
    inner = page.w - (2 * INSET) / (page.scale ?? 1),
    left =
      INSET / (page.scale ?? 1) +
      MARGIN +
      Math.max(0, (inner - (columns * UNIT_W + (columns - 1) * GAP + 2 * MARGIN)) / 2),
    column = Math.max(0, Math.min(columns - 1, Math.floor((x - left + GAP / 2) / (UNIT_W + GAP)))),
    cx = left + column * (UNIT_W + GAP),
    above = (page.places ?? []).filter(p => Math.abs(p.x - cx) < 1 && p.y + p.h <= y).sort((a, b) => b.y - a.y)[0];
  const id = (page.temp = (page.temp ?? 0) - 1),
    origin = { x: cx, y: Math.max(TITLE_H, y - PAD) };
  (page.pending ??= []).push({ id, after: above?.id ?? null });
  page.origins.set(id, origin);
  return id;
}
// A pending unit made in the store: its id the store's from now on
export function madeUnit(page, temp, id) {
  page.pending = (page.pending ?? []).filter(p => p.id !== temp);
  for (const p of page.pending) if (p.after === temp) p.after = id;
  page.origins.set(id, page.origins.get(temp));
  page.origins.delete(temp);
  for (const list of Object.values(LISTS)) for (const el of page[list] ?? []) if (el.g === temp) el.g = id;
}

// An element as the store keeps it: in its unit's own px
export function localOf(page, kind, el) {
  const o = page.origins?.get(el.g);
  if (!o) return el;
  const copy = { ...el };
  shift(kind, copy, -o.x, -o.y);
  return copy;
}
// An element moved by dx, dy in place (its points or its box)
function shift(kind, el, dx, dy) {
  if (kind === 'ink') el.points = el.points.map(([x, y, ...r]) => [x + dx, y + dy, ...r]);
  else Object.assign(el, { x: el.x + dx, y: el.y + dy });
}
const startOf = (kind, el) => (kind === 'ink' ? el.points[0] : [el.x, el.y]);
const bottomOf = (kind, el) =>
  kind === 'ink' ? Math.max(...el.points.map(p => p[1])) + el.size * 0.75 + 1 : el.y + (el.h ?? typedHeight(el));
// How tall typed words stand as they wrap at their box's width (booktexts.js TEXT: 18 px type, lines 1.4 apart, about
// half an em a letter), with their box's room round them
const typedHeight = t =>
  Math.max(
    1,
    ...String(t.text ?? '')
      .split('\n')
      .map(l => Math.ceil((l.length * 9.5) / Math.max(40, t.w - 8))),
  ) *
    25.2 +
  8;
// How tall what hangs under a unit is (its words, answers and replies: bookgroups.js .bk-under), in the page's px
function underOf(view, id) {
  const el = view.el.querySelector(`:scope > .bk-groups > .bk-under[data-g="${id}"]`);
  return el ? el.offsetHeight + 10 : 0;
}

// ---- the cards

// The page's title, its days' dates, and a card for every unit (the scrap's paper, its room to write and the handle
// at its foot), what hangs under each moved to its foot
function drawCards(view) {
  const page = view.page;
  let layer = view.el.querySelector(':scope > .bk-units');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'bk-units';
    view.el.prepend(layer);
    handles(view, layer);
  }
  const open = !(page.sending || page.sent || page.readonly);
  layer.style.height = `${page.h}px`;
  layer.innerHTML = `<h2 class="bk-page-title" style="width:${page.w}px">${esc(nameOf(page))}</h2>${page.headers
    .map(h => `<p class="bk-day" style="top:${h.y}px;width:${page.w}px">${esc(dayWords(h.day))}</p>`)
    .join('')}${page.places
    .map(p => {
      const body = bodyIn(page, p.id) + wordsOf(page, p.id),
        room = body > 0 && p.h - body > 8 ? `<div class="bk-room" style="top:${body}px"></div>` : '',
        grab = open
          ? `<button type="button" class="bk-room-handle" data-unit="${p.id}" style="left:${p.x + p.w / 2}px;top:${p.y + p.h}px" aria-label="${word('Make the room to write taller or shorter')}"></button>`
          : '';
      return `<div class="bk-unit" data-unit="${p.id}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px">${room}</div>${grab}`;
    })
    .join('')}`;
  for (const p of page.places) {
    const words = view.el.querySelector(`:scope > .bk-groups > .bk-words[data-g="${p.id}"]`);
    if (words) Object.assign(words.style, { left: `${p.x}px`, top: `${p.y + bodyIn(page, p.id)}px` });
    const under = view.el.querySelector(`:scope > .bk-groups > .bk-under[data-g="${p.id}"]`);
    if (under) Object.assign(under.style, { left: `${p.x}px`, top: `${p.y + p.h + 10}px` });
  }
}
const dayWords = day =>
  new Date(`${day}T12:00`)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    .replace(',', '');

// A unit's handle dragged: its height follows (never into what's drawn: resized), the masonry laid again as it goes,
// and saved as it's let go (/api/notebooks/groups/resize)
function handles(view, layer) {
  layer.addEventListener('pointerdown', e => {
    const b = e.target.closest('.bk-room-handle');
    if (!b) return;
    e.stopPropagation();
    e.preventDefault();
    const page = view.page,
      id = Number(b.dataset.unit),
      g = page.groups.get(id);
    if (!g) return;
    const from = heightOf(page, id),
      y0 = e.clientY;
    b.setPointerCapture(e.pointerId);
    const parts = () => {
      const p = { ink: [], texts: [], pictures: [] };
      for (const [kind, list] of Object.entries(LISTS))
        for (const el of page[list]) if (el.g === id) p[kind].push(localOf(page, kind, el));
      return p;
    };
    const move = m => {
      // (in the store's terms: the words drawn in its body aside)
      const h = resized(parts(), from + (m.clientY - y0) / (page.scale ?? 1)) - wordsOf(page, id);
      page.resizing = { id, h: Math.max(1, h) };
      view.relay?.();
    };
    const up = async () => {
      b.removeEventListener('pointermove', move);
      b.removeEventListener('pointerup', up);
      b.removeEventListener('pointercancel', up);
      const h = page.resizing?.h;
      if (h === undefined) return;
      try {
        const done = await ask(view.dev, '/api/notebooks/groups/resize', null, { id, since: g.updated, h });
        Object.assign(g, { h: done.h ?? h, updated: done.updated ?? g.updated });
      } catch (err) {
        view.refuse?.(err.message);
      }
      page.resizing = null;
      view.relay?.();
    };
    b.addEventListener('pointermove', move);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  });
}
