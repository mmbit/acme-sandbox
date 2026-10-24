#!/usr/bin/env node
// HQ-OS › Photos (the photo studio) in a real browser, on a phone and a tablet: the desk phone's line opening it on
// Approvals, its three tabs (Approvals first) and the count of what waits, one photo big (it flips to the original, and a
// tap shows it full size, a pinch or the wheel zooming it and a drag panning it) with the pages it goes on as links (or
// the words for where), what it should show and what to check, Accept and Reject with a comment (a box that grows, and
// Reject lit once there's one) and the next one following, the Queue's shots in progress to read only (each with the page it's for),
// History found by product and by a page's pasted address, one opened big and back, and "This should change" (its note
// required). Nothing runs off the screen, the photo big stays in its frame, and Accept and Reject show without
// scrolling (a tablet on its side and a desktop too).
//   node platform/hq/studio-check.mjs        (screenshots go to a temp folder, printed at the end)
// Part one runs HQ in dev mode on mock/studio.json (mock/brand.json says the company runs the studio); part two on a
// fake /api (not dev mode), for what only the real routes show: what each tap sends (each photo with the edit shown),
// the picture addresses, a typed comment kept across a live update and a refusal in the coordinator's own words, text
// staying text (a page that isn't an address too), the line when the image model's key isn't in, and a fresh opening
// on Approvals with nothing waiting. Part three: Wire's light look, where a photo's brief and the questions must stand
// out from its light panel.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, ROOT } from './serve.mjs';
import { contrastChannels } from '../../shared/contrast/contrast.js';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const XSS = '<img src=x onerror=alert(1)>';
const shots = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'studio-check-'));
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const browser = await playwright().chromium.launch();
const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 } };
const started = Date.now();

async function open(viewport, api, site = base) {
  const opened = await openPage(browser, { viewport, hasTouch: viewport.width < 500, colorScheme: 'light' });
  if (api) await opened.context.route(`${base}/api/**`, api);
  await opened.page.goto(`${site}/?intro=0`);
  await until(opened.page, '#loading.gone');
  return opened;
}
const desk = (page, fn, ...a) => page.evaluate(([fn, a]) => import('/shell/desk.js').then(m => m[fn](...a)), [fn, a]);
const photos = async page => {
  await desk(page, 'openComputer', 'studio');
  await page.waitForSelector('.sd [data-part=tabs] [role=tab]');
};
const tab = async (page, name) => {
  await page.click(`[data-tab=${name}]`);
  await page.waitForSelector(`[data-sec=${name}]:not([hidden])`);
};
const selected = page => page.getAttribute('.sd [role=tab][aria-selected=true]', 'data-tab');
const crumb = page => page.textContent('.device header b');
// Approvals' photo: its product, once it shows (a decision moves on to the next)
const approval = '[data-part=approvals]';
const what = page => page.textContent(`${approval} .sd-what`);
const shows = (page, words) =>
  page.waitForFunction(
    ([box, words]) => document.querySelector(`${box} .sd-what`)?.textContent === words,
    [approval, words],
  );
const counted = page => page.textContent(`${approval} .sd-count`).catch(() => null);
// Approvals' brief: each label with its words, a check per line; and its links, each opening in a new tab
const brief = page =>
  page.$$eval(`${approval} .sd-brief > *`, lines =>
    lines.map(line => {
      const label = line.querySelector('span').textContent,
        checks = [...line.querySelectorAll('li')].map(li => li.textContent);
      return [label, checks.length ? checks : line.textContent.slice(label.length).trim()];
    }),
  );
