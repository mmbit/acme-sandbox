// book-check.mjs's story of the board's controls on an iPad mini in WebKit, the iPad's engine (--stories "in WebKit"
// --webkit): the Pencil and a finger as Safari hands them over (pointer events on what's under them), the Pencil's tap
// on the grid opening a new scrap, its strip slid along to a tool, on it the Pencil writing and a finger after it
// drawing nothing (it pans, by default), the Pencil held still only ink, and its tap on the rail's mic, then a spot
// held, a voice note whose words write themselves there. Chromium's trusted touch and pen: strip.mjs.
import assert from 'node:assert/strict';
import { freePage, inScrap, savedWhere } from './mouse.mjs';
import { afterSlide, dictated, pressed, stillFor, stored } from './strip.mjs';
import { QUIET_MS, middleOf, until } from './kit.mjs';
import { bookOnTouch } from './start.mjs';

// c: book-check.mjs's played store and helpers
export function webkitStories(c) {
  return {
    'controls on an iPad mini in WebKit: the strip slid, the Pencil drawing and a finger not, the Pencil held still, its tap on the mic and a spot held':
      browser => webkit(browser, c),
  };
}

async function webkit(browser, c) {
  const free = freePage(c);
  const { context, page, errors } = await bookOnTouch(browser, c);
  try {
    const mid = await slidAndDrawn(page, c, free);
    await voice(page, c, free, mid);
    // (a made-up pointer can't be captured, as a real one can: the other WebKit stories leave it out too, and so in
    // Chromium, where the whole check runs it as well.)
    assert.deepEqual(
      errors.filter(e => !/can not be found here|No active pointer with the given id/.test(e)),
      [],
    );
  } finally {
    await context.close();
  }
}

// The Pencil's tap on the empty grid opens a new scrap; on it the Pencil held on Select slides down the strip to the
// eraser, its name showing, and lifts there (the tools an opened scrap's); then
// the Pencil writes on it, and a finger after it pans and draws nothing (the preferences' default). The opened scrap's
// middle on the screen
async function slidAndDrawn(page, c, free) {
  const mid = middleOf(
    await inScrap(page, c, free, async at => {
      await safari(page, 'pen', 'pointerdown', at);
      await safari(page, 'pen', 'pointerup', at);
    }),
  );
  const b = name => page.locator('#book .bk-strip').getByRole('button', { name, exact: true }).boundingBox();
  const [select, eraser] = [middleOf(await b('Select')), middleOf(await b('Eraser'))];
  await safari(page, 'pen', 'pointerdown', select);
  await page.waitForTimeout(300);
  await safari(page, 'pen', 'pointermove', eraser);
  await until(async () => (await page.locator('#bk-tip').textContent()).startsWith('Eraser'), "the eraser's name");
  await safari(page, 'pen', 'pointerup', eraser);
  await until(async () => (await pressed(page)) === 'Eraser', 'the eraser picked by the slide');
  await afterSlide(page);
  await page.locator('#book .bk-strip').getByRole('button', { name: 'Pen', exact: true }).tap();
  await until(async () => (await pressed(page)) === 'Pen', 'the pen picked');
  // the Pencil writes, and a finger doesn't
  await safariLine(page, 'pen', [mid[0] - 120, mid[1] - 80], [mid[0] + 60, mid[1] - 80]);
  await savedWhere(c, free.id, p => p.ink.length === 1);
  // (down the sheet: the scrap's left edge stays put, and the words held for below land across from their spot, inside
  // the scrap's width: booktexts.js spotFor)
  await safariLine(page, 'touch', [mid[0] + 20, mid[1] - 120], [mid[0] + 20, mid[1] + 60]);
  await page.waitForTimeout(QUIET_MS);
  assert.equal(stored(c, free).ink.length, 1, 'the finger drew nothing');
  return mid;
}
// The Pencil held still: a dot, nothing listening or opening; then a line written, the Pencil's tap on the mic and a
// spot held under the line: its words there
async function voice(page, c, free, mid) {
  const at = [mid[0] + 60, mid[1] + 180];
  await stillFor(
    page,
    at,
    p => safari(page, 'pen', 'pointerdown', p),
    p => safari(page, 'pen', 'pointerup', p),
  );
  await savedWhere(c, free.id, p => p.ink.length === 2);
  await safariLine(page, 'pen', [mid[0] - 120, mid[1] + 40], [mid[0] + 40, mid[1] + 50]);
  await savedWhere(c, free.id, p => p.ink.length === 3);
  const tap = async name => {
    const on = middleOf(await page.locator('#book .bk-strip').getByRole('button', { name, exact: true }).boundingBox());
    await safari(page, 'pen', 'pointerdown', on);
    await safari(page, 'pen', 'pointerup', on);
    await safari(page, 'pen', 'click', on);
  };
  await dictated(
    page,
    c,
    free,
    { tap, down: p => safari(page, 'pen', 'pointerdown', p), up: p => safari(page, 'pen', 'pointerup', p) },
    [mid[0] - 100, mid[1] + 110],
    'book-voice-webkit',
  );
}

// ---- helpers

// A pointer event as Safari hands over the Pencil's or a finger's, on what's at the point (a click, a tap's last)
const safari = (page, kind, type, [x, y]) =>
  page.evaluate(
    ([kind, type, x, y]) =>
      (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
        new (type === 'click' ? MouseEvent : PointerEvent)(type, {
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
