// node --test platform/hq/shell/callbubble.test.js (requires Chromium)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launched, openPage } from '../../../shared/browser/browser.mjs';

const browser = await launched();
assert.ok(browser, 'Call position checks require Chromium');
after(() => browser.close());

test('a new call bubble restores the position saved by a drop', async () => {
  const { context, page, errors } = await bubblePage();
  try {
    await page.evaluate(createBubble);
    const face = await page.locator('.cb-face').boundingBox();
    await page.mouse.move(face.x + face.width / 2, face.y + face.height / 2);
    await page.mouse.down();
    await page.mouse.move(230, 310, { steps: 4 });
    await page.mouse.up();
    const dropped = await page.locator('.callbubble').boundingBox();
    await page.evaluate(() => window.bubble.close());
    await page.reload();
    await page.evaluate(createBubble);
    const restored = await page.locator('.callbubble').boundingBox();
    assert.equal(restored.x, dropped.x, 'the saved horizontal drop survives a reload');
    assert.equal(restored.y, dropped.y, 'the saved vertical drop survives a reload');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a broken stored position raises its parse error instead of placing the call automatically', async () => {
  const { context, page } = await bubblePage();
  try {
    // Intentionally corrupt storage to exercise the reported broken-write failure.
    await page.evaluate(() => localStorage.setItem('callPosition', '{'));
    await assert.rejects(page.evaluate(createBubble), /SyntaxError/);
    assert.equal(await page.locator('.callbubble').count(), 0);
  } finally {
    await context.close();
  }
});

async function bubblePage() {
  const opened = await openPage(browser, { viewport: { width: 744, height: 1133 }, reducedMotion: 'reduce' });
  await opened.context.route('https://call.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('.js'))
      return route.fulfill({
        contentType: 'text/javascript',
        body: await readFile(new URL(`.${path}`, import.meta.url), 'utf8'),
      });
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><style>.callbubble { position: fixed; width: 120px; height: 70px; }</style>',
    });
  });
  await opened.page.goto('https://call.test');
  return opened;
}

async function createBubble() {
  const { CallBubble } = await import('/callbubble.js');
  window.bubble = new CallBubble({
    words: { call: 'Call', open: 'Open call', watched: 'Watching', pause: 'Pause', hangUp: 'Hang up' },
    face: document.createTextNode('Open call'),
    keep: 'callPosition',
  });
  window.bubble.show();
}
