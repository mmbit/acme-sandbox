// A scrap opened off the grid to draw on: picked up from its place, it flies forward onto a sheet that nearly fills
// the paper, a small margin round it and its soft shadow over the page, an endless canvas the pen draws on, a finger
// pans and a pinch zooms (the Ink README, A page of scraps). Klaar puts it back down in its place on the grid.
//
// An opened scrap is a page of its own: its record holds the one unit, its things in its own px from 0,0, and its view
// takes the grid's place in book.views while it's open, so the pen, Select, the eraser, saving (group by group) and
// Undo's steps (step.page) work on it as on any page. The grid's view waits under the sheet as it was left. Each
// scrap's record and view are kept for the visit, so its Undo and Redo go on where they were when it's opened again.
import { contentOf, setView, viewOf } from './bookview.js';
import { readAgain, saved, takenFrom } from './booksave.js';
import { LISTS, cardOf, laidOf, localOf, unitAt } from './bookunits.js';
import { UNIT_W } from './scrapunit.js';
import { createGroup, deleteGroup } from './notebookdata.js';
import { button, island } from './bookui.js';
import { onEveryTap } from './bookcontrols.js';
import { icon } from '../icons.js';
import { word } from './bookscope.js';
import { stylesheet } from '../../util.js';

// the sheet's margin inside the paper (CSS px), the room above what's on it as it opens, and the zooms it opens at
const MARGIN = 14,
  ABOVE = 64,
  OPENS = { least: 1, most: 2.5 };
// the pick-up's flight: quick, settling softly (the board: not overdone)
const FLY_MS = 360,
  EASE = 'cubic-bezier(.2, .8, .25, 1)';

// book: bookpages.js's. hooks: { viewFor(page): a page's view, made and laid as the book's own, lay() }
export function mountScrapOpen(book, hooks) {
  stylesheet('shell/ink/bookscrapopen.css');
  const st = { book, hooks, open: null, busy: false };
  book.root = book.paper.closest('#book') ?? document.getElementById('book');
  const div = className => Object.assign(document.createElement('div'), { className });
  Object.assign(st, {
    under: div('bk-backdrop'),
    scrim: div('bk-scrim'),
    lift: div('bk-lift'),
    shade: div('bk-sheet-shadow'),
    flyer: div('bk-flyer'),
    sheet: div('bk-sheet'),
    keys: div('bk-sheet-keys'),
  });
  st.lift.append(st.shade, st.flyer);
  st.flyer.append(st.sheet);
  const done = onEveryTap(button({ text: word('done'), label: word('done') }), () => close(st));
  done.classList.add('bk-sheet-done');
  st.keys.append(done);
  history(st);
  // (the paper resized, the iPad turned: the sheet keeps its margin)
  new ResizeObserver(() => st.open && requestAnimationFrame(() => place(st))).observe(book.desk);
  return {
    open: gid => open(st, gid),
    close: () => close(st),
    view: () => st.open?.view ?? null,
    gid: () => st.open?.gid ?? null,
    grid: () => st.open?.grid ?? null,
    key: node => st.keys.insertBefore(node, done),
    tapped: (view, x, y) => tapped(st, view, x, y),
  };
}

// Undo and Redo on the tools' island while a scrap is open: the bar with its own is put away then
function history(st) {
  const group = Object.assign(document.createElement('div'), { className: 'bk-group bk-scrap-history' }),
    undo = onEveryTap(button({ icon: icon('undo'), label: word('undo') }), () => st.book.undo()),
    redo = onEveryTap(button({ icon: icon('redo'), label: word('redo') }), () => st.book.redo());
  group.append(undo, redo);
  island('tools').append(group);
}

// ---- opening

