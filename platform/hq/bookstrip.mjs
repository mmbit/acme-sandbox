// book-check.mjs's stories of the board's controls (shell/ink/bookstrip.js, bookinput.js, bookpan.js, booktools.js,
// bookprefs.js): on a desktop with a mouse, the pen in use as the book opens (the rail: bookbar.mjs; the wheel: bookwheel.mjs),
// Ctrl's drag selecting and giving the tool back, a press held still a voice note whose
// words land where it was held, the cog's preferences kept on this device and its hold time obeyed; on a touch screen
// (Chromium's own touch and pen events, trusted), one finger drawing and two moving the page with no stray line, a
// slide along the rail picking a tool, drifting above it too, a double tap held a voice note, the radial menu
// on a long press, and a finger that pans once the pen's been used where the preferences say so. Each asserts what the
// board sees and what the store keeps.
import assert from 'node:assert/strict';
import { desk, freePage, paperBox, savedWhere, colourIn, BLUE } from './bookmouse.mjs';
import { HEARD, QUIET_MS, middleOf, mini, until, wordsHeard } from './bookkit.mjs';

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
    assert.equal(await kept.getByLabel('When pen is active, touch always pans').isChecked(), false);
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
    // (the page scrolls down only, never sideways: a page this short stays put. job #14672)
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
    await page.evaluate(() =>
      localStorage.setItem('ink.prefs', JSON.stringify({ radial: true, penPans: true, hold: 'medium' })),
    );
    const ring = [paper.x + paper.width / 2, paper.y + paper.height / 2 + 40];
    await pen.down(ring);
    await page.locator('#book .bk-radial [role=menuitemradio]').first().waitFor({ timeout: 2000 });
    const lit = await page.locator('#book .bk-radial').getByRole('menuitemradio', { name: 'Marker' }).boundingBox();
    await pen.move(middleOf(lit));
    await c.shot('book-radial', page);
    await pen.up(middleOf(lit));
    await until(async () => (await pressed(page)) === 'Marker', 'the highlighter picked from the ring');
    assert.equal(await page.locator('#book .bk-radial').count(), 0, 'the ring gone');
    // "touch always pans" on, and the pen used: a finger moves the page and draws nothing
    const ink = stored(c, free).ink.length;
    await touch.stroke([[ring[0] - 80, ring[1] + 100]], [[ring[0] + 40, ring[1] + 120]]);
    await page.waitForTimeout(QUIET_MS);
    assert.equal(stored(c, free).ink.length, ink, 'the finger panned, drawing nothing');
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