const links = page => page.$$eval(`${approval} .sd-brief a`, list => list.map(a => [a.textContent, a.href, a.target]));
const history = page => page.$$eval('[data-rows=history] > li', tiles => tiles.map(t => t.dataset.key));
const search = async (page, words) => {
  await page.fill('[data-search]', words);
  await page.waitForTimeout(100);
  return history(page);
};
// nothing runs off the side of the screen, and the screen itself doesn't scroll sideways
async function fits(page, where) {
  const over = await page.evaluate(() => {
    const w = document.documentElement.clientWidth,
      s = document.querySelector('#crt');
    const out = [...document.querySelectorAll('#tool *')].filter(e => {
      const r = e.getBoundingClientRect();
      return r.width && (r.right > w + 0.5 || r.left < -0.5);
    });
    return {
      out: out.slice(0, 3).map(e => `${e.tagName.toLowerCase()}.${e.className}`),
      sideways: s.scrollWidth > s.clientWidth + 1,
    };
  });
  assert.deepEqual(over, { out: [], sideways: false }, `${where}: something runs off the screen`);
}
// the photo big has both its pictures loaded, inside its frame
async function bigShown(page, box, where) {
  await page.waitForFunction(
    box => {
      const pictures = [...document.querySelectorAll(`${box} .sd-view img`)];
      return pictures.length && pictures.every(i => i.complete && i.naturalWidth > 0);
    },
    box,
    { timeout: 10_000 },
  );
  const { view, pictures } = await page.evaluate(box => {
    const rect = e => e.getBoundingClientRect().toJSON();
    return {
      view: rect(document.querySelector(`${box} .sd-view`)),
      pictures: [...document.querySelectorAll(`${box} .sd-view img`)].map(rect),
    };
  }, box);
  for (const p of pictures)
    assert.ok(
      p.top >= view.top && p.bottom <= view.bottom && p.left >= view.left && p.right <= view.right,
      `${where}: the picture inside its frame`,
    );
}
// Approvals' buttons on the screen without scrolling
async function decideShown(page, where) {
  const [button, screen] = await page.evaluate(() =>
    ['[data-reject]', '#crt'].map(s => document.querySelector(s).getBoundingClientRect().bottom),
  );
  assert.ok(button <= screen, `${where}: Accept and Reject on the screen (${button} > ${screen})`);
}
// Approvals' lit button: Accept, or Reject once the comment has words
const lit = page =>
  page.$$eval(`${approval} .sd-decide button`, list =>
    list.filter(b => b.classList.contains('cta')).map(b => b.textContent),
  );
// two fingers on the screen around (x, y), from one spread to another (Chromium's own touch input: page.touchscreen
// has one finger)
async function pinch(page, x, y, from, to) {
  const cdp = await page.context().newCDPSession(page);
  const fingers = d => [
    { x: x - d / 2, y, id: 0 },
    { x: x + d / 2, y, id: 1 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(from) });
  for (let i = 1; i <= 10; i++)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: fingers(from + ((to - from) * i) / 10),
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
// The photo big, full size: a tap opens the picture shown, the whole of it on
// the screen; a pinch (touch) or the wheel zooms where it points, that point staying put; a drag pans; a double tap
// goes back to the whole picture; ✕ (touch) or Escape closes it, nothing decided.
async function zoomed(page, box, where, { touch }) {
  const side = await page.getAttribute(`${box} .sd-view`, 'data-on'),
    product = await page.textContent(`${box} .sd-what`);
  await (touch ? page.tap(`${box} .sd-view`) : page.click(`${box} .sd-view`));
  await page.waitForFunction(() => document.querySelector('dialog.zoom[open] img')?.style.width);
  assert.equal(
    await page.$eval('dialog.zoom img', i => i.src),
    await page.$eval(`${box} .sd-view [data-img=${side}]`, i => i.src),
    `${where}: the picture shown, full size`,
  );
  const picture = () => page.$eval('dialog.zoom img', i => i.getBoundingClientRect().toJSON());
  const { width, height } = page.viewportSize(),
    [x, y] = [width / 2, height / 2];
  const whole = await picture();
  assert.ok(
    whole.left > -1 && whole.top > -1 && whole.right < width + 1 && whole.bottom < height + 1,
    `${where}: the whole picture on the screen (${JSON.stringify(whole)} in ${width}×${height})`,
  );
  await shot(page, `zoom-${where.replace(/\W+/g, '-')}`);
  const at = r => [(x - r.left) / r.width, (y - r.top) / r.height];
  if (touch) await pinch(page, x, y, 60, 240);
  else {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -700);
  }
  await page.waitForTimeout(200);
  const close = await picture();
  assert.ok(close.width > whole.width * 2.5, `${where}: zoomed in (${whole.width} → ${close.width} px wide)`);
  at(close).forEach((v, i) => assert.ok(Math.abs(v - at(whole)[i]) < 0.02, `${where}: the point zoomed on stays put`));
  await shot(page, `zoomed-${where.replace(/\W+/g, '-')}`);
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    for (const [type, dx] of [['touchStart', 0], ['touchMove', 40], ['touchMove', 80], ['touchEnd']])
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: x + dx, y }] });
    await cdp.detach();
  } else {
    await page.mouse.down();
    await page.mouse.move(x + 40, y, { steps: 4 });
    await page.mouse.move(x + 80, y, { steps: 4 });
    await page.mouse.up();
  }
  assert.ok(Math.abs((await picture()).left - close.left - 80) < 1, `${where}: a drag pans it`);
  // (a scripted swipe holds back the next tap a moment)
  if (touch) await page.waitForTimeout(3000);
  for (let i = 0; i < 2; i++) await (touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
  await page.waitForFunction(
    w => document.querySelector('dialog.zoom img').getBoundingClientRect().width === w,
    whole.width,
  );
  await (touch ? page.tap('dialog.zoom .zoom-close') : page.keyboard.press('Escape'));
  await page.waitForFunction(() => !document.querySelector('dialog.zoom'));
  assert.equal(await page.textContent(`${box} .sd-what`), product, `${where}: closed, nothing decided`);
}
// (once the computer has finished opening, and the pictures fading in)
const shot = async (page, name) => {
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(shots, `${name}.png`) });
};

