// node platform/hq/book-check.mjs --stories 'a page reaches the waiting call' [--webkit] [--shots dir]
import assert from 'node:assert/strict';
import { playLine } from './bookcall.mjs';
import { cornerOf, shownOnCall } from './bookshare.mjs';
import { inputs } from './bookbubbledrop.mjs';
import { MINI, UPRIGHT, chromiumPen, touchOf, middleOf, pressAlong, until } from './bookkit.mjs';

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
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom&renderer=brownstone`);
    await page.waitForSelector('#loading.gone');
    await page.locator('#call').tap();
    await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled);
    await page.locator('#call-min').tap();
    await page.waitForSelector('#call-layer', { state: 'hidden' });
    if (await page.evaluate(() => document.documentElement.dataset.book === 'folded'))
      await page.locator('#book .bk-lip').tap();
    await c.settled(page, viewport === MINI ? 'open' : 'spread');
    await page.waitForTimeout(600);
    await dropPages(browser, page, line, c, viewport);
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

async function dropPages(browser, page, line, c, viewport) {
  const connection = line.ws;
  let pictures = 0;
  for (const manual of [false, true]) {
    if (manual) {
      const hand = await inputs(browser, page),
        from = middleOf(await page.locator('.cb-face').boundingBox());
      await hand.stroke('touch', [from, [viewport.width * 0.45, viewport.height * 0.55]]);
    }
    for (const type of ['pen', 'touch']) {
      await ontoCall(browser, page, type, c, `${viewport.width}-${manual}-${type}`);
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
      await page.locator('#call-min').tap();
      await page.waitForSelector('#call-layer', { state: 'hidden' });
      if (viewport === UPRIGHT) {
        await page.locator('#book .bk-lip').tap();
        await c.settled(page, 'spread');
      }
      await page.waitForTimeout(600);
    }
  }
  assert.equal(line.said.filter(message => message.type === 'picture').length, pictures, 'each drop sends once');
}

async function ontoCall(browser, page, type, c, name) {
  const target = middleOf(await page.locator('.cb-face').boundingBox()),
    from = middleOf(await (await cornerOf(page)).boundingBox()),
    peeled = [from[0] - 45, from[1] + 35];
  const pointer = await holding(browser, page, type, from);
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

async function holding(browser, page, type, from) {
  if (browser.browserType().name() !== 'chromium') {
    const held = await pressAlong(page, [from], { type, lift: false });
    return { move: point => held.along([point]), up: () => held.up() };
  }
  const cdp = await page.context().newCDPSession(page);
  if (type === 'pen') {
    const pen = chromiumPen(cdp);
    await pen.down(from);
    return { move: point => pen.move(point), up: point => pen.up(point) };
  }
  const touch = touchOf(cdp);
  await touch.down([from]);
  return { move: point => touch.move([point]), up: () => touch.up() };
}
