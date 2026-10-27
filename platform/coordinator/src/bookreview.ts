// Review mode's notes on a product preview (feedback.ts saveNote), into the board's book: each one a note on the open
// sheet for the product's owner (a cycle folder's maker; HQ's the Process role's), on today's sheet page for that
// owner. Nothing on a sheet reaches an agent until the board taps the plane in HQ, behind its sign-in, after seeing the
// notes there (booksheets.ts send), so a note the product's own code posted waits with the rest, in plain sight.
//   - The note keeps its anchor (anchor.js v1: the page's whole address, the element, the view, the lines) and its
//     words. Its snip is the screenshot around the mark, with the pictures added to it below, in one picture (the book
//     keeps one a note). Its trail, the element's HTML and the browser it was seen on stay out: the book has no place
//     for them.
//   - A note's words never ask from here: only the board's own, in HQ (booknotes.ts addNote).
//   - The limits review mode always had hold: PER_HOUR notes an hour for each writer on each product, the ink's and
//     pictures' caps, and no screenshot while the disk is low (feedback.ts).
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { db, once } from './db.ts';
import { DATA_DIR } from './config.ts';
import { ceo } from './company.ts';
import { publish } from './events.ts';
import { findAgent } from './jobs.ts';
import * as owed from './owed.ts';
import * as pictures from './pictures.ts';
import * as feedback from './feedback.ts';
import { BOARD, sheetPageFor } from './book.ts';
import { addNote } from './booknotes.ts';
import { WORDS_MAX, isRefused } from './pagechecks.ts';

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
type Booked = { ok: true; id: number; n: number; owner: string; name: string };
// The note review mode posted (feedback.ts saveNote's body) on its owner's sheet. by: who wrote it ('board', or an
// invited guest's 'guest:<grant>'). open: checked after the snip is cut, before anything is written (a guest's link may
// have ended meanwhile).
export async function toBook(
  slug: string,
  host: string,
  base: string,
  b: any,
  by = BOARD,
  open: () => feedback.Refusal | null = () => null,
): Promise<feedback.Refusal | Booked> {
  const words = feedback.words(b?.note, WORDS_CUT);
  if (!words) return { status: 400, error: 'bad note' };
  const page = feedback.localPath(b.page, host, base),
    url = feedback.urlOf(host, base, page);
  if (overHour(by, feedback.urlOf(host, base, '/'))) return OVER_HOUR;
  const tooMuch = feedback.overInk(b);
  if (tooMuch) return tooMuch;
  const { element, viewport, shot } = feedback.markOf(b, url);
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
  const sheetPage = sheetPageFor(owner, url, viewport.w, viewport.h);
  // (video: a film's moment.)
  const { v, el, view, ink, video } = element,
    anchor = { v, url: element.url, el, view, ink, video };
  const said = b.said === 'spoken' ? 'spoken' : 'typed';
  const noted = addNote({ page: sheetPage.id, anchor, words, said, snip }, BOARD, false, null, by);
  if (typeof noted === 'number') return { status: noted, error: 'no such page' };
  if (isRefused(noted)) return { status: noted[0], error: noted[1] };
  // (no words here: they're page-controlled until the board has looked at them)
  publish({
    type: 'log',
    agent: owner,
    text: `A review note on ${owed.about(slug, page)} is on the board's sheet for ${name}`,
  });
  return { ok: true, id: noted.note.id, n: noted.note.n, owner, name };
}

// For review mode's menu on a page (GET /__review/mine, the board's): whose sheet a note there joins, and how many
// notes are on it now. On HQ, where each thing on the page names its own owner (the Pencil's markpage.js), the menu
// names the sheet the board's last note there went to (last: an agent id, ?owner=), else the page's own: the same
// owner the sheet goes to, never another's (the board, 2026-10-26).
export function menuOf(slug: string, page: string, last: string | null = null) {
  const { owner, name } = slug === feedback.HQ && last && findAgent(last) ? named(last) : ownerOf(slug, page);
  return { book: { owner, name }, notes: onSheet(owner), list: [], sent: false, more: false };
}

// Whose sheet a note on a page goes on: an agent on a desk, or the CEO, who passes it on. HQ's page as a whole is
// nobody's, so the CEO's, as the Pencil's notes on it are (shared/review/markpage.js ownerOf)
function ownerOf(slug: string, page: string) {
  if (slug === feedback.HQ) return named(ceo());
  const { agent } = feedback.ownerOf(owed.about(slug, page));
  return named(findAgent(agent) ? agent : ceo());
}
const named = (owner: string) => ({ owner, name: findAgent(owner)?.name ?? owner });
// The open notes on the board's unsent sheet for an owner
const onSheet = (owner: string) =>
  (
    db
      .prepare(
        `select count(*) n from book_notes n join book_sheets s on s.id = n.sheet
         where s.who = ? and s.owner = ? and s.status in ('open', 'sending') and s.page is null and n.status = 'open'`,
      )
      .get(BOARD, owner) as { n: number }
  ).n;
// Whether a writer has had PER_HOUR notes on this product (its pages' addresses start with origin) in the last hour
function overHour(by: string, origin: string) {
  const hourAgo = new Date(Date.now() - 36e5).toISOString();
  const { n } = db
    .prepare(
      `select count(*) n from book_notes where by = ? and created > ?
       and substr(json_extract(anchor, '$.url'), 1, ?) = ?`,
    )
    .get(by, hourAgo, origin.length, origin) as { n: number };
  return n >= feedback.PER_HOUR;
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