// A scrap on the grid shown opened: picked up from its card onto the sheet
async function open(st, gid) {
  const { book } = st,
    grid = viewOf(book);
  if (st.open || st.busy || !grid?.page.groups?.has(gid) || grid.page.focus) return;
  st.busy = true;
  try {
    const card = cardRect(st, grid, gid),
      view = scrapView(st, grid, gid);
    st.open = { gid, grid, view, i: book.cur, cam: { pan: { ...book.pan }, scale: book.scale } };
    park(st, grid);
    book.views[book.cur] = view;
    view.el.hidden = false;
    // (its words drawn on it and measured, then it's laid: bookgroups.js finds the view by the book's views)
    book.groups?.drawn(view.page);
    view.place(contentOf(book).w);
    setView(book, startCam(st, view));
    book.root?.toggleAttribute('data-scrap-open', true);
    book.paper.querySelector('.bk-pages')?.toggleAttribute('data-open', true);
    lifted(grid, gid, true);
    book.controls?.update();
    document.dispatchEvent(new CustomEvent('book:scrap-open', { detail: { gid, page: view.page } }));
    await fly(st, card, contentRect(st, view), true);
  } finally {
    st.busy = false;
  }
}
// An opened scrap's view: kept for the visit, its record read again when it's opened again (another screen, an agent
// may have changed it meanwhile)
function scrapView(st, grid, gid) {
  const kept = (grid.page.scrapViews ??= new Map()).get(gid);
  if (kept) {
    st.book.world.append(kept.el);
    readAgain(st.book, kept.page);
    return kept;
  }
  const view = st.hooks.viewFor(scrapPage(grid.page, gid));
  view.el.dataset.focus = '';
  grid.page.scrapViews.set(gid, view);
  return view;
}
// A scrap's own page record: the grid page's id and kind, its one group, its things in its own px
function scrapPage(grid, gid) {
  const g = grid.groups.get(gid),
    page = {
      ...{ id: grid.id, kind: grid.kind, chapter: grid.chapter, notebook: grid.notebook, owner: grid.owner },
      ...{ label: grid.label, sent: grid.sent, readonly: grid.readonly },
      ...{ focus: gid, parent: grid, groups: new Map([[gid, g]]), gone: new Map() },
      origins: new Map([[gid, { x: 0, y: 0 }]]),
      typed: new Map(grid.typed?.has(gid) ? [[gid, grid.typed.get(gid)]] : []),
    };
  for (const [kind, list] of Object.entries(LISTS))
    page[list] = (grid[list] ?? []).filter(el => el.g === gid).map(el => localOf(grid, kind, el));
  return page;
}
// The view it opens at: what's on it as its card shows it, as large as the sheet holds, across its middle
function startCam(st, view) {
  const sheet = sheetRect(st.book),
    fit = cardOf(view.page, view.page.focus),
    w = UNIT_W / fit.k,
    h = fit.h / fit.k,
    // (clear of the tools over its right edge, and of its keys at its top)
    room = sheet.w - st.book.size.right,
    s = Math.min(OPENS.most, Math.max(OPENS.least, Math.min(room / w, (sheet.h - ABOVE) / h))),
    left = sheet.x + Math.max(0, (room - w * s) / 2);
  return { scale: s, pan: { x: fit.x0 - left / s, y: fit.y0 - (sheet.y + ABOVE) / s } };
}

// ---- closing

