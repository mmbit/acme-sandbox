// book-check.mjs's stories of the paper's space on an iPad (shell/ink/bookpan.js, bookrow.js, ink.js's pen; Ink's
// folder): two fingers pan up and left of a page's origin and the Pencil
// writes there, kept where it was written through a reload; a pinch out stops on the page, never in the overview; and
// the freeze (a finger and the Pencil whose lifts never came, a text box open as the page turned) leaves the paper
// answering: two fingers pan, two pinch, the Pencil writes. Fingers and the Pencil are Chromium's own (CDP), the lifts
// that never came are events made without their ends.
import assert from 'node:assert/strict';
import { BLUE, freePage, paperBox, pick, savedWhere, tool } from './bookmouse.mjs';
import { MINI, chromiumPen } from './bookkit.mjs';

// how far a finger's pan or a pinch may land from where it was aimed (px): the pan's smoothing is none, its rounding one
const NEAR_PX = 3;

// c: book-check.mjs's played store and helpers: { hqIn, base, store, pages, settled, shot, noErrorsIn, settle }
export function spaceStories(c) {
  return {
    'on an iPad: two fingers pan up and left of the origin, the Pencil writes there, and it stays after a reload':
      browser => upAndLeft(browser, c),
    'on an iPad: a pinch out stops at the least zoom on the page, never the overview': browser => pinchOut(browser, c),
    'on an iPad: lifts that never came and a text box open as the page turned leave pan, pinch and the Pencil working':
      browser => noFreeze(browser, c),
  };
}

// ---- the stories

