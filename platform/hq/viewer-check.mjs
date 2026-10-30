#!/usr/bin/env node
// HQ's viewer in a browser (shell/viewer.js): a shop page on staging beside the same page live, their scroll linked,
// tabs where both don't fit, the device sizes, the notebook over or beside, and the QR code, at a laptop, an iPad mini
// on its side and upright, and a phone. node platform/hq/viewer-check.mjs [--webkit] [--shots <dir>]
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { serve, mockFiles, ROOT } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';
import { fulfilPart } from '../../shared/review/parts.mjs';
import { bookAtRest } from './bookkit.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const server = await serve(undefined, 0, await mockFiles()),
  base = `http://localhost:${server.address().port}`;
const STAGING = 'https://shop.preview.test',
  LIVE = 'https://www.shop.test/shop';
const scrollLink = await readFile(`${ROOT}/shared/watchalong/scrolllink.js`, 'utf8');
// staging runs review mode (the bar's Note), as a preview does for the board; live the scroll link alone
const reviewJs = (await readFile(`${ROOT}/shared/review/review.js`, 'utf8')).replace('{{HQ_ORIGIN}}', base);
// A tall shop page: staging has the shipping banner live hasn't yet
const shopPage = banner => `<!doctype html><meta name="viewport" content="width=device-width"><title>Shop</title>
  <body style="margin:0;font:18px system-ui;background:#fbf8f1">
  <header style="padding:16px;border-bottom:2px solid #222">Shop</header>
  ${banner ? '<p style="margin:12px;padding:10px;border:2px solid #222;border-radius:99px;text-align:center">Free shipping this week</p>' : ''}
  ${Array.from({ length: 30 }, (_, i) => `<div style="margin:12px;height:140px;border:2px solid #222;border-radius:8px">Product ${i + 1}</div>`).join('')}
  <script src="/__review/review.js"></script></body>`;
const artifacts = {
  id: 'shop',
  name: 'Shop',
  kind: 'app',
  about: '',
  open: `${STAGING}/`,
  public: [`${LIVE}/`],
  icon: null,
  picture: null,
  status: 'live',
  waiting: false,
  owner: 'kit',
  place: [],
  shown: null,
  cards: [],
  hero: false,
  archived: false,
};
const unlived = { ...artifacts, id: 'atlas', open: 'https://atlas.preview.test/', public: [] };

const LAPTOP = { width: 1440, height: 900 },
  MINI = { width: 1133, height: 744 },
  MINI_UP = { width: 744, height: 1133 },
  PHONE = { width: 390, height: 844 };

