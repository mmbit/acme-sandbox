// One page of the book: its pictures and dry ink, its send stamp and a refusal said quietly on it. The paper and its dots under it are the
// book's (bookpages.js draws them where the page shows), so the page itself has no edge.
//
// The page is its units (bookunits.js): each draws its pictures and dry ink on a canvas of its own at its place, as
// big as the unit and what's drawn on it. (were tiles across an endless page; what's drawn)
import { draw } from '/__review/ink.js';
import { layered } from '/__review/inkshape.js';
import { drawScrap, drawnBox } from './bookscrapdraw.js';
import { picture } from '../../util.js';
import { boxOf, pageBox } from './bookrow.js';
import { meets, union } from './bookselectmath.js';
import { landing } from './bookgroupmath.js';
import { mountAnswers } from './bookanswers.js';
import { nameOf } from './bookhead.js';
import { layUnits, reachOn } from './bookunits.js';
import { drawCards } from './bookunitcards.js';

// The page record (bookpages.js): { id (null while it waits blank), kind ('free' | 'sheet' | 'call' | 'guest'), owner,
// label, x, y, w, h (its box: bookrow.js), ink (null until read), scraps: [{ file, url, x, y, w, h, tilt }], texts, error }.
// held: the book out of sight as it's made.
export function pageView(page, held = false) {
  const el = document.createElement('div');
  el.className = 'bk-page';
  el.dataset.kind = page.kind;
  // Every page is a named region for whoever reads the book aloud.
  Object.assign(el, { role: 'region', ariaLabel: nameOf(page) });
  // The title belongs in the bar. The canvas keeps only its send stamp. (its class)
  const stamp = page.kind === 'guest' ? '' : '<span class="bk-sent" data-slot="stamp"></span>';
  // (the agents' answers over the page, .bk-answers: bookanswers.js.)
  el.innerHTML = `<div class="bk-send-stamp">${stamp}</div><div class="bk-answers" data-slot="answers"></div><p class="bk-refusal" role="status" hidden></p>`;
  const refusal = el.querySelector('.bk-refusal'),
    tiles = unitInk(el, page, held);
  refusal.textContent = page.error;
  refusal.hidden = !page.error;
  const view = {
    el,
    page,
    // its units laid at the paper's width (CSS px: bookunits.js), the element as big as the page they make, its ink
    // drawn again where a unit moved
    place(width) {
      if (width) this.width = width;
      const moved = layUnits(this, this.width);
      if (page.laid) drawCards(this);
      Object.assign(el.style, { width: `${page.w}px`, height: `${page.h}px` });
      tiles.redraw();
      return moved;
    },
    // What of the page the paper shows (a box in its px), drawn for zoom r; or null when it isn't shown
    show(box, r) {
      tiles.show(box, r);
      if (!box) return;
      Object.assign(refusal.style, { top: `${box.y0 + 12}px`, left: `${(box.x0 + box.x1) / 2}px` });
      // How far the paper's top is down the page, for what stays in view there: never past 140 px above the page's
      // foot.
      el.style.setProperty('--bk-above', `${Math.round(Math.max(0, Math.min(box.y0, pageBox(page).y1 - 140)))}px`);
    },
    addInk: tiles.addInk,
    redraw: tiles.redraw,
    rubbed: tiles.rubbed,
    drop: tiles.drop,
    hold: tiles.hold,
    refuse(words) {
      refusal.textContent = words;
      refusal.hidden = !words;
    },
  };
  // (a try's versions given room under their unit: bookanswers.js.)
  mountAnswers(el.querySelector('.bk-answers'), page, () => view.relay?.());
  return view;
}

