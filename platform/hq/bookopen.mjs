// book-check.mjs's stories of the Notebook opening and shutting as a heavy hardcover (shell/ink/bookswing.js), with a mouse
// on an iPad mini's landscape and a finger on a phone, in Chromium. Pulled by its tab, the board turns round the spine
// (never slides or stretches), lagging the hand; HQ's page dissolves under it and comes back, sharp, in its new room;
// the landing ticks once (the haptic, standing in for the thud). Held on after it lands, the same drag resizes it. Let
// go mostly upright, it swings back shut; a flick right shuts the open book; a tap mid-swing turns it round; the tab is a
// button for the keyboard. Each asserts what the board sees: the board's angle, the tab at its edge, HQ's page.
import assert from 'node:assert/strict';

const MINI = { width: 1133, height: 744 },
  PHONE = { width: 390, height: 844 };

// c: book-check.mjs's helpers: { hq(browser, viewport, options), shot(name, page), settled(page, mode), settle }
export function openStories(c) {
  return {
    "the Notebook's swing: pulled open it turns round the spine, lagging the hand; it lands with one tick and HQ comes back in its room; held on, the same drag resizes it":
      browser => pulledOpen(browser, c),
    "the Notebook's swing: let go upright it swings back shut; a flick right shuts it; a tap mid-swing turns it round; Enter opens and shuts":
      browser => shutAgain(browser, c),
    "the Notebook's swing on a phone: a tap opens it over the whole screen, its tab inside it, and shuts it": browser =>
      onAPhone(browser, c),
  };
}

// ---- the stories

