// book-check.mjs's stories of the agents' desk-phone cards under their group in the Notebook (shell/ink/bookasks.js,
// desk.js's On the page), on the played Notebook seeded as dev mode's (mock/notebook.json: Moss's card about the
// first page's second group, a sent drawing):
//   - an iPad mini: the card on the desk phone with its note's snip, Open in the book turning to the group's page, the
//     card under the group, "Moss asks", its choices as chips; one tapped answers it through the desk phone's own route,
//     the slip then reading answered with the pick, the page read again keeping it so, the desk phone with nothing
//     waiting.
//   - a desktop, a mouse: the card with choices answered with a click. (A card for a key, an upload or built work never
//     comes to the book: bookasks.test.ts.)
import assert from 'node:assert/strict';
import { open } from './booknotebook.mjs';
import { where } from './booknotebookscreen.mjs';
import { DESKTOP, MINI, until } from './bookkit.mjs';

// the seed's sent page (the first of My journal's), the group the card's about, and the note that group went as
const SENT = 1,
  GROUP = 2,
  NOTE = 2;
// a snip: an 8 × 6 red PNG
const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGN4ZmODFTEMpAQAW3NBof5buBkAAAAASUVORK5CYII=';

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots, and org (the CEO the routed group went to)
export function notebookAskStories(c) {
  return {
    "an agent's card under its group on an iPad mini: on the desk phone with its note, Open in the book at the group's page, a chip there answering it":
      browser => onMini(browser, c),
    "an agent's card under its group on a desktop, answered with a click": browser => onDesktop(browser, c),
  };
}

async function onMini(browser, c) {
  const { page, play, errors, done } = await open(browser, c, MINI, { hasTouch: true });
  try {
    const [ask] = asksOf(play),
      desk = await deskPhone(page, play, c);
    // the desk phone's card: On the page, the note's snip, and Open in the book
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
    const strip = page.locator('#phone-screen .on-page');
    await strip.waitFor({ timeout: 5000 });
    assert.match(await strip.innerText(), /On the page[\s\S]*Your note 1 for /i);
    // (a lazy picture: WebKit loads it a moment after it's drawn)
    await until(() => strip.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), 'the snip shown');
    await page.waitForTimeout(500); // (the phone's pop-in)
    await c.shot('notebook-ask-desk', page);
    assert.notEqual(await at(page), SENT, 'the book on another page first');
    await strip.getByRole('button', { name: 'Open in the book' }).click();
    await until(async () => (await at(page)) === SENT, "the book turned to the group's page");

    // in the book: under the group, the agent's name, the card's summary and its choices as chips
    const slip = page.locator(`#book .bk-under[data-g="${GROUP}"] .ask-slip[data-ask="${ask.id}"]`);
    await slip.waitFor({ timeout: 4000 });
    await slip.scrollIntoViewIfNeeded();
    const said = await slip.innerText();
    assert.match(said, /Moss asks/);
    assert.match(said, /Both read well small\. Which goes to print\?/);
    assert.match(said, /The same card is on your desk phone/);
    assert.deepEqual(await slip.locator('[data-choice]').allTextContents(), ['The wave', 'The sun']);
    await c.shot('notebook-ask-under', page);
    await slip.getByRole('button', { name: 'The wave' }).tap();
    await until(() => desk.answered.length, 'the answer posted');
    assert.deepEqual(
      desk.answered.map(b => [b.id, b.answer]),
      [[ask.id, 'The wave']],
      "the desk phone's own route",
    );
    await until(async () => (await slip.getAttribute('data-answered')) !== null, 'the slip answered');
    assert.match(await slip.locator('.ask-answer').textContent(), /The wave/);
    assert.equal(await slip.locator('[data-choice]').count(), 0, 'answered: nothing left to tap');
    // (the store's change reads the page again: still answered, from the store this time)
    await until(async () => /The wave/.test(await slip.innerText()), 'kept answered once the page is read again');
    assert.equal(asksOf(play)[0].status, 'answered');
    await c.shot('notebook-ask-answered', page);
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
    await page.waitForSelector('#phone-screen .quiet', { timeout: 4000 });
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

async function onDesktop(browser, c) {
  const { page, play, errors, done } = await open(browser, c, DESKTOP, {});
  try {
    const [ask] = asksOf(play),
      desk = await deskPhone(page, play, c);
    await turnToSent(page);
    const slip = page.locator(`#book .bk-under[data-g="${GROUP}"] .ask-slip[data-ask="${ask.id}"]`);
    await slip.waitFor({ timeout: 4000 });
    await slip.scrollIntoViewIfNeeded();
    await c.shot('notebook-ask-desktop', page);
    await slip.getByRole('button', { name: 'The sun' }).click();
    await until(async () => (await slip.getAttribute('data-answered')) !== null, 'the slip answered');
    assert.deepEqual(
      desk.answered.map(b => [b.id, b.answer]),
      [[ask.id, 'The sun']],
    );
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// ---- the played store and the desk phone

const asksOf = play => play.route('/api/notebooks/pages/groups', { page: SENT }).groups.find(g => g.id === GROUP).asks;
// The page shown, by its place in the notebook (1: its first)
const at = async page => Number(/(\d+) \/ \d+$/.exec(await where(page))?.[1]);
// The book turned to the sent page with the foot row's arrows
async function turnToSent(page) {
  for (let i = 0; i < 8 && (await at(page)) !== SENT; i++) {
    const was = await at(page);
    await page.locator('#book').getByRole('button', { name: 'The page before' }).click();
    await until(async () => (await at(page)) !== was, 'the page turned');
  }
  assert.equal(await at(page), SENT);
}
// The desk phone's card for the seeded card (bookasks.ts card: its place the note's group's page, in its notebook),
// listed while it's open; its answer route played, the answers posted kept. The played store answers it, as the
// coordinator's route does, so the Notebook's page is read again.
async function deskPhone(page, play, c) {
  const context = page.context(),
    [ask] = asksOf(play),
    answered = [];
  const card = {
    ...{ id: ask.id, agent: ask.agent, kind: ask.kind, title: ask.title, body: ask.body, urgency: 'whenever' },
    ...{ status: 'open', created: new Date().toISOString(), topic: 'notebook' },
    place: {
      ...{ url: '/', page: SENT, notebook: 1, note: NOTE, n: 1, owner: c.org.company.ceo, words: '' },
      snip: `/api/book/snip?id=${NOTE}`,
    },
  };
  await context.route(`${c.base}/api/requests`, r =>
    r.fulfill({ json: asksOf(play).some(a => a.id === ask.id && a.status === 'open') ? [card] : [] }),
  );
  await context.route(`${c.base}/api/book/snip?id=${NOTE}`, r =>
    r.fulfill({ contentType: 'image/png', body: Buffer.from(RED, 'base64') }),
  );
  await context.route(`${c.base}/api/requests/answer`, r => {
    const body = r.request().postDataJSON();
    answered.push(body);
    try {
      return r.fulfill({ json: play.route('/api/requests/answer', {}, body) });
    } catch (e) {
      return r.fulfill({ status: e.status ?? 500, json: { error: e.message } });
    }
  });
  return { answered };
}
