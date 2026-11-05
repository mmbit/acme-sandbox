// book-check.mjs's stories of our scraps on a sketch page (the Ink README, "Our scraps"; shell/ink/bookpage.js photos,
// bookwrite.js, bookselect.js, bookunitcards.js), at realbook.mjs's sizes with
// their blur: an iPhone upright and an iPad on its side. My journal's sketch page holds a scrap and a drawing from
// yesterday, and two scraps come today, as the pin flow brings them:
//   - the look: each photo taped straight onto its post-it, one paper with its own shadow, no card under the photo;
//   - a stroke starts anywhere: in the scrap opened by the Pencil's tap, started on its photo and on its words by
//     Pencil, it's ink on that scrap, drawn on top of what it crosses;
//   - our scraps are fixed: there too, Select on a scrap's photo picks it whole and moves nothing, the page holding
//     still;
//   - dates: today's scraps have today's date just above them, across the page's columns.
// Recorded with --shots. (No room or handle under a scrap, no free drawing)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { closeScrap, openScrap, pixelsIn, toChapter, until } from './kit.mjs';
import { SIZES, opened } from './realbook.mjs';
import { inputs } from './hands.mjs';
import { typedBoxes } from '../shell/ink/notebookparts.js';

const PHOTO = `data:image/jpeg;base64,${readFileSync(new URL('../mock/ask-spot-1.jpg', import.meta.url)).toString('base64')}`,
  ANCHOR = { v: 1, url: 'https://hq.example/', el: null, view: { x: 0, y: 0, w: 1200, h: 800, dpr: 1 }, ink: [] };
// yesterday, as the book reads a unit's day
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString(),
  WORDS = 'Make the hero bolder',
  TYPED = { x: 0, w: 320, color: '#1d1a2f' };
const unit = (id, kind, more) => ({
  ...{ id, page: 1, kind, by: kind === 'drawing' ? 'board' : 'lyra', ink: [], texts: [], pictures: [], words: '' },
  ...{ said: 'typed', status: 'open', created: YESTERDAY, updated: YESTERDAY, pos: id, ...more },
});
const SEED = {
  notebooks: [{ id: 1, kind: 'mine', name: 'My journal', archived: false, created: YESTERDAY, updated: YESTERDAY }],
  pages: [{ id: 1, notebook: 1, pos: 0, label: 'Ideas', created: YESTERDAY, updated: YESTERDAY, w: 1200, h: 1600 }],
  groups: [
    unit(1, 'note', { texts: typedBoxes('A softer page turn, and a paper sound with it.', TYPED), h: 136 }),
    unit(2, 'drawing', {
      ink: [
        {
          color: '#2a2352',
          size: 3,
          points: [0, 1, 2, 3, 4, 5].map(k => [20 + k * 30, 20 + (k % 2) * 16, 0.5, k * 30]),
        },
      ],
      h: 60,
      column: 0,
    }),
  ],
  slips: [],
  asks: [],
  names: { lyra: 'Lyra' },
};

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function tapedStories(c) {
  return {
    'our scraps on an iPhone: taped onto their post-it, a stroke starts on a photo or its words, nothing in them moves, a later day dated':
      browser => taped(browser, c, 'iphone'),
    'our scraps on an iPad on its side: taped onto their post-it, a stroke starts on a photo or its words, nothing in them moves, a later day dated':
      browser => taped(browser, c, 'ipad'),
    'our scraps on an iPad mini upright: taped onto their post-it, a stroke starts on a photo or its words, nothing in them moves, a later day dated':
      browser => taped(browser, c, 'ipad-upright'),
  };
}

