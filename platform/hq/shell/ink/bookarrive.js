// Things arriving on a Notebook page (a scrap, a note, a picture, words put on it), from the store or from this screen,
// set down on it with bookpaper.js's land(): held off the page while a copy of them comes down onto their place, then
// drawn there as the copy goes.
import { LAND_MS, land } from './bookpaper.js';
import { thingsPicture } from './bookpaperdraw.js';
import { boundsOf } from './bookselectmath.js';
import { keyOf, landing } from './bookgroupmath.js';
import { bringIntoSight } from './bookgroupshow.js';
import { isCanvas } from './sketchcanvas.js';
import { fitted } from './bookunits.js';
import { PAD } from './booktexts.js';
import { picture } from '../../util.js';

// each group arriving at once lands this long after the one before (ms); a picture not loaded within LOAD_MS lands
// as the page would draw it then
const STAGGER_MS = 90,
  LOAD_MS = 1500;
// a line of typed words on the page (booktexts.js TEXT: 18 px at 1.4)
const LINE_PX = 26;
// the board's hands off the page this long (ms, no finger or pen down, none moved or key pressed since): what an agent
// puts on the page is slid into sight before it lands
const IDLE_MS = 3000;

// The board's hands on the screen: the pointers down, and when it last pressed, moved one down or typed (ms: -Infinity
// till then, so a page just opened is idle)
const hands = { down: new Set(), at: -Infinity };
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'wheel'])
  addEventListener(
    type,
    e => {
      if (type === 'pointerdown') hands.down.add(e.pointerId);
      if (type === 'pointerup' || type === 'pointercancel') hands.down.delete(e.pointerId);
      if (type !== 'pointermove' || e.buttons) hands.at = performance.now();
    },
    { capture: true, passive: true },
  );
const idle = () => !hands.down.size && performance.now() - hands.at > IDLE_MS;

// Elements just put on a view's page (its ink, scraps and texts), landed group by group. Off the paper shown, or with
// the book out of sight, they're simply there; with show (an agent's, from the store) on a page the board has left
// idle, the paper first slides to the last of them so the board sees it land (never while it
// draws). What's held is held by its key (page.landing: bookgroupmath.js landing()), so the page read again meanwhile
// holds its new copy of it too.
export function arrive(book, view, els, { show = false } = {}) {
  if (book.away || view.el.hidden || !els.length) return;
  const page = view.page,
    groups = new Map();
  page.landing ??= new Set();
  for (const el of els) {
    page.landing.add(keyOf(el));
    groups.set(el.g, [...(groups.get(el.g) ?? []), el]);
  }
  const all = () => [...groups.values()].forEach((group, i) => landGroup(book, view, group, i * STAGGER_MS));
  view.redraw(); // (held off the tiles and their words' boxes hidden, in the same task they were drawn in)
  showWords(view);
  // (their words and answers unseen while the paper slides: bookgroupshow.js bringIntoSight; a hand that stops it on
  // the way, a finger's scroll, sees them all at once where they are)
  const last = [...groups.keys()].at(-1),
    unseen = [...groups.keys()].flatMap(g => bitsOf(view, g)).map(el => el.animate({ opacity: [0, 0] }, 5000)),
    landed = () => {
      all();
      unseen.forEach(a => a.cancel());
    },
    there = () => {
      unseen.forEach(a => a.cancel());
      for (const el of els) page.landing.delete(keyOf(el));
      view.redraw();
      showWords(view);
    };
  if (!(show && idle() && book.views[book.cur] === view && bringIntoSight(view, last, landed, there))) landed();
}

// A face or an answer an agent hangs by a note on a view's opened scrap, just drawn (bookgroups.js): on a page the board
// has left idle, the paper slid to the note with it, as to what lands on one: hung beside its note, it's often past the
// paper's edge. What hangs under each group is kept on the view to tell what's come since
export function hung(book, view) {
  const was = view.hanging;
  view.hanging = new Map([...(view.page.groups?.values() ?? [])].map(g => [g.id, hangingOf(g)]));
  // (isCanvas takes the page)
  if (!was || !isCanvas(view.page) || !idle() || book.views[book.cur] !== view) return;
  const come = [...view.hanging].filter(
    ([id, now]) => (now.waiting && !was.get(id)?.waiting) || now.answers > (was.get(id)?.answers ?? 0),
  );
  if (come.length) bringIntoSight(view, come.at(-1)[0]);
}
// (what an agent hangs under a group: its face while an answer comes, and how many answers)
const hangingOf = g => ({ waiting: !!g.waiting, answers: (g.children ?? []).filter(c => c.kind !== 'reply').length });

async function landGroup(book, view, els, delay) {
  const page = view.page,
    things = {
      ink: els.filter(el => page.ink.includes(el)),
      scraps: els.filter(el => page.scraps.includes(el)),
      texts: els.filter(el => page.texts?.includes(el)),
    };
  // (its clip, words and answers on the groups' layer unseen till it comes down, then up as it presses on)
  const bits = bitsOf(view, els[0].g),
    unseen = bits.map(el => el.animate({ opacity: [0, 0] }, LOAD_MS + delay + LAND_MS));
  await loaded(things.scraps);
  unseen.forEach(a => a.cancel());
  for (const el of bits)
    el.animate({ opacity: [0, 0, 1], offset: [0, 0.55, 1] }, { duration: LAND_MS, delay, fill: 'backwards' });
  const extent = boundsOf(things, t => wordsBox(view, t)),
    // (on its card as the grid shows it.)
    fit = fitted(page, els[0].g),
    card = fit && { fit, o: page.origins.get(els[0].g) };
  if (extent && !book.away && !view.el.hidden)
    await land(...thingsPicture(view, things, extent, book.scale, card), delay);
  for (const el of els) page.landing.delete(keyOf(el));
  if (extent) view.redraw(extent);
  showWords(view);
}
const bitsOf = (view, g) =>
  g === undefined ? [] : [...view.el.querySelectorAll(`:scope > .bk-groups > [data-g="${g}"]`)];
// (the page's pictures are loaded once, by address: the copy and the page draw the same one)
async function loaded(scraps) {
  const wait = new Promise(done => setTimeout(done, LOAD_MS)),
    pictures = scraps.map(s => (s.img ?? picture(s.url)).decode().catch(() => {}));
  await Promise.race([Promise.all(pictures), wait]);
}
// A box of words in the page's own px (as setBox lays it, before a fitted card shrinks it: thingsPicture fits it to
// the card): its box's size at its place, or one line there before it has one.
function wordsBox(view, t) {
  const box = [...view.el.querySelectorAll(':scope > .bk-typed')].find(b => keyOf(b.typed) === keyOf(t));
  if (!box) return { x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + LINE_PX };
  const [x0, y0] = [t.x - PAD, t.y - PAD];
  return { x0, y0, x1: x0 + box.offsetWidth, y1: y0 + box.offsetHeight };
}
// The page's boxes of words shown, but those landing (booktexts.js hides one made meanwhile)
const showWords = view => {
  for (const box of view.el.querySelectorAll(':scope > .bk-typed'))
    box.classList.toggle('bk-landing', landing(view.page, box.typed));
};
