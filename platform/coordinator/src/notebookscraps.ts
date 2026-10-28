// A scrap onto a notebook's current page, stacked under what's on it: a snip cut of a page somewhere, or a typed note
// (review mode's general note). Its group is a page's like any other (notebookgroups.ts). (out of notebookgroups.ts, for its size)
import { keepPicture } from './notebookpictures.ts';
import { emptyGroup, shifted, typedBoxes, boxOf } from './notebookparts.ts';
import { db } from './db.ts';
import { findAgent } from './jobs.ts';
import { pictureSize } from '../../../shared/pictures/size.ts';
import { BOARD } from './ink/book.ts';
import { anchorOf, dataUrlPicture, isRefused, textsOf, wordsOf, type Anchor, type Refused } from './pagechecks.ts';
import { tooBig, type Scrap } from './pagescraps.ts';
import { currentPage, mine, notebookRow, pageRow, type NotebookPage } from './notebook.ts';
import { judgeLater } from './ink/bookjudge.ts';
import { insertGroup, partsOf, shown, type Group } from './notebookgroups.ts';

// Where a scrap lands on its page: under what's there, this far apart
const STACK = { x: 40, gap: 32, w: 360, top: 80 }; // (top: under the page's heading)

// POST /api/notebooks/groups/scrap { anchor, words?, said?, snip, owner?, notebook? }: a scrap onto the current page of
// a notebook (My Notebook by default), stacked under what's on it: the snip (a PNG or JPEG data URL) its picture
export function createScrap(b: any, who = BOARD) {
  const nb = b?.notebook === undefined ? mine(who) : notebookRow(Number(b.notebook), who);
  if (!nb) return 404;
  const anchor = anchorOf(b.anchor);
  if (isRefused(anchor)) return anchor;
  const said = wordsOf(b.words, b.said);
  if (isRefused(said)) return said;
  if (b.owner != null && !(typeof b.owner === 'string' && findAgent(b.owner)))
    return [400, 'owner is the agent whose work the scrap was cut from, or null'] as Refused;
  // (no snip, review mode's general note: its words typed, stacked as a scrap.)
  if (b.snip == null) {
    if (!said.words) return [400, 'a note with no picture holds words', 'noteEmpty'] as Refused;
    const g = stackWords(pageRow(currentPage(nb.id), who)!, who, said.words, {
      anchor,
      owner: b.owner ?? null,
      said: said.said,
    });
    return isRefused(g) ? g : shown(g);
  }
  const snip = dataUrlPicture(b.snip);
  if (isRefused(snip)) return snip;
  const big = tooBig(snip.clean);
  if (big) return big;
  const g = stackPicture(pageRow(currentPage(nb.id), who)!, who, snip, {
    anchor,
    words: said.words,
    said: said.said,
    owner: b.owner ?? null,
  });
  if (who === BOARD) judgeLater({ grp: g.id }); // (a ring without words too)
  return shown(g);
}
// A scrap of a picture on a page, under what's on it (a call's notes page's too: ink/callnotes.ts.)
export function stackPicture(
  p: NotebookPage,
  who: string,
  snip: { type: string; clean: Buffer },
  more: { anchor: Anchor; words: string; said: string | null; owner: string | null },
) {
  const file = keepPicture(p.id, snip),
    size = pictureSize(snip.clean)!;
  const w = Math.min(STACK.w, size.width),
    picture: Scrap = {
      file,
      x: STACK.x,
      y: stackFoot(p.id),
      w,
      h: Math.round((size.height * w) / size.width),
      tilt: 0,
    };
  return insertGroup(p, 'scrap', who, { ...emptyGroup, pictures: [picture] }, more);
}
// Typed words on a page, under what's on it (a call agent's notes too: ink/callnotes.ts)
export function stackWords(
  p: NotebookPage,
  who: string,
  words: string,
  more: { anchor?: Anchor; owner?: string | null; said?: string | null },
) {
  const texts = textsOf(typedBoxes(words, { x: STACK.x, w: STACK.w, color: NOTE_INK }))!;
  if (isRefused(texts)) return texts;
  return insertGroup(p, 'drawing', who, shifted({ ...emptyGroup, texts }, 0, stackFoot(p.id)), more);
}
const NOTE_INK = '#1d1a2f'; // (a typed note's ink: the post-it's, shared/review/postit.js)
// The foot of what's on a page, where the next scrap goes
export function stackFoot(page: number) {
  const groups = db.prepare('select * from notebook_groups where page = ? and deleted is null').all(page) as Group[];
  const feet = groups
    .map(g => boxOf(partsOf(g)))
    .filter(b => b !== null)
    .map(b => b.y + b.h);
  return feet.length ? Math.round(Math.max(...feet) + STACK.gap) : STACK.top;
}
