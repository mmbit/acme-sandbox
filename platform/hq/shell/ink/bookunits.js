// A notebook page as the deck draws it: paper-wide at its fit, zoomed in from there to write big (bookview.js.), its scrap units laid as a masonry (masonry.js) at the page's width, each a sticky note
// at its place with its room to write under its body and a handle at its foot to drag that room taller or shorter.
// Its head is room the view's title and day lie over at rest (bookviewhead.js), and a later day's date goes across
// every column where its units start. (The cards and dates drawn: bookunitcards.js.)
//
// The page's lists (page.ink, page.scraps, page.texts: what the tools work on) hold each unit's elements at its place
// on the page, in the page's px: a unit's own scrap px moved by its origin (page.origins: id → { x, y }). The store
// keeps them in the unit's own px (localOf undoes the move), so a unit's ink moves with it wherever the masonry puts it.
// A stroke goes to the unit it starts on, else to the scrap it's drawn across, else to the board's own drawing it comes
// near (strokes close together are one drawing: a word's letters, a shape's sides), else to the scrap it's drawn beside
// (its column's nearest, but one it's wholly below by more than NEAR); only ink below its column's last is a unit of
// its own (page.pending, made in the store by booksave.js with the column it's drawn in), the page's last, at the place
// the masonry gives it. So ink stays where it was drawn: a scrap's room growing or dragged moves none of what's drawn
// by it, and nothing drawn is put among the units to push the ones after it down. Never so that the board's drawing
// already on the page moves (an agent's card under it makes room, its ink with it): a drawing that would grow into one
// under it gives way to the next choice.
// Laid again (a room grown, an answer come, a scrap arrived), every unit keeps the column it was in while the page has
// as many: only what's under a unit that grew moves, and only down.
// A unit grows to hold whatever goes past its foot (heightOf), and its canvas reaches its ink wherever that goes
// (bookpage.js): nothing drawn is cut. The board's own drawings are ink on the page, no paper; an agent's scrap a card.
// A sketch page is a canvas instead (sketchcanvas.js): each unit at the place the store keeps for it, the same at any
// width, in page px at the board's own zoom (bookview.js; opening at opensAt), and a stroke drawn apart from every unit,
// any way from the page's origin, a unit of its own where it's drawn. A unit with no place yet is laid as the masonry
// lays it, and this screen pins it there (page.pins, saved by booksave.js). What hangs under a unit there covers none
// of them: at its foot, or the first clear paper below.
import { MARGIN, columnUnder, columnsOf, layout, placeAt, scaleOf } from './masonry.js';
import { UNIT_W, WORDS_IN, bodyOf } from './scrapunit.js';
import { boxOf, bottomOf, shift, startOf } from './bookunitbox.js';
import { union } from './bookselectmath.js';
import { underOf } from './bookunder.js';
import { canvasOf, daysOf, isCanvas, pushedDown } from './sketchcanvas.js';
import { unitFor } from './bookunitfor.js';

// the page's px above its grid, where the view's title and day lie at rest
export const TITLE_H = 72;
// kept off the paper's left and right edges besides the masonry's margin (the close-swipe strip on the left takes
// 28 px: book.css), in CSS px
const INSET = 8;
// a new unit on a page not laid yet starts this far above its first stroke
const PAD = 12;
export const LISTS = { ink: 'ink', texts: 'texts', pictures: 'scraps' };

// A unit's page origin, at the top-left before it is laid
const originOf = (page, id) => page.origins?.get(id) ?? { x: 0, y: 0 };

