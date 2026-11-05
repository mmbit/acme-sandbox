// book-check.mjs's story of the page's title on the view (the Ink README, "The book's frame": the title on the view;
// shell/ink/bookviewhead.js, bookcontrols.js, booktitle.js), in Slate by day and by night, Brownstone and Holo, on an
// iPhone (its home-screen app's blur at the top), an iPad mini upright and on its side, and a desktop. A page of
// scraps over three days, long enough to scroll, and a sketch page with a drawing:
//   - the title sits at the content's top left, below the blur, with the day of the topmost scrap on screen under it;
//     panned down to the second day's scraps and zoomed in, it stays put and the same size, and its day follows what's
//     at the top; nothing on the page is a title, and there's no pencil;
//   - on the sketch page it shows the page's title and its drawing's date;
//   - Rename page, first of the page's rows in the dots menu (no Close notebook there), writes the title where it
//     shows, saved by Enter;
//   - the page list from the bar's count has no title line or pencil of its own, its page numbers read at 4.5:1 or
//     more on the card.
// Recorded with --shots.
import assert from 'node:assert/strict';
import { LOOK_SCHEMES, toChapter, until } from './kit.mjs';
import { blurred } from './islands.mjs';
import { restsOpen } from './start.mjs';
import { contrastChannels } from '../../../shared/contrast/contrast.js';
import { typedBoxes } from '../shell/ink/notebookparts.js';

const SIZES = {
  phone: { width: 390, height: 844, sat: 47, touch: true },
  'mini-upright': { width: 744, height: 1133, sat: 24, touch: true },
  'mini-sideways': { width: 1133, height: 744, sat: 24, touch: true },
  desktop: { width: 1440, height: 900, sat: 0, touch: false },
};
// the scraps' three days, and how each reads under the title
const DAYS = [
  ['2026-10-30T12:00:00.000Z', /\b30 Oct\b/],
  ['2026-11-01T12:00:00.000Z', /\b1 Nov\b/],
  ['2026-11-03T12:00:00.000Z', /\b3 Nov\b/],
];
const T0 = DAYS[0][0],
  page = (id, label, more = {}) => ({
    id,
    notebook: 1,
    pos: id - 1,
    label,
    created: T0,
    updated: T0,
    w: 1200,
    h: 2400,
    ...more,
  }),
  WORDS = [
    'The price under the picture, not beside it.',
    'A softer page turn, and a paper sound with it.',
    'Tabs out of the page block on the iPad.',
    'Bookmarks with no dark outline, like the label.',
  ],
  // four notes a day, by Lyra, on the page of scraps
  note = (id, day) => ({
    ...{ id, page: 2, kind: 'note', by: 'lyra', owner_name: 'Lyra', ink: [], pictures: [], words: '', said: 'typed' },
    ...{ texts: typedBoxes(WORDS[id % 4], { x: 0, w: 320, color: '#1d1a2f' }), status: 'sent', pos: id, h: 180 },
    ...{ created: DAYS[day][0], updated: DAYS[day][0] },
  }),
  // the board's own drawing on the sketch page, on the second day: a wave
  drawing = {
    ...{ id: 100, page: 5, kind: 'drawing', by: 'board', texts: [], pictures: [], words: '', said: 'typed', pos: 0 },
    ...{ status: 'open', created: DAYS[1][0], updated: DAYS[1][0], place: { x: 60, y: 160 } },
    ink: [
      {
        color: '#2f62c9',
        size: 4,
        points: Array.from({ length: 30 }, (_, i) => [i * 10, 40 + 20 * Math.sin(i / 2), 0.5, i * 16]),
      },
    ],
  };
const SEED = {
  notebooks: [
    { id: 1, kind: 'mine', name: 'My journal', archived: false, created: T0, updated: T0, asks: { open: 0, all: 0 } },
  ],
  // (three sketch pages, so the page list has rows besides the one shown, Ideas the last and newest)
  pages: [
    page(1, 'Cover ideas', { pos: 0 }),
    page(4, 'Garden', { pos: 1 }),
    page(5, 'Ideas', { pos: 2 }),
    page(2, 'Shop notes', { kind: 'asks', pos: 3 }),
    page(3, 'Call with Lyra', { kind: 'call', pos: 4 }),
  ],
  groups: [drawing, ...Array.from({ length: 12 }, (_, i) => note(i + 1, Math.floor(i / 4)))],
  slips: [],
  asks: [],
  names: { lyra: 'Lyra' },
};
const dayOf = id => DAYS[Math.floor((id - 1) / 4)][1];

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function viewTitleStories(c) {
  return {
    "the page's title on the view: fixed as the page pans and zooms, the day of what's showing; Rename page in the dots menu; the page list's numbers read":
      async browser => {
        for (const [look, how] of Object.entries(LOOK_SCHEMES))
          for (const [name, size] of Object.entries(SIZES))
            try {
              await viewTitleAt(browser, c, `${look}-${name}`, how, size);
            } catch (e) {
              e.message = `${look} on the ${name}: ${e.message}`;
              throw e;
            }
      },
  };
}

