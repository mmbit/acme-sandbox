#!/usr/bin/env node
// HQ-OS › Sketchbook held like an iPad mini (touch, 744 × 1133), on HQ's mock sketches: the sketches and the archive, a
// new sketch drawn with a pen (its pressure kept), a resting palm drawing nothing once the pen has, undo and redo, the
// eraser taking a whole line (one undo puts it back), a label typed on the page, the page saved and shown on the
// computer, rename, archive and delete from a sketch's menu, and Send to the CEO (refused on an empty page). Pictures on
// the page: pasted, moved, pinched, resized, taken off and undone, pasted from a held press, dropped, saved and
// on the sketch's picture. Then a sketch opened in each look, for the eye, a picture from review mode landing on it.
// An invited person's book on a shelf of their name, its sketch looked at closer.
//   node platform/hq/sketchbook-check.mjs [--shots dir]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const shot = async (name, page) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const browser = await playwright().chromium.launch();

async function open(look = 'brownstone') {
  const opened = await openPage(browser, { viewport: { width: 744, height: 1133 }, hasTouch: true, isMobile: true });
  await opened.page.goto(`${base}/?intro=0&renderer=${look}`);
  await until(opened.page, '#loading.gone');
  await opened.page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('sketchbook')));
  await opened.page.waitForSelector('.sk-grid .sk-open');
  return { ...opened, cdp: await opened.context.newCDPSession(opened.page) };
}
const { context, page, errors, cdp } = await open();

// a pen, as Chromium's input reports one (pressure from the force), or a finger
async function pen(points, type = 'pen') {
  const send = (kind, [x, y], force, buttons = 1) =>
    cdp.send('Input.dispatchMouseEvent', {
      type: kind,
      x,
      y,
      button: 'left',
      buttons,
      clickCount: 1,
      pointerType: type,
      force,
    });
  await send('mousePressed', points[0], 0.2);
  for (let i = 1; i < points.length; i++) await send('mouseMoved', points[i], 0.2 + (0.7 * i) / points.length);
  await send('mouseReleased', points.at(-1), 0, 0);
}
async function finger(points) {
  const touch = (type, [x, y]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', points[0]);
  for (const p of points.slice(1)) await touch('touchMove', p);
  await touch('touchEnd', points.at(-1));
  await page.waitForTimeout(1200); // (Chromium's fling after a scripted swipe takes the next tap)
}
const across = (x0, y, x1, n = 24) =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y + Math.sin(i / 3) * 4]);
const sheetBox = () => page.locator('.sk-sheet').boundingBox();
// the dry canvas's most inked pixel within 8 px above or below a point on screen (the lines wave a little)
const inkAt = (x, y) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.sk-sheet canvas.dry'),
        r = c.getBoundingClientRect(),
        k = c.width / r.width,
        reach = Math.round(8 * k);
      const d = c
        .getContext('2d')
        .getImageData(Math.round((x - r.left) * k), Math.round((y - r.top) * k) - reach, 1, 2 * reach + 1).data;
      let best = [0, 0, 0, 0];
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > best[3]) best = [...d.slice(i, i + 4)];
      return best;
    },
    [x, y],
  );
const lines = () =>
  page.evaluate(() => import('/shell/sketchdata.js').then(m => m.loadSketches(true)).then(r => r.sketches));
const sketchOf = id => page.evaluate(id => import('/shell/sketchdata.js').then(m => m.loadSketch(true, id)), id);
const names = () => page.$$eval('.sk-grid .sk-name b', bs => bs.map(b => b.textContent));

// ---- the sketches and the archive
assert.deepEqual(await names(), ['Untitled', 'Shop header, bigger button', 'A cat at the door'], 'newest change first');
assert.equal(await page.locator('.sk-new').count(), 1, 'a new sketch first of all');
assert.match(await page.textContent('[data-shelf=archive]'), /Archive · 1/);
await shot('sketchbook-ipad', page);
await page.locator('[data-shelf=archive]').tap();
assert.deepEqual(await names(), ['Old layout']);
await page.locator('[data-shelf=sketches]').tap();
// ---- an invited person's own book, the board's to look at: a shelf of their name, a tap looks closer.
await page.locator('[data-shelf="guest:0"]').tap();
assert.equal(await page.textContent('[data-shelf="guest:0"]'), 'Ines');
assert.deepEqual(await names(), ['Bigger logo, please']);
assert.equal(await page.locator('.sk-new, .sk-dots').count(), 0, 'no New sketch and no menu on theirs');
await page.locator('[data-look]').tap();
await page.waitForSelector('dialog.zoom[open]');
await shot('sketchbook-theirs-ipad', page);
await page.locator('.zoom-close').tap();
await page.waitForSelector('dialog.zoom', { state: 'detached' });
await page.locator('[data-shelf=sketches]').tap();

