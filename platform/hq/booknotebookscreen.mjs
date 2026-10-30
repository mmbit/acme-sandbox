// The Notebook's page on screen for book-check's Notebook stories (booknotebook.mjs): the groups' units, the page's place
// and stamp, points on the paper, the tools, a turn, and a line drawn.
import assert from 'node:assert/strict';
import { pressAlong, until } from './bookkit.mjs';

// The groups drawn on the page shown, each top-level group a scrap unit (bookunits.js), by group
export const clipped = page =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('#book .bk-page')].filter(p => !p.hidden);
    return shown
      .flatMap(p => [...p.querySelectorAll('.bk-unit')].map(u => Number(u.dataset.unit)))
      .sort((a, b) => a - b);
  });
// A group's unit (g: its id; null: the page's first) picked with Select (the rail's), by a click or a tap (how), and the button named on Select's bar
// pressed the same way: its Delete, its Move to page…
export async function fromBar(page, g, name, how = 'click') {
  await page.locator('#book [data-island=tools] [data-mode=select]')[how]();
  // (the middle of what shows of the unit: a tall one runs past the desk's foot on a short screen, where a press isn't the paper's)
  const unit = page.locator(`#book .bk-page:not([hidden]) .bk-unit${g == null ? '' : `[data-unit="${g}"]`}`).first(),
    [b, desk] = await Promise.all([unit.boundingBox(), page.locator('#book .bk-desk').boundingBox()]),
    [x0, x1] = [Math.max(b.x, desk.x), Math.min(b.x + b.width, desk.x + desk.width)],
    [y0, y1] = [Math.max(b.y, desk.y), Math.min(b.y + b.height, desk.y + desk.height)],
    press = [(x0 + x1) / 2, (y0 + y1) / 2];
  if (how === 'tap') await page.touchscreen.tap(...press);
  else await page.mouse.click(...press);
  const bar = page.locator('#book .bk-sel-bar');
  await bar.waitFor({ timeout: 5000 });
  await bar.getByRole('button', { name, exact: true })[how]();
}
// The groups of two or more things, which have a clip, by group
export const held = groups =>
  groups.filter(g => (g.ink?.length ?? 0) + (g.texts?.length ?? 0) + (g.pictures?.length ?? 0) > 1).map(g => g.id);
export const where = page => page.locator('#book .bk-where').textContent();
export const stamp = page =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden);
    // (the red stamp's words, its label)
    return shown?.querySelector('[data-slot=stamp] svg')?.getAttribute('aria-label') ?? '';
  });
// Points on the page shown (page px, the seed's pages at 0, 0) on the screen. With a unit's id: points in that unit's
// own px, as the store keeps its things, moved to where the masonry put it (bookunits.js): a unit the page doesn't show
// fails.
export const onPaper = (page, points, unit = null) =>
  page.evaluate(
    ([points, unit]) => {
      const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden);
      const r = shown.getBoundingClientRect(),
        k = r.width / shown.offsetWidth,
        card = unit === null ? null : shown.querySelector(`.bk-unit[data-unit="${unit}"]`),
        [ox, oy] = unit === null ? [0, 0] : [parseFloat(card.style.left), parseFloat(card.style.top)];
      return points.map(([x, y]) => [r.left + (x + ox) * k, r.top + (y + oy) * k]);
    },
    [points, unit],
  );
export const tool = (page, name) => page.locator('#book').getByRole('button', { name, exact: true }).click();
// The page at a place in the notebook (1: its first; the seed's pages' ids are theirs), turned to with the foot row's
// arrows
export async function turnTo(page, id) {
  const n = () => where(page).then(w => Number(/(\d+) \/ \d+$/.exec(w)?.[1]));
  for (let i = 0, turns = 0; i < 60 && turns < 8 && (await n()) !== id; i++) {
    const was = await n(),
      arrow = page.locator('#book').getByRole('button', { name: was > id ? 'The page before' : 'The page after' });
    // (the row read mid-change, as a send's Undo takes its fresh page back: read again rather than press an arrow
    // that's off.)
    if (!Number.isFinite(was) || (await arrow.isDisabled())) {
      await page.waitForTimeout(150);
      continue;
    }
    await arrow.click();
    turns++;
    await until(async () => (await n()) !== was, 'the page turned');
  }
  assert.equal(await n(), id, `turned to page ${id}`);
}
// A line drawn with the Pencil through points on the screen (mouse: drawn with the mouse instead)
export async function pen(page, points, mouse = null) {
  if (mouse) {
    await mouse.move(...points[0]);
    await mouse.down();
    for (const p of points.slice(1)) await mouse.move(...p, { steps: 4 });
    return mouse.up();
  }
  await pressAlong(page, points);
}
