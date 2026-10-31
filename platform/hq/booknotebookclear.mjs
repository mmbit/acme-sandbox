// book-check.mjs's story of where scraps land (the coordinator's notebookscraps.ts, played: shell/ink/notebookplay.js)
// on the narrowest papers the board reads on, a phone's and an upright iPad mini's book at its least: saved one after
// another, each scrap's unit and its post-it words lie inside the paper and under none of the controls, the two apart;
// and on a desktop's at the unit's own width, unscaled. (A page of units at five sizes: bookunitspage.mjs.)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { paperBox } from './bookmouse.mjs';
import { islandsClearOf } from './bookkit.mjs';
import { UNIT_W } from './shell/ink/scrapunit.js';

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
      for (const id of scraps) await page.locator(`#book .bk-words[data-g="${id}"]`).waitFor({ timeout: 30_000 });
      let above = null;
      for (const id of scraps) {
        const { k, unit } = await clear(page, size, id);
        // (a desktop's paper has room for a unit's own width: drawn unscaled)
        if (how === 'open') assert.ok(Math.abs(k - 1) < 0.01, `${size}: scrap ${id} unscaled (${k})`);
        else assert.ok(k <= 1, `${size}: scrap ${id} fitted to the paper (${k})`);
        // (the masonry lays the second beside or below the first, never over it)
        if (above)
          assert.ok(
            above.x + above.width <= unit.x + 0.5 || above.y + above.height <= unit.y + 0.5,
            `${size}: scrap ${id} clear of the one before`,
          );
        above = unit;
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

// A scrap's unit and its post-it words (bookunits.js) inside the paper, what shows of them under none of the controls: how much the page
// scales the unit to fit (its width drawn over UNIT_W), and the unit's box. (the
// old canvas's --fit and picture box gone with it)
async function clear(page, size, id) {
  const unit = await page.locator(`#book .bk-unit[data-unit="${id}"]`).boundingBox(),
    words = await page.locator(`#book .bk-words[data-g="${id}"]`).boundingBox(),
    paper = await paperBox(page);
  for (const [what, r] of [
    ['unit', unit],
    ['words', words],
  ]) {
    const where = `${size}: scrap ${id}'s ${what} at ${Math.round(r.x)}..${Math.round(r.x + r.width)}`;
    assert.ok(r.x >= paper.x && r.x + r.width <= paper.x + paper.width, `${where}: inside the paper`);
    // (what the paper shows of it: the page scrolls, and the paper ends where the tools start)
    const top = Math.max(r.y, paper.y),
      shown = { ...r, y: top, height: Math.min(r.y + r.height, paper.y + paper.height) - top };
    if (shown.height > 0) assert.ok(await islandsClearOf(page, shown), `${where}: under none of the controls`);
  }
  return { k: unit.width / UNIT_W, unit };
}
