// book-check.mjs's story of the book opening on the hand (shell/ink/bookpalette.js, bookview.js, bookinput.js), on an
// iPad mini's touch screen in Chromium (its own touch and pen events, trusted): the hand named and pressed, a finger's
// drag moving the page and leaving no ink, a finger's double tap held a voice note, the Pencil writing as ever, the pen
// one tap away, and shut and opened again, the hand once more. The board scribbled by accident when it only meant to
// move (call 159).
import assert from 'node:assert/strict';
import { freePage, paperBox, savedWhere } from './bookmouse.mjs';
import { HEARD, QUIET_MS, mini, now, placed, pressed, stored, until } from './bookstrip.mjs';

// c: book-check.mjs's played store and helpers
export function handStories(c) {
  return {
    'the book opens on the hand: a finger moves the page and draws nothing, its double tap held is a voice note, the Pencil writes, the pen one tap away':
      browser => opensOnHand(browser, c),
  };
}

async function opensOnHand(browser, c) {
  const free = freePage(c);
  const { page, pen, touch, errors, done } = await mini(browser, c, { pen: false });
  const hand = async when => {
    assert.equal(await pressed(page), 'Move the page', `the hand in use ${when}`);
    assert.equal(await now(page), 'Move the page', `the hand named ${when}`);
  };
  try {
    const paper = await paperBox(page),
      mid = [paper.x + paper.width / 2, paper.y + paper.height / 2];
    await hand('as the book opens');
    await c.shot('book-opens-on-hand', page);
    const before = await placed(page);
    await touch.stroke([[mid[0] - 60, mid[1]]], [[mid[0] + 60, mid[1] + 40]]);
    const after = await placed(page);
    assert.ok(Math.abs(after[0] - before[0] - 120) < 6, `a finger moved the page: ${JSON.stringify([before, after])}`);
    await page.waitForTimeout(QUIET_MS);
    assert.equal(stored(c, free).ink.length, 0, 'no ink from the finger');
    // a finger's double tap held: a voice note, as with the pen (the microphone allowed: mini), and a Pencil's dot
    // above it kept (its first tap moved the page and drew no dot to take off); its touches sent at once, as under load
    // each awaited one lands seconds after the last
    const held = [mid[0] - 60, paper.y + 200];
    await pen.down([held[0], mid[1]]);
    await pen.up([held[0], mid[1]]);
    await savedWhere(c, free.id, p => p.ink.length === 1);
    await Promise.all([touch.down([held]), touch.up(), touch.down([held])]);
    await page.locator('#book .bk-voice').waitFor({ timeout: 2000 });
    await until(async () => (await page.locator('#book .bk-voice').textContent()).includes(HEARD), 'the words heard');
    await touch.up();
    const saved = await savedWhere(c, free.id, p => p.texts.length === 1);
    assert.equal(saved.texts[0].text, HEARD);
    assert.equal(saved.ink.length, 1, "the finger's hold drew nothing and took nothing off");
    await pen.down([mid[0] - 80, mid[1] + 80]);
    for (let i = 1; i <= 12; i++) await pen.move([mid[0] - 80 + i * 12, mid[1] + 80]);
    await pen.up([mid[0] + 64, mid[1] + 80]);
    await savedWhere(c, free.id, p => p.ink.length === 2);
    await page.locator('#book .bk-strip').getByRole('button', { name: 'Pen', exact: true }).tap();
    assert.equal(await pressed(page), 'Pen', 'the pen one tap away');
    await page.locator('#book .bk-lip').tap();
    await c.settled(page, 'folded');
    await page.locator('#book .bk-lip').tap();
    await c.settled(page, 'open');
    await hand('opened again');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
