// book-check.mjs's stories of moving about the book's pages with a mouse on a desktop (shell/ink/bookpages.js,
// bookpan.js, bookzoom.js, bookcontrols.js; Ink's folder): the overview opened from its button and a page opened from
// it; the page panned by Space and a drag and by the middle button, never past its corner, the paper showing nothing
// but paper; New page and back to the first from the pages' list. Each asserts what the board sees: the paper's
// pixels, the controls' words.
// (A trackpad's pinch zooms the page: canvas.mjs, pinch.mjs.)
import assert from 'node:assert/strict';
import { onDesk as onLiveDesk } from './mouse.mjs';
import { button, namedNotebook } from './chrome.mjs';
import { DESKTOP, OVERVIEW, shotPixels } from './kit.mjs';
import { press } from './bar.mjs';

// the book's paper colour (paper.js --bk-paper), and how far a patch of the paper may be from it (its dots)
const PAPER = [255, 250, 240],
  NEAR_PAPER = 40;
// what's left out of the paper when its ink is counted: the islands at its right and foot
const ISLANDS_PX = 90,
  FOOT_PX = 80;

// c: book-check.mjs's helpers: { hq (HQ in dev mode, the book drawn), storedPages, shot, settle }, and for the played
// store's (mouse.mjs's onDesk): { hqIn, base, settled }
export function deskStories(c) {
  return {
    'the overview from its button, and a page opened from it': browser => overview(browser, c),
    'pan by Space and a drag and by the middle button, never past its corner, the paper never showing an edge':
      browser => pan(browser, c),
    'New page, and back to the first from the pages’ list': browser => newPage(browser, c),
    'a notebook’s overview that can’t be read says why, retries at a tap; New page opens from it': browser =>
      unread(browser, c),
  };
}

// ---- the stories

