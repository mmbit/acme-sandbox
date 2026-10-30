// A scrap onto a notebook's current page as its last unit, with room to write under it: a snip cut of a page somewhere,
// or a typed note (review mode's general note). Its group is a page's like any other (notebookgroups.ts).
import { randomBytes } from 'node:crypto';
import { keepPicture } from './notebookpictures.ts';
import { emptyGroup, typedBoxes } from '../../hq/shell/ink/notebookparts.js';
import { scrapSize } from '../../hq/shell/ink/notebookstack.js';
import { ROOM, UNIT_W, unitOf } from '../../hq/shell/ink/scrapunit.js';
import { findAgent } from './jobs.ts';
import { pictureSize } from '../../../shared/pictures/size.ts';
import { BOARD } from './ink/book.ts';
import { anchorOf, dataUrlPicture, isRefused, textsOf, wordsOf, type Anchor, type Refused } from './pagechecks.ts';
import { tooBig, type Scrap } from './pagescraps.ts';
import { currentPage, mine, notebookRow, pageRow, type NotebookPage } from './notebook.ts';
import { judgeLater } from './ink/bookjudge.ts';
import { BOOK_FULL, noRoomFor } from './ink/sketchpeople.ts';
import { insertGroup, shown, type Parts } from './notebookgroups.ts';

// POST /api/notebooks/groups/scrap { anchor, words?, said?, snip, owner?, notebook? }: a scrap onto the current page of
// a notebook (My journal by default), its last: the snip (a PNG or JPEG data URL) its picture.
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
  // (no snip, review mode's general note: its words typed, a scrap.)
  if (b.snip == null) {
    if (!said.words) return [400, 'a note with no picture holds words', 'noteEmpty'] as Refused;
    const g = addWords(p, who, said.words, {
      anchor,
      owner: b.owner ?? null,
      said: said.said,
    });
    return isRefused(g) ? g : shown(g);
  }
  const g = pictureScrap(p, who, b.snip, {
    anchor,
    words: said.words,
    said: said.said,
    owner: b.owner ?? null,
  });
  if (isRefused(g)) return g;
  if (who === BOARD) judgeLater({ grp: g.id }); // (a ring without words too; the board's own)
  return shown(g);
}
// A picture scrap from its snip (a PNG or JPEG data URL), or why not: no picture, too big, or an agent's book full
// (a round's Advice too: notebookrounds.ts.)
export function pictureScrap(p: NotebookPage, who: string, snipUrl: unknown, more: Parameters<typeof addPicture>[3]) {
  const snip = dataUrlPicture(snipUrl);
  if (isRefused(snip)) return snip;
  const big = tooBig(snip.clean);
  if (big) return big;
  if (who !== BOARD && noRoomFor(who, snip)) return [413, BOOK_FULL] as Refused;
  return addPicture(p, who, snip, more);
}
// A scrap of a picture on a page, its last (a call's notes page's too: ink/callnotes.ts.)
export function addPicture(
  p: NotebookPage,
  who: string,
  snip: { type: string; clean: Buffer },
  more: { anchor?: Anchor; words: string; said: string | null; owner: string | null },
) {
  const file = keepPicture(p.id, snip),
    size = pictureSize(snip.clean)!;
  const picture: Scrap = { file, x: 0, y: 0, ...scrapSize(size.width, size.height), tilt: 0 };
  return addUnit(p, 'scrap', who, { ...emptyGroup, pictures: [picture] }, more);
}
// Typed words on a page, its last (a call agent's notes too: ink/callnotes.ts), a post-it as a scrap's words are: a
// group of its own kind, 'note'
export function addWords(
  p: NotebookPage,
  who: string,
  words: string,
  more: { anchor?: Anchor; owner?: string | null; said?: string | null },
) {
  const texts = typedNote(words);
  if (isRefused(texts)) return texts;
  return addUnit(p, 'note', who, { ...emptyGroup, texts }, more);
}
// What someone puts on a page as a unit of its own, with room to write under it
const addUnit = (p: NotebookPage, kind: 'scrap' | 'note', who: string, parts: Parts, more: object) => {
  const unit = unitOf(parts, ROOM);
  return insertGroup(p, kind, who, unit.parts as Parts, { ...more, h: unit.h });
};
const NOTE_INK = '#1d1a2f'; // (a typed note's ink: the post-it's, shared/review/postit.js)
// A typed note's words as boxes from the unit's top-left, a unit wide, or the refusal (a call's agent's words typed
// again: ink/callpage.ts). Each box a line of its own id, which a call's page ties its ask to (ink/callasks.ts)
export const typedNote = (words: string) =>
  textsOf(typedBoxes(words, { x: 0, w: UNIT_W, color: NOTE_INK }).map(t => ({ ...t, id: lineId() })))!;
const lineId = () => randomBytes(6).toString('hex');
