// Review-mode marks become scraps on the writer's Ink page, ready for its Send control.
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { db, once } from '../db.ts';
import { DATA_DIR } from '../config.ts';
import { ceo } from '../company.ts';
import { publish } from '../events.ts';
import { findAgent } from '../jobs.ts';
import * as owed from '../owed.ts';
import * as pictures from '../pictures.ts';
import * as feedback from '../feedback.ts';
import { BOARD, sheetPageFor } from './book.ts';
import { addNote } from './booknotes.ts';
import { WORDS_MAX, isRefused } from '../pagechecks.ts';
import { createScrap, createPageScrap } from '../notebookscraps.ts';
import { openPageOf, pageRow } from '../notebook.ts';

// The words' most: the book's, the cut's mark ("… (cut here)") included
const WORDS_CUT = WORDS_MAX - 20;
// A snip: the screenshot around the mark with this much margin, at least SNIP_MIN (shared/review/marks.js's for the
// Pencil). The pictures go under it at the snip's width, SNIP_PX at most, each PART_PX tall at most.
const MARGIN = 24,
  SNIP_MIN = { w: 240, h: 150 },
  SNIP_PX = 1600,
  PART_PX = 2000,
  GAP = 16;

// Past the hour's most for a writer on a product (overHour)
const OVER_HOUR = {
  status: 429,
  error: `${feedback.PER_HOUR} notes in an hour is the most, so a page stuck in a loop can't flood the book. Try again in a while.`,
};
// The note review mode posted (feedback.ts saveNote's body), for its owner: the board's in its Notebook, a guest's on
// their page in the round notebook. by: who wrote it ('board', or an
// invited guest's 'guest:<grant>'). open: checked after the snip is cut, before anything is written (a guest's link may
// have ended meanwhile).
export async function toBook(
  slug: string,
  host: string,
  base: string,
  b: any,
  by = BOARD,
  open: () => feedback.Refusal | null = () => null,
  guestPage?: number,
): Promise<feedback.Refusal | Scrap> {
  const words = feedback.words(b?.note, WORDS_CUT);
  if (!words) return { status: 400, error: 'bad note' };
  const page = feedback.localPath(b.page, host, base),
    url = feedback.urlOf(host, base, page);
  if (overHour(by, feedback.urlOf(host, base, '/'))) return OVER_HOUR;
  const tooMuch = feedback.overInk(b);
  if (tooMuch) return tooMuch;
  const { element, shot } = feedback.markOf(b, url);
  const full = feedback.noRoomFor(shot);
  if (full) return full;
  const added = feedback.picturesIn(b?.pictures);
  if (!added) return { status: 400, error: 'bad note' };
  let snip: string | null;
  try {
    snip = await snipOf(
      element,
      shot?.buf ?? null,
      added.flatMap(p => ('buf' in p ? [p.buf] : [])),
    );
  } catch {
    return { status: 400, error: 'its screenshot or a picture can’t be read' };
  }
  const shut = open();
  if (shut) return shut;
  const { owner, name } = ownerOf(slug, page);
  // (video: a film's moment.)
  const { v, el, view, ink, video } = element,
    anchor = { v, url: element.url, el, view, ink, video };
  const said = b.said === 'spoken' ? 'spoken' : 'typed';
  // The board uses My Notebook. The authenticated review share selects its guest's page.
  const note = { anchor, words, said, snip, owner, name };
  if (by === BOARD) return scrapped(slug, page, note);
  const target = guestPage && pageRow(guestPage, by);
  if (!target) return { status: 403, error: 'open the notebook from your review invitation first' };
  const group = createPageScrap({ ...note, anchor: { ...anchor, ink: [] } }, target, by);
  if (isRefused(group)) return { status: group[0], error: group[1] };
  return { ok: true, id: group.id, page: group.page, owner, name };
}
// The board's note as a scrap (notebookscraps.ts createScrap), heard by the owner's log as a sheet's note was
function scrapped(slug: string, page: string, b: Scrapped): feedback.Refusal | Scrap {
  // (its lines only in its snip, never on its anchor: rule zero, the board's, 2026-10-27)
  const anchor = { ...(b.anchor as object), ink: [] };
  // (no notebook asked for: My Notebook, made when there's none, so never createScrap's 404)
  const g = createScrap({ anchor, words: b.words, said: b.said, snip: b.snip, owner: b.owner }) as Exclude<
    ReturnType<typeof createScrap>,
    number
  >;
  if (isRefused(g)) return { status: g[0], error: g[1] };
  publish({
    type: 'log',
    agent: b.owner,
    text: `A review note on ${owed.about(slug, page)} is in the board's Notebook, for ${b.name}`,
  });
  return { ok: true, id: g.id, page: g.page, owner: b.owner, name: b.name };
}
type Scrapped = { anchor: any; words: string; said: string; snip: string | null; owner: string; name: string };
type Scrap = { ok: true; id: number; page: number; owner: string; name: string };