async function taped(browser, c, name) {
  const { context, p, errors } = await opened(browser, c, name, SIZES[name], SEED);
  try {
    const store = context.notebook,
      ids = [0, 1].map(
        () =>
          store.route('/api/notebooks/groups/scrap', {}, { anchor: ANCHOR, words: WORDS, said: 'typed', snip: PHOTO })
            .id,
      );
    await toChapter(p, 'sketch');
    await until(
      () => p.evaluate(ids => ids.every(g => document.querySelector(`#book .bk-words[data-g="${g}"]`)), ids),
      `${name}: today's scraps`,
    );
    await p.waitForTimeout(800);
    await firstInSight(p, ids[0]);
    await c.shot(`taped-${name}-scraps`, p);
    look(name, await p.evaluate(lookOf, ids[0]));
    dated(name, await p.evaluate(datesOf, ids));
    const hands = await inputs(p),
      kept = id => store.route('/api/notebooks/pages/groups', { page: 1 }).groups.find(g => g.id === id);
    // (in the scrap opened by the Pencil's tap, where the pen draws and a finger pans)
    const pen = { tap: at => hands.stroke('pen', [at]) };
    await openScrap(p, pen, ids[0]);
    for (const on of ['photo', 'words']) await startsOn(p, c, hands, kept, { name, type: 'pen', on, id: ids[0] });
    await fixed(p, c, hands, name, ids);
    await closeScrap(p, pen);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`taped-${name}-failed`, p);
    e.message = `${e.message} (page errors: ${errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await context.close();
  }
}

// The first of today's scraps in sight, the page panned across to it if the second's arrival slid it off (bookarrive.js:
// an agent's scrap is slid into sight, at a narrow page's own zoom), and down to it if it went up under the title's head
// (out of sight there once scrolled: bookviewhead.js.)
async function firstInSight(p, g) {
  const r = await p.locator(`#book .bk-unit[data-unit="${g}"]`).boundingBox(),
    width = p.viewportSize().width,
    foot = await p.evaluate(() => document.querySelector('#book .bk-view-head').getBoundingClientRect().bottom + 16),
    across = r.x >= 8 && r.x + r.width <= width - 8 ? 0 : r.x - 24,
    down = r.y >= foot ? 0 : r.y - foot - 8;
  if (!across && !down) return;
  const desk = await p.locator('#book .bk-desk').boundingBox();
  await p.mouse.move(desk.x + desk.width / 2, desk.y + desk.height / 2);
  await p.mouse.wheel(across, down);
  await p.waitForTimeout(800);
}
// (in the page) A scrap's look: its photo, the post-it under it with its shadow, and whatever else is stacked there
function lookOf(g) {
  const unitEl = document.querySelector(`#book .bk-unit[data-unit="${g}"]`),
    paper = unitEl.querySelector('.bk-unit-paper'),
    words = document.querySelector(`#book .bk-words[data-g="${g}"] .bk-scrap-words`),
    u = unitEl.getBoundingClientRect(),
    photo = [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-photo')].find(ph => {
      const r = ph.getBoundingClientRect();
      return r.left >= u.left - 1 && r.right <= u.right + 1 && r.top >= u.top - 1 && r.top < u.bottom;
    });
  // (a picture of it painted on the units' canvases: what a card under it was)
  const r = photo?.getBoundingClientRect() ?? u,
    [mx, my] = [r.left + r.width / 2, r.top + r.height / 2],
    painted = [...document.querySelectorAll('#book .bk-page:not([hidden]) canvas.bk-ink')].some(cv => {
      const b = cv.getBoundingClientRect(),
        k = cv.width / b.width;
      if (mx < b.left || my < b.top || mx >= b.right || my >= b.bottom) return false;
      return cv.getContext('2d').getImageData((mx - b.left) * k, (my - b.top) * k, 1, 1).data[3] > 0;
    });
  return {
    photo: !!photo,
    onPaper: !!photo && !!paper && r.bottom <= paper.getBoundingClientRect().bottom + 0.5,
    shadow: paper && getComputedStyle(paper).boxShadow,
    words: words && getComputedStyle(words).backgroundColor,
    painted,
  };
}
function look(name, l) {
  const said = JSON.stringify(l);
  assert.ok(l.photo, `${name}: the photo is taped on as the page's own (.bk-photo): ${said}`);
  assert.ok(l.onPaper, `${name}: the photo lies on its post-it: ${said}`);
  assert.ok(l.shadow && l.shadow !== 'none', `${name}: the post-it keeps its drop shadow: ${said}`);
  assert.equal(l.painted, false, `${name}: no card painted under the photo: ${said}`);
  assert.equal(
    l.words,
    'rgba(0, 0, 0, 0)',
    `${name}: the words written on the post-it, no paper of their own: ${said}`,
  );
}

