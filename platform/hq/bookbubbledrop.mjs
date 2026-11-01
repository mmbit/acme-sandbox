// node platform/hq/book-check.mjs --stories 'the small call stays where|call buttons stay readable' [--webkit] [--shots dir]
import assert from 'node:assert/strict';
import { playLine } from './bookcall.mjs';
import { chromiumPen, touchOf, pressAlong, middleOf } from './bookkit.mjs';

const SIZES = [
  { width: 1133, height: 744 },
  { width: 744, height: 1133 },
];

export function bubbleDropStories(c) {
  return Object.fromEntries(
    SIZES.flatMap(viewport => [
      [
        `the small call stays where pen and finger drop it, book open or closed, at ${viewport.width} × ${viewport.height}`,
        browser => dropped(browser, c, viewport),
      ],
      [
        `the call buttons stay readable with pen and touch at ${viewport.width} × ${viewport.height}`,
        browser => readable(browser, c, viewport),
      ],
    ]),
  );
}

async function readable(browser, c, viewport) {
  const context = await c.hqIn(browser, viewport, { notebooks: {}, hasTouch: true });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await playLine(context);
  const hand = await inputs(browser, page);
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom&renderer=wire`);
    await page.waitForSelector('#loading.gone');
    for (const open of viewport.width > viewport.height ? [true, false] : [false]) {
      await book(page, open);
      for (const large of [false, true]) {
        await readableCall({ page, c, viewport, open, large, hand });
      }
    }
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}

async function readableCall({ page, c, viewport, open, large, hand }) {
  if (!(await page.locator('#tool .intercom').isVisible())) await page.locator('#btn-intercom').tap();
  const big = await page.locator('#tool .intercom').evaluate(el => el.classList.contains('big'));
  if (big !== large) await page.locator('#dir-grow').tap();
  await page.locator('#call').tap();
  await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled);
  await page.waitForTimeout(500);
  for (const showing of [false, true, false]) {
    const pressed = await page.locator('#call-screenshare').getAttribute('aria-pressed');
    if (pressed !== String(showing)) await page.locator('#call-screenshare').tap();
    await page.waitForFunction(on => {
      const button = document.querySelector('#call-screenshare');
      return button?.getAttribute('aria-pressed') === String(on) && !button.disabled;
    }, showing);
    await readableKeys(page, c, `${viewport.width}-${open}-${large}-${showing}`);
    if (open && large && showing) await resizedKeys(page, hand, c, viewport);
  }
  await page.locator('#call-end').tap();
  await page.waitForSelector('#call-layer', { state: 'detached' });
}

async function resizedKeys(page, hand, c, viewport) {
  for (const width of [600, 590, 580, 570, 560, 450, 420, 400, 380, 360, 340, 320, 620]) {
    const edge = await page.locator('#book [role=separator]').boundingBox();
    await hand.stroke(width >= 560 ? 'pen' : 'touch', [
      [edge.x + edge.width / 2, viewport.height * 0.7],
      [width + edge.width / 2, viewport.height * 0.7],
    ]);
    if (width >= 560) await openSmallCall(page);
    await page.waitForFunction(() => getComputedStyle(document.body).visibility !== 'hidden');
    await readableKeys(page, c, `${viewport.width}-resized-${width}`);
  }
  await page.locator('#call-min').tap();
  await page.waitForSelector('#call-layer', { state: 'hidden' });
  await hand.pan([
    [viewport.width * 0.8, viewport.height * 0.6],
    [viewport.width * 0.9, viewport.height * 0.6],
  ]);
  await openSmallCall(page);
  await readableKeys(page, c, `${viewport.width}-after-two-finger-pan`);
}

async function openSmallCall(page) {
  await page.waitForSelector('#call-layer', { state: 'hidden' });
  await page.locator('.cb-face').tap();
  await page.waitForSelector('#call-layer', { state: 'visible' });
  await page.waitForSelector('.callbubble', { state: 'detached' });
  await page.waitForFunction(() =>
    document
      .querySelector('#call-layer .device')
      .getAnimations()
      .every(a => a.playState === 'finished'),
  );
}

async function readableKeys(page, c, name) {
  const failures = await page.locator('#call-screen .row button').evaluateAll(buttons =>
    buttons.flatMap(button => {
      const box = button.getBoundingClientRect(),
        broken = [];
      for (const span of button.querySelectorAll('span')) {
        if (!span.getClientRects().length) continue;
        const range = document.createRange();
        range.selectNodeContents(span);
        const lines = [...range.getClientRects()];
        if (new Set(lines.map(r => Math.round(r.top))).size > 1) broken.push(`${span.textContent} wraps`);
      }
      const row = button.parentElement.getBoundingClientRect();
      if (box.left < row.left || box.right > row.right || box.bottom > innerHeight)
        broken.push(`${button.id} outside the call`);
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      if (!button.contains(top)) broken.push(`${button.id} covered`);
      return broken;
    }),
  );
  await c.shot(`call-keys-${name}`, page);
  assert.deepEqual(failures, [], name);
}

async function dropped(browser, c, viewport) {
  const context = await c.hqIn(browser, viewport, { notebooks: {}, hasTouch: true });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await playLine(context);
  const hand = await inputs(browser, page);
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom&renderer=brownstone`);
    await page.waitForSelector('#loading.gone');
    await book(page, false);
    await page.locator('#call').tap();
    await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled);
    await placement(page, c, viewport);
    await page.locator('#call-min').tap();
    await page.waitForSelector('.callbubble');
    await page.waitForTimeout(600);
    await dropEverywhere(page, hand, c, viewport);
    const fitted = await resized(page, hand, c, viewport);
    await tappedOpen(page, hand, fitted);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`call-drop-${viewport.width}-failed`, page);
    throw e;
  } finally {
    await context.close();
  }
}

