// book-check.mjs's answers stories: Ink answers any note
// (shell/ink/bookanswers*.js; the coordinator's ink/bookjudge.ts, bookanswer.ts and booktry.ts), each on a Notebook of
// its own played by HQ's one stand-in (bookanswersplay.mjs). A board's note on a page: the agent's face and its pencil dots where
// the answer will land, then the answer written in by a small pen, with the hand-drawn bulb and the face, in free paper
// and never over the board's groups. A symbol written in its reply area (a tick, a Dutch krul, a cross, a question
// mark) goes to the agent as ink, nothing read from it. A drawing, a form (answered and sent) and an agent's question;
// the overview lists what's open (a note's versions: bookversions.mjs). On a call's page, the call's agent's answer lands the same way. On an iPad mini, a phone and a
// desktop. (Its Notebook played by notebookOn)
import assert from 'node:assert/strict';
import {
  FEED_MS,
  SYMBOLS,
  childrenOf,
  layer,
  notebookOn,
  onScreen,
  opened,
  pagePx,
  placed,
  stroke,
} from './bookanswersplay.mjs';
import { NARROWEST, overlapping } from '../coordinator/src/ink/answerspot.ts';
import { besideOnNarrower } from './bookanswersnarrow.mjs';

const WENT_LIVE = 'Yes: it went live this morning, at 09:12.';

// c: book-check's { hqIn, base, store, pages, posts, org, shot, settled, settle }
export function answerStories(c) {
  return {
    'an answer: the face and its dots, then written in by a pen beside the note, never over the board’s ink; each symbol in its reply area reaches the agent':
      browser => answered(browser, c, c.MINI, 'mini'),
    'an answer on a phone, an iPad upright and a desktop, in free paper': async browser => {
      await answered(browser, c, c.PHONE, 'phone', { hasTouch: true, isMobile: true });
      await answered(browser, c, { width: 744, height: 1133 }, 'mini-upright');
      await answered(browser, c, c.DESKTOP, 'desktop', { hasTouch: false, deviceScaleFactor: 1 });
    },
    'an agent’s drawing, form and question; the form answered; the overview lists what’s open': browser =>
      kinds(browser, c),
    "on a call's page, the call's agent's answer lands the same way": browser => onCall(browser, c),
    'an answer read before the room placed its agent wears their face once it has': browser => placedLate(browser, c),
    'an answer beside a note on a wide page lies below it where the book is narrower, clear of every note': browser =>
      besideOnNarrower(browser, c),
    "a note the board wrote later on an answer's narrow spot: on a narrower book the answer lies clear of it":
      browser => besideOnNarrower(browser, c, 'narrow'),
    "a note the board wrote on a narrower book over an answer's wide spot: on a wide book the answer lies clear of it":
      browser => besideOnNarrower(browser, c, 'wide'),
  };
}

