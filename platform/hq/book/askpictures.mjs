// book-check.mjs's stories of a card's pictures on its slip in the Notebook (shell/ink/bookasks.js): an agent's card
// whose before-and-after pairs follow straight on from its words (the glass for the notebook's bars, its pictures
// made here, each its file's name on it), in place of Moss's card under the sent page's group of the played Notebook
// (seeded as dev mode's, mock/notebook.json):
//   - a phone and an iPad mini, the card open and answered: the slip's words name no picture's path or file; its pairs
//     shown small, each its label and its two pictures loaded, tagged Before and After; a tap on one opens the desk
//     phone's viewer over the whole book on that side, the next pair a key away, and ✕ closes it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { open } from './notebook.mjs';
import { turnTo } from './notebookscreen.mjs';
import { MINI, middleOf, until } from './kit.mjs';

const PHONE = { width: 390, height: 844 };
// the seed's sent page and the group its card is about (notebookasks.mjs)
const SENT = 1,
  GROUP = 2;
const GLASS = 'products/_cycles/t';
const LOOKS = [
  ['A Clear frost', 'a'],
  ['B Milk glass', 'b'],
  ['C Lit rim', 'c'],
];
// (what each pair shows, its file's part and its pictures' size, as the screenshots are)
const SHOWN = [
  ['the bars close up', 'bars', [780, 200]],
  ['iPhone', 'phone', [390, 844]],
  ['iPad', 'ipad', [744, 1133]],
];
const BODY = `Three versions of the notebook's tool strip and bottom bar in light glass, from lightly frosted to clearer, built for real in Slate. Each is shown beside today's bars, on your iPhone and an iPad, with the bars close up. About two minutes.
Before and after:
${LOOKS.flatMap(([look, v]) => SHOWN.map(([what, f]) => `- ${look}, ${what}: ${GLASS}/now-${f}.jpg ${GLASS}/${v}-${f}.jpg`)).join('\n')}
We recommend A: it keeps the short lip Slate's keys have, so it still reads as ours, with the least glass of the three.

Choose:
${LOOKS.map(([look]) => `- ${look}`).join('\n')}`;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function askPictureStories(c) {
  const sizes = { 'a phone': [PHONE, { isMobile: true, folded: true }], 'an iPad mini': [MINI, {}] };
  return Object.fromEntries(
    Object.entries(sizes).flatMap(([on, [viewport, more]]) =>
      ['open', 'answered'].map(status => [
        `a card's pairs on its slip as pictures, never paths, ${status}, on ${on}`,
        browser => pictured(browser, c, viewport, { ...more, hasTouch: true }, status),
      ]),
    ),
  );
}

async function pictured(browser, c, viewport, more, status) {
  const notebooks = await seeded(status);
  const { page, errors, done } = await open(browser, c, viewport, { ...more, notebooks });
  try {
    await page
      .context()
      .route(`${c.base}/cycles/**`, r =>
        r.fulfill({ contentType: 'image/svg+xml', body: pictureOf(new URL(r.request().url()).pathname) }),
      );
    await turnTo(page, SENT);
    const slip = page.locator(`#book .bk-under[data-g="${GROUP}"] .ask-slip`);
    await until(async () => (await slip.count()) === 1, 'the card under its group');
    await slip.scrollIntoViewIfNeeded();
    const name = `ask-pictures-${status}-${viewport === MINI ? 'ipad' : 'phone'}`;
    await page.waitForTimeout(600);
    await c.shot(name, page);
    await slipShown(slip, status);
    await viewed(page, slip, () => c.shot(`${name}-viewer`, page));
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
// A picture for a pair's file (/cycles/t/a-phone.jpg) at its size, its name on it, so a mix-up shows: a before's warm,
// an after's green
function pictureOf(path) {
  const name = path.replace(/^.*\/|\.jpg$/g, ''),
    [, , [w, h]] = SHOWN.find(([, f]) => name.endsWith(`-${f}`)),
    tone = name.startsWith('now-') ? '#f6d8c4' : '#cfe8d2';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${tone}"/><text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" font-size="32">${name}</text></svg>`;
}
// The slip's words, none a path or a file's name; its pairs small, each its label, Before and After, both loaded
async function slipShown(slip, status) {
  const said = await slip.innerText();
  assert.match(said, /Three versions of the notebook's tool strip/);
  assert.doesNotMatch(said, /_cycles|\.jpe?g|now-bars|products\//, 'no path on the slip');
  const pairs = slip.locator('.ask-pics .pair');
  assert.equal(await pairs.count(), 9);
  assert.equal(await pairs.first().locator('figcaption').textContent(), 'A Clear frost, the bars close up');
  assert.deepEqual(await pairs.first().locator('.ba span').allTextContents(), ['Before', 'After']);
  await until(
    () =>
      slip
        .locator('.ask-pics img')
        .evaluateAll(imgs => imgs.length === 18 && imgs.every(i => i.complete && i.naturalWidth > 0)),
    'every picture loaded',
    20_000,
  );
  if (status === 'answered') assert.match(said, /A Clear frost/);
  else assert.equal(await slip.locator('[data-choice]').count(), 3);
}
// A tap on the second pair's after: the desk phone's viewer over the whole book, on that side (shot()), the next pair
// a key away, ✕ closing it
async function viewed(page, slip, shot) {
  const after = slip
    .locator('.ask-pics .pair')
    .nth(1)
    .getByRole('button', { name: /\(after\)/ });
  await after.scrollIntoViewIfNeeded();
  await after.tap();
  const viewer = page.locator('#book > .pic-zoom');
  await viewer.waitFor({ timeout: 5000 });
  const [x, y] = middleOf(await viewer.boundingBox());
  assert.ok(
    await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.pic-zoom'), [x, y]),
    'over the book',
  );
  const head = () => viewer.locator('.pic-head').innerText();
  await until(async () => /A Clear frost, iPhone/.test(await head()), 'the pair');
  await until(
    () => viewer.locator('.pic-stage img:not([hidden])').evaluate(i => i.complete && i.naturalWidth > 0),
    'its after shown',
  );
  await page.waitForTimeout(400);
  await shot();
  await page.keyboard.press('ArrowDown');
  await until(async () => /A Clear frost, iPad/.test(await head()), 'the next pair');
  await viewer.getByRole('button', { name: 'Close' }).tap();
  await until(async () => !(await viewer.count()), 'the viewer closed');
}

// The dev seed with its card under the sent page's group (the seed's first) the glass card, open or answered
async function seeded(status) {
  const seed = JSON.parse(await readFile(new URL('../mock/notebook.json', import.meta.url), 'utf8'));
  const [ask] = seed.asks;
  Object.assign(ask, {
    title: "Pick the glass for the notebook's bars",
    body: BODY,
    name: 'Marloes',
    agent: 'marloes',
  });
  if (status === 'answered')
    Object.assign(ask, { status, answer: 'A Clear frost', answered: '2026-11-03T10:00:00.000Z' });
  return seed;
}