// The opened scrap put back down on its card: saved, its things onto the grid's page, laid again, and flown back.
// One opened and left empty (a new one never drawn on) goes.
async function close(st) {
  const { book } = st,
    o = st.open;
  if (!o || st.busy) return;
  st.busy = true;
  try {
    book.tools?.leave?.();
    const scrap = o.view.page,
      from = contentRect(st, o.view),
      empty = !Object.values(LISTS).some(list => scrap[list].length) && !scrap.typed?.get(o.gid)?.trim();
    // (the grid laid with it under the sheet, and the sheet flown down onto its card there)
    backOnGrid(scrap, o.grid.page);
    // (its typed words redrawn on its card and where the reflow moved them.)
    o.grid.place(contentOf(book).w);
    book.tools?.added?.(o.grid);
    lifted(o.grid, o.gid, true);
    if (!empty) await fly(st, cardRect(st, o.grid, o.gid), from, false);
    // (where it is now: the notebook's pages may have been read again meanwhile)
    const i = book.views.indexOf(o.view);
    book.views[i >= 0 ? i : o.i] = o.grid;
    // (drawn once its view is the page's: bookgroups.js finds it there.)
    book.groups?.drawn(o.grid.page);
    o.view.el.hidden = true;
    o.view.el.remove();
    unpark(st, o.grid);
    book.root?.toggleAttribute('data-scrap-open', false);
    book.paper.querySelector('.bk-pages')?.toggleAttribute('data-open', false);
    st.open = null;
    st.hooks.lay();
    setView(book, o.cam);
    lifted(o.grid, o.gid, false);
    book.controls?.update();
    document.dispatchEvent(new CustomEvent('book:scrap-close', { detail: { gid: o.gid, page: o.grid.page } }));
    if (empty) thrownOut(st, o.grid, o.gid);
    // (its save done, the grid's group is the store's again)
    // (and what others changed on the grid meanwhile read in)
    saved(book, scrap)
      .then(() => o.grid.page.groups.has(o.gid) && keepGroup(scrap, o.grid.page))
      .then(() => readAgain(book, o.grid.page))
      // (one that failed said why, and is tried again by what waits on the grid's page: booksave.js saved.
      .catch(() => {});
  } finally {
    st.busy = false;
  }
}
// An opened scrap's things back on the grid's page, at its card's place there, and its group as this screen last
// saved or read it. One the grid held already (the same as it was, else by its id) stays the same object, now as the
// scrap left it, so the grid's own steps still hold it (bookedit.js): a picture pasted on the grid, Undo takes it back
// after its scrap was opened.
function backOnGrid(scrap, grid) {
  const gid = scrap.focus;
  for (const [kind, list] of Object.entries(LISTS)) {
    const all = (grid[list] ??= []),
      others = all.filter(el => el.g !== gid),
      had = all.filter(el => el.g === gid),
      // (not what's lifted out of it into a unit of its own: bookunits.js newUnit)
      its = scrap[list]
        .filter(el => el.g === gid || el.g === undefined)
        .map(el => takenFrom(had, laidOf(grid, kind, { ...el, g: gid })));
    all.splice(0, all.length, ...others, ...its);
  }
  keepGroup(scrap, grid);
  if (scrap.typed?.has(gid)) (grid.typed ??= new Map()).set(gid, scrap.typed.get(gid));
}
const keepGroup = (scrap, grid) => {
  const g = scrap.groups.get(scrap.focus);
  if (g) grid.groups.set(scrap.focus, g);
};
// A scrap opened new and left empty: off the grid and out of the store, nothing to undo
async function thrownOut(st, grid, gid) {
  const g = grid.page.groups.get(gid);
  grid.page.groups.delete(gid);
  grid.page.scrapViews?.delete(gid);
  st.hooks.lay();
  try {
    await deleteGroup(st.book.dev, gid, g?.updated);
  } catch (e) {
    console.error('[hq] An empty scrap can’t be let go:', e);
  }
  readAgain(st.book, grid.page);
}

// ---- the grid's view under the sheet

// The grid's view as it was left, under the sheet: out of the world the opened scrap pans and zooms, still where it
// showed, and the paper's dots with it
function park(st, grid) {
  const { book, under, scrim, lift } = st;
  under.style.transform = book.world.style.transform;
  under.style.setProperty('--bk-paper-dots', book.desk.style.backgroundPosition);
  under.append(grid.el);
  book.desk.prepend(under);
  under.after(scrim);
  scrim.after(lift);
  st.flyer.append(book.world);
  lift.after(st.keys);
  place(st);
}
function unpark(st, grid) {
  const { book, under } = st;
  // (the flight down let go: it fills, so the next scrap opened would show shrunk onto this one's card.
  for (const a of st.flyer.getAnimations()) a.cancel();
  book.desk.insertBefore(book.world, st.lift);
  book.world.append(grid.el);
  for (const el of [under, st.scrim, st.lift, st.keys]) el.remove();
  under.style.transform = '';
}
// The sheet and its keys where the paper's size puts them: the margin in from its edges, below the status bar's blur
function place(st) {
  const r = sheetRect(st.book),
    inset = `${r.y}px ${st.book.size.w - r.x - r.w}px ${st.book.size.h - r.y - r.h}px ${r.x}px`;
  for (const el of [st.sheet, st.shade])
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  st.flyer.style.clipPath = `inset(${inset} round 14px)`;
  Object.assign(st.keys.style, { top: `${r.y + 10}px`, right: `${st.book.size.w - r.x - r.w + 10}px` });
}
// The sheet's box on the paper (CSS px from the paper's top-left)
export function sheetRect(book) {
  const { w, h, top } = book.size,
    y = Math.max(MARGIN, top);
  return { x: MARGIN, y, w: w - 2 * MARGIN, h: h - y - MARGIN };
}
// Where a scrap's card shows on the paper (CSS px): its place on the grid's page through the grid's view
function cardRect(st, grid, gid) {
  const p = grid.page.places?.find(q => q.id === gid),
    { pan, scale: s } = st.open?.cam ?? st.book;
  if (!p) return null;
  return { x: (p.x - pan.x) * s, y: (p.y - pan.y) * s, w: p.w * s, h: p.h * s };
}
// Where what its card shows is on the paper with the opened scrap's view as it is (CSS px)
function contentRect(st, view) {
  const fit = cardOf(view.page, view.page.focus),
    { pan, scale: s } = st.book,
    w = UNIT_W / fit.k;
  return { x: (fit.x0 - pan.x) * s, y: (fit.y0 - pan.y) * s, w: w * s, h: (fit.h / fit.k) * s };
}
// A card hidden while it's picked up (its paper, its ink, its photo and its words), and back once it's down
function lifted(grid, gid, on) {
  for (const el of grid.el.querySelectorAll(`[data-unit="${gid}"], [data-g="${gid}"]`))
    el.style.visibility = on ? 'hidden' : '';
}