// ---- a new sketch: the pen draws, with its pressure
await page.locator('[data-new]').tap();
await page.waitForSelector('dialog.sk-page[open]');
let box = await sheetBox();
assert.ok(box.width > 600 && box.height > 700, `the page takes the screen: ${box.width} × ${box.height}`);
// every tool whole in the tray and there to tap, with an ink's tool in hand and with the eraser (its inks hidden)
const toolsShown = () =>
  page.$$eval('.sk-tool', tools =>
    tools.map(t => {
      const r = t.getBoundingClientRect(),
        tray = t.closest('.sk-tools').getBoundingClientRect(),
        // (the tool's lower half: its upper half is the drawing standing up out of the tray)
        hit = document.elementFromPoint(r.left + r.width / 2, r.bottom - 8);
      return [t.dataset.tool, r.left >= tray.left - 0.5 && r.right <= tray.right + 0.5 && !!hit && t.contains(hit)];
    }),
  );
const whole = Object.keys({ pen: 1, marker: 1, highlighter: 1, eraser: 1 }).map(tool => [tool, true]);
assert.deepEqual(await toolsShown(), whole, 'every tool whole in the tray at 744 px');
const trayWidth = () => page.locator('.sk-tray').evaluate(t => t.getBoundingClientRect().width);
const inksWidth = await trayWidth();
await page.locator('[data-tool=eraser]').tap();
assert.deepEqual(await toolsShown(), whole, 'and with the eraser in hand');
assert.equal(await trayWidth(), inksWidth, 'the tray keeps its size as the inks hide');
await page.locator('[data-tool=pen]').tap();
const y1 = box.y + 200;
await pen(across(box.x + 80, y1, box.x + 500));
assert.ok((await inkAt(box.x + 290, y1))[3] > 0, 'the pen draws');
// a palm resting on the glass draws nothing once the pen has
await finger(across(box.x + 80, box.y + 500, box.x + 500, 10));
assert.equal((await inkAt(box.x + 290, box.y + 500))[3], 0, 'a palm draws nothing');
// another tool and ink from the tray
await page.locator('[data-tool=marker]').tap();
await page.locator('[data-colour="#ff5a5f"]').tap();
await pen(across(box.x + 80, box.y + 320, box.x + 500));
const red = await inkAt(box.x + 290, box.y + 320);
assert.ok(red[0] > 200 && red[1] < 140, `the marker draws red: ${red}`);
await until(page, '.sk-state', /Saved/, 5000);
const id = (await lines())[0].id;
let saved = await sketchOf(id);
assert.equal(saved.ink.length, 2, 'both lines saved');
const pressures = saved.ink[0].points.map(p => p[2]);
assert.ok(Math.max(...pressures) - Math.min(...pressures) > 0.3, 'the pen’s pressure is kept');
assert.equal(saved.ink[1].color, '#ff5a5f');
assert.match(saved.picture, /^data:image\/png/, 'the page goes with its picture');

// ---- undo, redo and the eraser
await page.locator('[data-undo]').tap();
assert.equal((await inkAt(box.x + 290, box.y + 320))[3], 0, 'undo takes the last line back');
await page.keyboard.press('Control+Shift+z');
assert.ok((await inkAt(box.x + 290, box.y + 320))[3] > 0, 'redo puts it back');
await page.locator('[data-tool=eraser]').tap();
assert.ok(await page.locator('.sk-colours').isHidden(), 'the eraser has no inks');
await pen([
  [box.x + 300, y1 - 40],
  [box.x + 300, y1 + 40],
]);
assert.equal((await inkAt(box.x + 120, y1))[3], 0, 'the eraser takes the whole line it touches');
assert.ok((await inkAt(box.x + 290, box.y + 320))[3] > 0, 'and only that one');
await page.locator('[data-undo]').tap();
assert.ok((await inkAt(box.x + 120, y1))[3] > 0, 'one undo puts the rubbed line back');
await page.locator('[data-tool=pen]').tap();

