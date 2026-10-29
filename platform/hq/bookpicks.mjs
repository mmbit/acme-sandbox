// book-check.mjs's pick stories: circle a version to pick it
// (shell/ink/bookanswerversions.js; the coordinator's ink/bookpick.ts). On a note's versions page the board rings one
// version, with the Pencil on an iPad mini, a finger on a phone and a mouse on a desktop: once the pen rests, the ring
// goes as a reply on that version (the one it's drawn round, with the box its picture shows in), and stays drawn where
// it was. Nothing in HQ reads the ring: the store's judge does, played here by the reply route, which picks the version
// it was on, and the page stamps it. A tick on another moves the pick. On a call's page the same.
import assert from 'node:assert/strict';
import { inStory } from './bookanswers.mjs';
import { layer, stroke, triedNote } from './bookanswersplay.mjs';

// The ring sent once the pen rests, read as a pick and the page read again: about a second, but the played store's
// routes hand a post back several seconds late while the browser's connections are taken (a reply's own wait)
const LANDS_MS = 15_000;
const REPLY = '/api/notebooks/groups/reply';
// The stamp pressed before a shot (headless WebKit draws about a frame a second, so its press ends late)
const STAMPED_MS = 1500;
// A ring drawn as a hand draws one, about half a second round
const PACE_MS = 12;

// c: book-check's { hqIn, base, store, pages, posts, org, shot, settled, settle, MINI, PHONE, DESKTOP }
export function pickStories(c) {
  return {
    'a ring round a version picks it, stamped, and a tick on another moves the pick: the Pencil on an iPad mini':
      browser => picked(browser, c, { viewport: c.MINI, size: 'mini', pointer: 'pen', moves: true }),
    'a ring round a version picks it on a phone (a finger) and a desktop (a mouse)': async browser => {
      await picked(browser, c, {
        viewport: c.PHONE,
        size: 'phone',
        pointer: 'touch',
        options: { hasTouch: true, isMobile: true },
      });
      await picked(browser, c, {
        viewport: c.DESKTOP,
        size: 'desktop',
        pointer: 'mouse',
        options: { hasTouch: false, deviceScaleFactor: 1 },
      });
    },
    "on a call's page, a ring round a version picks it the same way": browser =>
      picked(browser, c, { viewport: c.MINI, size: 'call', pointer: 'pen', call: true }),
  };
}

// Three versions of a header, as a try run shoots them: its colour is what differs
const header = (fill, ink) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240"><rect width="320" height="240" fill="#fbf8f2"/><rect width="320" height="64" fill="${fill}"/><circle cx="34" cy="32" r="14" fill="${ink}" opacity=".8"/><rect x="60" y="24" width="120" height="16" rx="8" fill="${ink}" opacity=".7"/><rect x="24" y="96" width="272" height="12" rx="6" fill="#d9d2c4"/><rect x="24" y="120" width="220" height="12" rx="6" fill="#d9d2c4"/><rect x="24" y="168" width="96" height="36" rx="10" fill="${fill}"/></svg>`,
  )}`;
const VERSIONS = [
  [4610, 'Warm sand', header('#e8c88a', '#5a4220')],
  [4611, 'Brick red', header('#b0412f', '#fff4e8')],
  [4612, 'Late sun', header('#f0a050', '#4a2a10')],
];

async function picked(browser, c, { viewport, size, pointer, options = {}, moves = false, call = false }) {
  const { p, tries, nb, warmer, version, more } = triedNote(c);
  if (call) Object.assign(p, { kind: 'call', label: `Call with ${c.org.company.ceo}`, call: 1 });
  warmer.children = VERSIONS.map(([id, name, picture]) => version(id, name, picture));
  const of = id => warmer.children.find(v => v.id === id);
  // (the judge, played: a reply on a version is read as its pick, and the page hears it changed)
  more[REPLY] = (_url, body) => {
    const id = 9000 + c.posts.length;
    for (const v of warmer.children) v.picked = v.id === body.answer ? new Date().toISOString() : null;
    warmer.children.push({ kind: 'reply', id, answers: body.answer, ink: body.ink, created: new Date().toISOString() });
    nb.feed.push({ type: 'book', agent: nb.ceo, text: 'notebook', page: tries.id });
    nb.tell();
    return { id, parent: warmer.id };
  };
  await inStory(browser, c, { viewport, nb, made: [tries, p], more, options }, async page => {
    const frame = id => layer(page).locator(`.bk-version[data-answer="${id}"]`);
    await frame(4612).waitFor({ timeout: LANDS_MS });
    await page.waitForTimeout(c.settle);
    await clearOfTools(page);
    await ring(page, 4611, pointer);
    await wetRound(page, 4611);
    await frame(4611).locator('.bk-version-stamp').waitFor({ timeout: LANDS_MS });
    const sent = c.posts.filter(x => x.path === REPLY).at(-1)?.body;
    assert.equal(sent?.answer, 4611, 'the ring went to the version it was drawn round');
    const shown = await paperPx(page, 4611);
    assert.ok(near(sent.frame, shown), `with the box its picture shows in: ${JSON.stringify([sent.frame, shown])}`);
    assert.ok(sent.ink.length >= 1 && sent.ink[0].points.length > 10, 'the ring as the pen drew it');
    assert.deepEqual(pickedOnPage(await stamps(page)), [4611], 'the page shows the pick, stamped');
    assert.ok((await layer(page).locator('.bk-versions .bk-reply-sent path').count()) >= 1, 'the ring stays drawn');
    assert.equal(await layer(page).getByRole('img', { name: 'Picked' }).count(), 1);
    assert.ok(of(4611).picked && !of(4610).picked);
    await page.waitForTimeout(STAMPED_MS);
    await c.shot(`picks-ringed-${size}`, page);
    if (!moves) return;
    // a tick on the third moves it: one pick per try
    await tick(page, 4612, pointer);
    await frame(4612).locator('.bk-version-stamp').waitFor({ timeout: LANDS_MS });
    assert.equal(c.posts.filter(x => x.path === REPLY).at(-1)?.body.answer, 4612);
    assert.deepEqual(pickedOnPage(await stamps(page)), [4612], 'the stamp moved');
    await page.waitForTimeout(STAMPED_MS);
    await c.shot(`picks-moved-${size}`, page);
  });
}

// The ring as the pen draws it, wet, round the version's picture where the board drew it (before it's gone)
async function wetRound(page, id) {
  const wet = await page.evaluate(() => {
      const r = document
        .querySelector('#book .bk-versions-frames > .bk-reply-ink .bk-reply-wet')
        ?.getBoundingClientRect();
      return r && { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
    paper = await page.locator(`#book .bk-version[data-answer="${id}"] .bk-version-paper`).boundingBox();
  assert.ok(
    wet && wet.x < paper.x && wet.y < paper.y && wet.x + wet.width > paper.x + paper.width,
    `the ring drawn round it as the pen goes: ${JSON.stringify([wet, paper])}`,
  );
}

