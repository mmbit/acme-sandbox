// What lands in the book from outside: pictures, words and links pasted with Cmd/Ctrl+V while the book is open, dropped
// on its paper (files, or an <img>, a link or words dragged from another tab or app), pasted from Select's Paste bubble a
// tap on bare paper brings (bookselectpaste.js, which reads the clipboard: book.tape.fromClipboard), or carried in from
// HQ's page (a ring the Pencil drew, lifted by a finger: shared/review/carry.js, heard as 'book:tape' events).
// bookbrought.js reads what came. A picture lands a touch askew in a white border with a strip of tape
// (bookscrapdraw.js drawScrap, as bookpage.js draws a page's scraps); one at an address on another site comes through
// the coordinator (bookfetch.ts).
// Words land in a box at a readable width (booktexts.js put), a link as its picture when it is one, else as its words.
// Files of another kind are refused, saying so. Each landing is one step Undo takes back.
//
// Where it lands: pasted, on the page in view, or under the point when dropped or tapped (the notebook's current page
// when that page has been sent); carried, on the current page. Words with no point land as a voice note's do, under the
// line drawn last where it's in sight (landing()).
// (words, links and pictures by address, and bookbrought.js reading what came)
import { refused } from '../data.js';
import { scopedUrl } from './bookscope.js';
import { stylesheet } from '../../util.js';
import { sfx } from '../audio.js';
import { keepPicture } from './notebookdata.js';
import { changed, said, shut } from './booksave.js';
import { grownTo, pageBox, scrapBoxOf } from './bookrow.js';
import { shrink } from './bookscrapdraw.js';
import { placeScrap } from './bookscrap.js';
import { newId } from './bookedit.js';
import { arrive } from './bookarrive.js';
import { downToClear } from './bookwords.js';
import * as brought from './bookbrought.js';

const IMAGE = /^image\//;
// words landed keep this far inside the paper shown (page px)
const EDGE = 24;