// A page's units in their order: its top-level groups by pos, and the units drawn here not yet in the store last.
// [{ id, h, day, follows, column }], h in its scrap px as the page draws it. The board's drawing the store has under a
// unit follows it: it stays under that one at every width. One drawn as the page's last keeps the column it was drawn
// in instead.
export function unitsOf(page) {
  // (a group just deleted waits for its save, with no unit while nothing of it is on the page: Undo puts its things back;
  const gone = g => g.vanished && !Object.values(LISTS).some(list => page[list]?.some(el => el.g === g.id)),
    groups = [...(page.groups?.values() ?? [])]
      .filter(g => !gone(g))
      .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.id - b.id),
    units = groups.map(g => ({
      ...{ id: g.id, day: dayOf(g.created), place: g.place ?? page.pins?.get(g.id), drawn: g.kind === 'drawing' },
      ...placing(g.kind === 'drawing', g.column),
    }));
  for (const p of page.pending ?? [])
    units.push({ id: p.id, day: today(), column: p.column, place: p.place, drawn: true });
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
// A unit's height in its scrap px: as the store or a drag set it with its post-it words added (the store keeps it
// without them), and never shorter than what's on it reaches
export function heightOf(page, id) {
  const set = page.resizing?.id === id ? page.resizing.h : (page.groups?.get(id)?.h ?? 0),
    o = originOf(page, id);
  let foot = 0;
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) if (el.g === id) foot = Math.max(foot, bottomOf(kind, el) - o.y);
  return Math.max(set + wordsOf(page, id), Math.ceil(foot));
}
// How tall a scrap's post-it words are, drawn in its body under its picture (page px; 0 for none)
export const wordsOf = (page, id) => page.words?.get(id) ?? 0;
// Whether a scrap has post-it words the page hasn't drawn and measured yet (bookgroups.js draws a scrap's words: the
// board's typing, else the store's).
function wordsUnread(page, id) {
  const g = page.groups?.get(id);
  return g?.kind === 'scrap' && !!(page.typed?.get(id) ?? g.words) && !page.words?.has(id);
}
// How far down the page (its px) what's on a unit reaches: its picture, words and ink, its post-it words too; its top
// when it has nothing
export function footOf(page, id) {
  const o = originOf(page, id);
  let foot = o.y + bodyIn(page, id) + wordsOf(page, id);
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) if (el.g === id) foot = Math.max(foot, bottomOf(kind, el));
  return foot;
}
// A unit's body, where an agent's picture or words end (its room to write is below it), in its scrap px: its picture,
// or with none its first typed words (a promise); words the board writes later are in the room, never the body
export function bodyIn(page, id) {
  const parts = partsOf(page, id);
  if (parts.pictures.length) parts.texts = [];
  else parts.texts.splice(1);
  return page.groups?.has(id) && page.groups.get(id).kind !== 'drawing' ? bodyOf(parts) : 0;
}
// What's on a unit as the store keeps it, by kind ({ ink, texts, pictures }), in its own px
export function partsOf(page, id) {
  const parts = { ink: [], texts: [], pictures: [] };
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) if (el.g === id) parts[kind].push(localOf(page, kind, el));
  return parts;
}
// (a day as the board's clock has it, sortable: YYYY-MM-DD)
const dayOf = iso => (iso ? new Date(iso).toLocaleDateString('sv-SE') : undefined),
  today = () => dayOf(new Date().toISOString());

