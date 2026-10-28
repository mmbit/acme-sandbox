// One page of the book: its heading written at 0,0 (its day, and whose it is: "For Lark", a call's, a free page's
// label), its pictures and dry ink any way from there, and a refusal said quietly on it. The paper and its dots under it are the
// book's (bookpages.js draws them where the page shows), so the page itself has no edge.
//
// The dry ink is drawn in square tiles (bookrow.js TILE_PX on screen) for the zoom it shows at, and only near what the
// paper shows, so a page that has grown long or wide, or one zoomed far in, never needs a canvas bigger than a browser
// draws. (tiles both ways at the zoom; were strips at 1:1)
import { draw } from '/__review/ink.js';
import { drawScrap } from './sketchscraps.js';
import { picture, esc } from '../../util.js';
import { around, boxOf, pageBox, scrapBoxOf, tileSide, tilesIn } from './bookrow.js';

// what's kept drawn beyond what the paper shows, as a share of it on every side: enough to pan into without a gap
const KEEP = 0.5;

// The page record (bookpages.js): { id (null while it waits blank), kind ('free' | 'sheet' | 'call' | 'guest'), owner,
// label, x, y, w, h (its box: bookrow.js), ink (null until read), scraps: [{ file, url, x, y, w, h, tilt }], texts, error }.
// head: { title, day, today, colour } its heading's words (bookhead.js headOf). held: the book out of sight as it's made.
export function pageView(page, head, held = false) {
  const el = document.createElement('div');
  el.className = 'bk-page';
  el.dataset.kind = page.kind;
  // (a page with a title is a region by it, "For Kit", to whoever reads the book aloud.)
  if (head.title) Object.assign(el, { role: 'region', ariaLabel: head.title });
  // (a heading has a place beside its title for its stamp once the page is sent, bookpagesend.js.)
  const stamp = page.kind === 'guest' ? '' : '<span class="bk-send" data-slot="stamp"></span>';
  // (the heading, as written in a notebook: whose page it is and its stamp, then its day, today's marked; a page with
  // no title, its day and its stamp.)
  const today = head.today ? '<small class="bk-today">Today</small>' : '';
  const colour = head.colour ? ` style="color:${esc(head.colour)}"` : '',
    date = `<span class="bk-date"><b class="bk-when"${colour}>${esc(head.day)}</b>${today}</span>`,
    title = head.title ? `<span class="bk-name">${esc(head.title)}</span>${stamp}${date}` : `${date}${stamp}`;
  // (a sheet's notes, and a call's)
  const notes = page.kind === 'sheet' || page.kind === 'call' ? '<div class="bk-notes" data-slot="notes"></div>' : '';
  el.innerHTML = `<div class="bk-title"${head.title ? '' : ' data-bare'}>${title}</div>${notes}<p class="bk-refusal" role="status" hidden></p>`;
  const refusal = el.querySelector('.bk-refusal'),
    tiles = inkTiles(el, page, held);
  refusal.textContent = page.error;
  refusal.hidden = !page.error;
  return {
    el,
    page,
    // its size in its own px, as it has grown: the element from 0,0 to the box's far corner, what's above or left of it
    // hanging out past its top-left
    place() {
      const box = pageBox(page);
      Object.assign(el.style, { width: `${box.x1}px`, height: `${box.y1}px` });
    },
    // What of the page the paper shows (a box in its px), drawn for zoom r; or null when it isn't shown
    show(box, r) {
      tiles.show(box, r);
      if (!box) return;
      Object.assign(refusal.style, { top: `${box.y0 + 12}px`, left: `${(box.x0 + box.x1) / 2}px` });
      // (how far the paper's top is down the page, for what stays in view there; the box's bottom: job #19861)
      el.style.setProperty('--bk-above', `${Math.round(Math.max(0, Math.min(box.y0, pageBox(page).y1 - 140)))}px`);
    },
    addInk: tiles.addInk,
    redraw: tiles.redraw,
    drop: tiles.drop,
    hold: tiles.hold,
    refuse(words) {
      refusal.textContent = words;
      refusal.hidden = !words;
    },
  };
}