// book: bookpages.js's; paper: the book's paper. pages: bookpages.js's own, each given the book: { lay(book) (the pages
// laid out again), inView(book, i, box) (the table slides to show a box on page i), current(book) (the notebook's
// current page, read: { v, i }, a promise) }
export function mountTape(book, paper, pages) {
  stylesheet('shell/ink/booktape.css');
  const tape = { book, paper, pages };
  // (on the window: after the document's own, so a paste the select tool took for its clip stays its own)
  addEventListener('paste', e => pasted(tape, e));
  paper.addEventListener('dragover', e => {
    if (!brought.takes(e.dataTransfer) || theirs(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  paper.addEventListener('drop', e => {
    if (!brought.takes(e.dataTransfer) || theirs(e)) return;
    e.preventDefault();
    land(tape, brought.whatCame(brought.carried(e.dataTransfer)), { at: [e.clientX, e.clientY] });
  });
  document.addEventListener('book:tape', e => carried(tape, e));
  // (what the clipboard held, read for Select's Paste bubble, landed at a point on screen: bookselectpaste.js; and a
  // voice note's words, at a point on a page where it has one ({ view, x, y }, book.at's): bookvoice.js)
  book.tape = {
    fromClipboard: (got, at) => fromClipboard(tape, got, at),
    words: (words, point = null) => wordsIn(tape, words, { point, voice: true }),
  };
}

// ---- the ways in

const open = () => ['open', 'spread'].includes(document.documentElement.dataset.book);
// (a paste or a drop into a field, a box of words being typed in, or review mode's note, is theirs)
const theirs = e => {
  const target = e.composedPath()[0];
  return target instanceof Element && !!target.closest('input, textarea, [contenteditable], review-mode');
};
// Cmd/Ctrl+V with the book open: what the clipboard holds, on the page in view. One while the board is in a call's
// window is the call's (calldrop.js).
function pasted(tape, e) {
  if (!open() || theirs(e) || e.defaultPrevented || tape.book.calls?.pasteForCall()) return;
  const came = brought.whatCame(brought.carried(e.clipboardData));
  if (!came) return;
  e.preventDefault();
  land(tape, came, {});
}

// What the clipboard held (bookbrought.js clipboard), landed at [x, y] on screen
function fromClipboard(tape, got, at) {
  const came = brought.whatCame(got);
  if (!came)
    return tell(
      tape,
      onPage(tape.book, { clientX: at[0], clientY: at[1] }),
      'Nothing to paste: copy a picture or some words first.',
    );
  land(tape, came, { at });
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

// ---- landing

// What came (bookbrought.js whatCame), landed at a point on screen or on the page in view: pictures taped, a picture
// at an address fetched and taped, a link as its picture when it is one and else as its words, words in a box, a
// refusal said
async function land(tape, came, { at = null }) {
  if (!came) return;
  const i = at ? onPage(tape.book, { clientX: at[0], clientY: at[1] }) : -1;
  if (came.refused) return tell(tape, i, came.refused);
  if (came.pictures) return came.pictures.forEach((f, n) => tapeIn(tape, f, { at, i: n }));
  if (came.words && !came.link) return wordsIn(tape, came.words, { at });
  try {
    await tapeIn(tape, await pictureAt(came.picture ?? came.link), { at });
  } catch (err) {
    // (a link to a page, not a picture, is still a link: its words. A picture that didn't come, or one HQ can't draw,
    // says why)
    if (came.link && err.page) return wordsIn(tape, came.words, { at });
    tell(tape, i, `That picture didn’t come: ${err.message}`);
  }
}
// A picture's file from its address: a data: or blob: one and HQ's own read here, another site's through the
// coordinator (bookfetch.ts), since that site's CORS keeps HQ's page from reading it
async function pictureAt(url) {
  const here = /^(data|blob):/.test(url) || new URL(url, location.href).origin === location.origin;
  const got = await fetch(here ? url : scopedUrl(`/api/book/fetch?url=${encodeURIComponent(url)}`), {
    credentials: 'same-origin',
  }).catch(() => null);
  if (!got) throw refused(0, 'it couldn’t be reached');
  if (!got.ok) {
    const why = await got.json().catch(() => null);
    throw Object.assign(refused(got.status, why?.error ?? `error ${got.status}`), { page: why?.page === true });
  }
  const blob = await got.blob();
  if (!IMAGE.test(blob.type))
    throw Object.assign(refused(415, 'that address is a page, not a picture'), { page: true });
  return blob;
}

// Words onto the book in boxes (booktexts.js put), where landing() puts them on the page pageFor finds, wrapping at a
// readable width and kept inside the paper shown. One step Undo takes back. A voice note's words land here too
// (bookvoice.js, book.tape.words), on a slip of their own (voice). at: [x, y] on screen; point: { view, x, y }, a point
// on a view's page, the words starting there (a voice note held at it: bookinput.js).
async function wordsIn(tape, words, { at = null, point = null, voice = false }) {
  const { book } = tape;
  const found = point ? { v: point.view } : await pageFor(tape, { at });
  if (!found.v || !book.tools) return;
  const { v } = found,
    page = v.page;
  try {
    await ready(book, v);
    const k = book.views.indexOf(v);
    if (k < 0) return; // (the book went to another notebook meanwhile)
    // (a voice note's words start where it was held)
    const hit = found.at && book.at(at[0], at[1]),
      view = k === book.cur ? book.shown() : pageBox(page),
      spot = point ? { x: point.x, y: point.y, centre: false } : landing(v, view, hit?.i === k ? [hit.x, hit.y] : null);
    // (a voice note's shown there as they were heard: bookheard.js)
    const texts = book.tools.put({ view: v, x: spot.x, y: spot.y }, words, {
      centre: spot.centre,
      there: !!point,
      voice,
    });
    if (!texts.length) return;
    // (moved as one inside the paper shown, its first line never above it, and in the middle, below what's there
    // already)
    const left = texts[0].x,
      right = left + texts[0].w,
      dx = Math.max(view.x0 + EDGE - left, Math.min(0, view.x1 - EDGE - right)),
      down = Math.max(0, view.y0 + EDGE - texts[0].y),
      dy = down + (hit || !spot.centre ? 0 : below(v, texts, [dx, down]));
    if (dx || dy) {
      texts.forEach(t => Object.assign(t, { x: round(t.x + dx), y: round(t.y + dy) }));
      book.tools.added(v);
      changed(book, page);
    }
    // (a page grows to hold words landed past its edge, as it does a picture: bookselect.js)
    const grown = grownTo(page, stackOf(v, texts));
    if (grown.w !== page.w || grown.h !== page.h || grown.x !== page.x || grown.y !== page.y) {
      Object.assign(page, grown);
      tape.pages.lay(book);
      changed(book, page);
    }
    sfx.land();
    tape.pages.inView(book, k, { x0: texts[0].x, y0: texts[0].y, x1: texts[0].x + texts[0].w, y1: texts[0].y + EDGE });
  } catch (e) {
    said(book, page, `Those words didn’t stay: ${e.message}`);
  }
}
// Where words land on a view's page, of which the paper shows box (page px): their middle on a point given (dropped or
// tapped); else into the scrap of the line drawn last, under it from where it starts on the left (a point of its own, so
// the scrap is its: bookunits.js pointUnit) where that start is in sight, so the Pencil pastes or dictates right after
// scribbling; else their middle a little above the middle of box. { x, y, centre }
function landing(v, box, point) {
  if (point) return { x: point[0], y: point[1], centre: true };
  const start = (v.page.ink.at(-1)?.points ?? []).reduce((a, p) => (!a || p[0] < a[0] ? p : a), null);
  if (start && start[0] >= box.x0 && start[0] <= box.x1 && start[1] >= box.y0 && start[1] <= box.y1)
    return { x: start[0], y: start[1], centre: false };
  return { x: (box.x0 + box.x1) / 2, y: box.y0 + (box.y1 - box.y0) * 0.4, centre: true };
}
// How far words just put on a view's page, moved by [dx, dy], must move down to clear its other boxes of words and
// its pictures and send stamp.
function below(v, texts, [dx, dy]) {
  const mine = stackOf(v, texts),
    stamp = v.el.querySelector(':scope > .bk-send-stamp'),
    others = [...v.el.querySelectorAll(':scope > .bk-typed')].filter(el => !texts.includes(el.typed));
  const stack = { x0: mine.x0 + dx, y0: mine.y0 + dy, x1: mine.x1 + dx, y1: mine.y1 + dy };
  return downToClear(
    stack,
    [...[...others, ...(stamp ? [stamp] : [])].map(edges), ...v.page.scraps.map(scrapBoxOf)],
    EDGE,
  );
}
// The box words just put on a view's page take on it, as their boxes show (page px)
function stackOf(v, texts) {
  const mine = [...v.el.querySelectorAll(':scope > .bk-typed')].filter(el => texts.includes(el.typed)).map(edges);
  return { x0: mine[0].x0, y0: mine[0].y0, x1: Math.max(...mine.map(b => b.x1)), y1: mine.at(-1).y1 };
}
const edges = el => ({
  x0: el.offsetLeft,
  y0: el.offsetTop,
  x1: el.offsetLeft + el.offsetWidth,
  y1: el.offsetTop + el.offsetHeight,
});
const round = n => Math.round(n * 100) / 100;

// ---- taping

// The page under a point on screen, or -1 (book.at: the page shown, off the paper null.)
const onPage = (book, e) => book.at(e.clientX, e.clientY)?.i ?? -1;
// Words said on the page in view (or the one asked for)
function tell(tape, i, words) {
  const { book } = tape,
    v = book.views[i >= 0 ? i : book.cur];
  if (v) said(book, v.page, words);
}

// The page a picture goes on: the page under the point, else the one in view, while it's open; carried in from HQ's
// page, or onto a sent page, the notebook's current page (the newest open one).
async function pageFor(tape, { at, today }) {
  const { book } = tape;
  const i = at ? onPage(book, { clientX: at[0], clientY: at[1] }) : book.cur,
    v = book.views[i];
  if (v && !today && !shut(v.page)) return { v, at: !!at };
  return { v: (await tape.pages.current(book)).v, at: false };
}

// A picture file onto the book: drawn smaller (bookscrapdraw.js shrink, at most 2,000 px a side), kept by the store on
// its page, placed, drawn, saved, and a step Undo takes back. at: [x, y] on screen. i: its place among several.
// today: carried, so the notebook's current page.
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
    if (k < 0) return; // (the book went to another notebook meanwhile)
    // (the spot on the page, and the part of it the paper shows: its top when it isn't the page shown.)
    const point = found.at && book.at(at[0], at[1]),
      spot = point?.i === k ? [point.x, point.y] : null,
      view = k === book.cur ? book.shown() : pageBox(page);
    const scrap = {
      id: newId(), // (its own: bookedit.js)
      file: kept.file,
      url: kept.url,
      ...placeScrap({ nw: small.w, nh: small.h }, page, { at: spot, view, i }),
    };
    page.scraps.push(scrap);
    shown(tape, v, scrap);
    arrive(book, v, [scrap]);
    book.tools?.taped(v, scrap);
    sfx.land();
    changed(book, page);
    book.steps.push({
      page,
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
// The page's groups read, so what lands joins what's there
async function ready(book, v) {
  await v.reading;
  if (!v.page.ink) throw refused(0, 'this page couldn’t be read. Try again.');
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
// The store keeps the picture for a group on the page: { file, url }. In dev mode it stays in this browser.
const upload = (book, id, blob) => keepPicture(book.dev, id, blob);
// A scrap drawn where it lies (or where it lay), and the table slid to it if the paper doesn't show it
function shown(tape, v, scrap) {
  const box = scrapBoxOf(scrap);
  tape.pages.lay(tape.book);
  v.redraw(box);
  const i = tape.book.views.indexOf(v);
  if (i >= 0) tape.pages.inView(tape.book, i, box);
}
