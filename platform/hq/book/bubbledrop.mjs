// node platform/hq/book-check.mjs --stories 'the small call stays where' [--webkit] [--shots dir]
import assert from 'node:assert/strict';
import { playLine } from './call.mjs';
import { MINI, UPRIGHT, middleOf, bookOpen } from './kit.mjs';
import { inputs } from './hands.mjs';
import { minimiseCall } from './callview.mjs';
import { watchedPage } from './start.mjs';

export function bubbleDropStories(c) {
  return Object.fromEntries(
    [MINI, UPRIGHT].map(viewport => [
      `the small call stays where pen and finger drop it, book open or closed, at ${viewport.width} × ${viewport.height}`,
      browser => dropped(browser, c, viewport),
    ]),
  );
}

async function dropped(browser, c, viewport) {
  const context = await c.hqIn(browser, viewport, { notebooks: {}, hasTouch: true });
  const { page, errors } = await watchedPage(context);
  await playLine(context);
  const hand = await inputs(page);
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom&renderer=brownstone`);
    await page.waitForSelector('#loading.gone');
    await bookOpen(page, false);
    await page.locator('#call').tap();
    await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled);
    await placement(page, c, viewport);
    await minimiseCall(page);
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
    await bookOpen(page, open);
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
  await bookOpen(page, true);
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
  await minimiseCall(page);
  samePlace(await box(page), fitted, 'a tap opens the call and minimising preserves its drop');
  await page.locator('.cb-hangup').tap();
  await page.waitForSelector('.callbubble', { state: 'detached' });
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