async function pulledOpen(browser, c) {
  const { page, errors, done } = await c.hq(browser, MINI);
  try {
    const open = await seen(page);
    await shutBy(page, c);
    await ticks(page);
    const tab = await tabAt(page);
    await page.mouse.move(tab.x, tab.y);
    await page.mouse.down();
    // the hand moves quicker than the board: right after the move it's still more upright than under the finger
    await page.mouse.move(850, tab.y, { steps: 3 });
    const early = await seen(page);
    await page.waitForTimeout(700);
    const held = await seen(page);
    await c.shot('swing-lifted', page);
    assert.ok(held.angle > 0.3 && held.angle < 1.3, `lifted to ${held.angle.toFixed(2)} rad`);
    assert.ok(early.angle > held.angle + 0.05, `no lag: ${early.angle.toFixed(2)} then ${held.angle.toFixed(2)}`);
    // (never stretched: the board's laid out at the width it opens at, turned, its tab at its outer edge)
    assert.equal(held.width, open.width, 'the book stretched while lifted');
    assert.ok(Math.abs(held.tabRight - held.edgeLeft) < 6, `the tab at ${held.tabRight}, the edge at ${held.edgeLeft}`);
    assert.ok(held.hq.opacity < 0.95 && held.hq.opacity > 0, `HQ's page dissolving: ${JSON.stringify(held.hq)}`);
    // lowered past halfway and let go still: gravity takes it, one tick as it lands, HQ's page back, sharp, in its room
    await page.mouse.move(720, tab.y, { steps: 4 });
    await page.waitForTimeout(500);
    assert.ok((await seen(page)).angle < 1.05, 'lowered past halfway');
    await page.mouse.up();
    await c.settled(page, 'open');
    await page.waitForTimeout(600);
    const landed = await seen(page);
    assert.equal(landed.mode, 'open');
    assert.equal(landed.angle, 0);
    assert.equal(landed.page, open.page, 'HQ is back at its open width');
    assert.deepEqual(landed.hq, { opacity: 1, filter: '', visibility: '' }, "HQ's page clear at rest");
    assert.equal(await ticks(page), 1, 'one tick as it lands');
    await resizedInTheGesture(page, c, open, tab);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
// Pulled from shut and held on after it lands: it stays put, then the same drag resizes it, wider
async function resizedInTheGesture(page, c, open, tab) {
  await shutBy(page, c);
  await page.mouse.move(tab.x, tab.y);
  await page.mouse.down();
  await page.mouse.move(open.edgeLeft - 40, tab.y, { steps: 4 });
  await page.waitForTimeout(900);
  await page.mouse.move(open.edgeLeft - 200, tab.y, { steps: 8 });
  await page.waitForTimeout(400);
  await c.shot('swing-resized', page);
  await page.mouse.up();
  await c.settled(page, 'open');
  await page.waitForTimeout(600);
  // (the cover's edge where the finger holds the tab, its grip on it kept)
  const wider = await seen(page),
    edge = open.edgeLeft - 200 + (MINI.width - tab.x);
  assert.ok(Math.abs(wider.page - edge) < 3, `HQ's page ${wider.page}, not ${edge}`);
}

async function shutAgain(browser, c) {
  const { page, errors, done } = await c.hq(browser, MINI);
  try {
    await shutBy(page, c);
    await ticks(page);
    const tab = await tabAt(page);
    // lifted a little and let go: back up, shut, no tick
    await page.mouse.move(tab.x, tab.y);
    await page.mouse.down();
    await page.mouse.move(tab.x - 60, tab.y, { steps: 4 });
    await page.waitForTimeout(500);
    assert.ok((await seen(page)).angle > 1.05, 'lifted only a little');
    await page.mouse.up();
    await page.waitForTimeout(1200);
    let now = await seen(page);
    assert.equal(now.mode, 'folded');
    assert.equal(now.angle, 0, 'at rest, untransformed');
    assert.equal(await ticks(page), 0, 'a close never thuds');
    // open by a tap, then flicked right: shut
    await page.click('#book .bk-lip');
    await c.settled(page, 'open');
    const open = await tabAt(page);
    await page.mouse.move(open.x, open.y);
    await page.mouse.down();
    await page.mouse.move(open.x + 60, open.y, { steps: 2 });
    await page.mouse.up();
    await c.settled(page, 'folded');
    assert.equal((await seen(page)).mode, 'folded', 'a flick right shuts it');
    // a tap mid-swing turns it round: opening, it's shut again
    await page.click('#book .bk-lip');
    await page.waitForTimeout(120);
    const midway = await seen(page);
    assert.ok(midway.angle > 0.05, `mid-swing at ${midway.angle.toFixed(2)}`);
    await page.click('#book .bk-lip');
    await page.waitForTimeout(1500);
    assert.equal((await seen(page)).mode, 'folded', 'turned round mid-swing');
    // the keyboard: the tab is a button, Enter opens and shuts
    await page.focus('#book .bk-lip');
    await page.keyboard.press('Enter');
    await c.settled(page, 'open');
    assert.equal((await seen(page)).mode, 'open', 'Enter opens it');
    await page.keyboard.press('Enter');
    await c.settled(page, 'folded');
    assert.equal((await seen(page)).mode, 'folded', 'Enter shuts it');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function onAPhone(browser, c) {
  const { page, errors, done } = await c.hq(browser, PHONE);
  try {
    assert.equal((await seen(page)).mode, 'folded');
    await page.tap('#book .bk-lip');
    await page.waitForTimeout(150);
    const midway = await seen(page);
    assert.ok(midway.angle > 0.05, `mid-swing at ${midway.angle.toFixed(2)}`);
    assert.ok(midway.tabLeft >= 0, `the tab off the screen: ${midway.tabLeft}`);
    await c.settled(page, 'spread');
    const over = await seen(page);
    await c.shot('swing-phone', page);
    assert.equal(over.mode, 'spread');
    assert.ok(over.tabLeft >= 0 && over.tabLeft < 4, `the tab at ${over.tabLeft}, inside the screen's left edge`);
    // (the book lies over HQ's page: it never dissolves)
    assert.equal(midway.hq.opacity, 1);
    await page.tap('#book .bk-lip');
    await c.settled(page, 'folded');
    assert.equal((await seen(page)).mode, 'folded');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// ---- helpers

// What the board sees: the book's mode, the board's angle round the spine (rad, from its transform), the paper's laid
// width, the cover's edge's and the tab's boxes on the screen, HQ's page's width and how dissolved it is
const seen = page =>
  page.evaluate(() => {
    const edge = document.querySelector('#book .bk-edge'),
      leaf = document.querySelector('#book .bk-leaf'),
      tab = document.querySelector('#book .bk-lip').getBoundingClientRect(),
      m = new DOMMatrix(getComputedStyle(edge).transform),
      look = document.body.style;
    return {
      mode: document.documentElement.dataset.book,
      angle: Math.abs(Math.atan2(m.m13, m.m11)),
      width: leaf.offsetWidth,
      edgeLeft: Math.round(edge.getBoundingClientRect().left),
      tabLeft: Math.round(tab.left),
      tabRight: Math.round(tab.right),
      page: Math.round(document.body.getBoundingClientRect().width),
      hq: { opacity: Number(look.opacity || 1), filter: look.filter, visibility: look.visibility },
    };
  });
// The tab's middle
const tabAt = page =>
  page
    .locator('#book .bk-lip')
    .boundingBox()
    .then(r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }));
// The book shut by a tap of its tab, settled
async function shutBy(page, c) {
  await page.click('#book .bk-lip');
  await c.settled(page, 'folded');
  await page.waitForTimeout(400);
}
// The haptic ticks since last asked (navigator.vibrate counted: Chromium on Linux has none of its own)
const ticks = page =>
  page.evaluate(() => {
    const n = window.__ticks ?? 0;
    window.__ticks = 0;
    navigator.vibrate = () => ((window.__ticks = (window.__ticks ?? 0) + 1), true);
    return n;
  });