async function viewTitleAt(browser, c, name, { renderer, colorScheme }, size) {
  const { width, height, sat, touch } = size,
    context = await c.hqIn(
      browser,
      { width, height },
      {
        notebooks: structuredClone(SEED),
        hasTouch: touch,
        isMobile: false,
        deviceScaleFactor: 1,
        colorScheme,
      },
    );
  await blurred(context, { sat });
  const p = await context.newPage(),
    errors = [];
  p.on('pageerror', e => errors.push(e.message));
  const press = loc => (touch ? loc.tap() : loc.click());
  try {
    await p.goto(`${c.base}/?intro=0&renderer=${renderer}`);
    await restsOpen(p, c, size);
    await until(() => p.evaluate(() => !!document.querySelector('#book .bk-marks .bk-mk-tab')), 'the bookmarks');
    await toChapter(p, 'asks', press);
    await p.waitForFunction(() => !document.querySelector('#book .bk-turn-picture, #book .bk-turn-leaf'));
    await scraps(p, c, name, size);
    await toChapter(p, 'sketch', press);
    await p.waitForFunction(() => !document.querySelector('#book .bk-turn-picture, #book .bk-turn-leaf'));
    await sketch(p, c, name);
    await renamed(p, c, name, press);
    await pageList(p, c, name, press);
    assert.deepEqual(errors, [], 'no page errors');
  } catch (e) {
    await c.shot(`viewtitle-${name}-failed`, p).catch(() => {});
    throw e;
  } finally {
    await context.close();
  }
}

// The page of scraps: the title and the first day at the content's top left; panned down to the second day's scraps and
// zoomed in, the same place and size, the day the topmost scrap's
async function scraps(p, c, name, { sat }) {
  await headSays(p, 'Shop notes', DAYS[0][1]);
  const rest = await p.evaluate(headSeen);
  // (below the blur, at the paper's left, the first scrap below it: where, not by how many px.)
  assert.ok(rest.title.top >= sat, `the title below the blur: ${rest.title.top}, ${sat}`);
  assert.ok(
    rest.title.left >= rest.desk.left && rest.title.left < rest.desk.left + rest.desk.width / 4,
    `the title at the paper's left: ${rest.title.left}`,
  );
  assert.ok(rest.firstScrap >= rest.foot, `at rest the first scrap below the title: ${rest.firstScrap}, ${rest.foot}`);
  assert.equal(rest.onPage, 0, 'no title on the page itself');
  assert.equal(rest.pencils, 0, 'no pencil by the title');
  assert.equal(rest.takes, false, 'the title takes no press: the page under it does');
  assert.equal(rest.over, false, 'at rest, no band over the page');
  await c.shot(`viewtitle-${name}-top`, p);
  // panned down a little at a time till the second day's scraps are the first on screen
  const middle = [rest.desk.left + rest.desk.width / 2, rest.desk.top + rest.desk.height / 2];
  for (let k = 0; k < 60 && !((await p.evaluate(topUnit)) > 4); k++) await wheel(p, middle, { deltaY: 40 });
  const top = await p.evaluate(topUnit);
  assert.ok(top > 4 && top <= 8, `panned to the second day's scraps (the topmost now ${top})`);
  await headSays(p, 'Shop notes', dayOf(top));
  const panned = await p.evaluate(headSeen);
  same(rest, panned, 'panned');
  const { band } = panned;
  assert.ok(panned.over, 'scrolled: the band frosted over what passes under the title');
  assert.ok(band.top <= 0.5 && band.left <= 0.5, `the band from the screen's top-left: ${JSON.stringify(band)}`);
  assert.ok(band.right >= band.tools, `the band across the paper, under the tools too: ${JSON.stringify(band)}`);
  await p.waitForTimeout(250); // (the band's fade in done)
  await c.shot(`viewtitle-${name}-panned`, p);
  await dateHandedOver(p, c, name, middle);
  // zoomed in about the middle (a trackpad's pinch): the title neither moves nor grows
  const scale = () =>
      p.evaluate(() => parseFloat(document.querySelector('#book .bk-desk').style.getPropertyValue('--bk-scale'))),
    fit = await scale();
  for (let k = 0; k < 10 && (await scale()) < fit * 1.5; k++) await wheel(p, middle, { deltaY: -100, ctrlKey: true });
  assert.ok((await scale()) >= fit * 1.5, `zoomed in: ${await scale()} from ${fit}`);
  const zoomed = await p.evaluate(headSeen);
  same(rest, zoomed, 'zoomed in');
  await headSays(p, 'Shop notes', dayOf((await p.evaluate(topUnit)) ?? 1));
  await p.waitForTimeout(250); // (the band's fade in done)
  await c.shot(`viewtitle-${name}-zoomed`, p);
}