// The page laid at its width (CSS px): every unit's place, its elements moved with it; the page's box
// and scale as the view shows them. Returns whether anything moved (its ink then wants drawing again).
export function layUnits(view, width) {
  const page = view.page;
  if (!page.groups || !width) return false;
  page.origins ??= new Map();
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) if (!homed(page, el)) home(page, kind, el);
  // (only words drawn: a page hidden lays out none of them.)
  page.words = new Map(
    [...view.el.querySelectorAll(':scope > .bk-groups > .bk-words')]
      .filter(w => w.offsetHeight)
      .map(w => [Number(w.dataset.g), w.offsetHeight + 8]),
  );
  const units = unitsOf(page).map(u => ({ ...u, below: underOf(view, u.id) })),
    // (isCanvas takes the page)
    l = (isCanvas(page) ? canvasLaid : masonryLaid)(page, units, width),
    origins = new Map(l.places.map(p => [p.id, { x: p.x, y: p.y }]));
  let moved = page.scale !== l.scale;
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) {
      const was = originOf(page, el.g),
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
  page.places = l.places.map(p => ({ ...p, w: UNIT_W, h: heights.get(p.id) }));
  page.laid = l.laid;
  page.day = units.find(u => u.day !== undefined)?.day;
  page.headers = l.headers.filter(h => !inkedOver(page, h));
  page.columns = l.columns;
  Object.assign(page, { x: 0, y: 0, ...(l.size ?? canvasSize(page, width / l.scale)), scale: l.scale });
  // (a sketch page's units laid where they had no place: kept there, bookpages.js)
  if (page.pins?.size) view.pinned();
  return moved;
}
// The page's units laid as a masonry at width (CSS px), each as tall as it and what hangs under it (below) and as wide
// as the ink beside it reaches: their places in the page's px, each
// with its column and what hangs under it at its foot (hung), the dates across them, and the page's size
function masonryLaid(page, units, width) {
  // (a call's page never spans days: no dates on it, README, Our scraps)
  const inner = width - 2 * INSET,
    kept = keptColumns(page, inner),
    grown = units.map(u => ({
      ...u,
      h: u.h + u.below,
      w: besideOn(page, u.id),
      ...(kept.has(u.id) && { column: kept.get(u.id) }),
      ...(page.kind === 'call' && { day: undefined }),
    })),
    laid = { units: grown, width: inner },
    l = layout(laid.units, inner),
    s = l.scale;
  return {
    laid,
    scale: s,
    columns: l.columns,
    // (the masonry's places in its units' order)
    places: l.places.map((p, i) => {
      const at = onPage(p, s);
      return { id: p.id, ...at, column: p.column, hung: { ...at, y: at.y + units[i].h, w: UNIT_W, h: units[i].below } };
    }),
    headers: l.headers.map(h => ({ day: h.day, y: h.y / s + TITLE_H })),
    size: { w: width / s, h: l.height / s + TITLE_H },
  };
}
// A sketch page's units at their places, the ones with none laid at width and pinned there (page.pins), what hangs
// under each where it covers none of them (sketchcanvas.js), in page px: the board's zoom shows it larger or smaller
// (bookview.js)
function canvasLaid(page, units, width) {
  // (a room being dragged taller pushes what's below it down as it goes: bookunitcards.js)
  const inner = width - 2 * INSET,
    pushed = new Map(pushedDown(units, page.resizing?.push).map(u => [u.id, u.place])),
    wide = units.map(u => ({ ...u, w: widthOn(page, u.id), ...(pushed.has(u.id) && { place: pushed.get(u.id) }) })),
    { places, fresh } = canvasOf(wide, inner, { x: INSET, y: TITLE_H });
  page.pins ??= new Map();
  // (pinned only once every scrap among them has its post-it words measured, in the book's own font: one laid before is
  // too short or too tall, and what's pinned under it would lie under its words or a gap away. bookgroups.js lays the
  // page again once the font is in.)
  const measured = globalThis.document?.fonts?.status !== 'loading' && fresh.every(id => !wordsUnread(page, id));
  for (const p of places)
    if (measured && fresh.includes(p.id) && page.groups.has(p.id)) page.pins.set(p.id, { x: p.x, y: p.y });
  const at = new Map(places.map(p => [p.id, p])),
    first = units.find(u => u.day !== undefined)?.day;
  return {
    ...{ laid: { units: wide, width: inner, canvas: true }, scale: 1, columns: null, places },
    headers: daysOf(units, at, first).map(d => ({ ...d, w: UNIT_W })),
  };
}
// How wide a unit is from its origin's left (page px): a scrap's width, or as far as what's drawn on it reaches
const widthOn = (page, id, o = originOf(page, id)) => reachOn(page, { id, ...o, w: UNIT_W, h: 0 }).x1 - o.x;
// How wide a unit is from its origin's left (page px) with the ink beside it: a scrap's width, or as far as the ink
// wholly right of it reaches. A stroke that touches another note is that note's (unitFor). So the ink a note has beside
// it was drawn in clear paper, and an arrow from a note onto its neighbour never widens it. The board's drawing has no
// paper, so all its ink counts
function besideOn(page, id) {
  const o = originOf(page, id);
  if (drawing(page, id)) return widthOn(page, id, o);
  let x1 = o.x + UNIT_W;
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) {
      const box = boxOf(kind, el);
      if (el.g === id && box.x0 >= o.x + UNIT_W) x1 = Math.max(x1, box.x1);
    }
  return x1 - o.x;
}
// The zoom a sketch page opens at on a paper width (CSS px) wide: 1, or as a scrap's column fits on a narrower one (a
// phone's, the narrowest book's, its margin at the right giving way first as on a page of units)
export const opensAt = width => scaleOf(width - 2 * INSET, 1);
// A canvas as big as what's on it and what hangs under its units reach, any way from its origin, the paper's width
// (page px) at least. The board's drawing has no paper: only its ink counts, never a scrap's width from where it starts
function canvasSize(page, width) {
  const reach = page.places.map(({ hung: b, ...p }) => {
      const r = reachOn(page, drawing(page, p.id) ? { ...p, w: 0, h: 0 } : p);
      return b.h ? union(r, { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h }) : r;
    }),
    x = Math.min(0, ...reach.map(r => r.x0 - MARGIN)),
    y = Math.min(0, ...reach.map(r => r.y0 - MARGIN));
  return {
    x,
    y,
    w: Math.max(width, ...reach.map(r => r.x1 + MARGIN)) - x,
    h: Math.max(TITLE_H + 2 * MARGIN, ...reach.map(r => r.y1 + MARGIN)) - y,
  };
}
// The column each unit was laid in, while the page is laid at as many (id → column; none at a new count)
const keptColumns = (page, width) =>
  new Map(page.columns === columnsOf(width) ? (page.places ?? []).map(p => [p.id, p.column]) : []);
