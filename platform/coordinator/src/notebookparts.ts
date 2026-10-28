// A notebook group's elements as one (notebookgroups.ts): their box, joined, shifted, and a lasso's picks of them, in
// page px. Pure: nothing stored here.
import { TEXT_MAX } from './pagechecks.ts';
import type { Scrap } from './pagescraps.ts';

export type Parts = { ink: unknown[]; texts: unknown[]; pictures: Scrap[] };
export const emptyGroup: Parts = { ink: [], texts: [], pictures: [] };
export const hasAny = (p: Parts) => p.ink.length + p.texts.length + p.pictures.length > 0;
export const joined = (a: Parts, b: Parts): Parts => ({
  ink: [...a.ink, ...b.ink],
  texts: [...a.texts, ...b.texts],
  pictures: [...a.pictures, ...b.pictures],
});
export const shifted = (p: Parts, dx: number, dy: number): Parts => ({
  ink: (p.ink as { points: number[][] }[]).map(s => ({
    ...s,
    points: s.points.map(([x, y, ...r]) => [x + dx, y + dy, ...r]),
  })),
  texts: (p.texts as { x: number; y: number }[]).map(t => ({ ...t, x: t.x + dx, y: t.y + dy })),
  pictures: p.pictures.map(c => ({ ...c, x: c.x + dx, y: c.y + dy })),
});
export const picks = <T>(v: unknown, from: T[]) =>
  v === undefined
    ? []
    : Array.isArray(v) && v.every(i => Number.isInteger(i) && i >= 0 && i < from.length)
      ? [...new Set(v as number[])]
      : null;
// The box round a group's elements, in its page's px (null: nothing in it)
export function boxOf(p: Parts) {
  const boxes = [
    ...(p.ink as { size: number; points: number[][] }[]).flatMap(s =>
      s.points.map(([x, y]) => ({ x: x - s.size / 2, y: y - s.size / 2, w: s.size, h: s.size })),
    ),
    ...(p.texts as { x: number; y: number; w: number; text: string }[]).map(t => ({
      x: t.x,
      y: t.y,
      w: t.w,
      h: 24 * t.text.split('\n').length,
    })),
    ...p.pictures.map(c => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
  ];
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map(b => b.x)),
    y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
}
// Words as typed boxes one under another from y 0, at most max (TEXT_MAX) characters each, a box ending at its last
// space where it has one (kept: together the boxes are the words whole).
export function typedBoxes(words: string, at: { x: number; w: number; color: string }, max = TEXT_MAX) {
  const boxes: { x: number; y: number; w: number; text: string; color: string }[] = [];
  let rest = [...words],
    y = 0;
  while (rest.length) {
    const space = rest.length > max ? rest.lastIndexOf(' ', max - 1) : -1;
    const cut = rest.length <= max ? rest.length : space > 0 ? space + 1 : max;
    const box = { ...at, y, text: rest.slice(0, cut).join('') };
    rest = rest.slice(cut);
    if (!box.text.trim()) continue;
    boxes.push(box);
    y += boxOf({ ...emptyGroup, texts: [box] })!.h;
  }
  return boxes;
}
