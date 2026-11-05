// book-check.mjs's stories of the board's controls (shell/ink/bookstrip.js, bookinput.js, bookvoice.js, bookpan.js,
// booktools.js, bookprefs.js): on a desktop with a mouse, the pen in use as the book opens (the rail: bar.mjs; the
// wheel: wheel.mjs), Ctrl's drag selecting and giving the tool back, a tap on the rail's mic and a spot held a voice
// note whose words write themselves there, a press held still only a dot, the preferences (in the dots) kept on this
// device; on a touch screen (the fingers and the Pencil in either engine, hands.mjs), a slide along the rail picking a
// tool, drifting off it too, one finger scrolling the grid and drawing nothing there, and in a scrap opened by a
// finger's tap one finger drawing and two moving it with no stray line, the Pencil tapping the mic and holding a spot,
// the Pencil held still only ink, and a finger that pans once the pen's been used, as the preferences have it unless
// turned off (on a fresh device the first pen anywhere in HQ turns that on, once, and only the board turns it off); and
// by hand at the board's iPad sizes, the Pencil writing in a long opened scrap and one finger or two scrolling it with
// the text tool on, leaving no ink and no box of words. Each asserts what the board sees and what the store keeps. The
// pen draws in a scrap opened on the page (the grid takes no ink: a finger scrolls it).
import assert from 'node:assert/strict';
import { desk, freePage, inScrap, paperBox, savedWhere, colourIn, BLUE, inkOn, cardInSight } from './mouse.mjs';
import { press } from './bar.mjs';
import { PREFERENCES, QUIET_MS, MINI, UPRIGHT, middleOf, openScrap, until, wordsHeard } from './kit.mjs';
import { mini } from './start.mjs';
import { SAID } from './voice.mjs';

// c: book-check.mjs's played store and helpers
export function stripStories(c) {
  return {
    'controls with a mouse: the pen in use, Ctrl selects': browser => mouse(browser, c),
    'controls with a mouse: the mic tapped, then a spot held, puts the words there as they’re said; Undo takes them back; a press held still is a dot':
      browser => voiceByMouse(browser, c),
    'controls with a mouse: Preferences, from the dots, stick on this device': browser => preferences(browser, c),
    'controls on a touch screen: a slide along the rail picks a tool, one finger scrolls the grid, in an opened scrap one finger draws and two move it':
      browser => fingers(browser, c),
    'controls with the Pencil: the mic tapped right after writing, then a spot held, dictates there, the Pencil held still is only ink, a finger pans once the pen is in use':
      browser => pencil(browser, c),
    'a fresh iPad: a finger draws in an opened scrap till the first pen anywhere in HQ, then scrolls it, after a reload too; turned off, it stays off':
      browser => firstPen(browser, c),
    'by hand on an iPad mini, sideways and upright: the Pencil writes in an opened scrap, a finger or two scrolls it with the text tool on, by default':
      async browser => {
        for (const viewport of [MINI, UPRIGHT]) await scrolling(browser, c, viewport);
      },
  };
}

// ---- the stories