// (in the page) The dates on the page past its head's, and where today's scraps are
function datesOf(ids) {
  const days = [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-day')].map(d => {
      const r = d.querySelector('span').getBoundingClientRect();
      return { text: d.textContent, x: r.left, top: r.top, bottom: r.bottom };
    }),
    scraps = ids.map(g => {
      const r = document.querySelector(`#book .bk-unit[data-unit="${g}"]`).getBoundingClientRect();
      return { x: r.left, top: r.top };
    });
  return { days, scraps };
}
function dated(name, { days, scraps }) {
  const said = JSON.stringify({ days, scraps });
  assert.equal(days.length, 1, `${name}: one date past the page's head's, today's: ${said}`);
  // (a masonry's date across its columns, over today's first scrap: bookunits.js headers)
  const [d] = days,
    top = Math.min(...scraps.map(s => s.top));
  assert.ok(d.bottom <= top + 0.5 && top - d.bottom < 40, `${name}: the date just above today's scraps: ${said}`);
}

// A line started on a scrap's photo (low in it, on its plain ground) or on its words, by finger or Pencil: ink on that
// scrap in the store, and on top of what it crosses
async function startsOn(p, c, hands, kept, { name, type, on, id }) {
  const at = await p.evaluate(spotOn, { g: id, on }),
    had = kept(id).ink.length,
    line = Array.from({ length: 12 }, (_, i) => [at.x - 55 + i * 10, at.y + (i % 2 ? 5 : -5)]),
    what = `${name}: a ${type === 'pen' ? 'Pencil' : 'finger'}'s line started on a scrap's ${on}`;
  await hands.stroke(type, line);
  await until(() => kept(id).ink.length > had, `${what} is ink on that scrap`, 10_000);
  await p.waitForTimeout(400);
  // (on top: the ink's canvas the topmost thing there, and inked)
  let top;
  await until(
    async () => (top = await p.evaluate(topmostAt, line[5])) === 'inked canvas',
    `${what}: drawn on top of it`,
    8000,
  ).catch(() => assert.equal(top, 'inked canvas', `${what}: drawn on top of it`));
  if (on === 'photo') {
    const px = await pixelsIn(p, { x: line[5][0] - 3, y: line[5][1] - 3, width: 6, height: 6 });
    assert.ok(
      px.some(([r, g, b]) => r < 90 && g < 90 && b < 130),
      `${what}: its ink shows over the photo`,
    );
  }
  await c.shot(`taped-${name}-${type}-${on}`, p);
}
// (in the page) Where a line starts on a scrap: low in its photo, on the picture's plain ground; or in its words
function spotOn({ g, on }) {
  // (the opened scrap's page, the grid's under it)
  const shown =
      document.querySelector('#book .bk-page[data-focus]') ?? document.querySelector('#book .bk-page:not([hidden])'),
    u = shown.querySelector(`.bk-unit[data-unit="${g}"]`).getBoundingClientRect();
  if (on === 'words') {
    const w = shown.querySelector(`.bk-words[data-g="${g}"] .bk-scrap-words`).getBoundingClientRect();
    return { x: w.left + w.width / 2, y: w.top + w.height / 2 };
  }
  // (the photo as the page lays it now, or on the old code the top of the unit, where its picture was painted)
  const ph = [...shown.querySelectorAll('.bk-photo')]
    .map(e => e.getBoundingClientRect())
    .find(r => r.top >= u.top - 1 && r.top < u.bottom) ?? {
    left: u.left + 10,
    width: u.width - 20,
    top: u.top + 10,
    height: u.width * 0.5,
  };
  return { x: ph.left + ph.width / 2, y: ph.top + ph.height * 0.93 };
}
// (in the page) The topmost thing at a point, the ink's canvases asked too: 'inked canvas' when a canvas is on top
// there and the page's canvases hold ink at it (another unit's clear canvas may lie over the one that holds it)
function topmostAt([x, y]) {
  const shown =
      document.querySelector('#book .bk-page[data-focus]') ?? document.querySelector('#book .bk-page:not([hidden])'),
    canvases = [...shown.querySelectorAll('canvas.bk-ink')];
  for (const cv of canvases) cv.style.pointerEvents = 'auto';
  const el = document.elementFromPoint(x, y);
  for (const cv of canvases) cv.style.pointerEvents = '';
  if (!el?.matches('canvas.bk-ink')) return `${el?.tagName} ${el?.className}`;
  const inked = canvases.some(cv => {
    const b = cv.getBoundingClientRect(),
      k = cv.width / b.width;
    if (x < b.left || y < b.top || x >= b.right || y >= b.bottom) return false;
    const { data } = cv
      .getContext('2d')
      .getImageData((x - b.left) * k - 10 * k, (y - b.top) * k - 10 * k, 20 * k, 20 * k);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 128) return true;
    return false;
  });
  // (else what each canvas there holds near it, to read why)
  const near = canvases.map(cv => {
    const b = cv.getBoundingClientRect(),
      k = cv.width / b.width,
      { data } = cv.getContext('2d').getImageData((x - b.left) * k - 20, (y - b.top) * k - 20, 40, 40);
    return `${Math.round(b.left)},${Math.round(b.top)} ${cv.width}x${cv.height} k${k.toFixed(2)}: ${Math.max(...data.filter((_, i) => i % 4 === 3))}`;
  });
  return inked ? 'inked canvas' : `canvas without ink there (${near.join('; ')})`;
}