// For review mode's menu on a page (GET /__review/mine, the board's): whose sheet a note there joins, and how many
// notes are on it now. On HQ, where each thing on the page names its own owner (the Pencil's markpage.js), the menu
// names the sheet the board's last note there went to (last: an agent id, ?owner=), else the page's own: the same
// owner the sheet goes to, never another's (the board, 2026-10-26).
export function menuOf(slug: string, page: string, last: string | null = null) {
  const { owner, name } = slug === feedback.HQ && last && findAgent(last) ? named(last) : ownerOf(slug, page);
  return { book: { owner, name }, notes: onNewestPage() };
}

// Whose sheet a note on a page goes on: an agent on a desk, or the CEO, who passes it on. HQ's page as a whole is
// nobody's, so the CEO's, as the Pencil's notes on it are (shared/review/markpage.js ownerOf)
function ownerOf(slug: string, page: string) {
  if (slug === feedback.HQ) return named(ceo());
  const { agent } = feedback.ownerOf(owed.about(slug, page));
  return named(findAgent(agent) ? agent : ceo());
}
const named = (owner: string) => ({ owner, name: findAgent(owner)?.name ?? owner });
// The board's notes on My Notebook's current page, where its notes go now and the book opens (notebook.ts openPageOf):
// what it wrote or cut there and hasn't sent. None before it has one.
function onNewestPage() {
  const mine = db.prepare("select id from notebooks where who = ? and kind = 'mine'").get(BOARD) as
    { id: number } | undefined;
  const page = mine && openPageOf(mine.id);
  if (!page) return 0;
  const { n } = db
    .prepare(
      `select count(*) n from notebook_groups where page = ? and by = ? and parent is null and deleted is null
       and status = 'open'`,
    )
    .get(page, BOARD) as { n: number };
  return n;
}
// Whether a writer has had PER_HOUR notes on this product (its pages' addresses start with origin) in the last hour
function overHour(by: string, origin: string) {
  const hourAgo = new Date(Date.now() - 36e5).toISOString();
  const { n } = db
    .prepare(
      `select count(*) n from book_notes where by = ? and created > ?
       and substr(json_extract(anchor, '$.url'), 1, ?3) = ?4`,
    )
    .get(by, hourAgo, origin.length, origin) as { n: number };
  // (and the board's notes in its Notebook not sent yet, a scrap or a typed note: a sent one is a book note above.
  const scraps = db
    .prepare(
      `select count(*) n from notebook_groups where by = ? and created > ? and note is null and parent is null
       and substr(json_extract(anchor, '$.url'), 1, ?3) = ?4`,
    )
    .get(by, hourAgo, origin.length, origin) as { n: number };
  return n + scraps.n >= feedback.PER_HOUR;
}

