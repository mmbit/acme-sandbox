// book-check.mjs's stories of an agent's card and answer answered on their scrap opened (notebookasks.mjs lists them),
// on a played Notebook of their own: no field or room under a slip, the scrap drawn on and its Beantwoord sending it
// (shell/ink/bookslipreply.js, bookscrapkeys.js).
import assert from 'node:assert/strict';
import { DESKTOP, QUIET_MS, closeScrap, middleOf, openScrap, until } from './kit.mjs';
import { mini } from './start.mjs';
import { onDesk } from './mouse.mjs';
import { typedBoxes } from '../shell/ink/notebookparts.js';

const MADE = '2026-11-04T08:00:00.000Z';
// a snip: an 8 × 6 red PNG
export const RED =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGN4ZmODFTEMpAQAW3NBof5buBkAAAAASUVORK5CYII=';
// My journal's one open page: Moss's scrap with Moss's card on it (choices, so nothing answers it but a tap or the
// scrap's Beantwoord), and the board's scrap with Moss's answer under it.
const ASKED = 7,
  ANSWERED = 8,
  CARD = 3,
  SLIP = 30,
  ON_SCRAPS = {
    notebooks: [{ id: 1, kind: 'mine', name: 'My journal', archived: false, created: MADE, updated: MADE }],
    pages: [
      { id: 1, notebook: 1, pos: 0, kind: 'free', label: 'Monday', created: MADE, updated: MADE, w: 1200, h: 1600 },
    ],
    groups: [
      {
        ...{ id: ASKED, page: 1, h: 136, by: 'moss' },
        texts: typedBoxes('The cover: which sketch goes to print?', { x: 0, w: 320, color: '#1d1a2f' }),
      },
      {
        ...{ id: ANSWERED, page: 1, h: 136, by: 'board' },
        texts: typedBoxes('The header, warmer?', { x: 0, w: 320, color: '#1d1a2f' }),
      },
    ],
    slips: [
      {
        ...{ id: SLIP, note: null, grp: ANSWERED, by: 'moss', name: 'Moss', style: 'text', ticked: null },
        ...{ text: 'Warmer it is: the hand-lettered face.', created: MADE },
      },
    ],
    asks: [
      {
        ...{ id: CARD, group: ASKED, note: null, agent: 'moss', name: 'Moss', kind: 'decision' },
        ...{ title: 'The cover', body: 'Both read well small. Which goes to print?\n\nChoose:\n- The wave\n- The sun' },
        ...{ questions: null, page: null, status: 'open', answer: null, answered: null },
      },
    ],
    names: { moss: 'Moss' },
  };
