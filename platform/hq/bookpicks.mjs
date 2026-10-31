// book-check.mjs's pick stories: circle a version to choose it
// (shell/ink/bookversions.js; the coordinator's ink/bookpick.ts). Under a note, the board circles one of its versions,
// with the Pencil on an iPad mini, a finger on a phone and a mouse on a desktop: once the pen rests, the circle goes as
// a reply on that version (the one it's drawn round, with the box its picture shows in), and stays drawn where it was.
// Nothing in HQ reads the circle: the store's judge does, played here on the store's own pick (a tick on the version the
// reply is on), and the block stamps it CHOSEN, the others to be cleared once the page is sent. A tick on another moves the
// pick. On a call's page the same. (Its Notebook played by triedNote)
// The iPad turned after a circle, the circle stays round the version it chose
import assert from 'node:assert/strict';
import { inStory } from './bookanswers.mjs';
import { clearOfTools } from './bookversions.mjs';
import { childrenOf, layer, stroke, triedNote } from './bookanswersplay.mjs';

// The circle sent once the pen rests, read as a pick and the page read again: about a second, but the played store's
// routes hand a post back several seconds late while the browser's connections are taken (a reply's own wait)
const LANDS_MS = 15_000;
const REPLY = '/api/notebooks/groups/reply';
// The stamp pressed before a shot (headless WebKit draws about a frame a second, so its press ends late)
const STAMPED_MS = 1500;
// A circle drawn as a hand draws one, about half a second round
const PACE_MS = 12;

