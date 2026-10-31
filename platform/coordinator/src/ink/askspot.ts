// A design ask's spot (hq ask --at <address> --spot <selector>): the job's shot of the page with the thing in the middle
// and the thing's anchor (review mode's: shared/review/anchor.js), checked, then the thing ringed in pencil on the shot
// and the shot cut round it, for the ask's scrap (askpages.ts placeAsk). The ring is kept as the anchor's ink, as a
// mark's is.
import { randomInt } from 'node:crypto';
import sharp from 'sharp';
import { outline, PENS } from '../../../../shared/review/ink.js';
import { ringAround } from '../../../../shared/review/ring.js';
import { pictureSize } from '../../../../shared/pictures/size.ts';
import { anchorOf, dataUrlPicture, isRefused, type Anchor, type Stroke } from '../pagechecks.ts';
import { tooBig } from '../pagescraps.ts';

// The ring's pencil: the notebook's first pen
const PENCIL = PENS[0].color;
// Round the ring on the cut, in CSS px, and the least of the page the cut shows, so the thing is seen where it is
const MARGIN = 24,
  CUT_MIN = { w: 560, h: 315 };

type Box = { x: number; y: number; w: number; h: number };
type Spot = { anchor: Anchor & { el: { box: Box } }; shot: { type: string; clean: Buffer } };

// hq ask's spot ({ anchor, snip }) checked and ringed: { anchor, shot } for the scrap, or what's wrong (worded for the
// agent)
export async function spotOf(v: any) {
  const spot = checked(v);
  return typeof spot === 'string' ? spot : ringed(spot);
}
function checked(v: any): Spot | string {
  const anchor = anchorOf(v?.anchor);
  if (isRefused(anchor)) return `the spot's anchor: ${anchor[1]}`;
  if (!anchor.el) return "the spot's anchor names the thing: its element";
  if (!/^https:\/\//.test(anchor.url)) return "the spot's page is an https address the board opens";
  const shot = dataUrlPicture(v.snip);
  if (isRefused(shot)) return `the spot's shot: ${shot[1]}`;
  const big = tooBig(shot.clean);
  if (big) return `the spot's shot: ${big[1]}`;
  if (!overlaps(anchor.el.box, anchor.view)) return 'the spot is off the screen it was shot on';
  return { anchor: anchor as Spot['anchor'], shot };
}

// The shot with the thing ringed, cut round the ring, and the anchor carrying the ring as its ink
async function ringed(spot: Spot) {
  const { anchor, shot } = spot,
    view = anchor.view,
    size = pictureSize(shot.clean)!,
    k = size.width / view.w;
  const ring = ringAround(anchor.el.box, PENCIL, randomInt(2 ** 31)) as Stroke;
  const ink = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="${view.x} ${
    view.y
  } ${view.w} ${size.height / k}"><path d="${outline(ring)}" fill="${ring.color}"/></svg>`;
  // (the shot's pixels are first read here: a picture whose header reads and whose body doesn't fails here)
  const drawn = await sharp(shot.clean)
    .composite([{ input: Buffer.from(ink), left: 0, top: 0 }])
    .toBuffer()
    .catch((error: Error) => `the spot's shot isn't a picture HQ can read (${error.message})`);
  if (typeof drawn === 'string') return drawn;
  const cut = cutRound(ring, view),
    left = Math.round((cut.x - view.x) * k),
    top = Math.round((cut.y - view.y) * k);
  const clean = await sharp(drawn)
    .extract({
      left,
      top,
      width: Math.min(size.width - left, Math.round(cut.w * k)),
      height: Math.min(size.height - top, Math.round(cut.h * k)),
    })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { anchor: { ...anchor, ink: [ring] }, shot: { type: 'image/jpeg', clean } };
}

// The part of the screen round the ring (document px): its box and MARGIN, at least CUT_MIN, kept on the screen
function cutRound(ring: Stroke, view: Box) {
  const xs = ring.points.map(p => p[0]),
    ys = ring.points.map(p => p[1]);
  const x0 = Math.min(...xs) - ring.size - MARGIN,
    x1 = Math.max(...xs) + ring.size + MARGIN,
    y0 = Math.min(...ys) - ring.size - MARGIN,
    y1 = Math.max(...ys) + ring.size + MARGIN;
  const w = Math.min(view.w, Math.max(CUT_MIN.w, x1 - x0)),
    h = Math.min(view.h, Math.max(CUT_MIN.h, y1 - y0));
  const along = (from: number, to: number, side: number, start: number, room: number) =>
    Math.min(start + room - side, Math.max(start, (from + to) / 2 - side / 2));
  return { x: along(x0, x1, w, view.x, view.w), y: along(y0, y1, h, view.y, view.h), w, h };
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