// fromQr: HQ opened at the address the QR's sign-in sends a phone to, the viewer at url
async function opened(browser, viewport, url = `${STAGING}/shop`, touch = false, fromQr = false) {
  const { context, page, errors } = await openPage(browser, {
    viewport,
    hasTouch: touch,
    isMobile: touch && viewport.width < 600,
  });
  await context.route(`${base}/mock/artifacts.json`, r => r.fulfill({ json: [artifacts, unlived] }));
  await context.route(`${base}/api/notebooks/pair`, r =>
    r.fulfill({ json: { code: '482913', expires: Date.now() + 60_000 } }),
  );
  for (const host of [STAGING, LIVE.replace('/shop', ''), 'https://atlas.preview.test'])
    await context.route(`${host}/**`, r => {
      const path = new URL(r.request().url()).pathname;
      const staging = host === STAGING;
      if (path === '/__review/review.js')
        return r.fulfill({ contentType: 'text/javascript', body: (staging ? reviewJs : '') + scrollLink });
      if (staging && fulfilPart(r, path, reviewJs)) return;
      if (path.startsWith('/__review/')) return r.fulfill({ json: { show: false } });
      return r.fulfill({ contentType: 'text/html', body: shopPage(staging) });
    });
  await page.goto(`${base}/?intro=0${fromQr ? `&${new URLSearchParams({ open: 'viewer', url })}` : ''}`);
  await until(page, '#loading.gone');
  if (!fromQr) await page.evaluate(u => import('/shell/desk.js').then(m => m.openLink(u)), url);
  await until(page, '#viewer .pane.after iframe');
  await page.waitForTimeout(1500); // (review mode's hello answered: desk.js ASK_MS)
  return { context, page, errors };
}
const shot = (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png` });
const box = (page, sel) => page.locator(sel).first().boundingBox();
const frameOf = async (page, side) => (await page.$(`#viewer .pane.${side} iframe`)).contentFrame();
const visible = (page, side) =>
  page.$eval(`#viewer .pane.${side}`, el => !el.hidden && getComputedStyle(el).visibility !== 'hidden');
// Nothing on the bar over anything else on it, and all of it, the choices' buttons too, inside the screen
async function barWhole(page, viewport) {
  const boxesOf = sel =>
    page.$$eval(sel, all =>
      all
        .map(el => ({ name: el.className || el.textContent, ...el.getBoundingClientRect().toJSON() }))
        .filter(b => b.width),
    );
  const parts = await boxesOf('#viewer .bar > *:not([hidden])'),
    choices = await boxesOf('#viewer .bar .choices button');
  for (const b of [...parts, ...choices])
    assert.ok(b.right <= viewport.width + 0.5 && b.left >= -0.5, `${b.name} off the screen`);
  for (const a of parts)
    for (const b of parts)
      if (a !== b && a.left < b.right - 1 && b.left < a.right - 1) assert.fail(`on the bar, ${a.name} over ${b.name}`);
}
async function linkedScroll(page) {
  const after = await frameOf(page, 'after'),
    live = await frameOf(page, 'live');
  // (both pages' scroll links listening: a cold WebKit can still be loading live's.)
  for (const frame of [after, live]) await frame.waitForFunction(() => window.__scrollLink);
  await after.evaluate(() => scrollTo(0, 900));
  await page.waitForTimeout(400);
  assert.equal(await live.evaluate(() => scrollY), 900, 'live follows staging');
  await page.waitForTimeout(400);
  await live.evaluate(() => scrollTo(0, 300));
  await page.waitForTimeout(400);
  assert.equal(await after.evaluate(() => scrollY), 300, 'staging follows live');
}

const browser = await playwright()[process.argv.includes('--webkit') ? 'webkit' : 'chromium'].launch();
const results = [];
async function story(name, run) {
  try {
    await run();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
  }
}

await story('a laptop: live beside staging, linked scroll, four device sizes, the notebook beside', async () => {
  const { context, page, errors } = await opened(browser, LAPTOP);
  try {
    await until(page, '#viewer .pane.live iframe');
    await page.waitForTimeout(600);
    assert.equal(await page.$eval('#viewer .stage', s => s.dataset.mode), 'columns');
    const live = await box(page, '#viewer .pane.live'),
      staging = await box(page, '#viewer .pane.after');
    assert.ok(live.x + live.width <= staging.x, 'live on the left, staging on the right, apart');
    assert.deepEqual(await page.$$eval('#viewer .bar [data-device]', all => all.map(b => b.textContent)), [
      'This device',
      'Desktop',
      'Tablet',
      'Phone',
    ]);
    await linkedScroll(page);
    await barWhole(page, LAPTOP);
    await shot(page, 'laptop-this-device');
    await page.click('#viewer [data-device=phone]');
    await page.waitForTimeout(300);
    const phone = await box(page, '#viewer .pane.after .sized');
    assert.equal(Math.round(phone.width), 390, 'a phone frame at its own width');
    await linkedScroll(page);
    await shot(page, 'laptop-phone');
    await page.click('#viewer [data-device=desktop]');
    await page.waitForTimeout(300);
    const scale = await page.$eval('#viewer .pane.after', p => +p.style.getPropertyValue('--scale'));
    assert.ok(scale < 1, 'a desktop page drawn smaller in its column');
    await shot(page, 'laptop-desktop');
    // the notebook over: HQ's page keeps its whole width under the open book
    await page.click('#viewer [data-book=over]');
    await bookAtRest(page, 'folded');
    assert.equal(await page.evaluate(() => Math.round(document.body.getBoundingClientRect().width)), LAPTOP.width);
    // (the book shut from beside it: HQ's page dissolved into its whole width, wholly back first)
    await page.waitForFunction(() => {
      const { filter, opacity } = getComputedStyle(document.body);
      return filter === 'none' && opacity === '1';
    });
    // the book pulled out over the frames: HQ's page keeps its whole width, never fading or blurring as the book opens
    // (that only hides a reflow Over hasn't: the board, 30 Oct.), the bar keeps
    // clear of the book
    await page.evaluate(() => {
      window.__looks = new Set();
      const look = () => {
        if (!window.__looks) return;
        const { filter, opacity } = getComputedStyle(document.body);
        window.__looks.add(`${filter} ${opacity}`);
        requestAnimationFrame(look);
      };
      look();
      return import('/shell/ink/book.js').then(m => m.openBook());
    });
    await bookAtRest(page, 'open');
    const looks = await page.evaluate(() => {
      const seen = [...window.__looks];
      window.__looks = null;
      return seen;
    });
    assert.deepEqual(looks, ['none 1'], `HQ's page faded or blurred as the book opened over it: ${looks.join(', ')}`);
    assert.equal(await page.evaluate(() => Math.round(document.body.getBoundingClientRect().width)), LAPTOP.width);
    const close = await box(page, '#viewer [data-close]'),
      book = await box(page, '#book [role=separator]');
    assert.ok(close.x + close.width <= book.x, 'Close clear of the book over the frames');
    await shot(page, 'laptop-over');
    // Beside tapped while the book swings shut: it falls open again, and HQ's page takes its room beside it only while
    // the swing's dissolve has it gone, never in sight
    // (tapped two frames in: the swing steps at most 33 ms a frame, so it's still on its way up however slow the engine)
    const midSwing = await page.evaluate(async () => {
      window.__seen = [];
      const look = () => {
        window.__seen.push({
          width: Math.round(document.body.getBoundingClientRect().width),
          hidden: getComputedStyle(document.body).visibility === 'hidden',
        });
        requestAnimationFrame(look);
      };
      look();
      (await import('/shell/ink/book.js')).foldBook();
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      const swinging = !!document.querySelector('#book.bk-swinging');
      document.querySelector('#viewer [data-book=beside]').click();
      return swinging;
    });
    assert.ok(midSwing, 'Beside tapped while the book swings shut');
    await bookAtRest(page, 'open');
    // (two frames more, for the frame HQ's page was laid out in its room to be seen)
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const seen = await page.evaluate(() => window.__seen),
      moved = seen.findIndex(f => f.width !== LAPTOP.width);
    assert.ok(moved > 0, 'HQ took its room beside the book');
    assert.ok(
      seen[moved].hidden,
      `HQ's page took its room in sight: ${JSON.stringify(seen.slice(moved - 3, moved + 1))}`,
    );
    assert.ok((await page.evaluate(() => document.body.getBoundingClientRect().width)) < LAPTOP.width - 300);
    // kept for this screen
    await page.evaluate(() => document.querySelector('#viewer [data-close]').click());
    await page.evaluate(u => import('/shell/desk.js').then(m => m.openLink(u)), `${STAGING}/shop`);
    await page.waitForTimeout(500);
    assert.equal(await page.$eval('#viewer [data-device=desktop]', b => b.getAttribute('aria-pressed')), 'true');
    // the QR
    await page.click('#viewer .bar .qr');
    await until(page, '#viewer .qrcard .pair-qr');
    const href = await page.evaluate(() =>
      import('/shell/ink/pair.js').then(m => m.pairLink('https://shop.preview.test/shop')),
    );
    assert.match(href.link, /\/pair#code=482913&view=https%3A%2F%2Fshop\.preview\.test%2Fshop$/);
    await shot(page, 'laptop-qr');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await story(
  'an iPad mini on its side: over by default, side by side; beside takes turns as tabs, still linked',
  async () => {
    const { context, page, errors } = await opened(browser, MINI, undefined, true);
    try {
      await until(page, '#viewer .pane.live iframe');
      await page.waitForTimeout(600);
      assert.deepEqual(await page.$$eval('#viewer .bar [data-device]', all => all.map(b => b.textContent)), [
        'This device',
        'Phone',
      ]);
      assert.equal(await page.$('#viewer .bar .qr'), null, 'no QR on a tablet');
      await page.click('#viewer [data-device=phone]');
      await page.evaluate(() => import('/shell/ink/book.js').then(m => m.foldBook()));
      await bookAtRest(page, 'folded');
      assert.equal(await page.$eval('#viewer .stage', s => s.dataset.mode), 'columns');
      await barWhole(page, MINI);
      await shot(page, 'mini-over-phone');
      await page.click('#viewer [data-device=here]');
      await page.click('#viewer [data-book=beside]');
      await bookAtRest(page, 'open');
      assert.equal(await page.$eval('#viewer .stage', s => s.dataset.mode), 'tabs');
      assert.ok(await visible(page, 'after'));
      assert.ok(!(await visible(page, 'live')));
      await linkedScroll(page);
      assert.ok(await page.isVisible('#viewer .bar .pin'), "staging's review mode: the bar's Note");
      await page.click('#viewer [data-tab=live]');
      assert.ok(await visible(page, 'live'));
      await barWhole(page, { width: await page.evaluate(() => document.body.getBoundingClientRect().width) });
      await shot(page, 'mini-beside-tabs');
      await page.click('#viewer .bar .pin');
      assert.ok(await visible(page, 'after'), 'Note on the Live tab brings staging, where it pins, to the front');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

await story('a phone on its side beside the open book: Over and Beside, the bar whole', async () => {
  const { context, page, errors } = await opened(browser, { width: 844, height: 390 }, undefined, true);
  try {
    await until(page, '#viewer .pane.live iframe');
    await page.click('#viewer [data-book=beside]');
    await page.waitForTimeout(1200);
    await barWhole(page, { width: await page.evaluate(() => document.body.getBoundingClientRect().width) });
    await shot(page, 'phone-sideways-beside');
    await page.click('#viewer [data-book=over]');
    await bookAtRest(page, 'folded'); // (Over puts the book away)
    assert.equal(await page.$eval('#viewer .stage', s => s.dataset.mode), 'columns', 'live and staging side by side');
    await shot(page, 'phone-sideways-over');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const [name, viewport] of [
  ['an upright iPad mini', MINI_UP],
  ['a phone', PHONE],
])
  await story(`${name}: tabs, no switcher, the notebook over`, async () => {
    const { context, page, errors } = await opened(browser, viewport, undefined, true);
    try {
      await until(page, '#viewer .pane.live iframe');
      await page.waitForTimeout(600);
      assert.equal(await page.$('#viewer .bar [data-device]'), null);
      assert.equal(await page.$('#viewer .bar [data-book]'), null);
      assert.equal(await page.$eval('#viewer .stage', s => s.dataset.mode), 'tabs');
      await linkedScroll(page);
      await barWhole(page, viewport);
      await shot(page, name.replace(/\W+/g, '-'));
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

await story("a phone from the laptop's QR: HQ opens on the same viewer, live and staging as tabs", async () => {
  const { context, page, errors } = await opened(browser, PHONE, `${STAGING}/shop`, true, true);
  try {
    await until(page, '#viewer .pane.live iframe');
    assert.match(await page.$eval('#viewer .pane.after iframe', f => f.src), /shop\.preview\.test\/shop$/);
    assert.equal(await page.evaluate(() => location.search), '?intro=0', 'the address put back as HQ loads');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await story('a preview that is not live: staging alone, edge to edge, no head', async () => {
  const { context, page, errors } = await opened(browser, LAPTOP, 'https://atlas.preview.test/');
  try {
    await page.waitForTimeout(600);
    assert.equal(await page.$('#viewer .pane.live'), null);
    assert.equal(await page.$eval('#viewer .stage', s => s.classList.contains('headed')), false);
    const stage = await box(page, '#viewer .stage'),
      frame = await box(page, '#viewer .pane.after iframe');
    assert.ok(
      Math.abs(stage.width - frame.width) < 1 && Math.abs(stage.height - frame.height) < 1,
      'the frame fills it',
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

await browser.close();
server.close();
console.log(results.join('\n'));
if (results.some(r => r.startsWith('FAIL'))) process.exit(1);
