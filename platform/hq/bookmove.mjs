// book-check.mjs's stories of the one way to move things on a Notebook page (shell/ink/booktools.js, bookselect.js,
// bookselectlift.js), the board's two cases on the played Notebook seeded as dev mode's (mock/notebook.json), on a
// desktop with a mouse and on an iPad mini with the Pencil:
//   - the pen draws across a scrap: the line lands on it (in the scrap's group), and the scrap stays where it was;
//   - Select pressed on one line of a group picks the whole group (its frame round all of it), and every line of it,
//     its clip with them, follows the pointer while it's held; let go, nothing jumps, and the store has every line
//     moved by the same.
import assert from 'node:assert/strict';
import { onPaper, pen, tool } from './booknotebookscreen.mjs';
import { open } from './booknotebook.mjs';
import { DESKTOP, MINI, pressAlong, until } from './bookkit.mjs';

// the seed's newest page, its wave (four lines) and its big scrap (mock/notebook.json)
const NEWEST = 3,
  WAVE = 9,
  SCRAP = 11;
// the drag, in screen px
const BY = [70, 45];

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
    points = await inSight(page, SCRAP, [
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

// A group slid into view clear of the tools, as the book shows a scrap ('book:scrap': on an iPad mini the islands and
// the pages' row cover the seed's where the book was left), and points on it (page px) on the screen once the paper's
// still and nothing's over them
async function inSight(page, id, at) {
  await page.evaluate(detail => document.dispatchEvent(new CustomEvent('book:scrap', { detail })), {
    id,
    page: NEWEST,
  });
  let was = '';
  return until(async () => {
    const points = await onPaper(page, at),
      still = JSON.stringify(points) === was;
    was = JSON.stringify(points);
    const bare = await page.evaluate(
      ps => ps.every(([x, y]) => document.elementFromPoint(x, y)?.closest('#book .bk-page')),
      points,
    );
    return still && bare && points;
  }, 'the scrap clear of the tools');
}

// ---- Select moves a group, live

async function movesAGroup(page, play, pencil, c, name) {
  const was = group(play, WAVE);
  await tool(page, 'Select');
  // pressed on the wave's first line only
  const [from] = await inSight(page, WAVE, [was.ink[0].points[1].slice(0, 2)]),
    k = await scaleOf(page),
    clip = () => rectOf(page, `#book .bk-clip[data-g="${WAVE}"]`),
    clipWas = await clip();
  const held = await press(page, from, pencil);
  try {
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const at = [from[0] + (BY[0] * i) / steps, from[1] + (BY[1] * i) / steps];
      await held.move(at);
      // every frame: the clip with the pointer, as far as it's come
      const now = await clip();
      assert.ok(
        near([now.x - clipWas.x, now.y - clipWas.y], [at[0] - from[0], at[1] - from[1]], 2),
        `the group's clip follows the pointer live (step ${i}: ${Math.round(now.x - clipWas.x)}, ${Math.round(now.y - clipWas.y)})`,
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
  await landed(page, play, { was, k, clip, clipHeld: await clip() });
  await c.shot(`move-${name}-group-moved`, page);
}
// Let go: the store has every line moved by the same, and the clip where it was let go (no jump)
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
    `the clip stays where it was let go (${Math.round(clipNow.x - clipHeld.x)}, ${Math.round(clipNow.y - clipHeld.y)})`,
  );
}

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