// Select on a scrap's photo, dragged: the scrap is picked whole, with no handles, and nothing moves, the page holding
// still
async function fixed(p, c, hands, name, ids) {
  await p.locator('#book [data-island=tools] [data-mode=select]').click();
  const before = await p.evaluate(placesOf, ids),
    at = await p.evaluate(spotOn, { g: ids[0], on: 'photo' });
  await hands.stroke(
    'pen',
    [0, 1, 2, 3, 4, 5, 6, 7, 8].map(k => [at.x, at.y - 60 + k * 18]),
  );
  await p.waitForTimeout(800);
  const after = await p.evaluate(placesOf, ids);
  await c.shot(`taped-${name}-select`, p);
  assert.equal(after.picked, 1, `${name}: the scrap picked whole`);
  assert.equal(after.handles, 0, `${name}: no handles to move or scale it`);
  assert.deepEqual(after.photos, before.photos, `${name}: no photo moved`);
  assert.deepEqual(after.units, before.units, `${name}: no scrap moved, the page held still`);
  await p.locator('#book [data-island=tools] [data-mode=pen]').click();
}
// (in the page) Where today's scraps and every photo are on the screen, and how many frames of picked things show
function placesOf(ids) {
  const box = el => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top)];
  };
  // (the opened scrap's page, the grid's under it)
  const shown =
    document.querySelector('#book .bk-page[data-focus]') ?? document.querySelector('#book .bk-page:not([hidden])');
  return {
    units: ids.map(g =>
      box(
        shown.querySelector(`.bk-unit[data-unit="${g}"]`) ?? document.querySelector(`#book .bk-unit[data-unit="${g}"]`),
      ),
    ),
    photos: [...shown.querySelectorAll('.bk-photo')].map(box),
    picked: shown.querySelectorAll('.bk-sel').length,
    handles: [...shown.querySelectorAll('.bk-sel-handle')].filter(h => h.offsetWidth).length,
  };
}
