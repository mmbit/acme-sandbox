// node platform/hq/book-check.mjs --stories 'call buttons stay readable' [--webkit] [--shots dir]
import assert from 'node:assert/strict';
import { playLine } from './bookcall.mjs';
import { inputs } from './bookhands.mjs';
import { MINI, UPRIGHT, bookOpen } from './bookkit.mjs';
import { openSmallCall, minimiseCall } from './bookcallview.mjs';

export function callKeyStories(c) {
  return Object.fromEntries(
    [MINI, UPRIGHT].map(viewport => [
      `the call buttons stay readable with pen and touch at ${viewport.width} × ${viewport.height}`,
      browser => readable(browser, c, viewport),
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
      await bookOpen(page, open);
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
  await minimiseCall(page);
  await hand.pan([
    [viewport.width * 0.8, viewport.height * 0.6],
    [viewport.width * 0.9, viewport.height * 0.6],
  ]);
  await openSmallCall(page);
  await readableKeys(page, c, `${viewport.width}-after-two-finger-pan`);
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
