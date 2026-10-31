// A notebook page as the deck draws it: paper-wide, scrolling down only, its scrap units laid as a masonry
// (masonry.js) at the page's width, each a sticky note at its place with its room to write under its body and a
// handle at its foot to drag that room taller or shorter. The page's title is at its top, a day's date across every
// column where its units start.
//
// The page's lists (page.ink, page.scraps, page.texts: what the tools work on) hold each unit's elements at its place
// on the page, in the page's px: a unit's own scrap px moved by its origin (page.origins: id → { x, y }). The store
// keeps them in the unit's own px (localOf undoes the move), so a unit's ink moves with it wherever the masonry puts it.
// A stroke goes to the unit it starts on, else to the board's own drawing it comes near (strokes close together are one
// drawing: a word's letters, a shape's sides); else it's a new unit of its own (page.pending, made in the store by
// booksave.js with `after` the unit above it, or with the column it's drawn in where none is above), at the place the
// masonry gives it, so its ink stays where it was drawn.
// A unit grows to hold whatever goes past its foot (scrapunit.js heightFor), and its canvas reaches its ink wherever
// that goes (bookpage.js): nothing drawn is cut. The board's own drawings are ink on the page, no paper under them; an
// agent's scrap is a card.
import { GAP, MARGIN, layout, placeAt } from './masonry.js';
import { UNIT_W, bodyOf, resized } from './scrapunit.js';
import { ask } from './notebookdata.js';
import { nameOf } from './bookhead.js';
import { esc } from '../../util.js';
import { word } from './bookscope.js';
import { boxOf as inkBox } from './bookrow.js';
import { scrapBox, union } from './bookselectmath.js';

// the page's px above its grid, for its title
export const TITLE_H = 72;
// kept off the paper's left and right edges besides the masonry's margin (the close-swipe strip on the left takes
// 28 px: book.css), in CSS px
const INSET = 8;
// typed words keep this far in from their unit's sides; a new unit on a page not laid yet starts this far above its
// first stroke
const PAD = 12;
// how near (page px) a stroke comes to the board's own drawing to be part of it
const NEAR = 64;
const LISTS = { ink: 'ink', texts: 'texts', pictures: 'scraps' };

