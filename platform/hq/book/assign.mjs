// book-check.mjs's stories of the grid's circle and line and the opened scrap's keys (shell/ink/bookgridgesture.js,
// bookdropzones.js, bookscrapkeys.js), on the board's iPad mini upright and docked beside HQ (about 550 px of paper),
// with the Pencil, on an Asks page of an agent's six scraps (unitspage.mjs), a second Asks page, two invited people and
// an agent among the store's people:
//   - a loop round a card carried on out of it: the page's controls fade and the two drop zones slide in, People (the
//     invited only, no agent) and Pages (this one muted, the other, a new page); the line drawn onto a person lights
//     them, and lifted there the scrap goes to them: asked once, it stays on the grid wearing their face, the zones gone
//     and the controls back, nothing opened, no ink; once they've answered, a tick on their face;
//   - a loop lifted, then a line started near it within the second: onto the other page, the scrap moves there;
//   - a loop and a line lifted on bare paper: nothing goes;
//   - a scrap handed to the board (a question) opened: Answer beside Klaar sends the answer and closes it;
//   - an agent's scrap opened: ⋯ has Give to… and, last, Throw scrap away, which asks once more (it's Moss's); thrown
//     away, the sheet closes and the card leaves the grid, and the toast's Undo brings it back.
// Recorded with --shots.
import assert from 'node:assert/strict';
import { MINI, UPRIGHT, closeScrap, middleOf, openScrap, say, steps, until } from './kit.mjs';
import { bookWide, noMicrophone, restsOpen, watchedPage } from './start.mjs';
import { hands } from './hands.mjs';
import { SEED } from './unitspage.mjs';
import { still, units } from './unitsread.mjs';

const SIZES = {
  'iPad mini upright': { viewport: UPRIGHT },
  'iPad mini docked beside HQ': { viewport: MINI, book: 560 },
};
const PEOPLE = [
  { to: 'guest:20', name: 'Sam de Vries', kind: 'guest' },
  { to: 'guest:14', name: 'Femke Jansen-Okafor', kind: 'guest' },
  { to: 'moss', name: 'Moss', kind: 'agent' },
];
// the seed's Asks page and the second one; the scrap handed to the board (a question)
const HERE = 1,
  OTHER = 2,
  ASKED = 3;
function seeded() {
  const seed = structuredClone(SEED),
    [asks] = seed.pages;
  seed.pages.unshift({ ...asks, id: OTHER, pos: -1, label: 'Ideas' });
  seed.people = PEOPLE;
  seed.groups.find(g => g.id === ASKED).handed = { answered: false };
  return seed;
}

// c: book-check.mjs's { hqIn, base, settled, shot, noErrorsIn }
export const assignStories = c =>
  Object.fromEntries(
    Object.entries(SIZES).map(([name, size]) => [
      `the circle and line on an ${name}: round a scrap and out of it, the zones, onto a person, onto a page, lifted off both; Answer and the tucked-away Throw away on an opened scrap`,
      browser => gestures(browser, c, name, size),
    ]),
  );