async function placement(page, c, viewport) {
  console.log(
    'Call window, notebook closed:',
    JSON.stringify(
      await page.evaluate(() => {
        const call = document.querySelector('#call-layer .device').getBoundingClientRect();
        return {
          width: innerWidth,
          height: innerHeight,
          page: document.body.clientWidth,
          call: { left: call.left, right: call.right },
          mode: document.documentElement.dataset.book,
        };
      }),
    ),
  );
  await c.shot(`call-placement-${viewport.width}-closed`, page);
}

async function dropEverywhere(page, hand, c, viewport) {
  const failures = [];
  for (const open of [true, false]) {
    await book(page, open);
    for (const type of ['pen', 'touch']) {
      for (const [fx, fy] of [
        [0.18, 0.27],
        [0.65, 0.43],
        [0.32, 0.68],
      ]) {
        await dropAt(page, hand, type, [viewport.width * fx, viewport.height * fy]).catch(e =>
          failures.push(`${open ? 'open' : 'closed'}: ${e.message}`),
        );
      }
    }
    await c.shot(`call-drop-${viewport.width}-${open ? 'open' : 'closed'}`, page);
  }
  assert.deepEqual(failures, [], failures.join('\n'));
}

async function resized(page, hand, c, viewport) {
  await book(page, true);
  await dropAt(page, hand, 'pen', [viewport.width * 0.23, viewport.height * 0.3]);
  const before = await box(page);
  await resizeBook(page, hand, viewport);
  samePlace(await box(page), before, 'notebook resize preserves the drop');
  await hand.pan([
    [viewport.width * 0.65, viewport.height * 0.6],
    [viewport.width * 0.75, viewport.height * 0.6],
  ]);
  samePlace(await box(page), before, 'two fingers on the notebook leave the call alone');
  await page.setViewportSize({ width: viewport.height, height: viewport.width });
  await page.waitForTimeout(1200);
  samePlace(await box(page), before, 'rotation preserves a drop that still fits');
  await dropAt(page, hand, 'touch', [viewport.height - 200, viewport.width - 200]);
  await page.setViewportSize(viewport);
  await page.waitForTimeout(1200);
  const fitted = await box(page);
  assert.ok(
    fitted.x >= 0 &&
      fitted.y >= 0 &&
      fitted.x + fitted.width <= viewport.width &&
      fitted.y + fitted.height <= viewport.height,
    'rotation keeps the whole tile reachable',
  );
  await c.shot(`call-drop-${viewport.width}-rotated`, page);
  return fitted;
}

