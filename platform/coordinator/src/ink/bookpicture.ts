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
import { drawnGroups } from '../notebookgroups.ts';

// GET /api/book/picture?id=: the page as a picture, drawn here (an image or nothing, never kept in a cache)
export async function servePicture(req: IncomingMessage, res: ServerResponse, who: string | null = BOARD) {
  const p = row(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')), who);
  const file = p && (await pictureOf(p));
  if (!file) return notFound(res);
  serveFile(res, file);
}
// The page's picture's file in DIR: the one kept since its last change, or drawn now and kept. null: the page was
// deleted while it was drawn.
export async function pictureOf(p: Page): Promise<string | null> {
  if (p.picture && existsSync(`${DIR}/${p.picture}`)) return p.picture;
  const { ink, texts } = drawnOf(p.id);
  // (a notebook page's groups drawn over what the page has of its own)
  const { x, y, w, h } = p,
    groups = drawnGroups(p.id);
  const drawn = {
    x,
    y,
    w,
    h,
    ink: [...JSON.parse(ink), ...groups.ink],
    scraps: [...JSON.parse(p.scraps), ...groups.pictures],
    texts: [...JSON.parse(texts), ...groups.texts],
  };
  const png = await render(drawn, DIR);
  const name = `${p.id}-${randomBytes(4).toString('hex')}.png`;
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
  return name;
}