async function gestures(browser, c, name, size) {
  const s = await onTouch(browser, c, size);
  const shot = what => c.shot(`gesture-${name.replaceAll(' ', '-')}-${what}`, s.page);
  try {
    await toPerson(s, shot);
    await toPage(s, shot);
    await offBoth(s, shot);
    await answered(s, shot);
    await thrownAway(s, shot);
    c.noErrorsIn(s.errors);
  } catch (e) {
    await shot('failed');
    e.message = `${name}: ${e.message} (page errors: ${s.errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await s.page.context().close();
  }
}

// HQ on a touch screen with a pen at size, the seed's Asks page open in the book; the store's requests as sent
async function onTouch(browser, c, { viewport, book }) {
  const context = await c.hqIn(browser, viewport, { notebooks: seeded(), hasTouch: true, deviceScaleFactor: 1 });
  await noMicrophone(context);
  await bookWide(context, viewport, book);
  await context.addInitScript(() =>
    localStorage.setItem('ink.prefs', JSON.stringify({ penSeen: true, penPans: true })),
  );
  const { page, errors } = await watchedPage(context);
  const sent = [];
  page.on('request', r => {
    const at = /\/api\/notebooks\/groups\/(assign|answer)/.exec(r.url());
    if (at) sent.push({ route: at[1], ...r.postDataJSON() });
  });
  await page.goto(`${c.base}/?intro=0`);
  await restsOpen(page, c, viewport);
  await until(async () => (await units(page)).length === SEED.groups.length, 'the six scraps on the grid');
  return { page, errors, sent, ...(await hands(page)) };
}

// ---- the circle and line

// Round the second card and out of it onto Sam: the zones while the line's drawn, the hand-over, the face on the card
async function toPerson(s, shot) {
  const { page, pen, sent } = s,
    card = await cardOf(page, 2),
    inked = inkOn(page, HERE);
  const ring = loop(card, 1.1);
  await pen.down(ring[0]);
  for (const p of ring.slice(1)) await pen.move(p);
  const out = steps(ring.at(-1), [card.x + card.w / 2, card.y + card.h + 70], 8).slice(1);
  for (const p of out) await pen.move(p);
  const sam = page.locator('#book > .bk-zone-people .bk-mark[data-to="guest:20"]');
  await sam.waitFor();
  await zonesLook(page);
  await shot('zones');
  const at = middleOf(await sam.boundingBox());
  for (const p of steps(out.at(-1), at, 14).slice(1)) await pen.move(p);
  await until(() => sam.evaluate(m => m.hasAttribute('data-lit')), 'Sam lit under the line');
  await shot('lit');
  await pen.up(at);
  await until(() => sent.some(b => b.route === 'assign'), 'the hand-over sent');
  assert.deepEqual(sent, [{ route: 'assign', id: 2, to: 'guest:20' }], 'asked once, for Sam');
  const tag = page.locator('#book .bk-tag[data-assigned][title="Assigned to Sam de Vries"]');
  await tag.waitFor();
  await tidied(page);
  assert.equal(inkOn(page, HERE), inked, 'the gesture leaves no ink');
  assert.equal(await page.locator('#book .bk-pages[data-open]').count(), 0, 'nothing opened');
  await shot('given');
  // (Sam presses Answer on their side: the face gets its tick)
  page.context().notebook.answered(2, 'guest:20');
  await page.locator('#book .bk-tag[data-assigned][data-answered][title="Sam de Vries answered"] .bk-tick').waitFor();
  await shot('ticked');
}
// While the line's drawn: the controls faded, People with the invited and no agent, Pages with this one muted
async function zonesLook(page) {
  await until(
    () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#book .bk-controls > *')].every(el => +getComputedStyle(el).opacity < 0.05),
      ),
    'the controls faded',
  );
  const people = await page.locator('#book > .bk-zone-people .bk-mark-name').allTextContents();
  assert.deepEqual(people, ['Femke Jansen-Okafor', 'Sam de Vries'], 'the invited, never an agent');
  const pages = await page
    .locator('#book > .bk-zone-pages .bk-mark')
    .evaluateAll(ms => ms.map(m => (m.hasAttribute('aria-disabled') ? 'here' : m.dataset.page)));
  assert.deepEqual(pages, [String(OTHER), 'here', 'new'], 'the other page, this one muted, a new one');
  const whole = await page.evaluate(() =>
    [...document.querySelectorAll('#book > .bk-zone')].every(z => {
      const r = z.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }),
  );
  assert.ok(whole, 'both zones whole on the screen');
  const marks = await page
    .locator('#book > .bk-zone .bk-mark')
    .evaluateAll(ms => ms.map(m => Math.min(m.offsetWidth, m.offsetHeight)));
  assert.ok(
    marks.every(n => n >= 44),
    `every mark a Pencil's size (${marks})`,
  );
}
// A loop round a card in view lifted, a line from its edge within the second onto the other page: it moves there
async function toPage(s, shot) {
  const { page, pen } = s,
    card = await inView(page, 2);
  await pen.stroke(loop(card, 1.05));
  await page.waitForTimeout(300);
  const from = [card.x + card.w / 2, card.y + card.h + 10];
  await pen.down(from);
  const first = steps(from, [from[0], from[1] + 60], 6).slice(1);
  for (const p of first) await pen.move(p);
  const other = page.locator(`#book > .bk-zone-pages .bk-mark[data-page="${OTHER}"]`);
  await other.waitFor();
  const at = middleOf(await other.boundingBox());
  for (const p of steps(first.at(-1), at, 14).slice(1)) await pen.move(p);
  await until(() => other.evaluate(m => m.hasAttribute('data-lit')), 'the page lit');
  await shot('page-lit');
  await pen.up(at);
  await until(() => groupsOn(page, OTHER).some(g => g.id === card.id), 'the scrap moved to the other page');
  await page.locator('#toasts .toast', { hasText: 'Moved to' }).waitFor();
  await tidied(page);
  // (nothing of it left behind on the grid: its photo goes with it, though another scrap shows the same picture)
  await until(
    async () => !(await page.locator(`#book .bk-page:not([hidden]) .bk-photo[data-g="${card.id}"]`).count()),
    'its photo gone from the grid',
  );
  await shot('moved');
}
// Round a card in view and out of it, lifted between the zones: nothing goes, all tidied away
async function offBoth(s, shot) {
  const { page, pen, sent } = s,
    had = sent.length,
    card = await inView(page),
    ring = loop(card, 1.1),
    { height } = page.viewportSize(),
    end = [card.x + card.w / 2, Math.min(card.y + card.h + 160, height / 2 + 60)];
  await pen.down(ring[0]);
  for (const p of [...ring.slice(1), ...steps(ring.at(-1), end, 16).slice(1)]) await pen.move(p);
  await page.locator('#book > .bk-zone-pages').waitFor();
  await pen.up(end);
  await tidied(page);
  assert.equal(sent.length, had, 'lifted off both zones, nothing goes');
  assert.ok(
    groupsOn(page, HERE).some(g => g.id === card.id),
    'the scrap stays',
  );
  await shot('nothing');
}
// The zones, the line and the halo gone, the controls back
async function tidied(page) {
  await until(
    async () => !(await page.locator('#book > :is(.bk-zone, .bk-gesture-line, .bk-ringed, .bk-assign-copy)').count()),
    'the zones, the line and the copy tidied away',
  );
  assert.equal(await page.locator('#book[data-gesture]').count(), 0, 'the controls back');
}

