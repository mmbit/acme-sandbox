// book-check.mjs's story of the Notebook's page on a phone (the seeded Notebook, booknotebook.mjs open): the sent page's
// scrap with its words, its answer under it, a reply written, a new answer there within seconds
import assert from 'node:assert/strict';
import { stamp, turnTo } from './booknotebookscreen.mjs';
import { group, open } from './booknotebook.mjs';
import { until } from './bookkit.mjs';

const PHONE = { width: 390, height: 844 };
const SENT = 1;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function notebookPhoneStories(c) {
  return {
    'the Notebook on a phone: the sent page whole, its answer under its scrap, a reply written (kept as another answer comes) and taken back, a new answer there within seconds, ticked':
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
    // (an agent's desk-phone card under its group, on a phone too: booknotebookasks.mjs.)
    const asked = page.locator('#book .bk-under[data-g="2"] .ask-slip').first();
    await asked.scrollIntoViewIfNeeded();
    assert.match(await asked.innerText(), /Moss asks[\s\S]*The wave/, "an agent's card under its group");
    await slip.scrollIntoViewIfNeeded();
    await c.shot('notebook-phone-answer', page);
    const replies = () => group(play, 3).children.filter(r => r.kind === 'reply').length;
    const had = replies();
    await slip.locator('.slip-reply').tap();
    await page.keyboard.type('Lovely: one more in the teal, please');
    // (another answer comes meanwhile: the reply being written stays, unsent, till it's sent.)
    const slips = page.locator('#book .bk-under[data-g="3"] .answer-slip'),
      shown = await slips.count();
    play.answer(3, { by: 'moss', text: 'Teal is on its way' });
    await page.waitForTimeout(1500);
    assert.equal(replies(), had, 'nothing sent while the reply is written');
    assert.equal(
      await slip.locator('.slip-reply').inputValue(),
      'Lovely: one more in the teal, please',
      'the reply being written kept',
    );
    await page.keyboard.press('Enter');
    await until(() => replies() === had + 1, 'the reply in the store');
    await until(async () => (await slips.count()) === shown + 1, 'the answer that came meanwhile drawn once it went');
    const undo = page.locator('#book .bk-unreply').first();
    await undo.waitFor();
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

// A new answer from the store under its group within seconds (the store's event, not a read on a timer), with a
// picture of what was made and its link; its box ticks it
async function answered(page, play, c) {
  const ticks = [];
  await page.route('**/api/book/slip/tick', r => {
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
