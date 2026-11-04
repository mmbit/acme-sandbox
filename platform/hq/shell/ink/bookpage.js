// One page of the book: its pictures and dry ink, its send stamp and a refusal said quietly on it. The paper and its dots under it are the
// book's (bookpages.js draws them where the page shows), so the page itself has no edge.
//
// The page is its units (bookunits.js): each draws its pictures and dry ink on a canvas of its own at its place, as
// big as the unit and what's drawn on it; our scraps' photos are taped onto their post-its under all of the page's ink
// (photos). (were tiles across an endless page; what's drawn)
import { draw } from '/__review/ink.js';
import { layered } from '/__review/inkshape.js';
import { drawScrap, drawnBox, photoOf, tapeOf } from './bookscrapdraw.js';
import { picture } from '../../util.js';
import { boxOf, pageBox } from './bookrow.js';
import { meets, union } from './bookselectmath.js';
import { landing } from './bookgroupmath.js';
import { mountAnswers } from './bookanswers.js';
import { nameOf } from './bookhead.js';
import { fixed, layUnits, reachOn } from './bookunits.js';
import { drawCards } from './bookunitcards.js';

// zoomed in, a unit's canvas holds what's this share of the view's size beyond each of its sides too, so a pan paints
// it again only now and then
const NEAR = 0.25;
// the most device px a unit's canvas has (an iPad's tab holds few, and none past 16.7 million): past it, it's drawn a
// little softer
const MOST_PX = 8_000_000;

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
    // (its ink's: addInk, redraw, rubbed, under, over, drop, hold; its own show over theirs)
    ...tiles,
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
// meanwhile is painted once it shows. A canvas is drawn for the zoom the view rests at (r, bookview.js): zoomed in past
// 1, only round what the paper shows, painted again as the view moves on past it. A unit's canvas is let go when the unit goes, and every canvas when another page
// shows: the book keeps a view of each of a notebook's pages, and an iPad's tab holds few canvases
function unitInk(el, page, held) {
  const st = { el, page, units: new Map(), held, shown: false, stale: false, box: null, r: 1 };
  const paintAll = () => {
    st.owed = false;
    if (st.held || !st.shown) return void (st.stale = true);
    const places = new Map((page.places ?? []).map(p => [p.id, p]));
    for (const [id, u] of st.units) if (!places.has(id)) drop(u.canvas, st.units, id);
    for (const p of places.values()) paint(st, p);
    photos(st);
  };
  // (the units' canvases painted again only in a box, where ink went and nothing moved)
  const paintIn = box => {
    if (st.held || !st.shown) return void (st.stale = true);
    for (const p of page.places ?? []) paint(st, p, box);
  };
  const tiles = {
    show(box, r = 1) {
      const shown = Boolean(box),
        zoomed = r !== st.r;
      Object.assign(st, { box, r });
      if (shown !== st.shown) {
        st.shown = shown;
        return shown ? paintAll() : tiles.drop();
      }
      if (!shown || st.held) return;
      if (zoomed) return paintAll();
      // (zoomed in: a canvas whose unit shows past what it holds)
      for (const p of page.places ?? []) if (r > 1 && !holdsShown(st, st.units.get(p.id))) paint(st, p);
    },
    // A stroke just dried, a stroke undone, a picture loaded: the units drawn again
    addInk: () => paintAll(),
    redraw: () => paintAll(),
    // The eraser's rub (bookerase.js): ink gone from a box of the page, nothing moved, so only that box is painted
    // again, as a page of overlapping ink has most of it under any rub
    rubbed: box => paintIn(box),
    under: on => inkUnder(st, on),
    over: (g, box) => paintOver(st, g, box),
    drop: () => st.units.forEach((u, id) => drop(u.canvas, st.units, id)),
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
  const scraps = page.scraps.filter(s => s.g === p.id && !landing(page, s) && !fixed(page, s.g)),
    u = units.get(p.id),
    { canvas } = u,
    reach = scraps.map(drawnBox).reduce(union, reachOn(page, p)),
    { at, k } = canvasAt(st, reach),
    part = box && u.at && u.k === k && same(u.at, at);
  if (part && !meets(u.at, box)) return;
  const { x0: x, y0: y } = at,
    [cw, ch] = [at.x1 - x, at.y1 - y],
    w = Math.round(cw * k),
    h = Math.round(ch * k);
  Object.assign(u, { at, k, reach });
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
  const here = page.ink.filter(s => s.g === p.id && inked(st, s) && shows(boxOf(s)));
  draw(g, layered(here));
  g.restore();
}
// Whether paint() draws a stroke: not while it's landing, nor while a see-through line is drawn over it (inkUnder)
const inked = (st, s) => !landing(st.page, s) && (!st.under || s.alpha < 1);
// A see-through line being drawn (bookwet.js): the units painted without the ink that will lie over it, which
// paintOver draws to lie over the line; and painted whole again once it's gone, before the screen shows them (a lift's
// own paint, addInk, comes first).
function inkUnder(st, on) {
  if (st.under === on) return;
  st.under = on;
  if (on) return st.redraw();
  st.owed = true;
  queueMicrotask(() => st.owed && st.redraw());
}
// The ink paint() leaves out under a see-through line being drawn, to lie over it: unit by unit from the bottom up (each
// lies over the ones after it), what its pictures cover cut away and its ink drawn but for its see-through strokes.
function paintOver(st, g, box) {
  const { page } = st;
  for (const p of (page.places ?? []).toReversed()) {
    const scraps = page.scraps.filter(
      s => s.g === p.id && !landing(page, s) && !fixed(page, s.g) && meets(drawnBox(s), box),
    );
    g.save();
    g.globalCompositeOperation = 'destination-out';
    for (const s of scraps) drawScrap(g, s);
    g.restore();
    draw(
      g,
      page.ink.filter(s => s.g === p.id && !(s.alpha < 1) && !landing(page, s) && meets(boxOf(s), box)),
    );
  }
}
// What of a unit's reach (page px) its canvas holds, in whole px, and how many device px a page px is on it: the zoom
// the view rests at (st.r); zoomed in past 1, only what's within NEAR of the paper's view; never more than MOST_PX
function canvasAt(st, reach) {
  const near = st.r > 1 && st.box && grown(st.box, NEAR),
    r = near ? within(reach, near) : reach,
    at = { x0: Math.floor(r.x0), y0: Math.floor(r.y0) };
  Object.assign(at, { x1: Math.max(at.x0, Math.ceil(r.x1)), y1: Math.max(at.y0, Math.ceil(r.y1)) });
  const area = Math.max(1, (at.x1 - at.x0) * (at.y1 - at.y0));
  return { at, k: Math.min((devicePixelRatio || 1) * st.r, Math.sqrt(MOST_PX / area)) };
}
// Whether a unit's canvas holds all of it the paper shows (none painted yet: it does not)
function holdsShown(st, u) {
  if (!u?.reach) return false;
  const shows = within(u.reach, st.box);
  return shows.x1 <= shows.x0 || shows.y1 <= shows.y0 || holds(u.at, shows);
}
const holds = (outer, b) => b.x0 >= outer.x0 && b.y0 >= outer.y0 && b.x1 <= outer.x1 && b.y1 <= outer.y1;
const same = (a, b) => a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
// A box cut to another, and one grown by a share of its size each way
const within = (a, b) => ({
  x0: Math.max(a.x0, b.x0),
  y0: Math.max(a.y0, b.y0),
  x1: Math.min(a.x1, b.x1),
  y1: Math.min(a.y1, b.y1),
});
const grown = (b, by) => {
  const dx = (b.x1 - b.x0) * by,
    dy = (b.y1 - b.y0) * by;
  return { x0: b.x0 - dx, y0: b.y0 - dy, x1: b.x1 + dx, y1: b.y1 + dy };
};
// Our scraps' photos (bookunits.js fixed), each taped straight onto its post-it as the page's own element, under all
// the page's ink (bookgroups.css .bk-photos): never on a unit's canvas, so no unit's ink lies under another's photo.
// What's landing shows once it's down (bookarrive.js). An element kept per picture, so a loaded one never loads again.
// (README, Our scraps.)
function photos(st) {
  const { el, page } = st;
  let layer = el.querySelector(':scope > .bk-photos');
  if (!layer) {
    layer = Object.assign(document.createElement('div'), { className: 'bk-photos' });
    el.prepend(layer);
  }
  const had = new Map([...layer.children].map(c => [c.dataset.url, c]));
  for (const s of page.scraps) {
    if (!fixed(page, s.g) || landing(page, s)) continue;
    let photo = had.get(s.url);
    had.delete(s.url);
    if (!photo) {
      photo = Object.assign(document.createElement('div'), { className: 'bk-photo' });
      photo.dataset.url = s.url;
      photo.append(Object.assign(new Image(), { src: s.url, alt: '', draggable: false }));
    }
    const at = photoOf(s),
      tape = tapeOf(s);
    Object.assign(photo.style, {
      ...{ left: `${at.x}px`, top: `${at.y}px`, width: `${at.w}px`, height: `${at.h}px`, rotate: `${s.tilt}deg` },
    });
    photo.style.setProperty('--bk-tape-w', `${tape.w}px`);
    photo.style.setProperty('--bk-tape-h', `${tape.h}px`);
    layer.append(photo);
  }
  for (const gone of had.values()) gone.remove();
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
