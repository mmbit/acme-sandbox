// book-check.mjs's stories of the paper's space on an iPad (shell/ink/bookpan.js, bookrow.js, bookscrapopen.js, ink.js's
// pen; Ink's folder): two fingers never pan above or left of a page's corner, its title's, and there the Pencil's tap
// opens a new scrap, it writes in it, and put back its card shows it, through a reload too; a pinch out stops on the
// page at its fit, never in the overview; and the freeze (a finger and the Pencil whose lifts never came, a text box open
// as its scrap was put back) leaves the paper answering: two fingers pan, two pinch, the Pencil writes. Fingers and the
// Pencil in either engine (hands.mjs), the lifts that never came are events made without their ends. (A page of scraps
// takes no ink of its own, and pans down only as far as its scraps go: a long page's pan down is fill.mjs's.)
import assert from 'node:assert/strict';
import { BLUE, freePage, paperBox, pick, savedWhere, tool } from './mouse.mjs';
import { MINI, closeScrap, middleOf, openScrap, shotPixels } from './kit.mjs';
import { SHOWN } from './notebookscreen.mjs';
import { hands } from './hands.mjs';
import { restsOpen, watchedPage } from './start.mjs';

// how far a finger's pan or a pinch may land from where it was aimed (px): the pan's smoothing is none, its rounding one
const NEAR_PX = 3;

// c: book-check.mjs's played store and helpers: { hqIn, base, store, pages, settled, shot, noErrorsIn, settle }
export function spaceStories(c) {
  return {
    "on an iPad: two fingers never pan past the page's corner, the Pencil writes in a new scrap there, and it stays after a reload":
      browser => downAndRight(browser, c),
    "on an iPad: a pinch out stops at the page's fit, never the overview": browser => pinchOut(browser, c),
    'on an iPad: lifts that never came and a text box open as its scrap was put back leave pan, pinch and the Pencil working':
      browser => noFreeze(browser, c),
  };
}

// ---- the stories

