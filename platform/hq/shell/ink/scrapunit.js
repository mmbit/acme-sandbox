// A scrap unit: one scrap on a notebook page, its own small canvas. Everything on it (a picture, typed words, ink, the
// room to write under it) is in its own scrap px, from its top-left, at its one width. The page places units
// (masonry.js) and never holds a mark of its own, so a unit's ink moves with it wherever the page reflows it.
// Pure: parts and numbers in, no DB, no DOM. The store (coordinator's notebookgroups.ts) and HQ's page share it.
import { boxOf, typedHigh } from './notebookstack.js';
import { joined, shifted } from './notebookparts.js';
import { LINE } from './bookinkmath.js';

// Every unit is this wide in its scrap px: a column's width at scale 1, wide enough for a line of handwriting.
export const UNIT_W = 320;
// The room to write under what an agent puts on a page, at first: a line of handwriting and its space
export const ROOM = 96;
// The room under a unit: ROOM under what someone put on a person's page, none under their own drawing
export const roomFor = (by, who) => (by === who ? 0 : ROOM);

// Parts in some other frame (an old page's px, a picture's own) as a unit: moved to its top-left, scaled down to
// UNIT_W where wider, and as tall as they stand plus room. Empty parts make a unit just its room tall.
// parts: { ink, texts, pictures } (notebookparts.js)
export function unitOf(parts, room = 0) {
  const box = boxOf(parts);
  if (!box) return { parts, h: room };
  const k = Math.min(1, UNIT_W / box.w);
  if (k === 1) return { parts: shifted(parts, -box.x, -box.y), h: Math.ceil(box.h) + room };
  // (a pen kept as thick as the store keeps a line stands a little past the scaled corner)
  const drawn = scaled(shifted(parts, -box.x, -box.y), k),
    corner = boxOf(drawn),
    moved = shifted(drawn, -corner.x, -corner.y),
    unit = { ...moved, texts: typedAt(moved.texts) };
  return { parts: unit, h: bottomOf(unit) + room };
}

// A unit's height once parts change on it: never shorter than they reach down, never shorter than it was
export const heightFor = (parts, h) => Math.max(h, bottomOf(parts));

// A unit resized by hand to h: down no further than its parts reach
export const resized = (parts, h) => Math.max(Math.round(h), bottomOf(parts));

// What's under one more piece on a unit: its parts joined after the ones it has, taller if they reach past it
export function added(unit, more) {
  const parts = joined(unit.parts, more);
  return { parts, h: heightFor(parts, unit.h) };
}

// Where a unit's own body ends: the bottom of its pictures and typed words, what an agent put there. Below it is the
// unit's room to write, ink and all.
export const bodyOf = parts => bottomOf({ ink: [], texts: parts.texts, pictures: parts.pictures });

// A point on the page (CSS px) in a placed unit's scrap px (place: masonry.js's, scale its layout's)
export const pointIn = (place, scale, x, y) => ({ x: (x - place.x) / scale, y: (y - place.y) / scale });

// How far down a unit's parts reach, in its scrap px (0 for none)
function bottomOf(parts) {
  const box = boxOf(parts);
  return box ? Math.ceil(box.y + box.h) : 0;
}

// Parts scaled by k from their origin: points, pictures' rects and pen sizes (no thinner than the store keeps a line),
// and typed boxes' places, their words their own size as the select tool's scaling keeps them (bookselectmath.js
// movedText)
function scaled(parts, k) {
  const line = s => ({
    ...s,
    size: Math.max(LINE.min, s.size * k),
    points: s.points.map(([x, y, ...r]) => [x * k, y * k, ...r]),
  });
  return {
    ink: parts.ink.map(line),
    texts: parts.texts.map(t => ({ ...t, x: t.x * k, y: t.y * k })),
    pictures: parts.pictures.map(c => ({ ...c, x: c.x * k, y: c.y * k, w: c.w * k, h: c.h * k })),
  };
}
// Typed boxes on a unit, top to bottom: each no wider than the unit and inside it, and down past the boxes above it
// that its words, wrapped again, would cover
function typedAt(texts) {
  const placed = new Map();
  for (const t of [...texts].sort((a, b) => a.y - b.y)) {
    const w = Math.min(t.w, UNIT_W),
      x = Math.min(t.x, UNIT_W - w);
    const above = [...placed.values()].filter(o => x < o.x + o.w && o.x < x + w).map(o => o.y + typedHigh(o));
    placed.set(t, { ...t, x, y: Math.max(t.y, ...above), w });
  }
  return texts.map(t => placed.get(t));
}
