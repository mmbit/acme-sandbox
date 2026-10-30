// A scrap onto a notebook's current page, stacked under what's on it: a snip cut of a page somewhere, or a typed note
// (review mode's general note). Its group is a page's like any other (notebookgroups.ts).
import { randomBytes } from 'node:crypto';
import { keepPicture } from './notebookpictures.ts';
import { emptyGroup, shifted, typedBoxes } from '../../hq/shell/ink/notebookparts.js';
import { boxOf, nextScrap, scrapSize, STACK } from '../../hq/shell/ink/notebookstack.js';
import { db } from './db.ts';
import { findAgent } from './jobs.ts';
import { pictureSize } from '../../../shared/pictures/size.ts';
import { BOARD } from './ink/book.ts';
import { anchorOf, dataUrlPicture, isRefused, textsOf, wordsOf, type Anchor, type Refused } from './pagechecks.ts';
import { tooBig, type Scrap } from './pagescraps.ts';
import { currentPage, mine, notebookRow, pageRow, type NotebookPage } from './notebook.ts';
import { judgeLater } from './ink/bookjudge.ts';
import { BOOK_FULL, noRoomFor } from './ink/sketchpeople.ts';
import { insertGroup, partsOf, shown, type Group } from './notebookgroups.ts';

// POST /api/notebooks/groups/scrap { anchor, words?, said?, snip, owner?, notebook? }: a scrap onto the current page of
// a notebook (My Notebook by default), stacked under what's on it: the snip (a PNG or JPEG data URL) its picture.
// by: who wrote it, the notebook's own person, or an invited person's note on a share in the board's (ink/bookreview.ts)
export function createScrap(b: any, who = BOARD, by = who) {
  const nb = b?.notebook === undefined ? mine(who) : notebookRow(Number(b.notebook), who);
  if (!nb) return 404;
  return createPageScrap(b, pageRow(currentPage(nb.id), who)!, by);
}

// The review share chooses its guest's page on the server before this writer is called. who: who wrote it.
export function createPageScrap(b: any, p: NotebookPage, who: string) {
  if (p.send_at !== null) return [409, 'un-send this page before adding a scrap', 'pageSent'] as Refused;
  const anchor = anchorOf(b.anchor);
  if (isRefused(anchor)) return anchor;
  const said = wordsOf(b.words, b.said);
  if (isRefused(said)) return said;
  if (b.owner != null && !(typeof b.owner === 'string' && findAgent(b.owner)))
    return [400, 'owner is the agent whose work the scrap was cut from, or null'] as Refused;
  // (no snip, review mode's general note: its words typed, stacked as a scrap.)
  if (b.snip == null) {
    if (!said.words) return [400, 'a note with no picture holds words', 'noteEmpty'] as Refused;
    const g = stackWords(p, who, said.words, {
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
  if (who !== BOARD && noRoomFor(who, snip)) return [413, BOOK_FULL] as Refused;
  const g = stackPicture(p, who, snip, {
    anchor,
    words: said.words,
    said: said.said,
    owner: b.owner ?? null,
  });
  if (who === BOARD) judgeLater({ grp: g.id }); // (a ring without words too; the board's own)
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
  const { w, h } = scrapSize(size.width, size.height),
    { x, y } = stackSpot(p, h),
    picture: Scrap = { file, x, y, w, h, tilt: 0 };
  return insertGroup(p, 'scrap', who, { ...emptyGroup, pictures: [picture] }, more);
}
// Typed words on a page, under what's on it (a call agent's notes too: ink/callnotes.ts), a post-it as a scrap's words
// are: a group of its own kind, 'note'
export function stackWords(
  p: NotebookPage,
  who: string,
  words: string,
  more: { anchor?: Anchor; owner?: string | null; said?: string | null },
) {
  const texts = typedNote(words);
  if (isRefused(texts)) return texts;
  const typed = { ...emptyGroup, texts },
    { x, y } = stackSpot(p, boxOf(typed)!.h);
  return insertGroup(p, 'note', who, shifted(typed, x, y), more);
}
const NOTE_INK = '#1d1a2f'; // (a typed note's ink: the post-it's, shared/review/postit.js)
// A typed note's words as boxes from the page's origin, a scrap wide, or the refusal (a call's agent's words typed again:
// ink/callpage.ts). Each box a line of its own id, which a call's page ties its
// ask to (ink/callasks.ts)
export const typedNote = (words: string) =>
  textsOf(typedBoxes(words, { x: 0, w: STACK.w, color: NOTE_INK }).map(t => ({ ...t, id: lineId() })))!;
const lineId = () => randomBytes(6).toString('hex');
// Where the next scrap on a page goes, h tall (notebookstack.js nextScrap: next to the newest group, or in a call's
// columns)
export function stackSpot(p: NotebookPage, h: number) {
  const groups = db
    .prepare('select * from notebook_groups where page = ? and parent is null and deleted is null')
    .all(p.id) as Group[];
  return nextScrap(
    groups.map(g => ({ id: g.id, kind: g.kind, words: g.words, box: boxOf(partsOf(g)) })),
    h,
    p.kind,
  );
}