// ---- the flight

// The sheet flying between a card (on the grid, CSS px) and what of it shows on the sheet (shown): up to the sheet as
// it opens, down onto the card as it's put back. The scrim and keys fade with it. No card (not laid yet): it fades.
function fly(st, card, shown, opening) {
  const { lift, flyer, scrim, keys } = st,
    sheet = flyer.style.clipPath,
    at = card && shown ? toCard(card, shown) : null,
    still = { transform: 'none', clipPath: sheet, opacity: 1 },
    small = at
      ? { transform: at.transform, clipPath: inCard(st.book, shown), opacity: 1 }
      : { transform: 'scale(.96)', clipPath: sheet, opacity: 0 },
    frames = opening ? [small, still] : [still, small],
    timing = { duration: FLY_MS, easing: EASE, fill: 'both' };
  lift.dataset.flying = '';
  const flight = flyer.animate(frames, timing),
    fade = opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
  scrim.animate(fade, timing);
  keys.animate(fade, timing);
  // (its end on the clock too, from when it starts: WebKit can settle finished late, the shadow's filter kept on that
  // long)
  const down = flight.ready.then(
    () => new Promise(done => setTimeout(done, FLY_MS + 40)),
    () => {},
  );
  return Promise.race([flight.finished.catch(() => {}), down]).then(() => {
    // (down, it stays small on its card till it's let go: unpark)
    if (opening) flight.cancel();
    delete lift.dataset.flying;
  });
}
// The transform that lays what shows on the sheet onto its card (from the paper's top-left)
function toCard(card, shown) {
  const k = card.w / shown.w;
  return { transform: `translate(${card.x - shown.x * k}px, ${card.y - shown.y * k}px) scale(${k})` };
}
// The sheet's clip cut to what its card shows
function inCard(book, r) {
  const { w, h } = book.size;
  return `inset(${r.y}px ${w - r.x - r.w}px ${h - r.y - r.h}px ${r.x}px round 6px)`;
}

// ---- taps on the grid

// A tap on the grid (page px, any press lifted where it came down: bookwrite.js gridPress): on a card it opens, in the room between two it
// makes a new scrap there and opens it
async function tapped(st, view, x, y) {
  const page = view.page,
    gid = unitAt(page, x, y);
  if (gid !== undefined && page.groups?.has(gid)) return open(st, gid);
  if (st.busy || page.readonly || page.sent) return;
  const after = beforeTap(page, x, y);
  st.busy = true;
  try {
    const made = await createGroup(st.book.dev, page.id, { empty: true, after });
    await readAgain(st.book, page);
    st.busy = false;
    if (page.groups.has(made.id)) await open(st, made.id);
  } catch (e) {
    view.refuse(e.message);
  } finally {
    st.busy = false;
  }
}
// The scrap a new one tapped in at a point (page px) goes right after: the last in that column above the tap, else
// 'start' when the tap is above them all
function beforeTap(page, x, y) {
  const places = page.places ?? [],
    near = places.reduce(
      (best, p) => {
        const d = Math.abs(x - (p.x + p.w / 2));
        return d < best.d ? { d, column: p.column } : best;
      },
      { d: Infinity, column: undefined },
    ),
    above = places.filter(p => p.column === near.column && p.y + p.h <= y).sort((a, b) => b.y - a.y)[0];
  if (above) return above.id;
  const below = places.filter(p => p.column === near.column).sort((a, b) => a.y - b.y)[0];
  if (!below) return places.at(-1)?.id ?? 'start';
  const order = [...page.groups.values()].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.id - b.id),
    k = order.findIndex(g => g.id === below.id);
  return k > 0 ? order[k - 1].id : 'start';
}
