// book-check.mjs's stories of assigning (shell/ink/bookassign.js) on the played Notebook seeded as dev mode's
// (mock/notebook.json: its people, and whom some of its scraps went to), three of its newest page's scraps moved onto an
// Asks page of My journal: only an Asks page's scraps are handed over, to guests only.
//   - a desktop, a mouse: a sketch's picked scrap has no Assign in Select's bar. On the Asks page, Assign opens the short
//     list beside it (the guests picked last, at their whole names); a name there hands the scrap over. More… then
//     opens every guest and no agent, a search finds one, and a pick there hands another scrap over; the short list
//     now starts with them.
//   - an iPad mini upright, the Pencil with the Pen: on a sketch, a circle round a scrap carried on out of it offers no
//     people but the sketch's chapter's pages, over the page bar and under no line; drawn onto one
//     and lifted, the scrap moves there, leaving no ink, and Undo brings it back. Each stroke goes round twice, as the board circles a thing, so it reads as a scratch-out too:
//     what it moved or handed over stays. On the Asks page it opens the short
//     list at the line's end, the line drawn onto a name lights
//     it, and lifted there it hands the scrap over, leaving no ink. Lifted off any name, nothing goes and the stroke is
//     ink; with Select, a loop alone is a lasso as ever.
//   - an iPad mini sideways, a finger: Assign and More… whole on the screen, every row a finger's size.
// Each hand-over: the store asked for the right person, the scrap wearing their tag, no name in a list cut. Recorded
// on the iPad mini upright with --shots (the film of the Pencil's way).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { group, ids, open } from './notebook.mjs';
import { inSight, onPaper, tool } from './notebookscreen.mjs';
import { DESKTOP, MINI, pressAlong, until } from './kit.mjs';
import { GAP } from '../shell/ink/masonry.js';
import { UNIT_W } from '../shell/ink/scrapunit.js';

const UPRIGHT = { width: 744, height: 1133 };
// the seed's newest page and a sketch of it left there, the sketch page before it; the Asks page made beside it, and what's moved onto it: the
// newest page's two pictures (mock/notebook.json), each a unit of its own, and the wave over the rows
const NEWEST = 3,
  OTHER = 2,
  SKETCH = 7,
  ASKS = 960,
  SMALL = 11,
  BIG = 12,
  WAVE = 9;
const SEED = JSON.parse(await readFile(new URL('../mock/notebook.json', import.meta.url), 'utf8'));
// The seed with My journal's Asks page, those three scraps on it
function withAsks() {
  const seed = structuredClone(SEED),
    newest = seed.pages.find(p => p.id === NEWEST);
  seed.pages.push({ ...newest, id: ASKS, pos: newest.pos + 1, kind: 'asks', label: 'Asks', send_at: null });
  for (const g of seed.groups) if ([SMALL, BIG, WAVE].includes(g.id)) g.page = ASKS;
  return seed;
}
const opened = (browser, c, viewport, how) => open(browser, c, viewport, { ...how, notebooks: withAsks() });
// a finger's least target (px)
const FINGER_PX = 44;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function assignStories(c) {
  return {
    'assign on a desktop: Assign in the bar, a name from Recent, then More…, a search and a name; tags on both scraps':
      browser => byMouse(browser, c),
    'assign on an iPad mini upright: a circle round a scrap and a line out of it, the list at its end, lifted on a name; on a sketch, onto a page':
      browser => byPen(browser, c),
    'assign on an iPad mini sideways: Assign and More… whole on the screen, every row a finger’s size': browser =>
      sideways(browser, c),
  };
}

// ---- the stories

