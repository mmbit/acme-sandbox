// book-check.mjs's story of the book in a native shell that draws the Apple Pencil itself (platform/ios: Pen.swift;
// shell/ink/booknative.js), on the played Notebook seeded as dev mode's, an iPad mini with a stand-in for the shell's
// bridge:
//   - the pen picked, on the grid (no ink) the Pencil is the page's; on an opened scrap the shell is told where the
//     paper is on the screen and the pen's ink;
//   - a stroke the shell hands back lands on the opened scrap as the pen's line, its pressure kept, saved to the store;
//   - a tap the shell hands back is a click where it tapped: on the Eraser beside the opened scrap, the Pencil back to
//     the page;
//   - while an answer's slide on the opened scrap has lent the zoom, the shell is told the pen's width at the board's
//     zoom. The Pencil touching the paper gives that zoom back, and the stroke then drawn lands as drawn at it.
import assert from 'node:assert/strict';
import { open } from './notebook.mjs';
import { tool } from './notebookscreen.mjs';
import { MINI, middleOf, openScrap, until } from './kit.mjs';
import { hands } from './hands.mjs';
import { inStory, slipOf, WENT_LIVE } from './answers.mjs';
import { FEED_MS, notebookOn } from './answersplay.mjs';
import { viewNow } from './canvas.mjs';

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, org, settle
export function nativeStories(c) {
  return {
    "the native shell: the Pencil drawn by the shell lands as the pen's line, a tap a click": browser =>
      inShell(browser, c),
    "an answer in the native shell: the board's Pencil on the paper gives its zoom back, and its stroke lands as drawn":
      browser => lentZoom(browser, c),
  };
}

// (the shell's bridge as WKWebView gives it, what the page tells it kept)
function standIn() {
  window.told = [];
  window.webkit = { messageHandlers: { shell: { postMessage: m => window.told.push(structuredClone(m)) } } };
}

