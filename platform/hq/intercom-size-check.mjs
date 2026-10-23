#!/usr/bin/env node
// The intercom's size: it opens small, the corner's key makes it larger and back, and it opens at the size the board
// last chose, after a reload too. Its size and close keys stay clear of the box under them and on the screen, and the
// empty field's hint shows whole. In every look, on a phone and a laptop.
//   node platform/hq/intercom-size-check.mjs [--shots dir]
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const browser = await playwright().chromium.launch();

// the keys, the box under them (the screen, or what's in it when the look draws no frame round it) and the field
const measure = page =>
  page.evaluate(() => {
    const screen = document.querySelector('.intercom > .screen');
    const box = (
      parseFloat(getComputedStyle(screen).borderTopWidth) ? screen : screen.querySelector('#chat')
    ).getBoundingClientRect();
    const keys = [...document.querySelectorAll('.intercom header :is(#dir-grow, .x)')]
      .map(k => k.getBoundingClientRect())
      .map(r => ({ bottom: r.bottom, right: r.right }));
    const d = document.querySelector('.device.intercom').getBoundingClientRect(),
      field = document.querySelector('#dir-title');
    return {
      keys,
      box: { top: box.top },
      device: { width: d.width, right: d.right, bottom: d.bottom },
      // (a hint that wraps past the field's one row makes it taller inside than out)
      hintCut: field.scrollHeight > field.clientHeight,
      big: document.querySelector('.device.intercom').classList.contains('big'),
      pressed: document.querySelector('#dir-grow').getAttribute('aria-pressed'),
    };
  });

for (const look of ['wire', 'brownstone', 'holo'])
  for (const [width, height] of [
    [390, 844],
    [1280, 800],
  ]) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width, height },
      deviceScaleFactor: shots ? 2 : 1,
    });
    page.setDefaultTimeout(90_000); // (the stage draws behind it: slow on a busy machine's software GL)
    const where = `${look} ${width}`,
      url = `${base}/?intro=0&renderer=${look}&open=intercom`;
    // (measured once it has come in: the box's own animations finished)
    const settled = async () => {
      await page.waitForFunction(
        () =>
          document
            .querySelector('.device.intercom')
            ?.getAnimations()
            .every(a => a.playState === 'finished'),
        null,
        { polling: 250 },
      );
      return measure(page);
    };
    const open = async () => {
      await page.goto(url);
      await page.waitForSelector('#dir-grow');
      return settled();
    };
    // nothing stored: the small one, its keys clear of the box under them and on the screen, its hint whole
    let m = await open();
    assert.equal(m.big, false, `${where}: opens small`);
    for (const k of m.keys) {
      assert.ok(k.bottom <= m.box.top, `${where}: a key reaches ${(k.bottom - m.box.top).toFixed(1)} px into the box`);
      assert.ok(k.right <= width, `${where}: a key runs ${(k.right - width).toFixed(1)} px off the screen`);
    }
    assert.equal(m.hintCut, false, `${where}: the field's hint is cut off`);
    if (shots)
      await page.screenshot({
        path: `${shots}/${look}-${width}.png`,
        clip: await page.locator('.device.intercom').boundingBox(),
      });
    const small = m.device.width;
    // larger, then a reload: larger, within the screen
    await page.click('#dir-grow');
    assert.equal((await settled()).big, true, `${where}: the key makes it larger`);
    m = await open();
    assert.equal(m.big, true, `${where}: opens larger after a reload`);
    assert.equal(m.pressed, 'true', `${where}: the key shows it's larger`);
    assert.ok(
      m.device.right <= width && m.device.bottom <= height && m.device.width >= small,
      `${where}: the larger one fits the screen`,
    );
    // back to small, then a reload: small
    await page.click('#dir-grow');
    m = await open();
    assert.equal(m.big, false, `${where}: opens small again after a reload`);
    assert.deepEqual(errors, [], `${where}: no errors`);
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
    console.log(`ok ${where}`);
  }
await browser.close();
server.close();
console.log('intercom-size-check: passed');