async function byMouse(browser, c) {
  const { page, play, errors, done } = await opened(browser, c, DESKTOP, { hasTouch: false, deviceScaleFactor: 1 });
  const sent = handOvers(page);
  try {
    await tool(page, 'Select');
    // a sketch's scrap: no Assign
    await pick(page, play, SKETCH, p => page.mouse.click(...p), NEWEST);
    await page.locator('#book .bk-sel-bar').getByRole('button').first().waitFor();
    assert.equal(await assignIn(page).count(), 0, 'no Assign on a sketch');
    await c.shot('assign-desktop-sketch', page);
    await pick(page, play, SMALL, p => page.mouse.click(...p));
    await assignIn(page).click();
    const short = await listShown(page, '.bk-assign-short');
    assert.equal(await short.locator('.bk-person').first().locator('.bk-name').textContent(), 'Annemieke Bos');
    await c.shot('assign-desktop-recent', page);
    await short.getByRole('menuitem', { name: /Sam de Vries/ }).click();
    await page.waitForTimeout(350);
    await c.shot('assign-desktop-flying', page);
    await given(page, play, sent, SMALL, 'guest:20', 'Sam de Vries');
    await c.shot('assign-desktop-tagged', page);
    // More…: everyone, a search, a pick
    await pick(page, play, WAVE, p => page.mouse.click(...p));
    await assignIn(page).click();
    await (await listShown(page, '.bk-assign-short')).getByRole('menuitem', { name: /More…/ }).click();
    const all = await listShown(page, '.bk-assign-all');
    assert.equal(await all.locator('input').getAttribute('placeholder'), 'Search 10 people');
    assert.equal(await all.locator('.bk-person').count(), 10, 'every guest');
    for (const agent of ['Lyra', 'Wiebe']) assert.equal(await all.getByRole('menuitem', { name: agent }).count(), 0);
    await c.shot('assign-desktop-everyone', page);
    await all.locator('input').fill('jansen');
    assert.deepEqual(await shownNames(all), ['Femke Jansen-Okafor'], 'the search finds her');
    await c.shot('assign-desktop-search', page);
    await all.getByRole('menuitem', { name: /Femke Jansen-Okafor/ }).click();
    await given(page, play, sent, WAVE, 'guest:14', 'Femke Jansen-Okafor');
    // the short list remembers: Femke first now
    await pick(page, play, SMALL, p => page.mouse.click(...p));
    await assignIn(page).click();
    const again = await listShown(page, '.bk-assign-short');
    assert.equal(await again.locator('.bk-name').first().textContent(), 'Femke Jansen-Okafor', 'picked last, first');
    await c.shot('assign-desktop-remembered', page);
    await page.keyboard.press('Escape');
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

async function byPen(browser, c) {
  const { page, play, errors, done } = await opened(browser, c, UPRIGHT, {
    hasTouch: true,
    folded: true,
    record: 'assign-ipad-mini-pen',
  });
  const sent = handOvers(page);
  try {
    await onSketch(page, play, sent, c);
    await tool(page, 'Select');
    await inSight(page, ASKS, BIG, [middleOf(play, BIG)]);
    await page.waitForTimeout(400);
    // a loop round the big picture, lifted where it closes: a lasso, picking it, no list
    const ring = await onPaper(page, loop(play, BIG, 1.02), BIG);
    await drawn(page, ring);
    await page.locator('#book .bk-sel').waitFor();
    assert.equal(await page.locator('#book > .bk-list').count(), 0, 'a loop alone is a lasso');
    await assignIn(page).waitFor();
    await c.shot('assign-pen-lasso', page);
    const inked = await offAnyName(page, play, sent);
    // round it twice and out of it, onto Sam de Vries
    const before = ids(play, ASKS),
      out = await outOf(page, play, BIG, 160, true, true);
    const pen = await drawn(page, out, { lift: false });
    const short = await listShown(page, '.bk-assign-short');
    assert.equal(await page.locator('#book > .bk-assign-line').count(), 1, 'the line drawn');
    await page.waitForTimeout(500);
    await c.shot('assign-pen-list', page);
    const sam = await short.getByRole('menuitem', { name: /Sam de Vries/ }).boundingBox();
    const onto = steps(out.at(-1), [sam.x + sam.width * 0.4, sam.y + sam.height / 2], 12);
    for (const p of onto) {
      await pen.along([p]);
      await page.waitForTimeout(25);
    }
    await until(() => short.locator('.bk-person[data-lit]').count(), 'the name lit');
    await c.shot('assign-pen-lit', page);
    await pen.up();
    await page.waitForTimeout(400);
    await c.shot('assign-pen-flying', page);
    await given(page, play, sent, BIG, 'guest:20', 'Sam de Vries');
    await page.waitForTimeout(1500);
    assert.equal(inkOn(play, ASKS), inked, 'the stroke that handed it over leaves no ink');
    assert.deepEqual(ids(play, ASKS), before, 'what was handed over stays where it is, and nothing is scratched out');
    await c.shot('assign-pen-tagged', page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// With the Pen, as the board writes: round the big picture and out of it, lifted off any name, nothing goes and the
// stroke is ink as ever, then undone. → the ink's count before it
async function offAnyName(page, play, sent) {
  await tool(page, 'Pen');
  const inked = inkOn(play, ASKS),
    before = ids(play, ASKS);
  const away = await outOf(page, play, BIG, 220, false, true);
  await drawn(page, away);
  await until(() => inkOn(play, ASKS) === inked + 1, 'the stroke kept as ink');
  assert.deepEqual(
    before.filter(id => !ids(play, ASKS).includes(id)),
    [],
    'nothing scratched out',
  );
  await until(async () => !(await page.locator('#book > .bk-list').count()), 'the list tidied away');
  assert.equal(sent.length, 0, 'lifted off any name, nothing goes');
  await page.locator('#book').getByRole('button', { name: 'Undo' }).first().tap();
  await until(() => inkOn(play, ASKS) === inked, 'that stroke undone');
  return inked;
}
// With the Pen on a sketch: round a scrap and out of it, its chapter's pages come (no people, no Asks page), over the
// page bar and the line under them; drawn onto the second page and lifted there, the scrap moves there with all its
// ink and the stroke leaves none; Undo brings it back
async function onSketch(page, play, sent, c) {
  await tool(page, 'Pen');
  await inSight(page, NEWEST, SKETCH, [middleOf(play, SKETCH)]);
  const inked = inkOn(play, NEWEST),
    before = ids(play, NEWEST),
    its = group(play, SKETCH).ink.length,
    there = inkOn(play, OTHER);
  const out = await outOf(page, play, SKETCH, 160, true, true),
    pen = await drawn(page, out, { lift: false });
  const pages = await listShown(page, '.bk-move-pages');
  assert.equal(await page.locator('#book > .bk-assign-short').count(), 0, 'no people on a sketch');
  assert.equal(await pages.locator('.bk-list-head').textContent(), 'Move to a page in Sketch');
  assert.deepEqual(
    await pages.locator('.bk-row').evaluateAll(rows => rows.map(r => r.dataset.page ?? 'here')),
    ['2', 'here', 'new'],
    'the open sketch pages (not Cover ideas, timed to send), this one among them not to be picked, then New page',
  );
  await overBarUnderNoLine(pages);
  await c.shot('assign-pen-sketch-pages', page);
  const row = await pages.locator(`[data-page="${OTHER}"]`).boundingBox();
  for (const p of steps(out.at(-1), [row.x + row.width * 0.6, row.y + row.height / 2], 12)) {
    await pen.along([p]);
    await page.waitForTimeout(25);
  }
  await until(() => pages.locator(`[data-page="${OTHER}"][data-lit]`).count(), 'the page lit');
  await c.shot('assign-pen-sketch-lit', page);
  await pen.up();
  await until(() => ids(play, OTHER).includes(SKETCH), 'the sketch moved to the page');
  await page.locator('#toasts .toast', { hasText: 'Moved to' }).waitFor();
  assert.equal(inkOn(play, OTHER), there + its, 'all of its ink there');
  assert.equal(inkOn(play, NEWEST), inked - its, 'the stroke that moved it leaves no ink');
  assert.equal(sent.length, 0, 'nothing handed over');
  await until(async () => !(await page.locator('#book > :is(.bk-list, .bk-assign-line)').count()), 'tidied away');
  await page.waitForTimeout(800);
  assert.ok(ids(play, OTHER).includes(SKETCH), 'what moved shows on its new page');
  assert.deepEqual(
    ids(play, NEWEST),
    before.filter(id => id !== SKETCH),
    'nothing scratched out',
  );
  await page.locator('#book').getByRole('button', { name: 'Undo' }).first().tap();
  await until(() => ids(play, NEWEST).includes(SKETCH), 'Undo brings it back');
}
// The pages' list over the page bar, and the line drawn under it
async function overBarUnderNoLine(pages) {
  const seen = await pages.evaluate(card => {
    const line = document.querySelector('#book > .bk-assign-line'),
      bar = document.querySelector('#book .bk-island[data-island="pages"]').getBoundingClientRect();
    return {
      over: card.getBoundingClientRect().bottom <= bar.top,
      under: +getComputedStyle(line).zIndex < +getComputedStyle(card).zIndex,
    };
  });
  assert.ok(seen.over, 'the pages over the page bar');
  assert.ok(seen.under, 'the line under the list');
}

async function sideways(browser, c) {
  const { page, play, errors, done } = await opened(browser, c, MINI, { hasTouch: true });
  try {
    await tool(page, 'Select');
    await pick(page, play, BIG, p => page.touchscreen.tap(...p));
    await assignIn(page).tap();
    const short = await listShown(page, '.bk-assign-short');
    assert.ok(
      (await rowHeights(short)).every(h => h >= FINGER_PX),
      'every row a finger’s size',
    );
    await c.shot('assign-sideways-recent', page);
    await short.getByRole('menuitem', { name: /More…/ }).tap();
    const all = await listShown(page, '.bk-assign-all');
    assert.ok(
      (await rowHeights(all)).every(h => h >= FINGER_PX),
      'every row a finger’s size',
    );
    await c.shot('assign-sideways-everyone', page);
    await all.getByRole('button', { name: 'Done' }).tap();
    await until(async () => !(await page.locator('#book > .bk-list').count()), 'Done puts it away');
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// ---- on the screen

// A scrap on a page (the Asks page's, unless said) picked with Select at its middle, slid into view first, by
// press(point on the screen)
async function pick(page, play, id, press, on = ASKS) {
  await press((await inSight(page, on, id, [middleOf(play, id)]))[0]);
  await page.locator('#book .bk-sel').waitFor();
}
// Assign in Select's bar, when it's shown
const assignIn = page => page.locator('#book .bk-sel-bar').getByRole('button', { name: 'Assign', exact: true });
// The middle of what a unit holds, in its own px (the store's)
function middleOf(play, id) {
  const { box } = group(play, id);
  return [box.x + box.w / 2, box.y + box.h / 2];
}
// The card of people or pages (its class) shown: whole on the screen, none of its names cut
async function listShown(page, kind) {
  const card = page.locator(`#book > .bk-list${kind}:not([inert])`);
  await card.waitFor();
  await card.locator('.bk-row').last().waitFor();
  await page.waitForTimeout(700); // (its rows popping in)
  const seen = await card.evaluate(el => {
    const r = el.getBoundingClientRect(),
      names = [...el.querySelectorAll('.bk-row:not([hidden]) .bk-name')];
    return {
      whole: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      cut: names.filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent),
    };
  });
  assert.ok(seen.whole, `${kind} whole on the screen`);
  assert.deepEqual(seen.cut, [], 'no name cut');
  return card;
}
// The lines of ink on a page, in the store
const inkOn = (play, page) =>
  play.route('/api/notebooks/pages/groups', { page }).groups.reduce((n, g) => n + g.ink.length, 0);
const shownNames = card => card.locator('.bk-person:not([hidden]) .bk-name').allTextContents();
const rowHeights = card =>
  card.locator('.bk-person').evaluateAll(rows => rows.map(r => r.getBoundingClientRect().height));
// The hand-overs the store was asked for, as sent
function handOvers(page) {
  const sent = [];
  page.on('request', r => r.url().includes('/api/notebooks/groups/assign') && sent.push(r.postDataJSON()));
  return sent;
}
// A scrap handed over: asked for once with the right person, the store has it, and it wears their tag
async function given(page, play, sent, id, to, name) {
  await until(() => sent.some(b => b.id === id), `the hand-over of ${id} sent`);
  assert.deepEqual(
    sent.filter(b => b.id === id),
    [{ id, to }],
  );
  await until(() => group(play, id).assigned.some(p => p.to === to), 'the store has it');
  const tag = page.locator(`#book .bk-groups .bk-tag[title="Assigned to ${name}"]`);
  await tag.waitFor();
  await until(() => tag.evaluate(t => getComputedStyle(t).opacity === '1'), 'its tag in');
  await until(async () => !(await page.locator('#book > .bk-list').count()), 'the list tidied away');
}

// ---- the Pencil

// A loop round what a unit holds in the gap about it (bare paper, so Select's press draws it and the loop takes in
// nothing of a neighbour's), in its px, `turns` round from the middle of its foot, each corner overshot by `over` px and
// come back to, as a hand does
function loop(play, id, turns, over = 0) {
  const h = held(play, id),
    m = GAP / 2;
  const corners = [
    [UNIT_W / 2, h + m],
    [UNIT_W + m, h + m],
    [UNIT_W + m, -m],
    [-m, -m],
    [-m, h + m],
    [UNIT_W / 2, h + m],
  ];
  const round = corners.slice(1).flatMap((c, i) => {
    const line = steps(corners[i], c, Math.ceil(gone(corners[i], c) / 8)).slice(1),
      past = [0, 1].map(j => c[j] + Math.sign(c[j] - corners[i][j]) * over);
    return over && i < corners.length - 2 ? [...line, past, c] : line;
  });
  return [corners[0], ...Array.from({ length: Math.round(turns * round.length) }, (_, i) => round[i % round.length])];
}
const gone = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
// How far down a unit what it holds reaches (its px): a stroke drawn by it and undone leaves the unit grown below that
const held = (play, id) => {
  const { box, h } = group(play, id);
  return box ? box.y + box.h : h;
};
// That loop 1.1 times round, then a line out of it on the screen, by away px (screen) past the unit's side nearer the
// screen's middle (inward) or its edge, and half that below its foot: the points on the screen. The list pops up at
// the line's end going inward, so a line going the other way is lifted off it. twice: round twice instead, its corners
// overshot, as the board circles a thing: a scribble as a scratch-out reads one (review/gestures.js)
async function outOf(page, play, id, away, inward = true, twice = false) {
  const ring = await onPaper(page, twice ? loop(play, id, 2, 20) : loop(play, id, 1.1), id),
    h = held(play, id);
  const [[x0], [x1, y1]] = await onPaper(
    page,
    [
      [0, 0],
      [UNIT_W, h],
    ],
    id,
  );
  const { width, height } = page.viewportSize(),
    x = (x0 + x1) / 2 < width / 2 === inward ? x1 + away : x0 - away;
  const end = [Math.min(Math.max(x, 24), width - 24), Math.min(y1 + away / 2, height - 24)];
  return [...ring, ...steps(ring.at(-1), end, 16).slice(1)];
}
const steps = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [0, 1].map(j => a[j] + ((b[j] - a[j]) * i) / n));
// A Pencil's stroke along points on the screen, a few at a time as a hand draws (lift false: held, { along, up })
async function drawn(page, points, { lift = true } = {}) {
  const pen = await pressAlong(page, points.slice(0, 2), { lift: false });
  for (let i = 2; i < points.length; i += 3) {
    await pen.along(points.slice(i, i + 3));
    await page.waitForTimeout(16);
  }
  if (lift) await pen.up();
  return pen;
}
