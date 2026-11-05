// node platform/hq/book-check.mjs --stories highlighter [--webkit]   (desktop mouse and iPad mini Pencil)
// Each draws in a new scrap opened by a tap on the blank page, its points from just left of the sheet's left edge.
import assert from 'node:assert/strict';
import { freePage, onDesk, paperBox, pick, savedWhere } from './mouse.mjs';
import { DESKTOP, MINI, openScrap, pressAlong, until } from './kit.mjs';
import { inUnit } from './notebookscreen.mjs';

export function highlightStories(c) {
  return Object.fromEntries(
    [false, true].flatMap(pencil =>
      [
        ['highlighter only adds marks over groups and typed words', addsMarks],
        ['highlighter erases along its whole length like pen ink', erasesMarks],
        ["a deleted group's ink and highlight leave the page at once, and Undo brings them back", deletesMarks],
        ['the marker lies under the ink and the words as it is drawn, as once dry: nothing changes at the lift', under],
      ].map(([name, story]) => [
        `${pencil ? 'iPad mini Pencil' : 'desktop mouse'}: ${name}`,
        browser => play(browser, c, pencil, story),
      ]),
    ),
  );
}

async function play(browser, c, pencil, story) {
  const free = freePage(c);
  const { page, errors, done } = await onDesk(browser, c, {
    viewport: pencil ? MINI : DESKTOP,
    hasTouch: pencil,
    initScript: () => {
      navigator.mediaDevices.enumerateDevices = async () => [];
    },
  });
  try {
    const desk = await paperBox(page),
      tap = pencil ? at => pressAlong(page, [at]) : ([x, y]) => page.mouse.click(x, y),
      { gid, sheet } = await openScrap(page, { tap }, undefined, [desk.x + 120, desk.y + 200]);
    assert.ok(gid, 'a new scrap opened');
    // (the stories' points, 140 to 420 across, clear of the tools island at the sheet's right)
    const paper = { x: sheet.x - 110, y: sheet.y };
    const draw = points =>
      stroke(
        page,
        points.map(([x, y]) => [paper.x + x, paper.y + y]),
        pencil,
      );
    await story(page, c, free, draw, pencil, paper);
    assert.deepEqual(
      errors.filter(error => !/No active pointer|can not be found here/.test(error)),
      [],
    );
    await c.shot(`book-highlighter-${pencil ? 'ipad' : 'desktop'}-${story.name}`, page);
  } catch (error) {
    await c.shot(`book-highlighter-${pencil ? 'ipad' : 'desktop'}-${story.name}-failed`, page);
    throw error;
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

async function addsMarks(page, c, free, draw, pencil, paper) {
  await pick(page, 'Pen');
  await draw([
    [180, 180],
    [350, 180],
  ]);
  const original = await savedWhere(c, free.id, p => p.ink.length === 1);
  await pick(page, 'Marker');
  const zigzag = Array.from({ length: 12 }, (_, i) => [i % 2 ? 140 : 400, 165 + i * 3]);
  await draw(zigzag);
  const marked = await savedWhere(c, free.id, p => p.ink.length === 2);
  assert.deepEqual(marked.ink[0], original.ink[0], 'highlighting back and forth keeps the group intact');
  await pick(page, 'Text');
  await page.mouse.click(paper.x + 150, paper.y + 300);
  await page.keyboard.type('Keep these words');
  await page.keyboard.press('Escape');
  const typed = await savedWhere(c, free.id, p => p.texts.length === 1);
  const words = await page.locator('#book .bk-typed-words').boundingBox();
  await pick(page, 'Marker');
  await draw([
    [words.x - paper.x + 3, words.y - paper.y + 12],
    [words.x - paper.x + words.width + 10, words.y - paper.y + 12],
  ]);
  const kept = await savedWhere(c, free.id, p => p.ink.length === 3);
  assert.deepEqual(kept.texts, typed.texts, 'a highlighter strike leaves every word intact');
}

async function erasesMarks(page, c, free, draw, pencil, paper) {
  await pick(page, 'Pen');
  await draw([
    [250, 180],
    [250, 280],
  ]);
  await pick(page, 'Marker');
  await draw([
    [250, 230],
    [420, 230],
    [140, 230],
  ]);
  await savedWhere(c, free.id, p => p.ink.length === 2);
  const { groups } = c.notebook.route('/api/notebooks/pages/groups', { page: free.id });
  assert.equal(groups.length, 1, 'pen and marker share a group');
  await draw(Array.from({ length: 12 }, (_, i) => [i % 2 ? 140 : 420, 175 + i * 10]));
  await page.waitForTimeout(1000);
  assert.ok(await inkInColumn(page, paper.x + 170, paper.y + 150), 'the highlighter is visible');
  await pick(page, 'Eraser');
  const erasedAt = [];
  for (const x of [170, 270, 380]) {
    await draw([
      [x, 150],
      [x, 310],
    ]);
    assert.equal(await inkInColumn(page, paper.x + x, paper.y + 150), 0, 'all ink at the eraser is gone');
    // (the store keeps a unit's ink in its own px: the eraser's column there.)
    erasedAt.push(await inUnit(page, null, paper.x + x));
    await savedWhere(c, free.id, p => p.ink.length > 0 && erasedAt.every(x => offColumn(p.ink, x)));
  }
}

// Select's bar's Delete takes the group's painted ink off at once (no wait), and Undo paints it again. (No line deletes
// anything)
async function deletesMarks(page, c, free, draw, pencil, paper) {
  await pick(page, 'Pen');
  await draw([
    [250, 180],
    [250, 280],
  ]);
  await pick(page, 'Marker');
  await draw([
    [250, 230],
    [420, 230],
    [140, 230],
  ]);
  await savedWhere(c, free.id, p => p.ink.length === 2);
  const painted = () => Promise.all([170, 250].map(x => inkInColumn(page, paper.x + x, paper.y + 150)));
  await until(async () => (await painted()).every(Boolean), 'the pen line and its highlight painted');
  await pick(page, 'Select');
  await page.mouse.click(paper.x + 250, paper.y + 200);
  await page.locator('#book .bk-sel-bar').getByRole('button', { name: 'Delete', exact: true }).click();
  assert.deepEqual(await painted(), [0, 0], "Select's bar's Delete takes the ink and highlight off at once");
  await savedWhere(c, free.id, p => p.ink.length === 0);
  // (the opened scrap's Undo, on the tools' island)
  await page.locator('#book .bk-scrap-history').getByRole('button', { name: 'Undo' }).click();
  await until(async () => (await painted()).every(Boolean), 'Undo paints them again');
  await savedWhere(c, free.id, p => p.ink.length === 2);
}

// The marker drawn across a pen's line and a box of typed words, held before its lift: what the screen shows round
// them then is what it shows once the marker is dry, the ink and the words over it both times (the Ink README, The
// book's frame). Pixels that differ by more than CLOSE in a channel are counted; a line that stays as it was changes
// at most a few soft-edge pixels, a marker over the ink and the words hundreds.
async function under(page, c, free, draw, pencil, paper) {
  await pick(page, 'Pen');
  await draw([
    [250, 140],
    [250, 260],
  ]);
  await savedWhere(c, free.id, p => p.ink.length === 1);
  await pick(page, 'Text');
  await page.mouse.click(paper.x + 150, paper.y + 300);
  await page.keyboard.type('Keep these words');
  await page.keyboard.press('Escape');
  await savedWhere(c, free.id, p => p.texts.length === 1);
  const words = await page.locator('#book .bk-typed-words').boundingBox();
  await pick(page, 'Marker');
  // (across the line, then down and back across the words)
  const across = [
      [150, 200],
      [350, 200],
      [words.x - paper.x + words.width + 10, words.y - paper.y + words.height / 2],
      [words.x - paper.x - 40, words.y - paper.y + words.height / 2],
    ].map(([x, y]) => [paper.x + x, paper.y + y]),
    clip = {
      x: Math.min(paper.x + 140, words.x - 16),
      y: paper.y + 180,
      width: Math.max(paper.x + 360, words.x + words.width + 20) - Math.min(paper.x + 140, words.x - 16),
      height: words.y + words.height + 16 - (paper.y + 180),
    };
  const lift = await held(page, across, pencil);
  await page.waitForTimeout(300);
  const wet = await page.screenshot({ clip });
  await lift();
  // (the mouse off the words, which edge their box under a resting pointer)
  if (!pencil) await page.mouse.move(paper.x + 20, paper.y + 20);
  await savedWhere(c, free.id, p => p.ink.length === 2);
  await page.waitForTimeout(300);
  const dry = await page.screenshot({ clip }),
    changed = await page.evaluate(differing, [wet.toString('base64'), dry.toString('base64'), CLOSE]);
  assert.ok(changed <= STILL, `the marker over the ink and the words changed at its lift: ${changed} px differ`);
}
// a channel's difference above it is one an eye sees, and how many such pixels a line that stays as it was may show
const CLOSE = 24,
  STILL = 12;
// A marker's line held down along points, by the mouse or the Pencil, resting at its end till the line has caught up
// with it (ink.js follows a hand a little behind): → its lift
async function held(page, points, pencil) {
  const rest = Array(8).fill(points.at(-1));
  if (pencil) {
    const { along, up } = await pressAlong(page, dense(points), { lift: false });
    await along(rest);
    return up;
  }
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(...point, { steps: 8 });
  for (const point of rest) await page.mouse.move(...point);
  return () => page.mouse.up();
}
// (in the page) How many pixels of two pictures of one box differ by more than close in a channel
async function differing([a, b, close]) {
  const pixels = async png => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob()),
      g = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    g.drawImage(bitmap, 0, 0);
    return g.getImageData(0, 0, bitmap.width, bitmap.height).data;
  };
  const [p, q] = [await pixels(a), await pixels(b)];
  let n = 0;
  for (let i = 0; i < p.length; i += 4) if (Math.max(...[0, 1, 2].map(k => Math.abs(p[i + k] - q[i + k]))) > close) n++;
  return n;
}