// A page's units in their order: its top-level groups by pos, and the units drawn here not yet in the store right
// after the unit they were drawn under. [{ id, h, day, follows, column }], h in its scrap px as the page draws it.
// What the board draws under a unit (a drawing, a unit drawn here) follows it: it stays under that one at every width.
// One drawn with nothing above it keeps the column it was drawn in instead.
export function unitsOf(page) {
  // (a group just deleted waits for its save, with no unit while nothing of it is on the page: Undo puts its things back;
  const gone = g => g.vanished && !Object.values(LISTS).some(list => page[list]?.some(el => el.g === g.id)),
    groups = [...(page.groups?.values() ?? [])]
      .filter(g => !gone(g))
      .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.id - b.id),
    units = groups.map(g => ({ id: g.id, day: dayOf(g.created), ...placing(g.kind === 'drawing', g.column) }));
  for (const p of page.pending ?? []) {
    const at = units.findIndex(u => u.id === p.after);
    units.splice(
      at < 0 ? units.length : at + 1,
      0,
      at < 0 ? { id: p.id, day: units.at(-1)?.day ?? today(), column: p.column } : { id: p.id, follows: true },
    );
  }
  if (units.length) units[0].follows = false;
  // (a unit following another is of its day, and one drawn between older ones of theirs: the days only go on down
  // the page)
  for (let k = 1; k < units.length; k++) if (units[k].follows) units[k].day = units[k - 1].day;
  for (let k = units.length - 2; k >= 0; k--)
    if (units[k + 1].day && units[k].day > units[k + 1].day) units[k].day = units[k + 1].day;
  return units.map(u => ({ ...u, h: heightOf(page, u.id) }));
}
// How the board's drawing is laid: in the column it was drawn in (the store's column), else under the unit before it
const placing = (drawn, column) => (!drawn ? {} : column == null ? { follows: true } : { column });
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
const dayOf = iso => (iso ? new Date(iso).toLocaleDateString('sv-SE') : undefined),
  today = () => dayOf(new Date().toISOString());

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
    laid = {
      units: units.map(u => ({ ...u, h: u.h + underOf(view, u.id) })),
      width: width - 2 * INSET,
    },
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
    l = layout([...units, { id: null, h, day: today() }], width);
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
// An element with no unit yet (a picture taped in, words typed on the page, a shape): its unit as a stroke's
function home(page, kind, el) {
  el.g = unitFor(page, startOf(kind, el), boxOf(kind, el));
}
// The unit a stroke goes to (page px): the one it starts on, else the board's drawing it comes near, else a new one
export const inkUnit = (page, stroke) => unitFor(page, stroke.points[0], boxOf('ink', stroke));
// The unit what is put at a point goes to (typed words), as a stroke starting there
export const pointUnit = (page, x, y) => unitFor(page, [x, y], { x0: x, y0: y, x1: x, y1: y });
// The unit at a point on the page (its px), or undefined in the space between units
export const unitAt = (page, x, y) => (page.places ? placeAt(page.places, x, y)?.id : undefined);
function unitFor(page, [x, y], box) {
  return unitAt(page, x, y) ?? nearDrawing(page, box) ?? newUnit(page, box, y);
}
// The board's own drawing nearest a box, within NEAR of what's drawn on it; undefined when none is that near
function nearDrawing(page, box) {
  let best,
    gap = NEAR;
  for (const p of page.places ?? []) {
    if (!drawing(page, p.id)) continue;
    const r = reachOn(page, p),
      d = Math.max(0, r.x0 - box.x1, box.x0 - r.x1) + Math.max(0, r.y0 - box.y1, box.y0 - r.y1);
    if (d <= gap) [best, gap] = [p.id, d];
  }
  return best;
}
// Whether a unit is the board's own drawing (a stroke's unit not yet in the store too): ink on the page, no paper card
export const drawing = (page, id) => id < 0 || page.groups?.get(id)?.kind === 'drawing';
// What a unit covers on the page (its px): its place and whatever is drawn on it, wherever that reaches
export function reachOn(page, p) {
  let r = { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h };
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) if (el.g === p.id) r = union(r, boxOf(kind, el));
  return r;
}
// A new unit for what's drawn in a box between units, started at height y: right after the unit above that in its
// column, which it follows; where none is above, the page's last, kept in the column it's drawn in. At the place the
// masonry gives it, as layUnits lays it, so what's drawn stays where it was (above the unit's top, where it's drawn
// higher). On a page not laid yet, just above what's drawn.
function newUnit(page, box, y) {
  const id = (page.temp = (page.temp ?? 0) - 1),
    column = columnAt(page, (box.x0 + box.x1) / 2),
    above = (page.places ?? [])
      .filter(p => columnAt(page, p.x + p.w / 2) === column && p.y + p.h <= y)
      .sort((a, b) => b.y - a.y)[0];
  (page.pending ??= []).push(above ? { id, after: above.id } : { id, after: null, column });
  const units = page.laid?.units ?? [],
    at = units.findIndex(u => u.id === above?.id),
    unit = above ? { id, h: 0, follows: true } : { id, h: 0, day: units.at(-1)?.day ?? today(), column },
    laid = units.toSpliced(at < 0 ? units.length : at + 1, 0, unit),
    place = page.laid && layout(laid, page.laid.width).places.find(p => p.id === id);
  page.origins.set(id, place ? onPage(place, page.scale ?? 1) : { x: 0, y: Math.max(TITLE_H, box.y0 - PAD) });
  return id;
}
// The masonry's column under an x on the page (its px), the nearest where it's beside the grid
function columnAt(page, x) {
  const columns = page.columns ?? 1,
    inner = page.w - (2 * INSET) / (page.scale ?? 1),
    left =
      INSET / (page.scale ?? 1) +
      MARGIN +
      Math.max(0, (inner - (columns * UNIT_W + (columns - 1) * GAP + 2 * MARGIN)) / 2);
  return Math.max(0, Math.min(columns - 1, Math.floor((x - left + GAP / 2) / (UNIT_W + GAP))));
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
// What an element covers on the page (its px): a line's width round its points, a picture's corners as it's turned
function boxOf(kind, el) {
  if (kind === 'ink') return inkBox(el);
  if (kind === 'pictures') return scrapBox(el);
  return { x0: el.x, y0: el.y, x1: el.x + el.w, y1: el.y + (el.h ?? typedHeight(el)) };
}
const bottomOf = (kind, el) => boxOf(kind, el).y1;
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
  let layer = view.el.querySelector(':scope > .bk-units'),
    grabs = view.el.querySelector(':scope > .bk-grabs');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'bk-units';
    view.el.prepend(layer);
  }
  // (the handles over the page, where a press reaches them: the cards' layer is behind the paper's own box.)
  if (!grabs) {
    grabs = document.createElement('div');
    grabs.className = 'bk-grabs';
    view.el.append(grabs);
    handles(view, grabs);
  }
  const open = !(page.sending || page.sent || page.readonly);
  layer.style.height = `${page.h}px`;
  layer.innerHTML = `<h2 class="bk-page-title" style="width:${page.w}px">${esc(nameOf(page))}</h2>${page.headers
    .map(h => `<p class="bk-day" style="top:${h.y}px;width:${page.w}px">${esc(dayWords(h.day))}</p>`)
    .join('')}${page.places
    .map(p => {
      const body = bodyIn(page, p.id) + wordsOf(page, p.id),
        room = body > 0 && p.h - body > 8 ? `<div class="bk-room" style="top:${body}px"></div>` : '',
        // (the board's own drawing is ink on the page: no paper.)
        ink = drawing(page, p.id);
      return `<div class="bk-unit"${ink ? ' data-drawing' : ''} data-unit="${p.id}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px">${room}</div>`;
    })
    .join('')}`;
  // (no room to drag on the board's own drawing)
  grab(grabs, open ? page.places.filter(p => !drawing(page, p.id)) : []);
  for (const p of page.places) {
    const words = view.el.querySelector(`:scope > .bk-groups > .bk-words[data-g="${p.id}"]`);
    if (words) Object.assign(words.style, { left: `${p.x}px`, top: `${p.y + bodyIn(page, p.id)}px` });
    const under = view.el.querySelector(`:scope > .bk-groups > .bk-under[data-g="${p.id}"]`);
    if (under) Object.assign(under.style, { left: `${p.x}px`, top: `${p.y + p.h + 10}px` });
    // (whom it went to, at its corner: bookassignlist.js.)
    const tags = view.el.querySelector(`:scope > .bk-groups > .bk-tags[data-g="${p.id}"]`);
    if (tags) Object.assign(tags.style, { left: `${p.x + p.w}px`, top: `${p.y + p.h}px` });
  }
}
// A handle at every unit's foot, each kept as the page is laid again (the one held keeps its pointer)
function grab(grabs, places) {
  const had = new Map([...grabs.children].map(b => [b.dataset.unit, b]));
  for (const p of places) {
    let b = had.get(String(p.id));
    had.delete(String(p.id));
    if (!b) {
      b = Object.assign(document.createElement('button'), { type: 'button', className: 'bk-room-handle' });
      b.dataset.unit = p.id;
      b.setAttribute('aria-label', word('Make the room to write taller or shorter'));
      grabs.append(b);
    }
    Object.assign(b.style, { left: `${p.x + p.w / 2}px`, top: `${p.y + p.h}px` });
  }
  for (const b of had.values()) b.remove();
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
      y0 = e.clientY,
      pointer = e.pointerId;
    b.setPointerCapture(pointer);
    const parts = () => {
      const p = { ink: [], texts: [], pictures: [] };
      for (const [kind, list] of Object.entries(LISTS))
        for (const el of page[list]) if (el.g === id) p[kind].push(localOf(page, kind, el));
      return p;
    };
    const move = m => {
      if (m.pointerId !== pointer) return;
      // (in the store's terms: the words drawn in its body aside)
      const h = resized(parts(), from + (m.clientY - y0) / (page.scale ?? 1)) - wordsOf(page, id);
      page.resizing = { id, h: Math.max(1, h) };
      view.relay?.();
    };
    const up = async u => {
      if (u.pointerId !== pointer) return;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
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
    // (followed on the window, wherever the pointer is as the masonry's laid again under it. job #15978)
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
}
