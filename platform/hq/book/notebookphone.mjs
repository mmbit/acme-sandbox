// book-check.mjs's story of the Notebook's page on a phone (the seeded Notebook, notebook.mjs open): the sent page's
// scrap with its words, its answer under it, a reply drawn in the room pulled out under it, a new answer there within seconds
import assert from 'node:assert/strict';
import { stamp, turnTo } from './notebookscreen.mjs';
import { group, open } from './notebook.mjs';
import { until } from './kit.mjs';

const PHONE = { width: 390, height: 844 };
const SENT = 1;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function notebookPhoneStories(c) {
  return {
    'the Notebook on a phone: the sent page whole, its answer under its scrap, a reply drawn under it in two strokes (kept as another answer comes) sent whole and taken back, a new answer there within seconds, ticked':
      browser => onPhone(browser, c),
  };
}

async function onPhone(browser, c) {
  const { page, play, errors, done } = await open(browser, c, PHONE, { hasTouch: true, isMobile: true, folded: true });
  try {
    await turnTo(page, SENT);
    await until(async () => /^Sent /.test(await stamp(page)), 'the sent page stamped');
    const words = page.locator('#book .bk-scrap-words').first();
    await words.scrollIntoViewIfNeeded();
    assert.equal((await words.textContent()).trim(), group(play, 3).words, "the scrap's words under it");
    const slip = page.locator('#book .bk-under .answer-slip').first();
    await slip.scrollIntoViewIfNeeded();
    assert.match(await slip.textContent(), /Warmer it is/, 'the answer under its group');
    // (an agent's desk-phone card under its group, on a phone too: notebookasks.mjs.)
    const asked = page.locator('#book .bk-under[data-g="2"] .ask-slip').first();
    await asked.scrollIntoViewIfNeeded();
    assert.match(await asked.innerText(), /Moss asks[\s\S]*The wave/, "an agent's card under its group");
    await slip.scrollIntoViewIfNeeded();
    await c.shot('notebook-phone-answer', page);
    const { undo, replies, had } = await drawnReply(page, play, slip);
    await c.shot('notebook-phone-replied', page);
    // (its own click, in its seconds: on a loaded machine a tap waits seconds for frames, and review mode's pin at the
    // foot may be over it till it steps off, dock.js)
    await undo.dispatchEvent('click');
    await until(() => replies() === had, 'the reply taken back');
    await answered(page, play, c);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// A reply drawn under the slip: no field to type in there, the room pulled out, the reply drawn in it in two strokes
// with a rest between them (kept, unsent, as another answer comes meanwhile), gone whole with the room's Send and shown
// under the slip as drawn.
async function drawnReply(page, play, slip) {
  const replies = () => group(play, 3).children.filter(r => r.kind === 'reply').length;
  const had = replies();
  assert.equal(await slip.locator('textarea, input').count(), 0, 'no field under the answer');
  await upTheScreen(page, slip.locator('.bk-slip-room-pull'));
  await slip.locator('.bk-slip-room-pull').tap();
  const room = slip.locator('.bk-slip-room-paper');
  await until(async () => (await room.boundingBox())?.height > 60, 'the room pulled out');
  await room.scrollIntoViewIfNeeded();
  const r = await room.boundingBox();
  await page.mouse.move(r.x + 30, r.y + 30);
  await page.mouse.down();
  for (const [dx, dy] of [
    [60, 20],
    [110, 50],
    [70, 70],
    [30, 30],
  ])
    await page.mouse.move(r.x + dx, r.y + dy);
  await page.mouse.up();
  // (another answer comes as the pen rests: the reply being drawn stays, unsent, till its Send.)
  const slips = page.locator('#book .bk-under[data-g="3"] .answer-slip'),
    shown = await slips.count();
  play.answer(3, { by: 'moss', text: 'Teal is on its way' });
  await page.waitForTimeout(1500);
  assert.equal(replies(), had, 'nothing sent while the pen rests');
  const wet = room.locator('.bk-reply-wet path');
  assert.equal(await wet.count(), 1, 'the reply being drawn kept');
  await page.mouse.move(r.x + 140, r.y + 30);
  await page.mouse.down();
  await page.mouse.move(r.x + 170, r.y + 70, { steps: 4 });
  await page.mouse.up();
  assert.equal(await wet.count(), 2, 'its second stroke kept with it');
  await room.locator('.bk-slip-room-send').tap();
  await until(() => replies() === had + 1, 'the reply in the store');
  const drawn = page.locator('#book .bk-reply .bk-slip-ink').first();
  await drawn.waitFor();
  assert.equal(await drawn.locator('path').count(), 2, 'the reply drawn whole');
  await until(async () => (await slips.count()) === shown + 1, 'the answer that came meanwhile drawn once it went');
  const undo = page.locator('#book .bk-unreply').first();
  await undo.waitFor();
  await drawn.scrollIntoViewIfNeeded();
  return { undo, replies, had };
}

// The page panned on (a wheel's turn on the paper, bookpan.js: mobile WebKit's Playwright has no wheel to turn, and a
// finger draws on a fresh device) till el is in the screen's upper half, with room under it to pull out and draw in,
// clear of the bar at the foot: the book's paper pans by itself, so a scroll into view moves nothing
async function upTheScreen(page, el) {
  const { height } = page.viewportSize();
  await until(async () => {
    const b = await el.boundingBox();
    if (b && b.y < height / 2) return true;
    await page.evaluate(() => {
      const desk = document.querySelector('#book .bk-desk'),
        r = desk.getBoundingClientRect();
      desk.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: 300,
          clientX: r.left + r.width / 3,
          clientY: r.top + r.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await page.waitForTimeout(300);
  }, 'the answer panned into sight');
}

// A new answer from the store under its group within seconds (the store's event, not a read on a timer), with a
// picture of what was made and its link; its box ticks it, on the answers' route
async function answered(page, play, c) {
  const ticks = [];
  await page.route('**/api/notebooks/answers/tick', r => {
    ticks.push(r.request().postDataJSON());
    return r.fulfill({ json: { ok: true } });
  });
  const slips = page.locator('#book .bk-under[data-g="3"] .answer-slip'),
    had = await slips.count();
  const made = play.answer(3, {
    ...{ by: 'moss', text: 'And one in teal: here it is' },
    ...{ picture: '/mock/book-snip-2.svg', link: 'https://teal.preview.example' },
  });
  await until(async () => (await slips.count()) === had + 1, 'the answer under its group within seconds', 4000);
  const slip = page.locator(`#book .answer-slip[data-slip="${made.id}"]`);
  await slip.scrollIntoViewIfNeeded();
  assert.equal(await slip.locator('.slip-pic').count(), 1, 'a picture of what was made');
  const link = slip.getByRole('link', { name: 'Open what Moss made' });
  assert.equal(await link.getAttribute('href'), 'https://teal.preview.example', 'and its link');
  await c.shot('notebook-phone-new-answer', page);
  await slip.locator('.slip-tick').tap();
  await until(() => ticks.length, 'the tick sent');
  assert.deepEqual(ticks, [{ id: made.id, ticked: true }]);
  assert.equal(await slip.getAttribute('data-ticked'), '', 'the slip ticked');
}
