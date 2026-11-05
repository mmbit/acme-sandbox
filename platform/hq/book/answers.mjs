// book-check.mjs's answers stories: Ink answers any note
// (shell/ink/bookgroups.js and bookanswers.js; the coordinator's ink/bookjudge.ts, bookanswer.ts and booktry.ts), each on
// a Notebook of its own played by HQ's one stand-in (answersplay.mjs). A board's note on a page: the agent's face
// and its pencil dots under the note's unit while the answer comes, or why none came, then the answer slipped there,
// as the store keeps them (no spot): by the unit, under it or beside it, clear of every other unit, at every width the
// board reads on.
// A drawing, its strokes on its slip under the note, a form there too (answered and sent) and an agent's question;
// the overview lists what's open (a note's versions: versions.mjs). The board answers one from its scrap opened, by
// its sheet's key (notebookasks.mjs). On a call's page, the call's agent's answer lands the same way. On an iPad mini,
// a phone and a desktop. (Its Notebook played by notebookOn)
import assert from 'node:assert/strict';
import { FEED_MS, inSight, notebookOn, opened, shownByItsNote, underItsNote } from './answersplay.mjs';
import { press } from './bar.mjs';
import { OVERVIEW, until } from './kit.mjs';
import { viewNow } from './canvas.mjs';
import { watchedPage } from './start.mjs';

export const WENT_LIVE = 'Yes: it went live this morning, at 09:12.';

// c: book-check's { hqIn, base, store, pages, posts, org, shot, settled, settle }
export function answerStories(c) {
  return {
    "an answer: the face and its dots under the note's unit, why none came, then its slip there, clear of every other note":
      browser => answered(browser, c, c.MINI, 'mini'),
    'an answer on a phone, an iPad upright and a desktop, its book narrow and spread wide, by its note':
      async browser => {
        await answered(browser, c, c.PHONE, 'phone', { hasTouch: true, isMobile: true });
        await answered(browser, c, { width: 744, height: 1133 }, 'mini-upright');
        await answered(browser, c, c.DESKTOP, 'desktop', { hasTouch: false, deviceScaleFactor: 1 });
        // (its columns side by side, the note asked about in the middle of a full row.)
        const wide = { hasTouch: false, deviceScaleFactor: 1, book: 1100 };
        await answered(browser, c, { width: 1920, height: 1080 }, 'desktop-wide', wide, { at: 1 });
        // (a staggered masonry: the note asked about boxed in by a short note over it and one under it and a tall
        // drawing either side.)
        await answered(browser, c, { width: 1920, height: 1080 }, 'desktop-staggered', wide, STAGGERED);
        // (four columns, three rows: the second row's two middle notes boxed in, one asked about, the other answered
        // already.)
        const wider = { ...wide, book: 1600 };
        await answered(browser, c, { width: 1920, height: 1080 }, 'desktop-rows', wider, ROWS);
      },
    'an agent’s drawing, form and question; the form answered; the overview lists what’s open': browser =>
      kinds(browser, c),
    'a drawing answer’s strokes on its slip under its note, a wide one fit to the slip, at a phone, an iPad mini and a desktop':
      async browser => {
        await drawn(browser, c, c.PHONE, 'phone', { hasTouch: true, isMobile: true });
        await drawn(browser, c, c.MINI, 'mini');
        await drawn(browser, c, c.DESKTOP, 'desktop', { hasTouch: false, deviceScaleFactor: 1 });
      },
    "on a call's page, the call's agent's answer lands the same way": browser => onCall(browser, c),
    'an answer coming on a page read before the room placed its agent wears their face once it has': browser =>
      placedLate(browser, c),
  };
}

