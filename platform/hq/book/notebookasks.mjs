// book-check.mjs's stories of the agents' desk-phone cards under their group in the Notebook (shell/ink/bookasks.js,
// desk.js's On the page), on the played Notebook seeded as dev mode's (mock/notebook.json: Moss's card about the
// first page's second group, a sent drawing):
//   - an iPad mini: the card on the desk phone with its note's snip, Open in the book turning to the group's page, the
//     card under the group, "Moss asks", its choices as chips; one tapped answers it through the desk phone's own route,
//     the slip then reading answered with the pick, the page read again keeping it so, the desk phone with nothing
//     waiting.
//   - a desktop, a mouse: the card with choices answered with a click. (A card for a key, an upload or built work never
//     comes to the book: bookasks.test.ts.)
//   - a phone, an iPad mini and a desktop: no field under the card to type in; its room pulled out by the handle and
//     drawn in, an arrow across its width, its shaft, a rest, its head: both kept, nothing sent, till the room's Send;
//     then, the upload slow, a stroke then isn't taken, and the whole drawing goes as a PNG of it uploaded for the card
//     and sent with the answer on the desk phone's route, the slip then answered with the drawing, as the page read
//     again shows it.
import assert from 'node:assert/strict';
import { open } from './notebook.mjs';
import { pageAt, turnTo } from './notebookscreen.mjs';
import { DESKTOP, MINI, until } from './kit.mjs';

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
    ...Object.fromEntries(
      Object.entries(DRAWN).map(([at, size]) => [
        `an agent's card under its group answered by drawing under it, no field to type in, on ${at}`,
        browser => drawnAnswer(browser, c, size),
      ]),
    ),
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