async function resizeBook(page, hand, viewport) {
  const leaf = page.locator('#book .bk-leaf'),
    before = await leaf.boundingBox();
  const edge = await page.locator('#book [role=separator]').boundingBox();
  let path;
  if (edge.x >= 0) {
    const start = [edge.x + edge.width / 2, viewport.height * 0.7];
    path = [start, [start[0] + 70, start[1]]];
  } else {
    // Upright, the cover edge is off screen. The tab starts a resize when pulled left first.
    const lip = await page.locator('#book .bk-lip').boundingBox();
    const start = [lip.x + lip.width - 2, lip.y + lip.height / 2];
    // The book stays spread until it leaves HQ at least a phone's width.
    path = [start, [1, start[1]], [start[0] + 370, start[1]]];
  }
  await hand.stroke('touch', path);
  await page.waitForTimeout(1200);
  const after = await leaf.boundingBox();
  assert.ok(Math.abs(after.width - before.width) > 1, 'the finger really resized the notebook');
}

async function tappedOpen(page, hand, fitted) {
  await hand.stroke('pen', [middleOf(await page.locator('.cb-face').boundingBox())]);
  await page.waitForSelector('#call-layer', { state: 'visible' });
  await page.locator('#call-min').tap();
  await page.waitForSelector('.callbubble');
  await page.waitForTimeout(600);
  samePlace(await box(page), fitted, 'a tap opens the call and minimising preserves its drop');
  await page.locator('.cb-hangup').tap();
  await page.waitForSelector('.callbubble', { state: 'detached' });
}

async function book(page, open) {
  const closed = () => page.evaluate(() => ['folded', 'shut'].includes(document.documentElement.dataset.book));
  if ((await closed()) === open) await page.locator('#book .bk-lip').tap();
  await page.waitForFunction(
    open =>
      !document.querySelector('#book.bk-swinging') &&
      !['folded', 'shut'].includes(document.documentElement.dataset.book) === open,
    open,
  );
  await page.waitForTimeout(800);
}

async function dropAt(page, hand, type, [x, y]) {
  const was = await box(page),
    face = middleOf(await page.locator('.cb-face').boundingBox());
  const target = [face[0] + x - was.x, face[1] + y - was.y];
  await hand.stroke(type, [face, target]);
  await page.waitForTimeout(1200);
  samePlace(await box(page), { x, y }, `${type}: release stays at the requested point`);
  assert.equal(await page.locator('#call-layer').isVisible(), false, 'a stroke never opens the call');
}

const box = page => page.locator('.callbubble').boundingBox();
// The coordinates are the user's input, not a prescribed layout. A drop must not snap or throw elsewhere.
function samePlace(actual, expected, why) {
  assert.ok(
    Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1,
    `${why}: dropped at ${expected.x},${expected.y}, found at ${actual.x},${actual.y}`,
  );
}

export async function inputs(browser, page) {
  if (browser.browserType().name() === 'chromium') {
    const cdp = await page.context().newCDPSession(page),
      pen = chromiumPen(cdp),
      touch = touchOf(cdp);
    return {
      stroke: (type, points) => (type === 'pen' ? pen.stroke(points) : touchPath(touch, points)),
      pan: points =>
        touch.stroke(
          points,
          points.map(([x, y]) => [x, y - 70]),
        ),
    };
  }
  return {
    stroke: (type, points) => pressAlong(page, points, { type }),
    pan: points =>
      page.evaluate(points => {
        const target = document.elementFromPoint(...points[0]);
        for (const kind of ['pointerdown', 'pointermove', 'pointerup'])
          points.forEach(([x, y], i) =>
            target.dispatchEvent(
              new PointerEvent(kind, {
                pointerType: 'touch',
                pointerId: 30 + i,
                isPrimary: i === 0,
                bubbles: true,
                clientX: x,
                clientY: y - (kind === 'pointerdown' ? 0 : 70),
                buttons: kind === 'pointerup' ? 0 : 1,
              }),
            ),
          );
      }, points),
  };
}

async function touchPath(touch, points) {
  await touch.down([points[0]]);
  for (const point of points.slice(1)) await touch.move([point]);
  await touch.up();
}