// A page's dry ink and pictures in tiles: those near what the paper shows drawn for the zoom it shows at, the rest let
// go. Live tiles: 'column,row' → { canvas, c, row }, all drawn for zoom st.r. Held (the book shut out of sight), nothing
// is painted: what changed meanwhile is drawn once it shows (stale: the keys of tiles to paint again then). A page's
// tiles are big canvases: painted while nobody sees them they cost the frames of whatever moves on screen (the ink lifting
// into the shut book, a note just put in it).
function inkTiles(el, page, held) {
  const st = { el, page, tiles: new Map(), r: 1, box: null, held, stale: new Set() };
  const tiles = {
    show(box, r = st.r) {
      st.box = box;
      const inked = page.ink?.length || page.scraps.length;
      // (a new zoom: the tiles drawn for it replace the old ones in the same frame, so nothing flashes)
      const old = r === st.r ? null : st.tiles;
      if (old) [st.r, st.tiles] = [r, new Map()];
      const wanted = box && inked ? tilesIn(page, around(box, KEEP), tileSide(st.r)) : [],
        keys = new Set(wanted.map(String));
      for (const [key, tile] of st.tiles) if (!keys.has(key)) drop(tile.canvas, st.tiles, key);
      for (const [c, row] of wanted) if (!st.tiles.has(`${c},${row}`)) paintTile(st, c, row);
      if (old) for (const [key, tile] of old) drop(tile.canvas, old, key);
    },
    // A stroke just dried: drawn over the tiles it crosses (a highlighter's under the ink: those tiles drawn again),
    // and a tile it brings into being draws it with the rest
    addInk(stroke) {
      if (stroke.alpha < 1 || st.held) return tiles.redraw(boxOfStroke(stroke));
      const box = boxOfStroke(stroke),
        drawn = new Map(st.tiles);
      if (st.box) tiles.show(st.box);
      for (const [key, tile] of drawn) if (st.tiles.has(key) && crosses(st, box, tile)) draw(penOn(st, tile), [stroke]);
    },
    // Every tile a box crosses drawn again (a stroke undone, a picture loaded), or all of them
    redraw(box = null) {
      if (st.box) tiles.show(st.box);
      for (const tile of [...st.tiles.values()]) if (!box || crosses(st, box, tile)) paintTile(st, tile.c, tile.row);
    },
    drop() {
      for (const [key, tile] of st.tiles) drop(tile.canvas, st.tiles, key);
    },
    // Held while the book is out of sight; let go, what it would have painted meanwhile painted now
    hold(on) {
      if (st.held === on) return;
      st.held = on;
      if (on) return;
      const again = [...st.stale];
      st.stale.clear();
      if (st.box) tiles.show(st.box);
      for (const key of again) if (st.tiles.has(key)) paintTile(st, st.tiles.get(key).c, st.tiles.get(key).row);
    },
  };
  st.redraw = tiles.redraw;
  return tiles;
}
const tileBox = (st, { c, row }) => {
  const t = tileSide(st.r);
  return { x0: c * t, y0: row * t, x1: (c + 1) * t, y1: (row + 1) * t };
};
const crosses = (st, box, tile) => overlaps(box, tileBox(st, tile));
function paintTile(st, c, row) {
  const key = `${c},${row}`,
    t = tileSide(st.r),
    k = st.r * (devicePixelRatio || 1),
    { page, tiles } = st;
  if (st.held) return void (tiles.has(key) && st.stale.add(key));
  if (!tiles.has(key)) {
    const canvas = document.createElement('canvas');
    canvas.className = 'bk-ink';
    st.el.prepend(canvas);
    tiles.set(key, { canvas, c, row });
  }
  const tile = tiles.get(key),
    side = Math.round(t * k);
  if (tile.canvas.width !== side) Object.assign(tile.canvas, { width: side, height: side });
  Object.assign(tile.canvas.style, { left: `${c * t}px`, top: `${row * t}px`, width: `${t}px`, height: `${t}px` });
  const g = penOn(st, tile),
    box = tileBox(st, tile);
  g.clearRect(box.x0, box.y0, t, t);
  for (const s of page.scraps) if (overlaps(scrapBoxOf(s), box)) drawScrap(g, withPicture(st, s));
  // (a highlighter's strokes under the ink, as a highlighter goes on paper)
  const here = page.ink.filter(s => overlaps(boxOfStroke(s), box));
  draw(g, [...here.filter(s => s.alpha < 1), ...here.filter(s => !(s.alpha < 1))]);
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

// A tile's pen: its canvas in the page's px, its top-left at the tile's
function penOn(st, { canvas, c, row }) {
  const t = tileSide(st.r),
    k = canvas.width / t,
    g = canvas.getContext('2d');
  g.setTransform(k, 0, 0, k, -c * t * k, -row * t * k);
  return g;
}
const overlaps = (a, b) => a.x1 > b.x0 && a.x0 < b.x1 && a.y1 > b.y0 && a.y0 < b.y1;
// (a stroke's box, worked out once: every tile asks for it)
const boxes = new WeakMap();
function boxOfStroke(s) {
  if (!boxes.has(s)) boxes.set(s, boxOf(s));
  return boxes.get(s);
}
// A canvas let go at once: Safari keeps a removed canvas's pixels until it's collected, and an iPad's tab holds few
const drop = (canvas, tiles, key) => {
  canvas.width = canvas.height = 0;
  canvas.remove();
  tiles.delete(key);
};
