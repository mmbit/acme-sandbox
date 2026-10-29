// Where an answer lies on its group's page, read from the store: the page's taken paper (its groups, the answers given
// and coming) and its width, given to answerspot.ts (pure) to place it. bookanswer.ts clips it there; the board's
// groups move a spot they come to cover (spotsClear: notebookgroups.ts).
import { readFileSync } from 'node:fs';
import { pictureSize } from '../../../../shared/pictures/size.ts';
import { db, once } from '../db.ts';
import { pageRow } from '../notebook.ts';
import { DIR } from '../pagescraps.ts';
import { partsOf, type Group } from '../notebookgroups.ts';
import { boxOf } from '../notebookparts.ts';
import { waitingOf, type Slip } from './bookslips.ts';
import {
  answerHeight,
  answerSpot,
  downAgain,
  overlapping,
  spotAgain,
  spotBox,
  spotBoxes,
  type Box,
  type Contents,
  type Spot,
} from './answerspot.ts';

// A quick answer's height before its words are in: about 60 words
export const QUICK_WORDS = 'x'.repeat(330);

// Where an answer holding a lies on its group's page: the spot kept for it (its quick run's, now as tall as a), if
// that's still free paper, its narrow spots too, else answerSpot's among the page's groups and the answers given and
// coming (job: the run it's from, whose dots it takes), inside the page's width (what its paper showed when it was made,
// grown by the board's own ink)
export function placeFor(top: Group, a: Contents, kept: Spot | null, job: number | null): Spot {
  const box = boxOf(partsOf(top)) ?? { x: 0, y: 0, w: 0, h: 0 },
    taken = takenOn(top.page, job),
    page = pageRow(top.page, null)!;
  const there = kept && sized(kept, a);
  return there && !spotBoxes(box, there).some(b => taken.some(t => overlapping(b, t)))
    ? there
    : answerSpot(box, a, taken, page);
}
// A spot kept as tall as a at its width, its narrow spots too
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
// When the board's groups on a page change (written, edited, moved onto it, brought back by Undo): each answer's spot
// they now cover, its wide one or a narrow one (on a screen that draws another), and each answer coming's dots, moved
// down clear of the page's taken paper again, for every screen. The caller tells the page.
export function spotsClear(page: number) {
  const { groups, kept } = paperOn(page, null);
  const written = groups.filter(g => g.top).map(g => g.box);
  for (const k of kept) {
    if (!spotBoxes(k.root, k.spot).some(s => written.some(b => overlapping(s, b)))) continue;
    const taken = [...written, ...kept.filter(o => o !== k).flatMap(o => spotBoxes(o.root, o.spot))],
      covered = (s: Spot) => written.some(b => overlapping(spotBox(k.root, s), b)),
      again = (s: Spot): Spot => ({
        ...(covered(s) ? downAgain(k.root, s, taken) : s),
        ...(s.narrow && { narrow: again(s.narrow) }),
      });
    k.spot = again(k.spot);
    store(k);
  }
}
const store = (k: Kept) =>
  k.slip !== undefined
    ? db.prepare('update book_slips set spot = ? where id = ?').run(JSON.stringify(k.spot), k.slip)
    : db.prepare('update notebook_groups set asked_spot = ? where id = ?').run(JSON.stringify(k.spot), k.grp!);
// Once, at the start (not as this file loads: notebookgroups.ts and this file import each other, so its tables may not
// be made yet): every spot kept from before the controls at the paper's right grew placed again for them
// (spotsNarrower).
export const spotsOnStart = () => once('2026-10-28-answer-spots-narrower', spotsNarrower);
// Every page's kept spots placed again (spotsAgain)
export function spotsNarrower() {
  const pages = db
    .prepare(
      `select distinct page from notebook_groups where deleted is null
        and (asked_spot is not null or id in (select grp from book_slips where spot is not null))`,
    )
    .all() as { page: number }[];
  for (const { page } of pages) spotsAgain(page);
}
// A page's kept spots (only: those on that group's box, as Undo brings it back: notebookgroups.ts restoreGroup) placed
// again by answerSpot's rules (spotAgain), each clear of the page's groups and the other answers as they are by then,
// for every paper down to the narrowest
export function spotsAgain(page: number, only: number | null = null) {
  const paper = pageRow(page, null);
  if (!paper) return;
  const { groups, kept } = paperOn(page, null);
  // (the board's own groups, as spotsClear takes them: a reply's ink lies in its answer's strip)
  const written = groups.filter(g => g.top).map(g => g.box);
  for (const k of kept) {
    if (only !== null && k.top !== only) continue;
    const taken = [...written, ...kept.filter(o => o !== k).flatMap(o => spotBoxes(o.root, o.spot))];
    k.spot = spotAgain(k.root, k.spot, contentsOf(k), taken, paper);
    store(k);
  }
}
// What a kept answer holds, for its height on narrower paper: a slip's words, ink, form and picture (its kept file's
// size); an answer coming, a quick run's words
function contentsOf(k: Kept): Contents {
  if (k.slip === undefined) return { text: QUICK_WORDS };
  const s = db.prepare('select * from book_slips where id = ?').get(k.slip) as Slip,
    ink = s.ink ? (boxOf({ ink: JSON.parse(s.ink), texts: [], pictures: [] })?.h ?? 0) : 0,
    picture = s.picture ? pictureSize(readFileSync(`${DIR}/${s.picture}`)) : null;
  return { text: s.text, ink, questions: s.form ? (JSON.parse(s.form) as unknown[]).length : 0, picture };
}
// A page's groups' boxes (top: not a reply) and the spots kept on it, each on its group's box: the answers given (slip)
// and coming but job's (grp, its face's while it shows: its dots, or why an ended ask brought none)
type Kept = { root: Box; top: number; spot: Spot; slip?: number; grp?: number };
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
    const g = all.find(x => x.id === s.grp)!,
      root = rootBox(g);
    if (root) kept.push({ root, top: g.parent ?? g.id, spot: JSON.parse(s.spot!) as Spot, slip: s.id });
  }
  for (const g of all) {
    const root = rootBox(g);
    if (root && g.asked_spot && g.asked !== job && waitingOf(g)?.style === 'text')
      kept.push({ root, top: g.parent ?? g.id, spot: JSON.parse(g.asked_spot) as Spot, grp: g.id });
  }
  return { groups, kept };
}
