// book-check.mjs's answers stories: Ink answers any note
// (shell/ink/bookanswers*.js; the coordinator's ink/bookjudge.ts, bookanswer.ts and booktry.ts), on book-check's played
// store with the Notebook's groups routed here. A board's note on a page: the agent's face and its pencil dots where
// the answer will land, then the answer written in by a small pen, with the hand-drawn bulb and the face, in free paper
// and never over the board's groups. A symbol written in its reply area (a tick, a Dutch krul, a cross, a question
// mark) goes to the agent as ink, nothing read from it. A drawing, a form (answered and sent) and an agent's question;
// the overview lists what's open. A note that asks for a change gets versions: the tab on the note, its page filling
// in frame by frame. On a call's page, the call's agent's answer lands the same way. On an iPad mini, a phone and a
// desktop.
import assert from 'node:assert/strict';
import { freePage } from './bookmouse.mjs';
import { SYMBOLS, layer, notebookOn, onScreen, opened, overlaps, pagePx, routed, stroke } from './bookanswersplay.mjs';
import { NARROWEST, answerSpot } from '../coordinator/src/ink/answerspot.ts';
import { besideOnNarrower } from './bookanswersnarrow.mjs';

const WRITE_MS = 4000; // an answer seen and written in, as the feed brings it (its pen: well under two seconds)
const REST_MS = 1500; // a reply's ink, the pen rested, posted
const WENT_LIVE = 'Yes: it went live this morning, at 09:12.';

