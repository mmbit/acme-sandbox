// A page's scraps, as book.ts keeps them: pictures placed on a page, each a file of the page's in DIR, checked as a save
// places them and swept once nothing names them. DIR holds the book's other files too: a page's picture, a note's snip
// and a slip's picture.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { DATA_DIR } from './config.ts';
import { keepFile } from './uploads.ts';
import { pictureSize } from '../../../shared/pictures/size.ts';
import type { Refused } from './pagechecks.ts';

export const DIR = `${DATA_DIR}/book`;
// A scrap lies anywhere a page grows to, either side of its heading, and may hang off it a little (SCRAP_XY),
// and be up to three times the page's longer side (SCRAP_SIDE: HQ's
// own resize, sketchscraps.js). MAX_SCRAPS on a page: HQ holds
// each decoded, up to 16 MB at 2,000 px, twice while it draws the page: 40 stays inside what Safari lets an iPad's tab
// hold. MAX_SCRAP_FILES a page, placed or not: disk, at most pictures.MAX_BYTES each and kept SWEEP_MS once nothing
// names them (undo can place one again), about 210 MB a page a day. WAITING_MAX not placed yet (book.ts fromReview):
// one cap for the book, since 'new' makes a page each time and a cap per page would bound nothing.
export const MAX_SCRAPS = 40,
  WAITING_MAX = 12;
const MAX_SCRAP_FILES = 60;
export const SWEEP_MS = 24 * 3600_000;
const SCRAP_XY = { min: -24_000, max: 24_000 },
  SCRAP_SIDE = { min: 4, max: 12000 },
  TILT = 180;

export type Scrap = { file: string; x: number; y: number; w: number; h: number; tilt: number };
export const isScrap = (id: number, file: unknown) =>
  typeof file === 'string' && new RegExp(`^${id}-s-[0-9a-f]{8}\\.(png|jpg)$`).test(file);
export const scrapFiles = (id: number) => readdirSync(DIR).filter(f => isScrap(id, f));
export const full = (id: number) => scrapFiles(id).length >= MAX_SCRAP_FILES;
// (base: the routes' addresses, HQ's or a person's on the guest desk)
export const scrapUrl = (id: number, file: string, base: string) =>
  `${base}/scrap?id=${id}&file=${encodeURIComponent(file)}`;
// A picture HQ makes is PICTURE_SIDE px on its long side at most (sketchscraps.js shrink, review mode's picture): one
// that says it's bigger in its header is refused before it's kept, as every drawing of its page would decode it whole
const PICTURE_SIDE = 2000;
export function tooBig(clean: Buffer): Refused | null {
  const size = pictureSize(clean);
  if (!size) return [400, 'not a picture we can read'];
  return Math.max(size.width, size.height) > PICTURE_SIDE
    ? [413, `a picture is ${PICTURE_SIDE} px on its long side at most`]
    : null;
}
export function keepScrap(id: number, p: { type: string; clean: Buffer }) {
  const file = `${id}-s-${randomBytes(4).toString('hex')}.${p.type === 'image/png' ? 'png' : 'jpg'}`;
  keepFile(`${DIR}/${file}`, p.clean);
  return file;
}
// The scraps as HQ placed them, every one checked, or the refusal: kept whole or not at all, like the ink. ours: whether
// a file is one the page may place (a notebook group's pictures are named their own way: notebookgroups.ts)
export function scrapsOf(
  v: unknown,
  id: number,
  ours = (file: unknown) => isScrap(id, file) && existsSync(`${DIR}/${file}`),
): Scrap[] | Refused {
  if (!Array.isArray(v)) return [400, 'scraps is a list of pictures on the page'];
  if (v.length > MAX_SCRAPS) return [400, `a page holds at most ${MAX_SCRAPS} pictures`];
  const scraps: Scrap[] = [],
    seen = new Set<string>();
  const within = (n: unknown, r: { min: number; max: number }) =>
    typeof n === 'number' && Number.isFinite(n) && n >= r.min && n <= r.max;
  const round = (n: number) => Math.round(n * 100) / 100;
  for (const c of v) {
    if (!c || typeof c !== 'object' || !ours(c.file))
      return [400, 'a picture on the page is one uploaded to this page'];
    if (seen.has(c.file)) return [400, 'a picture is on the page once'];
    seen.add(c.file);
    const sides = within(c.w, SCRAP_SIDE) && within(c.h, SCRAP_SIDE);
    if (!within(c.x, SCRAP_XY) || !within(c.y, SCRAP_XY) || !sides || !within(c.tilt, { min: -TILT, max: TILT }))
      return [400, 'a picture on the page is { file, x, y, w, h, tilt }, within the page and a half turn'];
    scraps.push({ file: c.file, x: round(c.x), y: round(c.y), w: round(c.w), h: round(c.h), tilt: round(c.tilt) });
  }
  return scraps;
}
// The page's scrap files nothing names (keep), once they're a day old
export function sweep(id: number, keep: string[]) {
  for (const file of scrapFiles(id))
    if (!keep.includes(file) && statSync(`${DIR}/${file}`).mtimeMs < Date.now() - SWEEP_MS)
      rmSync(`${DIR}/${file}`, { force: true });
}

// One of DIR's pictures as the answer: an image or nothing, never kept in a cache (a snip's and a slip's too).
// (moved here from book.ts)
export function serveFile(res: ServerResponse, file: string) {
  res.writeHead(200, {
    'content-type': typeOf(file),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  });
  res.end(readFileSync(`${DIR}/${file}`));
}
export const notFound = (res: ServerResponse) => {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
};
export const typeOf = (file: string) => (file.endsWith('.png') ? 'image/png' : 'image/jpeg');