// A page's dry ink and pictures, one canvas per unit at its place (bookunits.js), each drawing only its own elements
// in its own px: a unit 'id' → { canvas, id }. Held (the book shut out of sight), nothing is painted: what changed
// meanwhile is painted once it shows. A unit's canvas is let go when the unit goes, and every canvas when another page
// shows: the book keeps a view of each of a notebook's pages, and an iPad's tab holds few canvases
function unitInk(el, page, held) {
  const st = { el, page, units: new Map(), held, shown: false, stale: false };
  const paintAll = () => {
    if (st.held || !st.shown) return void (st.stale = true);
    const places = new Map((page.places ?? []).map(p => [p.id, p]));
    for (const [id, u] of st.units) if (!places.has(id)) drop(u.canvas, st.units, id);
    for (const p of places.values()) paint(st, p);
  };
  // (the units' canvases painted again only in a box, where ink went and nothing moved)
  const paintIn = box => {
    if (st.held || !st.shown) return void (st.stale = true);
    for (const p of page.places ?? []) paint(st, p, box);
  };
  const tiles = {
    show(box) {
      const shown = Boolean(box);
      if (shown === st.shown) return;
      st.shown = shown;
      if (shown) paintAll();
      else tiles.drop();
    },
    // A stroke just dried, a stroke undone, a picture loaded: the units drawn again
    addInk: () => paintAll(),
    redraw: () => paintAll(),
    // The eraser's rub (bookerase.js): ink gone from a box of the page, nothing moved, so only that box is painted
    // again, as a page of overlapping ink has most of it under any rub
    rubbed: box => paintIn(box),
    drop() {
      for (const [id, u] of st.units) drop(u.canvas, st.units, id);
    },
    hold(on) {
      st.held = on;
      if (!on && st.stale) {
        st.stale = false;
        paintAll();
      }
    },
  };
  st.redraw = paintAll;
  return tiles;
}
// A unit's canvas painted: its pictures, then a highlighter's strokes under the ink, as on paper; what's landing is
// drawn once it's down (bookarrive.js). box: only what's in it (page px), on the canvas as it is while all that's
// drawn still fits it
function paint(st, p, box = null) {
  const { page, units } = st;
  if (!units.has(p.id)) {
    const canvas = document.createElement('canvas');
    canvas.className = 'bk-ink';
    // (under the canvases already there: the units painted in their order lie each over the ones after it, as the
    // page picture stacks them, bookrender.ts inkSvg)
    st.el.prepend(canvas);
    units.set(p.id, { canvas, id: p.id });
  }
  // (as big as the unit, and further wherever its ink, a scrap's tape or its shadow reaches past it: nothing drawn is
  // cut.)
  const scraps = page.scraps.filter(s => s.g === p.id && !landing(page, s)),
    u = units.get(p.id),
    { canvas } = u,
    r = scraps.map(drawnBox).reduce(union, reachOn(page, p)),
    k = devicePixelRatio || 1,
    part = box && u.at && u.k === k && holds(u.at, r);
  if (part && !meets(u.at, box)) return;
  const [x, y] = part ? [u.at.x0, u.at.y0] : [Math.floor(r.x0), Math.floor(r.y0)],
    [cw, ch] = part ? [u.at.x1 - x, u.at.y1 - y] : [Math.ceil(r.x1) - x, Math.ceil(r.y1) - y],
    w = Math.round(cw * k),
    h = Math.round(ch * k);
  Object.assign(u, { at: { x0: x, y0: y, x1: x + cw, y1: y + ch }, k });
  if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  Object.assign(canvas.style, { left: `${x}px`, top: `${y}px`, width: `${cw}px`, height: `${ch}px` });
  const g = canvas.getContext('2d');
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  // (a box: in whole device pixels, cleared and clipped so its edge leaves no seam, and in it what reaches in, its soft
  // edge a device pixel)
  let clip = null;
  if (part) {
    const x0 = Math.max(0, Math.floor((box.x0 - x) * k)),
      y0 = Math.max(0, Math.floor((box.y0 - y) * k)),
      x1 = Math.min(w, Math.ceil((box.x1 - x) * k)),
      y1 = Math.min(h, Math.ceil((box.y1 - y) * k));
    g.beginPath();
    g.rect(x0, y0, x1 - x0, y1 - y0);
    g.clip();
    g.clearRect(x0, y0, x1 - x0, y1 - y0);
    clip = { x0: x + (x0 - 1) / k, y0: y + (y0 - 1) / k, x1: x + (x1 + 1) / k, y1: y + (y1 + 1) / k };
  } else g.clearRect(0, 0, w, h);
  g.setTransform(k, 0, 0, k, -x * k, -y * k);
  const shows = b => !clip || meets(b, clip);
  for (const s of scraps) if (shows(drawnBox(s))) drawScrap(g, withPicture(st, s));
  const here = page.ink.filter(s => s.g === p.id && !landing(page, s) && shows(boxOf(s)));
  draw(g, layered(here));
  g.restore();
}
const holds = (outer, b) => b.x0 >= outer.x0 && b.y0 >= outer.y0 && b.x1 <= outer.x1 && b.y1 <= outer.y1;
// a scrap's picture, drawn again once it has loaded
function withPicture(st, s) {
  if (s.img) return s;
  s.img = picture(s.url);
  // (a picture that fails stays a blank card: picture() logs it)
  s.img.decode().then(
    () => st.redraw(),
    () => {},
  );
  return s;
}
// A canvas let go at once: Safari keeps a removed canvas's pixels until it's collected, and an iPad's tab holds few
const drop = (canvas, units, id) => {
  canvas.width = canvas.height = 0;
  canvas.remove();
  units.delete(id);
};
