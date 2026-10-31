// book-check.mjs's stories of the one way to move things on a Notebook page (shell/ink/booktools.js, bookselect.js,
// bookselectlift.js), the board's two cases on the played Notebook seeded as dev mode's (mock/notebook.json), on a
// desktop with a mouse and on an iPad mini with the Pencil:
//   - the pen draws across a scrap: the line lands on it (in the scrap's group), and the scrap stays where it was;
//   - Select pressed on one line of a group picks the whole group (its frame round all of it), and every line of it,
//     its frame with them, follows the pointer while it's held; let go, nothing jumps, and the store has every line
//     moved by the same (in its unit's own px, the unit where the masonry put it), and every line shows on the page
//     where it landed, past its unit's edge too.
import assert from 'node:assert/strict';
import { inSight, onPaper, pen, tool } from './booknotebookscreen.mjs';
import { open } from './booknotebook.mjs';
import { DESKTOP, MINI, pixelsIn, pressAlong, until } from './bookkit.mjs';

// the seed's newest page, its wave (four lines) and its big scrap (mock/notebook.json)
const NEWEST = 3,
  WAVE = 9,
  SCRAP = 11;
// the drag, in screen px: to the left, past the left edge of the wave's unit
const BY = [-45, 0];

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function moveStories(c) {
  return {
    'one way to move, on a desktop: the pen draws across a scrap, Select moves a group as one, live': browser =>
      onDevice(browser, c, DESKTOP, false),
    'one way to move, on an iPad mini: the Pencil draws across a scrap, Select moves a group as one, live': browser =>
      onDevice(browser, c, MINI, true),
  };
}

