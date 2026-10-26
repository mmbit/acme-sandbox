#!/usr/bin/env node
// An invited person's own Sketchbook, on the real coordinator through a real guest sign-in (the code by email, in test
// mode on the page): the invite gives it, with no switch, their link's page has Your Sketchbook, and there, held like
// an iPad mini (touch, 744 × 1133) and then an iPhone (390 × 844), the shelf, a new sketch drawn with a pen (its
// pressure kept), saved, labelled and sent to the CEO, which reaches the intercom as their line with its picture. The
// board, in HQ on a desktop, opens their book from its rail and draws on that sketch in its own ink, and they see it on
// their open page; a line of theirs drawn as the board draws again keeps both. A save refused for its size says so over
// the page, on the phone too, with a New sketch. (The board's part)
//   node platform/hq/sketchguest-check.mjs [--shots dir]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { harness } from '../coordinator/src/harness.ts';
import { playwright, openPage } from '../../shared/browser/browser.mjs';
import { reviewPart } from '../../shared/review/parts.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const shot = async (name, page) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

const h = await harness('sketchguest');
const { base } = h;
const { ORIGIN } = await import('../coordinator/src/config.ts');
const guests = await import('../coordinator/src/guests.ts');
const shares = await import('../coordinator/src/shares.ts');

// ---- Ines, on a share the board made, signs in at her link's door with the code it mails her
guests.invite('Ines', 'ines@example.org');
const share = shares.create({ about: 'hello', host: 'hello.preview.example.com', prefix: '/', start: '/' }, [], 3);
const door = new URL(shares.linkOf(shares.invite(share.id, 'Ines'))).pathname;
const form = (path, fields) =>
  fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
const code = (await (await form(`${door}/send`, {})).text()).match(/page from .*?: (\d{6})/)?.[1];
assert.ok(code, 'the door sends a code');
const signedIn = await form(`${door}/verify`, { code });
const cookie = signedIn.headers.get('set-cookie').split(';')[0].split('=');

const browser = await playwright().chromium.launch();
async function open(viewport) {
  const opened = await openPage(browser, { viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await opened.context.addCookies([{ name: cookie[0], value: cookie[1], url: `${base}/guest/` }]);
  // (a page's POST from 127.0.0.1 isn't HQ's ORIGIN: the same POST, sent from here with it, as the browser at HQ would)
  await opened.context.route(`${base}/guest/sketchbook/api/**`, async route => {
    const r = route.request();
    if (r.method() !== 'POST') return route.fallback();
    const res = await fetch(r.url(), {
      method: 'POST',
      headers: { ...r.headers(), origin: ORIGIN, cookie: cookie.join('=') },
      body: r.postDataBuffer(),
    });
    route.fulfill({
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: Buffer.from(await res.arrayBuffer()),
    });
  });
  return { ...opened, cdp: await opened.context.newCDPSession(opened.page) };
}
const { context, page, errors, cdp } = await open({ width: 744, height: 1133 });

// a pen, as Chromium's input reports one (pressure from the force)
async function pen(points) {
  const send = (type, [x, y], force, buttons = 1) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons,
      clickCount: 1,
      pointerType: 'pen',
      force,
    });
  await send('mousePressed', points[0], 0.2);
  for (let i = 1; i < points.length; i++) await send('mouseMoved', points[i], 0.2 + (0.7 * i) / points.length);
  await send('mouseReleased', points.at(-1), 0, 0);
}
const across = (x0, y, x1, n = 24) =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y + Math.sin(i / 3) * 4]);
// until what holds in the page, or fail saying what didn't
const until = (page, holds, what) =>
  page.waitForFunction(holds, null, { timeout: 8000, polling: 100 }).catch(() => assert.fail(`never: ${what}`));

// ---- her link's page leads to it
await page.goto(base + door);
await page.locator('a[href="/guest/sketchbook/"]').tap();
await page.waitForSelector('.sk-grid .sk-new');
assert.equal(await page.locator('h1').textContent(), 'Ines’s Sketchbook');
await shot('guest-shelf-ipad', page);

