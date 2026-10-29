// A notebook group's pictures (notebookgroups.ts): uploaded to an open page for a group there to place, kept in the
// book's files as `<page>-g-<random>`, served only to the person whose page it was uploaded to.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as pictures from './pictures.ts';
import { keepFile, refuse, reply } from './uploads.ts';
import { readBody } from '../../../shared/routes/routes.ts';
import { BOARD } from './ink/book.ts';
import { isRefused } from './pagechecks.ts';
import { DIR, notFound, serveFile, tooBig } from './pagescraps.ts';
import { pageRow } from './notebook.ts';
import { BOOK_FULL, noRoomFor } from './ink/sketchpeople.ts';
import { openPage } from './notebookgroups.ts';

const PICTURE = /^(\d+)-g-[0-9a-f]{8}\.(png|jpg)$/;

// POST /api/notebooks/pictures?page=: one picture as the body (a JPEG or PNG), for a group on that page to place:
// { file, url }
export async function uploadPicture(
  req: IncomingMessage,
  res: ServerResponse,
  who = BOARD,
  stillOpen = () => true,
  pictureBase = '/api/notebooks/pictures',
) {
  const page = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('page'));
  if (isRefused(openPage(page, who))) return refuse(req, res, 404, 'no such open page');
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'image/jpeg' && type !== 'image/png') return refuse(req, res, 415, 'a JPEG or PNG only');
  const raw = await readBody(req, pictures.MAX_BYTES);
  if (!raw) return refuse(req, res, 413, 'too large');
  const p = pictures.picture(raw);
  if (!p) return reply(res, 400, { error: 'not a picture we can read' }, true);
  const big = tooBig(p.clean);
  if (big) return reply(res, big[0], { error: big[1] }, true);
  if (!stillOpen() || isRefused(openPage(page, who)))
    return reply(res, 403, { error: 'this invitation or page has closed' });
  // (a guest's book's room, counted with nothing awaited before it's kept, so two bodies ending together can't both fit)
  if (who !== BOARD && noRoomFor(who, p)) return reply(res, 413, { error: BOOK_FULL });
  const file = keepPicture(page, p);
  return reply(res, 200, { file, url: `${pictureBase}?file=${encodeURIComponent(file)}` });
}
// GET /api/notebooks/pictures?file=: one of a person's group pictures
export function servePicture(req: IncomingMessage, res: ServerResponse, who: string | null = BOARD) {
  const file = new URL(req.url ?? '/', 'http://x').searchParams.get('file') ?? '';
  if (!ours(file, who) || !existsSync(`${DIR}/${file}`)) return notFound(res);
  serveFile(res, file);
}
export const keepPicture = (page: number, p: { type: string; clean: Buffer }) => {
  const file = `${page}-g-${randomBytes(4).toString('hex')}.${p.type === 'image/png' ? 'png' : 'jpg'}`;
  keepFile(`${DIR}/${file}`, p.clean);
  return file;
};
// A group picture's file is one of the person's: uploaded to a page of their book
export const ours = (file: unknown, who: string | null) => {
  const m = typeof file === 'string' ? PICTURE.exec(file) : null;
  return !!m && !!pageRow(Number(m[1]), who);
};
export const pictureUrl = (file: string) => `/api/notebooks/pictures?file=${encodeURIComponent(file)}`;