// The snip as a JPEG data URL, or null with neither a screenshot nor a picture: the screenshot around the mark (the
// whole screen for a mark without a place), then the pictures under it, one column on white
async function snipOf(element: Mark, shot: Buffer | null, added: Buffer[]) {
  const parts = [...(shot ? [await around(shot, element)] : []), ...added];
  if (!parts.length) return null;
  const sized = await Promise.all(
    parts.map(p =>
      sharp(p)
        .resize({ width: SNIP_PX, height: PART_PX, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true }),
    ),
  );
  const W = Math.max(...sized.map(s => s.info.width)),
    H = sized.reduce((h, s) => h + s.info.height, 0) + GAP * (sized.length - 1);
  let top = 0;
  const layers = sized.map(s => {
    const layer = { input: s.data, left: Math.round((W - s.info.width) / 2), top };
    top += s.info.height + GAP;
    return layer;
  });
  const column = await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
    .composite(layers)
    .png()
    .toBuffer();
  return `data:image/jpeg;base64,${(await fitted(column, W)).toString('base64')}`;
}
type Mark = ReturnType<typeof feedback.markOf>['element'];
// The screenshot (the screen as it was, review mode's lines drawn on it) cut around the mark, as the Pencil's snip is
async function around(shot: Buffer, element: Mark) {
  const { width = 0, height = 0 } = await sharp(shot).metadata();
  const k = element.view.w > 0 ? width / element.view.w : 1,
    W = width / k,
    H = height / k;
  const mark = element.area ?? element.el?.box;
  if (!mark) return shot;
  const area = { x: mark.x - element.view.x, y: mark.y - element.view.y, w: mark.w, h: mark.h };
  const w = Math.min(W, Math.max(SNIP_MIN.w, area.w + 2 * MARGIN)),
    h = Math.min(H, Math.max(SNIP_MIN.h, area.h + 2 * MARGIN));
  const x = Math.min(W - w, Math.max(0, area.x + area.w / 2 - w / 2)),
    y = Math.min(H - h, Math.max(0, area.y + area.h / 2 - h / 2));
  const left = Math.max(0, Math.round(x * k)),
    top = Math.max(0, Math.round(y * k));
  return sharp(shot)
    .extract({
      left,
      top,
      width: Math.max(1, Math.min(width - left, Math.round(w * k))),
      height: Math.max(1, Math.min(height - top, Math.round(h * k))),
    })
    .png()
    .toBuffer();
}
// A JPEG of the column within the book's most for a picture: smaller and plainer until it fits
async function fitted(column: Buffer, width: number) {
  let out = column;
  for (const scale of [1, 0.7, 0.5, 0.35])
    for (const quality of [85, 65]) {
      out = await sharp(column)
        .resize({ width: Math.max(1, Math.round(width * scale)) })
        .jpeg({ quality })
        .toBuffer();
      if (out.length <= pictures.MAX_BYTES) return out;
    }
  return out;
}

// The board's notes that waited on products (status pending) before notes went to the book: each moved onto its owner's
// sheet as an open note, so none is lost. Its snip: its screenshot whole, or without one its first picture (the rest of
// its pictures stay behind, in its row). One the sheet has no room for keeps waiting, and says so in the log.
once('2026-10-26-pending-review-notes-to-book', () => {
  const waiting = db
    .prepare("select * from review_notes where status = 'pending' and share is null order by id")
    .all() as any[];
  for (const n of waiting) {
    const element = JSON.parse(n.element),
      viewport = JSON.parse(n.viewport ?? '{}');
    const file = n.shot ?? JSON.parse(n.pictures ?? '[]')[0];
    const snip = file && readPicture(file);
    const { owner } = ownerOf(n.slug, n.page);
    const page = sheetPageFor(owner, element.url, Number(viewport.w) || 1024, Number(viewport.h) || 768);
    const el = element.el?.box ? element.el : null,
      anchor = { v: 1, url: element.url, el, view: element.view, ink: element.ink ?? [] };
    const words = feedback.words(n.note, WORDS_CUT);
    const noted = addNote({ page: page.id, anchor, words, said: 'typed', snip }, BOARD, false);
    if (typeof noted === 'number' || isRefused(noted)) {
      console.error(`Review note #${n.id}: not moved to the book:`, noted);
      continue;
    }
    db.prepare("update review_notes set status = 'moved' where id = ?").run(n.id);
  }
});
// A review note's file as a data URL, or null if it's gone
function readPicture(file: string) {
  try {
    const raw = readFileSync(`${DATA_DIR}/review/${file}`);
    return `data:image/${file.endsWith('.png') ? 'png' : 'jpeg'};base64,${raw.toString('base64')}`;
  } catch {
    return null;
  }
}