async function onDevice(browser, c, viewport, pencil) {
  const { page, play, errors, done } = await open(browser, c, viewport, {
    hasTouch: pencil,
    ...(pencil ? {} : { deviceScaleFactor: 1 }),
  });
  const name = pencil ? 'mini' : 'desktop';
  try {
    await drawsOnAScrap(page, play, pencil);
    await c.shot(`move-${name}-pen-on-scrap`, page);
    await movesAGroup(page, play, pencil, c, name);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// ---- the pen on a scrap

async function drawsOnAScrap(page, play, pencil) {
  const was = group(play, SCRAP),
    ink = was.ink.length;
  await tool(page, 'Pen');
  // (across the scrap's top, starting and ending on it)
  const s = was.pictures[0],
    points = await inSight(page, NEWEST, SCRAP, [
      [s.x + 30, s.y + 16],
      [s.x + s.w / 2, s.y + 30],
      [s.x + s.w - 30, s.y + 22],
    ]);
  await pen(page, points, pencil ? null : page.mouse);
  const now = await until(() => {
    const g = group(play, SCRAP);
    return g.ink.length > ink && g;
  }, 'the line saved on the scrap, in its group');
  assert.deepEqual(pick(now.pictures[0]), pick(s), 'the scrap stays where it was: the pen draws on it, never moves it');
  assert.equal(await page.locator('#book .bk-sel').count(), 0, 'nothing picked by the pen');
}

// ---- Select moves a group, live

async function movesAGroup(page, play, pencil, c, name) {
  const was = group(play, WAVE);
  await tool(page, 'Select');
  // pressed on the wave's first line only
  const [from] = await inSight(page, NEWEST, WAVE, [was.ink[0].points[1].slice(0, 2)]),
    k = await scaleOf(page),
    // (the group's frame: on the units page its lines move inside their unit, which stays in its place.)
    clip = () => rectOf(page, '#book .bk-sel');
  const held = await press(page, from, pencil);
  try {
    await until(clip, 'the group picked');
    const clipWas = await clip();
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const at = [from[0] + (BY[0] * i) / steps, from[1] + (BY[1] * i) / steps];
      await held.move(at);
      // every frame: the group's frame with the pointer, as far as it's come
      const now = await clip();
      assert.ok(
        near([now.x - clipWas.x, now.y - clipWas.y], [at[0] - from[0], at[1] - from[1]], 2),
        `the group's frame follows the pointer live (step ${i}: ${Math.round(now.x - clipWas.x)}, ${Math.round(now.y - clipWas.y)})`,
      );
    }
    // the whole group picked: its frame round every line of it, lifted together
    const frame = await page.locator('#book .bk-sel').boundingBox(),
      box = boxOf(was.ink);
    assert.ok(
      frame.width >= (box.x1 - box.x0) * k - 2 && frame.height >= (box.y1 - box.y0) * k - 2,
      `the frame holds the whole group (${Math.round(frame.width)} × ${Math.round(frame.height)})`,
    );
    assert.equal(await page.locator('#book canvas.bk-sel-lifted').count(), 1, 'its lines lifted together');
    await c.shot(`move-${name}-group-held`, page);
  } finally {
    await held.up();
  }
  const moved = await landed(page, play, { was, k, clip, clipHeld: await clip() });
  await shows(page, moved);
  await c.shot(`move-${name}-group-moved`, page);
}
// Let go: the store has every line moved by the same, and the frame where it was let go (no jump)
async function landed(page, play, { was, k, clip, clipHeld }) {
  const dx = BY[0] / k,
    dy = BY[1] / k;
  const moved = await until(() => {
    const g = group(play, WAVE);
    return !near(g.ink[0].points[0], was.ink[0].points[0], 0.01) && g;
  }, 'the group saved where it was let go');
  for (const [i, s] of moved.ink.entries())
    assert.ok(
      near(s.points[0], [was.ink[i].points[0][0] + dx, was.ink[i].points[0][1] + dy], 1.5),
      `line ${i + 1} of the group moved with it`,
    );
  await page.waitForTimeout(400);
  const clipNow = await clip();
  assert.ok(
    near([clipNow.x, clipNow.y], [clipHeld.x, clipHeld.y], 2),
    `the frame stays where it was let go (${Math.round(clipNow.x - clipHeld.x)}, ${Math.round(clipNow.y - clipHeld.y)})`,
  );
  return moved;
}
// Let go, every line of the group shows on the page where it landed, past its unit's edge too (the unit's canvas
// reaches its ink wherever it goes: bookpage.js): read on the screen once the lifted canvas is gone and nothing is
// picked over them.
async function shows(page, moved) {
  await until(async () => !(await page.locator('#book canvas.bk-sel-lifted').count()), 'the lifted canvas gone');
  await tool(page, 'Pen');
  await until(async () => !(await page.locator('#book .bk-sel').count()), 'nothing picked over the lines');
  const lines = await Promise.all(moved.ink.map(s => onPaper(page, s.points, WAVE))),
    box = boxOf(lines.map(points => ({ points }))),
    unit = await page.locator(`#book .bk-page:not([hidden]) .bk-unit[data-unit="${WAVE}"]`).boundingBox();
  assert.ok(
    box.y0 < unit.y || box.x0 < unit.x || box.x1 > unit.x + unit.width,
    `the lines moved past their unit's edge (lines ${frameWords(box)}, unit ${frameWords(unitBox(unit))})`,
  );
  const paper = await page.locator('#book .bk-page:not([hidden])').boundingBox();
  assert.ok(
    box.x0 > paper.x && box.x1 < paper.x + paper.width && box.y0 > Math.max(0, paper.y),
    `the lines landed on the paper in sight (${frameWords(box)})`,
  );
  const ink = await inkIn(page, box);
  for (const [i, points] of lines.entries()) {
    const seen = points.filter(([x, y]) => ink(x, y)).length / points.length;
    assert.ok(seen > 0.9, `line ${i + 1} shows where it landed (${Math.round(seen * 100)}% of its points)`);
  }
}
// Whether the board's ink (#2a2352, dark on the paper) is on the screen within 2 px of a point, in a box of it
async function inkIn(page, box) {
  const clip = { x: Math.floor(box.x0) - 4, y: Math.floor(box.y0) - 4 },
    width = Math.ceil(box.x1) + 4 - clip.x,
    height = Math.ceil(box.y1) + 4 - clip.y,
    pixels = await pixelsIn(page, { ...clip, width, height }),
    // (the screenshot's px for a CSS px)
    k = Math.round(Math.sqrt(pixels.length / (width * height))),
    dark = (x, y) => pixels[y * width * k + x].reduce((a, b) => a + b) < 360;
  return (x, y) => {
    for (let dy = -2 * k; dy <= 2 * k; dy++)
      for (let dx = -2 * k; dx <= 2 * k; dx++)
        if (dark(Math.round((x - clip.x) * k) + dx, Math.round((y - clip.y) * k) + dy)) return true;
    return false;
  };
}
const unitBox = ({ x, y, width, height }) => ({ x0: x, y0: y, x1: x + width, y1: y + height });
const frameWords = b => [b.x0, b.y0, b.x1, b.y1].map(Math.round).join(', ');

// ---- the pointer

// A press held at a point (the mouse's, or the Pencil's as Safari sends it), moved and let go step by step
async function press(page, at, pencil) {
  if (!pencil) {
    await page.mouse.move(...at);
    await page.mouse.down();
    return {
      move: to => page.mouse.move(...to, { steps: 2 }),
      up: () => page.mouse.up(),
    };
  }
  const held = await pressAlong(page, [at], { lift: false });
  return { move: to => held.along([to]), up: held.up };
}

// ---- reading

const group = (play, id) => play.route('/api/notebooks/pages/groups', { page: NEWEST }).groups.find(g => g.id === id);
const pick = ({ x, y, w, h, tilt }) => ({ x, y, w, h, tilt });
const near = ([x, y], [x1, y1], px) => Math.abs(x - x1) <= px && Math.abs(y - y1) <= px;
function boxOf(ink) {
  const xs = ink.flatMap(s => s.points.map(p => p[0])),
    ys = ink.flatMap(s => s.points.map(p => p[1]));
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
// Where an element is on the screen ({ x, y }), as it's drawn this frame
const rectOf = (page, selector) =>
  page.evaluate(selector => {
    const r = document.querySelector(selector)?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y } : null;
  }, selector);
// The page's px on the screen
const scaleOf = page =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden);
    return shown.getBoundingClientRect().width / shown.offsetWidth;
  });
