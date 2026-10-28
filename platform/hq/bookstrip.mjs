// book-check.mjs's stories of the board's controls (shell/ink/bookstrip.js, bookinput.js, bookpan.js, booktools.js,
// bookprefs.js): on a desktop with a mouse, the strip on the page's left naming its tool, the wheel stepping through
// the tools, Ctrl and the wheel zooming, Shift's drag moving the page, Ctrl's drag selecting and giving the tool back, a
// press held still a voice note whose words land where it was held, the cog's preferences kept on this device and its
// hold time obeyed; on a touch screen (Chromium's own touch and pen events, trusted), one finger drawing and two moving
// the page with no stray line, a slide along the strip picking a tool, a double tap held a voice note, the radial
// menu on a long press, and a finger that pans once the pen's been used where the preferences say so. Each asserts
// what the board sees and what the store keeps.
import assert from 'node:assert/strict';
import { freePage, onDesk, paperBox, savedWhere, colourIn, BLUE } from './bookmouse.mjs';

export const MINI = { width: 1133, height: 744 };
// how long a story waits to be sure something didn't happen (the page is saved this soon after a change)
export const QUIET_MS = 1200;
// what the stand-in microphone hears
export const HEARD = 'order the blue mugs';

// c: book-check.mjs's played store and helpers
export function stripStories(c) {
  return {
    'controls with a mouse: the strip on the left names its tool; the wheel steps through tools, Ctrl zooms, Shift pans, Ctrl selects':
      browser => mouse(browser, c),
    'controls with a mouse: held still, a voice note lands its words where it was held; Undo takes them back':
      browser => voiceByMouse(browser, c),
    "controls with a mouse: the cog's preferences stick on this device, and the hold waits as long as they say":
      browser => preferences(browser, c),
    'controls on a touch screen: one finger draws, two move the page, a slide along the strip picks a tool': browser =>
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
    const paper = await paperBox(page),
      strip = await page.locator('#book .bk-strip [data-island=tools]').boundingBox();
    assert.ok(strip.x < paper.x + 120, `the strip on the page's left: ${strip.x} against ${paper.x}`);
    assert.equal(await now(page), 'Pen', 'the tool in use named');
    // the wheel: one notch on, one back
    const mid = [paper.x + paper.width / 2, paper.y + paper.height / 2];
    await page.mouse.move(...mid);
    await page.mouse.wheel(0, 100);
    await until(async () => (await now(page)) === 'Highlighter', 'the next tool after a notch');
    await page.waitForTimeout(300);
    await page.mouse.wheel(0, -100);
    await until(async () => (await now(page)) === 'Pen', 'the tool before after a notch back');
    // a blue line, then Shift's drag moves it on the screen, drawing nothing
    await page.keyboard.press('3');
    await stroke(page, [mid[0] - 80, mid[1]], [mid[0] + 80, mid[1]]);
    await savedWhere(c, free.id, p => p.ink.length === 1);
    assert.ok((await colourIn(page, BLUE)).n > 100, 'the blue line shows');
    const before = await placed(page);
    await page.keyboard.down('Shift');
    await stroke(page, [mid[0] - 100, mid[1] - 150], [mid[0] - 50, mid[1] - 120]);
    await page.keyboard.up('Shift');
    const after = await placed(page);
    assert.deepEqual([after[0] - before[0], after[1] - before[1]], [50, 30], "Shift's drag moved the page with it");
    const line = await colourIn(page, BLUE);
    // Ctrl's drag: a select box round the line, the pen back once it's let go, nothing drawn
    await page.keyboard.down('Control');
    await stroke(page, [line.x - 140, line.y - 60], [line.x + 140, line.y + 60]);
    await page.keyboard.up('Control');
    await page.locator('#book .bk-sel-bar').waitFor({ timeout: 2000 });
    assert.equal(await pressed(page), 'Pen', 'the pen back after the Ctrl drag');
    // Ctrl and the wheel zoom: the % shows
    await page.mouse.move(...mid);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -200);
    await page.keyboard.up('Control');
    await until(() => page.locator('#book .bk-pct').isVisible(), 'the zoom off 100%');
    await page.waitForTimeout(QUIET_MS);
    assert.equal(stored(c, free).ink.length, 1, 'Shift, Ctrl and the wheel drew nothing');
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
    await page.locator('#book .bk-voice').waitFor({ timeout: 2000 });
    await until(async () => (await page.locator('#book .bk-voice').textContent()).includes(HEARD), 'the words heard');
    await c.shot('book-voice-listening', page);
    await page.mouse.up();
    const saved = await savedWhere(c, free.id, p => p.texts.length === 1);
    assert.equal(saved.texts[0].text, HEARD);
    assert.equal(saved.ink.length, 0, 'the hold drew nothing');
    const box = await page.locator('#book .bk-typed').boundingBox();
    assert.ok(Math.abs(box.x - at[0]) < 30 && Math.abs(box.y + box.height / 2 - at[1]) < 30, 'the words where it held');
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
      mid = [paper.x + paper.width / 2, paper.y + paper.height / 2];
    // a slide along the strip: each tool's name as it passes, the one it lifts on picked
    const b = name => page.locator('#book .bk-strip').getByRole('button', { name, exact: true }).boundingBox();
    const [select, eraser] = [await b('Select'), await b('Eraser')];
    await touch.down([[select.x + select.width / 2, select.y + select.height / 2]]);
    await page.waitForTimeout(300);
    await touch.move([[eraser.x + eraser.width / 2, eraser.y + eraser.height / 2]], 8);
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
    // two fingers move the page, drawing nothing
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
    const after = await placed(page);
    assert.ok(
      Math.abs(after[0] - before[0] - 90) < 6,
      `two fingers moved the page: ${JSON.stringify([before, after])}`,
    );
    await page.waitForTimeout(QUIET_MS);
    assert.equal(stored(c, free).ink.length, 1, 'no stray line from two fingers');
    await shortStrip(page, touch, b);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// A phone on its side, too short for the whole strip: a quick drag along it scrolls it, picking nothing, to the cog at
// its foot; a press held still slides as ever.
async function shortStrip(page, touch, b) {
  await page.setViewportSize({ width: 844, height: 390 });
  const island = page.locator('#book .bk-strip .bk-island');
  await until(() => island.evaluate(el => el.hasAttribute('data-scrolls')), 'the strip scrolling on a short screen');
  const was = await pressed(page),
    type = await b('Type');
  await touch.down([middleOf(type)]);
  await touch.move([[type.x + type.width / 2, type.y - 180]], 8);
  await touch.up();
  await until(() => island.evaluate(el => el.scrollTop > 0), 'the strip scrolled by a drag');
  assert.equal(await pressed(page), was, 'a drag along a scrolling strip picks nothing');
  const cog = await b('Preferences on this device');
  assert.ok(cog && cog.y + cog.height <= 390, `the cog brought onto the screen: ${JSON.stringify(cog)}`);
  const shapes = page.locator('#book .bk-strip').getByRole('button', { name: /^Shapes/ });
  const [from, to] = [await b('Type'), await shapes.boundingBox()];
  await touch.down([middleOf(from)]);
  await page.waitForTimeout(300);
  await touch.move([middleOf(to)], 8);
  await touch.up();
  await until(async () => /^Shapes/.test(await pressed(page)), 'Shapes picked by a slide on the scrolling strip');
}

async function pencil(browser, c) {
  const free = freePage(c);
  const { page, pen, touch, errors, done } = await mini(browser, c);
  try {
    const paper = await paperBox(page),
      at = [paper.x + paper.width / 2 - 60, paper.y + 200];
    // a double tap held: the first tap's dot taken off, the words where it held
    await pen.tap(at);
    await page.waitForTimeout(120);
    await pen.down(at);
    await page.locator('#book .bk-voice').waitFor({ timeout: 2000 });
    await until(async () => (await page.locator('#book .bk-voice').textContent()).includes(HEARD), 'the words heard');
    await pen.up(at);
    const saved = await savedWhere(c, free.id, p => p.texts.length === 1);
    assert.equal(saved.texts[0].text, HEARD);
    await page.waitForTimeout(QUIET_MS);
    assert.equal(stored(c, free).ink.length, 0, "the double tap's dot taken off");
    // the radial menu on: a long press opens it, a slide out to the highlighter and a lift picks it
    await page.evaluate(() =>
      localStorage.setItem('ink.prefs', JSON.stringify({ radial: true, penPans: true, hold: 'medium' })),
    );
    const ring = [paper.x + paper.width / 2, paper.y + paper.height / 2 + 40];
    await pen.down(ring);
    await page.locator('#book .bk-radial [role=menuitemradio]').first().waitFor({ timeout: 2000 });
    const lit = await page
      .locator('#book .bk-radial')
      .getByRole('menuitemradio', { name: 'Highlighter' })
      .boundingBox();
    await pen.move([lit.x + lit.width / 2, lit.y + lit.height / 2]);
    await c.shot('book-radial', page);
    await pen.up([lit.x + lit.width / 2, lit.y + lit.height / 2]);
    await until(async () => (await pressed(page)) === 'Highlighter', 'the highlighter picked from the ring');
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

// A desktop with a mouse and a microphone (the stand-in: shell/voice.js's recording and /api/voice's words)
async function desk(browser, c, opts) {
  const opened = await onDesk(browser, c, opts);
  await heard(opened.page);
  await opened.page.reload();
  await opened.page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
  await c.settled(opened.page, 'open');
  return opened;
}
// The iPad mini as a touch screen with a pen, in Chromium (its own touch and pen events, trusted)
async function mini(browser, c) {
  // (at 1x, so a screenshot's px are the screen's: colourIn)
  const context = await c.hqIn(browser, MINI, { hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await heard(page);
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
  await c.settled(page, 'open');
  const cdp = await context.newCDPSession(page);
  return { page, pen: penOf(cdp), touch: touchOf(cdp), errors, done: () => context.close() };
}
// The microphone's stand-in: the recording module answered with one that hears at once, and its words
export async function heard(page) {
  await page.route('**/shell/voice.js', r =>
    r.fulfill({
      contentType: 'text/javascript',
      body: `export const MAX_SECONDS = 1200, TRANSCRIBER = true, canRecord = true;
export function record({ onSegment } = {}) {
  const s = { ready: Promise.resolve(), level: () => 0.4, cancel() {} };
  setTimeout(() => onSegment?.(new Blob(['piece'], { type: 'audio/wav' })), 100);
  s.stop = async () => new Blob(['clip'], { type: 'audio/webm' });
  return s;
}`,
    }),
  );
  await page.route('**/api/voice**', r => r.fulfill({ json: { text: HEARD } }));
  await page.addInitScript(() => {
    if (navigator.mediaDevices)
      navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'mic', label: '' }];
  });
}
function penOf(cdp) {
  const send = (type, [x, y], down) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: down || type === 'mouseReleased' ? 'left' : 'none',
      buttons: down ? 1 : 0,
      clickCount: 1,
      pointerType: 'pen',
      force: down ? 0.5 : 0,
    });
  return {
    down: at => send('mousePressed', at, true),
    move: at => send('mouseMoved', at, true),
    up: at => send('mouseReleased', at, false),
    tap: async at => {
      await send('mousePressed', at, true);
      await send('mouseReleased', at, false);
    },
  };
}
// Fingers: down at points, moved to others in steps, lifted
function touchOf(cdp) {
  let last = [];
  const points = all => all.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 }));
  const t = {
    down: async at => {
      last = at;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(at) });
    },
    move: async (to, steps = 12) => {
      const from = last;
      for (let i = 1; i <= steps; i++) {
        const now = from.map(([x, y], k) => [x + ((to[k][0] - x) * i) / steps, y + ((to[k][1] - y) * i) / steps]);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(now) });
      }
      last = to;
    },
    up: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    stroke: async (from, to) => {
      await t.down(from);
      await t.move(to);
      await t.up();
    },
  };
  return t;
}
export const middleOf = b => [b.x + b.width / 2, b.y + b.height / 2];
async function stroke(page, [x0, y0], [x1, y1]) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 16, y0 + ((y1 - y0) * i) / 16);
  await page.mouse.up();
}
// Where the page is on the paper: its top-left's shift on the screen (bookview.js draws it there)
const placed = page =>
  page.evaluate(() => {
    const m = new DOMMatrix(getComputedStyle(document.querySelector('#book .bk-world')).transform);
    return [Math.round(m.e), Math.round(m.f)];
  });
const now = page => page.locator('#book .bk-now').textContent();
export const pressed = page =>
  page.evaluate(
    () => document.querySelector('#book .bk-strip [aria-pressed=true]')?.getAttribute('aria-label') ?? null,
  );
export const stored = (c, free) => c.pages.find(p => p.id === free.id);
export async function until(read, what) {
  for (const end = Date.now() + 4000; Date.now() < end; await new Promise(r => setTimeout(r, 100)))
    if (await read().catch(() => false)) return;
  throw new Error(`not ${what}`);
}