// The card answered by drawing in the room under it: the handle pulls it out (the card has chips, so it starts tucked
// in), strokes there with a rest between them kept as one drawing till its Send, which sends it whole as a picture
// uploaded for the card and named in the answer
const DRAWN = {
  'a phone': { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, folded: true },
  'an iPad mini': { viewport: MINI, hasTouch: true },
  'a desktop': { viewport: DESKTOP },
};
async function drawnAnswer(browser, c, { viewport, ...more }) {
  const { page, play, errors, done } = await open(browser, c, viewport, more);
  try {
    const [ask] = asksOf(play),
      desk = await deskPhone(page, play, c);
    await turnTo(page, SENT);
    const slip = page.locator(`#book .bk-under[data-g="${GROUP}"] .ask-slip[data-ask="${ask.id}"]`);
    await once(page, slip);
    await slip.scrollIntoViewIfNeeded();
    assert.equal(await slip.locator('textarea, input, [contenteditable]').count(), 0, 'no field under the card');
    const pull = slip.locator('.bk-slip-room-pull');
    await (more.hasTouch ? pull.tap() : pull.click());
    const room = slip.locator('.bk-slip-room-paper');
    await until(async () => (await room.boundingBox())?.height > 60, 'the room pulled out');
    await room.scrollIntoViewIfNeeded();
    await c.shot(`notebook-ask-room-${viewport.width}`, page);
    const k = await drawnAndSent(page, room, desk, more.hasTouch);
    await until(() => desk.answered.length, 'the answer posted once sent');
    const [sent] = desk.answered;
    assert.deepEqual([sent.id, sent.answer, sent.pictures], [ask.id, '', [desk.picture.id]], 'its picture with it');
    assert.equal(desk.picture.request, ask.id, 'uploaded for the card');
    // (WebKit's Playwright doesn't hand over an upload's body: its bytes are checked in Chromium)
    if (desk.picture.bytes) assert.equal(desk.picture.bytes.subarray(1, 4).toString(), 'PNG', 'a PNG of the strokes');
    await until(async () => (await slip.getAttribute('data-answered')) !== null, 'the slip answered');
    assert.equal(
      await slip.locator('[data-choice], .bk-slip-room').count(),
      0,
      'answered: nothing left to tap or draw in',
    );
    await drawnShown(slip, desk, k);
    assert.equal(await slip.locator('.ask-answer').count(), 0, 'no words: the drawing is the answer');
    await c.shot(`notebook-ask-drawn-${viewport.width}`, page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// An arrow drawn across the room in two strokes, a rest after each: both kept, nothing sent, till the room's Send
// (tapped with a touch); then, its upload held, a stroke isn't taken. The room's scale on the screen, k
async function drawnAndSent(page, room, desk, touch) {
  const box = await room.boundingBox(),
    wet = room.locator('.bk-reply-wet path'),
    { shaft, head } = arrow(box.width);
  await stroke(page, box, shaft);
  await page.waitForTimeout(1500);
  await stroke(page, box, head);
  await page.waitForTimeout(1500);
  assert.equal(desk.answered.length, 0, 'nothing sent while the pen rests');
  assert.equal(await wet.count(), 2, 'both strokes kept in the room');
  const send = room.locator('.bk-slip-room-send'),
    k = await room.evaluate(el => el.getBoundingClientRect().width / el.offsetWidth);
  const upload = desk.slow();
  await (touch ? send.tap() : send.click());
  await upload.started;
  // (a stroke while it goes isn't taken: what was drawn is what goes)
  const later = shaft.map(([x, y]) => [x, y - 20]);
  await stroke(page, box, later);
  assert.equal(await wet.count(), 2, 'no stroke taken while it goes');
  upload.release();
  return k;
}
// The drawing the card was answered with, the picture that went, under its tick at its own px; in Chromium, the
// uploaded PNG's height the arrow's at the room's scale k
async function drawnShown(slip, desk, k) {
  const drawn = slip.locator('img.ask-drawn');
  await until(() => drawn.evaluate(img => img.complete && img.naturalWidth > 0), 'the drawing shown once read again');
  const [tall, shown, own] = await drawn.evaluate(img => [img.naturalHeight, img.offsetWidth, img.naturalWidth]);
  assert.equal(shown, own, 'the drawing shown at its own px');
  // (the uploaded PNG, in Chromium: from the head's top to the shaft's foot in page px, with the pen's width, 3, and
  // the paper round it, 24 a side)
  const { shaft, head } = arrow(0),
    span = (shaft[0][1] - head[0][1]) / k + 3 + 2 * 24;
  if (desk.picture.bytes) assert.ok(Math.abs(tall - span) <= 2, `${tall} px, not ${span}: the head and the shaft`);
}
// The card on the page turned to, once: WebKit's turn draws the page twice till it's done, so once, and still once a
// moment later
const once = (page, slip) =>
  until(
    async () => (await slip.count()) === 1 && (await page.waitForTimeout(400), await slip.count()) === 1,
    'the page turned to, its card once',
  );
// An arrow drawn across the room in two strokes, its shaft and its head, in px from the room's corner: from near its
// left edge to its tip near its right one (w: the room's width on the screen)
const arrow = w => ({
  shaft: [
    [10, 80],
    [w / 2, 60],
    [w - 10, 40],
  ],
  head: [
    [w - 30, 30],
    [w - 10, 40],
    [w - 22, 60],
  ],
});
// A stroke through points drawn in the room (r: its box)
async function stroke(page, r, points) {
  const [[x, y], ...rest] = points;
  await page.mouse.move(r.x + x, r.y + y);
  await page.mouse.down();
  for (const [dx, dy] of rest) await page.mouse.move(r.x + dx, r.y + dy, { steps: 4 });
  await page.mouse.up();
}

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
    answered = [],
    desk = { answered, picture: null, held: null };

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
  await picturesOn(context, c, desk);
  return desk;
}
// The card's picture uploaded (desk.picture: its id, the card it's for and its bytes) and read back, played
async function picturesOn(context, c, desk) {
  // (slow(): the next upload held till its release(), started once it's asked for)
  desk.slow = () => {
    let started, release;
    const asked = new Promise(done => (started = done));
    desk.held = { started, freed: new Promise(done => (release = done)) };
    return { started: asked, release };
  };
  await context.route(
    url => url.pathname === '/api/pictures' && url.searchParams.has('request'),
    async r => {
      const { held } = desk;
      desk.held = null;
      held?.started();
      await held?.freed;
      const request = Number(new URL(r.request().url()).searchParams.get('request'));
      desk.picture = { id: 41, request, bytes: r.request().postDataBuffer() };
      return r.fulfill({ json: { id: 41, type: 'image/png', bytes: desk.picture.bytes?.length ?? 0 } });
    },
  );
  await context.route(`${c.base}/api/pictures/file?id=41`, r =>
    r.fulfill({ contentType: 'image/png', body: desk.picture?.bytes ?? Buffer.from(RED, 'base64') }),
  );
}
