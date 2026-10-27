// The sheets in the book: on each sheet page ("For Lark") its notes in their sheet's order, each with its number in the
// red disc it has on HQ's page, its snip and its words, a text field the Pencil writes over (Apple's Scribble) or a
// keyboard types into; once sent, "3 notes sent to Bolt · 15:36" at the page's head and the page lightly creased. A
// line from one number to another links the two notes; a face in the rail opens its sheet with a turn of the leaf, and
// the small plane by it hands the sheet over. Holding, dragging and flicking a
// note are booknotegrip.js; the faces' side booksheetface.js; the hand-over's fold and flight bookplane.js; a page
// given by its corner bookdogear.js; the maths booksheetplace.js; the store's routes booksheetdata.js.
//
// The sheets come with the rail's read of them (book:sheets, bookrail.js), so the faces and the pages never disagree;
// every change here reads them again (refreshRail). A call page's come with it (withCalls).
import { esc, store, titleCase } from '../util.js';
import { shownNumbers } from '/__review/notenumbers.js';
import * as world from '../world/world.js';
import { refreshRail } from './bookrail.js';
import { said } from './booksave.js';
import { editNote, linkNotes, loadCalls } from './booksheetdata.js';
import { joined, notesOnPages, sentTo, whose } from './booksheetplace.js';
import { laidOut, takenBoxes } from './booksheetlay.js';
import { mountGrip } from './booknotegrip.js';
// (the faces give, the leaf turns to a sheet, a page goes by its corner)
import { awaitSend, deadlines } from './bookplane.js';
import { mountDogEar } from './bookdogear.js';
import { mountFaces } from './booksheetface.js';
import { pageBox } from './bookrow.js';
import { slipsHtml, tickLine, wire as wireSlips } from './bookslips.js';
import { asksHtml, pageAsksHtml, wireAsks } from './bookslips.js';
import { keep } from './bookedit.js'; // (steps filtered in place, for Redo)

// a note's words are saved this long after the last letter (and at once when the field is left)
const SAVE_MS = 700;
// the room under the last note, so the page never ends at a note's edge
const FOOT_PX = 48;

// book: the pages' (bookpages.js). hooks: { lay(), changed(page), show(pageId), open(day, pageId), made(pageId), release() }
// (open: a day at a page at once, under a turning leaf.).
// Returns { added(view), drawAll(), claim(view, stroke) }: a page view made, a day's row laid out, and a line just
// drawn on a page, which the sheet takes (true) when it links two notes rather than staying as ink.
// (And light(note): Search's find.)
export function mountSheets(book, hooks) {
  const sh = { book, hooks, dev: book.dev, sheets: { open: [], sent: [] }, on: new Map(), deadlines };
  sh.ceo = () => world.company?.ceo;
  sh.name = id => world.agents?.get(id)?.data.name ?? titleCase(id ?? '');
  sh.view = id => book.views.find(v => v.page.id === id);
  sh.note = id => [...sh.sheets.open, ...sh.sheets.sent].flatMap(s => s.notes).find(n => n.id === Number(id));
  sh.sheet = id => [...sh.sheets.open, ...sh.sheets.sent].find(s => s.id === Number(id));
  sh.refresh = () => refreshRail();
  sh.tell = (page, e) => (page ? said(book, page, e.message) : console.error('[hq] The book:', e));
  mountGrip(sh);
  sh.corner = mountDogEar(sh);
  document.addEventListener('book:sheets', e =>
    withCalls(sh, e.detail).then(
      sheets => {
        sh.sheets = sheets;
        drawAll(sh);
      },
      err => sh.tell(null, err),
    ),
  );
  mountFaces(sh); // (a face opens its sheet, its plane gives it: booksheetface.js.)
  // a note the Pencil just left: its page may be new today (the first mark on that agent's work), read in at it once
  document.addEventListener('pencil:note', e => {
    if (!book.who && book.day === book.today && !sh.view(e.detail?.page)) hooks.made(e.detail.page);
  });
  return {
    added: v => (v.page.kind === 'call' ? drawAll(sh) : draw(sh, v)),
    drawAll: () => drawAll(sh),
    // (a tick written over an answer's slip ticks it: bookslips.js.)
    claim: (v, stroke) => linkLine(sh, v, stroke) || tickLine(sh, v, stroke),
    // (Search's find)
    light: id => light(sh, id),
    // (a page's ink just read: the table laid out again, and a sheet's notes round the ink.)
    inked: v => {
      hooks.lay();
      if (v.page.kind === 'sheet') settle(sh, v);
    },
  };
}
// A note's number lit where a page of the row shows it (Search's find): its note, or null when none shows it.
// (a note with no number shows none: its cutting is lit.)
function light(sh, id) {
  const note = sh.book.world.querySelector(`.bs-note[data-id="${Number(id)}"]`),
    n = note?.querySelector('.bs-n') ?? note?.querySelector('.bs-body');
  if (!n) return null;
  delete n.dataset.lit;
  void n.offsetWidth; // (lit again from the start when it's the same one)
  n.dataset.lit = '';
  n.addEventListener('animationend', () => delete n.dataset.lit, { once: true });
  return note;
}