async function downAndRight(browser, c) {
  const free = freePage(c);
  let pad = await onPad(browser, c);
  try {
    const { page, fingers, pen } = pad,
      from = await originAt(page),
      mid = middleOf(await paperBox(page));
    // two fingers drag the page right and down: it holds at its corner, its title's
    await pan(fingers, mid, [180, 140]);
    near(await originAt(page), from, [0, 0], "two fingers never pan above or left of the page's corner");
    await tool(page, 'Pen').tap();
    await page.getByRole('menuitemradio', { name: 'Blue' }).tap();
    // (the card stays open over the paper beside the strip for a width too: Escape closes it.)
    await page.keyboard.press('Escape');
    // the Pencil's tap there makes a new scrap and opens it, and it writes in it in blue
    const tapper = { tap: at => pen([at]) },
      { gid, sheet } = await openScrap(page, tapper, undefined, mid),
      start = [sheet.x + 60, sheet.y + sheet.height / 2];
    await pen(Array.from({ length: 16 }, (_, i) => [start[0] + i * 8, start[1] + 3 * Math.sin(i / 2)]));
    await savedWhere(c, free.id, p => p.ink.length === 1);
    const groups = c.notebook.route('/api/notebooks/pages/groups', { page: free.id }).groups;
    assert.equal(groups.find(g => g.ink.length)?.id, gid, 'the line saved in the scrap it was written in');
    // put back, its card shows the line
    await closeScrap(page, tapper);
    const card = (on = page) => on.locator(`#book .bk-unit[data-unit="${gid}"]`).filter({ visible: true }).first();
    assert.ok((await blueIn(page, await card().boundingBox())) > 20, "the blue line on the scrap's card");
    await c.shot('book-space-down-right', page);
    c.noErrorsIn(pad.errors);
    await pad.done();
    // read again: the page opens with the card, its line on it
    pad = await onPad(browser, c, { keep: true });
    await card(pad.page).waitFor();
    assert.ok(
      (await blueIn(pad.page, await card(pad.page).boundingBox())) > 20,
      'the blue line on its card after a reload',
    );
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
    const fit = await scaleOf(page);
    await fingers(...closing);
    // (a page of scraps zooms out no further than its fit: masonry.js.)
    const least = await scaleOf(page);
    assert.ok(least <= fit, `zoomed out no further than its fit (${fit} to ${least})`);
    assert.equal(await overview(page), false, 'still the page, no overview');
    // closed again: the zoom stays where it stopped
    await fingers(...closing);
    assert.equal(await scaleOf(page), least, 'the least zoom holds');
    assert.equal(await overview(page), false, 'and still no overview');
    await c.shot('book-space-pinched-out', page);
    // the whole page in sight at its corner: two fingers move it no further
    const from = await originAt(page);
    await pan(fingers, [x, y], [60, 40]);
    near(await originAt(page), from, [0, 0], 'two fingers hold the page at its corner at the least zoom');
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
    // a new scrap opened by the Pencil's tap, a text box opened in it with the Pencil, the scrap put back with it still
    // open, and opened again
    const tapper = { tap: at => pen([at]) },
      { gid, sheet } = await openScrap(page, tapper, undefined, [x, y]);
    await pick(page, 'Text', 'tap');
    await pen([[sheet.x + 80, sheet.y + sheet.height / 2]]);
    await page.keyboard.type('half a thought');
    await closeScrap(page, tapper);
    await page.waitForTimeout(c.settle);
    await openScrap(page, tapper, gid);
    // the paper answers: two fingers pan,
    const from = await originAt(page);
    await pan(fingers, [x, y], [0, 50]);
    near(await originAt(page), from, [0, 50], 'two fingers pan');
    // two fingers pinch,
    const scale = await scaleOf(page);
    await fingers(
      [
        [x - 80, y],
        [x + 80, y],
      ],
      [
        [x - 40, y],
        [x + 40, y],
      ],
    );
    const pinched = await scaleOf(page);
    assert.ok(Math.abs(pinched / scale - 0.5) < 0.05, `two fingers pinch: ${scale} to ${pinched}`);
    // and the Pencil writes
    const strokes = c.pages.find(p => p.id === free.id).ink.length;
    await pick(page, 'Pen', 'tap');
    await pen(Array.from({ length: 16 }, (_, i) => [x - 120 + i * 10, y + 150 + 2 * Math.sin(i / 2)]));
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
  const { page, errors } = await watchedPage(context);
  await page.goto(`${c.base}/?intro=0`);
  await restsOpen(page, c, MINI);
  return {
    page,
    ...handsOn(page, await hands(page), c.settle),
    errors,
    done: async () => {
      if (!context.pages().length) return;
      onPad.state = await context.storageState();
      await context.close();
    },
  };
}
// The fingers and the Pencil on the page (hands.mjs), each let go after a rest
function handsOn(page, { touch, pen: pencil }, settle) {
  const fingers = async (from, to, steps = 10) => {
    await touch.down(from);
    await touch.move(to, steps);
    await page.waitForTimeout(200);
    await touch.up();
    await page.waitForTimeout(settle);
  };
  const pen = async points => {
    await pencil.stroke(points);
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

// The origin of the page shown (an opened scrap's while one is open), on the screen
const originAt = page => page.locator(SHOWN).first().boundingBox();
// The page's zoom, as the paper draws it
const scaleOf = page =>
  page.evaluate(() => +document.querySelector('#book .bk-world').style.transform.match(/scale\(([\d.]+)\)/)[1]);
// How many px of the blue ink there are in a box on the screen ({ x, y, width, height })
async function blueIn(page, box) {
  const { data } = await shotPixels(page, box);
  let n = 0;
  for (let i = 0; i < data.length; i += 4)
    if (Math.abs(data[i] - BLUE[0]) + Math.abs(data[i + 1] - BLUE[1]) + Math.abs(data[i + 2] - BLUE[2]) < 60) n++;
  return n;
}
const overview = page => page.evaluate(() => !document.querySelector('#book .bk-far').hidden);
function near(now, from, [dx, dy], what) {
  const moved = [now.x - from.x, now.y - from.y];
  assert.ok(
    Math.abs(moved[0] - dx) <= NEAR_PX && Math.abs(moved[1] - dy) <= NEAR_PX,
    `${what}: moved ${moved.map(Math.round)}, not ${dx}, ${dy}`,
  );
}