async function mouse(browser, c) {
  const free = freePage(c);
  const { page, errors, done } = await desk(browser, c);
  try {
    const paper = await inScrap(page, c, free);
    assert.equal(await pressed(page), 'Pen', 'the pen in use');
    const mid = middleOf(paper);
    // a blue line, its key pressed with the mouse over the book: the colour keys are the book's only while the
    // pointer is on it (bookpalette.js)
    await page.mouse.move(...mid);
    await page.keyboard.press('0'); // (Blue, the pen's tenth colour)
    await stroke(page, [mid[0] - 80, mid[1]], [mid[0] + 80, mid[1]]);
    await savedWhere(c, free.id, p => p.ink.length === 1);
    assert.ok((await colourIn(page, BLUE)).n > 100, 'the blue line shows');
    const line = await colourIn(page, BLUE);
    // Ctrl's drag: a select box round the line, the pen back once it's let go, nothing drawn
    await page.keyboard.down('Control');
    await stroke(page, [line.x - 140, line.y - 60], [line.x + 140, line.y + 60]);
    await page.keyboard.up('Control');
    await page.locator('#book .bk-sel-bar').waitFor({ timeout: 2000 });
    // (given back a tick after Select's own lift: booktools.js selectFor.)
    await until(async () => (await pressed(page)) === 'Pen', 'the pen back after the Ctrl drag', 2000);
    await page.waitForTimeout(QUIET_MS);
    assert.equal(stored(c, free).ink.length, 1, 'Ctrl drew nothing');
    await c.shot('book-strip-desktop', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function voiceByMouse(browser, c) {
  const free = freePage(c);
  const { page, errors, done } = await desk(browser, c);
  try {
    const mid = middleOf(await inScrap(page, c, free));
    // a press held still a second and a half: a dot, and nothing listens or opens (no long press anywhere)
    await stillFor(
      page,
      [mid[0] + 140, mid[1] + 160],
      at => page.mouse.move(...at).then(() => page.mouse.down()),
      () => page.mouse.up(),
    );
    await savedWhere(c, free.id, p => p.ink.length === 1);
    await stroke(page, [mid[0] - 140, mid[1] - 80], [mid[0] + 20, mid[1] - 60]);
    await savedWhere(c, free.id, p => p.ink.length === 2);
    await dictated(
      page,
      c,
      free,
      {
        tap: name => press(page, name),
        down: at => page.mouse.move(...at).then(() => page.mouse.down()),
        up: () => page.mouse.up(),
      },
      [mid[0] - 100, mid[1] + 60],
      'book-voice-listening',
    );
    await page.locator('#book .bk-scrap-history').getByRole('button', { name: 'Undo', exact: true }).click();
    await savedWhere(c, free.id, p => p.texts.length === 0);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function preferences(browser, c) {
  let { page, errors, done } = await desk(browser, c);
  try {
    await press(page, PREFERENCES);
    const card = page.getByRole('dialog', { name: PREFERENCES });
    // (whether touch scrolls, and the pen's voice note hold outside the notebook: no radial menu)
    assert.equal(await card.locator('input').count(), 4, 'touch scrolls, and three hold times');
    assert.equal(await card.getByLabel('Touch always scrolls').isChecked(), false, 'off where no pen was ever used');
    assert.equal(await card.getByLabel('Medium').isChecked(), true, 'the hold medium on a new device');
    await card.getByLabel('Touch always scrolls').check();
    await card.getByLabel('Long').check();
    await c.shot('book-prefs', page);
    assert.deepEqual(errors, []);
    await done();
    ({ page, errors, done } = await desk(browser, c, { keep: true }));
    await press(page, PREFERENCES);
    const kept = page.getByRole('dialog', { name: PREFERENCES });
    assert.equal(await kept.getByLabel('Touch always scrolls').isChecked(), true, 'kept on this device');
    assert.equal(await kept.getByLabel('Long').isChecked(), true, 'the hold kept on this device');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function fingers(browser, c) {
  const free = freePage(c);
  // (a grid longer than the screen: nine scraps, each a tall line)
  for (let i = 0; i < 9; i++) c.notebook.route('/api/notebooks/groups/create', {}, { page: free.id, ink: [tall(i)] });
  const { page, touch, errors, done } = await mini(browser, c);
  try {
    await slid(page, touch, c);
    await page.locator('#book .bk-strip').getByRole('button', { name: 'Pen', exact: true }).tap();
    await page.keyboard.press('0'); // (Blue, the pen's tenth colour)
    // one finger on the grid scrolls it, on a fresh device too: the grid takes no ink
    const ink = inkOn(c, free),
      mid = middleOf(await paperBox(page)),
      top = await placed(page);
    await touch.stroke([[mid[0], mid[1] + 150]], [[mid[0], mid[1] - 150]]);
    await page.waitForTimeout(QUIET_MS);
    const scrolled = await placed(page);
    assert.ok(scrolled[1] < top[1] - 100, `one finger scrolled the grid: ${top} → ${scrolled}`);
    assert.equal(inkOn(c, free), ink, 'no ink on the grid from a finger');
    // a finger's tap on a card in sight opens its scrap, and on it one finger draws
    await openScrap(page, fingerOf(touch), undefined, await cardInSight(page));
    const at = middleOf(await page.locator('#book .bk-sheet').boundingBox());
    await touch.stroke([[at[0] - 100, at[1]]], [[at[0] + 100, at[1]]]);
    await until(() => inkOn(c, free) === ink + 1, "the finger's line saved in the scrap");
    assert.ok((await colourIn(page, BLUE)).n > 100, 'the blue line shows');
    // two fingers move the opened scrap, drawing nothing
    const before = await placed(page);
    const two = (dx, dy) => [-60, 60].map(x => [at[0] + x + dx, at[1] + 120 + dy]);
    await touch.stroke(two(0, 0), two(90, 40));
    await page.waitForTimeout(QUIET_MS);
    const after = await placed(page);
    assert.notDeepEqual(after, before, 'two fingers moved the opened scrap');
    assert.equal(inkOn(c, free), ink + 1, 'no stray line from two fingers');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// A slide along the rail: each tool's name as it passes, the one it lifts on picked, no hold
async function slid(page, touch, c) {
  const b = name => page.locator('#book .bk-strip').getByRole('button', { name, exact: true }).boundingBox();
  const [select, eraser] = [await b('Select'), await b('Eraser')];
  await touch.down([middleOf(select)]);
  // (drifting off the rail onto the paper beside it: the tool level with the finger, the rail standing upright.
  await touch.move([[eraser.x - 30, eraser.y + eraser.height / 2]], 8);
  await until(async () => (await page.locator('#bk-tip').textContent()).startsWith('Eraser'), "the eraser's name");
  await c.shot('book-strip-slide', page);
  await touch.up();
  await until(async () => (await pressed(page)) === 'Eraser', 'the eraser picked by the slide');
}

async function pencil(browser, c) {
  const free = freePage(c);
  const { page, pen, touch, errors, done } = await mini(browser, c);
  try {
    const mid = middleOf(await inScrap(page, c, free, pen.tap));
    // the Pencil held still a second and a half: a dot, and nothing listens or opens
    await stillFor(page, [mid[0] + 120, mid[1] + 200], pen.down, pen.up);
    await savedWhere(c, free.id, p => p.ink.length === 1);
    // a line written, then the Pencil taps the mic and holds a spot below it: the words there
    await pen.stroke([
      [mid[0] - 120, mid[1] - 60],
      [mid[0] - 40, mid[1] - 50],
      [mid[0] + 40, mid[1] - 60],
    ]);
    await savedWhere(c, free.id, p => p.ink.length === 2);
    const tap = async name =>
      pen.tap(middleOf(await page.locator('#book .bk-strip').getByRole('button', { name, exact: true }).boundingBox()));
    await dictated(page, c, free, { tap, down: pen.down, up: pen.up }, [mid[0] - 80, mid[1] + 40], 'book-voice-pencil');
    // the pen used, so "touch always scrolls" on: a finger moves the page and draws nothing
    const ink = stored(c, free).ink.length;
    await touch.stroke([[mid[0] - 80, mid[1] + 100]], [[mid[0] + 40, mid[1] + 120]]);
    await page.waitForTimeout(QUIET_MS);
    assert.equal(stored(c, free).ink.length, ink, 'the finger panned, drawing nothing');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// A fresh iPad, nothing kept on it: a finger draws in an opened scrap; the first pen tap anywhere in HQ, here on
// HQ's own page beside the book, turns "touch always scrolls" on, once; from then a finger moves the scrap with no pen
// first, after a reload too. Turned off in Preferences, it stays off however often the pen comes back.
async function firstPen(browser, c) {
  const free = freePage(c);
  c.notebook.route('/api/notebooks/groups/create', {}, { page: free.id, ink: [tall(0)] });
  const { page, pen, touch, errors, done } = await mini(browser, c);
  const kept = () => page.evaluate(() => JSON.parse(localStorage.getItem('ink.prefs') ?? '{}'));
  const { draws, pans } = fingerLines(page, touch, c, free);
  // (on HQ's page beside the book, nothing there to press)
  const onHq = await page.evaluate(() => {
    const at = [8, innerHeight - 8];
    if (document.elementFromPoint(...at)?.closest('#book, button, a, input')) throw new Error('no bare HQ there');
    return at;
  });
  try {
    assert.deepEqual(await kept(), {}, 'nothing kept on a fresh device');
    await draws('a finger draws before any pen');
    await pen.tap(onHq);
    await until(async () => (await kept()).penPans === true, 'the first pen, outside the book, turned it on');
    await reopen(page, c);
    await pans('after a reload, a finger moves the scrap with no pen first');
    await press(page, PREFERENCES);
    const card = page.getByRole('dialog', { name: PREFERENCES });
    assert.equal(await card.getByLabel('Touch always scrolls').isChecked(), true, 'on in Preferences');
    await card.getByLabel('Touch always scrolls').uncheck();
    await page.keyboard.press('Escape');
    await pen.tap(onHq);
    await page.waitForTimeout(QUIET_MS);
    assert.equal((await kept()).penPans, false, 'the pen again turns nothing back on');
    await reopen(page, c);
    await draws('turned off, a finger draws again after a reload');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// A finger's line across the free page's scrap, opened by a finger's tap if it isn't: it draws (the line saved), or
// it moves the scrap and leaves nothing
function fingerLines(page, touch, c, free) {
  const finger = async () => {
    if (!(await page.locator('#book .bk-sheet').isVisible()))
      await openScrap(page, fingerOf(touch), undefined, await cardInSight(page));
    const n = inkOn(c, free),
      [x, y] = middleOf(await page.locator('#book .bk-sheet').boundingBox());
    await touch.stroke([[x - 80, y + 60]], [[x + 40, y - 60]]);
    return n;
  };
  return {
    draws: async why => {
      const n = await finger();
      await until(() => inkOn(c, free) > n, why);
    },
    pans: async why => {
      const n = await finger();
      await page.waitForTimeout(QUIET_MS);
      assert.equal(inkOn(c, free), n, why);
    },
  };
}
// HQ reloaded, nothing else changed, the book open again
async function reopen(page, c) {
  await page.reload();
  await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
  await c.settled(page, 'open');
}

// The board's walk-through by hand, nothing set on the device: a scrap with a line far down it, opened by the Pencil,
// longer than the screen; the Pencil writes a line on it, the text tool picked; a finger's drag up and then two
// fingers' scroll it each time, and neither leaves ink or a box of words
async function scrolling(browser, c, viewport) {
  const free = freePage(c);
  // (a line written far down it: the scrap as tall as what's on it, longer than the screen)
  free.ink.push({
    color: '#1d9a5b',
    size: 5,
    points: Array.from({ length: 40 }, (_, i) => [20 + (i % 2) * 260, i * 70, 0.5, i * 16]),
  });
  const { page, pen, touch, errors, done } = await mini(browser, c, { viewport });
  const size = `${viewport.width} × ${viewport.height}`;
  try {
    const mid = middleOf(await inScrap(page, c, free, pen.tap));
    await pen.stroke([
      [mid[0] - 80, mid[1]],
      [mid[0], mid[1] + 10],
      [mid[0] + 80, mid[1]],
    ]);
    const { ink } = await savedWhere(c, free.id, p => p.ink.length === 2);
    await page.locator('#book .bk-strip').getByRole('button', { name: 'Text', exact: true }).tap();
    await until(async () => (await pressed(page)) === 'Text', 'the text tool picked');
    for (const fingers of [1, 2]) {
      const before = await placed(page),
        from = Array.from({ length: fingers }, (_, i) => [mid[0] - 40 + i * 80, mid[1] + 150]);
      await touch.stroke(
        from,
        from.map(([x, y]) => [x, y - 250]),
      );
      await page.waitForTimeout(QUIET_MS);
      const after = await placed(page);
      assert.ok(after[1] < before[1] - 100, `${fingers} finger(s) scrolled the scrap at ${size}: ${before} → ${after}`);
      assert.equal(
        await page.locator('#book .bk-typed').count(),
        0,
        `no box of words from ${fingers} finger(s) at ${size}`,
      );
      assert.equal(stored(c, free).ink.length, ink.length, `no ink from ${fingers} finger(s) at ${size}`);
      assert.equal(stored(c, free).texts.length, 0, `no words kept from ${fingers} finger(s) at ${size}`);
      await c.shot(`book-scroll-${fingers}-${viewport.width}`, page);
      // (back to the top for the next)
      await touch.stroke([[mid[0], mid[1] - 150]], [[mid[0], mid[1] + 400]]);
      await page.waitForTimeout(QUIET_MS);
    }
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// ---- helpers

// A tall line down a scrap (in its own px), the i-th of a story's long grid
const tall = i => ({
  color: '#1d9a5b',
  size: 5,
  points: Array.from({ length: 12 }, (_, k) => [40 + (k % 2) * 240, 20 + k * 40, 0.5, i * 1000 + k * 16]),
});
// A finger's tap, as openScrap takes a pen's
const fingerOf = touch => ({ tap: at => touch.down([at]).then(() => touch.up()) });
// The mic tapped (tap(name): the rail's button of that name pressed by the mouse, the Pencil or Safari's), then a spot
// on the paper held (down(at) and up(at), at: on the screen): the words show there as they're heard, the mic red while
// it's held; let go, the mic out at once and the words land at the spot. shot: the listening's picture's name.
export async function dictated(page, c, free, { tap, down, up }, at, shot) {
  const mic = page.locator('#book .bk-mic');
  await tap('Voice note');
  assert.equal(await mic.getAttribute('aria-pressed'), 'true', 'the mic lit, waiting for a spot');
  await down(at);
  await page.locator('#book .bk-heard').waitFor({ timeout: 5000 });
  assert.equal(await mic.getAttribute('data-listening'), '', 'the mic recording while the spot is held');
  await wordsHeard(page);
  await c.shot(shot, page);
  await up(at);
  assert.equal(await mic.getAttribute('aria-pressed'), 'false', 'let go, the mic out at once');
  const [words] = (await savedWhere(c, free.id, p => p.texts.length === 1)).texts;
  assert.equal(words.text, SAID);
  const box = await page.locator('#book .bk-typed').boundingBox();
  assert.ok(
    at[0] >= box.x - 4 && at[0] <= box.x + box.width && at[1] >= box.y - 4 && at[1] <= box.y + box.height,
    `the words where the spot was held: ${JSON.stringify({ at, box })}`,
  );
  await until(async () => (await page.locator('#book .bk-heard').count()) === 0, 'the words as heard gone');
}
// A press held still for a second and a half (down(at), then up(at)): it opens nothing, and nothing listens
export async function stillFor(page, at, down, up) {
  await down(at);
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('#book .bk-heard').count(), 0, 'a press held still listens to nothing');
  assert.equal(await page.locator('#book [role=menu]:visible').count(), 0, 'a press held still opens nothing');
  await up(at);
}

async function stroke(page, [x0, y0], [x1, y1]) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 16, y0 + ((y1 - y0) * i) / 16);
  await page.mouse.up();
}
// Where the page is on the paper: its top-left's shift on the screen (bookview.js draws it there)
export const placed = page =>
  page.evaluate(() => {
    const m = new DOMMatrix(getComputedStyle(document.querySelector('#book .bk-world')).transform);
    return [Math.round(m.e), Math.round(m.f)];
  });
export const pressed = page =>
  page.evaluate(
    () => document.querySelector('#book .bk-strip [aria-pressed=true]')?.getAttribute('aria-label') ?? null,
  );
export const stored = (c, free) => c.pages.find(p => p.id === free.id);
