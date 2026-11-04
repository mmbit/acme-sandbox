// node platform/hq/book-check.mjs --stories 'a page reaches the waiting call' [--webkit] [--shots dir]
// A page torn off at its spine (shell/ink/booktear.js) with the Pencil and a finger, carried onto a minimised call's
// bubble and let go there.
import assert from 'node:assert/strict';
import { playLine } from './call.mjs';
import { shownOnCall } from './share.mjs';
import { spineOf } from './tearing.mjs';
import { inputs } from './hands.mjs';
import { minimiseCall } from './callview.mjs';
import { MINI, UPRIGHT, middleOf, until } from './kit.mjs';
import { watchedPage } from './start.mjs';

export function callDropStories(c) {
  return Object.fromEntries(
    [MINI, UPRIGHT].map(viewport => [
      `a page reaches the waiting call with pen and finger at ${viewport.width} × ${viewport.height}`,
      browser => waitingCall(browser, c, viewport),
    ]),
  );
}

async function waitingCall(browser, c, viewport) {
  const context = await c.hqIn(browser, viewport, { hasTouch: true, notebooks: {} });
  const line = await playLine(context);
  await context.route(`${c.base}/api/book/picture**`, route =>
    route.fulfill({ contentType: 'image/png', body: Buffer.from(c.SNIP.split(',')[1], 'base64') }),
  );
  let uploaded = 0;
  await context.route(`${c.base}/api/pictures**`, route =>
    route.fulfill({ json: { id: ++uploaded, type: 'image/jpeg' } }),
  );
  const { page, errors } = await watchedPage(context);
  const hand = await inputs(browser, page);
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom&renderer=brownstone`);
    await page.waitForSelector('#loading.gone');
    await page.locator('#call').tap();
    await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled);
    await minimiseCall(page);
    if (await page.evaluate(() => document.documentElement.dataset.book === 'folded'))
      await page.locator('#book .bk-lip').tap();
    await c.settled(page, viewport === MINI ? 'open' : 'spread');
    await page.waitForTimeout(600);
    await dropPages(hand, page, line, c, viewport);
    await page.locator('.cb-hangup').tap();
    await page.waitForSelector('.callbubble', { state: 'detached' });
    c.noErrorsIn(errors);
  } catch (error) {
    await c.shot(`page-call-${viewport.width}-failed`, page);
    throw error;
  } finally {
    await context.close();
  }
}

async function dropPages(hand, page, line, c, viewport) {
  const connection = line.ws;
  let pictures = 0;
  for (const manual of [false, true]) {
    if (manual) {
      const from = middleOf(await page.locator('.cb-face').boundingBox());
      await hand.stroke('touch', [from, [viewport.width * 0.45, viewport.height * 0.55]]);
    }
    for (const type of ['pen', 'touch']) {
      await ontoCall(hand, page, type, c, `${viewport.width}-${manual}-${type}`);
      await shownOnCall({ line }, ++pictures, 'the page dropped at the call seen before picking it up');
      assert.equal(line.ws, connection, 'the page reaches the existing call');
      const before = line.audioBytes;
      await until(() => line.audioBytes > before, 'the microphone continues after the drop');
      assert.equal(await page.locator('#book > .bk-held').count(), 0, 'the carried page is put away');
      if (!(await page.locator('#call-layer').isVisible())) await page.locator('.cb-face').tap();
      await page.waitForSelector('.callbubble', { state: 'detached' });
      if (viewport === UPRIGHT) {
        await page.locator('#book .bk-lip').tap();
        await c.settled(page, 'folded');
      }
      await page.locator('#call-screenshare').tap();
      await page.waitForFunction(() => !document.querySelector('#call-screenshare').disabled);
      await minimiseCall(page);
      if (viewport === UPRIGHT) {
        await page.locator('#book .bk-lip').tap();
        await c.settled(page, 'spread');
      }
      await page.waitForTimeout(600);
    }
  }
  assert.equal(line.said.filter(message => message.type === 'picture').length, pictures, 'each drop sends once');
}

async function ontoCall(hand, page, type, c, name) {
  const target = middleOf(await page.locator('.cb-face').boundingBox()),
    from = await spineOf(page),
    peeled = [from[0] - 60, from[1] + 12];
  const pointer = await hand.hold(type, from);
  await pointer.move(peeled);
  await page.locator('#book .bk-share[data-mode=carrying]').waitFor();
  // The hand keeps aiming at the call it saw before lifting the page.
  await page.waitForTimeout(650);
  await pointer.move(target);
  await page.waitForTimeout(650);
  await c.shot(`page-call-${name}`, page);
  assert.equal(await page.locator('.callbubble').getAttribute('data-drop'), '', 'the waiting call takes the page');
  await pointer.up(target);
  await page.waitForSelector('#book > .bk-held', { state: 'detached' });
}
