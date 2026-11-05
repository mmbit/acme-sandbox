// book-check.mjs's stories of the agents' desk-phone cards under their group in the Notebook (shell/ink/bookasks.js,
// desk.js's On the page), on the played Notebook seeded as dev mode's (mock/notebook.json: Moss's card about the
// first page's second group, a sent drawing):
//   - an iPad mini: the card on the desk phone with its note's snip, Open in the book turning to the group's page, the
//     card under the group, "Moss asks", its choices as chips; one tapped answers it through the desk phone's own route,
//     the slip then reading answered with the pick, the page read again keeping it so, the desk phone with nothing
//     waiting.
//   - a desktop, a mouse: the card with choices answered with a click. (A card for a key, an upload or built work never
//     comes to the book: bookasks.test.ts.)
//   - an iPad mini (the Pencil) and a desktop (the mouse): no field or room under an agent's card or answer; its scrap
//     opened, drawn on in two strokes with a rest, put back with Klaar: nothing sent; opened again, its Beantwoord sends
//     the drawing as a PNG uploaded for the card with the answer on the desk phone's route, the slip then answered with
//     it. A scrap with an agent's answer under it, opened and drawn on: its Beantwoord sends the stroke as the reply to
//     that answer, shown once (on the scrap, not again under the slip), its Undo there in its seconds; with the
//     board's reply its last word, no Beantwoord.
//   - an iPad mini upright, the Pencil: a question on another page of the book (a scrap handed to the board) gathered
//     onto its Asks page after the page's own, its page's name over its card; opened, drawn in and put back with Klaar
//     it's still open; opened again, its Answer key (Beantwoord) beside Klaar answers it, the sheet goes and the
//     question leaves the Asks page, staying on its own.
import assert from 'node:assert/strict';
import { open } from './notebook.mjs';
import { pageAt } from './notebookscreen.mjs';
import { DESKTOP, MINI, QUIET_MS, UPRIGHT, closeScrap, openScrap, toChapter, until } from './kit.mjs';
import { mini } from './start.mjs';
import { RED, answersRouted, drawnOn, picturesOn } from './notebookaskdrawn.mjs';
import { typedBoxes } from '../shell/ink/notebookparts.js';

// the seed's sent page (the first of My journal's), the group the card's about, and the note that group went as
const SENT = 1,
  GROUP = 2,
  NOTE = 2;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots, and org (the CEO the routed group went to)
export function notebookAskStories(c) {
  return {
    "an agent's card under its group on an iPad mini: on the desk phone with its note, Open in the book at the group's page, a chip there answering it":
      browser => onMini(browser, c),
    "an agent's card under its group on a desktop, answered with a click": browser => onDesktop(browser, c),
    "a question from another page gathered on the Asks page with its page's name, opened by the Pencil, answered only by its Answer key":
      browser => gathered(browser, c),
    "an agent's card and answer on their scraps answered by drawing on the scrap opened, sent only by its Beantwoord, no room under them, on an iPad mini":
      browser => drawnOn(browser, c, 'ipad'),
    "an agent's card and answer on their scraps answered by drawing on the scrap opened, sent only by its Beantwoord, no room under them, on a desktop":
      browser => drawnOn(browser, c, 'desktop'),
  };
}

// My journal with a free page, Monday, holding a question handed to the board, and its Asks page with one scrap of its
// own: the question gathered there (notebookplaypeople.js gatheredOn)
const MADE = '2026-11-04T08:00:00.000Z',
  QUESTION = 6,
  GATHERED = {
    notebooks: [{ id: 1, kind: 'mine', name: 'My journal', archived: false, created: MADE, updated: MADE }],
    pages: [
      { id: 1, notebook: 1, pos: 0, kind: 'free', label: 'Monday', created: MADE, updated: MADE, w: 1200, h: 1600 },
      { id: 2, notebook: 1, pos: 1, kind: 'asks', label: 'Asks', created: MADE, updated: MADE, w: 1200, h: 1600 },
    ],
    groups: [
      {
        id: 5,
        page: 2,
        h: 136,
        by: 'lyra',
        texts: typedBoxes('The shop page, a first go.', { x: 0, w: 320, color: '#1d1a2f' }),
      },
      {
        ...{ id: QUESTION, page: 1, h: 136, by: 'lyra', handed: { answered: false } },
        texts: typedBoxes('Blue or green for the header?', { x: 0, w: 320, color: '#1d1a2f' }),
      },
    ],
    slips: [],
    asks: [],
    names: { lyra: 'Lyra' },
  };
