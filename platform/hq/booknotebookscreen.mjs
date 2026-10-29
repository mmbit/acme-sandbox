// The Notebook's page on screen for book-check's Notebook stories (booknotebook.mjs): the groups' clips, the page's place
// and stamp, points on the paper, the tools, a turn, a line drawn, and a wait.
import assert from 'node:assert/strict';

// The groups' clips on the page shown, by group
export const clipped = page =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('#book .bk-page')].filter(p => !p.hidden);
    return shown.flatMap(p => [...p.querySelectorAll('.bk-clip')].map(c => Number(c.dataset.g))).sort((a, b) => a - b);
  });
// The groups of two or more things, which have a clip, by group
export const held = groups =>
  groups.filter(g => (g.ink?.length ?? 0) + (g.texts?.length ?? 0) + (g.pictures?.length ?? 0) > 1).map(g => g.id);
export const where = page => page.locator('#book .bk-where').textContent();
export const stamp = page =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden);
    return shown?.querySelector('[data-slot=stamp]')?.textContent ?? '';
  });
// Points on the page shown (page px, the seed's pages at 0, 0) on the screen
export const onPaper = (page, points) =>
  page.evaluate(points => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden);
    const r = shown.getBoundingClientRect(),
      k = r.width / shown.offsetWidth;
    return points.map(([x, y]) => [r.left + x * k, r.top + y * k]);
  }, points);
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
  // (the whole line goes to where it touched down, as the page's pointer capture sends a real pen's: a line ending
  // under the Undo island over the paper's right edge is still the page's. A made-up pointer can't be captured.)
  await page.evaluate(pts => {
    const under = document.elementFromPoint(...pts[0]) ?? document.body;
    const at = (kind, [x, y], pressure) =>
      under.dispatchEvent(
        new PointerEvent(kind, {
          ...{ pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: x, clientY: y, pressure },
          ...{ buttons: kind === 'pointerup' ? 0 : 1, bubbles: true, composed: true, cancelable: true },
        }),
      );
    const steps = pts.flatMap((p, i) =>
      i
        ? [0.25, 0.5, 0.75, 1].map(t => [
            pts[i - 1][0] + (p[0] - pts[i - 1][0]) * t,
            pts[i - 1][1] + (p[1] - pts[i - 1][1]) * t,
          ])
        : [p],
    );
    at('pointerdown', steps[0], 0.4);
    steps.slice(1).forEach(p => at('pointermove', p, 0.5));
    at('pointerup', steps.at(-1), 0);
  }, points);
}
// (long enough for a loaded worker, where the page's timers come seconds late: its 600 ms save took over 6 s)
export async function until(read, what, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const v = await read();
    if (v) return v;
  }
  throw new Error(`not ${what}`);
}
