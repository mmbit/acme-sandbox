// book-check.mjs's stories of the Notebook opening and shutting as a heavy hardcover (shell/ink/bookswing.js), with a mouse
// on an iPad mini's landscape and a finger on a phone, in Chromium. Pulled by its tab, the board turns round the spine
// (never slides or stretches), lagging the hand; HQ's page dissolves under it and comes back, sharp, in its new room;
// the landing ticks once (the haptic, standing in for the thud). Held on after it lands, the same drag resizes it. Let
// go mostly upright, it swings back shut; a flick right shuts the open book; a tap mid-swing turns it round; the tab is a
// button for the keyboard. Each asserts what the board sees: the board's angle, the tab at its edge, HQ's page.
import assert from 'node:assert/strict';
import { MINI, until } from './bookkit.mjs';
import { SETTLE_MAX, SWING } from './shell/ink/bookswingmath.js';

const PHONE = { width: 390, height: 844 };

// c: book-check.mjs's helpers: { hq(browser, viewport, options), shot(name, page), settled(page, mode), settle }
export function openStories(c) {
  return {
    "the Notebook's swing: pulled open it turns round the spine, lagging the hand; it lands with one tick and HQ comes back in its room; held on, the same drag resizes it":
      browser => pulledOpen(browser, c),
    "the Notebook's swing: let go upright it swings back shut; a flick right shuts it; a tap mid-swing turns it round; Enter opens and shuts":
      browser => shutAgain(browser, c),
    "the Notebook's swing on a phone: a tap opens it over the whole screen, its tab inside it, and shuts it": browser =>
      onAPhone(browser, c),
    "the Notebook's swing: shut as opened, HQ's page blurred and faded out wholly before it takes its room, and back in":
      browser => roomWhileGone(browser, c),
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
    const { firstAngle, held } = await lifted(page, tab);
    await c.shot('swing-lifted', page);
    assert.ok(held.angle > 0.3 && held.angle < 1.3, `lifted to ${held.angle.toFixed(2)} rad`);
    assert.ok(firstAngle > held.angle + 0.05, `no lag: ${firstAngle.toFixed(2)} then ${held.angle.toFixed(2)}`);
    // (never stretched: the board's laid out at the width it opens at, turned, its tab at its outer edge)
    assert.equal(held.width, open.width, 'the book stretched while lifted');
    // (held, the tab lifts up, never out: no gap between it and the cover)
    assert.ok(
      Math.abs(held.tabRight - held.edgeLeft) <= 1,
      `the tab at ${held.tabRight}, the edge at ${held.edgeLeft}`,
    );
    assert.ok(held.hq.opacity < 0.95 && held.hq.opacity > 0, `HQ's page dissolving: ${JSON.stringify(held.hq)}`);
    assert.equal(held.shadow, 1, "the book's own shadow, the one it rests with, while it's high");
    // lowered past halfway and let go still: gravity takes it, one tick as it lands, HQ's page back, sharp, in its room
    await page.mouse.move(720, tab.y, { steps: 4 });
    await page.waitForTimeout(500);
    assert.ok((await seen(page)).angle < 1.05, 'lowered past halfway');
    await letGoOneShadow(page, c);
    await hqBack(page);
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
// The tab pressed and pulled quickly left. Gives the board's angle on the first frame after the hand's last move, and
// the board once it rests under the finger. The quicker the hand, the more upright that first frame. Each frame is read
// in the page, as on a loaded worker the board can catch up before a read from here arrives.
async function lifted(page, tab) {
  const caughtUp = () =>
    page.evaluate(() => {
      const angles = window.__angles;
      return angles.length > 3 && Math.abs(angles.at(-1) - angles.at(-4)) < 0.002; // (still over three frames)
    });
  await page.mouse.move(tab.x, tab.y);
  await page.mouse.down();
  await anglesWatched(page);
  await page.mouse.move(850, tab.y, { steps: 3 });
  await until(caughtUp, 'the book caught up with the hand');
  return { firstAngle: await page.evaluate(() => window.__firstAngle()), held: await seen(page) };
}
// Pulled from shut and held on after it lands: it stays put, then the same drag resizes it, wider
async function resizedInTheGesture(page, c, open, tab) {
  await shutBy(page, c);
  await page.mouse.move(tab.x, tab.y);
  await page.mouse.down();
  await page.mouse.move(open.edgeLeft - 40, tab.y, { steps: 4 });
  // (landed flat under the finger, then drawn on: the resize starts once it has lain flat for a few of the swing's own
  // frames, which a loaded worker draws late.)
  await until(async () => (await seen(page)).angle < 0.003, 'the book landed flat under the finger');
  await page.mouse.move(open.edgeLeft - 200, tab.y, { steps: 8 });
  // (the cover's edge where the finger holds the tab, its grip on it kept)
  const edge = open.edgeLeft - 200 + (MINI.width - tab.x);
  await until(async () => Math.abs((await seen(page)).edgeLeft - edge) < 3, `the cover's edge at ${edge}, held`);
  await c.shot('swing-resized', page);
  await page.mouse.up();
  await c.settled(page, 'open');
  await hqBack(page);
  const wider = await seen(page);
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

// The tab tapped, HQ's page watched on every frame from then into __rooms: its room, gone, blurred, opacity, and the
// frame's time on two clocks: the wall clock (t), and the swing's own clock (swung), which steps at most SWING.frame a
// frame, as the swing and its fade do (bookswing.js).
const tappedWatched = page =>
  page.evaluate(longest => {
    const frames = (window.__rooms = []);
    let swung = 0;
    const watch = t => {
      const s = getComputedStyle(document.body);
      if (frames.length) swung += Math.min(longest, t - frames.at(-1).t);
      frames.push({
        room: document.documentElement.style.getPropertyValue('--book-room'),
        gone: s.visibility === 'hidden',
        blurred: s.filter !== 'none',
        opacity: Number(s.opacity),
        t,
        swung,
      });
      if (frames.length < 2000) requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    document.querySelector('#book .bk-lip').click();
  }, SWING.frame * 1000);
// How long HQ's page took to fade out from the tap, stayed gone, and came back in (ms). The fade out is timed on the
// swing's clock (swung), the one its fade plays on: a loaded machine's frames take longer than the swing steps. Gone
// and back are wall-clock time (t), which settling in and coming back in run on.
function phases(frames) {
  const first = frames.findIndex(f => f.gone),
    last = frames.findLastIndex(f => f.gone),
    clear = frames.findLastIndex(f => f.opacity < 1);
  const ms = (i, j, clock = 't') => Math.round(frames[j][clock] - frames[i][clock]);
  return { out: ms(0, first, 'swung'), gone: ms(first, last), back: ms(last, clear), outByWall: ms(0, first) };
}

// Opened and shut by the tab: on every frame HQ's page changes its room (laid out beside the book, or the whole screen
// again), it's wholly gone, so its reflow never shows; it went blurred and faded, as it does on opening, and comes back.
async function roomWhileGone(browser, c) {
  const { page, errors, done } = await c.hq(browser, MINI),
    times = {};
  try {
    // (twice round: the first swing on a slow machine still blurs, till the book turns its blur off there)
    for (const [mode, way] of [
      ['folded', 'shut'],
      ['open', 'opened'],
      ['folded', 'shut'],
      ['open', 'opened'],
    ]) {
      await tappedWatched(page);
      await page.waitForFunction(
        mode =>
          document.documentElement.dataset.book === mode &&
          !document.querySelector('#book.bk-swinging') &&
          getComputedStyle(document.body).opacity === '1',
        mode,
        { timeout: 120_000, polling: 100 },
      );
      const frames = await page.evaluate(() => window.__rooms.splice(0));
      const moved = frames.flatMap((f, i) => (i && f.room !== frames[i - 1].room ? [f] : []));
      assert.equal(moved.length, 1, `${way}: HQ's page took its new room once`);
      assert.ok(moved[0].gone, `${way}: HQ's page wholly gone as it took its room (${JSON.stringify(moved[0])})`);
      // (back: the wait above; the watcher's last frame can come before the one that cleared it)
      assert.ok(
        frames.some(f => f.blurred || f.opacity < 1),
        `${way}: faded`,
      );
      times[way] = phases(frames);
    }
    // (the same timing both ways. Out, on the swing's clock, and back may differ by a third of the longer way's time,
    // plus 50 ms for three 60 Hz frames late on a loaded machine. Gone may differ by SETTLE_MAX more, the time the
    // page's own transitions may take after its reflow (bookswingmath.js).)
    for (const [phase, slack] of [
      ['out', 0],
      ['gone', SETTLE_MAX],
      ['back', 0],
    ])
      assert.ok(
        Math.abs(times.shut[phase] - times.opened[phase]) <=
          Math.max(times.shut[phase], times.opened[phase]) / 3 + 50 + slack,
        `${phase}: shut ${times.shut[phase]} ms, opened ${times.opened[phase]} ms ` +
          `(out by the wall clock: shut ${times.shut.outByWall} ms, opened ${times.opened.outByWall} ms)`,
      );
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
// Let go lowered: it lands open, its own shadow round it all the way down, the same as at rest: nothing pops in
async function letGoOneShadow(page, c) {
  await shadowWatched(page);
  await page.mouse.up();
  await c.settled(page, 'open');
  const drop = await page.evaluate(() => window.__shadows);
  assert.ok(drop.length && drop.every(s => s === 1), `the book's shadow on its drop: ${drop.join(' ')}`);
  assert.equal(await page.locator('#book .bk-cast').count(), 0, 'no second shadow under the book');
  assert.equal((await seen(page)).shadow, 1, "the book's own shadow beside it at rest");
}

// What the board sees: the book's mode, the board's angle round the spine (rad, from its transform), the paper's laid
// width, the cover's edge's and the tab's boxes on the screen, HQ's page's width and how dissolved it is, and how
// strong the book's own shadow on HQ's page beside it is
export const seen = page =>
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
// The board's angle round the spine on every frame since the hand's last move, into __angles. Each move starts the
// list again. Its listener is added after bookfollow.js's, so each frame's read is the swing's step for that move.
// __firstAngle() stops the reads and gives the first.
const anglesWatched = page =>
  page.evaluate(() => {
    const edge = document.querySelector('#book .bk-edge');
    let frame = 0;
    const read = () => {
      const m = new DOMMatrix(getComputedStyle(edge).transform);
      window.__angles.push(Math.abs(Math.atan2(m.m13, m.m11)));
      frame = requestAnimationFrame(read);
    };
    const moved = () => {
      window.__angles = [];
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    window.__angles = [];
    addEventListener('pointermove', moved);
    window.__firstAngle = () => {
      removeEventListener('pointermove', moved);
      cancelAnimationFrame(frame);
      return window.__angles[0];
    };
  });
// HQ's page back in, sharp, after settling in its room while gone
const hqBack = page =>
  page.waitForFunction(() => Number(document.body.style.opacity || 1) === 1 && !document.body.style.filter);
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
export const tabAt = page =>
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
