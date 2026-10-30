// book-check.mjs's story of the pages' row at the paper's foot (shell/ink/bookcontrols.js), on a desktop and a phone:
// one slim row with the page's name whole in it (on a desktop; a phone's trails off), each control's tooltip whole above the row, over none of its buttons,
// and Send out of it, its own island at the top of the stack, its tooltip over no other control.
import assert from 'node:assert/strict';
import { paperBox } from './bookmouse.mjs';
import { desk } from './bookstrip.mjs';
import { islandsClearOf } from './bookkit.mjs';

const PHONE = { width: 390, height: 844 };

// c: book-check.mjs's played store and helpers
export function barStories(c) {
  return {
    "the pages' row: one slim line, its tooltips whole above it, Send at the stack's top, on a desktop and a phone":
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
    send = await page.locator('#book [data-island=send] .bk-send').boundingBox();
  await slim(page, where, bar, send);
  await c.shot(`book-bar-${where}`, page);
  await rowTips(page, where, bar, paper);
  if (where !== 'desktop') return;
  await sendTip(page, send);
  await c.shot('book-bar-desktop-send', page);
}

// One slim line: the page's name in it whole, the zoom's % with the pages, before New page; Send out of the row, at
// the top of the stack over the paper's right edge, above Undo
async function slim(page, where, bar, send) {
  const undo = await page.locator('#book .bk-undo').boundingBox(),
    add = await page.getByRole('button', { name: 'New page', exact: true }).boundingBox(),
    pct = await page.locator('#book .bk-pct').boundingBox(),
    button = await page.locator('#book [data-island=pages] .bk-btn').first().boundingBox();
  assert.ok(bar.height < button.height * 2, `${where}: one row, ${Math.round(bar.height)} px tall`);
  const name = await page
    .locator('#book .bk-where span')
    .evaluate(el => ({ text: el.textContent, shown: el.clientWidth, whole: el.scrollWidth }));
  // (a phone's row has the paper's width: there a long name trails off, whole in the notebook's pages)
  if (where === 'desktop')
    assert.ok(name.whole <= name.shown, `${where}: the page's name whole (${JSON.stringify(name)})`);
  else assert.ok(name.shown >= 48, `${where}: the page's name shown (${JSON.stringify(name)})`);
  assert.ok(pct.x + pct.width <= add.x, `${where}: the zoom's % before New page`);
  assert.equal(await page.locator('#book [data-island=pages] .bk-send').count(), 0, `${where}: no Send in the row`);
  assert.ok(send.y + send.height <= undo.y, `${where}: Send tops the stack`);
  // (the strip placed beside the stack by its width, measured whichever way the book came to rest: a phone's opened
  // from its lip.)
  const strip = await page.locator('#book .bk-strip [data-island=tools]').boundingBox(),
    island = await page.locator('#book [data-island=book]').boundingBox();
  assert.ok(apart(strip, island), `${where}: the strip beside Undo's island, not over it`);
}
const apart = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

// Every control's tooltip in the row whole on the screen, above the row, clear of it
async function rowTips(page, where, bar, paper) {
  const view = page.viewportSize();
  for (const name of ["The overview: the notebook's pages, and the Shelf", 'Back to 100%', 'New page']) {
    const b = await page.locator('#book [data-island=pages]').getByRole('button', { name, exact: true }).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 2 });
    const tip = page.locator('#bk-tip');
    await tip.waitFor({ state: 'visible', timeout: 10_000 });
    const t = await tip.boundingBox();
    assert.ok(t.y + t.height <= bar.y, `${where}: ${name}'s tooltip above the row`);
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
    assert.ok(await islandsClearOf(page, t), `${where}: ${name}'s tooltip over no control`);
    await page.mouse.move(paper.x + 40, paper.y + 40);
    await tip.waitFor({ state: 'hidden', timeout: 10_000 });
  }
}

// Send's tooltip left of it and of the tools beside it, whole on the screen, over no control
async function sendTip(page, send) {
  await page.mouse.move(send.x + send.width / 2, send.y + send.height / 2, { steps: 2 });
  const tip = page.locator('#bk-tip');
  await tip.waitFor({ state: 'visible', timeout: 10_000 });
  const t = await tip.boundingBox();
  assert.ok(t.x >= 0 && t.x + t.width <= send.x - 2, "desktop: Send's tooltip left of it");
  assert.ok(await islandsClearOf(page, t), "desktop: Send's tooltip over no control");
}
