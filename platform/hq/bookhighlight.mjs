// node platform/hq/book-check.mjs --stories highlighter [--webkit]   (desktop mouse and iPad mini Pencil)
import assert from 'node:assert/strict';
import { freePage, paperBox, pick, savedWhere } from './bookmouse.mjs';

const MINI = { width: 1133, height: 744 };

export function highlightStories(c) {
  return Object.fromEntries(
    [false, true].flatMap(pencil =>
      [
        ['highlighter only adds marks over groups and typed words', addsMarks],
        ['highlighter erases along its whole length like pen ink', erasesMarks],
      ].map(([name, story]) => [
        `${pencil ? 'iPad mini Pencil' : 'desktop mouse'}: ${name}`,
        browser => play(browser, c, pencil, story),
      ]),
    ),
  );
}

async function play(browser, c, pencil, story) {
  const free = freePage(c);
  const context = await c.hqIn(browser, pencil ? MINI : { width: 1440, height: 900 }, {
    hasTouch: pencil,
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => {
    navigator.mediaDevices.enumerateDevices = async () => [];
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#book .bk-desk');
  await c.settled(page, 'open');
  try {
    const box = await paperBox(page);
    const draw = points =>
      stroke(
        page,
        points.map(([x, y]) => [box.x + x, box.y + y]),
        pencil,
      );
    await story(page, c, free, draw);
    assert.deepEqual(
      errors.filter(error => !/No active pointer|can not be found here/.test(error)),
      [],
    );
    await c.shot(`book-highlighter-${pencil ? 'ipad' : 'desktop'}-${story.name}`, page);
  } catch (error) {
    await c.shot(`book-highlighter-${pencil ? 'ipad' : 'desktop'}-${story.name}-failed`, page);
    throw error;
  } finally {
    await context.close();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

async function addsMarks(page, c, free, draw) {
  await pick(page, 'Pen');
  await draw([
    [180, 180],
    [350, 180],
  ]);
  const original = await savedWhere(c, free.id, p => p.ink.length === 1);
  await pick(page, 'Highlighter');
  const zigzag = Array.from({ length: 12 }, (_, i) => [i % 2 ? 140 : 400, 165 + i * 3]);
  await draw(zigzag);
  const marked = await savedWhere(c, free.id, p => p.ink.length === 2);
  assert.deepEqual(marked.ink[0], original.ink[0], 'highlighting back and forth keeps the group intact');
  await pick(page, 'Type');
  const paper = await paperBox(page);
  await page.mouse.click(paper.x + 120, paper.y + 300);
  await page.keyboard.type('Keep these words');
  await page.keyboard.press('Escape');
  const typed = await savedWhere(c, free.id, p => p.texts.length === 1);
  const words = await page.locator('#book .bk-typed-words').boundingBox();
  await pick(page, 'Highlighter');
  await draw([
    [words.x - paper.x + 3, words.y - paper.y + 12],
    [words.x - paper.x + words.width + 10, words.y - paper.y + 12],
  ]);
  const kept = await savedWhere(c, free.id, p => p.ink.length === 3);
  assert.deepEqual(kept.texts, typed.texts, 'a highlighter strike leaves every word intact');
}

async function erasesMarks(page, c, free, draw) {
  await pick(page, 'Pen');
  await draw([
    [250, 180],
    [250, 280],
  ]);
  await pick(page, 'Highlighter');
  await draw([
    [250, 230],
    [420, 230],
    [140, 230],
  ]);
  await savedWhere(c, free.id, p => p.ink.length === 2);
  assert.equal(
    c.notebook.route('/api/notebooks/pages/groups', { page: free.id }).groups.length,
    1,
    'pen and marker share a group',
  );
  await draw(Array.from({ length: 12 }, (_, i) => [i % 2 ? 140 : 420, 175 + i * 10]));
  await page.waitForTimeout(1000);
  const paper = await paperBox(page);
  assert.ok(await inkInColumn(page, paper.x + 170, paper.y + 150), 'the highlighter is visible');
  await pick(page, 'Eraser');
  const erasedAt = [];
  for (const x of [170, 270, 380]) {
    await draw([
      [x, 150],
      [x, 310],
    ]);
    assert.equal(await inkInColumn(page, paper.x + x, paper.y + 150), 0, 'all ink at the eraser is gone');
    erasedAt.push(x);
    await savedWhere(c, free.id, p => p.ink.length > 0 && erasedAt.every(x => offColumn(p.ink, x)));
  }
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
  const dense = points.flatMap((point, i) => {
    if (!i) return [point];
    const previous = points[i - 1];
    const n = Math.max(1, Math.ceil(Math.hypot(point[0] - previous[0], point[1] - previous[1]) / 6));
    return Array.from({ length: n }, (_, j) => previous.map((v, k) => v + ((point[k] - v) * (j + 1)) / n));
  });
  if (!pencil) {
    await page.mouse.move(...points[0]);
    await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(...point, { steps: 2 });
    return page.mouse.up();
  }
  await page.evaluate(points => {
    const send = (type, [clientX, clientY]) =>
      document.elementFromPoint(clientX, clientY).dispatchEvent(
        new PointerEvent(type, {
          pointerId: 7,
          pointerType: 'pen',
          isPrimary: true,
          clientX,
          clientY,
          pressure: type === 'pointerup' ? 0 : 0.5,
          buttons: type === 'pointerup' ? 0 : 1,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
    send('pointerdown', points[0]);
    points.slice(1).forEach(point => send('pointermove', point));
    send('pointerup', points.at(-1));
  }, dense);
}
