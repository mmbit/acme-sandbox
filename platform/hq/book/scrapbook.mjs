// book-check.mjs's story of the notebook as a scrapbook (the board, call #262; shell/ink/bookscrapopen.js,
// bookunits.js): every page a masonry of scraps that takes no ink, a scrap opened nearly full screen to draw in. On the
// board's iPad mini upright (744 × 1133) and docked beside HQ on its side (about 550 px of paper), with the Pencil and
// fingers in either engine (hands.mjs), an Asks page of six scraps:
//   - the grid lays the scraps in columns: one docked, two upright;
//   - a pen's stroke on the grid, across a card or in a gap, draws nothing and saves nothing;
//   - a pen's tap on a scrap opens it: its sheet with a margin all round, the page bar at the foot hidden, Undo and
//     Redo on the sheet's right; a line drawn there, below what's on it, is the scrap's, and Klaar puts it back, its
//     card grown to show the line and the typed notes under it moved down with their words;
//   - a pen's tap in the gap between two cards makes a new scrap there and opens it (its flight up outrun by its clock,
//     as WebKit's can be: the sheet still full size, never the last scrap's flight down): two lines drawn in it, Undo
//     takes back only its own, never the other scrap's line, even with nothing of its own left, and Redo brings one back;
//   - the iPad turned, the grid reflows and the line stays on its card, on no other.
// Recorded with --shots.
import assert from 'node:assert/strict';
import { MINI, UPRIGHT, QUIET_MS, closeScrap, middleOf, openScrap, say, shotPixels, until } from './kit.mjs';
import { bookWide, noMicrophone, restsOpen, watchedPage } from './start.mjs';
import { hands } from './hands.mjs';
import { SEED } from './unitspage.mjs';
import { sound, still, units } from './unitsread.mjs';
import { PENS } from '../../../shared/review/ink.js';

// the pen in Teal at its widest, a colour none of the seed's pictures has, so its pixels on a card are the line's
const TEAL = PENS.find(p => p.name === 'Teal').color;
const SIZES = {
  'iPad mini upright': { viewport: UPRIGHT, columns: 2 },
  'iPad mini docked beside HQ': { viewport: MINI, book: 560, columns: 1 },
};

// c: book-check.mjs's { hqIn, base, settled, shot, noErrorsIn }
export const scrapbookStories = c =>
  Object.fromEntries(
    Object.entries(SIZES).map(([name, size]) => [
      `the scrapbook on an ${name}: scraps in columns, no ink on the grid, a scrap opened by the pen and drawn in, Klaar, a new scrap in a gap, its own Undo, reflowed with its ink`,
      browser => scrapbook(browser, c, name, size),
    ]),
  );

