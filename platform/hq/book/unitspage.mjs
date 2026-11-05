// book-check.mjs's story of a notebook page as a masonry of scrap units (shell/ink/bookunits.js), on an Asks page
// seeded with an agent's six scraps of mixed heights (pictures with words, plain notes, one with an answer under it).
// First the same scraps on a sketch page, a masonry too, the page's day in the board's English. At a phone, an iPad mini
// upright and sideways, and a wide desktop. Each time: no two units (with what hangs under them) overlap, the space
// between units in a column is the same, nothing scrolls sideways, and the last unit scrolls clear of the tools. Each
// note's paper is the whole card: no room or handle under it, the card itself no shadow, edge or turned corner (a scrap
// is opened to be drawn in: scrapbook.mjs). The wide desktop is then made narrower and opened again, laid in fewer
// columns. Recorded with --shots.
import assert from 'node:assert/strict';
import { atEverySize } from './kit.mjs';
import { bookWide, noMicrophone, watchedPage } from './start.mjs';
import { BOOK } from '../shell/ink/booklayout.js';
import { typedBoxes } from '../shell/ink/notebookparts.js';
import { opened, sound, still, units } from './unitsread.mjs';

const T0 = '2026-10-29T15:00:00.000Z';
const SIZES = {
  phone: { width: 390, height: 844 },
  'ipad-mini-upright': { width: 744, height: 1133 },
  'ipad-mini-sideways': { width: 1133, height: 744 },
  'desktop-narrow': { width: 1920, height: 1080, book: BOOK.min },
  // (then a narrower window, its page laid again in fewer columns)
  'desktop-wide': { width: 1920, height: 1080, book: 1500, turned: { width: 1133, height: 744 } },
};
// the agent's scraps, each a unit in its own px (scrapunit.js UNIT_W 320 wide, ROOM 96 under its body)
const picture = (file, h) => ({ file, x: 0, y: 0, w: 320, h, tilt: 0 });
const scrap = (id, kind, pictures, words, h) => ({
  id,
  page: 1,
  kind,
  by: 'moss',
  owner_name: 'Moss',
  ink: [],
  texts: [],
  pictures,
  words,
  said: 'typed',
  status: 'open',
  created: T0,
  updated: T0,
  pos: id,
  h,
});
// a promise handed off on the call: its words typed on a small scrap, as the store makes a note
const note = (id, words) => {
  const texts = typedBoxes(words, { x: 0, w: 320, color: '#1d1a2f' });
  return { ...scrap(id, 'note', [], '', 96), texts, h: 40 + 96 };
};
export const SEED = {
  notebooks: [{ id: 1, kind: 'mine', name: 'My journal', archived: false, created: T0, updated: T0 }],
  pages: [
    // (an Asks page: a masonry the board draws on, README A page of scrap units.)
    { id: 1, notebook: 1, pos: 0, kind: 'asks', label: 'Asks', created: T0, updated: T0, w: 1200, h: 1600 },
  ],
  groups: [
    scrap(1, 'scrap', [picture('book-snip-1.svg', 137)], 'The masthead, warmer: the hand-lettered face.', 137 + 96),
    scrap(2, 'scrap', [picture('review-shot.svg', 208)], 'Your circle on the shelf.', 208 + 96),
    note(3, 'Promise: the print file by Friday.'),
    scrap(4, 'scrap', [picture('book-snip-2.svg', 187)], 'The ochre, softened.', 187 + 96),
    note(5, 'Promise: two more covers to choose from.'),
    scrap(6, 'scrap', [picture('book-snip-1.svg', 137)], 'Which one goes to print?', 137 + 96),
  ],
  slips: [
    {
      id: 1,
      note: 4,
      by: 'moss',
      name: 'Moss',
      text: 'Softer it is: I took the ochre down a step and warmed the paper.',
      picture: null,
      link: null,
      preview: null,
      now: null,
      now_at: null,
      created: T0,
      ticked: null,
    },
  ],
  asks: [],
  names: { moss: 'Moss' },
};

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function unitsPageStories(c) {
  return {
    "a page of scrap units: an agent's six scraps, whole cards with no room under them, at a phone, an iPad mini both ways and a desktop, never overlapping":
      atEverySize(SIZES, (browser, name, size) => atSize(browser, c, name, size)),
  };
}

