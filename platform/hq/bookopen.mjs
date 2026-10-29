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
    // (held, the tab lifts up, never out: no gap between it and the cover, the board's call 149)
    assert.ok(
      Math.abs(held.tabRight - held.edgeLeft) <= 1,
      `the tab at ${held.tabRight}, the edge at ${held.edgeLeft}`,
    );
    assert.ok(held.hq.opacity < 0.95 && held.hq.opacity > 0, `HQ's page dissolving: ${JSON.stringify(held.hq)}`);
    assert.ok(held.shadow < 0.1, `the book's own shadow beside it while it's high: ${held.shadow}`);
    // lowered past halfway and let go still: gravity takes it, one tick as it lands, HQ's page back, sharp, in its room
    await page.mouse.move(720, tab.y, { steps: 4 });
    await page.waitForTimeout(500);
    assert.ok((await seen(page)).angle < 1.05, 'lowered past halfway');
    await letGoShadowGrowing(page, c);
    // (HQ's page settles in its room while it's gone, then comes back in slowly: the board's call 148)
    await page.waitForFunction(
      () => Number(document.body.style.opacity || 1) === 1 && !document.body.style.filter,
      null,
      { timeout: 15_000 },
    );
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
    await c.settled(page, 'folded');
    let now = await seen(page);
    assert.equal(now.mode, 'folded');
    assert.equal(now.angle, 0, 'at rest, untransformed');
    assert.equal(await ticks(page), 0, 'a close never thuds');
    // open by a tap, then flicked right: shut
    await page.click('#book .bk-lip');
    await c.settled(page, 'open');
    await flicked(page, 60);
    await c.settled(page, 'folded');
    assert.equal((await seen(page)).mode, 'folded', 'a flick right shuts it');
    await turnedRound(page, c);
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
    // (at the book's edge, the margin in that shows its shadow)
    assert.ok(over.tabLeft >= 0 && over.tabLeft < 24, `the tab at ${over.tabLeft}, inside the screen's left edge`);
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

// A tap mid-swing turns it round: opening, it's shut again, never having lain open
async function turnedRound(page, c) {
  await page.evaluate(() => {
    window.__layOpen = false;
    document.addEventListener('book:layout', e => (window.__layOpen ||= e.detail.mode !== 'folded'));
  });
  await page.click('#book .bk-lip');
  await swingDrawn(page);
  const midway = await seen(page);
  assert.ok(midway.angle > 0.05, `mid-swing at ${midway.angle.toFixed(2)}`);
  // The tab's own click(): Playwright's page.click waits for the tab to hold still, and on a loaded machine that's
  // not till the swing is over
  await page.$eval('#book .bk-lip', lip => lip.click());
  await c.settled(page, 'folded');
  assert.equal(await page.evaluate(() => window.__layOpen), false, 'turned round mid-swing, not landed and shut');
}
// Let go lowered: it lands open, its own shadow on HQ's page beside it growing in with its drop
async function letGoShadowGrowing(page, c) {
  await shadowWatched(page);
  await page.mouse.up();
  await c.settled(page, 'open');
  const drop = await page.evaluate(() => window.__shadows);
  assert.ok(
    drop.some(s => s > 0.05 && s < 0.95),
    `the shadow beside the book popped in: ${drop.map(s => s.toFixed(2)).join(' ')}`,
  );
  assert.equal((await seen(page)).shadow, 1, "the book's own shadow beside it at rest");
}

// What the board sees: the book's mode, the board's angle round the spine (rad, from its transform), the paper's laid
// width, the cover's edge's and the tab's boxes on the screen, HQ's page's width and how dissolved it is, and how
// strong the book's own shadow on HQ's page beside it is
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
      shadow: (s => (s.visibility === 'visible' ? Number(s.opacity) : 0))(getComputedStyle(edge, '::before')),
    };
  });
// The book's own shadow on HQ's page beside it (how strong it is) on every frame while it swings, into __shadows
const shadowWatched = page =>
  page.evaluate(() => {
    const edge = document.querySelector('#book .bk-edge'),
      book = document.getElementById('book');
    window.__shadows = [];
    const frame = () => {
      if (!book.classList.contains('bk-swinging')) return;
      const s = getComputedStyle(edge, '::before');
      window.__shadows.push(s.visibility === 'visible' ? Number(s.opacity) : 0);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
// The swing's first frame drawn: the cover's edge turned round the spine
const swingDrawn = page =>
  page.waitForFunction(() => document.querySelector('#book .bk-edge').style.transform.includes('rotateY'));
// A flick on the tab dx px (+ right), its pointer events and the click a browser sends after them dispatched in one
// go. Playwright's mouse moves can come further apart than bookfollow.js's FLICK_MS on a loaded machine, and then the
// flick reads as still.
const flicked = (page, dx) =>
  page.evaluate(dx => {
    const lip = document.querySelector('#book .bk-lip'),
      r = lip.getBoundingClientRect(),
      [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
    const at = (type, clientX) =>
      lip.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          composed: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX,
          clientY: y,
        }),
      );
    at('pointerdown', x);
    at('pointermove', x + dx / 2);
    at('pointermove', x + dx);
    at('pointerup', x + dx);
    lip.click();
  }, dx);
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