// ---- part one: dev mode, on a phone and a tablet
for (const [size, viewport] of Object.entries(SIZES)) {
  const { context, page, errors } = await open(viewport);
  // the desk phone's line while photos wait opens Photos on Approvals, the oldest first
  await desk(page, 'openPhone');
  await page.waitForSelector('.studio-line', { timeout: 20_000 });
  assert.match(await page.textContent('.studio-line'), /^Photos: 4 photos to approve›$/);
  await page.click('.studio-line');
  await page.waitForSelector(`${approval} .sd-view`);
  assert.match(await crumb(page), /› Photos$/);
  assert.deepEqual(
    await page.$$eval('.sd [role=tab]', tabs => tabs.map(t => t.textContent)),
    ['Approvals4', 'Queue', 'History'],
    'three tabs, Approvals first with what waits',
  );
  assert.equal(await selected(page), 'approvals');
  assert.equal(await what(page), 'Story mug');
  assert.equal(await counted(page), '1 of 4');
  // the page it goes on (a link opening in a new tab), what it should show and the one thing to check
  assert.deepEqual(await brief(page), [
    ['Goes on:', 'shop.example/story-mug/gallery'],
    ['Should show:', 'A close-up of the printed story'],
    ['Check:', ['The words are sharp enough to read']],
  ]);
  assert.deepEqual(await links(page), [
    ['shop.example/story-mug/gallery', 'https://shop.example/story-mug/gallery', '_blank'],
  ]);
  await bigShown(page, approval, `${size}: Approvals`);
  await decideShown(page, `${size}: Approvals`);
  await fits(page, `${size}: Approvals`);
  await shot(page, `approvals-${size}`);

  // the edit first; the switch flips to the original and says which, and flips back; a tap shows it full size
  assert.equal(await page.getAttribute(`${approval} .sd-view`, 'data-on'), 'edited');
  await page.click('[data-show=original]');
  await page.waitForSelector(`${approval} .sd-view[data-on=original]`);
  assert.equal(await page.getAttribute('[data-show=original]', 'aria-checked'), 'true');
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.sd-view [data-img=edited]')).opacity === '0',
  );
  await zoomed(page, approval, `${size}, the original`, { touch: size === 'phone' });
  await page.click('[data-show=edited]');
  await page.waitForSelector(`${approval} .sd-view[data-on=edited]`);
  await zoomed(page, approval, `${size}, the edit`, { touch: size === 'phone' });

  // a comment lights Reject and quiets Accept; the box grows with its lines; only spaces light Accept again
  assert.deepEqual(await lit(page), ['Accept']);
  const comment = page.locator(`${approval} textarea`);
  await comment.fill('Creased at the top.\nA smudge by the cord.\nBetter hung from a pin.');
  assert.deepEqual(await lit(page), ['Reject'], 'words in the box: Reject is lit');
  assert.ok(
    await comment.evaluate(t => t.scrollHeight <= t.clientHeight),
    'the box grows with its lines: none is cut off',
  );
  await decideShown(page, `${size}: Approvals, a three-line comment`);
  await shot(page, `approvals-comment-${size}`);
  await comment.fill('   ');
  assert.deepEqual(await lit(page), ['Accept'], 'only spaces: Accept is lit');

  // Accept with a comment: the next one follows, with its own pages and checks
  await page.fill(`${approval} textarea`, 'lovely light');
  await page.click('[data-accept]');
  await shows(page, 'Wave tote');
  assert.equal(await counted(page), '1 of 3');
  assert.equal(await page.textContent('[data-tab=approvals] i'), '3');
  assert.deepEqual(await brief(page), [
    ['Goes on:', 'shop.example/wave-tote, shop.example/gifts/a-new-home'],
    ['Should show:', 'The tote over a shoulder, the whole print in view'],
    ['Check:', ['Both handles in the picture', 'The wave isn’t creased']],
  ]);
  assert.equal((await links(page)).length, 2, 'each page a link');
  assert.equal(await page.inputValue(`${approval} textarea`), '', 'a fresh comment field');
  assert.deepEqual(await lit(page), ['Accept'], 'and Accept lit');
  assert.equal(await page.getAttribute(`${approval} .sd-view`, 'data-on'), 'edited', 'the edit first again');
  await decideShown(page, `${size}: Approvals, two pages`);
  await fits(page, `${size}: Approvals, two pages`);
  await shot(page, `approvals-pages-${size}`);

  // Reject with a comment: back to the keeper, and the next one follows
  await page.fill(`${approval} textarea`, 'the handles are cut off');
  await page.click('[data-reject]');
  await page.waitForSelector('.toast >> text=With your comment: the handles are cut off');
  await shows(page, 'Sprout plush');
  assert.equal(await counted(page), '1 of 2');
  // many pages: the request's words for where, no link
  assert.deepEqual((await brief(page))[0], ['Goes on:', 'every gift guide page']);
  assert.deepEqual(await links(page), []);
  await decideShown(page, `${size}: Approvals, where in words`);

  // the Queue: the shots the keeper is developing (the one sent back too), each with the page it's for, and the
  // month; nothing in it to tap
  await tab(page, 'queue');
  assert.match(await crumb(page), /› Photos$/);
  const queue = await page.$$eval('[data-rows=queue] > li', rows => rows.map(r => r.dataset.key));
  assert.deepEqual(queue.toSorted(), ['p10', 'p12', 'p8', 'p9'].toSorted());
  assert.match(await page.textContent('[data-part=queue]'), /Pinhole has 4 photos in the darkroom/);
  assert.ok(await page.locator('[data-part=queue] .sd-light').isVisible(), 'the safelight is on while photos develop');
  assert.equal(await page.locator('.sd-key').count(), 0, 'the key is in: no line about it');
  assert.equal(await page.textContent('[data-key=p8] .sd-for'), 'For shop.example/gifts/for-a-teacher');
  assert.equal(await page.textContent('[data-key=p12] .sd-for'), 'For shop.example/wave-tote', 'its first page');
  assert.equal(await page.textContent('[data-key=p9] .sd-for'), 'For the shop’s front page and its newsletter');
  assert.match(await page.textContent('[data-key=p10] .sd-state'), /Pinhole is developing it/);
  assert.equal(await page.locator('[data-sec=queue] :is(button, input, a)').count(), 0, 'nothing to tap');
  assert.match(await page.textContent('[data-part=foot]'), /THIS MONTH · 14 EDITS · \$0\.55/);
  await fits(page, `${size}: the Queue`);
  await shot(page, `queue-${size}`);

  // History: the approved ones, newest decided first (the one just accepted on top; declined and withdrawn ones don't
  // show, an unknown product by its id), found by product or by a page's pasted address
  await tab(page, 'history');
  assert.deepEqual(await history(page), ['p11', 'p7', 'p6', 'p5', 'p3']);
  assert.ok(
    (await page.getAttribute('[data-key=p3] button', 'aria-label')).startsWith('keyring,'),
    'an unknown product by its id',
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-rows=history] img')].every(i => i.complete && i.naturalWidth > 0),
  );
  await fits(page, `${size}: History`);
  await shot(page, `history-${size}`);
  assert.deepEqual(await search(page, 'tote'), ['p6'], 'by product name');
  assert.deepEqual(await search(page, 'KEYRING'), ['p3'], 'by product id');
  assert.deepEqual(await search(page, 'https://www.shop.example/gifts/a-new-home/?ref=mail#top'), ['p6'], 'by a page');
  assert.deepEqual(await search(page, 'shop.example/sprout'), ['p7'], 'by a page as typed');
  assert.deepEqual(await search(page, 'teapot'), []);
  assert.equal(await page.textContent('[data-part=history-none]'), 'None of the approved photos matches that.');
  assert.deepEqual(await search(page, ''), ['p11', 'p7', 'p6', 'p5', 'p3']);

  // one opened big: the day it was approved and its pages; the header's back button returns to the list
  await page.click('[data-key=p6] button');
  await page.waitForSelector('[data-part=history]:not([hidden]) .sd-view');
  assert.ok(await page.locator('[data-rows=history]').isHidden(), 'the list steps aside');
  assert.match(await crumb(page), /› Photos › Wave tote$/);
  assert.equal(await page.textContent('[data-part=history] .sd-count'), 'Approved 16 Oct');
  assert.deepEqual(
    await page.$$eval('[data-part=history] .sd-places a', links => links.map(a => [a.textContent, a.href])),
    [
      ['shop.example/wave-tote', 'https://shop.example/wave-tote'],
      ['shop.example/gifts/a-new-home', 'https://shop.example/gifts/a-new-home'],
    ],
  );
  await bigShown(page, '[data-part=history]', `${size}: History, one big`);
  await fits(page, `${size}: History, one big`);
  await shot(page, `history-big-${size}`);
  await page.click('.device [data-home]');
  await page.waitForSelector('[data-rows=history]:not([hidden]) [data-key=p6]');
  assert.ok(await page.locator('[data-part=history]').isHidden());
  assert.equal(await selected(page), 'history', 'back on the list, still in History');

  // This should change: its note is required, then it goes back to the keeper and leaves History
  await page.click('[data-key=p6] button');
  await page.click('[data-change]');
  const change = page.locator('[data-part=history] .sd-retry textarea');
  await change.waitFor();
  assert.ok(await change.evaluate(i => i === document.activeElement), 'the note field has the focus');
  await page.click('[data-part=history] .sd-retry button');
  await page.waitForTimeout(300);
  assert.ok(await change.isVisible(), 'no note: nothing sent');
  await change.fill('the tote is creased');
  await fits(page, `${size}: This should change`);
  await shot(page, `change-${size}`);
  await page.click('[data-part=history] .sd-retry button');
  await page.waitForSelector('.toast >> text=the tote is creased');
  await page.waitForSelector('[data-rows=history]:not([hidden])');
  assert.deepEqual(await history(page), ['p11', 'p7', 'p5', 'p3'], 'gone from History');

  // the ones sent back come back to Approvals once developed (dev mode: in 9 s, read at the next redraw, every 15 s)
  await tab(page, 'approvals');
  assert.equal(await what(page), 'Sprout plush', 'the one shown stays until it’s decided');
  await page.waitForFunction(() => document.querySelector('[data-tab=approvals] i')?.textContent === '4', null, {
    timeout: 40_000,
  });
  assert.equal(await counted(page), '3 of 4');
  assert.deepEqual(errors, []);
  await context.close();
}