// ---- a new sketch, drawn with the pen, saved, labelled
await page.locator('[data-new]').tap();
await page.waitForSelector('dialog.sk-page[open]');
const box = await page.locator('.sk-sheet').boundingBox();
await pen(across(box.x + 80, box.y + 200, box.x + 500));
await pen(across(box.x + 80, box.y + 320, box.x + 420));
await until(page, () => document.querySelector('.sk-state')?.textContent === 'Saved', 'it saves itself');
await page.locator('.sk-label').fill('Bigger logo');
await page.locator('.sk-label').press('Enter');
await until(page, () => document.querySelector('.sk-state')?.textContent === 'Saved', 'the label saves');
const [mine] = (
  await (await fetch(`${base}/guest/sketchbook/api/list`, { headers: { cookie: cookie.join('=') } })).json()
).sketches;
assert.deepEqual([mine.label, mine.strokes], ['Bigger logo', 2]);
const ink = await (
  await fetch(`${base}/guest/sketchbook/api/ink?id=${mine.id}`, { headers: { cookie: cookie.join('=') } })
).json();
const pressures = ink.ink[0].points.map(p => p[2]);
assert.ok(pressures.at(-1) > pressures[0] + 0.3, `the pen's pressure is kept: ${pressures[0]} → ${pressures.at(-1)}`);
await shot('guest-page-ipad', page);

// ---- Send: to the CEO, as her line on the intercom with its picture
await page.locator('[data-send]').tap();
await until(page, () => /^Sent to /.test(document.querySelector('.sk-state')?.textContent ?? ''), 'sent');
const line = (await h.board('/api/chat')).body.messages.at(-1);
assert.deepEqual([line.who, line.text], ['guest', `From Ines’s Sketchbook: “Bigger logo” (sketch #${mine.id})`]);
assert.equal(line.pictures.length, 1);
await shot('guest-sent-ipad', page);

// ---- the board opens her book from its rail in HQ, on a desktop, and draws on her sketch in its own ink (Night)
const NIGHT = '#2a2352';
// (her canvas's pixels in the board's ink, not hers: Night's blue well over its red, her Ink's about level)
const nightOn = p =>
  p.evaluate(() => {
    const c = document.querySelector('.sk-sheet canvas.dry'),
      d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] < 110 && d[i + 2] - d[i] > 25) n++;
    return n;
  });
assert.equal(await nightOn(page), 0, 'only her ink so far');
const hq = await openPage(browser, { viewport: { width: 1280, height: 800 } });
const [, boardSession] = h.boardCookie.split('=');
await hq.context.addCookies([{ name: 's', value: boardSession, url: base }]);
// (HQ's POSTs from 127.0.0.1, sent on from here with HQ's ORIGIN, as for her page above)
await hq.context.route(`${base}/api/**`, async route => {
  const r = route.request();
  if (r.method() !== 'POST') return route.fallback();
  const res = await fetch(r.url(), {
    method: 'POST',
    headers: { ...r.headers(), origin: ORIGIN, cookie: h.boardCookie },
    body: r.postDataBuffer(),
  });
  route.fulfill({
    status: res.status,
    headers: Object.fromEntries(res.headers),
    body: Buffer.from(await res.arrayBuffer()),
  });
});
// (review mode's parts HQ imports, which the coordinator gives the board on HQ's own host only)
await hq.context.route(`${base}/__review/*.js`, route => {
  const part = reviewPart(new URL(route.request().url()).pathname, null);
  return part === null
    ? route.fallback()
    : route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: part });
});
await hq.page.goto(`${base}/?intro=0`);
const chip = hq.page.locator('#book .bk-person[title="Ines’s book"]');
await chip.waitFor({ timeout: 20000 });
const read = hq.page.waitForResponse(r => r.url().includes(`/api/book/page?id=${mine.id}`) && r.ok());
await chip.click();
await read;
await until(
  hq.page,
  () => /Ines’s book/.test(document.querySelector('#book .bk-when')?.textContent),
  'her book, named',
);
assert.equal(await chip.getAttribute('aria-pressed'), 'true');
await shot('board-in-her-book-desktop', hq.page);
const sheet = await hq.page.locator('#book .bk-page').first().boundingBox(),
  desk = await hq.page.locator('#book .bk-desk').boundingBox();