async function atSize(browser, c, name, size) {
  await onSketch(browser, c, name, size);
  const context = await deskAt(browser, c, size);
  const { page, errors } = await watchedPage(context);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await opened(page, 6);
    await page.waitForTimeout(400);
    await sound(page, `${name}, as the agent left it`);
    await wholePapers(page, name);
    await c.shot(`units-${name}-1-call`, page);
    await atFoot(page, c, name);
    if (size.turned) await turned(page, c, name, size.turned, errors);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`units-${name}-failed`, page);
    e.message = `${name}: ${e.message} (page errors: ${errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await context.close();
  }
}
// The same scraps arriving on a sketch page (My journal's, a grid like every page): each clear of the one under it once
// its words are measured (bookunits.js), the view's day in the board's English.
async function onSketch(browser, c, name, size) {
  const sketch = { ...SEED, pages: SEED.pages.map(p => ({ ...p, kind: undefined, label: 'Cover notes' })) },
    context = await deskAt(browser, c, size, sketch),
    { page, errors } = await watchedPage(context);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await opened(page, 6);
    await page.waitForTimeout(400);
    await sound(page, `${name}, on a sketch page`);
    await boardDays(page, name);
    await c.shot(`units-${name}-0-sketch`, page);
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}
// The board's page days in its English with no comma, "Sat 31 Oct", in WebKit too, whose en-GB writes "Sat, 31 Oct"
async function boardDays(page, name) {
  // (the view's day under the title, and the page's dates between days.)
  const days = await page.evaluate(() =>
    [...document.querySelectorAll('#book :is(.bk-day, .bk-view-day:not([hidden]))')].map(d => d.textContent),
  );
  assert.ok(days.length, `${name}: the book shows a page day`);
  for (const day of days) assert.match(day, /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/, `${name}: the board's page day`);
}
// Each unit bare (no paper, shadow, clip or turned corner of its own), its note's paper the whole card, with no room or
// handle under it
async function wholePapers(page, name) {
  const seen = await page.evaluate(() =>
    [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-unit')].map(u => {
      const [look, after] = [getComputedStyle(u), getComputedStyle(u, '::after')],
        card = u.getBoundingClientRect(),
        paper = u.querySelector(':scope > .bk-unit-paper').getBoundingClientRect();
      return {
        unit: u.dataset.unit,
        bare: [look.boxShadow, look.backgroundImage, look.backgroundColor, look.clipPath, after.content],
        rooms: u.querySelectorAll('.bk-room, .bk-room-handle').length,
        paperEnds: Math.round(card.bottom - paper.bottom),
      };
    }),
  );
  assert.equal(seen.length, 6, `${name}: the six units`);
  const clear = 'rgba(0, 0, 0, 0)';
  for (const u of seen) {
    const what = `${name}: unit ${u.unit} (${JSON.stringify(u)})`;
    assert.deepEqual(u.bare, ['none', 'none', clear, 'none', 'none'], `${what}: no paper, shadow, clip or corner`);
    assert.equal(u.rooms, 0, `${what}: no room or handle under it`);
    assert.ok(Math.abs(u.paperEnds) <= 1, `${what}: its note's paper the whole card`);
  }
}
// The page turned to another size and opened again from the store: laid in another number of columns
async function turned(page, c, name, size, errors) {
  const columns = async () => new Set((await units(page)).map(u => Math.round(u.x))).size,
    were = await columns(),
    n = (await units(page)).length;
  await page.setViewportSize(size);
  const before = errors.length;
  await page.reload();
  await opened(page, n);
  // (WebKit tells the requests a reload cut off, HQ's events and the like, as refused: not the page's.
  errors.splice(before, Infinity, ...errors.slice(before).filter(e => !/due to access control checks/.test(e)));
  await still(page);
  assert.notEqual(await columns(), were, `${name}: turned, the page laid in another number of columns`);
  await sound(page, `${name}, turned`);
  await c.shot(`units-${name}-4-turned`, page);
}
// HQ at a size on a seed (the story's own by default), a mouse's desk: its notebook as narrow or wide as the board
// dragged it (booklayout.js keep).
export async function deskAt(browser, c, size, seed = SEED) {
  const { width, height, book } = size,
    viewport = { width, height },
    context = await c.hqIn(browser, viewport, { notebooks: structuredClone(seed), hasTouch: false, isMobile: false });
  await noMicrophone(context);
  await bookWide(context, viewport, book);
  return context;
}
// Scrolled to its foot: the last unit up on the page, and every unit clear of the tools
async function atFoot(page, c, name) {
  // (over the notebook's paper: beside HQ, the screen's middle is HQ's)
  const desk = await page.locator('#book .bk-desk').boundingBox();
  await page.mouse.move(desk.x + desk.width / 2, desk.y + desk.height / 2);
  for (let k = 0; k < 12; k++) await page.mouse.wheel(0, 600);
  await page.waitForTimeout(500);
  await c.shot(`units-${name}-3-foot`, page);
  // (what's written ends left of the tools' island, the paper running on under it with nothing laid there, and the last
  // unit scrolls up into the paper's view.)
  const foot = await page.evaluate(() => {
    const tools = document.querySelector('#book .bk-strip').getBoundingClientRect(),
      el = document.querySelector('#book .bk-desk'),
      desk = el.getBoundingClientRect(),
      all = [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-unit')].map(u => u.getBoundingClientRect());
    return {
      last: Math.max(...all.map(u => u.bottom)),
      right: Math.max(...all.map(u => u.right)),
      desk: { bottom: desk.bottom, right: desk.right - parseFloat(getComputedStyle(el).paddingRight) },
      tools: tools.left,
    };
  });
  const clear = foot.desk.right <= foot.tools + 1 && foot.right <= foot.tools + 1 && foot.last <= foot.desk.bottom + 1;
  assert.ok(clear, `${name}: the last unit clear of the tools (${JSON.stringify(foot)})`);
}