async function overview(browser, c) {
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const pages = (await c.storedPages(page)).length;
    await button(page, OVERVIEW, true).click();
    await page.waitForTimeout(c.settle);
    // (the notebook's pages, the bar put away over them.)
    const list = page.getByRole('list', { name: 'The overview' }),
      frames = list.locator('.bk-tile[data-id] .bk-tile-open');
    await list.waitFor();
    assert.equal(await frames.count(), pages, "every page of the notebook's in the overview");
    await c.shot('desk-overview', page);
    // (a tile names a page as the pages control does, a sent one's with ", sent")
    const first = (await frames.first().getAttribute('aria-label')).replace(/, sent$/, '');
    await frames.first().click();
    await page.waitForTimeout(c.settle);
    assert.equal(await frames.count(), 0, 'the overview has gone');
    assert.match(await where(page), new RegExp(`^The notebook's pages: ${first}, 1 of`), 'its page is the one shown');
    assert.ok((await inkPixels(page)) > 0, 'with its ink');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// A refused overview read says why and retries at a tap. Its pages and New page open once the read works.
async function unread(browser, c) {
  const { page, errors, done } = await onLiveDesk(browser, c, { notebooks: namedNotebook() });
  let refusing = true;
  await page.route('**/api/notebooks/pages?notebook=1', r =>
    refusing ? r.fulfill({ status: 503, json: { error: 'This notebook can’t be read.' } }) : r.fallback(),
  );
  const overview = page.getByRole('list', { name: 'The overview' }),
    lost = overview.locator('.bk-far-lost');
  try {
    await button(page, OVERVIEW, true).click();
    await lost.waitFor();
    assert.equal(await lost.textContent(), 'This notebook can’t be read. Tap to try again.', 'why, over the paper');
    await c.shot('desk-unread', page);
    refusing = false;
    await lost.click();
    await lost.waitFor({ state: 'hidden' });
    await overview.getByRole('button', { name: 'Untitled page', exact: true }).click();
    await overview.waitFor({ state: 'hidden' });
    await button(page, /^The notebook's pages: Untitled page, 2 of 2$/).waitFor();
    await button(page, OVERVIEW, true).click();
    await overview.locator('[data-new]').click();
    await button(page, /^The notebook's pages: Untitled page, 3 of 3$/).waitFor();
    await page.waitForFunction(() => !document.querySelector('#book .bk-turn-picture, #book .bk-turn-leaf'));
    assert.equal(await inkPixels(page), 0, 'the new page is blank');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function pan(browser, c) {
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const desk = await paperBox(page),
      at = [desk.x + desk.width / 2, desk.y + desk.height / 2],
      from = await originAt(page);
    // Space held, the mouse drags the page up and left
    await page.mouse.move(...at);
    await page.keyboard.down('Space');
    await drag(page, at, [-120, -80], 'left');
    await page.keyboard.up('Space');
    await page.waitForTimeout(c.settle);
    // (down, never sideways: the board, a Notebook scrolls up and down.)
    near(await originAt(page), from, [0, -80], 'Space and a drag');
    // the middle button drags it back
    await drag(page, at, [120, 80], 'middle');
    await page.waitForTimeout(c.settle);
    near(await originAt(page), from, [0, 0], 'the middle button');
    // dragged right and down past its top-left: the page held at its corner, where the title lies at rest (the Ink
    // README, the title on the view.)
    await drag(page, at, [200, 300], 'middle');
    await page.waitForTimeout(c.settle);
    near(await originAt(page), from, [0, 0], 'never above or left of its corner');
    assert.deepEqual(await notPaper(page), [], 'nothing but paper there, no edge');
    // and far down and right: paper still
    await drag(page, at, [-500, -600], 'middle');
    await page.waitForTimeout(c.settle);
    assert.deepEqual(await notPaper(page), [], 'nothing but paper, panned far');
    await c.shot('desk-panned', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function newPage(browser, c) {
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const [, n] = (await where(page)).match(/(\d+) of (\d+)$/);
    await press(page, 'New page');
    await button(page, new RegExp(`Untitled page, ${+n + 1} of ${+n + 1}$`)).waitFor();
    assert.match(await where(page), new RegExp(`Untitled page, ${+n + 1} of ${+n + 1}$`));
    // (the leaf turned: its picture of the page before gone)
    await page.waitForFunction(() => !document.querySelector('#book .bk-turn-picture, #book .bk-turn-leaf'));
    assert.equal(await hiddenCanvases(page), 0, 'the inked page turned past holds no canvas');
    assert.equal(await inkPixels(page), 0, 'a blank page');
    await button(page, /^The notebook's pages/).click();
    await page.getByRole('menuitem').first().click();
    // (the blank page left goes: booktidy.js.)
    await button(page, new RegExp(`, 1 of ${n}$`)).waitFor();
    await page.waitForTimeout(c.settle);
    assert.match(await where(page), new RegExp(`, 1 of ${n}$`), 'back at the first, the blank page left gone');
    assert.equal(await hiddenCanvases(page), 0, 'nor do the pages turned past');
    assert.ok((await inkPixels(page)) > 0, 'with its ink');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// ---- what the board sees

const where = page => button(page, /^The notebook's pages/).getAttribute('aria-label');
// (the ink canvases the pages not shown still hold: bookpage.js lets them go)
const hiddenCanvases = page => page.locator('#book .bk-page[hidden] canvas.bk-ink').count();
// (the shown paper's, not a page turn's picture of it.)
const paperBox = page => page.locator('#book .bk-desk:not(.bk-turn-picture *)').boundingBox();
const originAt = page => page.locator('#book .bk-page:not([hidden])').boundingBox();
async function drag(page, [x, y], [dx, dy], which) {
  await page.mouse.move(x, y);
  await page.mouse.down({ button: which });
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up({ button: which });
}
// a box where it was, moved by [dx, dy], within a px or two
function near(box, was, [dx, dy], what) {
  const off = [box.x - was.x - dx, box.y - was.y - dy];
  assert.ok(Math.hypot(...off) <= 3, `${what}: off by ${off.map(Math.round)}`);
}

// The paper's pixels, read from a screenshot: { data (RGBA), w, h }
const onPaper = async page => shotPixels(page, await paperBox(page));
// The ink on the paper: how many dark px, away from the islands at its right and foot (the tools and the bar:
// bookui.js)
export async function inkPixels(page) {
  const { data, w, h } = await onPaper(page),
    paper = await paperBox(page),
    k = w / paper.width,
    // (the tools' and the bar's boxes in the shot's px, with a few px round them for their shadows, and the page's
    // title on the view, never ink; no Undo pill)
    strip = await page.evaluate(() =>
      [...document.querySelectorAll('#book .bk-strip, #book .bk-bar, #book .bk-view-head')]
        .filter(el => el.offsetParent)
        .map(el => el.getBoundingClientRect())
        .map(r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })),
    ),
    out = strip.map(r => ({
      left: (r.left - paper.x - 6) * k,
      right: (r.right - paper.x + 6) * k,
      top: (r.top - paper.y - 6) * k,
      bottom: (r.bottom - paper.y + 6) * k,
    })),
    covered = (x, y) => out.some(r => x >= r.left && x < r.right && y >= r.top && y < r.bottom);
  let n = 0;
  for (let y = 0; y < h - FOOT_PX; y++)
    for (let x = 0; x < w - ISLANDS_PX; x++) {
      const i = (y * w + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] < 300 && !covered(x, y)) n++;
    }
  return n;
}
// The patches of the paper (its left edge, its foot's left, its top) whose colour is far from the
// paper's: a table, an edge, a shadow. [] when it's all paper.
async function notPaper(page) {
  const { data, w, h } = await onPaper(page),
    far = [];
  for (const [px, py] of [
    [4, Math.round(h / 2)],
    [4, h - 14],
    [Math.round(w * 0.6), 4],
  ]) {
    const sum = [0, 0, 0];
    for (let y = py; y < py + 10; y++)
      for (let x = px; x < px + 10; x++) for (let k = 0; k < 3; k++) sum[k] += data[(y * w + x) * 4 + k];
    const rgb = sum.map(v => Math.round(v / 100));
    if (rgb.some((v, k) => Math.abs(v - PAPER[k]) > NEAR_PAPER)) far.push({ at: [px, py], rgb });
  }
  return far;
}

// HQ on a desktop in Chromium on its mock data (the day's pages and their ink), the book open beside it, a mouse and
// no touch
const onDesk = (browser, c) => c.hq(browser, DESKTOP, { hasTouch: false, deviceScaleFactor: 1 });
