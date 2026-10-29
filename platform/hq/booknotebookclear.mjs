// book-check.mjs's story of where scraps land (the coordinator's notebookscraps.ts, played: shell/ink/notebookstack.js)
// on the narrowest papers the board reads on, a phone's and an upright iPad mini's book at its least: saved one under
// another, each scrap's picture and words as drawn (fitted to the paper there: shell/ink/bookscrapfit.js) lie inside the
// paper and under none of the controls, each below the words above it; and on a desktop's at the store's readable
// width, as the store has them.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { onPaper } from './booknotebookscreen.mjs';
import { paperBox } from './bookmouse.mjs';
import { islandsClearOf } from './bookkit.mjs';
import { STACK } from './shell/ink/notebookstack.js';

const SEED = JSON.parse(await readFile(new URL('./mock/notebook.json', import.meta.url), 'utf8'));
const NEWEST = 3; // (the seed's open page, the one the book opens on)
const ANCHOR = { v: 1, url: '/', el: null, view: { x: 0, y: 0, w: 1280, h: 800, dpr: 2 }, ink: [] };
const SAID = ['Shorter', 'Make this headline shorter, and the button a warmer red'];

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn and snipPng
export function scrapsClearStories(c) {
  return {
    "scraps land clear of the tools on a phone and on an upright iPad mini's book at its least, readable on a desktop":
      browser => clearOfTools(browser, c),
  };
}

async function clearOfTools(browser, c) {
  for (const [size, viewport, how] of [
    ['phone', { width: 390, height: 844 }, 'lip'],
    ['mini-upright-least', { width: 744, height: 1133 }, 'least'],
    ['desktop', { width: 1440, height: 900 }, 'open'],
  ]) {
    const { context, page, errors } = await opened(browser, c, viewport, how);
    try {
      const scraps = SAID.map(
        words =>
          context.notebook.route(
            '/api/notebooks/groups/scrap',
            {},
            { anchor: ANCHOR, words, said: 'spoken', snip: c.snipPng(640, 320) },
          ).id,
      );
      for (const id of scraps) await page.locator(`#book .bk-under[data-g="${id}"]`).waitFor({ timeout: 30_000 });
      const { groups } = context.notebook.route('/api/notebooks/pages/groups', { page: NEWEST });
      let above = null;
      for (const g of groups.filter(x => scraps.includes(x.id))) {
        const { k, picture, words } = await clear(page, size, g);
        // (a desktop's paper has room for the store's readable width: drawn as the store has it)
        if (how === 'open') assert.deepEqual([g.pictures[0].w, k], [STACK.w, 1], `${size}: scrap ${g.id} readable`);
        else assert.ok(k < 1, `${size}: scrap ${g.id} fitted to the paper`);
        // (a caption never over the next scrap: the board, call 162)
        if (above) assert.ok(above.y + above.height <= picture.y, `${size}: scrap ${g.id} below the words above it`);
        above = words;
      }
      await c.shot(`scraps-clear-${size}`, page);
      c.noErrorsIn(errors);
    } finally {
      await context.close();
    }
  }
}

// HQ on the seed with its newest page emptied, so the scraps stack from its top, in view: a phone's book opened from
// its lip, upright beside HQ's page as the board leaves it with its cover's edge at its least (booklayout.js), or a
// desktop's as it opens
async function opened(browser, c, viewport, how) {
  const seed = structuredClone(SEED);
  seed.groups = seed.groups.filter(g => g.page !== NEWEST);
  const context = await c.hqIn(browser, viewport, { hasTouch: true, notebooks: seed }),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (how === 'least')
    await page.addInitScript(() =>
      localStorage.setItem('hq.book.portrait', JSON.stringify({ mode: 'open', book: 320 })),
    );
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#loading.gone');
  if (how === 'lip') {
    await c.settled(page, 'folded');
    await page.locator('#book .bk-lip').tap();
  }
  await c.settled(page, how === 'lip' ? 'spread' : 'open');
  return { context, page, errors };
}

// A scrap's picture and its words as drawn inside the paper, under none of the controls: how much it's scaled to fit
// (its words' --fit, as its picture is, about the store's box's top-left)
async function clear(page, size, g) {
  const under = page.locator(`#book .bk-under[data-g="${g.id}"]`),
    k = Number(await under.evaluate(el => el.style.getPropertyValue('--fit'))),
    paper = await paperBox(page),
    [[x0, y0], [x1, y1]] = await onPaper(page, [
      [g.box.x, g.box.y],
      [g.box.x + g.box.w * k, g.box.y + g.box.h * k],
    ]),
    words = await under.boundingBox(),
    picture = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  for (const [what, r] of [
    ['picture', picture],
    ['words', words],
  ]) {
    const where = `${size}: scrap ${g.id}'s ${what} at ${Math.round(r.x)}..${Math.round(r.x + r.width)}`;
    assert.ok(r.x >= paper.x && r.x + r.width <= paper.x + paper.width, `${where}: inside the paper`);
    assert.ok(await islandsClearOf(page, r), `${where}: under none of the controls`);
  }
  return { k, picture, words };
}