// ---- pictures on the page: pasted, moved by a finger, pinched, resized by the corner, taken off and put back, held on
// the paper for Paste, dropped, and drawn over.
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
const copyPicture = colour =>
  page.evaluate(async colour => {
    const c = new OffscreenCanvas(240, 160),
      g = c.getContext('2d');
    g.fillStyle = colour;
    g.fillRect(0, 0, 240, 160);
    const blob = await c.convertToBlob({ type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, colour);
const scrapBoxes = () =>
  page.$$eval('.sk-scrap:not(.busy)', els =>
    els.map(e => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: e.offsetWidth, h: e.offsetHeight };
    }),
  );
const scrapsNow = async n => {
  await page.waitForFunction(n => document.querySelectorAll('.sk-scrap:not(.busy)').length === n, n, { timeout: 5000 });
  return scrapBoxes();
};
await copyPicture('#14a3a0');
await page.keyboard.press('Control+v');
let [scrap] = await scrapsNow(1);
assert.ok(
  Math.abs(scrap.x - (box.x + box.width / 2)) < 2 && Math.abs(scrap.y - (box.y + box.height / 2)) < 2,
  'Ctrl+V puts the picture in the page’s middle',
);
assert.ok(await page.locator('.sk-picked').isVisible(), 'picked, with its handles');
// once a pen has drawn, a finger moves it at once
await finger(across(scrap.x, scrap.y, scrap.x + 120, 24).map(([x], i) => [x, scrap.y + i * 4]));
let [moved] = await scrapBoxes();
assert.ok(Math.abs(moved.x - scrap.x - 120) < 3 && Math.abs(moved.y - scrap.y - 96) < 3, 'a finger moves it');
// two fingers pinch it to twice its size
const pinch = async (c, from, to) => {
  const at = d => [
    { x: c.x - d, y: c.y, id: 0 },
    { x: c.x + d, y: c.y, id: 1 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) });
  for (let i = 1; i <= 8; i++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from + ((to - from) * i) / 8) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(1200);
};
await pinch(moved, 30, 60);
let [pinched] = await scrapBoxes();
assert.ok(Math.abs(pinched.w / moved.w - 2) < 0.1, `two fingers pinch it bigger (${moved.w} → ${pinched.w})`);
// the corner's grip makes it smaller again
const grip = await page.locator('.sk-grip').boundingBox();
await finger([
  [grip.x + 15, grip.y + 15],
  [grip.x + 15 - (pinched.w / 2) * 0.5, grip.y + 15 - (pinched.h / 2) * 0.5],
]);
let [sized] = await scrapBoxes();
assert.ok(sized.w < pinched.w * 0.7, `its corner resizes it (${pinched.w} → ${sized.w})`);
// the pen draws over it, under nothing
await page.locator('[data-tool=pen]').tap();
await pen(across(sized.x - 60, sized.y, sized.x + 60));
assert.ok((await inkAt(sized.x, sized.y))[3] > 0, 'the pen draws over the picture');
await page.locator('[data-undo]').tap();
// its × takes it off, and undo puts it back where it was
await page.locator('.sk-unpin').tap();
await scrapsNow(0);
await page.locator('[data-undo]').tap();
[scrap] = await scrapsNow(1);
assert.ok(Math.abs(scrap.x - sized.x) < 2 && scrap.w === sized.w, 'undo puts it back as it was');
for (let i = 0; i < 2; i++) await page.locator('[data-undo]').tap();
[scrap] = await scrapBoxes();
assert.ok(Math.abs(scrap.x - moved.x) < 2 && scrap.w === moved.w, 'and each move is its own step');
await page.keyboard.press('Control+Shift+z');
await page.keyboard.press('Control+Shift+z');
// a finger held still on the bare paper offers Paste, which reads the clipboard there
await copyPicture('#7a4fd8');
const paper = [box.x + 120, box.y + box.height - 120];
await finger([paper]); // (a tap on the paper puts the handles away first)
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: paper[0], y: paper[1] }] });
await page.waitForTimeout(700);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.locator('.sk-callout').tap();
await scrapsNow(2);
// a picture file dropped on the page lands where it's dropped
const dropAt = [box.x + box.width - 160, box.y + 140];
const files = await page.evaluateHandle(async () => {
  const c = new OffscreenCanvas(200, 200),
    g = c.getContext('2d');
  g.fillStyle = '#ff8c2e';
  g.fillRect(0, 0, 200, 200);
  const t = new DataTransfer();
  t.items.add(new File([await c.convertToBlob({ type: 'image/png' })], 'orange.png', { type: 'image/png' }));
  return t;
});
await page
  .locator('.sk-sheet')
  .dispatchEvent('drop', { dataTransfer: files, clientX: dropAt[0], clientY: dropAt[1], bubbles: true });