async function gathered(browser, c) {
  const s = await mini(browser, c, { viewport: UPRIGHT, notebooks: structuredClone(GATHERED) }),
    { page } = s,
    play = page.context().notebook,
    question = () => play.route('/api/notebooks/pages/groups', { page: 1 }).groups.find(g => g.id === QUESTION),
    card = page.locator(`#book .bk-page:not([hidden]) .bk-unit[data-unit="${QUESTION}"]`);
  try {
    await toChapter(page, 'asks', loc => loc.tap());
    // (the page turned: its picture gone)
    await until(async () => (await card.count()) === 1, 'the question gathered on the Asks page');
    assert.equal(await card.locator('.bk-unit-from').textContent(), 'Monday', "the question wears its page's name");
    const own = await page.locator('#book .bk-page:not([hidden]) .bk-unit[data-unit="5"]').boundingBox(),
      from = await card.boundingBox();
    assert.ok(from.y > own.y || from.x > own.x, "gathered after the page's own scrap");
    // (opened, drawn in, put back: Klaar alone answers nothing)
    let { gid, sheet } = await openScrap(page, s.pen, QUESTION);
    assert.equal(gid, QUESTION, 'the Pencil’s tap on the question opens it');
    const answer = page.locator('#book .bk-sheet-keys .bk-scrap-answer');
    await answer.waitFor({ timeout: 5000 });
    await s.pen.stroke(Array.from({ length: 13 }, (_, i) => [sheet.x + 80 + i * 16, sheet.y + 300 + (i % 2) * 24]));
    await until(() => question().ink.length === 1, 'the line drawn on the question saved');
    await closeScrap(page, s.pen);
    await page.waitForTimeout(QUIET_MS);
    assert.equal(question().question?.answered, false, 'Klaar answers nothing');
    assert.ok(await card.isVisible(), 'still on the Asks page');
    // (opened again: its Answer key answers it)
    ({ gid } = await openScrap(page, s.pen, QUESTION));
    assert.equal(gid, QUESTION, 'opened again');
    const at = await answer.boundingBox(),
      done = await page.locator('#book .bk-sheet-keys .bk-sheet-done').boundingBox();
    assert.ok(Math.abs(at.y - done.y) < 8, `the Answer key beside Klaar (${JSON.stringify([at, done])})`);
    await s.pen.tap([at.x + at.width / 2, at.y + at.height / 2]);
    await until(() => question().question?.answered === true, 'its Answer key answers it');
    await page.locator('#book .bk-sheet').waitFor({ state: 'hidden', timeout: 30_000 });
    await until(async () => !(await card.count()), 'answered, it leaves the Asks page');
    assert.ok(question(), 'and stays on its own page');
    await c.shot('notebook-ask-gathered-answered', page);
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot('notebook-ask-gathered-failed', page);
    throw e;
  } finally {
    await s.done();
  }
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
    assert.equal(await slip.locator('textarea, input').count(), 0, 'no field under the card');
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
    await once(page, slip);
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

// The card on the page turned to, once: WebKit's turn draws the page twice till it's done, so once, and still once a
// moment later
const once = (page, slip) =>
  until(
    async () => (await slip.count()) === 1 && (await page.waitForTimeout(400), await slip.count()) === 1,
    'the page turned to, its card once',
  );

// ---- the played store and the desk phone

const asksOf = play => play.route('/api/notebooks/pages/groups', { page: SENT }).groups.find(g => g.id === GROUP).asks;
// The page shown, by its place in the notebook (1: its first)
const at = async page => (await pageAt(page))?.[0];
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
// coordinator's route does, so the Notebook's page is read again. A picture uploaded for an answer is kept as picture
// ({ id, request, bytes }) and served back.
async function deskPhone(page, play, c) {
  const context = page.context(),
    [ask] = asksOf(play),
    desk = { answered: await answersRouted(context, c, play), picture: null, held: null };

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
  await picturesOn(context, c, desk);
  return desk;
}