// c: book-check's { hqIn, base, store, pages, posts, org, shot, settled, settle, MINI, UPRIGHT, PHONE, DESKTOP, pullLip }
export function pickStories(c) {
  return {
    'a circle round a version chooses it, stamped CHOSEN, and a tick on another moves the pick: the Pencil on an iPad mini':
      browser => picked(browser, c, { viewport: c.MINI, size: 'mini', pointer: 'pen', moves: true }),
    'a circle round a version chooses it on a desktop (a mouse) and a phone (a finger)': async browser => {
      await picked(browser, c, {
        viewport: c.DESKTOP,
        size: 'desktop',
        pointer: 'mouse',
        options: { hasTouch: false, deviceScaleFactor: 1 },
      });
      await picked(browser, c, {
        viewport: c.PHONE,
        size: 'phone',
        pointer: 'touch',
        options: { hasTouch: true, isMobile: true },
      });
    },
    "on a call's page, a circle round a version chooses it the same way": browser =>
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
  const { nb, warmer, version } = triedNote(c, call ? { kind: 'call', label: `Call with ${c.org.company.ceo}` } : {});
  warmer.tried = { ...warmer.tried, going: false };
  nb.seed.slips.push(...VERSIONS.map(([id, name, picture]) => ({ id, ...version(name, picture) })));
  await inStory(browser, c, { viewport, nb, options }, async (page, play) => {
    judged(play, warmer);
    const of = id => childrenOf(play, warmer).find(v => v.id === id);
    const frame = id => layer(page).locator(`.bk-version[data-answer="${id}"]`);
    await frame(4612).waitFor({ timeout: LANDS_MS });
    await page.waitForTimeout(c.settle);
    await clearOfTools(page, '.bk-version-paper');
    await circle(page, 4611, pointer);
    await wetRound(page, 4611);
    await frame(4611).locator('.bk-version-stamp').waitFor({ timeout: LANDS_MS });
    const sent = c.posts.filter(x => x.path === REPLY).at(-1)?.body;
    assert.equal(sent?.answer, 4611, 'the circle went to the version it was drawn round');
    const shown = await paperPx(page, 4611);
    assert.ok(near(sent.frame, shown), `with the box its picture shows in: ${JSON.stringify([sent.frame, shown])}`);
    assert.ok(sent.ink.length >= 1 && sent.ink[0].points.length > 10, 'the circle as the pen drew it');
    assert.deepEqual(pickedOnPage(await stamps(page)), [4611], 'the block shows the pick, stamped');
    assert.ok((await layer(page).locator('.bk-versions .bk-reply-sent path').count()) >= 1, 'the circle stays drawn');
    assert.equal(await layer(page).getByRole('img', { name: 'Chosen' }).count(), 1);
    assert.deepEqual(
      await layer(page)
        .locator('.bk-version[data-cleared]')
        .evaluateAll(els => els.map(el => +el.dataset.answer)),
      [4610, 4612],
      'the others greyed, to be cleared once the page is sent',
    );
    assert.ok(of(4611).picked && !of(4610).picked);
    await page.waitForTimeout(STAMPED_MS);
    await c.shot(`picks-circled-${size}`, page);
    if (!moves) return;
    await turned(page, c, {
      reply: childrenOf(play, warmer).find(r => r.kind === 'reply' && r.answers === 4611),
      sent,
      viewport,
      size,
    });
    // a tick on the first moves it: one pick per try
    await tick(page, 4610, pointer);
    await frame(4610).locator('.bk-version-stamp').waitFor({ timeout: LANDS_MS });
    assert.equal(c.posts.filter(x => x.path === REPLY).at(-1)?.body.answer, 4610);
    assert.deepEqual(pickedOnPage(await stamps(page)), [4610], 'the stamp moved');
    await page.waitForTimeout(STAMPED_MS);
    await c.shot(`picks-moved-${size}`, page);
  });
}

// The iPad turned upright after the circle: the frames wrap anew, and the circle, read back with its frame, still rings
// the one it chose; then turned back
async function turned(page, c, { reply, sent, viewport, size }) {
  assert.ok(near(reply?.frame, sent.frame), `the reply read back with its frame: ${JSON.stringify(reply?.frame)}`);
  const before = await ringed(page, 4611);
  await page.setViewportSize(c.UPRIGHT);
  await c.settled(page, 'folded');
  await c.pullLip(page, -600);
  await c.settled(page, 'spread');
  await page.waitForTimeout(c.settle);
  const after = await ringed(page, 4611);
  assert.ok(
    ['x', 'y', 'w'].some(k => Math.abs(before.paper[k] - after.paper[k]) >= 2),
    `the turn moved the frame on the block: ${JSON.stringify([before.paper, after.paper])}`,
  );
  assert.ok(around(after.ink, after.paper), `the circle still round it: ${JSON.stringify(after)}`);
  await c.shot(`picks-turned-${size}`, page);
  await page.setViewportSize(viewport);
  await c.settled(page, 'open');
  await page.waitForTimeout(c.settle);
}

// The judge, played: each new reply on a version is read as its pick (bookpick.ts pickNow), through the store's own
// pick, a tick on that version
function judged(play, warmer) {
  const read = new Set();
  play.listen(() =>
    queueMicrotask(() => {
      const children = childrenOf(play, warmer),
        versions = new Set(children.filter(v => v.style === 'version').map(v => v.id));
      for (const r of children.filter(r => r.kind === 'reply' && versions.has(r.answers) && !read.has(r.id))) {
        read.add(r.id);
        play.route('/api/notebooks/answers/tick', {}, { id: r.answers, ticked: true });
      }
    }),
  );
}

// The circle as the pen draws it, wet, round the version's picture where the board drew it (before it's gone)
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
    `the circle drawn round it as the pen goes: ${JSON.stringify([wet, paper])}`,
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
// A version's picture and its reply's ink, in the px of the block its frames wrap in
const ringed = (page, id) =>
  page.evaluate(id => {
    const paper = document.querySelector(`#book .bk-version[data-answer="${id}"] .bk-version-paper`),
      surface = paper?.closest('.bk-versions-frames'),
      ink = surface?.querySelector(`.bk-reply-sent > g[data-on="${id}"]`);
    if (!ink) return null;
    const o = surface.getBoundingClientRect(),
      box = el => {
        const r = el.getBoundingClientRect();
        return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
      };
    return { paper: box(paper), ink: box(ink) };
  }, id);
const around = (a, b) => a.x < b.x && a.y < b.y && a.x + a.w > b.x + b.w && a.y + a.h > b.y + b.h;
const near = (a, b) => a && b && ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < 2);

// A circle round a version's picture, in screen px, as a hand draws one: a loop a little outside it, a little more than
// once round. A finger starts it on the picture (elsewhere a finger moves the page), the Pencil and a mouse outside it.
async function circle(page, id, pointer) {
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