// Every frame left of the tools floating at the paper's right, the islands' stack and the tool strip beside it, so a
// ring round one starts on the page
async function clearOfTools(page) {
  const tools = await page
      .locator('#book .bk-islands .bk-island, #book .bk-strip .bk-island')
      .evaluateAll(els => Math.min(...els.filter(el => el.offsetWidth).map(el => el.getBoundingClientRect().left))),
    rights = await layer(page)
      .locator('.bk-version-paper')
      .evaluateAll(els => els.map(el => el.getBoundingClientRect().right));
  assert.ok(
    rights.length && rights.every(x => x <= tools),
    `the versions clear of the tools: ${JSON.stringify([rights, tools])}`,
  );
}

// Which versions show a stamp, by id
const stamps = page =>
  layer(page)
    .locator('.bk-version[data-answer]')
    .evaluateAll(els => els.map(el => [Number(el.dataset.answer), !!el.querySelector('.bk-version-stamp')]));
const pickedOnPage = shown => shown.filter(([, on]) => on).map(([id]) => id);
// A version's picture in its own page's px (the layer it's in: the book shows two pages)
const paperPx = (page, id) =>
  page.evaluate(id => {
    const el = document.querySelector(`#book .bk-version[data-answer="${id}"] .bk-version-paper`),
      root = el?.closest('.bk-answers');
    if (!root) return null;
    const r = el.getBoundingClientRect(),
      o = root.getBoundingClientRect(),
      k = root.offsetWidth ? o.width / root.offsetWidth : 1;
    return { x: (r.left - o.left) / k, y: (r.top - o.top) / k, w: r.width / k, h: r.height / k };
  }, id);
const near = (a, b) => a && b && ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < 2);

// A ring round a version's picture, in screen px, as a hand draws one: a loop a little outside it, a little more than
// once round. A finger starts it on the picture (elsewhere a finger moves the page), the Pencil and a mouse outside it.
async function ring(page, id, pointer) {
  const r = await page.locator(`#book .bk-version[data-answer="${id}"] .bk-version-paper`).boundingBox();
  const cx = r.x + r.width / 2,
    cy = r.y + r.height / 2,
    rx = r.width / 2 + 10,
    ry = r.height / 2 + 10;
  const loop = Array.from({ length: 40 }, (_, i) => {
    const a = -Math.PI / 2 - 0.3 + (i / 39) * 2.25 * Math.PI;
    return [cx + Math.cos(a) * rx * (1 + 0.04 * Math.sin(3 * a)), cy + Math.sin(a) * ry];
  });
  const start = pointer === 'touch' ? [[cx - r.width * 0.2, r.y + 6]] : [];
  await stroke(page, [...start, ...loop], pointer, PACE_MS);
}
async function tick(page, id, pointer) {
  const r = await page.locator(`#book .bk-version[data-answer="${id}"] .bk-version-paper`).boundingBox();
  const s = Math.min(r.width, r.height) * 0.4,
    x = r.x + r.width / 2 - s / 2,
    y = r.y + r.height / 2 - s / 2;
  await stroke(
    page,
    [
      [x, y + s * 0.55],
      [x + s * 0.2, y + s * 0.75],
      [x + s * 0.35, y + s * 0.95],
      [x + s * 0.6, y + s * 0.5],
      [x + s, y],
    ],
    pointer,
  );
}
