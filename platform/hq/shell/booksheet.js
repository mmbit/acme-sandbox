// The sheets in the book: on each sheet page ("For Lark") its notes in their sheet's order, each with its number in the
// red disc it has on HQ's page, its snip and its words, a text field the Pencil writes over (Apple's Scribble) or a
// keyboard types into; at the page's head the paper plane that sends the sheet, ten seconds to undo, then "Sent 08:16"
// and the page lightly creased. A line from one number to another links the two notes; a face in the rail opens its
// sheet. Holding, dragging and flicking a note are booknotegrip.js; the plane's flight bookplane.js, a free page's
// booksendpage.js; the maths
// booksheetplace.js; the store's routes booksheetdata.js.
//
// The sheets come with the rail's read of them (book:sheets, bookrail.js), so the faces and the pages never disagree;
// every change here reads them again (refreshRail).
import { esc, titleCase } from '../util.js';
import * as world from '../world/world.js';
import { refreshRail } from './bookrail.js';
import { said } from './booksave.js';
import { editNote, linkNotes } from './booksheetdata.js';
import { joined, notesOnPages, planeSheet, sentLine, whose } from './booksheetplace.js';
import { mountGrip } from './booknotegrip.js';
import { mountPageSend } from './booksendpage.js';
import { PLANE, awaitSend, flightHtml, sendNow, undoNow } from './bookplane.js';
import { slipsHtml, tickLine, wire as wireSlips } from './bookslips.js';

// a note's words are saved this long after the last letter (and at once when the field is left)
const SAVE_MS = 700;
// the room under the last note, so the page never ends at a note's edge
const FOOT_PX = 48;

