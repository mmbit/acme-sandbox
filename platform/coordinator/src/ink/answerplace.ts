// Where an answer lies on its group's page, read from the store: the page's taken paper (its groups, the answers given
// and coming) and its width, given to answerspot.ts (pure) to place it. bookanswer.ts clips it there; the board's
// writing moves a spot it covers (spotsClear: notebookgroups.ts).
import { db } from '../db.ts';
import { pageRow } from '../notebook.ts';
import { partsOf, type Group } from '../notebookgroups.ts';
import { boxOf } from '../notebookparts.ts';
import { waitingOf, type Slip } from './bookslips.ts';
import {
  answerHeight,
  answerSpot,
  downAgain,
  spotBox,
  spotBoxes,
  type Box,
  type Contents,
  type Spot,
} from './answerspot.ts';

// A quick answer's height before its words are in: about 60 words
export const QUICK_WORDS = 'x'.repeat(330);

// Where an answer holding a lies on its group's page: the spot kept for it (its quick run's, now as tall as a), if
// that's still free paper, its narrow spot too, else answerSpot's among the page's groups and the answers given and
// coming (job: the run it's from, whose dots it takes), inside the page's width (what its paper showed when it was made,
// grown by the board's own ink)
export function placeFor(top: Group, a: Contents, kept: Spot | null, job: number | null): Spot {
  const box = boxOf(partsOf(top)) ?? { x: 0, y: 0, w: 0, h: 0 },
    taken = takenOn(top.page, job),
    page = pageRow(top.page, null)!;
  const there = kept && sized(kept, a);
  return there && !spotBoxes(box, there).some(b => taken.some(t => overlaps(b, t)))
    ? there
    : answerSpot(box, a, taken, page);
}
// A spot kept as tall as a at its width, its narrow spot too
const sized = (spot: Spot, a: Contents): Spot => ({
  ...spot,
  h: answerHeight(a, spot.w),
  ...(spot.narrow && { narrow: sized(spot.narrow, a) }),
});
// The page's taken paper: every group's box (replies too), every answer given and every answer coming but job's, on
// any screen (their narrow spots too)
function takenOn(page: number, job: number | null): Box[] {
  const { groups, kept } = paperOn(page, job);
  return [...groups.map(g => g.box), ...kept.flatMap(k => spotBoxes(k.root, k.spot))];
}
// When the board has written on a page: each answer's spot its groups now cover, its wide spot or its narrow one
// (written on a screen that draws the other), moved down clear of the page's taken paper again, for every screen. The
// caller tells the page.
export function spotsClear(page: number) {
  const { groups, kept } = paperOn(page, null);
  const written = groups.filter(g => g.top).map(g => g.box);
  for (const k of kept) {
    const covered = (s: Spot) => written.some(b => overlaps(spotBox(k.root, s), b));
    if (!covered(k.spot) && !(k.spot.narrow && covered(k.spot.narrow))) continue;
    const taken = [...written, ...kept.filter(o => o !== k).flatMap(o => spotBoxes(o.root, o.spot))],
      again = (s: Spot) => (covered(s) ? downAgain(k.root, s, taken) : s);
    k.spot = { ...again(k.spot), ...(k.spot.narrow && { narrow: again(k.spot.narrow) }) };
    if (k.slip !== undefined)
      db.prepare('update book_slips set spot = ? where id = ?').run(JSON.stringify(k.spot), k.slip);
    else db.prepare('update notebook_groups set asked_spot = ? where id = ?').run(JSON.stringify(k.spot), k.grp!);
  }
}
// A page's groups' boxes (top: not a reply) and the spots kept on it, each on its group's box: the answers given (slip)
// and coming but job's (grp, its dots')
type Kept = { root: Box; spot: Spot; slip?: number; grp?: number };
function paperOn(page: number, job: number | null) {
  const all = db.prepare('select * from notebook_groups where page = ? and deleted is null').all(page) as Group[];
  const boxes = new Map(all.map(g => [g.id, boxOf(partsOf(g))] as const));
  const rootBox = (g: Group) => boxes.get(g.parent ?? g.id) ?? null;
  const groups = all.flatMap(g => {
    const box = boxes.get(g.id);
    return box ? [{ box, top: g.parent === null }] : [];
  });
  const kept: Kept[] = [];
  const ids = all.map(g => g.id);
  const slips = ids.length
    ? (db
        .prepare(`select * from book_slips where grp in (${ids.map(() => '?').join(', ')}) and spot is not null`)
        .all(...ids) as Slip[])
    : [];
  for (const s of slips) {
    const root = rootBox(all.find(x => x.id === s.grp)!);
    if (root) kept.push({ root, spot: JSON.parse(s.spot!) as Spot, slip: s.id });
  }
  for (const g of all) {
    const root = rootBox(g);
    if (root && g.asked_spot && g.asked !== job && waitingOf(g)?.style === 'text')
      kept.push({ root, spot: JSON.parse(g.asked_spot) as Spot, grp: g.id });
  }
  return { groups, kept };
}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