// Panned on till the next day's date between days comes up to the title's foot: out of sight on the page, the head's
// day now its day, so no second date peeks under the title's
async function dateHandedOver(p, c, name, middle) {
  // (settled: the fades finished, which headless WebKit leaves where they start)
  const dateUnder = settled =>
    p.evaluate(settled => {
      const head = document.querySelector('#book .bk-view-head'),
        foot = head.getBoundingClientRect().bottom,
        date = [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-day')].find(d => {
          const r = d.getBoundingClientRect();
          return r.width && r.top + 14 >= foot - 8 && r.top + 14 < foot + 8;
        });
      if (date && settled)
        for (const a of [...date.getAnimations(), ...head.getAnimations({ subtree: true })]) a.finish();
      return (
        date && { under: date.hasAttribute('data-under'), seen: getComputedStyle(date).opacity, day: date.textContent }
      );
    }, settled);
  for (let k = 0; k < 300 && !(await dateUnder()); k++) await wheel(p, middle, { deltaY: 5 });
  await p.waitForTimeout(250); // (the band's and the date's fades done)
  const date = await dateUnder(true);
  assert.ok(date, "panned till a date between days is at the title's foot");
  assert.ok(date.under && date.seen === '0', `the date at the title's foot out of sight: ${JSON.stringify(date)}`);
  assert.ok((await p.evaluate(headSeen)).over, 'a date under the title: the band frosted over it');
  await headSays(p, 'Shop notes', date.day);
  await c.shot(`viewtitle-${name}-date-under`, p);
}

// The sketch page: its title and its drawing's date (no line across the title: the grid takes no ink, a line is drawn
// in an opened scrap.)
async function sketch(p, c, name) {
  await headSays(p, 'Ideas', DAYS[1][1]);
  await c.shot(`viewtitle-${name}-sketch`, p);
}

// Rename page, the first of the page's rows in the dots menu, writes the title where it shows; Enter saves it
async function renamed(p, c, name, press) {
  const dots = p.locator('#book .bk-more'),
    menu = p.locator('#book .bk-more-card'),
    field = p.getByRole('textbox', { name: 'Page title' });
  await press(dots);
  await menu.waitFor({ timeout: 5000 });
  const rows = await menu.getByRole('menuitem').evaluateAll(all => all.map(b => b.textContent));
  assert.ok(!rows.includes('Close notebook'), `no Close notebook in the page's menu: ${rows}`);
  const at = rows.indexOf('Rename page');
  assert.ok(at >= 0 && at < rows.indexOf('Tear off and send'), `Rename page first of the page's rows: ${rows}`);
  await c.shot(`viewtitle-${name}-menu`, p);
  await press(menu.getByRole('menuitem', { name: 'Rename page', exact: true }));
  await until(() => field.evaluate(el => el === document.activeElement), 'the title to write in');
  assert.ok(await field.evaluate(el => !!el.closest('.bk-view-head')), 'the title written where it shows');
  assert.equal(await field.inputValue(), 'Ideas');
  await field.fill('Ideas for the shop');
  await c.shot(`viewtitle-${name}-renaming`, p);
  await field.press('Enter');
  await headSays(p, 'Ideas for the shop', DAYS[1][1]);
  assert.match(await p.locator('#book .bk-where').getAttribute('aria-label'), /Ideas for the shop/);
}

// The page list: the chapter's pages by name and number, no title line or pencil of its own, its numbers read on it
async function pageList(p, c, name, press) {
  const where = p.locator('#book .bk-where'),
    list = p.locator('#book .bk-pages-menu');
  await press(where);
  await list.waitFor({ timeout: 5000 });
  assert.equal(await list.locator('input, .bk-title, svg').count(), 0, 'no title line or pencil in the page list');
  const ratio = Math.min(...(await list.evaluate(coloursIn)).map(([fg, bg]) => contrastChannels(fg, bg)));
  assert.ok(ratio >= 4.5, `the page numbers read on the list: ${ratio.toFixed(2)}:1`);
  console.log(`  ${name}: the page list's numbers at ${ratio.toFixed(2)}:1`);
  await c.shot(`viewtitle-${name}-list`, p);
  await press(where);
  await until(async () => !(await list.count()), 'the page count tapped again closes the list');
}