// Whether the board's own writing, kept where drawn (above its unit too), crosses the words of a day's date at y (the
// page's px, bookgroups.css's .bk-day): the date gives way.
// (a sketch page's, over a scrap, only where it is across: { y, x?, w? })
const inkedOver = (page, { y, x, w }) =>
  page.places.some(p => {
    const r = reachOn(page, p);
    return drawing(page, p.id) && r.y0 < y + 26 && r.y1 > y + 14 && (w === undefined || (r.x0 < x + w && r.x1 > x));
  });
// Where a new unit h tall (its scrap px) goes as the page's last, today's: where a scrap lands (booklanding.js)
export function nextPlace(page, h) {
  const unit = { id: null, h, below: 0, day: today() };
  if (!page.laid?.canvas) return placeAmong(page, unit, page.laid?.units.length);
  return canvasOf([...page.laid.units, unit], page.laid.width, { x: INSET, y: TITLE_H }).places.at(-1);
}
// Where a unit put among the page's laid units at an index goes, in the page's px as layUnits lays it: null on a page
// not laid yet
function placeAmong(page, unit, at) {
  if (!page.laid) return null;
  const l = layout(page.laid.units.toSpliced(at, 0, unit), page.laid.width);
  return onPage(l.places[at], l.scale); // (the masonry's places in its units' order)
}
// A place in the masonry's px as the page's own, at the layout's scale
const onPage = (p, s) => ({ x: (p.x + INSET) / s, y: p.y / s + TITLE_H });
// Typed words kept inside their unit, WORDS_IN from its sides: a box moved past
// its right side slides back in at its own width, never squeezed to a sliver
function inside(el, o) {
  el.w = Math.max(40, Math.min(el.w, UNIT_W - 2 * WORDS_IN));
  el.x = Math.max(o.x + WORDS_IN, Math.min(el.x, o.x + UNIT_W - WORDS_IN - el.w));
}
// Whether an element is in a unit the page knows (the store's, or one drawn here)
const homed = (page, el) => page.groups.has(el.g) || page.gone?.has(el.g) || page.pending?.some(p => p.id === el.g);
// An element with no unit yet (a picture taped in, words typed on the page, a shape): its unit as a stroke's
function home(page, kind, el) {
  const box = boxOf(kind, el);
  el.g = unitFor(page, startOf(kind, el), box, kind === 'ink' ? el : box);
}
// The unit a stroke goes to (page px): the one it starts on, else the board's drawing whose ink it comes near, else a
// new one.
export const inkUnit = (page, stroke) => unitFor(page, stroke.points[0], boxOf('ink', stroke), stroke);
// The unit what is put at a point goes to (typed words), as a stroke starting there
export const pointUnit = (page, x, y) => unitFor(page, [x, y], { x0: x, y0: y, x1: x, y1: y });
// The unit at a point on the page (its px), or undefined in the space between units
export const unitAt = (page, x, y) => (page.places ? placeAt(page.places, x, y)?.id : undefined);
// Whether a unit is the board's own drawing (a stroke's unit not yet in the store too): ink on the page, no paper card
export const drawing = (page, id) => id < 0 || page.groups?.get(id)?.kind === 'drawing';
// Whether a unit is one of our scraps (in the store, and not the board's own drawing): fixed, its photo and words never
// picked or moved, only drawn over and its words edited (README, Our scraps.)
export const fixed = (page, id) => id !== undefined && !!page.groups?.has(id) && !drawing(page, id);
// What a unit covers on the page (its px): its place and whatever is drawn on it, wherever that reaches
export function reachOn(page, p) {
  const r = { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h },
    on = drawnOn(page, p.id);
  return on ? union(r, on) : r;
}
// What's drawn on a unit, wherever it is on the page (its px): the box round its ink, typed words and pictures; null for
// none
export function drawnOn(page, id) {
  let r = null;
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) if (el.g === id) r = r ? union(r, boxOf(kind, el)) : boxOf(kind, el);
  return r;
}
// A new unit for what's drawn in a box below every scrap: the page's last, today's, kept in the column it's drawn in, at
// the place the masonry gives it, as layUnits lays it, so what's drawn stays where it was. On a page not laid yet, just
// above what's drawn. Lifted: what's lifted out of others for another page (bookmoveto.js), kept where it is on its own
// page too.
export function newUnit(page, box, lifted = false) {
  const id = (page.temp = (page.temp ?? 0) - 1),
    here = { x: box.x0 - PAD, y: box.y0 - PAD };
  // (isCanvas takes the page)
  if (isCanvas(page)) {
    // (on a canvas, where it's drawn, kept there by the store)
    (page.pending ??= []).push({ id, place: here });
    page.origins.set(id, here);
    return id;
  }
  const column = columnAt(page, (box.x0 + box.x1) / 2),
    place = placeAmong(page, { id, h: 0, day: today(), column }, page.laid?.units.length);
  (page.pending ??= []).push({ id, column });
  page.origins.set(id, lifted ? here : (place ?? { x: 0, y: Math.max(TITLE_H, here.y) }));
  return id;
}
// The masonry's column under an x on the page (its px), the nearest where it's beside the grid
export const columnAt = (page, x) => columnUnder(x - INSET / (page.scale ?? 1), page.columns ?? 1);
// A pending unit made in the store: its id the store's from now on
export function madeUnit(page, temp, id) {
  page.pending = (page.pending ?? []).filter(p => p.id !== temp);
  page.origins.set(id, page.origins.get(temp));
  page.origins.delete(temp);
  // (and its place under its new id: its ink is drawn at it before the page is laid again)
  for (const p of [...(page.places ?? []), ...(page.laid?.units ?? [])]) if (p.id === temp) p.id = id;
  for (const list of Object.values(LISTS)) for (const el of page[list] ?? []) if (el.g === temp) el.g = id;
}

// An element as the store keeps it: in its unit's own px
export const localOf = (page, kind, el) => byOrigin(page, kind, el, -1);
// An element of the store's at its unit's place on the page, in the page's px
export const laidOf = (page, kind, el) => byOrigin(page, kind, el, 1);
function byOrigin(page, kind, el, sign) {
  const o = page.origins?.get(el.g);
  if (!o) return el;
  const copy = { ...el };
  shift(kind, copy, sign * o.x, sign * o.y);
  return copy;
}
