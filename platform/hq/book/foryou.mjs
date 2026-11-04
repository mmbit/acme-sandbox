// book-check.mjs's stories of what's still the board's to answer on a Notebook page (shell/ink/bookforyou.js), on the
// played Notebook seeded as dev mode's (mock/notebook.json) with two more cards on its sent page: one open and one
// answered, beside Moss's open one. On a phone and an iPad mini, upright: the counter by the page's title says "2 open",
// the two groups edged "for you" and the answered one not, the page's long title ending in an ellipsis short of the
// counter; next slides the page to the first open ask, next again to
// the second; a chip tapped there answers it and the count drops to 1; once none is open the counter is away.
// (by the page's title.)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { open } from './notebook.mjs';
import { turnTo } from './notebookscreen.mjs';
import { UPRIGHT, until } from './kit.mjs';
import { islandsClearOf } from './islands.mjs';

const SEED = JSON.parse(await readFile(new URL('../mock/notebook.json', import.meta.url), 'utf8'));
const PHONE = { width: 390, height: 844 };
// the seed's sent page (the first of My Notebook's), and its title, longer than the head has room for
const SENT = 1,
  LONG = 'Cover ideas for the autumn shop window, the sign and the bench out front';

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function forYouStories(c) {
  return {
    'asks for you on a phone: "2 open" by the title, next going to each, one answered in the book leaving "1 open", none open putting the counter away':
      browser => story(browser, c, 'phone', PHONE, { isMobile: true, folded: true }),
    'asks for you on an iPad mini upright: "2 open" by the title, next going to each, one answered in the book leaving "1 open", none open putting the counter away':
      browser => story(browser, c, 'mini', UPRIGHT, { folded: true }),
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
    // (the book's own, not the copy a page turn shows over it.)
    const count = page.locator('#book .bk-for-you-count:not(.bk-turn-picture *)');
    const edged = await twoOpen(page, count, c, name);
    await answeredInTheBook(page, count, edged, c, name);
    await noneOpen(page, play, count, c, name);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// "2 open", the two groups edged; next the first open ask down the page, then the second. → the edged groups' ids
async function twoOpen(page, count, c, name) {
  await until(async () => (await count.getAttribute('data-open')) === '2', 'two asks open on the page');
  assert.equal(await count.locator('.bk-open').textContent(), '2 open');
  await titleEnds(page, count, c, name);
  const edged = await edges(page);
  assert.deepEqual([...edged].sort(), [2, 3], 'the two groups with an open ask edged "for you", the answered one not');
  await c.shot(`for-you-${name}-open`, page);
  for (const id of edged) {
    await count.getByRole('button', { name: 'The next open ask' }).tap();
    await until(async () => (await count.getAttribute('data-at')) === String(id), `the step at group ${id}`);
    await until(() => inView(page, `.bk-for-you[data-g="${id}"]`), `group ${id}'s ask slid into view`);
    await until(() => tagReads(page, id), `group ${id}'s "for you" tag readable, on the paper and covered by nothing`);
    // (the pulse the step rings it with faded or gone, so only the edge's line shows)
    await page.evaluate(() =>
      Promise.all(
        [...document.querySelectorAll('#book .bk-reached')].flatMap(el =>
          el.getAnimations().map(a => a.finished.catch(() => {})),
        ),
      ),
    );
    await until(() => still(page, `#book .bk-for-you[data-g="${id}"]`), `group ${id}'s slide over`);
    const { own, others } = await ringed(page, id);
    assert.deepEqual(own, ['inside', 'inside'], `group ${id}'s ring round its unit and its cards`);
    assert.deepEqual(others, [], `group ${id}'s ring round nothing else`);
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
// The last answered on the desk phone: the counter and its arrows away, nothing left edged (they stepped through every scrap, and showed on any page with one)
async function noneOpen(page, play, count, c, name) {
  const last = groupsOn(play)
    .flatMap(g => g.asks)
    .find(a => a.status === 'open');
  play.route('/api/requests/answer', {}, { id: last.id, answer: 'The wave' });
  await until(async () => await count.isHidden(), 'the counter away once nothing is open');
  assert.deepEqual(await edges(page), [], 'no edge left');
  await c.shot(`for-you-${name}-none-open`, page);
}

// The page's long title in its head ends in an ellipsis, its pencil whole and short of the counter (bookgroups.css)
async function titleEnds(page, count, c, name) {
  await c.shot(`for-you-${name}-title`, page);
  const seen = await page.evaluate(() => {
      const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden),
        b = shown.querySelector('.bk-title-tap'),
        words = b.firstElementChild;
      return {
        cut: words.scrollWidth > words.clientWidth + 1 && getComputedStyle(words).textOverflow === 'ellipsis',
        end: b.querySelector('svg').getBoundingClientRect().right,
      };
    }),
    counter = await count.boundingBox();
  assert.ok(seen.cut, `${name}: the long title ends in an ellipsis`);
  assert.ok(seen.end <= counter.x, `${name}: its pencil (to ${seen.end}) short of the counter (from ${counter.x})`);
}
// The seed with two more cards on the sent page's groups: one open on its scrap, one answered on its first drawing
function seeded() {
  const seed = structuredClone(SEED),
    card = { agent: 'moss', name: 'Moss', kind: 'decision', questions: null, page: null };
  seed.pages.find(p => p.id === SENT).label = LONG;
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
// The desk phone's answer route played on the store, as the coordinator answers it (notebookasks.mjs)
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
// A group's "for you" ring on the page shown, as the board sees it: the edge read on the screen alone (nothing else of
// the book shown, over white paper: neither the islands nor a neighbour's tag over its line), its line every pixel
// redder than its faint glow, and where the middle of its unit and of its card lie ({ own }), and which other units
// and cards on the page lie inside it or under its line ({ others }): 'inside' (no way out to the read's border but
// across the line), 'line' or 'outside' (bookforyou.js edge: drawn round each, never round the box round both)
async function ringed(page, id) {
  const edge = `#book .bk-page:not([hidden]) > .bk-groups > .bk-for-you[data-g="${id}"]`,
    { clip, own, others } = await page.evaluate(partsAround, [edge, id, READ_ROOM]);
  const alone = await page.addStyleTag({
    content:
      `#book, #book .bk-desk * { visibility: hidden !important; }` +
      `#book .bk-desk { visibility: visible !important; background: #fff !important; }` +
      `${edge}, ${edge} * { visibility: visible !important; }`,
  });
  // (at the screen's own pixels: a zoomed-out page's line is under a CSS px)
  const png = await page.screenshot({ clip });
  await alone.evaluate(el => el.remove());
  const src = `data:image/png;base64,${png.toString('base64')}`,
    where = await page.evaluate(whereInRead, [src, clip.width, [...own, ...others.map(([, m]) => m)], GLOW]);
  return {
    own: where.slice(0, own.length),
    others: others.map(([g], k) => `${g}: ${where[own.length + k]}`).filter(o => !o.endsWith('outside')),
  };
}
// (in the page) The screen read round an edge (clip: its box and READ_ROOM round it, on the screen), and the middles in
// it (CSS px) of its group's unit and card (own) and of each other unit and card there ([group, middle])
function partsAround([edge, id, room]) {
  const shown = document.querySelector(edge).parentElement.parentElement,
    r = document.querySelector(edge).getBoundingClientRect(),
    x = Math.max(0, Math.floor(r.left - room)),
    y = Math.max(0, Math.floor(r.top - room)),
    w = Math.min(innerWidth, Math.ceil(r.right + room)) - x,
    h = Math.min(innerHeight, Math.ceil(r.bottom + room)) - y;
  const middle = el => {
    const b = el.getBoundingClientRect();
    return [b.left + b.width / 2 - x, b.top + b.height / 2 - y];
  };
  const others = [...shown.querySelectorAll('.bk-unit[data-unit], :scope > .bk-groups > .bk-under[data-g]')]
    .map(el => [el.dataset.unit ?? el.dataset.g, middle(el)])
    .filter(([g, [mx, my]]) => g !== String(id) && mx >= 0 && my >= 0 && mx < w && my < h);
  return {
    clip: { x, y, width: w, height: h },
    own: [`.bk-unit[data-unit="${id}"]`, `:scope > .bk-groups > .bk-under[data-g="${id}"]`].map(q =>
      middle(shown.querySelector(q)),
    ),
    others,
  };
}
// (in the page) Where each point (CSS px) lies in a screen read of the edge alone over white, cssWidth CSS px wide:
// 'line', 'inside' (no way out to the read's border but across the line) or 'outside'. The line every pixel taken off
// white by more than glow in a channel.
async function whereInRead([src, cssWidth, points, glow]) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const { width: w, height: h } = img,
    k = w / cssWidth,
    g = Object.assign(document.createElement('canvas'), { width: w, height: h }).getContext('2d');
  g.drawImage(img, 0, 0);
  const { data } = g.getImageData(0, 0, w, h),
    line = new Uint8Array(w * h);
  // (a line a pixel thick, as a zoomed-out page draws it, leaves gaps between its corners' pixels: closed, each pixel
  // of it taking in its eight neighbours)
  for (let i = 0; i < line.length; i++) {
    if (![0, 1, 2].some(c => 255 - data[4 * i + c] > glow)) continue;
    const x = i % w;
    for (const dy of [-w, 0, w])
      for (const dx of [x > 0 ? -1 : 0, 0, x < w - 1 ? 1 : 0]) if (line[i + dy + dx] === 0) line[i + dy + dx] = 1;
  }
  return points.map(([cx, cy]) => {
    const start = Math.round(cy * k) * w + Math.round(cx * k);
    if (line[start]) return 'line';
    const seen = new Uint8Array(w * h),
      next = [start];
    seen[start] = 1;
    while (next.length) {
      const i = next.pop(),
        px = i % w,
        py = (i - px) / w;
      if (px === 0 || py === 0 || px === w - 1 || py === h - 1) return 'outside';
      for (const j of [i - 1, i + 1, i - w, i + w])
        if (!seen[j] && !line[j]) {
          seen[j] = 1;
          next.push(j);
        }
    }
    return 'inside';
  });
}
// (the read round an edge's box: past its glow, CSS px; and the most its glow takes off white in a channel, 0-255: its
// line takes more)
const READ_ROOM = 24,
  GLOW = 60;
// Whether what's at selector stands where it stood a moment ago on the screen: a slide to it over
async function still(page, selector) {
  const at = () => page.locator(selector).boundingBox().then(JSON.stringify),
    was = await at();
  await page.waitForTimeout(300);
  return was === (await at());
}
// Whether a group on the page shown (what's drawn round it: its box with its answers and cards) lies whole on the
// paper, clear of the counter and of every control over the paper
const inView = async (page, selector) => {
  const box = await page.evaluate(selector => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden),
      el = shown.querySelector(`:scope > .bk-groups > ${selector}`);
    if (!el) return null;
    const r = el.getBoundingClientRect(),
      desk = document.querySelector('#book .bk-desk').getBoundingClientRect();
    // (and clear of the counter by the title, over the paper's head)
    const c = document.querySelector('#book .bk-for-you-count').getBoundingClientRect(),
      on = r.top >= desk.top && r.bottom <= desk.bottom && r.left >= desk.left && r.right <= desk.right,
      clear = c.bottom <= r.top || c.top >= r.bottom || c.right <= r.left || c.left >= r.right;
    return on && clear && { x: r.x, y: r.y, width: r.width, height: r.height };
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
