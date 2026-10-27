// Pictures taped into the book: pasted with Cmd/Ctrl+V while the book is open, dropped on its paper, pasted from the
// Paste bubble a finger held still on a page brings, or carried in from HQ's page (a ring the Pencil drew, lifted by a
// finger: shared/review/carry.js, heard as 'book:tape' events). Each lands a touch askew in a white border with a strip
// of tape (sketchscraps.js drawScrap, as bookpage.js draws a page's scraps), and is one step Undo takes back.
//
// Where it lands: pasted, on the page in view, or under the point when dropped or held (today's free page when that
// page is a call's or a guest's); carried, on today's free page, at the spot if it's let go over that page.
import { act, refused } from './data.js';
import { stylesheet } from '../util.js';
import { sfx } from './audio.js';
import { createPage, loadPage } from './bookdata.js';
import { changed, newSides, readAt, said } from './booksave.js';
import { pageBox, scrapBoxOf, spanOf } from './bookrow.js';
import { shrink } from './sketchscraps.js';
import { placeScrap } from './bookscrap.js';

const IMAGE = /^image\//;
// a finger held this long, this still, on a page brings the Paste bubble; it goes again after BUBBLE_MS
const HOLD_MS = 500,
  HOLD_PX = 8,
  BUBBLE_MS = 5000;
// the pages a picture is taped on as they are; any other kind sends it to today's free page
const TAPES_ON = new Set(['free', 'sheet']);

// book: bookpages.js's; paper: the book's paper. pages: bookpages.js's own, each given the book: { openDay(book)
// (today's row, a promise), lay(book) (the row laid out again), inView(book, i, box) (the table slides to show a box on
// page i), blank(book) (today's blank page at the end, added when none waits) }
export function mountTape(book, paper, pages) {
  stylesheet('shell/booktape.css');
  const tape = { book, paper, pages, bubble: null };
  document.addEventListener('paste', e => pasted(tape, e));
  paper.addEventListener('dragover', e => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  paper.addEventListener('drop', e => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    const found = images(e.dataTransfer.files);
    if (found.length) found.forEach((f, i) => tapeIn(tape, f, { at: [e.clientX, e.clientY], i }));
  });
  held(tape);
  document.addEventListener('book:tape', e => carried(tape, e));
}

// ---- the ways in

const images = list => [...(list ?? [])].filter(f => IMAGE.test(f.type));
const carriesFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files');
const open = () => ['open', 'spread'].includes(document.documentElement.dataset.book);
// Cmd/Ctrl+V with the book open: the clipboard's pictures on the page in view. A paste into a text field, or into
// review mode's note, is theirs.
function pasted(tape, e) {
  const found = images(e.clipboardData?.files),
    target = e.composedPath()[0];
  if (!found.length || !open()) return;
  if (target instanceof Element && target.closest('input, textarea, [contenteditable], review-mode')) return;
  e.preventDefault();
  found.forEach((f, i) => tapeIn(tape, f, { i }));
}

// A finger held still on a page: a Paste bubble there, which reads the clipboard when tapped (Safari asks first)
function held(tape) {
  const desk = tape.book.desk;
  let hold = null;
  const away = () => {
    clearTimeout(hold?.timer);
    hold = null;
  };
  desk.addEventListener('pointerdown', e => {
    away();
    // (a press on an open note on a sheet is the note's: held, it lifts to be carried, booknotegrip.js)
    if (e.pointerType !== 'touch' || !e.isPrimary || e.target.closest?.('.bs-note[data-open]')) return;
    if (onPage(tape.book, e) < 0) return;
    hold = { id: e.pointerId, from: [e.clientX, e.clientY] };
    hold.timer = setTimeout(() => {
      const at = hold.from;
      hold = null;
      offerPaste(tape, at);
    }, HOLD_MS);
  });
  desk.addEventListener('pointermove', e => {
    if (hold && e.pointerId === hold.id && Math.hypot(e.clientX - hold.from[0], e.clientY - hold.from[1]) > HOLD_PX)
      away();
  });
  desk.addEventListener('pointerup', away);
  desk.addEventListener('pointercancel', away);
}
function offerPaste(tape, [x, y]) {
  tape.bubble?.remove();
  const box = tape.paper.getBoundingClientRect();
  const bubble = Object.assign(document.createElement('button'), { className: 'bk-paste', textContent: 'Paste' });
  Object.assign(bubble.style, { left: `${x - box.left}px`, top: `${y - box.top}px` });
  tape.paper.append((tape.bubble = bubble));
  sfx.tick();
  const gone = e => {
    if (e?.target === bubble) return;
    bubble.remove();
    if (tape.bubble === bubble) tape.bubble = null;
    removeEventListener('pointerdown', gone, true);
  };
  addEventListener('pointerdown', gone, true);
  setTimeout(gone, BUBBLE_MS);
  bubble.onclick = async () => {
    gone();
    const i = onPage(tape.book, { clientX: x, clientY: y });
    try {
      const items = await navigator.clipboard.read();
      const imageOf = it => {
        const type = it.types.find(t => IMAGE.test(t));
        return type && it.getType(type);
      };
      const found = (await Promise.all(items.map(imageOf))).filter(Boolean);
      if (!found.length) return tell(tape, i, 'No picture to paste: copy one first.');
      found.forEach((f, n) => tapeIn(tape, f, { at: [x, y], i: n }));
    } catch {
      tell(tape, i, 'The clipboard can’t be read here: paste with ⌘V or Ctrl+V.');
    }
  };
}