// The card and the answer each answered on its scrap opened, by the Pencil on an iPad mini or the mouse on a desktop
export async function drawnOn(browser, c, on) {
  const notebooks = structuredClone(ON_SCRAPS),
    s =
      on === 'ipad'
        ? await mini(browser, c, { notebooks })
        : await onDesk(browser, c, { viewport: DESKTOP, notebooks }),
    { page } = s,
    pen = s.pen ?? mousePen(page),
    play = page.context().notebook,
    desk = { answered: await answersRouted(page.context(), c, play), picture: null, held: null };
  await picturesOn(page.context(), c, desk);
  try {
    await page.locator(`#book .bk-unit[data-unit="${ASKED}"]`).first().waitFor({ timeout: 30_000 });
    for (const under of [`[data-g="${ASKED}"] .ask-slip`, `[data-g="${ANSWERED}"] .answer-slip`]) {
      const slip = page.locator(`#book .bk-under${under}`).first();
      await slip.waitFor({ timeout: 5000 });
      const extra = await slip.locator('textarea, input, [contenteditable], .bk-slip-room').count();
      assert.equal(extra, 0, `no field or room under ${under}`);
    }
    await answeredOn(page, pen, play, desk, c, on);
    await repliedOn(page, pen, play, c, on);
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot(`notebook-ask-drawn-${on}-failed`, page);
    throw e;
  } finally {
    await s.done();
  }
}
// Moss's card answered on its scrap: drawn on in two strokes with a rest, put back with Klaar (nothing goes), opened
// again and sent by Beantwoord, its drawing a PNG uploaded for the card, the slip then answered with it
async function answeredOn(page, pen, play, desk, c, on) {
  const card = () => groupOn(play, ASKED).asks[0],
    answer = page.locator('#book .bk-sheet-keys .bk-scrap-answer');
  const { sheet } = await openScrap(page, pen, ASKED);
  await answer.waitFor({ timeout: 5000 });
  const at = [sheet.x + sheet.width * 0.3, sheet.y + sheet.height * 0.36];
  await pen.stroke(line(at, 160, 0));
  await page.waitForTimeout(1500);
  await pen.stroke(line([at[0] + 160, at[1] - 30], 0, 60));
  await until(() => groupOn(play, ASKED).ink.length === 2, 'both strokes saved on the scrap');
  assert.equal(card().status, 'open', 'nothing sent while the pen rests');
  await closeScrap(page, pen);
  await page.waitForTimeout(QUIET_MS);
  assert.equal(card().status, 'open', 'Klaar sends nothing');
  await openScrap(page, pen, ASKED);
  await answer.waitFor({ timeout: 5000 });
  await c.shot(`notebook-ask-drawn-${on}`, page);
  await pen.tap(middleOf(await answer.boundingBox()));
  await until(() => card().status === 'answered', 'its Beantwoord answers the card');
  const [sent] = desk.answered;
  assert.deepEqual([sent.id, sent.answer, sent.pictures], [CARD, '', [desk.picture.id]], 'its drawing with it');
  assert.equal(desk.picture.request, CARD, 'uploaded for the card');
  // (WebKit's Playwright doesn't hand over an upload's body: its bytes are checked in Chromium)
  if (desk.picture.bytes) assert.equal(desk.picture.bytes.subarray(1, 4).toString(), 'PNG', 'a PNG of the strokes');
  await putBack(page);
  const slip = page.locator(`#book .bk-under[data-g="${ASKED}"] .ask-slip[data-answered]`).first();
  await slip.locator('img.ask-drawn').waitFor({ timeout: 10_000 });
  assert.equal(await slip.locator('[data-choice]').count(), 0, 'answered: nothing left to tap');
}
// Moss's answer replied to on the board's scrap: a stroke drawn there, sent by Beantwoord as the reply to it, shown
// once (on the scrap), its Undo there in its seconds; then, the reply its last word, no Beantwoord
async function repliedOn(page, pen, play, c, on) {
  const replies = () => groupOn(play, ANSWERED).children.filter(r => r.kind === 'reply'),
    answer = page.locator('#book .bk-sheet-keys .bk-scrap-answer');
  const { sheet } = await openScrap(page, pen, ANSWERED);
  await answer.waitFor({ timeout: 5000 });
  await pen.stroke(line([sheet.x + sheet.width * 0.3, sheet.y + sheet.height * 0.36], 180, 20));
  await until(() => groupOn(play, ANSWERED).ink.length === 1, 'the stroke saved on the scrap');
  await pen.tap(middleOf(await answer.boundingBox()));
  await until(() => replies().length === 1, 'its Beantwoord sends the reply');
  const [reply] = replies(),
    [drawn] = groupOn(play, ANSWERED).ink;
  assert.equal(reply.answers, SLIP, 'to the answer under it');
  assert.deepEqual(
    reply.ink.map(st => st.id),
    [drawn.id],
    'the stroke drawn on the scrap',
  );
  await putBack(page);
  const shown = page.locator(`#book .bk-under[data-g="${ANSWERED}"] .bk-reply`);
  await shown.waitFor({ timeout: 10_000 });
  assert.equal(await shown.locator('.bk-slip-ink').count(), 0, 'its ink shown once, on the scrap');
  await c.shot(`notebook-reply-drawn-${on}`, page);
  // (its own click, in its seconds: the bar at the foot may lie over it)
  await shown.locator('.bk-unreply').dispatchEvent('click');
  await until(() => !replies().length, 'the reply taken back in its seconds');
  await until(async () => !(await shown.count()), 'and gone from under the slip');
  // (sent again, the board's reply is the last word: opened, no Beantwoord)
  await openScrap(page, pen, ANSWERED);
  await page.locator('#book .bk-scrap-more').waitFor({ timeout: 5000 });
  assert.equal(await answer.count(), 1, 'taken back, the answer waits on the board again');
  await pen.tap(middleOf(await answer.boundingBox()));
  await until(() => replies().length === 1, 'sent again');
  await putBack(page);
  await openScrap(page, pen, ANSWERED);
  await page.locator('#book .bk-scrap-more').waitFor({ timeout: 5000 });
  assert.equal(await answer.count(), 0, "the board's reply its last word: no Beantwoord");
  await closeScrap(page, pen);
}
// The sheet put back by its Beantwoord: gone, and its flight down onto its card over (as kit.mjs closeScrap waits)
async function putBack(page) {
  await page.locator('#book .bk-sheet').waitFor({ state: 'hidden', timeout: 30_000 });
  await page.waitForFunction(
    () => !document.querySelector('#book .bk-pages[data-open]') && !document.querySelector('#book .bk-lift'),
  );
}
// A straight stroke from at, dx and dy across, in screen px
const line = ([x, y], dx, dy) => Array.from({ length: 13 }, (_, i) => [x + (dx * i) / 12, y + (dy * i) / 12]);
// The mouse as the pen: a click is its tap, a drag its stroke
const mousePen = page => ({
  tap: ([x, y]) => page.mouse.click(x, y),
  stroke: async ([[x, y], ...rest]) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const [mx, my] of rest) await page.mouse.move(mx, my);
    await page.mouse.up();
  },
});
// A group on the played store's page 1
const groupOn = (play, id) => play.route('/api/notebooks/pages/groups', { page: 1 }).groups.find(g => g.id === id);
// The desk phone's answer route played (the answers posted kept)
export async function answersRouted(context, c, play) {
  const answered = [];
  await context.route(`${c.base}/api/requests/answer`, r => {
    const body = r.request().postDataJSON();
    answered.push(body);
    try {
      return r.fulfill({ json: play.route('/api/requests/answer', {}, body) });
    } catch (e) {
      return r.fulfill({ status: e.status ?? 500, json: { error: e.message } });
    }
  });
  return answered;
}

// The card's picture uploaded (desk.picture: its id, the card it's for and its bytes) and read back, played
export async function picturesOn(context, c, desk) {
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