const top = Math.max(sheet.y, desk.y) + 120;
const saved = hq.page.waitForRequest(r => r.url().endsWith('/api/book/page/save') && r.postDataJSON().who);
await hq.page.mouse.move(sheet.x + 60, top);
await hq.page.mouse.down();
for (let i = 1; i <= 16; i++) await hq.page.mouse.move(sheet.x + 60 + i * 14, top + Math.sin(i / 2) * 10);
await hq.page.mouse.up();
const save = (await saved).postDataJSON();
assert.equal(save.ink.at(-1).color, NIGHT, "the board's own ink");
assert.ok(save.since, 'saved over the page as the board read it');
await until(
  hq.page,
  () => !document.querySelector('#book .bk-page .bk-refusal:not([hidden])'),
  'nothing refused on the page',
);
// she sees it on her open page, as soon as she looks (her tab back in front)
await new Promise(r => setTimeout(r, 1500));
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForFunction(
  () => {
    const c = document.querySelector('.sk-sheet canvas.dry'),
      d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] < 110 && d[i + 2] - d[i] > 25) return true;
    return false;
  },
  null,
  { timeout: 15000, polling: 200 },
);
const seen = await nightOn(page);
assert.ok(seen > 40, `the board's line on her page: ${seen} px`);
await shot('guest-sees-board-ipad', page);
// the board draws again as she does: her save over the page she had is refused and merged, and both lines stay
const before = await (
  await fetch(`${base}/guest/sketchbook/api/ink?id=${mine.id}`, { headers: { cookie: cookie.join('=') } })
).json();
const second = {
  color: NIGHT,
  size: 4,
  points: [
    [100, 700, 0.5, 0],
    [300, 720, 0.5, 40],
  ],
};
assert.equal(
  (
    await h.board('/api/book/page/save', {
      who: save.who,
      id: mine.id,
      ink: [...before.ink, second],
      scraps: [],
      since: before.updated,
    })
  ).status,
  200,
);
await pen(across(box.x + 80, box.y + 440, box.x + 360));
await until(page, () => document.querySelector('.sk-state')?.textContent === 'Saved', 'hers saves, merged');
const after = await (
  await fetch(`${base}/guest/sketchbook/api/ink?id=${mine.id}`, { headers: { cookie: cookie.join('=') } })
).json();
assert.equal(after.ink.length, before.ink.length + 2, 'her line and the board’s second, none lost');
assert.ok(after.ink.some(s => JSON.stringify(s.points) === JSON.stringify(second.points)));
assert.ok((await nightOn(page)) > seen, "the board's second line drawn on her page too");
assert.deepEqual(hq.errors, []);
await hq.context.close();

// ---- back on the shelf, the sketch with its picture
await page.locator('[data-back]').tap();
await page.waitForSelector('dialog.sk-page', { state: 'detached' });
await until(page, () => document.querySelector('.sk-grid .sk-open img')?.complete, 'its picture on the shelf');
assert.equal(await page.locator('.sk-grid .sk-name b').first().textContent(), 'Bigger logo');
assert.deepEqual(errors, []);
await context.close();

// ---- the phone: the shelf two across, a save refused for its size says so over the page, with a New sketch
const phone = await open({ width: 390, height: 844 });
await phone.page.goto(`${base}/guest/sketchbook/`);
await phone.page.waitForSelector('.sk-grid .sk-open');
await shot('guest-shelf-phone', phone.page);
let refusedOnce = false;
await phone.context.route(`${base}/guest/sketchbook/api/save`, route => {
  if (refusedOnce) return route.fallback();
  refusedOnce = true;
  route.fulfill({
    status: 413,
    contentType: 'application/json',
    body: JSON.stringify({
      error: 'This sketch is full: start a new sketch to keep drawing (undo the last lines to save this one)',
    }),
  });
});
await phone.page.locator('[data-open]').first().tap();
await phone.page.waitForSelector('dialog.sk-page[open]');
const small = await phone.page.locator('.sk-sheet').boundingBox();
const phonePen = async points => {
  const send = (type, [x, y], force, buttons = 1) =>
    phone.cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons,
      clickCount: 1,
      pointerType: 'pen',
      force,
    });
  await send('mousePressed', points[0], 0.3);
  for (const p of points.slice(1)) await send('mouseMoved', p, 0.6);
  await send('mouseReleased', points.at(-1), 0, 0);
};
await phonePen(across(small.x + 30, small.y + small.height / 2, small.x + small.width - 30));
await phone.page.waitForSelector('.sk-full', { timeout: 5000 });
const note = await phone.page.locator('.sk-full').boundingBox();
assert.ok(note.x >= 0 && note.x + note.width <= 390, `the note fits the phone: ${JSON.stringify(note)}`);
assert.match(await phone.page.locator('.sk-full').textContent(), /This sketch is full: start a new sketch/);
await shot('guest-full-phone', phone.page);
// (the next change takes it away and saves)
await phone.page.locator('[data-undo]').tap();
await until(phone.page, () => !document.querySelector('.sk-full'), 'undo takes the note away');
await until(phone.page, () => document.querySelector('.sk-state')?.textContent === 'Saved', 'and saves');
await phone.page.locator('[data-redo]').tap();
await until(phone.page, () => document.querySelector('.sk-state')?.textContent === 'Saved', 'redo saves too');
assert.deepEqual(phone.errors, []);
await phone.context.close();

await browser.close();
await h.stop?.();
console.log('sketchguest-check: ok');
process.exit(0);
