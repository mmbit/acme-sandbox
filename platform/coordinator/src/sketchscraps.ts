// The Sketchbook's scraps, as sketches.ts keeps them: pictures placed on a sketch's page (or waiting from review mode to
// be), each a file of the sketch's in DIR, checked as a save places them and swept once nothing names them.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { db } from './db.ts';
import { DATA_DIR } from './config.ts';
import { keepFile } from './uploads.ts';

export const DIR = `${DATA_DIR}/sketches`;
// A scrap may hang off the page a little (SCRAP_XY, SCRAP_SIDE). MAX_SCRAPS on a page: HQ holds
// each decoded, up to 16 MB at 2,000 px (sketchscraps.js shrink), twice while it draws the page: 40 stays inside what
// Safari lets an iPad's tab hold. MAX_SCRAP_FILES a sketch, placed or not: disk, at most pictures.MAX_BYTES each and
// kept SWEEP_MS once nothing names them (undo can place one again), about 210 MB a sketch a day. WAITING_MAX from review
// mode, not placed yet: what a product page's own script can post while the board views it (feedback.ts); one cap for
// the Sketchbook, since 'new' makes a page each time and a cap per sketch would bound nothing.
export const MAX_SCRAPS = 40,
  WAITING_MAX = 12;
const MAX_SCRAP_FILES = 60;
const SWEEP_MS = 24 * 3600_000,
  SCRAP_XY = { min: -4000, max: 8000 },
  SCRAP_SIDE = { min: 4, max: 12000 },
  TILT = 180;

type Refused = [number, string];
export type Scrap = { file: string; x: number; y: number; w: number; h: number; tilt: number };
export const isScrap = (id: number, file: unknown) =>
  typeof file === 'string' && new RegExp(`^${id}-s-[0-9a-f]{8}\\.(png|jpg)$`).test(file);
export const scrapFiles = (id: number) => readdirSync(DIR).filter(f => isScrap(id, f));
export const full = (id: number) => scrapFiles(id).length >= MAX_SCRAP_FILES;
// the board's (who) sketch HQ opened last, not archived
export const lastOpened = (who: string) =>
  (
    db
      .prepare('select id from sketches where who = ? and archived = 0 order by opened desc, updated desc, id desc')
      .get(who) as { id: number } | undefined
  )?.id;
// (base: the routes' addresses, HQ's or a person's on the guest desk)
export const scrapUrl = (id: number, file: string, base: string) =>
  `${base}/scrap?id=${id}&file=${encodeURIComponent(file)}`;
export const waitingOf = (id: number) =>
  JSON.parse((db.prepare('select waiting from sketches where id = ?').get(id) as { waiting: string }).waiting) as {
    file: string;
  }[];
export function keepScrap(id: number, p: { type: string; clean: Buffer }) {
  const file = `${id}-s-${randomBytes(4).toString('hex')}.${p.type === 'image/png' ? 'png' : 'jpg'}`;
  keepFile(`${DIR}/${file}`, p.clean);
  return file;
}
// The scraps as HQ placed them, every one checked, or the refusal: kept whole or not at all, like the ink
export function scrapsOf(v: unknown, id: number): Scrap[] | Refused {
  if (!Array.isArray(v)) return [400, 'scraps is a list of pictures on the page'];
  if (v.length > MAX_SCRAPS) return [400, `a sketch holds at most ${MAX_SCRAPS} pictures`];
  const scraps: Scrap[] = [],
    seen = new Set<string>();
  const within = (n: unknown, r: { min: number; max: number }) =>
    typeof n === 'number' && Number.isFinite(n) && n >= r.min && n <= r.max;
  const round = (n: number) => Math.round(n * 100) / 100;
  for (const c of v) {
    if (!c || typeof c !== 'object' || !isScrap(id, c.file) || !existsSync(`${DIR}/${c.file}`))
      return [400, 'a picture on the page is one uploaded to this sketch'];
    if (seen.has(c.file)) return [400, 'a picture is on the page once'];
    seen.add(c.file);
    const sides = within(c.w, SCRAP_SIDE) && within(c.h, SCRAP_SIDE);
    if (!within(c.x, SCRAP_XY) || !within(c.y, SCRAP_XY) || !sides || !within(c.tilt, { min: -TILT, max: TILT }))
      return [400, 'a picture on the page is { file, x, y, w, h, tilt }, within the page and a half turn'];
    scraps.push({ file: c.file, x: round(c.x), y: round(c.y), w: round(c.w), h: round(c.h), tilt: round(c.tilt) });
  }
  return scraps;
}
// The sketch's scrap files nothing names (keep), once they're a day old
export function sweep(id: number, keep: string[]) {
  for (const file of scrapFiles(id))
    if (!keep.includes(file) && statSync(`${DIR}/${file}`).mtimeMs < Date.now() - SWEEP_MS)
      rmSync(`${DIR}/${file}`, { force: true });
}