// c: book-check's { hqIn, base, store, pages, posts, org, shot, settled, settle }
export function answerStories(c) {
  return {
    'an answer: the face and its dots, then written in by a pen beside the note, never over the board’s ink; each symbol in its reply area reaches the agent':
      browser => answered(browser, c, c.MINI, 'mini'),
    'an answer on a phone and a desktop, in free paper': async browser => {
      await answered(browser, c, c.PHONE, 'phone', { hasTouch: true, isMobile: true });
      await answered(browser, c, c.DESKTOP, 'desktop', { hasTouch: false, deviceScaleFactor: 1 });
    },
    'an agent’s drawing, form and question; the form answered; the overview lists what’s open': browser =>
      kinds(browser, c),
    'a note asking for a change gets versions: its tab, and their page filling in frame by frame': browser =>
      versions(browser, c),
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
// A story on HQ opened over its own pages (made: the store's pages it made, gone after), its errors none (exported for
// bookpicks.mjs)
export async function inStory(browser, c, { viewport, nb, made, options = {}, more = {} }, steps) {
  const { page, errors, done } = await opened(browser, c, viewport, nb, options, more);
  try {
    await steps(page);
    assert.deepEqual(errors, []);
  } finally {
    for (const p of made) c.pages.splice(c.pages.indexOf(p), 1);
    await done();
  }
}
export const written = (page, id) =>
  layer(page).locator(`.bk-answer[data-answer="${id}"][data-written]`).waitFor({ timeout: WRITE_MS });
const overview = page =>
  page
    .locator('#book')
    .getByRole('button', { name: /^The overview/ })
    .click();
const posted = (c, from, path) => c.posts.slice(from).find(x => x.path === path);
// An answer as the board sees it (or its dots, waiting: the selector): across inside the paper the book shows, left of
// the controls at its right edge and clear of the tool strip over its left, all of it. On paper with no room for an
// answer at its least between them (the book at its least: answerspot.ts NARROWEST) it runs into the controls' column,
// never under the controls floating at its foot.
export async function inPaper(page, id, selector = `.bk-answer[data-answer="${id}"]`) {
  const { at, paper, rail, strip } = await onScreen(page, selector);
  const shown = `answer ${id} at ${Math.round(at.x)}..${Math.round(at.x + at.w)}`;
  assert.ok(at.x >= paper.x && at.x + at.w <= paper.x + paper.w, `${shown}: inside the paper`);
  for (const r of rail)
    assert.ok(
      paper.w < NARROWEST ? !overlaps(at, r) : at.x + at.w <= r.x,
      `${shown}: left of the controls from ${Math.round(r.x)}`,
    );
  assert.ok(!overlaps(at, strip), `${shown}: clear of the tool strip to ${Math.round(strip.x + strip.w)}`);
}

async function answered(browser, c, viewport, size, options = {}) {
  const p = freePage(c),
    nb = notebookOn(c, p),
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
  beside.box = { x: 60, y: 60 + 80, w: 640, h: 60 };
  nb.groups.push(asked, beside);
  // (where the store puts it, with its narrow spot for a narrower book: answerspot.ts.)
  const spot = answerSpot(asked.box, { text: WENT_LIVE }, [asked.box, beside.box], { x: 0, w: 1200 });
  await inStory(browser, c, { viewport, nb, made: [p], options }, async page => {
    await waitingFor(c, nb, page, asked, spot, size);
    const slip = await writtenIn(c, nb, page, asked, spot, size);
    await symbols(c, nb, page, asked, slip, options.hasTouch === false ? 'mouse' : 'pen', size);
  });
}
// The book reads its page as HQ loads, before the scene has placed anyone: the answer's head shows the agent's initial,
// then their face once the room is placed (stage.js stage:look). The look's scene held back till the initial is seen.
async function placedLate(browser, c) {
  const p = freePage(c),
    nb = notebookOn(c, p),
    asked = nb.typed(4150, 'Is this live yet?', 60, 60);
  asked.children = [nb.answer(4250, 'text', 'Yes: this morning.', { dx: 0, dy: 120, w: 300 })];
  nb.groups.push(asked);
  const context = await c.hqIn(browser, c.MINI);
  let release;
  const held = new Promise(go => (release = go));
  try {
    await routed(context, c, nb);
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
    c.pages.splice(c.pages.indexOf(p), 1);
    await context.close();
  }
}
// the verdict's in: the face and three pencil dots where the answer will go
async function waitingFor(c, nb, page, asked, spot, size) {
  asked.waiting = { by: nb.ceo, name: nb.name, style: 'text', spot };
  nb.tell();
  const waiting = layer(page).locator(`.bk-answer-waiting[data-group="${asked.id}"]`);
  await waiting.waitFor({ timeout: WRITE_MS });
  assert.ok(await waiting.locator('.bk-answer-dots').count(), 'its pencil dots');
  await inPaper(page, asked.id, `.bk-answer-waiting[data-group="${asked.id}"]`);
  await c.shot(`answers-waiting-${size}`, page);
}
// the answer: written in by a small pen, quickly, with the bulb and the face, never over the board's groups
async function writtenIn(c, nb, page, asked, spot, size) {
  delete asked.waiting;
  asked.children = [nb.answer(4201, 'text', WENT_LIVE, spot)];
  nb.tell();
  const slip = layer(page).locator('.bk-answer[data-answer="4201"]');
  await slip.waitFor({ timeout: WRITE_MS });
  const t0 = Date.now();
  await written(page, 4201);
  // (its pen takes 1.5 s at most, bookanswerpace.test.js; headless WebKit draws about a frame a second)
  assert.ok(Date.now() - t0 < 3500, `written in quickly (${Date.now() - t0} ms)`);
  assert.equal(await layer(page).locator('.bk-answer-waiting').count(), 0, 'its dots gone');
  assert.ok(await slip.locator('.bk-answer-bulb svg').count(), 'the hand-drawn bulb');
  assert.ok(await slip.locator('.bk-answer-face').count(), "the agent's face");
  assert.match(await slip.locator('.bk-answer-words').innerText(), /went live this morning/);
  assert.equal(await slip.locator('.bk-answer-pen').count(), 0, 'the pen away once written');
  const at = await pagePx(page, '.bk-answer[data-answer="4201"]');
  assert.ok(at, 'the answer in page px');
  for (const g of nb.groups) assert.ok(!overlaps(at, g.box), `the answer clear of group ${g.id}`);
  await inPaper(page, 4201);
  await c.shot(`answers-written-${size}`, page);
  return slip;
}
// each symbol written in the reply area goes to the agent as ink, nothing read from it
async function symbols(c, nb, page, asked, slip, type, size) {
  const reply = slip.locator('.bk-answer-reply');
  for (const [i, [name, draw]] of Object.entries(SYMBOLS).entries()) {
    const from = c.posts.length,
      r = await reply.boundingBox();
    assert.ok(r, 'the reply area shows');
    await stroke(page, draw(r.x + 12 + i * 44, r.y + 6, Math.min(28, r.height - 10)), type);
    for (const t = Date.now(); Date.now() - t < REST_MS + 2000; await page.waitForTimeout(100))
      if (posted(c, from, '/api/notebooks/groups/reply')) break;
    const sent = posted(c, from, '/api/notebooks/groups/reply');
    assert.ok(sent, `the ${name} went as a reply`);
    assert.equal(sent.body.answer, 4201, `the ${name} under its answer`);
    assert.ok(sent.body.ink?.length, `the ${name} as ink`);
    asked.children.push({ kind: 'reply', id: 9100 + from, by: 'board', ink: sent.body.ink, answers: 4201 });
    nb.tell();
    // (the answer drawn again with it: its strip holds every reply's strokes so far.)
    const strokes = asked.children.filter(r => r.kind === 'reply').reduce((n, r) => n + r.ink.length, 0);
    await slip
      .locator('.bk-reply-sent path')
      .nth(strokes - 1)
      .waitFor({ state: 'attached', timeout: WRITE_MS });
  }
  await c.shot(`answers-symbols-${size}`, page);
}

async function kinds(browser, c) {
  const p = freePage(c),
    nb = notebookOn(c, p),
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
  // (each below its note: no room beside it left of the controls on the mini's paper, as the store places them)
  const below = { dx: 0, dy: 64, w: 300 };
  chart.children = [nb.answer(4310, 'drawing', 'Up a bit since Monday:', below, { ink })];
  colour.children = [nb.answer(4311, 'form', 'Two quick ones:', below, { form })];
  banner.children = [nb.answer(4312, 'question', 'Shall I make it one line on phones?', below)];
  nb.groups.push(chart, colour, banner);
  const listed = (g, a) => ({
    id: a.id,
    group: g.id,
    page: p.id,
    notebook: 1,
    by: a.by,
    name: a.name,
    text: a.text,
    created: a.created,
  });
  nb.open.forms.push(listed(colour, colour.children[0]));
  nb.open.questions.push(listed(banner, banner.children[0]));
  await inStory(browser, c, { viewport: c.MINI, nb, made: [p] }, async page => {
    await written(page, 4310);
    assert.ok(
      await layer(page).locator('.bk-answer[data-answer="4310"] .bk-answer-ink path').count(),
      'a drawing, in ink',
    );
    const sheet = layer(page).locator('.bk-answer[data-answer="4311"] .bk-answer-form');
    await sheet.waitFor({ timeout: WRITE_MS });
    assert.ok(await layer(page).locator('.bk-answer[data-answer="4312"]').count(), "the agent's question");
    for (const id of [4310, 4311, 4312]) await inPaper(page, id);
    await c.shot('answers-kinds', page);
    await formSent(c, page, sheet);
    await openListed(c, page);
  });
}
// the form answered, and sent
async function formSent(c, page, sheet) {
  await sheet.getByRole('button', { name: 'Warm' }).click();
  const from = c.posts.length;
  await sheet.locator('button.bk-answer-send').click();
  await page.waitForTimeout(600);
  const sent = posted(c, from, '/api/notebooks/answers/form');
  assert.ok(sent, 'the form went');
  assert.equal(sent.body.id, 4311);
  assert.equal(sent.body.answers?.[0], 'Warm', "the board's pick");
}
// the overview lists what's open, a tap turning to its page
async function openListed(c, page) {
  await overview(page);
  // (the turn's picture of the overview gone first: it shows the same list for a moment.)
  await page.waitForSelector('#book .bk-turn-picture', { state: 'detached' });
  const item = page.locator('#book .bk-open .bk-open-item[data-answer="4312"][data-kind="question"]:visible');
  await item.waitFor({ timeout: WRITE_MS });
  const form = page.locator('#book .bk-open .bk-open-item[data-answer="4311"][data-kind="form"]:visible');
  assert.ok(await form.count(), 'the open form');
  await c.shot('answers-open', page);
  await item.click();
  await page.waitForTimeout(c.settle);
  // (the turn's picture of the page gone first: it holds a copy of its answers.)
  await page.waitForSelector('#book .bk-turn-picture', { state: 'detached' });
  assert.ok(await layer(page).locator('.bk-answer[data-answer="4312"]').isVisible(), 'a tap turns to its page');
}

// (a version's frame: an 8 × 6 picture, as the try run shoots them)
const RED =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGN4ZmODFTEMpAQAW3NBof5buBkAAAAASUVORK5CYII=';
// A board's note tried in versions: its page (p), its versions page made after it (tries, the one the book opens on),
// the played Notebook on them, the note, a version made, and the store's routes listing the pages (shared with bookpicks.mjs)
export function triedNote(c) {
  const p = freePage(c),
    tries = freePage(c),
    nb = notebookOn(c, p),
    warmer = nb.typed(4400, 'warmer?', 60, 60);
  Object.assign(tries, { label: `${nb.name} tries: warmer?`, tries: warmer.id });
  warmer.tries_page = tries.id;
  const version = (id, name, picture = RED) =>
    nb.answer(id, 'version', `${name}, as it would look`, null, { version: name, picture });
  nb.groups.push(warmer);
  const tile = x => ({
    id: x.id,
    title: x.label || 'Free page',
    tries: x.tries ?? null,
    sent: null,
    sending: false,
    archived: false,
    groups: 0,
  });
  const listed = () => ({
    notebook: { id: 1, name: 'My Notebook', kind: 'mine', archived: false },
    pages: c.pages.map(tile),
    archived: [],
  });
  const more = {
    '/api/notebooks': () => ({ shelf: [listed().notebook], archive: [] }),
    '/api/notebooks/pages': listed,
  };
  return { p, tries, nb, warmer, version, more };
}
async function versions(browser, c) {
  const { p, tries, nb, warmer, version, more } = triedNote(c);
  warmer.waiting = { by: nb.ceo, name: nb.name, style: 'versions', count: 3, spot: { dx: 280, dy: 0, w: 160 } };
  warmer.children = [version(4410, 'Sand and honey'), version(4411, 'Brick red')];
  await inStory(browser, c, { viewport: c.MINI, nb, made: [tries, p], more }, async page => {
    await tabbed(c, page, p);
    const frame = which => page.locator(`#book .bk-versions .bk-version${which}`);
    await frame('').first().waitFor({ timeout: WRITE_MS });
    assert.equal(await frame('[data-answer]').count(), 2, 'two in');
    assert.equal(await frame('[data-empty]').count(), 1, 'one still coming');
    await c.shot('answers-versions-filling', page);
    delete warmer.waiting;
    warmer.children.push(version(4412, 'Late sun'));
    nb.feed.push({ type: 'book', agent: nb.ceo, text: 'notebook', page: tries.id });
    nb.tell();
    await frame('[data-answer="4412"]').waitFor({ timeout: WRITE_MS });
    assert.equal(await frame('[data-empty]').count(), 0, 'all three in');
    await c.shot('answers-versions', page);
  });
}
// the note's "3 versions →" tab, turning to their page (the book opens on its last page, the versions')
async function tabbed(c, page, p) {
  const tab = page.locator('#book button.bk-versions-tab');
  if (!(await tab.isVisible())) {
    await overview(page);
    await page.getByRole('list', { name: 'The overview' }).locator(`.bk-tile[data-id="${p.id}"] .bk-tile-open`).click();
    await page.waitForTimeout(c.settle);
  }
  await tab.waitFor({ timeout: WRITE_MS });
  assert.match(await tab.innerText(), /3 versions/);
  await c.shot('answers-versions-tab', page);
  await tab.click();
  await page.waitForTimeout(c.settle);
}

// (the call's agent writes it itself, through its book tool: the same answer, the same place)
async function onCall(browser, c) {
  const p = freePage(c);
  Object.assign(p, { kind: 'call', label: `Call with ${c.org.company.ceo}`, call: 1 });
  const nb = notebookOn(c, p),
    asked = nb.typed(4500, 'what does reach count here?', 60, 60);
  nb.groups.push(asked);
  await inStory(browser, c, { viewport: c.MINI, nb, made: [p] }, async page => {
    asked.children = [
      nb.answer(4501, 'text', 'People who saw it at least once, not views.', { dx: 0, dy: 64, w: 300 }),
    ];
    nb.tell();
    await written(page, 4501);
    const at = await pagePx(page, '.bk-answer[data-answer="4501"]');
    assert.ok(at && !overlaps(at, asked.box), "clear of the board's note");
    await inPaper(page, 4501);
    await c.shot('answers-call', page);
  });
}
