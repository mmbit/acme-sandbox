// book-check.mjs's story of the Notebook's page on a phone (the seeded Notebook, notebook.mjs open): the sent page's
// scrap with its words, its answer under it with no field or room to answer in (the board answers on a scrap opened:
// notebookaskdrawn.mjs), a new answer there within seconds
import assert from 'node:assert/strict';
import { stamp, turnTo } from './notebookscreen.mjs';
import { group, open } from './notebook.mjs';
import { until } from './kit.mjs';

const PHONE = { width: 390, height: 844 };
const SENT = 1;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function notebookPhoneStories(c) {
  return {
    'the Notebook on a phone: the sent page whole, its answer under its scrap, no room under it, a new answer there within seconds, ticked':
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
    assert.equal(await slip.locator('textarea, input, .bk-slip-room').count(), 0, 'no field or room under the answer');
    await c.shot('notebook-phone-answer', page);
    await answered(page, play, c);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
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
