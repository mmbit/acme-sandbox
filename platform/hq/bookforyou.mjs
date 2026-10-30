// book-check.mjs's stories of what's still the board's to answer on a Notebook page (shell/ink/bookforyou.js), on the
// played Notebook seeded as dev mode's (mock/notebook.json) with two more cards on its sent page: one open and one
// answered, beside Moss's open one. On a phone and an iPad mini, upright: the page counts "2 open" over its name, the two
// groups edged "for you" and the answered one not; next slides the page to the first open ask, next again to the
// second; a chip tapped there answers it and the count drops to "1 open"; once none is open the same arrows step
// through every scrap on the page, round to the first again.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { open } from './booknotebook.mjs';
import { turnTo } from './booknotebookscreen.mjs';
import { islandsClearOf, until } from './bookkit.mjs';

const SEED = JSON.parse(await readFile(new URL('./mock/notebook.json', import.meta.url), 'utf8'));
const PHONE = { width: 390, height: 844 },
  MINI_UPRIGHT = { width: 744, height: 1133 };
// the seed's sent page (the first of My Notebook's)
const SENT = 1;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function forYouStories(c) {
  return {
    'asks for you on a phone: "2 open" by the title, next going to each, one answered in the book leaving "1 open", none open stepping through every scrap':
      browser => story(browser, c, 'phone', PHONE, { isMobile: true, folded: true }),
    'asks for you on an iPad mini upright: "2 open" by the title, next going to each, one answered in the book leaving "1 open", none open stepping through every scrap':
      browser => story(browser, c, 'mini', MINI_UPRIGHT, { folded: true }),
  };
}

