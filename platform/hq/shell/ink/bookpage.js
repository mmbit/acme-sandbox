// One page of the book: its pictures and dry ink, its send stamp and a refusal said quietly on it. The paper and its dots under it are the
// book's (bookpages.js draws them where the page shows), so the page itself has no edge.
//
// The page is its units (bookunits.js): each draws its pictures and dry ink on a canvas of its own at its place, as
// big as the unit and what's drawn on it. (were tiles across an endless page; what's drawn)
import { draw } from '/__review/ink.js';
import { drawScrap } from './bookscrapdraw.js';
import { picture } from '../../util.js';
import { pageBox } from './bookrow.js';
import { landing } from './bookgroupmath.js';
import { mountAnswers } from './bookanswers.js';
import { nameOf } from './bookhead.js';
import { layUnits, reachOn } from './bookunits.js';

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
  mountAnswers(el.querySelector('.bk-answers'), page);
  return {
    el,
    page,
    // its units laid at the paper's width (CSS px: bookunits.js), the element as big as the page they make, its ink
    // drawn again where a unit moved
    place(width) {
      if (width) this.width = width;
      const moved = layUnits(this, this.width);
      Object.assign(el.style, { width: `${page.w}px`, height: `${page.h}px` });
      tiles.redraw();
      return moved;
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

// A page's dry ink and pictures, one canvas per unit at its place (bookunits.js), each drawing only its own elements
// in its own px: a unit 'id' → { canvas, id }. Held (the book shut out of sight), nothing is painted: what changed
// meanwhile is painted once it shows. A unit's canvas is let go when the unit goes.
function unitInk(el, page, held) {
  const st = { el, page, units: new Map(), held, stale: false };
  const paintAll = () => {
    if (st.held) return void (st.stale = true);
    const places = new Map((page.places ?? []).map(p => [p.id, p]));
    for (const [id, u] of st.units) if (!places.has(id)) drop(u.canvas, st.units, id);
    for (const p of places.values()) paint(st, p);
  };
  const tiles = {
    show: () => st.units.size || paintAll(),
    // A stroke just dried, a stroke undone, a picture loaded: the units drawn again
    addInk: () => paintAll(),
    redraw: () => paintAll(),
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
// drawn once it's down (bookarrive.js)
function paint(st, p) {
  const { page, units } = st;
  if (!units.has(p.id)) {
    const canvas = document.createElement('canvas');
    canvas.className = 'bk-ink';
    st.el.prepend(canvas);
    units.set(p.id, { canvas, id: p.id });
  }
  // (as big as the unit, and further wherever its ink reaches past it: nothing drawn is cut.)
  const { canvas } = units.get(p.id),
    r = reachOn(page, p),
    [x, y] = [Math.floor(r.x0), Math.floor(r.y0)],
    [cw, ch] = [Math.ceil(r.x1) - x, Math.ceil(r.y1) - y],
    k = devicePixelRatio || 1,
    w = Math.round(cw * k),
    h = Math.round(ch * k);
  if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  Object.assign(canvas.style, { left: `${x}px`, top: `${y}px`, width: `${cw}px`, height: `${ch}px` });
  const g = canvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  g.setTransform(k, 0, 0, k, -x * k, -y * k);
  for (const s of page.scraps) if (s.g === p.id && !landing(page, s)) drawScrap(g, withPicture(st, s));
  const here = page.ink.filter(s => s.g === p.id && !landing(page, s));
  draw(g, [...here.filter(s => s.alpha < 1), ...here.filter(s => !(s.alpha < 1))]);
}
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
