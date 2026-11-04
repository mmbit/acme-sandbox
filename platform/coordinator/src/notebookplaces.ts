// A sketch page's units at their own places (sketchcanvas.js): a place HQ gives a unit that has none, one made where
// it's drawn, and one split out beside its unit.
import { db, inOneStep } from './db.ts';
import { BOARD } from './ink/book.ts';
import { changed, pageChapter, type NotebookPage } from './notebook.ts';
import { isRefused, type Refused } from './pagechecks.ts';
import { isUnitOn, openPage, row, shown, type Group, type Parts } from './notebookgroups.ts';
import { isCanvas, isPlace, isPush, liftedOut, pushedDown } from '../../hq/shell/ink/sketchcanvas.js';
import { unitOf } from '../../hq/shell/ink/scrapunit.js';

// A unit's place on a canvas: its top-left in the page's px
export type Place = { x: number; y: number };

// Whether a page is a canvas: one of the board's sketches
export const onCanvas = (p: NotebookPage) => isCanvas(pageChapter(p));

// POST /api/notebooks/groups/place { page, places: [{ id, x, y }] }: units of a sketch page placed where they have
// none yet, as HQ laid them. A unit placed already keeps its place: the first screen's stands. → { groups }, the units
// named, each with the place the store keeps
export function placeGroups(b: any, who = BOARD) {
  const p = openPage(Number(b?.page), who);
  if (isRefused(p)) return p;
  if (!onCanvas(p)) return [400, 'only a sketch page places its units'] as Refused;
  if (!Array.isArray(b.places) || !b.places.every(isPlace)) return [400, 'places: [{ id, x, y }]'] as Refused;
  const units = (b.places as (Place & { id: unknown })[]).map(place => ({ place, g: row(Number(place.id)) }));
  if (!units.every(u => isUnitOn(u.g, p.id))) return [400, 'each id is a unit on this page'] as Refused;
  const now = new Date().toISOString(),
    put = db.prepare('update notebook_groups set place = ?, updated = ? where id = ? and place is null'),
    placed = units.filter(u => put.run(placeJson(u.place), now, u.g!.id).changes);
  if (placed.length) changed(p.notebook, p.id);
  return { groups: units.map(u => shown(row(u.g!.id)!)) };
}
// The place a unit made on page p is given (b.place: the page's px): one on a canvas, none elsewhere
export function placeOf(p: NotebookPage, place: unknown): string | null | Refused {
  if (!onCanvas(p) || place == null) return null;
  return isPlace(place) ? placeJson(place) : ([400, 'a place is { x, y }'] as Refused);
}
// Parts split out of unit g as a unit of their own: on a canvas, left where they are; elsewhere scaled to a unit's
// width (scrapunit.js). → { parts, h, place }
export function splitOut(p: NotebookPage, g: Group, parts: Parts) {
  if (!onCanvas(p)) return { ...unitOf(parts), place: null };
  const lifted = liftedOut(parts, g.place && (JSON.parse(g.place) as Place));
  return { parts: lifted.parts as Parts, h: lifted.h, place: lifted.place && placeJson(lifted.place) };
}

// A unit g of page p made h tall by hand, in one step, and on a canvas what's below its foot moved down as its room grew
// (push { from, by, ... }, sketchcanvas.js pushedDown): a refusal for a push that isn't one or isn't on a canvas.
export function resized(p: NotebookPage, g: Group, h: number, push: unknown): Refused | void {
  if (push != null && (!isPush(push) || !onCanvas(p)))
    return [400, 'push is { top, from, x0, x1, by } on a sketch page'] as Refused;
  const others = (
      db
        .prepare(
          'select id, place from notebook_groups where page = ? and parent is null and deleted is null and id != ?',
        )
        .all(p.id, g.id) as { id: number; place: string | null }[]
    ).map(u => ({ id: u.id, place: u.place && (JSON.parse(u.place) as Place) })),
    now = new Date().toISOString(),
    put = db.prepare('update notebook_groups set place = ?, updated = ? where id = ?');
  inOneStep(() => {
    for (const u of pushedDown(others, push)) put.run(placeJson(u.place), now, u.id);
    db.prepare('update notebook_groups set h = ?, updated = ? where id = ?').run(h, now, g.id);
  });
}

const placeJson = (place: Place) => JSON.stringify({ x: place.x, y: place.y });
