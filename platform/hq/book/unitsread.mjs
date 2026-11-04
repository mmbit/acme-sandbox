// What a page of scrap units shows in the browser, as book-check.mjs's stories read it (shell/ink/bookunits.js): the
// units on screen, still or laid out sound, the store's strokes by unit, the book opened on them, a line written with
// the mouse, and what a note's own size and a column at LEAST of it come to on screen.
import assert from 'node:assert/strict';
import { until } from './kit.mjs';
import { DAY_H, GAP, LEAST, MOST } from '../shell/ink/masonry.js';
import { UNIT_W } from '../shell/ink/scrapunit.js';

// The book open, tapped open from its tab where it starts folded (a phone's), its n units drawn
export async function opened(page, n) {
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
// How many strokes the store keeps in each group of the page: group id → strokes
export const strokesBy = page =>
  new Map(
    page
      .context()
      .notebook.route('/api/notebooks/pages/groups', { page: 1 })
      .groups.map(g => [g.id, g.ink.length]),
  );
// A note's width, drawn at most at its own size (masonry.js MOST), a rounding's half-pixel over
export const OWN_W = UNIT_W * MOST + 0.5;
// The room right of a page's notes that holds another column at LEAST of its size, beside the margin left of them
export const anotherColumn = margin => (UNIT_W + GAP) * LEAST + margin;
// The units on screen, each with what hangs under it: { id, x, y, w, h, bottom } in CSS px
export const units = page =>
  page.evaluate(() =>
    [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-unit')].map(u => {
      const r = u.getBoundingClientRect(),
        under = document.querySelector(`#book .bk-page:not([hidden]) .bk-under[data-g="${u.dataset.unit}"]`),
        bottom = under ? Math.max(r.bottom, under.getBoundingClientRect().bottom) : r.bottom;
      return { id: Number(u.dataset.unit), x: r.left, y: r.top, w: r.width, h: r.height, bottom };
    }),
  );
// No two units overlap, units in a column are the same space apart, and the page never scrolls sideways
export async function sound(page, when) {
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
export async function still(page) {
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
export async function line(page, x, y, len) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let k = 1; k <= 12; k++) await page.mouse.move(x + 24 + (len * k) / 12, y + Math.sin(k / 2) * 8);
  await page.mouse.up();
  await page.waitForTimeout(250);
}
// The group the store has saved a new stroke in, against the strokes it had by group (strokesBy)
export async function savedInto(page, had, what) {
  let into;
  await until(
    () => {
      const now = strokesBy(page);
      into = [...now.keys()].find(id => now.get(id) > (had.get(id) ?? 0));
      return into !== undefined;
    },
    what,
    8000,
  );
  return into;
}