// The head shows title, and a day matching day
const headSays = (p, title, day) =>
  until(
    () =>
      p.evaluate(
        ({ title, day }) => {
          const head = document.querySelector('#book .bk-view-head'),
            seen = head?.querySelector('.bk-page-title')?.textContent,
            on = head?.querySelector('.bk-view-day');
          return seen === title && !on.hidden && new RegExp(day).test(on.textContent);
        },
        { title, day: day.source },
      ),
    `the title "${title}" with the day ${day} under it`,
    10_000,
  );
// Two readings of the head the same: its place and its type's size
function same(a, b, what) {
  for (const k of ['top', 'left', 'height'])
    assert.ok(Math.abs(a.title[k] - b.title[k]) <= 1, `${what}: the title's ${k} ${b.title[k]}, was ${a.title[k]}`);
  assert.equal(b.size, a.size, `${what}: the title's type the same size`);
}
// A wheel at a point on the screen (with ctrlKey: a trackpad's pinch), as the browser sends it to what's there
const wheel = (p, [x, y], more) =>
  p.evaluate(
    ({ x, y, more }) =>
      document
        .elementFromPoint(x, y)
        .dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, bubbles: true, cancelable: true, ...more })),
    { x, y, more },
  );

// (each function below runs in the page, with page.evaluate, so it names what it reads itself.)
// The head: the title's box and type size, the paper's box, titles or pencils on the page, and what a press on the
// title's middle reaches
function headSeen() {
  const title = document.querySelector('#book .bk-view-head .bk-page-title'),
    r = title.querySelector('span').getBoundingClientRect(),
    desk = document.querySelector('#book .bk-desk').getBoundingClientRect(),
    under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const head = document.querySelector('#book .bk-view-head'),
    band = head.getBoundingClientRect(),
    strip = document.querySelector('#book .bk-strip').getBoundingClientRect();
  return {
    // (the band: from the screen's top across the paper, under the tools too, frosted while something's under it)
    band: { top: band.top - desk.top, left: band.left - desk.left, right: band.right, tools: strip.left },
    over: head.hasAttribute('data-over'),
    title: { top: r.top, left: r.left, width: r.width, height: r.height },
    size: getComputedStyle(title).fontSize,
    desk: { left: desk.left, top: desk.top, width: desk.width, height: desk.height },
    onPage: document.querySelectorAll('#book .bk-page .bk-page-title, #book .bk-title-tap').length,
    // (a read-only page's lock is no pencil.)
    pencils: document.querySelectorAll('#book .bk-view-head svg:not(.bk-view-locked *)').length,
    takes: !!under?.closest('.bk-view-head'),
    foot: band.bottom,
    firstScrap: Math.min(
      ...[...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-unit')].map(
        u => u.getBoundingClientRect().top,
      ),
    ),
  };
}
// The topmost scrap on screen below the title's head, what's under it out of sight (its id), or null
function topUnit() {
  const foot = document.querySelector('#book .bk-view-head').getBoundingClientRect().bottom;
  let top = null;
  for (const u of document.querySelectorAll('#book .bk-page:not([hidden]) .bk-unit')) {
    const r = u.getBoundingClientRect();
    if (r.bottom <= foot || r.top >= innerHeight || !r.width) continue;
    if (!top || r.top < top.r.top - 0.5 || (Math.abs(r.top - top.r.top) <= 0.5 && r.left < top.r.left))
      top = { id: Number(u.dataset.unit), r };
  }
  return top?.id ?? null;
}
// The list's page numbers' colours and the card's under them, each composited over what's under it: [[fg, bg]], sRGB
// channels 0 to 255 (contrast.js's sums, in node).
function coloursIn(list) {
  const rgba = colour => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      const x = cv.getContext('2d', { willReadFrequently: true });
      x.fillStyle = colour;
      x.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = x.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    },
    over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
  // (each number: the backgrounds from the page's paper up to it, each over the one under it)
  const paper = over(rgba(getComputedStyle(document.querySelector('#book .bk-desk')).backgroundColor), [255, 255, 255]);
  return [...list.querySelectorAll('small')].map(n => {
    const chain = [];
    for (let el = n; el && el !== document.documentElement; el = el.parentElement) chain.unshift(el);
    const bg = chain.reduce((under, el) => over(rgba(getComputedStyle(el).backgroundColor), under), paper);
    return [over(rgba(getComputedStyle(n).color), bg), bg];
  });
}
