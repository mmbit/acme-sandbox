// Where a mark lifted off HQ's page lands in the book (review mode's lift.js asks with 'pencil:landing'): open, on the
// page its note went on, turned to first, where the note's snip will show; folded, in its handle, which then shows the
// snip for a moment (book:landed). With a soft paper sound as it goes.
import { foley } from '../audio.js';

// The sheets' notes as their list laid them out (px on the page, till the pin flow lands a scrap instead.): the list's padding at its top and left, a note's
// number column with its gap, the cutting's white border, and the room under a note
const LIST_TOP = 58,
  LIST_LEFT = 12,
  LIST_RIGHT = 22,
  NUMBER = 40,
  CUT = 4,
  NOTE_GAP = 20;
// A snip as review mode cuts it (marks.js): the ink with this much room round it, at least this big
const MARGIN = 24,
  SNIP_MIN = { w: 240, h: 150 };
// Into the handle the ink shrinks to this wide at most (px)
const IN_HANDLE = 34;
// How long a page made for a note may take to be read into the book (ms)
const READ_MS = 4000;

// on: { pages (bookpages.js), lip, the handle's button, paper, layout() (book.js's) }
export function mountLanding({ pages, lip, paper, layout }) {
  const desk = paper.querySelector('.bk-desk'); // (the paper's visible part)
  document.addEventListener('pencil:landing', e => {
    const ask = e.detail,
      mode = layout()?.mode;
    // (paired, the page's screen leaves it to the other's book: the ink drifts off this one, pair.js)
    if (ask.land || !mode || document.documentElement.dataset.paired === 'page') return;
    foley('slide', { dur: 0.5, material: 'paper', size: 0.8 }, { vol: 0.6 });
    if (mode === 'folded') {
      ask.land = inHandle(lip, ask.from);
      const { id, page, snip } = ask;
      ask.arrived = () => document.dispatchEvent(new CustomEvent('book:landed', { detail: { id, page, snip } }));
      return;
    }
    // (a page of the day shows at once, under its turning leaf: bookflip.js swaps it in before the leaf moves)
    if (ask.page && pages.page()?.id !== ask.page) pages.show(ask.page);
    const shown = pages.page()?.id === ask.page;
    ask.land = onPaper(desk, ask.from, shown);
    ask.aim = () => onSnip(desk, ask);
    if (!shown && ask.page) turnWhenRead(pages, layout, ask.page);
  });
}

// A page made for the note is in the book once the day is read again (it may be read twice: the note heard, the page
// made), each read turned to the note's page if it shows another
function turnWhenRead(pages, layout, page) {
  const turn = () => layout()?.mode !== 'folded' && pages.page()?.id !== page && pages.show(page);
  document.addEventListener('book:whose', turn);
  setTimeout(() => document.removeEventListener('book:whose', turn), READ_MS);
}

// The handle's centre-left, where it shows the snip beside it, the ink small
function inHandle(lip, from) {
  const b = lip.getBoundingClientRect(),
    w = Math.min(IN_HANDLE, from.w),
    h = (w / Math.max(from.w, 1)) * from.h;
  return { x: b.left - w / 2, y: b.top + b.height / 2 - h / 2, w, h, handle: true };
}

// Where the note's ink will show on the paper: its snip goes last in the page's open sheet, under its notes (or at the
// list's top when it has none), the ink inside it where it was in the snip. On a page not laid out yet (a new one,
// being read), where a page's first note goes. Kept in the paper's visible part.
function onPaper(desk, from, shown) {
  const page = shown ? desk.querySelector('.bk-world .bk-page:not([hidden])') : null,
    slot = page?.querySelector('[data-slot=notes]'),
    sb = (slot ?? desk).getBoundingClientRect(),
    k = slot?.offsetWidth ? sb.width / slot.offsetWidth : 1,
    list = slot?.querySelector('.bs-list'),
    open = [...(list?.querySelectorAll('.bs-group:not([data-sent])') ?? [])].at(-1),
    last = [...((open ?? list)?.querySelectorAll('.bs-note') ?? [])].at(-1),
    // (the note before's words column, which the new one's snip fills as far as it can)
    body = last?.querySelector('.bs-body')?.getBoundingClientRect(),
    top = last ? last.getBoundingClientRect().bottom + NOTE_GAP * k : sb.top + LIST_TOP * k,
    left = (body?.left ?? sb.left + (LIST_LEFT + NUMBER) * k) + CUT * k;
  const column = body
    ? body.width - 2 * CUT * k
    : ((list?.offsetWidth ?? slot?.offsetWidth ?? sb.width / k) - LIST_LEFT - LIST_RIGHT - NUMBER - 2 * CUT) * k;
  const snip = snipOf(from),
    f = Math.min(k, column / snip.w),
    land = {
      x: left + (from.x - snip.x) * f,
      y: top + CUT * k + (from.y - snip.y) * f,
      w: from.w * f,
      h: from.h * f,
    };
  return within(land, desk.getBoundingClientRect());
}
// Where the ink is on the note's snip once the book has drawn it (and its picture has loaded): turned as the snip is
function onSnip(desk, { id, from }) {
  const note = desk.querySelector(`.bk-world .bk-page:not([hidden]) .bs-note[data-id="${Number(id)}"]`),
    img = note?.querySelector('img.bs-snip'),
    slot = note?.closest('[data-slot=notes]');
  if (!img?.naturalWidth || !slot?.offsetWidth) return null;
  // (its box as laid out, round the middle of its turned one)
  const b = img.getBoundingClientRect(),
    k = slot.getBoundingClientRect().width / slot.offsetWidth,
    w = img.offsetWidth * k,
    h = img.offsetHeight * k,
    left = b.left + b.width / 2 - w / 2,
    top = b.top + b.height / 2 - h / 2,
    snip = snipOf(from);
  const land = {
    x: left + ((from.x - snip.x) / snip.w) * w,
    y: top + ((from.y - snip.y) / snip.h) * h,
    w: (from.w / snip.w) * w,
    h: (from.h / snip.h) * h,
  };
  return {
    ...within(land, desk.getBoundingClientRect()),
    turn: parseFloat(note.style.getPropertyValue('--tilt')) || 0,
  };
}
// The snip review mode cut round the ink: its box on HQ's page
function snipOf(from) {
  const W = document.body.clientWidth,
    H = innerHeight,
    w = Math.min(W, Math.max(SNIP_MIN.w, from.w + 2 * MARGIN)),
    h = Math.min(H, Math.max(SNIP_MIN.h, from.h + 2 * MARGIN));
  return {
    x: Math.min(W - w, Math.max(0, from.x + from.w / 2 - w / 2)),
    y: Math.min(H - h, Math.max(0, from.y + from.h / 2 - h / 2)),
    w,
    h,
  };
}
// A rect moved (and shrunk, if it must) into a box, with a little room at its edges
function within(r, box, pad = 12) {
  const f = Math.min(1, (box.width - 2 * pad) / Math.max(r.w, 1), (box.height - 2 * pad) / Math.max(r.h, 1)),
    w = r.w * f,
    h = r.h * f;
  return {
    x: Math.min(box.right - pad - w, Math.max(box.left + pad, r.x)),
    y: Math.min(box.bottom - pad - h, Math.max(box.top + pad, r.y)),
    w,
    h,
  };
}
