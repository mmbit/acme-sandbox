// A page of the book as a picture: drawn here once a change (bookrender.ts), kept in the book's DIR until the next,
// and served. (moved here from book.ts)
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from '../db.ts';
import { keepFile } from '../uploads.ts';
import { render } from './bookrender.ts';
import { DIR, notFound, serveFile } from '../pagescraps.ts';
import { BOARD, drawnOf, row, type Page } from './book.ts';
import { drawnGroups, shown, type Group } from '../notebookgroups.ts';
import { slipsUnder, underAt } from '../../../hq/shell/ink/notebookstack.js';
import { inkOf } from '../../../hq/shell/ink/agentink.js';
import type { Answer, Said, Under } from './bookrender.ts';

// GET /api/book/picture?id=: the page as a picture, drawn here (an image or nothing, never kept in a cache)
export async function servePicture(req: IncomingMessage, res: ServerResponse, who: string | null = BOARD) {
  const p = row(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')), who);
  const file = p && (await pictureOf(p));
  if (!file) return notFound(res);
  serveFile(res, file);
}
// How the pictures kept are drawn, in their files' names: a page's picture drawn another way is drawn again when next
// read. Change it with what render() draws.
const DRAWING = 'w';

// The page's picture's file in DIR: the one kept since its last change, or drawn now and kept. null: the page was
// deleted while it was drawn.
export async function pictureOf(p: Page): Promise<string | null> {
  const current = p.picture?.startsWith(`${p.id}-${DRAWING}-`);
  if (current && existsSync(`${DIR}/${p.picture}`)) return p.picture;
  const { ink, texts } = drawnOf(p.id);
  // (a notebook page's groups drawn over what the page has of its own, what's under them and its answers as wide as
  // they're set)
  const { x, y, h } = p,
    groups = drawnGroups(p.id),
    { under, answers } = answersOn(p.id);
  const drawn = {
    x,
    y,
    w: Math.max(p.x + p.w, ...[...under, ...answers].map(o => o.x + o.w)) - x,
    h,
    ink: [...JSON.parse(ink), ...groups.ink],
    scraps: [...JSON.parse(p.scraps), ...groups.pictures],
    texts: [...JSON.parse(texts), ...groups.texts],
    under,
    answers,
  };
  const png = await render(drawn, DIR);
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

// What the book draws of a page's groups past their parts:
// under each a scrap's words and the answers and replies slipped under it (notebookstack.js slipsUnder), and the answers the store
// placed at their spots (bookanswers.js), in the page's px. A version is its own page's; a reply to an answer at its
// spot is its ink, a group's part.
function answersOn(page: number) {
  const tops = db
    .prepare('select * from notebook_groups where page = ? and parent is null and deleted is null order by id')
    .all(page) as Group[];
  const under: Under[] = [],
    answers: Answer[] = [];
  for (const g of tops) {
    const { box, children } = shown(g);
    if (!box) continue;
    const slips: Said[] = slipsUnder(children).map(c =>
      c.kind === 'reply'
        ? { name: null, text: c.words || (c.ink.length ? 'Written reply' : '') }
        : { name: c.name, text: c.text, ...slipPicture(c.id) },
    );
    const words = g.kind === 'scrap' ? g.words : '';
    if (words || slips.length) under.push({ ...underAt(box, g.kind), text: words, slips });
    for (const c of children)
      if (c.kind === 'answer' && c.spot && c.style !== 'version')
        answers.push({
          ...{ x: box.x + c.spot.dx, y: box.y + c.spot.dy, w: c.spot.w },
          ...{ name: c.name, color: inkOf(c.by), text: c.text, ink: c.ink ?? [], ...slipPicture(c.id) },
        });
  }
  return { under, answers };
}
// An answer's picture's file
function slipPicture(slip: number) {
  const { picture } = (db.prepare('select picture from book_slips where id = ?').get(slip) ?? {}) as {
    picture?: string | null;
  };
  return picture ? { picture } : {};
}