// a tablet on its side (as wide as a desktop, not as tall): the photo big stays in its frame, Accept on the screen; a
// desktop: the wheel zooms the photo full size, in Approvals and in History
{
  const { context, page, errors } = await open({ width: 1180, height: 820 });
  await photos(page);
  await bigShown(page, approval, 'tablet on its side: Approvals');
  await decideShown(page, 'tablet on its side: Approvals');
  await fits(page, 'tablet on its side: Approvals');
  await shot(page, 'approvals-tablet-side');
  await tab(page, 'history');
  await page.click('[data-key=p7] button');
  await bigShown(page, '[data-part=history]', 'tablet on its side: History, one big');
  assert.deepEqual(errors, []);
  await context.close();
}
{
  const { context, page, errors } = await open({ width: 1440, height: 900 });
  await photos(page);
  await bigShown(page, approval, 'desktop: Approvals');
  await zoomed(page, approval, 'desktop, Approvals', { touch: false });
  await tab(page, 'history');
  await page.click('[data-key=p7] button');
  await bigShown(page, '[data-part=history]', 'desktop: History, one big');
  await zoomed(page, '[data-part=history]', 'desktop, History', { touch: false });
  // This should change's note grows with its lines too
  await page.click('[data-change]');
  const change = page.locator('[data-part=history] .sd-retry textarea');
  await change.fill('Creased.\nSmudged.\nHang it from a pin.');
  assert.ok(
    await change.evaluate(t => t.scrollHeight <= t.clientHeight),
    'This should change: the box grows, none is cut off',
  );
  await shot(page, 'change-desktop');
  assert.deepEqual(errors, []);
  await context.close();
}