async function upAndLeft(browser, c) {
  const free = freePage(c);
  let pad = await onPad(browser, c);
  try {
    const { page, fingers, pen } = pad,
      from = await originAt(page),
      mid = middleOf(await paperBox(page));
    // two fingers drag the page right and down: the paper shows what's up and left of its origin (one finger draws)
    await pan(fingers, mid, [180, 140]);
    near(await originAt(page), from, [180, 140], 'two fingers pan up and left of the origin');
    await tool(page, 'Pen').tap();
    await page.getByRole('menuitemradio', { name: 'Blue' }).tap();
    // (the card stays open over the paper beside the strip for a width too: Escape closes it.)
    await page.keyboard.press('Escape');
    const origin = await originAt(page),
      start = [origin.x - 150, origin.y - 90];
    await pen(Array.from({ length: 16 }, (_, i) => [start[0] + i * 8, start[1] + 3 * Math.sin(i / 2)]));
    const saved = await savedWhere(c, free.id, p => p.ink.length === 1);
    assert.ok(
      saved.ink[0].points.every(([x, y]) => x < 0 && y < 0),
      `the ink above and left of the origin, where it was written: ${JSON.stringify(saved.ink[0].points[0])}`,
    );
    assert.ok(saved.x < 0 && saved.y < 0, `the page grew up and left to hold it: ${saved.x}, ${saved.y}`);
    await c.shot('book-space-up-left', page);
    c.noErrorsIn(pad.errors);
    await pad.done();
    // read again: the page opens where it was left, its ink where it was written, above and left of its origin
    pad = await onPad(browser, c, { keep: true });
    const again = await originAt(pad.page),
      [px, py] = saved.ink[0].points[8],
      at = [again.x + px, again.y + py];
    assert.ok(at[0] < again.x && at[1] < again.y);
    assert.ok((await blueAround(pad.page, at)) > 20, `the blue line where it was written after a reload, at ${at}`);
    c.noErrorsIn(pad.errors);
  } finally {
    await pad.done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

async function pinchOut(browser, c) {
  const free = freePage(c);
  const { page, fingers, errors, done } = await onPad(browser, c);
  try {
    // (the fingers one above the other: side by side, one would land on the tool strip by the paper's edge)
    const [x, y] = middleOf(await paperBox(page)),
      closing = [
        [
          [x, y - 160],
          [x, y + 160],
        ],
        [
          [x, y - 15],
          [x, y + 15],
        ],
      ];
    await fingers(...closing);
    const least = await scaleOf(page);
    assert.ok(least < 1, `zoomed out (${least})`);
    assert.equal(await overview(page), false, 'still the page, no overview');
    // closed again: the zoom stays where it stopped
    await fingers(...closing);
    assert.equal(await scaleOf(page), least, 'the least zoom holds');
    assert.equal(await overview(page), false, 'and still no overview');
    await c.shot('book-space-pinched-out', page);
    // two fingers still pan
    const from = await originAt(page);
    await pan(fingers, [x, y], [60, 40]);
    near(await originAt(page), from, [60, 40], 'two fingers pan at the least zoom');
    c.noErrorsIn(errors);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

async function noFreeze(browser, c) {
  const free = freePage(c);
  const { page, fingers, pen, errors, done } = await onPad(browser, c);
  try {
    const paper = await paperBox(page),
      [x, y] = middleOf(paper);
    // two fingers down whose lifts never come (a pinch the browser lost), and the Pencil's line Scribble took
    await liftsNeverCame(page, [x, y]);
    // a text box opened with the Pencil, then the page turned with it still open, and back
    await pick(page, 'Text', 'tap');
    await pen([[x - 100, y + 120]]);
    await page.keyboard.type('half a thought');
    await page.locator('#book').getByRole('button', { name: 'New page', exact: true }).tap();
    await page.waitForTimeout(c.settle);
    await page.locator('#book').getByRole('button', { name: 'The page before', exact: true }).tap();
    await page.waitForTimeout(c.settle);
    // the paper answers: two fingers pan,
    const from = await originAt(page);
    await pan(fingers, [x, y], [-70, -50]);
    near(await originAt(page), from, [-70, -50], 'two fingers pan');
    // two fingers pinch,
    const scale = await scaleOf(page);
    await fingers(
      [
        [x - 40, y],
        [x + 40, y],
      ],
      [
        [x - 80, y],
        [x + 80, y],
      ],
    );
    const pinched = await scaleOf(page);
    assert.ok(Math.abs(pinched / scale - 2) < 0.05, `two fingers pinch: ${scale} to ${pinched}`);
    // and the Pencil writes
    const strokes = c.pages.find(p => p.id === free.id).ink.length;
    await pick(page, 'Pen', 'tap');
    await pen(Array.from({ length: 16 }, (_, i) => [x - 120 + i * 10, y - 60 + 2 * Math.sin(i / 2)]));
    await savedWhere(c, free.id, p => p.ink.length === strokes + 1);
    await c.shot('book-space-no-freeze', page);
    c.noErrorsIn(errors);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

// ---- the iPad

// Pointers pressed on the paper at a point whose lifts never come: two fingers (a pinch the browser lost) and the Pencil
// (its line Scribble took)
const liftsNeverCame = (page, at) =>
  page.evaluate(([x, y]) => {
    const desk = document.querySelector('#book .bk-desk');
    const press = (type, pointerId, pointerType, isPrimary, dx) =>
      desk.dispatchEvent(
        new PointerEvent(type, { pointerId, pointerType, isPrimary, clientX: x + dx, clientY: y, bubbles: true }),
      );
    press('pointerdown', 41, 'touch', true, -80);
    press('pointerdown', 42, 'touch', false, 80);
    press('pointermove', 42, 'touch', false, 60);
    press('pointerdown', 43, 'pen', true, 0);
    press('pointermove', 43, 'pen', true, 20);
  }, at);

// HQ on the played store at an iPad's size with touch, the book open on its last page (keep: this browser's storage
// kept, a reload). fingers(from, to): fingers down at from's points, moved together to to's and lifted after a rest
// (no flick). pen(points): the Pencil down at the first point, along the rest, and up.
async function onPad(browser, c, { keep = false } = {}) {
  onPad.state = keep ? onPad.state : undefined;
  const context = await c.hqIn(browser, MINI, {
    hasTouch: true,
    ...(onPad.state && { storageState: onPad.state }),
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
  await c.settled(page, 'open');
  return {
    page,
    ...handsOn(page, await context.newCDPSession(page), c.settle),
    errors,
    done: async () => {
      if (!context.pages().length) return;
      onPad.state = await context.storageState();
      await context.close();
    },
  };
}
// Chromium's own fingers and Pencil on the page (CDP)
function handsOn(page, cdp, settle) {
  const fingers = async (from, to, steps = 10) => {
    const at = k => from.map(([x, y], i) => ({ x: x + (to[i][0] - x) * k, y: y + (to[i][1] - y) * k, id: i + 1 }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
    for (let i = 1; i <= steps; i++)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(i / steps) });
    await page.waitForTimeout(200);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(settle);
  };
  const pen = async points => {
    await chromiumPen(cdp).stroke(points);
    await page.waitForTimeout(settle);
  };
  return { fingers, pen };
}

// Two fingers side by side moved together by [dx, dy] from round a point: a pan, the page's zoom kept (one finger
// draws with the tool in use: bookwrite.js.)
const pan = (fingers, [x, y], [dx, dy]) =>
  fingers(
    [
      [x - 40, y],
      [x + 40, y],
    ],
    [
      [x - 40 + dx, y + dy],
      [x + 40 + dx, y + dy],
    ],
  );

// ---- what the board sees

const middleOf = b => [b.x + b.width / 2, b.y + b.height / 2];
// The origin of the page shown, on the screen
const originAt = page => page.locator('#book .bk-page:not([hidden])').boundingBox();
// The page's zoom, as the paper draws it
const scaleOf = page =>
  page.evaluate(() => +document.querySelector('#book .bk-world').style.transform.match(/scale\(([\d.]+)\)/)[1]);
// How many px of the blue ink there are round a point on the screen
async function blueAround(page, [x, y], r = 8) {
  const png = await page.screenshot({ clip: { x: x - r, y: y - r, width: 2 * r, height: 2 * r } });
  return page.evaluate(
    async ([src, rgb]) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const cv = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
        g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const { data } = g.getImageData(0, 0, cv.width, cv.height);
      let n = 0;
      for (let i = 0; i < data.length; i += 4)
        if (Math.abs(data[i] - rgb[0]) + Math.abs(data[i + 1] - rgb[1]) + Math.abs(data[i + 2] - rgb[2]) < 60) n++;
      return n;
    },
    [`data:image/png;base64,${png.toString('base64')}`, BLUE],
  );
}
const overview = page => page.evaluate(() => !document.querySelector('#book .bk-far').hidden);
function near(now, from, [dx, dy], what) {
  const moved = [now.x - from.x, now.y - from.y];
  assert.ok(
    Math.abs(moved[0] - dx) <= NEAR_PX && Math.abs(moved[1] - dy) <= NEAR_PX,
    `${what}: moved ${moved.map(Math.round)}, not ${dx}, ${dy}`,
  );
}