// ---- the stories
// A story on HQ opened over its own Notebook, steps(page, the store it's played on), its errors none (exported for
// bookpicks.mjs)
export async function inStory(browser, c, { viewport, nb, options = {} }, steps) {
  const { page, errors, play, done } = await opened(browser, c, viewport, nb, options);
  try {
    await steps(page, play);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
// An answer settled: its pen done (data-written), and its box the same two frames running, the book done laying it out
export async function written(page, id) {
  await layer(page).locator(`.bk-answer[data-answer="${id}"][data-written]`).waitFor({ timeout: FEED_MS });
  await page.waitForFunction(
    sel => {
      const box = () => JSON.stringify(document.querySelector(sel)?.getBoundingClientRect());
      const before = box();
      return new Promise(go => requestAnimationFrame(() => requestAnimationFrame(() => go(box() === before))));
    },
    `#book .bk-answers .bk-answer[data-answer="${id}"]`,
    { timeout: FEED_MS },
  );
}
const overview = page =>
  page
    .locator('#book')
    .getByRole('button', { name: /^The overview/ })
    .click();
// The first post to path since from, once it's made (null if none is by FEED_MS)
async function postOf(c, from, path) {
  for (const end = Date.now() + FEED_MS; Date.now() < end; await new Promise(go => setTimeout(go, 100))) {
    const sent = c.posts.slice(from).find(x => x.path === path);
    if (sent) return sent;
  }
  return null;
}
// An answer as the board sees it (or its dots, waiting: the selector): across inside the paper the book shows, left of
// the controls at its right edge, Undo's column and the tool strip beside it, all of it, wherever the page is scrolled.
// Only on paper narrower than the narrowest an answer is placed for (answerspot.ts
// NARROWEST) may it run into their column, never under them.
export async function inPaper(page, id, selector = `.bk-answer[data-answer="${id}"]`) {
  const { at, paper, rail, strip } = await onScreen(page, selector);
  const shown = `answer ${id} at ${Math.round(at.x)}..${Math.round(at.x + at.w)} on paper ${Math.round(paper.w)} wide`;
  assert.ok(at.x >= paper.x && at.x + at.w <= paper.x + paper.w, `${shown}: inside the paper`);
  for (const r of [...rail, strip])
    assert.ok(
      paper.w < NARROWEST ? !overlapping(at, r) : at.x + at.w <= r.x,
      `${shown}: left of the controls from ${Math.round(r.x)}`,
    );
}

async function answered(browser, c, viewport, size, options = {}) {
  const nb = notebookOn(c),
    asked = nb.typed(4100, 'Is this live yet?', 60, 60),
    beside = nb.typed(4101, 'and the header colour', 60, 140);
  // (the board's ink to the note's right, so the free paper is below it)
  beside.ink = [
    {
      color: '#2b2b2b',
      size: 4,
      points: [
        [420, 60, 0.5, 0],
        [700, 90, 0.5, 40],
      ],
    },
  ];
  nb.groups.push(asked, beside);
  const spot = placed(nb, asked, { text: WENT_LIVE });
  await inStory(browser, c, { viewport, nb, options }, async (page, play) => {
    await waitingFor(c, nb, play, page, asked, spot, size);
    const id = await writtenIn(c, nb, play, page, asked, spot, size);
    await symbols(c, play, page, asked, id, options.hasTouch === false ? 'mouse' : 'pen', size);
  });
}
// The book reads its page as HQ loads, before the scene has placed anyone: the answer's head shows the agent's initial,
// then their face once the room is placed (stage.js stage:look). The look's scene held back till the initial is seen.
async function placedLate(browser, c) {
  const nb = notebookOn(c),
    asked = nb.typed(4150, 'Is this live yet?', 60, 60);
  nb.groups.push(asked);
  nb.seed.slips.push({ id: 4250, ...nb.answer(asked, 'text', 'Yes: this morning.', { dx: 0, dy: 120, w: 300 }) });
  const context = await c.hqIn(browser, c.MINI, { notebooks: nb.seed });
  let release;
  const held = new Promise(go => (release = go));
  try {
    await context.route(/\/renderers\/[^/]+\/scene\.js$/, async r => {
      await held;
      await r.fallback();
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${c.base}/?intro=0`);
    const face = layer(page).locator('.bk-answer[data-answer="4250"] .bk-answer-face');
    await face.waitFor({ state: 'attached', timeout: 10_000 });
    assert.equal(await face.textContent(), [...nb.name][0], "the agent's initial while the room is empty");
    release();
    await page.waitForSelector('#loading.gone');
    await page.waitForFunction(
      () => document.querySelector('#book .bk-answer[data-answer="4250"] .bk-answer-face')?.style.backgroundImage,
      null,
      { timeout: 10_000 },
    );
    assert.equal(await face.textContent(), '', 'their face, the initial gone');
    await c.shot('answers-face-placed-late', page);
    assert.deepEqual(errors, []);
  } finally {
    release();
    await context.close();
  }
}
// the verdict's in: the face and three pencil dots where the answer will go
async function waitingFor(c, nb, play, page, asked, spot, size) {
  play.asking(asked.id, { by: nb.ceo, spot });
  const waiting = layer(page).locator(`.bk-answer-waiting[data-group="${asked.id}"]`);
  await waiting.waitFor({ timeout: FEED_MS });
  assert.ok(await waiting.locator('.bk-answer-dots').count(), 'its pencil dots');
  for (const reason of ['Waiting for my turn to answer.', "I couldn't answer that. Ask again."]) {
    play.asking(asked.id, { by: nb.ceo, spot, reason });
    await waiting.getByText(reason, { exact: true }).waitFor();
    assert.equal(await waiting.locator('.bk-answer-dots').count(), 0, 'the face explains why instead of thinking');
  }
  play.asking(asked.id, { by: nb.ceo, spot });
  await waiting.locator('.bk-answer-dots').waitFor();
  await inPaper(page, asked.id, `.bk-answer-waiting[data-group="${asked.id}"]`);
  await c.shot(`answers-waiting-${size}`, page);
}
// the answer: written in by a small pen, quickly, with the bulb and the face, never over the board's groups
async function writtenIn(c, nb, play, page, asked, spot, size) {
  const { id } = play.answer(asked.id, nb.answer(asked, 'text', WENT_LIVE, spot));
  const slip = layer(page).locator(`.bk-answer[data-answer="${id}"]`);
  await slip.waitFor({ timeout: FEED_MS });
  const t0 = Date.now();
  await written(page, id);
  // (its pen takes 1.5 s at most, bookanswerpace.test.js; headless WebKit draws about a frame a second)
  assert.ok(Date.now() - t0 < 3500, `written in quickly (${Date.now() - t0} ms)`);
  assert.equal(await layer(page).locator('.bk-answer-waiting').count(), 0, 'its dots gone');
  assert.ok(await slip.locator('.bk-answer-bulb svg').count(), 'the hand-drawn bulb');
  assert.ok(await slip.locator('.bk-answer-face').count(), "the agent's face");
  assert.match(await slip.locator('.bk-answer-words').innerText(), /went live this morning/);
  assert.equal(await slip.locator('.bk-answer-pen').count(), 0, 'the pen away once written');
  const at = await pagePx(page, `.bk-answer[data-answer="${id}"]`);
  assert.ok(at, 'the answer in page px');
  for (const g of nb.groups) assert.ok(!overlapping(at, g.box), `the answer clear of group ${g.id}`);
  await inPaper(page, id);
  await c.shot(`answers-written-${size}`, page);
  return id;
}
// each symbol written in the reply area goes to the agent as ink, nothing read from it
async function symbols(c, play, page, asked, id, type, size) {
  const slip = layer(page).locator(`.bk-answer[data-answer="${id}"]`),
    reply = slip.locator('.bk-answer-reply');
  for (const [i, [name, draw]] of Object.entries(SYMBOLS).entries()) {
    const from = c.posts.length,
      r = await reply.boundingBox();
    assert.ok(r, 'the reply area shows');
    await stroke(page, draw(r.x + 12 + i * 44, r.y + 6, Math.min(28, r.height - 10)), type);
    const sent = await postOf(c, from, '/api/notebooks/groups/reply');
    assert.ok(sent, `the ${name} went as a reply`);
    assert.equal(sent.body.answer, id, `the ${name} under its answer`);
    assert.ok(sent.body.ink?.length, `the ${name} as ink`);
    // (the answer drawn again with it: its strip holds every reply's strokes so far.)
    const strokes = childrenOf(play, asked)
      .filter(r => r.kind === 'reply')
      .reduce((n, r) => n + r.ink.length, 0);
    await slip
      .locator('.bk-reply-sent path')
      .nth(strokes - 1)
      .waitFor({ state: 'attached', timeout: FEED_MS });
  }
  await c.shot(`answers-symbols-${size}`, page);
}

async function kinds(browser, c) {
  const nb = notebookOn(c),
    chart = nb.typed(4300, 'how did signups go this week', 60, 60),
    colour = nb.typed(4301, 'which colour for the badge', 60, 380),
    banner = nb.typed(4302, 'the banner wraps on my phone', 60, 820);
  const curve = Array.from({ length: 20 }, (_, i) => [
    i * 12,
    80 - Math.round(Math.sin(i / 4) * 30 + i * 2),
    0.5,
    i * 20,
  ]);
  const ink = [{ color: '#2b2b2b', size: 3, points: curve }],
    form = [
      { title: 'Which colour?', options: ['Warm', 'Cool'] },
      { title: 'Anything else?', optional: true },
    ];
  nb.groups.push(chart, colour, banner);
  // (each where the store places it: beside its note on a wide book, below it, right of the tool strip, on the mini's.
  const [up, two, shall] = ['Up a bit since Monday:', 'Two quick ones:', 'Shall I make it one line on phones?'];
  const atChart = placed(nb, chart, { text: up, ink: 80 }),
    atColour = placed(nb, colour, { text: two, questions: form.length }),
    atBanner = placed(nb, banner, { text: shall });
  nb.seed.slips.push(
    { id: 4310, ...nb.answer(chart, 'drawing', up, atChart, { ink }) },
    { id: 4311, ...nb.answer(colour, 'form', two, atColour, { form }) },
    { id: 4312, ...nb.answer(banner, 'question', shall, atBanner) },
  );
  await inStory(browser, c, { viewport: c.MINI, nb }, async page => {
    await written(page, 4310);
    assert.ok(
      await layer(page).locator('.bk-answer[data-answer="4310"] .bk-answer-ink path').count(),
      'a drawing, in ink',
    );
    const sheet = layer(page).locator('.bk-answer[data-answer="4311"] .bk-answer-form');
    await sheet.waitFor({ timeout: FEED_MS });
    assert.ok(await layer(page).locator('.bk-answer[data-answer="4312"]').count(), "the agent's question");
    for (const id of [4310, 4311, 4312]) await inPaper(page, id);
    await c.shot('answers-kinds', page);
    // (the overview first: an answered form is no longer open, bookanswer.ts openList)
    await openListed(c, page, nb.p);
    await formSent(c, page, sheet);
  });
}
// the form answered, and sent
async function formSent(c, page, sheet) {
  await sheet.getByRole('button', { name: 'Warm' }).click();
  const from = c.posts.length;
  await sheet.locator('button.bk-answer-send').click();
  const sent = await postOf(c, from, '/api/notebooks/answers/form');
  assert.ok(sent, 'the form went');
  assert.equal(sent.body.id, 4311);
  assert.equal(sent.body.answers?.[0], 'Warm', "the board's pick");
}
// the overview lists what's open beside its grid of pages, which shows the story's page and no error, a tap turning to its page
async function openListed(c, page, p) {
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
  assert.ok(await layer(page).locator('.bk-answer[data-answer="4312"]').isVisible(), 'a tap turns to its page');
}

// (the call's agent writes it itself, through its book tool: the same answer, the same place)
async function onCall(browser, c) {
  const nb = notebookOn(c, { kind: 'call', label: `Call with ${c.org.company.ceo}` }),
    asked = nb.typed(4500, 'what does reach count here?', 60, 60);
  nb.groups.push(asked);
  await inStory(browser, c, { viewport: c.MINI, nb }, async (page, play) => {
    const text = 'People who saw it at least once, not views.';
    const { id } = play.answer(asked.id, nb.answer(asked, 'text', text, placed(nb, asked, { text })));
    await written(page, id);
    const at = await pagePx(page, `.bk-answer[data-answer="${id}"]`);
    assert.ok(at && !overlapping(at, asked.box), "clear of the board's note");
    await inPaper(page, id);
    await c.shot('answers-call', page);
  });
}
