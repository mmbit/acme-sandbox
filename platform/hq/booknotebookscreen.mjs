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
// A group's unit (g: its id; null: the page's first) picked with Select, by a click or a tap (how), and the button named
// on Select's bar pressed the same way: its Delete, its Move to page…
export async function fromBar(page, g, name, how = 'click') {
  await page.locator('#book [data-island=tools] [data-mode=select]')[how]();
  const unit = page.locator(`#book .bk-page:not([hidden]) .bk-unit${g == null ? '' : `[data-unit="${g}"]`}`).first(),
    press = await shownPoint(page, unit);
  assert.ok(press, 'a point of the unit shows on the page');
  if (how === 'tap') await page.touchscreen.tap(...press);
  else await page.mouse.click(...press);
  const bar = page.locator('#book .bk-sel-bar');
  await bar.waitFor({ timeout: 5000 });
  await bar.getByRole('button', { name, exact: true })[how]();
}
// The first point of a unit, in screen px, scanned from its top left in rows 4 px apart and steps 8 px along, where the
// page itself is under the point and no control on it (a room's handle): a tall unit runs past the desk's foot, and the
// for-you counter floats over that foot
async function shownPoint(page, unit) {
  const [box, desk] = await Promise.all([unit.boundingBox(), page.locator('#book .bk-desk').boundingBox()]),
    area = {
      left: Math.max(box.x, desk.x),
      right: Math.min(box.x + box.width, desk.x + desk.width),
      top: Math.max(box.y, desk.y),
      bottom: Math.min(box.y + box.height, desk.y + desk.height),
    };
  return unit.evaluate((u, { left, right, top, bottom }) => {
    const rowPx = 4,
      stepPx = 8,
      insetPx = 2;
    for (let y = top + insetPx; y < bottom; y += rowPx)
      for (let x = left + insetPx; x < right; x += stepPx) {
        const hit = document.elementFromPoint(x, y);
        if (u.closest('.bk-page').contains(hit) && !hit.closest('button')) return [x, y];
      }
    return null;
  }, area);
}
// The groups of two or more things, which have a clip, by group
export const held = groups =>
  groups.filter(g => (g.ink?.length ?? 0) + (g.texts?.length ?? 0) + (g.pictures?.length ?? 0) > 1).map(g => g.id);
// The page shown: its title at its head and where it is on the rail ("Ideas 2/3")
export const where = page =>
  page.evaluate(
    () =>
      `${document.querySelector('#book .bk-page:not([hidden]) .bk-page-title')?.textContent ?? ''} ${document.querySelector('#book .bk-where')?.textContent ?? ''}`,
  );
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
// A column of the screen (x) in a unit's own px, as the store keeps its ink: onPaper's, the other way.
export async function inUnit(page, unit, x) {
  const along = [0, 1].map(dx => [dx, 0]),
    [[x0], [x1]] = await onPaper(page, along, unit);
  return (x - x0) / (x1 - x0);
}
// Bare paper on the page shown, on the screen: a little under the shortest column's last unit (and what hangs under
// it), where a line is a unit of its own (bookunits.js newUnit), left of the controls; where the page ends under that
// unit (one column, as a desktop's book shows it), in the gap under the column's first unit; and the unit above it,
// [x, y, id].
export const clearPlace = page =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden),
      columns = new Map();
    for (const u of shown.querySelectorAll('.bk-unit')) {
      const r = u.getBoundingClientRect(),
        under = shown.querySelector(`.bk-under[data-g="${u.dataset.unit}"]`),
        bottom = Math.max(r.bottom, under?.getBoundingClientRect().bottom ?? 0),
        x = Math.round(r.left);
      columns.set(x, [...(columns.get(x) ?? []), { left: r.left, top: r.top, bottom, unit: Number(u.dataset.unit) }]);
    }
    const column = [...columns.values()]
        .map(units => units.sort((a, b) => a.top - b.top))
        .sort((a, b) => a.at(-1).bottom - b.at(-1).bottom)[0],
      low = column.at(-1);
    if (low.bottom + 28 < shown.getBoundingClientRect().bottom - 8) return [low.left + 40, low.bottom + 28, low.unit];
    return [column[0].left + 40, (column[0].bottom + column[1].top) / 2, column[0].unit];
  });
export const tool = (page, name) => page.locator('#book').getByRole('button', { name, exact: true }).click();
// The page at a place in the notebook (1: its first; the seed's pages' ids are theirs), turned to with the foot row's
// arrows
export async function turnTo(page, id) {
  const n = () => where(page).then(w => Number(/(\d+)\/\d+$/.exec(w)?.[1]));
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
// A group (id, on the page on) slid into view, as the book shows a scrap ('book:scrap'), and points on it (its unit's
// px, as the store keeps them) on the screen once the paper's still and nothing's over them
export async function inSight(page, on, id, at) {
  await page.evaluate(detail => document.dispatchEvent(new CustomEvent('book:scrap', { detail })), {
    id,
    page: on,
  });
  await page.locator(`#book .bk-page:not([hidden]) .bk-unit[data-unit="${id}"]`).waitFor();
  let was = '';
  return until(async () => {
    const points = await onPaper(page, at, id),
      still = JSON.stringify(points) === was;
    was = JSON.stringify(points);
    const bare = await page.evaluate(
      ps => ps.every(([x, y]) => document.elementFromPoint(x, y)?.closest('#book .bk-page')),
      points,
    );
    return still && bare && points;
  }, 'the scrap in view, nothing over it');
}