// ---- part two: the real routes (not dev mode)
{
  const studio = JSON.parse(readFileSync(join(ROOT, 'platform/hq/mock/studio.json'), 'utf8'));
  Object.assign(studio, { key: false });
  const photo = id => studio.photos.find(p => p.id === id);
  studio.products[0].name = `Story mug ${XSS}`;
  photo(14).request.show += ` ${XSS}`;
  photo(14).checks[0] += ` ${XSS}`;
  photo(13).request.where = XSS;
  photo(11).request.pages.push('ftp://shop.example/story-mug');
  photo(7).places.push(XSS);
  const posts = [];
  let refused = false;
  const { context, page, errors } = await open(SIZES.phone, async r => {
    const url = new URL(r.request().url()),
      path = url.pathname;
    if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
    if (path === '/api/requests' || path === '/api/gazette') return r.fulfill({ json: [] });
    if (path === '/api/studio') return r.fulfill({ json: studio });
    if (path === '/api/studio/original' || path === '/api/studio/edited') {
      const p = studio.photos.find(x => x.id === Number(url.searchParams.get('id')));
      const side = path.endsWith('edited') ? 'edited' : 'original';
      return r.fulfill({ response: await r.fetch({ url: `${base}/mock/studio/${p.mockPicture}-${side}.svg` }) });
    }
    const body = r.request().postDataJSON();
    if (path === '/api/studio/decide') {
      posts.push({ decide: body });
      // (the first Accept is refused, as when someone decided it a minute before)
      if (!refused) {
        refused = true;
        return r.fulfill({ status: 409, json: { error: `Someone decided that one a minute ago. ${XSS}` } });
      }
      for (const { id } of body.photos) photo(id).status = body.decision;
      return r.fulfill({ json: { decided: body.photos.length } });
    }
    if (path === '/api/studio/reject') {
      posts.push({ reject: body });
      photo(body.photo.id).status = 'new';
      return r.fulfill({ json: { ok: true } });
    }
    if (path === '/api/studio/change') {
      posts.push({ change: body });
      Object.assign(photo(body.photo.id), { status: 'new', places: [] });
      return r.fulfill({ json: { ok: true } });
    }
    return r.fulfill({ status: 404, body: '' });
  });
  await photos(page);
  await page.waitForSelector(`${approval} .sd-view`);
  // the pictures come from the studio's own routes, an edit by its id, and the original that edit came from with it
  const sources = await page.$$eval(`${approval} .sd-view img`, list => list.map(i => i.getAttribute('src')));
  assert.deepEqual(sources, ['/api/studio/original?id=11&edit=18', '/api/studio/edited?id=11&edit=18']);
  // a page that isn't a web address shows as text, never a link
  assert.deepEqual((await brief(page))[0], [
    'Goes on:',
    'shop.example/story-mug/gallery, ftp://shop.example/story-mug',
  ]);
  assert.deepEqual(
    (await links(page)).map(([words]) => words),
    ['shop.example/story-mug/gallery'],
  );
  // a live update while the board types (another photo comes in to wait, the count changes): the comment and its
  // focus stay; then it goes again
  const live = waiting =>
    page.evaluate(n => import('/world/world.js').then(w => w.setStudio({ keeper: 'pinhole', waiting: n })), waiting);
  await page.fill(`${approval} textarea`, 'the light is lovely');
  studio.photos.unshift({ ...studio.photos.find(p => p.id === 14), id: 15, edit: 22 });
  await live(5);
  await page.waitForFunction(box => document.querySelector(`${box} .sd-count`)?.textContent === '1 of 5', approval);
  assert.equal(await page.inputValue(`${approval} textarea`), 'the light is lovely', 'the comment stays');
  assert.ok(await page.$eval(`${approval} textarea`, i => i === document.activeElement), 'and keeps the focus');
  assert.deepEqual(await lit(page), ['Reject'], 'and Reject stays lit');
  studio.photos.shift();
  await live(4);
  await page.waitForFunction(box => document.querySelector(`${box} .sd-count`)?.textContent === '1 of 4', approval);
  assert.equal(await page.inputValue(`${approval} textarea`), 'the light is lovely');
  // a refusal shows in the coordinator's own words, under its photo, and the photo stays with its buttons working
  await page.fill(`${approval} textarea`, 'nice');
  await page.click('[data-accept]');
  await page.waitForSelector(`${approval} .sd-msg`);
  assert.equal(await page.textContent(`${approval} .sd-msg`), `Someone decided that one a minute ago. ${XSS}`);
  assert.ok(await page.locator('[data-accept]').isEnabled(), 'its buttons work again');
  assert.ok(await page.locator('[data-reject]').isEnabled());
  assert.equal(await page.inputValue(`${approval} textarea`), 'nice', 'the comment stays');
  await shot(page, 'refused-phone');
  // Accept sends the edit shown, a comment as its note
  await page.click('[data-accept]');
  await shows(page, 'Wave tote');
  assert.deepEqual(posts.splice(0), [
    { decide: { photos: [{ id: 11, edit: 18 }], decision: 'approved', note: 'nice' } },
    { decide: { photos: [{ id: 11, edit: 18 }], decision: 'approved', note: 'nice' } },
  ]);
  // Reject sends its comment whole, with its line breaks. Accept without a comment sends no note
  const long = `the handles are cut off\n\n${'The print runs off the left edge and the strap looks grey. '.repeat(12).trim()}`;
  await page.fill(`${approval} textarea`, long);
  await page.click('[data-reject]');
  await shows(page, 'Sprout plush');
  assert.deepEqual((await brief(page))[0], ['Goes on:', XSS], 'where stays text');
  await page.click('[data-accept]');
  await page.waitForFunction(() =>
    /Story mug/.test(document.querySelector('[data-part=approvals] .sd-what')?.textContent),
  );
  assert.deepEqual(posts.splice(0), [
    { reject: { photo: { id: 12, edit: 19 }, note: long } },
    { decide: { photos: [{ id: 13, edit: 20 }], decision: 'approved' } },
  ]);
  // text stays text: a product's name, what it should show and a check
  assert.equal(await page.textContent(`${approval} .sd-what`), `Story mug ${XSS}`);
  assert.deepEqual((await brief(page)).slice(1), [
    ['Should show:', `The mug from the side with the sun, on a breakfast table ${XSS}`],
    ['Check:', [`The sun on the print is whole ${XSS}`, 'The handle points right', 'No second mug in the shot']],
  ]);
  await decideShown(page, 'phone: Approvals, three checks');
  await page.click('[data-accept]');
  await page.waitForSelector(`${approval} .sd-empty`);
  assert.equal(await page.locator('[data-tab=approvals] i').count(), 0, 'nothing waits: no count');
  posts.splice(0);

  // the Queue: the key isn't in yet, one line says where its card is; nothing to tap
  await tab(page, 'queue');
  assert.match(await page.textContent('.sd-key'), /image model’s key isn’t in yet: its card is on the desk phone/);
  assert.equal(await page.locator('[data-sec=queue] button').count(), 0);
  await shot(page, 'no-key-phone');

  // History: a tile's picture is the edit approved; a page that isn't an address shows as text; This should change
  await tab(page, 'history');
  assert.equal(await page.getAttribute('[data-key=p7] img', 'src'), '/api/studio/edited?id=7&edit=12');
  await page.click('[data-key=p7] button');
  assert.deepEqual(await page.$$eval('[data-part=history] .sd-places li', list => list.map(li => li.textContent)), [
    'shop.example/sprout-plush',
    XSS,
  ]);
  await page.click('[data-change]');
  await page.fill('[data-part=history] .sd-retry textarea', 'the plush looks grey');
  await page.click('[data-part=history] .sd-retry button');
  await page.waitForSelector('[data-rows=history]:not([hidden])');
  assert.deepEqual(posts.splice(0), [{ change: { photo: { id: 7, edit: 12 }, note: 'the plush looks grey' } }]);
  assert.equal(await page.locator('#crt img[src="x"], #crt [onerror]').count(), 0, 'an element came out of the data');

  // a fresh opening lands on Approvals, with its line when nothing waits
  await desk(page, 'openComputer', 'home');
  await photos(page);
  assert.equal(await selected(page), 'approvals');
  await page.waitForSelector(`${approval} .sd-empty`);
  assert.deepEqual(errors, [], 'no page error, no dialog');
  await context.close();
}

