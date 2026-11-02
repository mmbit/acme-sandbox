// book-check.mjs's stories of the board's controls (shell/ink/bookstrip.js, bookinput.js, bookpan.js, booktools.js,
// bookprefs.js): on a desktop with a mouse, the pen in use as the book opens (the rail: bookbar.mjs; the wheel: bookwheel.mjs),
// Ctrl's drag selecting and giving the tool back, a press held still a voice note whose
// words land where it was held, the cog's preferences kept on this device and its hold time obeyed; on a touch screen
// (Chromium's own touch and pen events, trusted), one finger drawing and two moving the page with no stray line, a
// slide along the rail picking a tool, drifting above it too, a double tap held a voice note, the radial menu
// on a long press, and a finger that pans once the pen's been used, as the preferences have it unless turned off (on a
// fresh device the first pen anywhere in HQ turns that on, once, and only the board turns it off); and
// by hand at the board's iPad sizes, the Pencil writing and one finger or two scrolling a long page with the text tool
// on, leaving no ink and no box of words. Each asserts what the board sees and what the store keeps.
import assert from 'node:assert/strict';
import { desk, freePage, paperBox, savedWhere, colourIn, BLUE } from './bookmouse.mjs';
import { press } from './bookbar.mjs';
import { HEARD, QUIET_MS, MINI, UPRIGHT, middleOf, mini, until, wordsHeard } from './bookkit.mjs';