async function scrapbook(browser, c, name, size) {
  const s = await onTouch(browser, c, size);
  const shot = what => c.shot(`scrapbook-${name.replaceAll(' ', '-')}-${what}`, s.page);
  try {
    const cards = await inColumns(s.page, name, size.columns);
    await shot('grid');
    await noInkOnGrid(s, cards);
    const drawn = await drawnIn(s, shot, cards[0].id);
    const made = await newInGap(s, shot, drawn);
    await reflowed(s, c, shot, name, size, drawn, made);
    c.noErrorsIn(s.errors);
  } catch (e) {
    await shot('failed');
    e.message = `${name}: ${e.message} (page errors: ${s.errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await s.page.context().close();
  }
}

// HQ on a touch screen with a pen at size, the seed's Asks page open in the book, its pen Teal at its widest
async function onTouch(browser, c, { viewport, book }) {
  const context = await c.hqIn(browser, viewport, {
    notebooks: structuredClone(SEED),
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  await noMicrophone(context);
  await bookWide(context, viewport, book);
  await context.addInitScript(teal => {
    localStorage.setItem('hq.book.tools', JSON.stringify({ pen: teal, widths: { pen: 2 } }));
    localStorage.setItem('ink.prefs', JSON.stringify({ penSeen: true, penPans: true }));
  }, TEAL);
  const { page, errors } = await watchedPage(context);
  await page.goto(`${c.base}/?intro=0`);
  await restsOpen(page, c, viewport);
  await until(async () => (await units(page)).length === SEED.groups.length, 'the six scraps on the grid');
  return { page, errors, ...(await hands(page)) };
}

// The store's page: its groups by id, each { ink (strokes), pos }
const groups = page =>
  new Map(
    page
      .context()
      .notebook.route('/api/notebooks/pages/groups', { page: 1 })
      .groups.map(g => [g.id, { ink: g.ink.length, pos: g.pos }]),
  );
const inkOf = (page, id) => groups(page).get(id)?.ink ?? 0;

// The scraps laid in columns (how many at this size), apart and evenly spaced: the cards, top to bottom
async function inColumns(page, name, columns) {
  const cards = await still(page),
    paper = await page.locator('#book .bk-desk').boundingBox(),
    xs = new Set(cards.map(u => Math.round(u.x)));
  console.log(`  ${name}: ${Math.round(paper.width)} px of paper, ${xs.size} columns`);
  assert.equal(xs.size, columns, `${columns} columns on ${Math.round(paper.width)} px of paper`);
  await sound(page, 'the grid');
  return cards.toSorted((a, b) => a.y - b.y || a.x - b.x);
}

// A pen's stroke across a card and one in the gap under it: nothing saved, nothing drawn on the screen, nothing opened
async function noInkOnGrid({ page, pen }, cards) {
  const [a] = cards,
    had = groups(page),
    box = { x: a.x, y: a.y, width: a.w, height: Math.min(a.bottom + 40, page.viewportSize().height) - a.y },
    before = await shotPixels(page, box);
  const [x, y] = [a.x + a.w * 0.25, a.y + a.h / 2];
  await pen.stroke(zigzag([x, y], a.w * 0.5, 30));
  await pen.stroke(zigzag([a.x + a.w * 0.2, a.bottom + 20], a.w * 0.6, 8));
  await page.waitForTimeout(QUIET_MS);
  assert.deepEqual([...groups(page)], [...had], 'a pen stroke on the grid saves nothing');
  assert.equal(await page.locator('#book .bk-pages[data-open]').count(), 0, 'a stroke on the grid opens no scrap');
  const changed = differ(before, await shotPixels(page, box));
  assert.ok(changed < 30, `a pen stroke on the grid draws nothing (${changed} px changed)`);
}

// A pen's tap opens the first scrap: the sheet with a margin, the bar hidden, Undo and Redo on its right; a line drawn
// in it below what's on it is the scrap's, and Klaar puts it back, its card grown to show the line and every typed
// note's words on its own card. The scrap's id
async function drawnIn(s, shot, gid) {
  const { page, pen } = s,
    card = () => page.locator(`#book .bk-unit[data-unit="${gid}"]`).boundingBox(),
    was = await card(),
    before = await shotPixels(page, was),
    others = await othersInk(page, gid);
  const { gid: opened, sheet } = await openScrap(page, pen, gid);
  assert.equal(opened, gid, 'the scrap tapped is the one opened');
  await openLooks(page, sheet);
  await shot('opened');
  await pen.stroke(zigzag([sheet.x + sheet.width * 0.3, sheet.y + sheet.height * 0.8], sheet.width * 0.4, 50));
  await until(() => inkOf(page, gid) === 1, `the line saved in scrap ${gid}`);
  assert.deepEqual(await othersInk(page, gid), others, 'the line is in no other scrap');
  await shot('drawn');
  await closeScrap(page, pen);
  await still(page);
  const now = await card();
  assert.ok(now.height > was.height + 20, `the card grown with the line (${was.height} to ${now.height} px)`);
  // (laid once, by Klaar: nothing else lays the grid again to put them right)
  await typedOnCards(page);
  await until(async () => !(await page.evaluate(barHidden)), 'the page bar back once the scrap is put back');
  assert.ok(tealIn(before) < 10, `no Teal on the card before (${tealIn(before)} px)`);
  await until(async () => tealIn(await shotPixels(page, await card())) > 40, 'the card shows the new line');
  await shot('back');
  return gid;
}
// What the opened scrap looks like: its sheet on the paper with a margin round it, nearly all of it, [data-open]
// on the pages, the page bar at the foot hidden, and Undo and Redo on the sheet's right
async function openLooks(page, sheet) {
  const view = page.viewportSize(),
    book = await page.locator('#book .bk-desk').boundingBox(),
    shown = {
      x: Math.max(book.x, 0),
      y: Math.max(book.y, 0),
      right: Math.min(book.x + book.width, view.width),
      bottom: Math.min(book.y + book.height, view.height),
    },
    said = `sheet ${JSON.stringify(sheet)} in ${JSON.stringify(shown)}`;
  assert.ok(
    sheet.x >= shown.x + 4 &&
      sheet.y >= shown.y + 4 &&
      sheet.x + sheet.width <= shown.right - 4 &&
      sheet.y + sheet.height <= shown.bottom - 4,
    `a margin round the sheet (${said})`,
  );
  assert.ok(
    sheet.width * sheet.height >= 0.6 * (shown.right - shown.x) * (shown.bottom - shown.y),
    `the sheet nearly the whole paper (${said})`,
  );
  assert.equal(await page.locator('#book .bk-pages[data-open]').count(), 1, '[data-open] on the pages');
  await until(() => page.evaluate(barHidden), 'the page bar hidden while the scrap is open');
  for (const key of ['undo', 'redo']) {
    const b = await (await keyOf(page, key))?.boundingBox();
    assert.ok(b, `${say(key)} shown on the opened scrap`);
    assert.ok(b.x > sheet.x + sheet.width / 2, `${say(key)} on the sheet's right (${JSON.stringify(b)}, ${said})`);
  }
}
// (in the page) Whether the page bar (the book's foot: paging, options, the grid's Undo) is out of sight: gone, hidden,
// see-through or off the screen
function barHidden() {
  const bar = document.querySelector('#book .bk-foot');
  if (!bar) return true;
  const r = bar.getBoundingClientRect(),
    look = getComputedStyle(bar);
  return (
    !r.width ||
    look.visibility === 'hidden' ||
    Number(look.opacity) < 0.05 ||
    r.top >= innerHeight ||
    !!bar.closest('[hidden], [inert]')
  );
}
// The opened scrap's Undo or Redo: the one shown, out of the book's foot
async function keyOf(page, key) {
  for (const b of await page
    .locator('#book')
    .getByRole('button', { name: say(key), exact: true })
    .all())
    if ((await b.isVisible()) && !(await b.evaluate(e => !!e.closest('.bk-foot')))) return b;
  return null;
}
const press = async (page, pen, key) => pen.tap(middleOf(await (await keyOf(page, key)).boundingBox()));
// Every other group's strokes: [[id, strokes]]
const othersInk = async (page, gid) => [...groups(page)].filter(([id]) => id !== gid).map(([id, g]) => [id, g.ink]);

// A pen's tap in the gap between two cards of a column makes a new scrap there and opens it: two lines in it, Undo
// three times takes back only its own (the first scrap's line stays), Redo brings one back, Klaar, and it's on the
// grid right after the card above the gap. The new scrap's id
async function newInGap({ page, pen }, shot, drawn) {
  const cards = await still(page),
    column = cards.filter(u => Math.round(u.x) === Math.round(cards[0].x)).toSorted((a, b) => a.y - b.y),
    k = column.findIndex((u, i) => i + 1 < column.length && column[i + 1].y < page.viewportSize().height - 40);
  assert.ok(k >= 0, 'two cards in a column on the screen');
  const [above, below] = [column[k], column[k + 1]],
    had = new Set(groups(page).keys());
  await flightOutrun(page);
  const { gid, sheet } = await openScrap(page, pen, undefined, [above.x + above.w / 2, (above.bottom + below.y) / 2]);
  assert.ok(!had.has(gid), `a new scrap opened, not ${gid} that was there`);
  assert.deepEqual(
    await page.evaluate(() => {
      const flyer = document.querySelector('#book .bk-flyer');
      return { flights: flyer.getAnimations().length, transform: getComputedStyle(flyer).transform };
    }),
    { flights: 0, transform: 'none' },
    "the sheet full size, the first scrap's flight down let go",
  );
  for (const dy of [0.35, 0.6])
    await pen.stroke(zigzag([sheet.x + sheet.width * 0.3, sheet.y + sheet.height * dy], sheet.width * 0.4, 30));
  await until(
    () => inkOf(page, gid) === 2,
    () => `the new scrap ${gid} saved with its two lines (the store: ${JSON.stringify([...groups(page)])})`,
  );
  await shot('new');
  for (const left of [1, 0]) {
    await press(page, pen, 'undo');
    await until(() => inkOf(page, gid) === left, `Undo leaves the new scrap ${left} lines`);
    assert.equal(inkOf(page, drawn), 1, `Undo in the new scrap leaves scrap ${drawn}'s line`);
  }
  if (await (await keyOf(page, 'undo')).isEnabled()) await press(page, pen, 'undo');
  await page.waitForTimeout(QUIET_MS);
  assert.equal(inkOf(page, drawn), 1, `an Undo past the new scrap's own steps leaves scrap ${drawn}'s line`);
  await press(page, pen, 'redo');
  await until(() => inkOf(page, gid) === 1, 'Redo brings a line back to the new scrap');
  await closeScrap(page, pen);
  const order = [...groups(page)].toSorted((a, b) => a[1].pos - b[1].pos).map(([id]) => id);
  assert.equal(order.indexOf(gid), order.indexOf(above.id) + 1, `the new scrap after ${above.id} (${order})`);
  await until(async () => (await units(page)).some(u => u.id === gid), 'the new scrap on the grid');
  await sound(page, 'with the new scrap');
  await shot('new-back');
  return gid;
}

// The iPad turned (upright on its side, docked upright): the grid laid again, and the first scrap's line still on its
// card, on no other card (the new scrap's own line aside)
async function reflowed({ page }, c, shot, name, { viewport }, drawn, made) {
  const was = (await units(page)).find(u => u.id === drawn);
  await page.setViewportSize({ width: viewport.height, height: viewport.width });
  // (headless WebKit tells no resize of its own)
  await page.evaluate(() => dispatchEvent(new Event('resize')));
  await page.waitForTimeout(1500);
  if ((await page.evaluate(() => document.documentElement.dataset.book)) === 'folded') {
    await page.evaluate(() => document.querySelector('#book .bk-lip').click());
    await c.settled(page, 'spread');
  }
  const now = await still(page),
    card = now.find(u => u.id === drawn);
  console.log(`  ${name} turned: ${new Set(now.map(u => Math.round(u.x))).size} columns`);
  assert.ok(
    card && (Math.abs(card.x - was.x) > 2 || Math.abs(card.w - was.w) > 2 || Math.abs(card.y - was.y) > 2),
    `the grid laid again as the iPad turned (${JSON.stringify([was, card])})`,
  );
  await sound(page, 'turned');
  await shot('turned');
  assert.equal(inkOf(page, drawn), 1, `scrap ${drawn} keeps its line`);
  for (const u of now.filter(u => u.y + u.h > 0 && u.y < page.viewportSize().height)) {
    const box = { x: u.x, y: Math.max(u.y, 0), width: u.w, height: Math.min(u.y + u.h, page.viewportSize().height) };
    box.height -= box.y;
    const n = tealIn(await shotPixels(page, box));
    if (u.id === drawn) assert.ok(n > 40, `the line still on scrap ${drawn}'s card (${n} px)`);
    else if (u.id !== made) assert.ok(n < 10, `no line on scrap ${u.id}'s card (${n} px)`);
  }
}

// Every typed note's words on the grid inside its own card
async function typedOnCards(page) {
  const typed = await page.evaluate(() =>
    [...document.querySelectorAll('#book .bk-page:not([hidden]) > .bk-typed')].map(el => {
      const r = el.getBoundingClientRect(),
        card = document
          .querySelector(`#book .bk-page:not([hidden]) .bk-unit[data-unit="${el.typed.g}"]`)
          ?.getBoundingClientRect();
      return { g: el.typed.g, y: r.top + r.height / 2, card: card && { top: card.top, bottom: card.bottom } };
    }),
  );
  assert.ok(typed.length, 'typed notes on the grid');
  for (const { g, y, card } of typed)
    assert.ok(
      card && y > card.top && y < card.bottom,
      `note ${g}'s words on its own card (${JSON.stringify({ y, card })})`,
    );
}
// The flyer's next flight slowed past its clock (FLY_MS + 40 from its start), so the clock ends it first, as WebKit's
// late finished can.
const flightOutrun = page =>
  page.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const flight = animate.apply(this, args);
      if (this.classList.contains('bk-flyer')) {
        flight.playbackRate = 0.3;
        Element.prototype.animate = animate;
      }
      return flight;
    };
  });
// A hand's zigzag from a point w px across, dy px up and down, as a Pencil samples it
const zigzag = ([x, y], w, dy) =>
  Array.from({ length: 25 }, (_, i) => [x + (w * i) / 24, y + dy * Math.sin((i * Math.PI) / 3)]);
// How many pixels of two shots of the same box differ
function differ(a, b) {
  let n = 0;
  for (let i = 0; i < Math.min(a.data.length, b.data.length); i += 4)
    if (
      Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]) >
      60
    )
      n++;
  return n;
}
// How many pixels of a shot are the Teal pen's
function tealIn({ data }) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(TEAL.slice(i, i + 2), 16));
  let n = 0;
  for (let i = 0; i < data.length; i += 4)
    if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) < 60) n++;
  return n;
}