const dropped = (await scrapsNow(3)).at(-1);
assert.ok(Math.hypot(dropped.x - dropAt[0], dropped.y - dropAt[1]) < 3, 'a dropped picture lands where it’s dropped');
await page.keyboard.press('Delete');
await scrapsNow(2);
await until(page, '.sk-state', /Saved/, 5000);
saved = await sketchOf(id);
assert.equal(saved.scraps.length, 2, 'the pictures are saved with the sketch');
const tealOnPicture = await page.evaluate(
  async ([url, s]) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
      g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const k = img.width / s.w,
      f = saved => saved.find(p => p.file);
    const p = f(s.scraps);
    return [...g.getImageData(Math.round((p.x + p.w / 2) * k), Math.round((p.y + p.h / 2) * k), 1, 1).data];
  },
  [saved.picture, saved],
);
assert.deepEqual(tealOnPicture.slice(0, 3), [0x14, 0xa3, 0xa0], 'and drawn on its picture, under the ink');
await shot('sketch-pictures-ipad', page);

// ---- a label, then back to the computer, where it shows first
await page.locator('.sk-label').fill('Kitchen counter idea');
await page.locator('.sk-label').press('Enter');
await until(page, '.sk-state', /Saved/, 5000);
await shot('sketch-page-ipad', page);
await page.locator('[data-back]').tap();
await page.waitForSelector('dialog.sk-page', { state: 'detached' });
await until(page, '.sk-grid', /Kitchen counter idea/, 5000);
assert.equal((await names())[0], 'Kitchen counter idea');
assert.ok(await page.locator('.sk-grid .sk-card:nth-child(2) img').count(), 'with its picture');
saved = await sketchOf(id);
assert.equal(saved.ink.length, 2, 'the undone rub is saved too');
assert.equal(saved.scraps.length, 2, 'and the pictures');

// ---- rename, archive and delete from a sketch's menu
const menuOf = async (name, item) => {
  await page.locator('.sk-card', { hasText: name }).locator('[data-menu]').tap();
  await page.locator(`.sk-menu [data-${item}]`).tap();
};
await menuOf('A cat at the door', 'relabel');
await page.locator('.sk-rename').fill('The cat, at the door');
await page.locator('.sk-rename').press('Enter');
await until(page, '.sk-grid', /The cat, at the door/, 5000);
await menuOf('The cat, at the door', 'archive');
await until(page, '[data-shelf=archive]', /Archive · 2/, 5000);
assert.ok(!(await names()).includes('The cat, at the door'), 'archived: off the sketches');
await menuOf('Untitled', 'delete');
assert.match(await page.textContent('.sk-menu [data-delete]'), /for good/, 'the first press asks');
await page.locator('.sk-menu [data-delete]').tap();
await until(page, '.sk-grid', /^(?!.*Untitled)/s, 5000);
assert.ok(!(await lines()).some(s => s.label === ''), 'deleted for good');

// ---- Send to the CEO: an empty page is refused, a drawn one goes
await page.locator('[data-new]').tap();
await page.waitForSelector('dialog.sk-page[open]');
await page.locator('[data-send]').tap();
await until(page, '.sk-state.warn', /Draw something first/, 5000);
await page.locator('[data-back]').tap();
await page.waitForSelector('dialog.sk-page', { state: 'detached' });
await page.locator(`.sk-card:has-text("Kitchen counter idea") [data-open]`).tap();
await page.waitForSelector('dialog.sk-page[open]');
await page.locator('[data-send]').tap();
await until(page, '.toast', /Sent to .+ on the intercom/, 5000);
assert.ok((await sketchOf(id)).sent, 'sent');
await page.waitForTimeout(900);
assert.equal(await page.locator('.sk-flying').count(), 0, 'the paper plane has flown');
assert.deepEqual(errors, []);
await context.close();

// ---- each look, for the eye
for (const look of ['brownstone', 'wire', 'holo']) {
  const opened = await open(look);
  await shot(`sketchbook-${look}`, opened.page);
  await opened.page.locator('.sk-card:has-text("Shop header") [data-open]').tap();
  await opened.page.waitForSelector('dialog.sk-page[open]');
  // (a picture from review mode waits on it, and lands as it opens)
  await opened.page.waitForSelector('.sk-scrap.landing', { state: 'detached' });
  await opened.page.waitForTimeout(400);
  assert.equal(await opened.page.locator('.sk-scrap').count(), 1, `${look}: the picture from review mode lands on it`);
  await shot(`sketch-${look}`, opened.page);
  assert.deepEqual(opened.errors, [], `${look}: no errors`);
  await opened.context.close();
}
await browser.close();
server.close();
console.log('sketchbook-check: ok');