// Carried in from HQ's page: 'over' asks whether a point is the paper's (cancelled: yes), 'drop' tapes it there
function carried(tape, e) {
  const { phase, x, y, picture } = e.detail ?? {},
    box = tape.paper.getBoundingClientRect();
  if (!open() || x < box.left || x >= box.right || y < box.top || y >= box.bottom) return;
  e.preventDefault();
  if (phase === 'drop' && picture)
    Promise.resolve(picture).then(
      blob => blob && tapeIn(tape, blob, { at: [x, y], today: true }),
      err => tell(tape, onPage(tape.book, { clientX: x, clientY: y }), `That picture didn’t come: ${err.message}`),
    );
}

// ---- taping

// The page under a point on screen, or -1 (book.at: the page shown, off the paper null.)
const onPage = (book, e) => book.at(e.clientX, e.clientY)?.i ?? -1;
// Words said on the page in view (or the one asked for)
function tell(tape, i, words) {
  const { book } = tape,
    v = book.views[i >= 0 ? i : book.cur];
  if (v) said(book, v.page, words);
}

// The page a picture goes on: today's free page when asked (or the page under the point isn't one it tapes on), else
// the page under the point, else the one in view. Today's row is opened for it when the book shows another day.
async function pageFor(tape, { at, today }) {
  const { book } = tape;
  const i = at ? onPage(book, { clientX: at[0], clientY: at[1] }) : book.cur,
    v = book.views[i];
  const fits = v && TAPES_ON.has(v.page.kind) && (!today || (v.page.kind === 'free' && v.page.day === book.today));
  if (fits) return { v, at: !!at };
  if (book.day !== book.today) await tape.pages.openDay(tape.book);
  const free = book.views.findLast(x => x.page.kind === 'free' && (x.page.blank || x.page.day === book.today));
  return { v: free ?? tape.pages.blank(book), at: false };
}

// A picture file onto the book: drawn smaller (sketchscraps.js shrink, at most 2,000 px a side), kept by the store on
// its page, placed, drawn, saved, and a step Undo takes back. at: [x, y] on screen. i: its place among several.
// today: carried, so today's free page.
async function tapeIn(tape, file, { at = null, i = 0, today = false }) {
  const { book } = tape;
  const small = await shrink(file);
  if (!small) return tell(tape, -1, 'That picture couldn’t be read here. Another kind of file?');
  const found = await pageFor(tape, { at, today });
  if (!found.v) return;
  const { v } = found,
    page = v.page;
  try {
    await ready(book, v);
    const kept = await upload(book, page.id, small.blob);
    const k = book.views.indexOf(v);
    if (k < 0) return; // (the book went to another day meanwhile)
    // (the spot on the page, and the part of it the paper shows: its top when it isn't the page shown.)
    const point = found.at && book.at(at[0], at[1]),
      spot = point?.i === k ? [point.x, point.y] : null,
      view = k === book.cur ? book.shown() : pageBox(page);
    const scrap = {
      file: kept.file,
      url: kept.url,
      ...placeScrap({ nw: small.w, nh: small.h }, page, { at: spot, view, i }),
    };
    page.scraps.push(scrap);
    page.blank = false;
    shown(tape, v, scrap);
    book.tools?.taped(v, scrap);
    sfx.land();
    changed(book, page);
    book.steps.push({
      undo: () => {
        const n = page.scraps.indexOf(scrap);
        if (n < 0) return;
        page.scraps.splice(n, 1);
        shown(tape, v, scrap);
        changed(book, page);
      },
    });
  } catch (e) {
    said(book, page, `That picture didn’t stay: ${e.message}`);
  }
}
// The page made in the store if it's still blank, and its ink and pictures read, so a picture joins what's there
async function ready(book, v) {
  const page = v.page;
  if (!page.id) {
    const made = await createPage(book.dev, newSides(page));
    Object.assign(page, { id: made.id, day: made.day, blank: false });
  }
  if (page.ink) return;
  const full = await (v.reading ?? loadPage(book.dev, page.id, book.who));
  // (bookpages.js read() fills the page itself; read here first, this fills it and stands in for that read)
  if (!page.ink && full)
    Object.assign(readAt(page, full), {
      ink: full.ink,
      scraps: full.scraps,
      texts: full.texts,
      ...spanOf(page, full),
    });
  v.reading ??= Promise.resolve(full);
  if (!page.ink) throw refused(0, 'this page couldn’t be read. Try again.');
}
// A picture already in the book kept again as one of a page's own (a picture is on a page once, pagescraps.ts): its
// file read and uploaded for the view's page, { file, url }. The select tool pastes and duplicates with it.
export async function keepAgain(book, v, url) {
  const got = await fetch(url);
  if (!got.ok) throw refused(got.status, 'it couldn’t be read again');
  const blob = await got.blob();
  await ready(book, v);
  return upload(book, v.page.id, blob);
}
// The store keeps the picture as one of the page's: { file, url }. In dev mode it stays in this browser.
let devFiles = 0;
async function upload(book, id, blob) {
  // (in the book open: an invited person's too.)
  if (!book.dev)
    return act(`/api/book/scrap?id=${Number(id)}${book.who ? `&who=${encodeURIComponent(book.who)}` : ''}`, blob);
  if (!IMAGE.test(blob.type)) throw refused(415, 'a JPEG or PNG only');
  const file = `${id}-s-${(++devFiles).toString(16).padStart(8, '0')}.${blob.type === 'image/png' ? 'png' : 'jpg'}`;
  return { file, url: URL.createObjectURL(blob) };
}
// A scrap drawn where it lies (or where it lay), and the table slid to it if the paper doesn't show it
function shown(tape, v, scrap) {
  const box = scrapBoxOf(scrap);
  tape.pages.lay(tape.book);
  v.redraw(box);
  const i = tape.book.views.indexOf(v);
  if (i >= 0) tape.pages.inView(tape.book, i, box);
}