// book: the pages' (bookpages.js). hooks: { lay(), changed(page), show(pageId), today(), reload(), release() }.
// Returns { added(view), drawAll(), claim(view, stroke) }: a page view made, a day's row laid out, and a line just
// drawn on a page, which the sheet takes (true) when it links two notes rather than staying as ink.
// (And light(note): Search's find.)
export function mountSheets(book, hooks) {
  const sh = { book, hooks, dev: book.dev, sheets: { open: [], sent: [] }, on: new Map(), deadlines: new Map() };
  sh.ceo = () => world.company?.ceo;
  sh.name = id => world.agents?.get(id)?.data.name ?? titleCase(id ?? '');
  sh.view = id => book.views.find(v => v.page.id === id);
  sh.note = id => [...sh.sheets.open, ...sh.sheets.sent].flatMap(s => s.notes).find(n => n.id === Number(id));
  sh.sheet = id => [...sh.sheets.open, ...sh.sheets.sent].find(s => s.id === Number(id));
  sh.refresh = () => refreshRail();
  sh.tell = (page, e) => (page ? said(book, page, e.message) : console.error('[hq] The book:', e));
  mountGrip(sh);
  sh.pageSend = mountPageSend(sh);
  document.addEventListener('book:sheets', e => {
    sh.sheets = e.detail;
    drawAll(sh);
  });
  document.addEventListener('book:face', e => openSheetOf(sh, e.detail.owner ?? sh.ceo()));
  // a note the Pencil just left: its page may be new today (the first mark on that agent's work)
  document.addEventListener('pencil:note', e => {
    if (book.day === book.today && !sh.view(e.detail?.page)) hooks.reload();
  });
  return {
    added: v => draw(sh, v),
    drawAll: () => drawAll(sh),
    // (a tick written over an answer's slip ticks it: bookslips.js.)
    claim: (v, stroke) => linkLine(sh, v, stroke) || tickLine(sh, v, stroke),
    // (Search's find)
    light: id => light(sh, id),
  };
}
// A note's number lit where a page of the row shows it (Search's find): its note, or null when none shows it.
function light(sh, id) {
  const note = sh.book.world.querySelector(`.bs-note[data-id="${Number(id)}"]`),
    n = note?.querySelector('.bs-n');
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
  sh.on = notesOnPages(
    sh.sheets,
    sh.book.views.map(v => v.page),
    sh.ceo(),
  );
  for (const v of sh.book.views) draw(sh, v);
  for (const s of sh.sheets.open) if (s.status === 'sending') awaitSend(sh, s);
  // a send that has gone can't be undone any more: its step leaves the book's undo
  sh.book.steps = sh.book.steps.filter(step => !step.sheet || !sh.sheets.sent.some(s => s.id === step.sheet));
}
function draw(sh, v) {
  if (v.page.kind === 'free') return sh.pageSend.draw(v);
  const slot = v.el.querySelector('[data-slot=notes]');
  if (!slot || !v.page.id) return;
  const groups = sh.on.get(v.page.id) ?? [];
  const creased = groups.length > 0 && groups.every(g => g.sheet.status === 'sent');
  // (a page whose words are being written keeps its notes as they are till they're left: only its head follows)
  if (slot.contains(document.activeElement)) return head(sh, v, groups, creased);
  slot.innerHTML = `${creased ? creaseHtml(v.page) : ''}<div class="bs-list">${groups
    .map(g => groupHtml(sh, g, groups.length > 1))
    .join('')}</div><svg class="bs-links" aria-hidden="true"></svg>`;
  head(sh, v, groups, creased);
  for (const field of slot.querySelectorAll('textarea.bs-words')) words(sh, v, field);
  wireSlips(sh, slot);
  for (const img of slot.querySelectorAll('img.bs-snip')) img.addEventListener('load', () => snipSize(sh, v, img));
  // (a slip's pictures make the page longer as they come.)
  for (const img of slot.querySelectorAll('.answer-slip img')) img.addEventListener('load', () => settle(sh, v));
  requestAnimationFrame(() => settle(sh, v));
}
// A sheet's notes on the page; a sent one under the time it went, when the page has more than one
function groupHtml(sh, { sheet, notes }, captioned) {
  const sent = sheet.status === 'sent';
  return `<section class="bs-group" data-sheet="${sheet.id}"${sent ? ' data-sent' : ''}>${
    sent && captioned ? `<p class="bs-when">${esc(sentLine(sheet.sent))}</p>` : ''
  }${notes.map(({ note, away }) => noteHtml(sh, sheet, note, away)).join('')}</section>`;
}
function noteHtml(sh, sheet, n, away) {
  const open = sheet.status !== 'sent' && n.status === 'open',
    who = n.guest ? ` style="--who: ${esc(n.guest.colour)}"` : '';
  const label = `Note ${n.n}${n.guest ? `, ${n.guest.name}'s` : ''}`;
  return `<article class="bs-note" role="group" aria-label="${esc(label)}" data-id="${n.id}" data-sheet="${sheet.id}"${
    open ? ' data-open' : ''
  }><b class="bs-n"${who}>${n.n}</b><div class="bs-body">${
    n.guest ? `<span class="bs-tag"${who}>${esc(n.guest.name)}</span>` : ''
  }${away ? `<span class="bs-away">For ${esc(sh.name(away))}</span>` : ''}${
    n.snip
      ? `<img class="bs-snip" src="${esc(n.snip)}" alt="" draggable="false" data-id="${n.id}" data-dpr="${
          Number(n.anchor?.view?.dpr) || 2
        }"${sizes.has(n.id) ? ` style="width: ${sizes.get(n.id)}px"` : ''}>`
      : ''
  }${
    open || n.words
      ? `<textarea class="bs-words" rows="1" data-id="${n.id}" aria-label="Note ${n.n}'s words" placeholder="Write here"${
          open ? '' : ' readonly'
        }>${esc(n.words)}</textarea>`
      : ''
  }${slipsHtml(n)}</div></article>`;
}
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

// The page's head beside "For Lark": the plane and its count, the seconds to undo a send, or when it went
function head(sh, v, groups, creased) {
  const at = v.el.querySelector('[data-slot=plane]');
  if (!at) return;
  const sheet = planeSheet(sh.sheets, v.page, sh.ceo(), groups);
  if (sheet?.status === 'sending') at.innerHTML = flightHtml(sh, sheet, sh.name(whose(sheet, sh.ceo())));
  else if (sheet) {
    const count = sheet.notes.filter(n => n.status === 'open').length,
      to = sh.name(whose(sheet, sh.ceo()));
    at.innerHTML = `<button class="bs-plane" data-send="${sheet.id}" aria-label="Send to ${esc(to)}: ${count} note${
      count === 1 ? '' : 's'
    }" title="Send to ${esc(to)}">${PLANE}<b>${count}</b></button>`;
  } else if (creased) {
    const last = groups.map(g => g.sheet).sort((a, b) => (a.sent < b.sent ? 1 : -1))[0];
    at.innerHTML = `<span class="bs-stamp">${esc(sentLine(last.sent))}</span>`;
  } else at.innerHTML = '';
  // (a tap on the plane is the plane's: never the table's pan or the page's ink, which would take its click)
  at.onpointerdown = e => e.stopPropagation();
  at.onclick = e => {
    const send = e.target.closest('[data-send]'),
      back = e.target.closest('[data-undo]');
    if (send) sendNow(sh, v, sh.sheet(send.dataset.send), send);
    if (back) undoNow(sh, v, sh.sheet(back.dataset.undo));
  };
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
  const need = Math.ceil(list.offsetTop + list.offsetHeight + FOOT_PX);
  if (need > v.page.h) {
    v.page.h = need;
    v.page.blank = false;
    sh.hooks.lay();
    // (a page whose ink isn't read yet is saved once it is: a save is its whole ink)
    if (v.page.ink) sh.hooks.changed(v.page);
  }
  links(sh, v, slot);
}
// A disc's middle on its page, in the page's px
export function discsOf(v) {
  const at = v.el.getBoundingClientRect();
  return [...v.el.querySelectorAll('.bs-note')].map(el => {
    const r = el.querySelector('.bs-n').getBoundingClientRect();
    return {
      id: Number(el.dataset.id),
      sheet: Number(el.dataset.sheet),
      x: r.left + r.width / 2 - at.left,
      y: r.top + r.height / 2 - at.top,
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

// ---- a face opens its sheet

// Today's sheet page for that agent, the table sliding to it (today's row opened first when another day shows). One the
// book hasn't read yet (a note in review mode on a preview made it: bookreview.ts) brings today's row and the sheets in
// again.
async function openSheetOf(sh, owner) {
  const find = () => sh.book.views.find(v => v.page.kind === 'sheet' && v.page.owner === owner && v.page.id);
  if (!find()) {
    // (from an invited person's book open, the board's own)
    await (sh.book.day !== sh.book.today || sh.book.who ? sh.hooks.today() : sh.hooks.reload());
    await sh.refresh();
  }
  const v = find();
  if (v) sh.hooks.show(v.page.id);
}
