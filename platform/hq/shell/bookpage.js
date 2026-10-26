// One page of the book on its table: the paper, its head ("For Lark", "Call"), its pictures and dry ink, its tear
// lines where it grew, and a refusal said quietly on it.
//
// The dry ink is drawn in strips (bookrow.js TILE_PX) and only where the paper shows, so a page that has grown long
// never needs a canvas taller than a browser draws.
import { draw } from '/__review/ink.js';
import { drawScrap } from './sketchscraps.js';
import { picture, esc } from '../util.js';
import { TILE_PX, boxOf, scrapBoxOf, tilesIn } from './bookrow.js';

// The page record (bookpages.js): { id (null while it waits blank), kind ('free' | 'sheet' | 'call' | 'guest'), owner,
// label, w, h, ink (null until read), scraps: [{ file, url, x, y, w, h, tilt }], tears: [y], error }.
// title: its head's words, or ''.
export function pageView(page, title) {
  const el = document.createElement('div');
  el.className = 'bk-page';
  el.dataset.kind = page.kind;
  // (a page with a head is a region by its title, "For Kit", to whoever reads the book aloud.)
  if (title) Object.assign(el, { role: 'region', ariaLabel: title });
  // (a sheet's and a free page's head has a place for its plane beside the title: booksheet.js, booksendpage.js.
  const plane = page.kind === 'sheet' || page.kind === 'free' ? '<span class="bk-send" data-slot="plane"></span>' : '';
  el.innerHTML = `${title || plane ? `<div class="bk-title"${title ? '' : ' data-bare'}>${esc(title)}${plane}</div>` : ''}${
    page.kind === 'sheet' ? '<div class="bk-notes" data-slot="notes"></div>' : ''
  }<p class="bk-refusal" role="status" hidden></p>`;
  const refusal = el.querySelector('.bk-refusal'),
    strips = inkStrips(el, page);
  refusal.textContent = page.error;
  refusal.hidden = !page.error;
  return {
    el,
    page,
    // its place on the table and its size, in the table's px, with its tear lines
    place(x, y) {
      Object.assign(el.style, { transform: `translate(${x}px, ${y}px)`, width: `${page.w}px`, height: `${page.h}px` });
      el.querySelectorAll('.bk-tear').forEach(t => t.remove());
      for (const y of page.tears) {
        const tear = document.createElement('i');
        tear.className = 'bk-tear';
        tear.style.top = `${y}px`;
        el.append(tear);
      }
    },
    // The band of the page the paper shows (its px, top to bottom), or nulls when it's off the paper
    show(top, bottom) {
      strips.show(top === null ? null : { top, bottom });
      if (top !== null) refusal.style.top = `${Math.max(0, top) + 12}px`;
    },
    addInk: strips.addInk,
    redraw: strips.redraw,
    drop: strips.drop,
    refuse(words) {
      refusal.textContent = words;
      refusal.hidden = !words;
    },
  };
}

// A page's dry ink and pictures in strips: those in the band the paper shows drawn, a screen's worth either side
// kept, the rest let go. Live strips: their number → { canvas, h } (h: the strip's height as drawn, which a grown
// page's last one outgrows).
function inkStrips(el, page) {
  const st = { el, page, tiles: new Map(), band: null };
  const strips = {
    show(band) {
      st.band = band;
      const reach = band ? band.bottom - band.top : 0,
        inked = page.ink?.length || page.scraps.length;
      const wanted = band && inked ? tilesIn(page.h, band.top - reach, band.bottom + reach) : [];
      for (const [t, tile] of st.tiles)
        if (!wanted.includes(t)) {
          drop(tile.canvas);
          st.tiles.delete(t);
        }
      for (const t of wanted) if (st.tiles.get(t)?.h !== tileHeight(st, t)) paintStrip(st, t);
    },
    // A stroke just dried: drawn over the strips it crosses (a strip it brings into being draws it with the rest)
    addInk(stroke) {
      const box = boxOfStroke(stroke),
        drawn = new Map(st.tiles);
      if (st.band) strips.show(st.band);
      for (const [t, tile] of drawn) if (st.tiles.has(t) && crosses(st, box, t)) draw(penOn(tile.canvas, t), [stroke]);
    },
    // Every strip a box crosses drawn again (a stroke undone, a picture loaded), or all of them
    redraw(box = null) {
      for (const t of [...st.tiles.keys()]) if (!box || crosses(st, box, t)) paintStrip(st, t);
    },
    drop() {
      for (const tile of st.tiles.values()) drop(tile.canvas);
      st.tiles.clear();
    },
  };
  st.redraw = strips.redraw;
  return strips;
}
const tileHeight = (st, t) => Math.min(TILE_PX, st.page.h - t * TILE_PX);
const crosses = (st, box, t) => overlaps(box, { y0: t * TILE_PX, y1: t * TILE_PX + tileHeight(st, t) });
function paintStrip(st, t) {
  const h = tileHeight(st, t),
    k = devicePixelRatio || 1,
    { page, tiles } = st;
  if (!tiles.has(t)) {
    const canvas = document.createElement('canvas');
    canvas.className = 'bk-ink';
    st.el.prepend(canvas);
    tiles.set(t, { canvas });
  }
  const tile = tiles.get(t);
  tile.h = h;
  Object.assign(tile.canvas, { width: Math.round(page.w * k), height: Math.round(h * k) });
  Object.assign(tile.canvas.style, { top: `${t * TILE_PX}px`, width: `${page.w}px`, height: `${h}px` });
  const g = penOn(tile.canvas, t),
    strip = { y0: t * TILE_PX, y1: t * TILE_PX + h };
  for (const s of page.scraps) if (overlaps(scrapBoxOf(s), strip)) drawScrap(g, withPicture(st, s));
  draw(
    g,
    page.ink.filter(s => overlaps(boxOfStroke(s), strip)),
  );
}
// a scrap's picture, drawn again where it lies once it has loaded
function withPicture(st, s) {
  if (s.img) return s;
  s.img = picture(s.url);
  // (a picture that fails stays a blank card: picture() logs it)
  s.img.decode().then(
    () => st.redraw(scrapBoxOf(s)),
    () => {},
  );
  return s;
}

// A strip's pen: its canvas in the page's px, its top at the strip's
function penOn(canvas, t) {
  const k = devicePixelRatio || 1,
    g = canvas.getContext('2d');
  g.setTransform(k, 0, 0, k, 0, -t * TILE_PX * k);
  return g;
}
const overlaps = (box, strip) => box.y1 > strip.y0 && box.y0 < strip.y1;
// (a stroke's box, worked out once: a long page asks for it at every strip)
const boxes = new WeakMap();
function boxOfStroke(s) {
  if (!boxes.has(s)) boxes.set(s, boxOf(s));
  return boxes.get(s);
}
// A canvas let go at once: Safari keeps a removed canvas's pixels until it's collected, and an iPad's tab holds few
const drop = canvas => {
  canvas.width = canvas.height = 0;
  canvas.remove();
};
