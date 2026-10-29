// Things arriving on a Notebook page (a scrap, a note, a picture, words put on it), from the store or from this screen,
// set down on it with bookpaper.js's land(): held off the page while a copy of them comes down onto their place, then
// drawn there as the copy goes.
import { LAND_MS, land } from './bookpaper.js';
import { thingsPicture } from './bookpaperdraw.js';
import { boundsOf } from './bookselectmath.js';
import { keyOf, landing } from './bookgroupmath.js';
import { picture } from '../../util.js';

// each group arriving at once lands this long after the one before (ms); a picture not loaded within LOAD_MS lands
// as the page would draw it then
const STAGGER_MS = 90,
  LOAD_MS = 1500;
// a line of typed words on the page (booktexts.js TEXT: 18 px at 1.4)
const LINE_PX = 26;

// Elements just put on a view's page (its ink, scraps and texts), landed group by group. Off the paper shown, or with
// the book out of sight, they're simply there. What's held is held by its key (page.landing: bookgroupmath.js
// landing()), so the page read again meanwhile holds its new copy of it too.
export function arrive(book, view, els) {
  if (book.away || view.el.hidden || !els.length) return;
  const page = view.page,
    groups = new Map();
  page.landing ??= new Set();
  for (const el of els) {
    page.landing.add(keyOf(el));
    groups.set(el.g, [...(groups.get(el.g) ?? []), el]);
  }
  [...groups.values()].forEach((group, i) => landGroup(book, view, group, i * STAGGER_MS));
  view.redraw(); // (held off the tiles and their words' boxes hidden, in the same task they were drawn in)
  showWords(view);
}

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
  const extent = boundsOf(things, t => wordsBox(view, t));
  if (extent && !book.away && !view.el.hidden) await land(...thingsPicture(view, things, extent, book.scale), delay);
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
// A box of words as the page shows it (page px): its box's, or one line at its place before it has one
function wordsBox(view, t) {
  const box = [...view.el.querySelectorAll(':scope > .bk-typed')].find(b => keyOf(b.typed) === keyOf(t));
  if (!box) return { x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + LINE_PX };
  return {
    x0: box.offsetLeft,
    y0: box.offsetTop,
    x1: box.offsetLeft + box.offsetWidth,
    y1: box.offsetTop + box.offsetHeight,
  };
}
// The page's boxes of words shown, but those landing (booktexts.js hides one made meanwhile)
const showWords = view => {
  for (const box of view.el.querySelectorAll(':scope > .bk-typed'))
    box.classList.toggle('bk-landing', landing(view.page, box.typed));
};