// ---- part three: Wire's light look (dev mode, the brand's renderer set to it): a photo's brief and the studio's
// questions stand out from the colourway's light panel.
{
  const brand = JSON.parse(readFileSync(join(ROOT, 'platform/hq/mock/brand.json'), 'utf8'));
  const wire = await serve(undefined, 0, {
    'mock/brand.json': JSON.stringify({ ...brand, theme: { ...brand.theme, renderer: 'wire' } }),
  });
  const { context, page, errors } = await open(SIZES.phone, null, `http://localhost:${wire.address().port}`);
  await photos(page);
  assert.ok(
    await page.evaluate(
      () => document.body.classList.contains('keys') && !document.body.classList.contains('wire-dark'),
    ),
    'Wire is the look, on a light colourway',
  );
  // each line's words against what's behind them, the see-through backgrounds laid over the first solid one (WCAG's
  // contrast ratio)
  const measure = lines =>
    page.evaluate(
      lines =>
        lines.map(([what, selector]) => {
          const el = document.querySelector(selector),
            backgrounds = [];
          for (let e = el; e; e = e.parentElement) backgrounds.push(getComputedStyle(e).backgroundColor);
          return [what, getComputedStyle(el).color, backgrounds];
        }),
      lines,
    );
  await page.waitForSelector(`${approval} .sd-brief`);
  const lines = await measure([
    ['a brief’s label', `${approval} .sd-brief span`],
    ['a page’s link', `${approval} .sd-brief a`],
    ['what to check', `${approval} .sd-brief li`],
  ]);
  await shot(page, 'wire-light-phone');
  await zoomed(page, approval, 'Wire, phone', { touch: true });
  await page.fill(`${approval} textarea`, 'Creased.\nSmudged.');
  assert.deepEqual(await lit(page), ['Reject'], 'Wire: Reject lit');
  await shot(page, 'wire-light-comment-phone');
  await tab(page, 'history');
  await page.click('[data-key=p7] button');
  await page.click('[data-change]');
  await page.waitForSelector('[data-part=history] .sd-retry');
  lines.push(...(await measure([['This should change’s question', '[data-part=history] .sd-retry label']])));
  await shot(page, 'wire-light-change-phone');
  // a computed colour as [r, g, b, a], channels 0 to 255 (a color-mix() comes back as color(srgb r g b / a), 0 to 1)
  const rgba = css => {
    const [r, g, b, a = 1] = (css.match(/[\d.]+/g) ?? []).map((n, i) =>
      css.startsWith('color(') && i < 3 ? n * 255 : Number(n),
    );
    return [r, g, b, a];
  };
  const behind = backgrounds => {
    const layers = [];
    for (const bg of backgrounds.map(rgba)) {
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] === 1) break;
    }
    if (layers.at(-1)?.[3] !== 1) layers.push([255, 255, 255, 1]);
    return layers.reduceRight((under, [r, g, b, a]) => [r, g, b].map((v, i) => v * a + under[i] * (1 - a)));
  };
  const ratios = Object.fromEntries(
    lines.map(([what, color, backgrounds]) => [
      what,
      Math.round(contrastChannels(rgba(color).slice(0, 3), behind(backgrounds)) * 10) / 10,
    ]),
  );
  for (const [what, ratio] of Object.entries(ratios)) assert.ok(ratio >= 4.5, `Wire, light: ${what} at ${ratio}:1`);
  assert.deepEqual(errors, [], 'no page error, no dialog');
  await context.close();
  wire.close();
}

await browser.close();
server.close();
console.log(
  `studio-check (${Math.round((Date.now() - started) / 1000)} s): on a phone and a tablet the desk phone's line opening Approvals, the tabs and their count, a photo big (flip, its pages, what it should show and what to check, Accept and Reject with a comment, the next one following), the Queue to read only, History by product and by a page's address, one big and back, This should change (its note required), nothing off the screen; a comment's box growing and Reject lit with it; the photo full size with a pinch, the wheel, a drag and a double tap; what each tap sends, a refusal in its words, text as text, the no-key line, Approvals on a fresh opening; the brief and the questions in Wire's light look. Screenshots: ${shots}`,
);
