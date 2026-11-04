// book-check.mjs's stories of our scraps on a sketch page (the Ink README, "Our scraps"; shell/ink/bookpage.js photos,
// bookwrite.js, bookselect.js, bookunitcards.js, sketchcanvas.js), at realbook.mjs's sizes with their blur: an iPhone
// upright and an iPad on its side. My journal's sketch page holds a scrap and a drawing from yesterday, and two scraps
// come today, as the pin flow brings them:
//   - the look: each photo taped straight onto its post-it, one paper with its own shadow, no card under the photo;
//   - a stroke starts anywhere: started on a scrap's photo and on its words, by finger (as a fresh device's finger
//     draws) and by Pencil, it's ink on that scrap, drawn on top of what it crosses;
//   - our scraps are fixed: Select on a scrap's photo picks it whole and moves nothing, the page holding still, and its
//     room's handle dragged down opens room, the scrap below moving down with it, never one note under another (one
//     beside it, on a wide page, staying);
//   - dates: today's first scrap has today's date just above it, and free drawing today puts no date on the page.
// Recorded with --shots.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pixelsIn, toChapter, until } from './kit.mjs';
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
    'our scraps on an iPhone: taped onto their post-it, a stroke starts on a photo or its words, nothing in them moves, the handle opens room, a later day dated':
      browser => taped(browser, c, 'iphone'),
    'our scraps on an iPad on its side: taped onto their post-it, a stroke starts on a photo or its words, nothing in them moves, the handle opens room, a later day dated':
      browser => taped(browser, c, 'ipad'),
    'our scraps on an iPad mini upright: taped onto their post-it, a stroke starts on a photo or its words, nothing in them moves, the handle opens room, a later day dated':
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
    const hands = await inputs(browser, p),
      kept = id => store.route('/api/notebooks/pages/groups', { page: 1 }).groups.find(g => g.id === id);
    // (a fresh device's finger draws; once the Pencil has drawn, a finger moves the page)
    for (const type of ['touch', 'pen'])
      for (const on of ['photo', 'words']) await startsOn(p, c, hands, kept, { name, type, on, id: ids[0] });
    await freeDrawing(p, hands, name, ids);
    await fixed(p, c, hands, name, ids);
    await roomOpened(p, c, name, ids);
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
// an agent's scrap is slid into sight, at a narrow page's own zoom)
async function firstInSight(p, g) {
  const r = await p.locator(`#book .bk-unit[data-unit="${g}"]`).boundingBox(),
    width = p.viewportSize().width;
  if (r.x >= 8 && r.x + r.width <= width - 8) return;
  await p.mouse.move(width / 2, 300);
  await p.mouse.wheel(r.x - 24, 0);
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
  const days = [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-day:not(.bk-head-day)')].map(d => {
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
  const [d] = days,
    [first] = scraps;
  assert.ok(Math.abs(d.x - first.x) < 30, `${name}: the date at today's first scrap's left: ${said}`);
  assert.ok(d.bottom <= first.top && first.top - d.bottom < 30, `${name}: the date just above it: ${said}`);
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
  const u = document.querySelector(`#book .bk-unit[data-unit="${g}"]`).getBoundingClientRect();
  if (on === 'words') {
    const w = document.querySelector(`#book .bk-words[data-g="${g}"] .bk-scrap-words`).getBoundingClientRect();
    return { x: w.left + w.width / 2, y: w.top + w.height / 2 };
  }
  // (the photo as the page lays it now, or on the old code the top of the unit, where its picture was painted)
  const ph = [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-photo')]
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
  const canvases = [...document.querySelectorAll('#book .bk-page:not([hidden]) canvas.bk-ink')];
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

// A Pencil's line on bare paper below today's scraps: free drawing puts no date on the page
async function freeDrawing(p, hands, name, ids) {
  const at = await p.evaluate(g => {
    const r = document.querySelector(`#book .bk-unit[data-unit="${g}"]`).getBoundingClientRect();
    return { x: r.left + 40, y: Math.min(r.bottom + 60, innerHeight - 160) };
  }, ids[1]);
  await hands.stroke(
    'pen',
    [0, 1, 2, 3, 4, 5, 6].map(k => [at.x + k * 14, at.y + (k % 2) * 12]),
  );
  await p.waitForTimeout(1500);
  dated(name, await p.evaluate(datesOf, ids));
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
  return {
    units: ids.map(g => box(document.querySelector(`#book .bk-unit[data-unit="${g}"]`))),
    photos: [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-photo')].map(box),
    picked: document.querySelectorAll('#book .bk-page:not([hidden]) .bk-sel').length,
    handles: [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-sel-handle')].filter(h => h.offsetWidth)
      .length,
  };
}

// The first of today's scraps' room dragged down by its handle: the room opens and the scrap below moves down with it,
// never under it, in the store too; a scrap beside it stays
async function roomOpened(p, c, name, ids) {
  // (a handle under the bar's island scrolled up into reach first)
  const bar = await p.locator('#book .bk-bar').boundingBox(),
    low = await p.locator(`#book .bk-room-handle[data-unit="${ids[0]}"]`).boundingBox();
  if (bar && low.y + low.height + 160 > bar.y) {
    await p.mouse.move(low.x + low.width / 2, 300);
    await p.mouse.wheel(0, 300);
    await p.waitForTimeout(800);
  }
  const handle = await p.locator(`#book .bk-room-handle[data-unit="${ids[0]}"]`).boundingBox(),
    before = await p.evaluate(feet, ids),
    stored = () =>
      p
        .context()
        .notebook.route('/api/notebooks/pages/groups', { page: 1 })
        .groups.find(g => g.id === ids[1]).place,
    was = stored(),
    from = [handle.x + handle.width / 2, handle.y + handle.height / 2];
  // (a mouse: a pointer the browser has, which the handle captures, in WebKit too)
  await p.mouse.move(...from);
  await p.mouse.down();
  for (let k = 1; k <= 10; k++) await p.mouse.move(from[0], from[1] + k * 15);
  await p.mouse.up();
  await p.waitForTimeout(1200);
  const after = await p.evaluate(feet, ids),
    said = JSON.stringify({ before, after });
  await c.shot(`taped-${name}-room`, p);
  assert.ok(after[0].bottom > before[0].bottom + 80, `${name}: the room dragged taller: ${said}`);
  // A scrap beside it (a wide page) stays where it is
  if (before[1].left >= before[0].right || before[1].right <= before[0].left) {
    assert.deepEqual(after[1], before[1], `${name}: the scrap beside it stays: ${said}`);
    assert.deepEqual(stored(), was, `${name}: the store keeps the scrap beside it where it was`);
    return;
  }
  // (the scrap below as far from its foot as before: never pulled under it. Pinned before its words were measured, the
  // first can start a little over the next as it lands: that's the landing's, not the handle's.)
  assert.ok(
    Math.abs(after[1].top - after[0].bottom - (before[1].top - before[0].bottom)) < 3,
    `${name}: the scrap below moved down with the room, never pulled under it: ${said}`,
  );
  await until(() => stored()?.y > (was?.y ?? Infinity) + 60, `${name}: the store keeps the scrap below moved down`);
}
// (in the page) Each scrap's box on the screen
function feet(ids) {
  return ids.map(g => {
    const r = document.querySelector(`#book .bk-unit[data-unit="${g}"]`).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
}
