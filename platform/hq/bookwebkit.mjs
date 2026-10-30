// book-check.mjs's story of the board's controls on an iPad mini in WebKit, the iPad's engine (--stories "in WebKit"
// --webkit): the Pencil and a finger as Safari hands them over (pointer events on what's under them), the strip slid
// along to a tool, the Pencil and a finger writing, a double tap held a voice note whose words land where it held, and
// the radial menu on a long press. Chromium's trusted touch and pen: bookstrip.mjs.
import assert from 'node:assert/strict';
import { freePage, paperBox, savedWhere } from './bookmouse.mjs';
import { QUIET_MS, HEARD, heard, middleOf, pressed, stored } from './bookstrip.mjs';
import { MINI, until } from './bookkit.mjs';

// c: book-check.mjs's played store and helpers
export function webkitStories(c) {
  return {
    'controls on an iPad mini in WebKit: the strip slid, the Pencil and a finger drawing, a double tap held, the radial menu':
      browser => webkit(browser, c),
  };
}

async function webkit(browser, c) {
  const free = freePage(c);
  const context = await c.hqIn(browser, MINI, { hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await heard(page);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    await c.settled(page, 'open');
    const paper = await paperBox(page),
      mid = [paper.x + paper.width / 2, paper.y + paper.height / 2];
    await slidAndDrawn(page, c, free, mid);
    await voiceAndRing(page, c, free, mid);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// The Pencil held on Select slides down the strip to the eraser, its name showing, and lifts there; then the Pencil
// writes, and so does a finger
async function slidAndDrawn(page, c, free, mid) {
  const b = name => page.locator('#book .bk-strip').getByRole('button', { name, exact: true }).boundingBox();
  const [select, eraser] = [middleOf(await b('Select')), middleOf(await b('Eraser'))];
  await safari(page, 'pen', 'pointerdown', select);
  await page.waitForTimeout(300);
  await safari(page, 'pen', 'pointermove', eraser);
  await until(async () => (await page.locator('#bk-tip').textContent()).startsWith('Eraser'), "the eraser's name");
  await safari(page, 'pen', 'pointerup', eraser);
  await until(async () => (await pressed(page)) === 'Eraser', 'the eraser picked by the slide');
  await page.locator('#book .bk-strip').getByRole('button', { name: 'Pen', exact: true }).tap();
  // the Pencil writes, and so does a finger
  await safariLine(page, 'pen', [mid[0] - 120, mid[1] - 80], [mid[0] + 60, mid[1] - 80]);
  await savedWhere(c, free.id, p => p.ink.length === 1);
  await safariLine(page, 'touch', [mid[0] - 120, mid[1] - 20], [mid[0] + 60, mid[1] - 20]);
  await savedWhere(c, free.id, p => p.ink.length === 2);
}
// A double tap held: a voice note, its words where it held, the first tap's dot taken off; then the radial menu on, a
// long press opens the ring, and a slide to the highlighter and a lift take it
async function voiceAndRing(page, c, free, mid) {
  const at = [mid[0] - 40, mid[1] + 60];
  await safari(page, 'pen', 'pointerdown', at);
  await safari(page, 'pen', 'pointerup', at);
  await page.waitForTimeout(120);
  await safari(page, 'pen', 'pointerdown', at);
  await page.locator('#book .bk-voice').waitFor({ timeout: 2000 });
  await until(async () => (await page.locator('#book .bk-voice').textContent()).includes(HEARD), 'the words heard');
  await c.shot('book-voice-webkit', page);
  await safari(page, 'pen', 'pointerup', at);
  const saved = await savedWhere(c, free.id, p => p.texts.length === 1);
  assert.equal(saved.texts[0].text, HEARD);
  await page.waitForTimeout(QUIET_MS);
  assert.equal(stored(c, free).ink.length, 2, "the double tap's dot taken off");
  // the radial menu on: a long press opens the ring, a slide to the highlighter and a lift take it
  await page.evaluate(() => localStorage.setItem('ink.prefs', JSON.stringify({ radial: true })));
  const ring = [mid[0] + 40, mid[1] + 160];
  await safari(page, 'pen', 'pointerdown', ring);
  await page.locator('#book .bk-radial [role=menuitemradio]').first().waitFor({ timeout: 2000 });
  const lit = middleOf(
    await page.locator('#book .bk-radial').getByRole('menuitemradio', { name: 'Marker' }).boundingBox(),
  );
  await safari(page, 'pen', 'pointermove', lit);
  await c.shot('book-radial-webkit', page);
  await safari(page, 'pen', 'pointerup', lit);
  await until(async () => (await pressed(page)) === 'Marker', 'the highlighter picked from the ring');
}

// ---- helpers

// A pointer event as Safari hands over the Pencil's or a finger's, on what's at the point
const safari = (page, kind, type, [x, y]) =>
  page.evaluate(
    ([kind, type, x, y]) =>
      (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
        new PointerEvent(type, {
          pointerId: kind === 'pen' ? 7 : 11,
          pointerType: kind,
          isPrimary: true,
          clientX: x,
          clientY: y,
          pressure: type === 'pointerup' ? 0 : 0.5,
          buttons: type === 'pointerup' ? 0 : 1,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      ),
    [kind, type, x, y],
  );
async function safariLine(page, kind, from, to) {
  await safari(page, kind, 'pointerdown', from);
  for (let i = 1; i <= 12; i++)
    await safari(page, kind, 'pointermove', [
      from[0] + ((to[0] - from[0]) * i) / 12,
      from[1] + ((to[1] - from[1]) * i) / 12,
    ]);
  await safari(page, kind, 'pointerup', to);
}