// ---- the stories
// A story on HQ opened over its own Notebook, steps(page, the store it's played on), its errors none (exported for
// picks.mjs)
export async function inStory(browser, c, { viewport, nb, options = {} }, steps) {
  const { page, errors, play, done } = await opened(browser, c, viewport, nb, options);
  try {
    await steps(page, play);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
// (on the rail, or under More where the rail has folded it away.)
const overview = page => press(page, OVERVIEW);
// The first post to path since from, once it's made (null if none is by FEED_MS)
async function postOf(c, from, path) {
  for (const end = Date.now() + FEED_MS; Date.now() < end; await new Promise(go => setTimeout(go, 100))) {
    const sent = c.posts.slice(from).find(x => x.path === path);
    if (sent) return sent;
  }
  return null;
}
// An answer's slip under its note, as the page draws it (in .bk-under: bookgroups.js)
export const slipOf = (page, g, id) =>
  page.locator(`#book .bk-under[data-g="${g.id}"] .answer-slip[data-slip="${id}"]`);

// The note asked about (at: the first unless named) on a page of notes (each in the column it was drawn in, where the
// page has it; tall: a drawing down it, three short notes tall; answered: its answer come already). A wide book lays
// them side by side, one under another, a gap apart, and pins them there: whatever hangs under a note reads as its own
// at every width, beside it where no answer fits under it.
async function answered(browser, c, viewport, size, options = {}, { at = 0, notes = GRID } = {}) {
  const nb = notebookOn(c),
    groups = notes.map(({ column, tall }, i) =>
      Object.assign(nb.typed(4100 + i, i === at ? 'Is this live yet?' : `and the header colour, ${i}`, 60, 60), {
        column,
        ...(tall && { ink: [{ color: '#2b2230', size: 3, points: [20, 300].map((y, k) => [24, y, 0.5, k * 40]) }] }),
      }),
    ),
    asked = groups[at],
    before = notes.flatMap(({ answered }, i) => (answered ? [groups[i]] : []));
  nb.groups.push(...groups);
  nb.seed.slips.push(...before.map((g, k) => ({ id: 4190 + k, ...nb.answer(g, 'text', WENT_LIVE) })));
  await inStory(browser, c, { viewport, nb, options }, async (page, play) => {
    const { s: boardScale } = await viewNow(page);
    await waitingFor(c, nb, play, page, asked, size);
    await slipped(c, nb, play, page, asked, size);
    for (const [k, g] of before.entries()) await underItsNote(page, g, `.answer-slip[data-slip="${4190 + k}"]`);
    await givenBack(page, boardScale, options.isMobile);
  });
}
// The zoom the board opened the page at, back at its next touch wherever the slides to the answer took it
// (bookgroupshow.js giveBack): a wheel's turn, or on a phone (no wheel) a finger's tap, which draws a dot there
async function givenBack(page, boardScale, phone) {
  const desk = await page.locator('#book .bk-desk').boundingBox(),
    [x, y] = [desk.x + desk.width / 2, desk.y + desk.height / 2];
  if (phone) await page.touchscreen.tap(x, y);
  else {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 4);
  }
  let now;
  await until(
    async () => Math.abs((now = await viewNow(page)).s - boardScale) < 0.001,
    () => `the board's zoom ${boardScale} back: ${JSON.stringify(now)}`,
    FEED_MS,
  );
}
// (nine short notes in three columns)
const GRID = Array.from({ length: 9 }, (_, i) => ({ column: i % 3 }));
// (a tall drawing, a short note, a tall drawing; under the short one the note asked about, and another under that)
const STAGGERED = {
  at: 3,
  notes: [{ column: 0, tall: true }, { column: 1 }, { column: 2, tall: true }, { column: 1 }, { column: 1 }],
};
// (three rows of four short notes; the second row's two middle ones asked about and answered already)
const ROWS = { at: 6, notes: Array.from({ length: 12 }, (_, i) => ({ column: i % 4, answered: i === 5 })) };
// The book reads its page as HQ loads, before the scene has placed anyone: an answer coming shows the agent's initial,
// then their face once the room is placed (stage.js stage:look). The look's scene held back till the initial is seen.
async function placedLate(browser, c) {
  const nb = notebookOn(c),
    asked = nb.typed(4150, 'Is this live yet?', 60, 60);
  asked.asking = { by: nb.ceo };
  nb.groups.push(asked);
  const context = await c.hqIn(browser, c.MINI, { notebooks: nb.seed });
  let release;
  const held = new Promise(go => (release = go));
  try {
    await context.route(/\/renderers\/[^/]+\/scene\.js$/, async r => {
      await held;
      await r.fallback();
    });
    const { page, errors } = await watchedPage(context);
    await page.goto(`${c.base}/?intro=0`);
    const at = `#book .bk-under .bk-answer-waiting[data-group="${asked.id}"] .bk-answer-face`,
      face = page.locator(at);
    await face.waitFor({ state: 'attached', timeout: 10_000 });
    assert.equal(await face.textContent(), [...nb.name][0], "the agent's initial while the room is empty");
    release();
    await page.waitForSelector('#loading.gone');
    await page.waitForFunction(at => document.querySelector(at)?.style.backgroundImage, at, { timeout: 10_000 });
    assert.equal(await face.textContent(), '', 'their face, the initial gone');
    await c.shot('answers-face-placed-late', page);
    assert.deepEqual(errors, []);
  } finally {
    release();
    await context.close();
  }
}
// the verdict's in: the face and three pencil dots by the note, the paper slid to both, where its answer will come;
// why, where none came
async function waitingFor(c, nb, play, page, asked, size) {
  play.asking(asked.id, { by: nb.ceo });
  const selector = `.bk-answer-waiting[data-group="${asked.id}"]`,
    waiting = page.locator(`#book .bk-under[data-g="${asked.id}"] ${selector}`);
  await waiting.waitFor({ timeout: FEED_MS });
  assert.ok(await waiting.locator('.bk-answer-face').count(), "the agent's face");
  assert.ok(await waiting.locator('.bk-answer-dots').count(), 'its pencil dots');
  await shownByItsNote(page, asked, selector);
  await underItsNote(page, asked, selector);
  for (const reason of ['Waiting for my turn to answer.', "I couldn't answer that. Ask again."]) {
    play.asking(asked.id, { by: nb.ceo, reason });
    await waiting.getByText(reason, { exact: true }).waitFor({ timeout: FEED_MS });
    assert.equal(await waiting.locator('.bk-answer-dots').count(), 0, 'the face explains why instead of thinking');
    await underItsNote(page, asked, selector);
  }
  play.asking(asked.id, { by: nb.ceo });
  await waiting.locator('.bk-answer-dots').waitFor({ timeout: FEED_MS });
  await c.shot(`answers-waiting-${size}`, page);
}
// the answer: its slip by the note, the paper slid to both, the dots gone
async function slipped(c, nb, play, page, asked, size) {
  const { id } = play.answer(asked.id, nb.answer(asked, 'text', WENT_LIVE));
  const slip = slipOf(page, asked, id);
  await slip.waitFor({ timeout: FEED_MS });
  await page.locator('#book .bk-answer-waiting').waitFor({ state: 'detached', timeout: FEED_MS });
  assert.match(await slip.locator('.slip-text').innerText(), /went live this morning/);
  await shownByItsNote(page, asked, `.answer-slip[data-slip="${id}"]`);
  await underItsNote(page, asked, `.answer-slip[data-slip="${id}"]`);
  await c.shot(`answers-slipped-${size}`, page);
}

async function kinds(browser, c) {
  const nb = notebookOn(c),
    chart = nb.typed(4300, 'how did signups go this week', 60, 60),
    colour = nb.typed(4301, 'which colour for the badge', 60, 60),
    banner = nb.typed(4302, 'the banner wraps on my phone', 60, 60);
  const ink = [{ color: '#2b2b2b', size: 3, points: [0, 1, 2].map(i => [i * 40, 40 - i * 15, 0.5, i * 20]) }],
    form = [
      { title: 'Which colour?', options: ['Warm', 'Cool'] },
      { title: 'Anything else?', optional: true },
    ];
  nb.groups.push(chart, colour, banner);
  nb.seed.slips.push(
    { id: 4310, ...nb.answer(chart, 'drawing', 'Up a bit since Monday:', { ink }) },
    { id: 4311, ...nb.answer(colour, 'form', 'Two quick ones:', { form }) },
    { id: 4312, ...nb.answer(banner, 'question', 'Shall I make it one line on phones?') },
  );
  await inStory(browser, c, { viewport: c.MINI, nb }, async page => {
    const sheet = slipOf(page, colour, 4311).locator('.bk-answer-form');
    await sheet.waitFor({ timeout: FEED_MS });
    for (const [g, id] of [
      [chart, 4310],
      [colour, 4311],
      [banner, 4312],
    ])
      await underItsNote(page, g, `.answer-slip[data-slip="${id}"]`);
    await c.shot('answers-kinds', page);
    // (the overview first: an answered form is no longer open, bookanswer.ts openList)
    await openListed(c, page, nb.p, slipOf(page, banner, 4312));
    await formSent(c, page, sheet);
  });
}
// A drawing answer's strokes on its slip, under its words: a small chart and a
// line wider than any slip, both kept inside it
async function drawn(browser, c, viewport, size, options) {
  const nb = notebookOn(c),
    small = nb.typed(4320, 'how did signups go this week', 60, 60),
    wide = nb.typed(4321, 'and over the whole year?', 60, 60),
    chart = [
      { color: '#12808a', size: 3, points: [0, 1, 2, 3].map(i => [10 + i * 40, 70 - i * 18, 0.5, i * 20]) },
      {
        color: '#b06a12',
        size: 4,
        points: [
          [10, 80, 0.5, 0],
          [140, 80, 0.5, 40],
        ],
      },
    ],
    year = [
      { color: '#4458c9', size: 4, points: [...Array(13).keys()].map(i => [i * 100, 40 + (i % 2) * 60, 0.5, i * 20]) },
    ];
  nb.groups.push(small, wide);
  nb.seed.slips.push(
    { id: 4330, ...nb.answer(small, 'drawing', 'Up a bit since Monday:', { ink: chart }) },
    { id: 4331, ...nb.answer(wide, 'drawing', 'The year, month by month:', { ink: year }) },
  );
  await inStory(browser, c, { viewport, nb, options }, async page => {
    await inkOnSlip(page, small, 4330, chart);
    await inkOnSlip(page, wide, 4331, year);
    await c.shot(`answers-drawn-${size}`, page);
    // (no field under an answer: the board answers from the scrap opened, its sheet's key, notebookasks.mjs)
    assert.equal(await slipOf(page, small, 4330).locator('textarea, input').count(), 0, 'no field under an answer');
  });
}
// slip id's drawing (ink) under note g's words, on the slip, every stroke in view
async function inkOnSlip(page, g, id, ink) {
  const slip = slipOf(page, g, id),
    svg = slip.locator('svg.bk-slip-ink');
  await svg.waitFor({ timeout: FEED_MS });
  await svg.scrollIntoViewIfNeeded();
  await underItsNote(page, g, `.answer-slip[data-slip="${id}"]`);
  const seen = await slip.evaluate(el => {
    const box = e => e.getBoundingClientRect().toJSON(),
      svg = el.querySelector('.bk-slip-ink');
    return {
      slip: box(el),
      words: box(el.querySelector('.slip-text')),
      svg: box(svg),
      paths: [...svg.querySelectorAll('path')].map(box),
    };
  });
  const shown = JSON.stringify(seen);
  assert.ok(seen.svg.top >= seen.words.bottom, `under its words: ${shown}`);
  assert.ok(
    seen.svg.left >= seen.slip.left - TILT && seen.svg.right <= seen.slip.right + TILT,
    `on its slip: ${shown}`,
  );
  assert.equal(seen.paths.length, ink.length, 'a line for every stroke');
  seen.paths.forEach((p, i) => {
    const inside = p.width > 0 && p.left >= seen.svg.left - 4 && p.right <= seen.svg.right + 4;
    assert.ok(inside, `stroke ${i} in view: ${shown}`);
  });
}
// (a slip's half-degree tilt, in screen px)
const TILT = 3;
// the form answered, and sent
async function formSent(c, page, sheet) {
  await sheet.scrollIntoViewIfNeeded();
  // (its slip beside its note, past the paper's side: panned to)
  await inSight(page, '.answer-slip[data-slip="4311"]');
  await sheet.getByRole('button', { name: 'Warm' }).click();
  await c.shot('answers-form', page);
  const from = c.posts.length;
  await sheet.locator('button.bk-answer-send').click();
  const sent = await postOf(c, from, '/api/notebooks/answers/form');
  assert.ok(sent, 'the form went');
  assert.equal(sent.body.id, 4311);
  assert.equal(sent.body.answers?.[0], 'Warm', "the board's pick");
}
// the overview lists what's open beside its grid of pages, which shows the story's page and no error, a tap turning to
// its page (the question's slip there)
async function openListed(c, page, p, question) {
  await overview(page);
  // (the turn's picture of the overview gone first: it shows the same list for a moment.)
  await page.waitForSelector('#book .bk-turn-picture', { state: 'detached' });
  const item = page.locator('#book .bk-open .bk-open-item[data-answer="4312"][data-kind="question"]:visible');
  await item.waitFor({ timeout: FEED_MS });
  const form = page.locator('#book .bk-open .bk-open-item[data-answer="4311"][data-kind="form"]:visible');
  assert.ok(await form.count(), 'the open form');
  const grid = page.getByRole('list', { name: 'The overview' });
  await grid.locator(`.bk-tile[data-id="${p.id}"]`).waitFor({ timeout: FEED_MS });
  assert.equal(await grid.locator('.bk-far-lost').count(), 0, 'the grid read, no error in its place');
  await c.shot('answers-open', page);
  await item.click();
  await page.waitForTimeout(c.settle);
  // (the turn's picture of the page gone first: it holds a copy of its answers.)
  await page.waitForSelector('#book .bk-turn-picture', { state: 'detached' });
  assert.ok(await question.isVisible(), 'a tap turns to its page');
}

// (the call's agent writes it itself, through its book tool: the same answer, the same place)
async function onCall(browser, c) {
  const nb = notebookOn(c, { kind: 'call', label: `Call with ${c.org.company.ceo}` }),
    asked = nb.typed(4500, 'what does reach count here?', 60, 60);
  nb.groups.push(asked, nb.typed(4501, 'and on the phone?', 60, 60));
  await inStory(browser, c, { viewport: c.MINI, nb }, async (page, play) => {
    const { id } = play.answer(asked.id, nb.answer(asked, 'text', 'People who saw it at least once, not views.'));
    await slipOf(page, asked, id).waitFor({ timeout: FEED_MS });
    await shownByItsNote(page, asked, `.answer-slip[data-slip="${id}"]`);
    await underItsNote(page, asked, `.answer-slip[data-slip="${id}"]`);
    await c.shot('answers-call', page);
  });
}
