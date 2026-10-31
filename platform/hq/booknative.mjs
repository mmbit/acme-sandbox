// book-check.mjs's story of the book in a native shell that draws the Apple Pencil itself (platform/ios: Pen.swift;
// shell/ink/booknative.js), on the played Notebook seeded as dev mode's, an iPad mini with a stand-in for the shell's
// bridge:
//   - the pen picked, the shell is told where the paper is on the screen and the pen's ink;
//   - a stroke the shell hands back lands on the page shown as the pen's line, its pressure kept, saved to the store;
//   - a tap the shell hands back is a click where it tapped: on the Eraser, which takes the Pencil back to the page.
import assert from 'node:assert/strict';
import { open } from './booknotebook.mjs';
import { tool } from './booknotebookscreen.mjs';
import { MINI, middleOf, until } from './bookkit.mjs';

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function nativeStories(c) {
  return {
    "the native shell: the Pencil drawn by the shell lands as the pen's line, a tap a click": browser =>
      inShell(browser, c),
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
    await tool(page, 'Pen');
    const pen = await until(() => told(page).then(p => p?.tool === 'pen' && p), 'the shell told of the pen');
    const desk = await page.locator('#book .bk-desk').boundingBox();
    assert.ok(
      Math.abs(pen.paper[0] - Math.max(0, desk.x)) <= 1 && Math.abs(pen.paper[1] - Math.max(0, desk.y)) <= 1,
      `the paper where the book's desk is: ${pen.paper} for ${JSON.stringify(desk)}`,
    );
    assert.match(pen.color, /^#[0-9a-f]{6}$/i, 'the ink as #rrggbb');
    assert.ok(pen.size > 0 && pen.alpha === 1, "the pen's width and no alpha");

    // a wave on bare paper, pressing harder as it goes, as PencilKit hands it over
    const [x, y] = await bare(page, pen.paper),
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

    // a tap on the Eraser: picked, and the Pencil the page's again
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

// A place on the paper on the screen with bare page under a wave's width (130 × 30 px) from it
const bare = (page, [left, top, width, height]) =>
  page.evaluate(
    ([left, top, width, height]) => {
      const clear = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return !!el?.closest('#book .bk-desk') && !el.closest('.bk-unit, .bk-under, .bk-answers, button');
      };
      for (let y = top + 60; y < top + height - 60; y += 20)
        for (let x = left + 40; x < left + width - 180; x += 20)
          if ([0, 65, 130].every(dx => [-15, 15].every(dy => clear(x + dx, y + dy)))) return [x, y];
      throw new Error('no bare paper in view');
    },
    [left, top, width, height],
  );
// What the page last told the shell of its pen
const told = page => page.evaluate(() => window.told.filter(m => 'pen' in m).at(-1)?.pen);
// The lines in the store, on any of the notebook's pages
const lines = play =>
  play
    .route('/api/notebooks/pages', { notebook: 1 })
    .pages.flatMap(p => play.route('/api/notebooks/pages/groups', { page: p.id }).groups)
    .flatMap(g => g.ink);
