// book-check.mjs's story of a card's question several of whose answers are true (questions.js, a pick-many with
// picked: []) on its slip in the Notebook (shell/ink/bookasks.js), in place of Moss's card under the sent page's group
// of the played Notebook (seeded as dev mode's, mock/notebook.json):
//   - an iPad mini, touch: the question's options as tick boxes, none ticked; two tapped stay ticked together, Send
//     answers the card on the desk phone's route with both. In Chromium and, with --webkit, in WebKit.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { open } from './notebook.mjs';
import { turnTo } from './notebookscreen.mjs';
import { MINI, until } from './kit.mjs';
import { answersRouted } from './notebookaskdrawn.mjs';

// the seed's sent page and the group its card is about (notebookasks.mjs)
const SENT = 1,
  GROUP = 2;
const QUESTION = { title: 'Where did you read it?', options: ['Phone', 'Tablet', 'Desktop'], many: true, picked: [] };

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function askTickStories(c) {
  return {
    "a card's question with several true answers as tick boxes on its slip, two ticked and sent, on an iPad mini":
      browser => ticked(browser, c),
  };
}

async function ticked(browser, c) {
  const notebooks = await seeded();
  const { page, play, errors, done } = await open(browser, c, MINI, { hasTouch: true, notebooks });
  const name = `ask-ticks-${browser.browserType().name()}`;
  try {
    const answered = await answersRouted(page.context(), c, play);
    await turnTo(page, SENT);
    const slip = page.locator(`#book .bk-under[data-g="${GROUP}"] .ask-slip`);
    await until(async () => (await slip.count()) === 1, 'the card under its group');
    await slip.scrollIntoViewIfNeeded();
    const chips = slip.locator('.ask-q .chip');
    assert.equal(await slip.locator('.ask-q .chip.tick').count(), 3, 'its options as tick boxes');
    assert.equal(await slip.locator('.ask-q .chip.on').count(), 0, 'none ticked');
    await page.waitForTimeout(400);
    await c.shot(`${name}-open`, page);
    await chips.filter({ hasText: 'Phone' }).tap();
    await chips.filter({ hasText: 'Desktop' }).tap();
    assert.deepEqual(await chips.evaluateAll(l => l.map(e => e.getAttribute('aria-pressed'))), [
      'true',
      'false',
      'true',
    ]);
    await c.shot(`${name}-ticked`, page);
    await slip.getByRole('button', { name: 'Send' }).tap();
    await until(() => answered.length, 'the answer posted');
    assert.deepEqual(answered[0].answers, [['Phone', 'Desktop']], 'both ticked answers go');
    await until(async () => (await slip.getAttribute('data-answered')) !== null, 'the slip answered');
    await c.shot(`${name}-sent`, page);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`${name}-failed`, page);
    throw e;
  } finally {
    await done();
  }
}

// The dev seed with its card under the sent page's group asking the one question, no choices
async function seeded() {
  const seed = JSON.parse(await readFile(new URL('../mock/notebook.json', import.meta.url), 'utf8'));
  Object.assign(seed.asks[0], {
    title: 'Where did the cover read well?',
    body: 'Tick every screen the cover read well on.',
    questions: [QUESTION],
  });
  return seed;
}
