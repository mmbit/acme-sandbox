// book-check.mjs's story of the pages' row at the paper's foot (shell/ink/bookcontrols.js), on a desktop and a phone:
// each control's tooltip whole above the row, over none of its buttons, and Send at the row's end, apart from the
// zoom's %. (the board, 28 Oct)
import assert from 'node:assert/strict';
import { paperBox } from './bookmouse.mjs';

const PHONE = { width: 390, height: 844 };

// c: book-check.mjs's played store and helpers; desk: bookstrip.mjs's, the book open on a desktop
export function barStories(c, { desk }) {
  return {
    "the pages' row: its tooltips whole above it, Send apart from the zoom, on a desktop and a phone":
      async browser => {
        const opened = await desk(browser, c);
        try {
          await row(opened.page, c, 'desktop');
          assert.deepEqual(opened.errors, []);
        } finally {
          await opened.done();
        }
        const context = await c.hqIn(browser, PHONE, { hasTouch: true, deviceScaleFactor: 1 }),
          page = await context.newPage(),
          errors = [];
        page.on('pageerror', e => errors.push(e.message));
        try {
          await page.goto(`${c.base}/?intro=0`);
          await page.waitForSelector('#book .bk-lip', { timeout: 30_000 });
          await c.settled(page, 'folded');
          await page.click('#book .bk-lip');
          await c.settled(page, 'spread');
          await row(page, c, 'phone');
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      },
  };
}

async function row(page, c, where) {
  // the zoom off 100%, so its % shows in the row
  const paper = await paperBox(page);
  await page.mouse.move(paper.x + paper.width / 2, paper.y + paper.height / 2);
  await page.mouse.wheel(0, -200);
  await page.locator('#book .bk-pct').waitFor({ state: 'visible', timeout: 10_000 });
  const bar = await page.locator('#book [data-island=pages]').boundingBox(),
    send = await page.locator('#book .bk-btn.bk-send').boundingBox(),
    add = await page.getByRole('button', { name: 'New page', exact: true }).boundingBox(),
    pct = await page.locator('#book .bk-pct').boundingBox();
  // Send at the row's right end after New page, the zoom's % with the pages, apart from both
  assert.ok(bar.x + bar.width - (send.x + send.width) < 8, `${where}: Send ends the row`);
  assert.ok(pct.x + pct.width <= add.x - 8 && add.x + add.width <= send.x, `${where}: the zoom's % apart from Send`);
  await c.shot(`book-bar-${where}`, page);
  // every control's tooltip whole on the screen, above the row, clear of it
  const view = page.viewportSize();
  for (const name of ["The overview: the notebook's pages, and the Shelf", 'Back to 100%', 'New page', 'Send']) {
    const b = await page.locator('#book [data-island=pages]').getByRole('button', { name, exact: true }).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 2 });
    const tip = page.locator('#bk-tip');
    await tip.waitFor({ state: 'visible', timeout: 10_000 });
    const t = await tip.boundingBox();
    assert.ok(t.y + t.height <= bar.y - 2, `${where}: ${name}'s tooltip above the row`);
    assert.ok(t.x >= 0 && t.x + t.width <= view.width && t.y >= 0, `${where}: ${name}'s tooltip on the screen`);
    assert.ok(
      await tip.evaluate(el => {
        const r = el.getBoundingClientRect();
        return [...el.children].every(s => {
          const w = s.getBoundingClientRect();
          return w.left >= r.left && w.right <= r.right + 0.5 && w.bottom <= r.bottom + 0.5;
        });
      }),
      `${where}: ${name}'s tooltip whole`,
    );
    if (name === 'Send') await c.shot(`book-bar-${where}-send`, page);
    await page.mouse.move(paper.x + 40, paper.y + 40);
    await tip.waitFor({ state: 'hidden', timeout: 10_000 });
  }
}
