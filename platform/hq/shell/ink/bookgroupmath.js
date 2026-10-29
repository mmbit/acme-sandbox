// A Notebook page's groups as plain numbers (bookgroups.js): a group's box, which group a new line or box joins, what
// a scratch-out deletes, and what a page's change asks of the store. No DOM, so node tests it (bookgroupmath.test.js).

// a line starting this near (page px) outside a group's box starts in it
export const INSIDE_PX = 12;
// a new line joins the group drawn last when it comes this soon (ms) after it and lies this near (page px) to it, as
// the words of a line of writing do
export const NEAR = { ms: 4000, px: 72 };
// a scratch-out deletes a group it covers this much of
const COVERS = 0.5;
// a typed box's line, as the store measures it (notebookparts.ts)
const LINE_PX = 24;

const KINDS = ['ink', 'texts', 'pictures'];
export const emptyParts = () => ({ ink: [], texts: [], pictures: [] });

// The box round a group's elements in page px, { x, y, w, h }, as the store works it out; null for none
export function boxOf({ ink = [], texts = [], pictures = [] }) {
  const boxes = [
    ...ink.flatMap(s => s.points.map(([x, y]) => ({ x: x - s.size / 2, y: y - s.size / 2, w: s.size, h: s.size }))),
    ...texts.map(t => ({ x: t.x, y: t.y, w: t.w, h: LINE_PX * t.text.split('\n').length })),
    ...pictures.map(c => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
  ];
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map(b => b.x)),
    y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
}
// One element's box (kind: 'ink' | 'texts' | 'pictures')
export const elementBox = (kind, el) => boxOf({ [kind]: [el] });
// Where an element starts: a line's first point, a box's top-left, a picture's middle
const startOf = (kind, el) =>
  kind === 'ink'
    ? { x: el.points[0][0], y: el.points[0][1] }
    : kind === 'texts'
      ? { x: el.x, y: el.y }
      : { x: el.x + el.w / 2, y: el.y + el.h / 2 };
const holds = (box, { x, y }, pad) =>
  !!box && x >= box.x - pad && x <= box.x + box.w + pad && y >= box.y - pad && y <= box.y + box.h + pad;
// How far apart two boxes are (0 when they touch or overlap)
export const gap = (a, b) =>
  Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));
// How much of two boxes lies in both (px², 0 when they don't overlap)
export const overlapOf = (a, b) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const grown = (a, b) => (a ? boxOf({ pictures: [a, b] }) : b);

// Where new elements go. news: [{ kind, el }] in the order they were made, none with a group yet. groups: the page's
// open groups, [{ id, box }]. last: the group drawn in last ({ id, at, box }) or null; now: the time (ms).
//   - one starting inside a group joins it;
//   - one near the group drawn last, soon after it, joins that;
//   - the rest join each other when they're near, each such run a new group.
// Returns { sorted: [{ id (a group's, or null: a new one), items: [{ kind, el }], box }], recent: the one of them drawn
// in last (its id set once a new one's made: the next group drawn last) }.
export function sortNew(news, groups, last, now) {
  const into = groups.map(g => ({ id: g.id, box: g.box, items: [] }));
  let recent = last && now - last.at <= NEAR.ms ? into.find(g => g.id === last.id) : null;
  for (const item of news) {
    const box = elementBox(item.kind, item.el),
      start = startOf(item.kind, item.el);
    const to =
      into.find(g => g.id !== null && holds(g.box, start, INSIDE_PX)) ??
      (recent?.box && gap(recent.box, box) <= NEAR.px ? recent : null) ??
      into.find(g => g.id === null && gap(g.box, box) <= NEAR.px) ??
      into[into.push({ id: null, box: null, items: [] }) - 1];
    to.items.push(item);
    to.box = grown(to.box, box);
    recent = to;
  }
  return { sorted: into.filter(g => g.items.length), recent };
}

// The open group a scratch-out (a line scribbled back and forth: review mode's gestures.js tells, bookgroups.js) deletes:
// the one it covers most of, at least half; null when it covers none enough
export function scratched(points, groups) {
  const line = boxOf({ ink: [{ size: 0, points }] });
  let best = null,
    most = COVERS;
  for (const g of groups) {
    if (!g.box || !g.box.w || !g.box.h) continue;
    const share = overlapOf(line, g.box) / (g.box.w * g.box.h);
    if (share >= most) [best, most] = [g, share];
  }
  return best;
}

// What a page's change asks of the store: for each group the page had (base: id → its elements as last saved, each
// kind a list of JSON strings), its elements now (now: id → parts) changed, an edit; none left, a delete.
export function changesOf(base, now) {
  const edits = [],
    deletes = [];
  for (const [id, was] of base) {
    const parts = now.get(id) ?? emptyParts();
    if (!KINDS.some(k => parts[k].length)) deletes.push(id);
    else if (KINDS.some(k => !same(was[k], parts[k].map(keyOf)))) edits.push({ id, parts });
  }
  return { edits, deletes };
}
// An element as the store keeps it, for comparing (what HQ adds to one to draw it left out)
export const keyOf = el => JSON.stringify(el, (k, v) => (k === 'g' || k === 'img' || k === 'url' ? undefined : v));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