// ---- drawing

function drawAll(sh) {
  // (a note held up is left alone: the sheets are drawn again once it's put down)
  if (sh.busy) return;
  if (sh.sheets.callsFor !== callPages(sh).join()) {
    withCalls(sh, sh.sheets).then(
      () => drawAll(sh),
      err => sh.tell(null, err),
    );
    return;
  }
  sh.on = notesOnPages(
    sh.sheets,
    sh.book.views.map(v => v.page),
    sh.ceo(),
  );
  for (const v of sh.book.views) draw(sh, v);
  for (const s of sh.sheets.open) if (s.status === 'sending') awaitSend(sh, s);
  // a send that has gone can't be undone any more: its step leaves the book's undo
  keep(sh.book.steps, step => !step.sheet || !sh.sheets.sent.some(s => s.id === step.sheet));
}
// The call pages in the row, by id: each one's notes read with it (its call's sheet, never sent), however old the call,
// with every read of the sheets and as a call page comes into the row.
const callPages = sh => sh.book.views.filter(v => v.page.kind === 'call' && v.page.id).map(v => v.page.id);
async function withCalls(sh, sheets) {
  const pages = callPages(sh);
  sheets.calls = pages.length ? await loadCalls(sh.dev, pages) : [];
  sheets.callsFor = pages.join();
  return sheets;
}
function draw(sh, v) {
  sh.corner.draw(v); // (a page sent by its corner: when it went.)
  const slot = v.el.querySelector('[data-slot=notes]');
  if (!slot || !v.page.id) return;
  const groups = sh.on.get(v.page.id) ?? [];
  const creased = groups.length > 0 && groups.every(g => g.sheet.status === 'sent');
  // (a page whose words are being written keeps its notes as they are till they're left: only its head follows)
  if (slot.contains(document.activeElement)) return head(sh, v, groups, creased);
  // (each open note's number, when the page shows several to tell apart: notenumbers.js.)
  const numbers = shownNumbers(
    groups.flatMap(g => (g.sheet.status === 'sent' ? [] : g.notes.map(x => x.note).filter(n => n.status === 'open'))),
  );
  // (a sheet just sent from here: its line pressed on as it lands.)
  const fresh = new Set(
    groups.filter(g => g.sheet.status === 'sent' && sh.deadlines.has(g.sheet.id)).map(g => g.sheet.id),
  );
  // (the desk phone's cards about this page, with no note on it)
  const pageAsks = (sh.sheets.asks ?? []).filter(a => a.on === v.page.id);
  slot.innerHTML = `${creased ? creaseHtml(v.page) : ''}<div class="bs-list">${groups
    .map(g => groupHtml(sh, g, groups.length > 1, numbers, fresh))
    .join('')}${pageAsksHtml(pageAsks)}</div><svg class="bs-links" aria-hidden="true"></svg>`;
  head(sh, v, groups, creased, fresh);
  for (const id of fresh) sh.deadlines.delete(id);
  for (const field of slot.querySelectorAll('textarea.bs-words')) words(sh, v, field);
  wireSlips(sh, slot);
  // (and the cards about its notes and itself, answered here as on the desk phone)
  const asks = [...groups.flatMap(g => g.notes.flatMap(({ note }) => note.asks ?? [])), ...pageAsks];
  wireAsks(slot, sh.dev, new Map(asks.map(a => [a.id, a])));
  for (const img of slot.querySelectorAll('img.bs-snip')) img.addEventListener('load', () => snipSize(sh, v, img));
  // (a slip's pictures make the page longer as they come.)
  for (const img of slot.querySelectorAll('.answer-slip img')) img.addEventListener('load', () => settle(sh, v));
  requestAnimationFrame(() => settle(sh, v));
}
// A sheet's notes on the page; a sent one under what went to whom and when ("3 notes sent to Bolt · 15:36"), when the
// page has more than one (one alone: at the page's head). numbers: shownNumbers'; fresh: the sheets just sent from here.
// (a sheet in its seconds to undo: its notes gone faint, folded into the plane.)
function groupHtml(sh, { sheet, notes }, captioned, numbers, fresh) {
  const sent = sheet.status === 'sent',
    going = sheet.status === 'sending' ? ' data-going' : '';
  return `<section class="bs-group" data-sheet="${sheet.id}"${sent ? ' data-sent' : ''}${going}>${
    sent && captioned
      ? `<p class="bs-when"${fresh.has(sheet.id) ? ' data-fresh' : ''}>${esc(sentOf(sh, sheet))}</p>`
      : ''
  }${notes.map(({ note, away }) => noteHtml(sh, sheet, note, away, numbers.get(note.id))).join('')}</section>`;
}
const sentOf = (sh, sheet) => sentTo(sheet.notes.length, sh.name(whose(sheet, sh.ceo())), sheet.sent);
// (shown: its number on the page, or none. Its snip taped on a touch askew, each its own way, as a cutting in a
// scrapbook.)
function noteHtml(sh, sheet, n, away, shown) {
  // (a call's notes were heard on the call: kept as they were said.)
  const open = sheet.status !== 'sent' && sheet.status !== 'call' && n.status === 'open',
    who = n.guest ? ` style="--who: ${esc(n.guest.colour)}"` : '';
  const label = `Note${shown ? ` ${shown}` : ''}${n.guest ? `, ${n.guest.name}'s` : ''}`;
  return `<article class="bs-note" role="group" aria-label="${esc(label)}" data-id="${n.id}" data-sheet="${sheet.id}"${
    open ? ' data-open' : ''
  } style="--tilt: ${tiltOf(n.id)}deg">${shown ? `<b class="bs-n"${who}>${shown}</b>` : ''}<div class="bs-body">${
    n.guest ? `<span class="bs-tag"${who}>${esc(n.guest.name)}</span>` : ''
  }${away ? `<span class="bs-away">For ${esc(sh.name(away))}</span>` : ''}${
    n.snip
      ? `<span class="bs-cut"><img class="bs-snip" src="${esc(n.snip)}" alt="" draggable="false" data-id="${n.id}" data-dpr="${
          Number(n.anchor?.view?.dpr) || 2
        }"${sizes.has(n.id) ? ` style="width: ${sizes.get(n.id)}px"` : ''}></span>`
      : ''
  }${
    open || n.words
      ? `<textarea class="bs-words" rows="1" data-id="${n.id}" aria-label="${esc(label)}: its words" placeholder="Write here"${
          open ? '' : ' readonly'
        }>${esc(n.words)}</textarea>`
      : ''
  }${slipsHtml(n)}${asksHtml(n)}</div></article>`; // (asksHtml)
}
// A cutting's tilt: a degree or so either way, the same for a note each time it's drawn
const tiltOf = id => (((id * 7919) % 23) / 22 - 0.5) * 2.4;
// The fold lines of a sheet that has been sent: folded into a plane, opened again (a centre crease, the nose's two
// folds and the wings'), each a faint light line beside a fainter shadow
function creaseHtml({ w, h }) {
  const m = w / 2,
    folds = [
      [m, 0, m, h],
      [m, 0, 0, m],
      [m, 0, w, m],
      [m * 0.55, 0, m * 0.55, Math.min(h, w * 1.1)],
      [w - m * 0.55, 0, w - m * 0.55, Math.min(h, w * 1.1)],
    ];
  const line = ([x1, y1, x2, y2]) =>
    `<path d="M${x1 + 1} ${y1}L${x2 + 1} ${y2}" class="bs-fold-shade"/><path d="M${x1} ${y1}L${x2} ${y2}" class="bs-fold"/>`;
  return `<svg class="bs-crease" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path class="bs-fold-side" d="M${m} 0H${w}V${h}H${m}z"/>${folds
    .map(line)
    .join('')}</svg>`;
}

// The page's head beside "For Lark": what went to whom and when, once sent ("3 notes sent to Bolt · 15:36"), pressed on
// as it lands just after a send from here; a page of several sheets says it over each. (the plane is the face's, bookrail.js)
function head(sh, v, groups, creased, fresh = new Set()) {
  const at = v.el.querySelector('[data-slot=stamp]');
  if (!at || v.page.kind !== 'sheet') return;
  const last = creased && groups.length === 1 ? groups[0].sheet : null;
  at.innerHTML = last
    ? `<span class="bs-stamp"${fresh.has(last.id) ? ' data-fresh' : ''}>${esc(sentOf(sh, last))}</span>`
    : '';
}
// ---- words

// A note's words as a text field: the Pencil writes over them (Scribble), a keyboard types; saved soon after, and at
// once when left. A finger or the Pencil on it is the field's: never the table's pan or the page's ink.
function words(sh, v, field) {
  const fitted = () => {
    field.style.height = 'auto';
    field.style.height = `${Math.max(26, field.scrollHeight)}px`;
  };
  fitted();
  // (drawn before its page is laid out, or at another width: fitted again as its width settles, never for its height)
  let width = field.clientWidth;
  new ResizeObserver(() => {
    if (field.clientWidth === width) return;
    width = field.clientWidth;
    requestAnimationFrame(fitted); // (not inside the observer's own pass: its height change would be one more for it)
  }).observe(field);
  for (const type of ['pointerdown', 'touchstart', 'touchmove']) field.addEventListener(type, e => e.stopPropagation());
  if (field.readOnly) return;
  let timer = 0;
  const save = async () => {
    clearTimeout(timer);
    timer = 0;
    const note = sh.note(field.dataset.id);
    if (!note || note.words === field.value.trim()) return;
    note.words = field.value.trim();
    try {
      await editNote(sh.dev, note.id, note.words);
    } catch (e) {
      sh.tell(v.page, e);
    }
  };
  field.addEventListener('input', () => {
    fitted();
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_MS);
    settle(sh, v);
  });
  field.addEventListener('blur', () => timer && save());
}

// ---- the page's size, the snips' and the links' lines

// A snip as it was cut: its CSS px (its picture's px over the screen's pixel ratio), at most the page's width
const sizes = new Map(); // (each snip's width, kept: a sheet drawn again never jumps while its pictures load)
function snipSize(sh, v, img) {
  sizes.set(Number(img.dataset.id), Math.round(img.naturalWidth / Number(img.dataset.dpr)));
  img.style.width = `${sizes.get(Number(img.dataset.id))}px`;
  settle(sh, v);
}
// The page grows to hold its notes (never shrinks: page/save keeps its height), and the links are drawn between discs
function settle(sh, v) {
  const slot = v.el.querySelector('[data-slot=notes]'),
    list = slot?.querySelector('.bs-list');
  if (!list) return;
  lie(sh, v, list);
  // (the page's box may start above 0: its foot is y1.)
  const need = Math.ceil(list.offsetTop + list.offsetHeight + FOOT_PX),
    box = pageBox(v.page);
  if (need > box.y1) {
    v.page.h = need - box.y0;
    v.page.blank = false;
    sh.hooks.lay();
    // (a page whose ink isn't read yet is saved once it is: a save is its whole ink)
    if (v.page.ink) sh.hooks.changed(v.page);
  }
  links(sh, v, slot);
}
// The notes down the page clear of the board's writing and pictures there, and of each other (booksheetlay.js): each
// note (with its sent sheet's line over it, for a sheet's first) pushed down as far as it must, its place kept in this
// browser once its page's ink is read, so writing added round it later never moves it.
const SPOTS = 'book.spots';
function lie(sh, v, list) {
  const els = [...list.querySelectorAll('.bs-note')],
    leads = els.map(el => (el.previousElementSibling?.matches('.bs-when') ? el.previousElementSibling : el));
  for (const lead of leads) lead.style.marginTop = '';
  if (!els.length) return;
  const notes = els.map((el, i) => {
    const top = list.offsetTop + leads[i].offsetTop;
    return {
      id: Number(el.dataset.id),
      top,
      h: list.offsetTop + el.offsetTop + el.offsetHeight - top,
      after: i ? Number(els[i - 1].dataset.id) : null,
    };
  });
  const kept = new Map(Object.entries(store.get(SPOTS, {})).map(([id, p]) => [Number(id), p])),
    held = Number(list.contains(document.activeElement) && document.activeElement.dataset.id) || null,
    column = { x0: list.offsetLeft + els[0].offsetLeft, x1: list.offsetLeft + els[0].offsetLeft + els[0].offsetWidth };
  const out = laidOut(notes, column, takenBoxes(v.page.ink ?? [], v.page.scraps), kept, held);
  let shift = 0;
  notes.forEach((x, i) => {
    const down = out.get(x.id).y - (x.top + shift);
    if (down > 0.5) leads[i].style.marginTop = `${parseFloat(getComputedStyle(leads[i]).marginTop) + down}px`;
    shift += down;
  });
  // (kept only once the page's ink is read: a place given without it could be on writing not seen yet)
  if (!v.page.ink) return;
  const shown = new Set([...sh.sheets.open, ...sh.sheets.sent].flatMap(s => s.notes.map(n => n.id)));
  const all = Object.fromEntries([...kept, ...out].filter(([id]) => shown.has(id)));
  store.set(SPOTS, all);
}
// A disc's middle on its page, in the page's px (a note with no number: where its disc would be)
export function discsOf(v) {
  const at = v.el.getBoundingClientRect();
  return [...v.el.querySelectorAll('.bs-note')].map(el => {
    const disc = el.querySelector('.bs-n'),
      r = (disc ?? el).getBoundingClientRect();
    return {
      id: Number(el.dataset.id),
      sheet: Number(el.dataset.sheet),
      x: disc ? r.left + r.width / 2 - at.left : r.left + 16 - at.left,
      y: disc ? r.top + r.height / 2 - at.top : r.top + 12 - at.top,
    };
  });
}
// A thin line between linked notes' discs, bowed out to the left of the column of numbers
function links(sh, v, slot) {
  const svg = slot.querySelector('.bs-links'),
    discs = discsOf(v),
    at = new Map(discs.map(d => [d.id, d]));
  Object.assign(svg.style, { width: `${v.page.w}px`, height: `${v.page.h}px` });
  svg.innerHTML = discs
    .flatMap(a =>
      (sh.note(a.id)?.links ?? [])
        .filter(id => id > a.id && at.has(id))
        .map(id => {
          const b = at.get(id),
            bow = Math.max(6, a.x - 14 - Math.abs(b.y - a.y) * 0.06);
          return `<path d="M${a.x} ${a.y}C${bow} ${a.y},${bow} ${b.y},${b.x} ${b.y}"/>`;
        }),
    )
    .join('');
}

// A line drawn on a sheet page from one open note's number to another's (on one sheet) links them, or unlinks two that
// were: the sheet takes it, never kept as ink. Undo takes it back.
function linkLine(sh, v, stroke) {
  if (v.page.kind !== 'sheet') return false;
  const discs = discsOf(v).filter(d => sh.note(d.id)?.status === 'open' && sh.sheet(d.sheet)?.status !== 'sent');
  const pair = joined(stroke.points, discs);
  if (!pair) return false;
  const [a, b] = pair.map(id => sh.note(id));
  if (a.sheet !== b.sheet) return false;
  const linked = !(a.links ?? []).includes(b.id);
  const link = async on => {
    try {
      await linkNotes(sh.dev, a.id, b.id, on);
    } catch (e) {
      sh.tell(v.page, e);
    }
    sh.refresh();
  };
  sh.book.steps.push({ undo: () => link(!linked) });
  link(linked);
  return true;
}
