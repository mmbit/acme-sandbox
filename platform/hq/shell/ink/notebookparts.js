// A notebook group's elements as one, for the coordinator's store (notebookgroups.ts, notebookscraps.ts) and its play
// in memory (notebookplaygroups.js): joined, shifted, a lasso's picks of them, and words typed into boxes, in page px
// (their box: notebookstack.js). Pure: nothing stored, no DOM.
import { boxOf } from './notebookstack.js';

// a typed box holds at most this many characters (pagechecks.ts checks a page's against it)
export const TEXT_MAX = 2000;

export const emptyGroup = { ink: [], texts: [], pictures: [] };
export const hasAny = p => p.ink.length + p.texts.length + p.pictures.length > 0;
export const joined = (a, b) => ({
  ink: [...a.ink, ...b.ink],
  texts: [...a.texts, ...b.texts],
  pictures: [...a.pictures, ...b.pictures],
});
export const shifted = (p, dx, dy) => ({
  ink: p.ink.map(s => ({ ...s, points: s.points.map(([x, y, ...r]) => [x + dx, y + dy, ...r]) })),
  texts: p.texts.map(t => ({ ...t, x: t.x + dx, y: t.y + dy })),
  pictures: p.pictures.map(c => ({ ...c, x: c.x + dx, y: c.y + dy })),
});
// A lasso's indexes of a group's elements, once each (null: not its own)
export const picks = (v, from) =>
  v === undefined
    ? []
    : Array.isArray(v) && v.every(i => Number.isInteger(i) && i >= 0 && i < from.length)
      ? [...new Set(v)]
      : null;
// Words as typed boxes one under another from y 0, at most max characters each, a box ending at its last space where
// it has one (kept: together the boxes are the words whole)
export function typedBoxes(words, at, max = TEXT_MAX) {
  const boxes = [];
  let rest = [...words],
    y = 0;
  while (rest.length) {
    const space = rest.length > max ? rest.lastIndexOf(' ', max - 1) : -1;
    const cut = rest.length <= max ? rest.length : space > 0 ? space + 1 : max;
    const box = { ...at, y, text: rest.slice(0, cut).join('') };
    rest = rest.slice(cut);
    if (!box.text.trim()) continue;
    boxes.push(box);
    y += boxOf({ ...emptyGroup, texts: [box] }).h;
  }
  return boxes;
}