async function story(browser, c, name, viewport, more) {
  const { page, play, errors, done } = await open(browser, c, viewport, {
    hasTouch: true,
    notebooks: seeded(),
    ...more,
  });
  try {
    await answeredByPlay(page, play, c);
    await turnTo(page, SENT);
    const count = page.locator('#book .bk-for-you-count');
    const edged = await twoOpen(page, count, c, name);
    await answeredInTheBook(page, count, edged, c, name);
    await everyScrap(page, play, count, c, name);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// "2 open", the two groups edged; next the first open ask down the page, then the second. → the edged groups' ids
async function twoOpen(page, count, c, name) {
  await until(async () => (await count.getAttribute('data-open')) === '2', 'two asks open on the page');
  assert.equal(await count.locator('.bk-open').textContent(), '2 open');
  const edged = await edges(page);
  assert.deepEqual([...edged].sort(), [2, 3], 'the two groups with an open ask edged "for you", the answered one not');
  await c.shot(`for-you-${name}-open`, page);
  for (const id of edged) {
    await count.getByRole('button', { name: 'The next open ask' }).tap();
    await until(async () => (await count.getAttribute('data-at')) === String(id), `the step at group ${id}`);
    await until(() => inView(page, `.bk-for-you[data-g="${id}"]`), `group ${id}'s ask slid into view`);
    await until(() => tagReads(page, id), `group ${id}'s "for you" tag readable, on the paper and covered by nothing`);
  }
  await c.shot(`for-you-${name}-second`, page);
  return edged;
}
// The second answered here in the book with a chip: one left open
async function answeredInTheBook(page, count, [first, second], c, name) {
  const chip = `#book .bk-under[data-g="${second}"] .ask-slip:not([data-answered]) [data-choice]`;
  await page.locator(chip).first().tap();
  await until(async () => (await count.getAttribute('data-open')) === '1', 'one ask left open');
  assert.equal(await count.locator('.bk-open').textContent(), '1 open');
  assert.deepEqual(await edges(page), [first], 'only the one still open edged');
  await c.shot(`for-you-${name}-one-open`, page);
}
// The last answered on the desk phone: no dot, the arrows stepping through every scrap and round again
async function everyScrap(page, play, count, c, name) {
  const last = groupsOn(play)
    .flatMap(g => g.asks)
    .find(a => a.status === 'open');
  play.route('/api/requests/answer', {}, { id: last.id, answer: 'The wave' });
  await until(async () => (await count.getAttribute('data-open')) === '0', 'nothing open');
  assert.equal(await count.locator('.bk-open').textContent(), '', 'no count, no dot');
  assert.deepEqual(await edges(page), [], 'no edge left');
  const scraps = groupsOn(play).map(g => g.id),
    reached = [];
  for (let i = 0; i <= scraps.length; i++) {
    const was = await count.getAttribute('data-at');
    await count.getByRole('button', { name: 'The next scrap' }).tap();
    const at = await until(async () => {
      const now = await count.getAttribute('data-at');
      return now !== was && now;
    }, 'the next scrap reached');
    await until(() => inView(page, `.bk-reached[data-g="${at}"]`), `scrap ${at} slid into view`);
    reached.push(Number(at));
  }
  assert.deepEqual([...reached.slice(0, -1)].sort(), [...scraps].sort(), 'every scrap on the page, once each');
  assert.equal(reached.at(-1), reached[0], 'and round to the first again');
  await c.shot(`for-you-${name}-scraps`, page);
}

// The seed with two more cards on the sent page's groups: one open on its scrap, one answered on its first drawing
function seeded() {
  const seed = structuredClone(SEED),
    card = { agent: 'moss', name: 'Moss', kind: 'decision', questions: null, page: null };
  seed.asks.push(
    {
      ...{ ...card, id: 2, note: 3, title: 'The headline: warmer?' },
      body: 'Warmer, or as it is?\n\nChoose:\n- Warmer\n- As it is',
      ...{ status: 'open', answer: null, answered: null },
    },
    {
      ...{ ...card, id: 3, note: 1, title: 'The heart: keep it?' },
      body: 'Keep the heart on the cover?\n\nChoose:\n- Keep it\n- Drop it',
      ...{ status: 'answered', answer: 'Keep it', answered: '2026-10-28T09:00:00.000Z' },
    },
  );
  return seed;
}
// The desk phone's answer route played on the store, as the coordinator answers it (booknotebookasks.mjs)
async function answeredByPlay(page, play, c) {
  await page.context().route(`${c.base}/api/requests/answer`, r => {
    try {
      return r.fulfill({ json: play.route('/api/requests/answer', {}, r.request().postDataJSON()) });
    } catch (e) {
      return r.fulfill({ status: e.status ?? 500, json: { error: e.message } });
    }
  });
}
const groupsOn = play => play.route('/api/notebooks/pages/groups', { page: SENT }).groups;
// The groups edged "for you" on the page shown, top to bottom
const edges = page =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden);
    return [...shown.querySelectorAll(':scope > .bk-groups > .bk-for-you')]
      .sort((a, b) => a.offsetTop - b.offsetTop || a.offsetLeft - b.offsetLeft)
      .map(e => Number(e.dataset.g));
  });
// Whether a group on the page shown (what's drawn round it: its box with its answers and cards) lies whole on the
// paper, above the counter over the pages' row and clear of every control over the paper
const inView = async (page, selector) => {
  const box = await page.evaluate(selector => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden),
      el = shown.querySelector(`:scope > .bk-groups > ${selector}`);
    if (!el) return null;
    const r = el.getBoundingClientRect(),
      desk = document.querySelector('#book .bk-desk').getBoundingClientRect(),
      count = document.querySelector('#book .bk-for-you-count').getBoundingClientRect();
    const on = r.top >= desk.top && r.bottom <= count.top && r.left >= desk.left && r.right <= desk.right;
    return on && { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
  return box && islandsClearOf(page, box);
};
// Whether a group's "for you" tag on the page shown lies whole on the paper with nothing over its middle (hit-tested
// for this look only: the tag lets taps through to the page)
const tagReads = (page, id) =>
  page.evaluate(id => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden),
      tag = shown.querySelector(`:scope > .bk-groups > .bk-for-you[data-g="${id}"] b`),
      r = tag.getBoundingClientRect(),
      desk = document.querySelector('#book .bk-desk').getBoundingClientRect();
    tag.style.pointerEvents = 'auto';
    const over = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    tag.style.pointerEvents = '';
    return r.top >= desk.top && r.left >= desk.left && r.right <= desk.right && over === tag;
  }, id);