async function inShell(browser, c) {
  const hqIn = async (...a) => {
    const context = await c.hqIn(...a);
    await context.addInitScript(standIn);
    return context;
  };
  const { page, play, errors, done } = await open(browser, { ...c, hqIn }, MINI, {});
  try {
    // on the grid, which takes no ink, the Pencil is the page's (its tap, its circle and line); a card tapped opens its
    // scrap, and there, the pen picked from its tools, the shell draws the pen
    await until(() => told(page).then(p => p === false), "on the grid, the shell told the Pencil is the page's");
    const card = await page.locator('#book .bk-unit').filter({ visible: true }).first().getAttribute('data-unit'),
      { sheet } = await openScrap(page, (await hands(page)).pen, card);
    await tool(page, 'Pen');
    const pen = await until(() => told(page).then(p => p?.tool === 'pen' && p), 'the shell told of the pen');
    const desk = await page.locator('#book .bk-desk').boundingBox();
    assert.ok(
      Math.abs(pen.paper[0] - Math.max(0, desk.x)) <= 1 && Math.abs(pen.paper[1] - Math.max(0, desk.y)) <= 1,
      `the paper where the book's desk is: ${pen.paper} for ${JSON.stringify(desk)}`,
    );
    assert.match(pen.color, /^#[0-9a-f]{6}$/i, 'the ink as #rrggbb');
    assert.ok(pen.size > 0 && pen.alpha === 1, "the pen's width and no alpha");

    // a wave on the opened scrap's bare paper, pressing harder as it goes, as PencilKit hands it over
    const [x, y] = await bare(page, [sheet.x, sheet.y, sheet.width, sheet.height]),
      points = Array.from({ length: 16 }, (_, i) => [x + i * 8, y + Math.sin(i / 2) * 10, 0.2 + i * 0.04, i * 8]),
      was = new Set(lines(play).map(s => JSON.stringify(s)));
    await page.evaluate(points => window.shellPen(points), points);
    // (known by its light start: a line already there may come back from the store a little changed, in WebKit)
    const line = await until(
      () => lines(play).find(s => !was.has(JSON.stringify(s)) && s.points.some(p => p[2] < 0.25)),
      'the line saved, starting as lightly as it was drawn',
    );
    const pressures = line.points.map(p => p[2]);
    assert.ok(Math.max(...pressures) > 0.7, `its pressure kept: ${pressures}`);
    await c.shot('native-pen-line', page);

    // a tap on the Eraser, among the tools beside the opened scrap: picked, and the Pencil the page's again
    const eraser = middleOf(
      await page.locator('#book').getByRole('button', { name: 'Eraser', exact: true }).boundingBox(),
    );
    await page.evaluate(at => window.shellPen([[...at, 0.5, 0]]), eraser);
    await until(() => told(page).then(p => p === false), "the shell told the Pencil is the page's");
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// In a native shell that draws the Pencil itself (booknative.js): a tall note opened, its answer slid into sight on its
// sheet zooms out to show both (bookarrive.js hung). The Pencil touching the paper gives the board's zoom back
// (bookgroupshow.js giveBack), as a press does in a browser, so the stroke the shell then draws and plays to the page
// lands as large as it was drawn at the board's zoom
async function lentZoom(browser, c) {
  const nb = notebookOn(c),
    asked = Object.assign(nb.typed(4170, 'Is this live yet?', 60, 60), {
      ink: [{ color: '#2b2230', size: 3, points: [20, 1000].map((y, k) => [24, y, 0.5, k * 40]) }],
    });
  nb.groups.push(asked);
  const hqIn = async (...a) => {
    const context = await c.hqIn(...a);
    await context.addInitScript(standIn);
    return context;
  };
  await inStory(browser, { ...c, hqIn }, { viewport: MINI, nb }, async (page, play) => {
    // (the note opened by the Pencil's tap on its card, the page's on the grid: what hangs by it slides into sight on
    // its sheet; the pen picked from its tools.)
    await openScrap(page, (await hands(page)).pen, asked.id);
    await tool(page, 'Pen');
    const { size } = await until(() => told(page).then(p => p?.tool === 'pen' && p), 'the shell told of the pen');
    const { s: boardScale } = await viewNow(page);
    // (the board's hands off the paper: only then does what comes slide into sight)
    await page.waitForTimeout(IDLE_MS);
    const { id } = play.answer(asked.id, nb.answer(asked, 'text', WENT_LIVE));
    await slipOf(page, asked, id).waitFor({ timeout: FEED_MS });
    let lent;
    await until(
      async () => (lent = await stillView(page)) && lent.s < boardScale - 0.01,
      () => `the paper zoomed out from ${boardScale} to show the note and its answer: ${JSON.stringify(lent)}`,
      FEED_MS,
    );
    // (the shell's line as wide from its first point as the page's will be once the Pencil touches)
    assert.equal((await told(page)).size, size, `the pen as wide as at the board's zoom while ${lent.s} is lent`);
    const desk = await page.locator('#book .bk-desk').boundingBox(),
      [x, y] = await bare(page, [desk.x, desk.y, desk.width, desk.height]),
      // (a straight slant, every step alike)
      points = Array.from({ length: 16 }, (_, i) => [x + i * 8, y - 15 + i * 2, 0.5, i * 8]),
      was = new Set(lines(play).map(s => JSON.stringify(s)));
    await page.evaluate(([x, y]) => window.shellPenDown(x, y), points[0]);
    await atZoom(page, boardScale, 'as the Pencil touched the paper');
    await page.evaluate(points => window.shellPen(points), points);
    const line = await until(() => lines(play).find(s => !was.has(JSON.stringify(s))), 'the line saved', FEED_MS),
      // (from its first point to its last: the pen's line starts and ends where the hand did, however its smoothing
      // trails between. Its span is the same wherever the store places the unit.)
      [drawn, landed] = [points.map(([px, py]) => [px / boardScale, py / boardScale]), line.points].map(span);
    assert.ok(
      drawn.every((v, k) => Math.abs(v - landed[k]) <= 0.5),
      `the line as large as it was drawn at the board's zoom, ${boardScale}: ${landed} on the page, drawn ${drawn}`,
    );
    await atZoom(page, boardScale, 'once the line landed');
  });
}
// (the board's zoom on the paper, when)
async function atZoom(page, boardScale, when) {
  const now = await viewNow(page);
  assert.ok(Math.abs(now.s - boardScale) < 0.001, `the board's zoom ${boardScale} ${when}: ${JSON.stringify(now)}`);
}
// The view once the paper is still (viewNow), or null while it moves
async function stillView(page) {
  const was = await viewNow(page);
  await page.waitForTimeout(300);
  const now = await viewNow(page);
  return JSON.stringify(was) === JSON.stringify(now) ? now : null;
}
// (from the first of points to the last: [dx, dy])
const span = points => [0, 1].map(k => points.at(-1)[k] - points[0][k]);
// A place on the paper on the screen with bare page under a wave's width (130 × 30 px) from it: no unit, box of words
// or what hangs under them
const bare = (page, [left, top, width, height]) =>
  page.evaluate(
    ([left, top, width, height]) => {
      const clear = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return !!el?.closest('#book .bk-desk') && !el.closest('.bk-unit, .bk-typed, .bk-under, .bk-answers, button');
      };
      for (let y = top + 60; y < top + height - 60; y += 20)
        for (let x = left + 40; x < left + width - 180; x += 20)
          if ([0, 65, 130].every(dx => [-15, 15].every(dy => clear(x + dx, y + dy)))) return [x, y];
      throw new Error('no bare paper in view');
    },
    [left, top, width, height],
  );
// How long the board's hands are off the paper before what an agent hangs by a note is slid into sight (ms:
// bookarrive.js IDLE_MS, and a little)
const IDLE_MS = 3500;
// What the page last told the shell of its pen
const told = page => page.evaluate(() => window.told.filter(m => 'pen' in m).at(-1)?.pen);
// The lines in the store, on any of the notebook's pages
const lines = play =>
  play
    .route('/api/notebooks/pages', { notebook: 1 })
    .pages.flatMap(p => play.route('/api/notebooks/pages/groups', { page: p.id }).groups)
    .flatMap(g => g.ink);