// ---- the opened scrap's keys

// The scrap handed to the board opened: Answer beside Klaar sends the answer and puts it back
async function answered(s, shot) {
  const { page, pen, sent } = s;
  await openScrap(page, pen, ASKED);
  const answer = page.locator('#book .bk-sheet-keys .bk-scrap-answer');
  await answer.waitFor();
  assert.equal(await answer.textContent(), say('answerKey'));
  await shot('answer-key');
  await pen.tap(middleOf(await answer.boundingBox()));
  await until(() => sent.some(b => b.route === 'answer'), 'the answer sent');
  assert.deepEqual(
    sent.filter(b => b.route === 'answer'),
    [{ route: 'answer', id: ASKED }],
  );
  await page.waitForFunction(
    () => !document.querySelector('#book .bk-pages[data-open]') && !document.querySelector('#book .bk-lift'),
  );
  assert.equal(groupsOn(page, HERE).find(g => g.id === ASKED).question.answered, true, 'the store has it answered');
  // (opened again, no Answer: it's answered)
  await openScrap(page, pen, ASKED);
  assert.equal(await page.locator('#book .bk-sheet-keys .bk-scrap-answer').count(), 0, 'answered: no Answer');
  await closeScrap(page, pen);
}
// An agent's scrap opened: ⋯, Throw scrap away last, asked once more, thrown away; Undo brings it back
async function thrownAway(s, shot) {
  const { page, pen } = s,
    gid = ASKED;
  await openScrap(page, pen, gid);
  const more = page.locator('#book .bk-sheet-keys .bk-scrap-more');
  await pen.tap(middleOf(await more.boundingBox()));
  const menu = page.locator('#book > .bk-scrap-menu');
  await menu.waitFor();
  assert.deepEqual(await menu.locator('.bk-row').allTextContents(), [say('scrapGive'), say('scrapThrowAway')]);
  await shot('more');
  await pen.tap(middleOf(await menu.locator('[data-act="drop"]').boundingBox()));
  await menu.locator('.bk-scrap-ask').waitFor();
  assert.equal(await menu.locator('.bk-scrap-ask').textContent(), say('scrapByAgent', { name: 'Moss' }));
  assert.equal(groupsOn(page, HERE).filter(g => g.id === gid).length, 1, 'asked first: nothing thrown away yet');
  await shot('asked');
  await pen.tap(middleOf(await menu.locator('[data-act="drop"]').boundingBox()));
  await until(async () => !(await page.locator(`#book .bk-unit[data-unit="${gid}"]`).count()), 'the card gone');
  await until(() => !groupsOn(page, HERE).some(g => g.id === gid), 'thrown away in the store');
  await shot('thrown');
  await page.locator('#toasts .toast', { hasText: 'Deleted.' }).waitFor();
  await page
    .locator('#book')
    .getByRole('button', { name: say('undo'), exact: true })
    .first()
    .tap();
  await until(() => groupsOn(page, HERE).some(g => g.id === gid), 'Undo brings it back');
  await page.locator(`#book .bk-unit[data-unit="${gid}"]`).waitFor();
}

// ---- shared

// A card on the grid, still: { id, x, y, w, h } on the screen
const cardOf = async (page, id) => (await still(page)).find(u => u.id === id);
// The first card wholly on the screen, but the one left out
async function inView(page, but = null) {
  const { height } = page.viewportSize();
  return (await still(page)).find(u => u.id !== but && u.y >= 0 && u.y + u.h + 80 <= height);
}
// A loop round a card on the screen, `turns` round from the middle of its foot, 14 px clear of it
function loop({ x, y, w, h }, turns) {
  const [cx, cy, rx, ry] = [x + w / 2, y + h / 2, w / 2 + 14, h / 2 + 14],
    n = Math.round(48 * turns);
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = Math.PI / 2 + (2 * Math.PI * turns * i) / n;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}
// The store's groups on a page, and the lines of ink on them
const groupsOn = (page, id) => page.context().notebook.route('/api/notebooks/pages/groups', { page: id }).groups;
const inkOn = (page, id) => groupsOn(page, id).reduce((n, g) => n + g.ink.length, 0);