// c: book-check.mjs's played store and helpers
export function stripStories(c) {
  return {
    'controls with a mouse: the pen in use, Ctrl selects': browser => mouse(browser, c),
    'controls with a mouse: held still, a voice note lands its words where it was held; Undo takes them back':
      browser => voiceByMouse(browser, c),
    "controls with a mouse: the cog's preferences stick on this device, and the hold waits as long as they say":
      browser => preferences(browser, c),
    'controls on a touch screen: one finger draws, two move the page, a slide along the rail picks a tool': browser =>
      fingers(browser, c),
    'controls with the Pencil: a double tap held is a voice note, the radial menu on a long press, a finger pans once the pen is in use':
      browser => pencil(browser, c),
    'a fresh iPad: a finger draws till the first pen anywhere in HQ, then scrolls, after a reload too; turned off, it stays off':
      browser => firstPen(browser, c),
    'by hand on an iPad mini, sideways and upright: the Pencil writes, a finger or two scrolls with the text tool on, by default':
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
    const paper = await paperBox(page);
    assert.equal(await pressed(page), 'Pen', 'the pen in use');
    const mid = middleOf(paper);
    // a blue line, its key pressed with the mouse over the book: the colour keys are the book's only while the
    // pointer is on it (bookpalette.js)
    await page.mouse.move(...mid);
    await page.keyboard.press('3');
    await stroke(page, [mid[0] - 80, mid[1]], [mid[0] + 80, mid[1]]);
    await savedWhere(c, free.id, p => p.ink.length === 1);
    assert.ok((await colourIn(page, BLUE)).n > 100, 'the blue line shows');
    const line = await colourIn(page, BLUE);
    // Ctrl's drag: a select box round the line, the pen back once it's let go, nothing drawn
    await page.keyboard.down('Control');
    await stroke(page, [line.x - 140, line.y - 60], [line.x + 140, line.y + 60]);
    await page.keyboard.up('Control');
    await page.locator('#book .bk-sel-bar').waitFor({ timeout: 2000 });
    assert.equal(await pressed(page), 'Pen', 'the pen back after the Ctrl drag');
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
    const paper = await paperBox(page),
      at = [paper.x + 300, paper.y + 260];
    await page.mouse.move(...at);
    await page.mouse.down();
    await page.locator('#book .bk-voice').waitFor();
    await wordsHeard(page);
    await c.shot('book-voice-listening', page);
    await page.mouse.up();
    const saved = await savedWhere(c, free.id, p => p.texts.length === 1);
    assert.equal(saved.texts[0].text, HEARD);
    assert.equal(saved.ink.length, 0, 'the hold drew nothing');
    // (a unit of their own in the column it was held, where the masonry lays it: bookunits.js. Hidden while they
    // land: bookarrive.js)
    const words = page.locator('#book .bk-typed');
    await words.waitFor();
    const box = await words.boundingBox();
    assert.ok(box.x <= at[0] && at[0] <= box.x + box.width, `the words where it held: ${JSON.stringify([at, box])}`);
    assert.equal(await page.locator('#book .bk-voice').count(), 0, 'the listening slip gone');
    await page.locator('#book').getByRole('button', { name: 'Undo', exact: true }).click();
    await savedWhere(c, free.id, p => p.texts.length === 0);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function preferences(browser, c) {
  const free = freePage(c);
  let { page, errors, done } = await desk(browser, c);
  try {
    await page.locator('#book').getByRole('button', { name: 'Preferences on this device' }).click();
    const card = page.getByRole('dialog', { name: 'Preferences on this device' });
    assert.equal(await card.getByLabel('Medium').isChecked(), true, 'Medium, 750 ms, by default');
    await card.getByLabel('Long').check();
    await card.getByLabel('Use radial menu').check();
    await c.shot('book-prefs', page);
    assert.deepEqual(errors, []);
    await done();
    ({ page, errors, done } = await desk(browser, c, { keep: true }));
    await page.locator('#book').getByRole('button', { name: 'Preferences on this device' }).click();
    const kept = page.getByRole('dialog', { name: 'Preferences on this device' });
    assert.equal(await kept.getByLabel('Long').isChecked(), true, 'Long kept on this device');
    assert.equal(await kept.getByLabel('Use radial menu').isChecked(), true, 'the radial menu kept');
    assert.equal(await kept.getByLabel('Touch always scrolls').isChecked(), false, 'off where no pen was ever used');
    await page.keyboard.press('Escape');
    // Long: a press held 800 ms is no voice note yet; held on past 1000 ms it is
    const paper = await paperBox(page);
    await page.mouse.move(paper.x + 300, paper.y + 300);
    await page.mouse.down();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('#book .bk-voice').count(), 0, 'no voice note at 800 ms with Long');
    await page.locator('#book .bk-voice').waitFor({ timeout: 1000 });
    await wordsHeard(page);
    await page.mouse.up();
    await savedWhere(c, free.id, p => p.texts.length === 1);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function fingers(browser, c) {
  const free = freePage(c);
  const { page, touch, errors, done } = await mini(browser, c);
  try {
    const paper = await paperBox(page),
      mid = middleOf(paper);
    // a slide along the rail: each tool's name as it passes, the one it lifts on picked, no hold
    const b = name => page.locator('#book .bk-strip').getByRole('button', { name, exact: true }).boundingBox();
    const [select, eraser] = [await b('Select'), await b('Eraser')];
    await touch.down([middleOf(select)]);
    // (drifting above the rail onto the paper: the tool level with the finger)
    await touch.move([[eraser.x + eraser.width / 2, eraser.y - 30]], 8);
    await until(async () => (await page.locator('#bk-tip').textContent()).startsWith('Eraser'), "the eraser's name");
    await c.shot('book-strip-slide', page);
    await touch.up();
    await until(async () => (await pressed(page)) === 'Eraser', 'the eraser picked by the slide');
    await page.locator('#book .bk-strip').getByRole('button', { name: 'Pen', exact: true }).tap();
    // one finger draws
    await page.keyboard.press('3');
    await touch.stroke([[mid[0] - 100, mid[1]]], [[mid[0] + 100, mid[1]]]);
    await savedWhere(c, free.id, p => p.ink.length === 1);
    assert.ok((await colourIn(page, BLUE)).n > 100, 'the blue line shows');
    const before = await placed(page);
    // two fingers drawing nothing
    await touch.stroke(
      [
        [mid[0] - 60, mid[1] + 120],
        [mid[0] + 60, mid[1] + 120],
      ],
      [
        [mid[0] - 60 + 90, mid[1] + 160],
        [mid[0] + 60 + 90, mid[1] + 160],
      ],
    );
    // The page scrolls down only, never sideways: a page this short stays put.
    const after = await placed(page);
    assert.equal(after[0], before[0], `two fingers never move the page sideways: ${JSON.stringify([before, after])}`);
    await page.waitForTimeout(QUIET_MS);
    assert.equal(stored(c, free).ink.length, 1, 'no stray line from two fingers');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function pencil(browser, c) {
  const free = freePage(c);
  const { page, pen, touch, errors, done } = await mini(browser, c);
  try {
    const paper = await paperBox(page),
      at = [paper.x + paper.width / 2 - 60, paper.y + 200];
    // a lone tap draws a dot (so a double tap's first one does too)
    await pen.tap([at[0] + 160, at[1]]);
    const [lone] = (await savedWhere(c, free.id, p => p.ink.length === 1)).ink;
    // a double tap held: the first tap's dot taken off, the lone dot kept, the words where it held
    await pen.doubleTap(at);
    await page.locator('#book .bk-voice').waitFor();
    await wordsHeard(page);
    await pen.up(at);
    const saved = await savedWhere(c, free.id, p => p.texts.length === 1);
    assert.equal(saved.texts[0].text, HEARD);
    await page.waitForTimeout(QUIET_MS);
    const left = stored(c, free).ink.map(s => s.points);
    assert.deepEqual(left, [lone.points], "the double tap's dot taken off, the lone dot kept");
    // the radial menu on: a long press opens it, a slide out to the highlighter and a lift picks it
    await page.evaluate(() => localStorage.setItem('ink.prefs', JSON.stringify({ radial: true, hold: 'medium' })));
    const ring = [paper.x + paper.width / 2, paper.y + paper.height / 2 + 40];
    await pen.down(ring);
    await page.locator('#book .bk-radial [role=menuitemradio]').first().waitFor({ timeout: 2000 });
    const lit = await page.locator('#book .bk-radial').getByRole('menuitemradio', { name: 'Marker' }).boundingBox();
    await pen.move(middleOf(lit));
    await c.shot('book-radial', page);
    await pen.up(middleOf(lit));
    await until(async () => (await pressed(page)) === 'Marker', 'the highlighter picked from the ring');
    assert.equal(await page.locator('#book .bk-radial').count(), 0, 'the ring gone');
    // the pen used, so "touch always scrolls" on: a finger moves the page and draws nothing
    const ink = stored(c, free).ink.length;
    await touch.stroke([[ring[0] - 80, ring[1] + 100]], [[ring[0] + 40, ring[1] + 120]]);
    await page.waitForTimeout(QUIET_MS);
    assert.equal(stored(c, free).ink.length, ink, 'the finger panned, drawing nothing');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// A fresh iPad, nothing kept on it (the board, call 177): a finger draws; the first pen tap anywhere in HQ, here on
// HQ's own page beside the book, turns "touch always scrolls" on, once; from then a finger moves the page with no pen
// first, after a reload too. Turned off in Preferences, it stays off however often the pen comes back.
async function firstPen(browser, c) {
  const free = freePage(c);
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
    await pans('after a reload, a finger moves the page with no pen first');
    await press(page, 'Preferences on this device');
    const card = page.getByRole('dialog', { name: 'Preferences on this device' });
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

// A finger's line across the free page's paper: it draws (the line saved), or it moves the page and leaves nothing
function fingerLines(page, touch, c, free) {
  const finger = async () => {
    const n = stored(c, free).ink.length,
      [x, y] = middleOf(await paperBox(page));
    await touch.stroke([[x - 80, y + 60]], [[x + 40, y - 60]]);
    return n;
  };
  return {
    draws: async why => {
      const n = await finger();
      await savedWhere(c, free.id, p => p.ink.length > n).catch(() => assert.fail(why));
    },
    pans: async why => {
      const n = await finger();
      await page.waitForTimeout(QUIET_MS);
      assert.equal(stored(c, free).ink.length, n, why);
    },
  };
}
// HQ reloaded, nothing else changed, the book open again
async function reopen(page, c) {
  await page.reload();
  await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
  await c.settled(page, 'open');
}

// The board's walk-through by hand (call 174), nothing set on the device: a long page, the Pencil writes a line, the
// text tool picked; a finger's drag up and then two fingers' scroll the page each time, and neither leaves ink or a
// box of words
async function scrolling(browser, c, viewport) {
  const free = freePage(c);
  // (a line written far down it: the page as tall as what's on it, longer than the screen)
  free.ink.push({
    color: '#1d9a5b',
    size: 5,
    points: Array.from({ length: 40 }, (_, i) => [80 + (i % 2) * 400, i * 70, 0.5, i * 16]),
  });
  const { page, pen, touch, errors, done } = await mini(browser, c, { viewport });
  const size = `${viewport.width} × ${viewport.height}`;
  try {
    const paper = await paperBox(page),
      mid = middleOf(paper);
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
      assert.ok(after[1] < before[1] - 100, `${fingers} finger(s) scrolled the page at ${size}: ${before} → ${after}`);
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
