// book-check.mjs's stories of moving about the book's pages with a mouse on a desktop (shell/ink/bookpages.js,
// bookpan.js, bookzoom.js, bookcontrols.js; Ink's folder): the overview opened
// from its button and a page opened from it; the zoom by Ctrl with the wheel and with the keys (never when the pointer
// is on HQ's page), its % at the foot back to 100%, and out past the page's width to the overview; the page panned by
// Space and a drag and by the middle button, the paper showing nothing but paper; New page and back to the first from
// the pages' list; the page's heading written on it, moving with it. Each asserts what the board sees: the paper's
// pixels, the controls' words.
import assert from 'node:assert/strict';
import { freePage, onDesk as onLiveDesk } from './bookmouse.mjs';

const DESKTOP = { width: 1440, height: 900 };
// a page's day as its heading writes it: "Monday 26 October"
const DATE = /^[A-Z][a-z]+day \d{1,2} [A-Z][a-z]+$/;
// the book's paper colour (paper.js --bk-paper), and how far a patch of the paper may be from it (its dots)
const PAPER = [255, 250, 240],
  NEAR_PAPER = 40;
// what's left out of the paper when its ink is counted: the heading at its top, the islands at its right and foot
const HEAD_PX = 64,
  ISLANDS_PX = 90,
  FOOT_PX = 80;

