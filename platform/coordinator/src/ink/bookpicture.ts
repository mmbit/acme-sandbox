// A page of the book as a picture: drawn here once a change (bookrender.ts), kept in the book's DIR until the next,
// and served. (moved here from book.ts)
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from '../db.ts';
import { keepFile } from '../uploads.ts';
import { render, underHigh, type Drawn, type Said } from './bookrender.ts';
import { DIR, notFound, serveFile } from '../pagescraps.ts';
import { BOARD, drawnOf, row, type Page } from './book.ts';
import { partsOf, shown, type Group } from '../notebookgroups.ts';
import { CAPTION, slipsUnder, underAt } from '../../../hq/shell/ink/notebookstack.js';
import { shifted } from '../../../hq/shell/ink/notebookparts.js';
import { UNIT_W } from '../../../hq/shell/ink/scrapunit.js';
import type { Stroke, Typed } from '../pagechecks.ts';
import { layout, widthFor } from '../../../hq/shell/ink/masonry.js';

// GET /api/book/picture?id=: the page as a picture, drawn here (an image or nothing, never kept in a cache)
export async function servePicture(req: IncomingMessage, res: ServerResponse, who: string | null = BOARD) {
  const p = row(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')), who);
  const file = p && (await pictureOf(p));
  if (!file) return notFound(res);
  serveFile(res, file);
}
// How the pictures kept are drawn, in their files' names: a page's picture drawn another way is drawn again when next
// read. Change it with what render() draws.
const DRAWING = 'u';

// The page's picture's file in DIR: the one kept since its last change, or drawn now and kept. null: the page was
// deleted while it was drawn.
export async function pictureOf(p: Page): Promise<string | null> {
  const current = p.picture?.startsWith(`${p.id}-${DRAWING}-`);
  if (current && existsSync(`${DIR}/${p.picture}`)) return p.picture;
  const page = db.prepare('select notebook from book_pages where id = ?').get(p.id) as { notebook: number | null };
  const png = await render(page.notebook === null ? bookPage(p) : await unitsPage(p.id), DIR);
  const name = `${p.id}-${DRAWING}-${randomBytes(4).toString('hex')}.png`;
  keepFile(`${DIR}/${name}`, png);
  // (a change while it was drawn, or another draw of the same page kept first: this one goes, and the page's picture
  // now is the one read)
  const kept = db
    .prepare('update book_pages set picture = ? where id = ? and updated = ? and picture is ?')
    .run(name, p.id, p.updated, p.picture);
  if (!kept.changes) {
    rmSync(`${DIR}/${name}`, { force: true });
    const now = row(p.id, null);
    return now ? pictureOf(now) : null;
  }
  if (p.picture) rmSync(`${DIR}/${p.picture}`, { force: true });
  return name;
}

// A page of the book's own, from before the notebook: its ink, typed words and scraps where they lie
function bookPage(p: Page): Drawn {
  const { ink, texts } = drawnOf(p.id);
  return {
    ...{ x: p.x, y: p.y, w: p.w, h: p.h },
    ink: JSON.parse(ink),
    scraps: JSON.parse(p.scraps),
    texts: JSON.parse(texts),
  };
}
// A notebook page as its units in their order, laid out as the page lays them, each unit's parts at its place and
// what's under it right below its height: a scrap's words and the answers and replies slipped under it
// (notebookstack.js slipsUnder), each unit as tall in the layout as it and what's under it stand. A reply's ink is its
// own group's, drawn by HQ, not on the picture.
async function unitsPage(page: number): Promise<Drawn> {
  const tops = db
    .prepare('select * from notebook_groups where page = ? and parent is null and deleted is null order by pos, id')
    .all(page) as Group[];
  const units = [];
  for (const g of tops) {
    const parts = partsOf(g),
      h = g.h!,
      slips: Said[] = slipsUnder(shown(g).children)
        .map(c =>
          c.kind === 'reply'
            ? { name: null, text: c.words || (c.ink.length ? 'Written reply' : '') }
            : { name: c.name, text: c.text, ...slipPicture(c.id) },
        )
        .filter(said => said.text?.trim()); // (an answer still being written has nothing to show yet)
    const text = g.kind === 'scrap' ? g.words : '',
      under = text || slips.length ? { ...underAt({ x: 0, y: 0, w: UNIT_W, h }, g.kind), text, slips } : null;
    const below = under ? CAPTION.top + (await underHigh(under, DIR)) : 0;
    units.push({ id: g.id, h: h + below, parts, under });
  }
  // (two columns wide: the picture agents read of a page, at scale 1)
  const w = widthFor(2),
    { places, height } = layout(units, w),
    on = units.map((u, i) => ({ ...u, parts: shifted(u.parts, places[i].x, places[i].y), at: places[i] }));
  return {
    ...{ x: 0, y: 0, w, h: height },
    ink: on.flatMap(u => u.parts.ink) as Stroke[],
    scraps: on.flatMap(u => u.parts.pictures),
    texts: on.flatMap(u => u.parts.texts) as Typed[],
    under: on.flatMap(u => (u.under ? [{ ...u.under, x: u.under.x + u.at.x, y: u.under.y + u.at.y }] : [])),
  };
}
// An answer's picture's file
function slipPicture(slip: number) {
  const { picture } = (db.prepare('select picture from book_slips where id = ?').get(slip) ?? {}) as {
    picture?: string | null;
  };
  return picture ? { picture } : {};
}
