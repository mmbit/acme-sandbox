// book-check.mjs's story of a notebook page as a masonry of scrap units (shell/ink/bookunits.js), on a page seeded as
// the end of a test call: an agent's six scraps of mixed heights (pictures with words, plain notes, one with an answer
// under it). Then the board's annotations: a line written in a scrap's room, a line between scraps (a unit of its own),
// a room dragged taller by its handle, a line under the tallest column's last scrap. At a phone, an iPad mini upright
// and sideways, and a wide desktop. Each time: no two units (with what hangs under them) overlap, the space between
// units in a column is the same, nothing scrolls sideways, each line between scraps stays under the scrap it was
// written under, the room grows as its handle's dragged, and the last unit scrolls clear of the tools. The wide desktop
// is then made narrower and opened again: its lines still under their scraps in fewer columns (an iPad mini is one
// column either way up, left of the rail: job #15863). Recorded with --shots.
import assert from 'node:assert/strict';
import { until } from './bookkit.mjs';
import { typedBoxes } from './shell/ink/notebookparts.js';
import { DAY_H, GAP } from './shell/ink/masonry.js';
import { UNIT_W } from './shell/ink/scrapunit.js';

const T0 = '2026-10-29T15:00:00.000Z';
const SIZES = {
  phone: { width: 390, height: 844 },
  'ipad-mini-upright': { width: 744, height: 1133 },
  'ipad-mini-sideways': { width: 1133, height: 744 },
  'desktop-narrow': { width: 1920, height: 1080, book: 380 },
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
const SEED = {
  notebooks: [{ id: 1, kind: 'mine', name: 'My journal', archived: false, created: T0, updated: T0 }],
  pages: [
    { id: 1, notebook: 1, pos: 0, label: 'Call with Moss: the cover', created: T0, updated: T0, w: 1200, h: 1600 },
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
    "a page of scrap units: an agent's six scraps and the board's annotations, at a phone, an iPad mini both ways and a desktop, never overlapping":
      async browser => {
        // (every size shot and checked, the failures told together)
        const failed = [];
        for (const [name, size] of Object.entries(SIZES))
          await atSize(browser, c, name, size).catch(e => failed.push(e.message));
        assert.deepEqual(failed, [], failed.join('\n'));
      },
  };
}

async function atSize(browser, c, name, size) {
  const context = await deskAt(browser, c, size),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0`);
    await opened(page, 6);
    await page.waitForTimeout(400);
    await sound(page, `${name}, as the call left it`);
    await c.shot(`units-${name}-1-call`, page);
    const low = await annotate(page, name);
    await page.waitForTimeout(900);
    await sound(page, `${name}, annotated`);
    await c.shot(`units-${name}-2-annotated`, page);
    await atFoot(page, c, name);
    const tallest = await underTallest(page, name);
    if (size.turned) await turned(page, c, name, size.turned, [low, tallest]);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`units-${name}-failed`, page);
    e.message = `${name}: ${e.message} (page errors: ${errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await context.close();
  }
}
// The book open, tapped open from its tab where it starts folded (a phone's), its n units drawn
async function opened(page, n) {
  await page.waitForSelector('#book .bk-desk', { state: 'attached', timeout: 30_000 });
  await page.waitForFunction(
    () => document.documentElement.dataset.book && !document.querySelector('#book.bk-swinging'),
  );
  if ((await page.evaluate(() => document.documentElement.dataset.book)) === 'folded') {
    await page.locator('#book .bk-lip').click();
    await page.waitForFunction(() => !['folded', 'shut'].includes(document.documentElement.dataset.book));
  }
  await until(async () => (await units(page)).length === n, `the ${n} units drawn`);
}
// The board's annotations: a line in the first unit's room, one in the space under a unit (a unit of its own, right
// under it), a room dragged taller by its handle. Returns the unit the line was written under.
async function annotate(page, name) {
  const [first] = await units(page);
  await line(page, first.x + 40, first.y + first.h - 50, 120);
  // (apart in time, so the handwriting read into type, where it is, reads them apart)
  // (once the page is still: words read from the first line, where it is, land and grow its scrap first)
  const low = (await still(page)).sort((a, b) => a.bottom - b.bottom)[0];
  await line(page, low.x + 40, low.bottom + 12, 140);
  await until(async () => (await units(page)).length === 7, 'the line between scraps a unit of its own', 8000);
  stays(await still(page), low.id, `${name}: the line between scraps`);
  await dragRoom(page, name);
  return low.id;
}
// A line written under the tallest column's last unit, at the page's foot: it stays in that column, under it.
// Returns that unit.
async function underTallest(page, name) {
  const last = (await still(page)).sort((a, b) => b.bottom - a.bottom)[0];
  await line(page, last.x + 40, last.bottom + 12, 140);
  await until(async () => (await units(page)).length === 8, "the line under the tallest column's last", 8000);
  stays(await still(page), last.id, `${name}: the line under the tallest column's last unit`);
  return last.id;
}
// The page turned to another size once its lines are saved, and opened again from the store: laid in another number
// of columns, each line still right under the unit it was written under
async function turned(page, c, name, size, under) {
  await until(async () => (await units(page)).every(u => u.id > 0), 'the lines saved', 8000);
  const columns = async () => new Set((await units(page)).map(u => Math.round(u.x))).size,
    were = await columns();
  await page.setViewportSize(size);
  await page.reload();
  await opened(page, 8);
  const all = await still(page);
  assert.notEqual(await columns(), were, `${name}: turned, the page laid in another number of columns`);
  for (const id of under) stays(all, id, `${name}, turned: the line written under unit ${id}`);
  await sound(page, `${name}, turned`);
  await c.shot(`units-${name}-4-turned`, page);
}
// A line (a unit not the seed's) right under unit id in its column, the space between units apart
function stays(all, id, what) {
  const above = all.find(u => u.id === id),
    seeded = new Set(SEED.groups.map(g => g.id)),
    made = all.find(u => !seeded.has(u.id) && Math.abs(u.x - above.x) < 1 && u.y > above.bottom);
  assert.ok(
    made && made.y - above.bottom <= 40,
    `${what} stays under the unit it was written under (${JSON.stringify({ above, made })})`,
  );
}
// HQ at a size on the seed, a mouse's desk: its notebook as narrow or wide as the board dragged it (booklayout.js keep)
async function deskAt(browser, c, size) {
  const { width, height, book } = size,
    viewport = { width, height },
    context = await c.hqIn(browser, viewport, { notebooks: structuredClone(SEED), hasTouch: false, isMobile: false });
  // (no microphone: on a loaded machine a line's first move can come after the hold, and the press held still is then
  // a voice note, the voice line's words in a box of their own (bookinput.js); bookvoice.mjs has those. job #15274)
  await context.addInitScript(() => (navigator.mediaDevices.enumerateDevices = async () => []));
  if (book)
    await context.addInitScript(
      w => localStorage.setItem('hq.book.wide', JSON.stringify({ mode: 'open', book: w })),
      book,
    );
  return context;
}
// A unit's room dragged 80 px taller by its handle: the first handle on screen
async function dragRoom(page, name) {
  const b = await page.evaluate(() => {
    const on = [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-room-handle')]
      .map(h => Object.assign(h.getBoundingClientRect().toJSON(), { unit: h.dataset.unit }))
      .find(r => r.top > 0 && r.bottom < innerHeight - 200);
    return on && { x: on.left + on.width / 2, y: on.top + on.height / 2, unit: Number(on.unit) };
  });
  assert.ok(b, `${name}: a unit's handle shows`);
  const tall = () => units(page).then(all => all.find(u => u.id === b.unit).h),
    was = await tall();
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(b.x, b.y + k * 10);
  await page.mouse.up();
  // (the press the handle's, never the pen's: job #15978)
  await until(async () => (await tall()) >= was + 70, `${name}: the room dragged 80 px taller`, 4000);
}
// Scrolled to its foot: the last unit up on the page, and every unit clear of the rail
async function atFoot(page, c, name) {
  // (over the notebook's paper: beside HQ, the screen's middle is HQ's)
  const desk = await page.locator('#book .bk-desk').boundingBox();
  await page.mouse.move(desk.x + desk.width / 2, desk.y + desk.height / 2);
  for (let k = 0; k < 12; k++) await page.mouse.wheel(0, 600);
  await page.waitForTimeout(500);
  await c.shot(`units-${name}-3-foot`, page);
  // (the paper the page scrolls in ends left of the rail of controls, and the last unit scrolls up into it.)
  const foot = await page.evaluate(() => {
    const rail = document.querySelector('#book .bk-column').getBoundingClientRect(),
      desk = document.querySelector('#book .bk-desk').getBoundingClientRect(),
      all = [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-unit')].map(u => u.getBoundingClientRect());
    return {
      last: Math.max(...all.map(u => u.bottom)),
      right: Math.max(...all.map(u => u.right)),
      desk: { bottom: desk.bottom, right: desk.right },
      rail: rail.left,
    };
  });
  const clear = foot.desk.right <= foot.rail + 1 && foot.right <= foot.rail + 1 && foot.last <= foot.desk.bottom + 1;
  assert.ok(clear, `${name}: the last unit clear of the tools (${JSON.stringify(foot)})`);
}

// The units on screen, each with what hangs under it: { id, x, y, w, h, bottom } in CSS px
const units = page =>
  page.evaluate(() =>
    [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-unit')].map(u => {
      const r = u.getBoundingClientRect(),
        under = document.querySelector(`#book .bk-page:not([hidden]) .bk-under[data-g="${u.dataset.unit}"]`),
        bottom = under ? Math.max(r.bottom, under.getBoundingClientRect().bottom) : r.bottom;
      return { id: Number(u.dataset.unit), x: r.left, y: r.top, w: r.width, h: r.height, bottom };
    }),
  );
// No two units overlap, units in a column are the same space apart, and the page never scrolls sideways
async function sound(page, when) {
  const all = await units(page);
  for (const a of all)
    for (const b of all)
      if (a.id < b.id) {
        const apart =
          a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5 || a.bottom <= b.y + 0.5 || b.bottom <= a.y + 0.5;
        assert.ok(apart, `${when}: units ${a.id} and ${b.id} overlap (${JSON.stringify([a, b])})`);
      }
  // (the masonry's GAP at the page's scale; where a day's header starts between them, the unit right under it and the
  // header at least GAP under the one above: a line the board writes today on yesterday's page starts today.)
  const days = await page.evaluate(() =>
      [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-day')].map(d => d.getBoundingClientRect().top),
    ),
    columns = Map.groupBy(all, u => Math.round(u.x));
  for (const col of columns.values()) {
    const sorted = col.sort((a, b) => a.y - b.y);
    for (let k = 1; k < sorted.length; k++) {
      const [a, b] = [sorted[k - 1], sorted[k]],
        s = b.w / UNIT_W,
        day = days.findLast(y => y >= a.bottom - 0.5 && y <= b.y + 0.5),
        gap = day === undefined ? b.y - a.bottom : b.y - (day + DAY_H * s),
        room = day === undefined ? gap : day - a.bottom;
      assert.ok(
        Math.abs(gap - (day === undefined ? GAP * s : 0)) <= 1.5 && room >= GAP * s - 1.5,
        `${when}: the space between units ${a.id} and ${b.id} is ${gap} (${day === undefined ? 'no day' : 'a day'} between)`,
      );
    }
  }
  const sideways = await page.evaluate(() => {
    const w = document.querySelector('#book .bk-world').style.transform;
    return /translate3d\((-?[\d.]+)px/.exec(w)?.[1];
  });
  assert.equal(Number(sideways ?? 0), 0, `${when}: the page never moves sideways`);
}
// The units once they've stopped changing for a second: [{ id, x, y, w, h, bottom }]
async function still(page) {
  let was = '';
  for (let k = 0; k < 20; k++) {
    const now = await units(page);
    if (JSON.stringify(now) === was) return now;
    was = JSON.stringify(now);
    await page.waitForTimeout(1000);
  }
  return units(page);
}
// A line written with the mouse from x, y, len px across
async function line(page, x, y, len) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  // (moving at once, so a press held still, a voice note, never takes it)
  for (let k = 1; k <= 12; k++) await page.mouse.move(x + 24 + (len * k) / 12, y + Math.sin(k / 2) * 8);
  await page.mouse.up();
  await page.waitForTimeout(250);
}