// c: book-check.mjs's helpers: { hq (HQ in dev mode, the book drawn), storedPages, shot, settle }, and for the played
// store's (bookmouse.mjs's onDesk, freePage): { hqIn, base, store, pages, settled }
export function deskStories(c) {
  return {
    'the overview from its button, and a page opened from it': browser => overview(browser, c),
    "zoom in and out: the wheel, Ctrl and the keys, the foot's % back to 100%, and out to the overview": browser =>
      zoom(browser, c),
    'pan by Space and a drag and by the middle button, any way, the paper never showing an edge': browser =>
      pan(browser, c),
    'New page, and back to the first from the pages’ list': browser => newPage(browser, c),
    'the page’s heading is written on it at its top-left, and moves with it': browser => heading(browser, c),
    'a page tapped in the overview that can’t be read says why, and opens at a tap; New page opens from it': browser =>
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

// The store's notebook routes played over its pages (My Notebook, every page in it), its page read refused while
// `refusing`: the board taps a page, sees why, taps again once it can be read; then New page, opened.
async function unread(browser, c) {
  // (two pages: the book opens on the last, the first is tapped)
  const kept = freePage(c),
    last = freePage(c),
    { page, errors, done } = await onLiveDesk(browser, c),
    mine = { id: 1, name: 'My Notebook', kind: 'mine', archived: false, updated: null, pages: 0 },
    tile = p => ({ id: p.id, title: p.label || 'Free page', sent: false, sending: false, archived: false, groups: 0 });
  let refusing = true;
  await page.route(/\/api\/notebooks/, r => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/notebooks') return r.fulfill({ json: { shelf: [mine], archive: [] } });
    if (path === '/api/notebooks/pages')
      return r.fulfill({ json: { notebook: mine, pages: c.pages.map(tile), archived: [] } });
    if (path === '/api/notebooks/pages/create')
      return r.fulfill({ json: tile(c.store('/api/book/page/new', { kind: 'free', w: 1000, h: 800 }, null)) });
    return r.fallback();
  });
  await page.route(/\/api\/book\/page\?/, r =>
    refusing ? r.fulfill({ status: 404, json: { error: 'That page isn’t here any more.' } }) : r.fallback(),
  );
  const lost = page.locator('#book .bk-lost'),
    frame = id => page.getByRole('list', { name: 'The overview' }).locator(`.bk-tile[data-id="${id}"] .bk-tile-open`);
  try {
    await button(page, /^The overview/).click();
    await frame(kept.id).waitFor();
    await frame(kept.id).click();
    await page.waitForTimeout(c.settle);
    assert.equal(await lost.textContent(), 'That page isn’t here any more. Tap to try again.', 'why, over the paper');
    assert.ok(await lost.isVisible(), 'it shows');
    await c.shot('desk-unread', page);
    refusing = false;
    await lost.click();
    await page.waitForTimeout(c.settle);
    assert.ok(await lost.isHidden(), 'gone once it can be read');
    const n = c.pages.indexOf(last) + 1;
    assert.match(await where(page), new RegExp(`, ${c.pages.indexOf(kept) + 1} of ${n}$`), 'the page tapped');
    // New page, from the overview: the page just made opens, not the one before it
    await button(page, /^The overview/).click();
    await page.getByRole('list', { name: 'The overview' }).locator('[data-new]').click();
    await page.waitForTimeout(c.settle);
    assert.match(await where(page), new RegExp(`Free page, ${n + 1} of ${n + 1}$`), 'the new page');
    assert.equal(await inkPixels(page), 0, 'blank');
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
      from = await headingBox(page);
    // Space held, the mouse drags the page up and left
    await page.mouse.move(...at);
    await page.keyboard.down('Space');
    await drag(page, at, [-120, -80], 'left');
    await page.keyboard.up('Space');
    await page.waitForTimeout(c.settle);
    near(await headingBox(page), from, [-120, -80], 'Space and a drag');
    // the middle button drags it back
    await drag(page, at, [120, 80], 'middle');
    await page.waitForTimeout(c.settle);
    near(await headingBox(page), from, [0, 0], 'the middle button');
    // dragged right and down past its top-left: the page goes on up and left of its heading, as far as half the paper
    await drag(page, at, [200, 300], 'middle');
    await page.waitForTimeout(c.settle);
    near(await headingBox(page), from, [Math.min(200, desk.width / 2), Math.min(300, desk.height / 2)], 'up and left');
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
    await page.waitForTimeout(c.settle);
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

async function heading(browser, c) {
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const desk = await paperBox(page),
      day = page.locator('#book').getByText(DATE).locator('visible=true');
    const box = await day.boundingBox();
    assert.ok(box.x - desk.x < 60 && box.y - desk.y < 40, `the day at the paper's top-left: ${JSON.stringify(box)}`);
    // a titled page: its title, beside the day
    await button(page, /^The notebook's pages/).click();
    await page
      .getByRole('menuitem', { name: /Cover ideas/ })
      .first()
      .click();
    await page.waitForTimeout(c.settle);
    const name = 'Cover ideas',
      title = page.getByRole('region', { name }).getByText(name).first();
    await title.waitFor({ timeout: 5000 }).catch(async () => {
      const regions = await page.evaluate(() =>
        [...document.querySelectorAll('#book .bk-page')].map(p => `${p.ariaLabel}${p.hidden ? ' (hidden)' : ''}`),
      );
      assert.fail(`the page "${name}" shown, with its title (the pages: ${regions})`);
    });
    const top = (await title.boundingBox()).y;
    await c.shot('desk-heading', page);
    // panned down by the middle button (a mouse's wheel alone steps through the tools: bookpan.js.), the heading goes up with the page
    await drag(page, [desk.x + desk.width / 2, desk.y + desk.height / 2], [0, -150], 'middle');
    await page.waitForTimeout(c.settle);
    assert.ok(Math.abs((await title.boundingBox()).y - (top - 150)) <= 2, 'it moves with the page');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// ---- what the board sees

const button = (page, name, exact = false) => page.locator('#book').getByRole('button', { name, exact });
// (the % at the foot shows only while the zoom is off 100%)
const percent = async page => {
  const chip = button(page, 'Back to 100%');
  return (await chip.isVisible()) ? (await chip.textContent()).trim() : '100%';
};
const where = page => button(page, /^The notebook's pages/).getAttribute('aria-label');
const paperBox = page => page.locator('#book .bk-desk').boundingBox();
const headingBox = page => page.locator('#book').getByText(DATE).locator('visible=true').boundingBox();
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
// The ink on the paper: how many dark px, away from the heading at its top, the islands at its right and foot, and
// the tool strip beside them with the tool in use named beside it (bookstrip.js.)
export async function inkPixels(page) {
  const { data, w, h } = await onPaper(page),
    paper = await paperBox(page),
    k = w / paper.width,
    // (the strip's and its name's boxes in the shot's px, with a few px round them for their shadows)
    strip = await page.evaluate(() =>
      [...document.querySelectorAll('#book .bk-strip .bk-island, #book .bk-now')]
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
  for (let y = HEAD_PX; y < h - FOOT_PX; y++)
    for (let x = 0; x < w - ISLANDS_PX; x++) {
      const i = (y * w + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] < 300 && !covered(x, y)) n++;
    }
  return n;
}
// The patches of the paper (its left edge, its foot's left, its top past the heading) whose colour is far from the
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
