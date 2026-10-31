// book-check.mjs's stories of moving about the book's pages with a mouse on a desktop (shell/ink/bookpages.js,
// bookpan.js, bookzoom.js, bookcontrols.js; Ink's folder): the overview opened
// from its button and a page opened from it; the zoom by Ctrl with the wheel and with the keys (never when the pointer
// is on HQ's page), its % at the foot back to 100%, and out past the page's width to the overview; the page panned by
// Space and a drag and by the middle button, the paper showing nothing but paper; New page and back to the first from
// the pages' list. Each asserts what the board sees: the paper's
// pixels, the controls' words.
import assert from 'node:assert/strict';
import { onDesk as onLiveDesk } from './bookmouse.mjs';
import { button, namedNotebook } from './bookchrome.mjs';
import { DESKTOP } from './bookkit.mjs';

// the book's paper colour (paper.js --bk-paper), and how far a patch of the paper may be from it (its dots)
const PAPER = [255, 250, 240],
  NEAR_PAPER = 40;
// what's left out of the paper when its ink is counted: the islands at its right and foot
const ISLANDS_PX = 90,
  FOOT_PX = 80;

// c: book-check.mjs's helpers: { hq (HQ in dev mode, the book drawn), storedPages, shot, settle }, and for the played
// store's (bookmouse.mjs's onDesk): { hqIn, base, settled }
export function deskStories(c) {
  return {
    'the overview from its button, and a page opened from it': browser => overview(browser, c),
    "zoom in and out: the wheel, Ctrl and the keys, the foot's % back to 100%, and out to the overview": browser =>
      zoom(browser, c),
    'pan by Space and a drag and by the middle button, any way, the paper never showing an edge': browser =>
      pan(browser, c),
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
    await button(page, /^The overview/).click();
    await page.waitForTimeout(c.settle);
    assert.equal(await button(page, /^The overview/).getAttribute('aria-pressed'), 'true');
    // (the notebook's pages)
    const frames = page.getByRole('list', { name: 'The overview' }).locator('.bk-tile[data-id] .bk-tile-open');
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
    await button(page, /^The overview/).click();
    await lost.waitFor();
    assert.equal(await lost.textContent(), 'This notebook can’t be read. Tap to try again.', 'why, over the paper');
    await c.shot('desk-unread', page);
    refusing = false;
    await lost.click();
    await lost.waitFor({ state: 'hidden' });
    await overview.getByRole('button', { name: 'Untitled page', exact: true }).click();
    await overview.waitFor({ state: 'hidden' });
    await button(page, /^The notebook's pages: Untitled page, 2 of 2$/).waitFor();
    await button(page, /^The overview/).click();
    await overview.locator('[data-new]').click();
    await button(page, /^The notebook's pages: Untitled page, 3 of 3$/).waitFor();
    await page.waitForFunction(() => !document.querySelector('#book .bk-turn-picture, #book .bk-turn-leaf'));
    assert.equal(await inkPixels(page), 0, 'the new page is blank');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function zoom(browser, c) {
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const desk = await paperBox(page),
      middle = [desk.x + desk.width / 3, desk.y + desk.height / 2],
      ink = await inkPixels(page);
    // (the zoom's % shows at the foot only while it's off 100%, a tap back to 100%)
    assert.equal(await percent(page), '100%');
    await page.mouse.move(...middle);
    await page.keyboard.press('Control+Equal');
    await page.waitForTimeout(c.settle);
    assert.equal(await percent(page), '125%');
    assert.ok((await inkPixels(page)) > ink, 'the ink drawn bigger');
    // the wheel over the paper (Ctrl and the wheel pick tools: bookstrip.mjs.)
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(c.settle);
    assert.ok(parseInt(await percent(page)) > 125, `the wheel zoomed in: ${await percent(page)}`);
    await c.shot('desk-zoomed', page);
    // Ctrl and 0, + and − with the pointer on the book; on HQ's page they're the browser's
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(c.settle);
    assert.equal(await percent(page), '100%');
    await page.keyboard.press('Control+Equal');
    await page.waitForTimeout(c.settle);
    assert.equal(await percent(page), '125%');
    // (the pointer on HQ's page, the focus off the book's controls, as a click there leaves it)
    await page.mouse.move(desk.x / 2, desk.height / 2);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+Minus');
    await page.waitForTimeout(c.settle);
    assert.equal(await percent(page), '125%', "the keys on HQ's page leave the book's zoom alone");
    await button(page, 'Back to 100%').click();
    await page.waitForTimeout(c.settle);
    assert.equal(await percent(page), '100%');
    await page.mouse.move(...middle);
    await outToOverview(page, c);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// Ctrl and − over the paper, again and again: under 100%, and past its least zoom, the overview
async function outToOverview(page, c) {
  const pressed = async () => (await button(page, /^The overview/).getAttribute('aria-pressed')) === 'true',
    seen = [];
  for (let i = 0; i < 8 && !(await pressed()); i++) {
    seen.push(await percent(page));
    await page.keyboard.press('Control+Minus');
    await page.waitForTimeout(c.settle);
  }
  assert.ok(
    seen.some(p => parseInt(p) < 100),
    `zoomed out under 100% on the way: ${seen}`,
  );
  assert.ok(await pressed(), `out to the overview: ${seen}`);
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
    near(await originAt(page), from, [-120, -80], 'Space and a drag');
    // the middle button drags it back
    await drag(page, at, [120, 80], 'middle');
    await page.waitForTimeout(c.settle);
    near(await originAt(page), from, [0, 0], 'the middle button');
    // dragged right and down past its top-left: the page goes on up and left of its origin, as far as half the paper
    await drag(page, at, [200, 300], 'middle');
    await page.waitForTimeout(c.settle);
    near(await originAt(page), from, [Math.min(200, desk.width / 2), Math.min(300, desk.height / 2)], 'up and left');
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
    await button(page, 'New page', true).click();
    await button(page, new RegExp(`Untitled page, ${+n + 1} of ${+n + 1}$`)).waitFor();
    assert.match(await where(page), new RegExp(`Untitled page, ${+n + 1} of ${+n + 1}$`));
    assert.equal(await inkPixels(page), 0, 'a blank page');
    await button(page, /^The notebook's pages/).click();
    await page.getByRole('menuitem').first().click();
    await page.waitForTimeout(c.settle);
    assert.match(await where(page), new RegExp(`, 1 of ${+n + 1}$`), 'back at the first');
    assert.ok((await inkPixels(page)) > 0, 'with its ink');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// ---- what the board sees

// (the % at the foot shows only while the zoom is off 100%)
const percent = async page => {
  const chip = button(page, 'Back to 100%');
  return (await chip.isVisible()) ? (await chip.textContent()).trim() : '100%';
};
const where = page => button(page, /^The notebook's pages/).getAttribute('aria-label');
const paperBox = page => page.locator('#book .bk-desk').boundingBox();
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

// The paper's pixels, read from a screenshot (decoded by the browser): { data (RGBA), w, h }
async function onPaper(page) {
  const png = await page.screenshot({ clip: await paperBox(page) });
  const { b64, w, h } = await page.evaluate(
    async src => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const cv = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
        g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, cv.width, cv.height).data;
      let bin = '';
      for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return { b64: btoa(bin), w: cv.width, h: cv.height };
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );
  return { data: Buffer.from(b64, 'base64'), w, h };
}
// The ink on the paper: how many dark px, away from the islands at its right and foot, and the tool strip beside
// them and the page bar (the lane at the foot: bookui.js.)
export async function inkPixels(page) {
  const { data, w, h } = await onPaper(page),
    paper = await paperBox(page),
    k = w / paper.width,
    // (the rail's and the bar's boxes in the shot's px, with a few px round them for their shadows)
    strip = await page.evaluate(() =>
      [...document.querySelectorAll('#book .bk-column .bk-island')]
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
export async function notPaper(page) {
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