const offColumn = (ink, x) =>
  ink.every(stroke => stroke.points.every(point => point[0] < x) || stroke.points.every(point => point[0] > x));

async function inkInColumn(page, x, y) {
  return page.evaluate(
    ([x, y]) => {
      let ink = 0;
      for (const canvas of document.querySelectorAll('#book canvas.bk-ink')) {
        const box = canvas.getBoundingClientRect();
        if (x < box.left || x >= box.right) continue;
        const scale = canvas.width / box.width;
        for (let dy = 0; dy < 160; dy++) {
          if (y + dy < box.top || y + dy >= box.bottom) continue;
          ink += canvas.getContext('2d').getImageData((x - box.left) * scale, (y + dy - box.top) * scale, 1, 1).data[3];
        }
      }
      return ink;
    },
    [x, y],
  );
}

async function stroke(page, points, pencil) {
  if (!pencil) {
    // (as a hand moves the mouse: ink.js follows a few long jumps only part of the way)
    await page.mouse.move(...points[0]);
    await page.mouse.down();
    for (const point of dense(points).slice(1)) await page.mouse.move(...point);
    return page.mouse.up();
  }
  await pressAlong(page, dense(points));
}
// Points filled in no more than 6 px apart, as a Pencil reports them
const dense = points =>
  points.flatMap((point, i) => {
    if (!i) return [point];
    const previous = points[i - 1];
    const n = Math.max(1, Math.ceil(Math.hypot(point[0] - previous[0], point[1] - previous[1]) / 6));
    return Array.from({ length: n }, (_, j) => previous.map((v, k) => v + ((point[k] - v) * (j + 1)) / n));
  });
