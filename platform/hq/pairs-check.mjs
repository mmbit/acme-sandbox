#!/usr/bin/env node
// A card that brings work back on the desk phone, held like a phone and a tablet: each change's before and after lead
// it, side by side, with its live link under them (opening HQ's viewer, where review mode runs), then HQ's two answers
// in place of the card's own choices and an answer box, and its text under More; a tap opens the pairs in one viewer
// (→ and ← switch before and after in place, ↓ and ↑ go between pairs, by keys, swipes and its own keys, in every look),
// "Add notes" answers with review, and the answered card shows the pairs again. No label
// of the two answers and Call is cut off.
//   node platform/hq/pairs-check.mjs [--browser chromium|webkit]… [--shots <dir>]
// HQ on its own files with a fake /api, in Chromium and WebKit (set up as copy-check.mjs says).
const { chromium, webkit } = await import('/opt/node22/lib/node_modules/playwright/index.mjs').catch(
  () => import('/usr/local/lib/node_modules/playwright/index.mjs'),
); // (the server's, else a seat's)
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { serve, ROOT } from './serve.mjs';

const args = process.argv.slice(2),
  arg = k => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const BROWSERS = { chromium, webkit },
  WHICH = arg('--browser').length ? arg('--browser') : ['chromium', 'webkit'],
  SHOTS = arg('--shots')[0];
const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  'small phone': { width: 360, height: 740 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
}; // (the small phone and the desktop, for the one row)
// the looks the viewer is checked in besides the brownstone, in Chromium (Holo's scene crashes a headless Chromium at
// desktop size, on its own)
const SMOOTH = [
  ['holo', 'phone'],
  ['wire', 'phone'],
  ['wire', 'desktop'],
];
const TAP = { timeout: 90_000 };

const LINK = 'https://front.preview.example.org/en/about-us/';
const BODY = `Both of your notes on the shop front are fixed, in all three languages.

Before and after:
- About us, who we are: products/_cycles/t/about-before.png products/_cycles/t/about-after.png ${LINK}
- The delivery box's footnote: products/_cycles/t/box-before.png products/_cycles/t/box-after.png

Choose:
- Good now
- More changes

---
The two links became buttons side by side.`;
const card = {
  id: 1,
  created: new Date().toISOString(),
  agent: 'wren',
  kind: 'decision',
  title: 'Shop front, good now?',
  body: BODY, // its stored Choose: list must not show beside HQ's answers
  urgency: 'today',
  back: true,
};
const sent = []; // the answers the desk phone posted
const answered = { ...card, status: 'answered', answer: 'Good now', answered: new Date().toISOString() };

const server = await serve(),
  base = `http://localhost:${server.address().port}`;
let failed = false;
for (const name of WHICH)
  for (const [size, viewport] of Object.entries(VIEWPORTS)) {
    try {
      await check(name, size, viewport);
      console.log(`pairs-check ${name} ${size}: the pairs lead, the link under them, the text under More`);
    } catch (err) {
      failed = true;
      console.error(`pairs-check ${name} ${size}: ${err.message}`);
    }
  }
for (const [look, size] of SMOOTH) {
  try {
    await viewerIn(look, size, VIEWPORTS[size]);
    console.log(`pairs-check ${look} ${size}: the pairs in one viewer`);
  } catch (err) {
    failed = true;
    console.error(`pairs-check ${look} ${size}: ${err.message}`);
  }
}
server.close();
process.exit(failed ? 1 : 0);

async function check(name, size, viewport) {
  const browser = await BROWSERS[name].launch();
  try {
    const pictures = await picturesFrom(browser);
    const { page, errors, shot } = await openCard(
      browser,
      viewport,
      pictures,
      file => `pairs-${name}-${size}-${file}.png`,
    );
    await pairsLead(page);
    await shot('card');
    await views(page, shot);
    await linkOpensViewer(page);
    await leavesNotes(page);
    await archiveShows(page, shot);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

// The viewer alone, in a smooth look
async function viewerIn(look, size, viewport) {
  const browser = await chromium.launch();
  try {
    const pictures = await picturesFrom(browser);
    const { page, errors, shot } = await openCard(
      browser,
      viewport,
      pictures,
      file => `pairs-${look}-${size}-${file}.png`,
      look,
    );
    await views(page, shot);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

// Four pictures as a phone shoots them (780 px wide), each with its name on it, so a mix-up shows
async function picturesFrom(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 520 }, deviceScaleFactor: 2 });
  const pictures = {};
  for (const [file, tall, tone] of [
    ['about-before', 520, '#f6d8c4'],
    ['about-after', 380, '#cfe8d2'],
    ['box-before', 300, '#f6d8c4'],
    ['box-after', 300, '#cfe8d2'],
  ]) {
    await page.setViewportSize({ width: 390, height: tall });
    await page.setContent(
      `<body style="margin:0;height:${tall}px;background:${tone};font:24px sans-serif;display:grid;place-items:center">${file}</body>`,
    );
    pictures[`/cycles/t/${file}.png`] = await page.screenshot();
  }
  await page.close();
  return pictures;
}

// HQ with the fake /api and the pictures, the desk phone open on the card
async function openCard(browser, viewport, pictures, named, look = 'brownstone') {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route(`${base}/cycles/**`, r => {
    const picture = pictures[new URL(r.request().url()).pathname];
    return picture ? r.fulfill({ contentType: 'image/png', body: picture }) : r.fulfill({ status: 404, body: '' });
  });
  await ctx.route(`${base}/api/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/org') return r.fulfill({ path: join(ROOT, 'platform/hq/mock/org.json') });
    if (path === '/api/requests') return r.fulfill({ json: [card] });
    if (path === '/api/requests/answer')
      return (sent.push(r.request().postDataJSON()), r.fulfill({ json: { ok: true } }));
    if (path === '/api/preview/link') return r.fulfill({ json: { url: r.request().postDataJSON().url } });
    if (path === '/api/requests/archive') return r.fulfill({ json: { cards: [answered], more: false, total: 1 } });
    if (path === '/api/seen') return r.fulfill({ json: {} });
    if (['/api/gazette', '/api/mail', '/api/review/products'].includes(path)) return r.fulfill({ json: [] });
    return r.fulfill({ status: 404, body: '' });
  });
  const page = await ctx.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const shot = file => SHOTS && page.screenshot({ path: join(SHOTS, named(file)) });
  await page.goto(`${base}/?intro=0&renderer=${look}`);
  await page.waitForSelector('#loading.gone', { timeout: 60_000 });
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
  await page.waitForSelector('#phone-screen .req .pairs');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.req .pairs img')].every(i => i.complete && i.naturalWidth),
  );
  return { page, errors, shot };
}

// Under the title: each change, before then after, its link under them; the words under More
async function pairsLead(page) {
  const seen = await page.evaluate(() => {
    const screen = document.querySelector('#phone-screen');
    const pairs = [...screen.querySelectorAll('.req .pair')].map(p => ({
      label: p.querySelector('figcaption').textContent,
      pictures: [...p.querySelectorAll('img')].map(i => new URL(i.src).pathname),
      tags: [...p.querySelectorAll('.ba span')].map(s => s.textContent),
      link: p.querySelector('.live a')?.href ?? null,
    }));
    const before = screen.querySelector('.req h3').nextElementSibling;
    return {
      pairs,
      first: before?.classList.contains('pairs'),
      shownWords: [...screen.querySelectorAll('.req > .body')].map(b => b.textContent).join(' '),
    };
  });
  assert.deepEqual(
    seen.pairs.map(p => [p.label, p.pictures, p.tags, p.link]),
    [
      ['About us, who we are', ['/cycles/t/about-before.png', '/cycles/t/about-after.png'], ['Before', 'After'], LINK],
      [
        "The delivery box's footnote",
        ['/cycles/t/box-before.png', '/cycles/t/box-after.png'],
        ['Before', 'After'],
        null,
      ],
    ],
  );
  assert.ok(seen.first, 'the pairs come right under the title');
  assert.doesNotMatch(seen.shownWords, /all three languages|buttons side by side/, 'no text above the fold');
  const more = page.locator('.req details.more');
  assert.equal(await more.evaluate(d => d.open), false);
  assert.match(await more.textContent(), /all three languages[\s\S]*buttons side by side/);
  assert.equal(await page.locator('.req .pics').count(), 0, "the pairs' pictures aren't shown again below");
}

// A tap on an after picture opens it in the viewer, and a tap on it closes it. One on a before picture opens the card's
// pairs: → shows the pair's after in the same place and size (a shorter picture, drawn from the same top at the same
// width), ↓ the next pair at its before, ↑ and ← back, keys past
// the ends change nothing, and Escape closes the viewer alone. Sideways and upward swipes and the viewer's own keys do the
// same, and a swipe closes nothing.
async function views(page, shot) {
  await page.tap('.req .pair:first-child .ba button:nth-child(2)', TAP);
  assert.deepEqual(await shown(page), [
    'about-after',
    'About us, who we are (after)',
    'About us, who we areafter1 of 2',
  ]);
  await page.tap('.pic-stage', TAP);
  assert.equal(await page.locator('.pic-zoom').count(), 0);

  await page.tap('.req .pair:first-child .ba button:nth-child(1)', TAP);
  const before = await shown(page),
    place = await placeOf(page);
  assert.deepEqual(before, ['about-before', 'About us, who we are (before)', 'About us, who we arebefore1 of 2']);
  await shot('viewer');
  const keys = [
    ['ArrowRight', 'about-after'],
    ['ArrowRight', 'about-after'],
    ['ArrowDown', 'box-before'],
    ['ArrowDown', 'box-before'],
    ['ArrowRight', 'box-after'],
    ['ArrowUp', 'about-before'],
    ['ArrowUp', 'about-before'],
    ['ArrowRight', 'about-after'],
    ['ArrowLeft', 'about-before'],
  ];
  for (const [key, file] of keys) {
    await page.keyboard.press(key);
    assert.equal((await shown(page))[0], file, `${key} shows ${file}`);
    if (file.startsWith('about'))
      assert.deepEqual(spot(await placeOf(page)), spot(place), `${file} in the same place and size`);
  }
  await turned(page);
  await page.keyboard.press('ArrowRight');
  await shot('viewer-after');

  const swipes = [
    [-120, 0, 'about-after'],
    [0, -160, 'box-before'],
    [-120, 0, 'box-after'],
    [120, 0, 'box-before'],
    [0, 160, 'about-before'],
  ];
  for (const [dx, dy, file] of swipes) {
    await swipe(page, dx, dy);
    assert.equal((await shown(page))[0], file, `a swipe by ${dx}, ${dy} shows ${file}`);
  }
  for (const [button, file] of [
    ['[data-side=after]', 'about-after'],
    ['[data-go="1"]', 'box-before'],
    ['[data-side=after]', 'box-after'],
    ['[data-go="-1"]', 'about-before'],
  ]) {
    await page.tap(`.pic-keys ${button}`, TAP);
    assert.equal((await shown(page))[0], file, `${button} shows ${file}`);
  }
  assert.ok(await page.locator('.pic-keys [data-go="-1"]').isDisabled(), 'no previous at the first pair');

  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.pic-zoom').count(), 0);
  assert.ok(await page.locator('#phone-screen .req').isVisible(), 'Escape leaves the phone open');
  await page.tap('.req .pair:first-child .ba button:nth-child(1)', TAP);
  await page.tap('.pic-close', TAP);
  assert.equal(await page.locator('.pic-zoom').count(), 0);
}
// The picture the viewer shows (its file's name), its words and the viewer's heading
function shown(page) {
  return page.evaluate(() => {
    const z = document.querySelector('.pic-zoom'),
      img = [...z.querySelectorAll('.pic-stage img')].filter(i => getComputedStyle(i).visibility === 'visible');
    if (img.length !== 1) return [`${img.length} pictures`];
    return [img[0].src.replace(/^.*\/|\.png$/g, ''), img[0].alt, z.querySelector('.pic-head p').textContent];
  });
}
// Where the shown picture is drawn on the stage, and its size: the bounds of its light pixels over the viewer's dark
// stage, read from a screenshot
async function placeOf(page) {
  const stage = await page.locator('.pic-stage').boundingBox(),
    shot = await page.screenshot({ clip: stage });
  return page.evaluate(async png => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const canvas = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
      g = canvas.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, img.width, img.height),
      lit = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] <= 450) continue;
      const x = (i / 4) % img.width,
        y = Math.floor(i / 4 / img.width);
      Object.assign(lit, {
        left: Math.min(lit.left, x),
        top: Math.min(lit.top, y),
        right: Math.max(lit.right, x),
        bottom: Math.max(lit.bottom, y),
      });
    }
    return { left: lit.left, top: lit.top, width: lit.right - lit.left + 1, height: lit.bottom - lit.top + 1 };
  }, shot.toString('base64'));
}
function spot({ left, top, width }) {
  return { left, top, width };
}

// Turned sideways, the pair fits the stage again: its taller picture, the before, fills the stage's width or height, and
// the after still lands where it was
async function turned(page) {
  const { width, height } = page.viewportSize();
  await page.setViewportSize({ width: height, height: width });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const stage = await page.locator('.pic-stage').boundingBox(),
    before = await placeOf(page);
  await page.keyboard.press('ArrowRight');
  const after = await placeOf(page);
  await page.keyboard.press('ArrowLeft');
  await page.setViewportSize({ width, height });
  assert.deepEqual(spot(after), spot(before), 'turned, the after in the same place and size');
  assert.ok(
    stage.width - before.width <= 2 || stage.height - before.height <= 2,
    `turned, the pair fills the stage (${before.width}x${before.height} in ${stage.width}x${stage.height})`,
  );
}

// A finger's swipe over the picture, from its middle, in steps
async function swipe(page, dx, dy) {
  const r = await page.locator('.pic-stage').boundingBox(),
    x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
  assert.equal(await page.locator('.pic-zoom').count(), 1, 'a swipe closes nothing');
}

// The answered card, from Answered: its pairs lead again, the card's words folded under it
async function archiveShows(page, shot) {
  await page.tap('[data-past]', TAP);
  await page.tap('[data-card="0"]', TAP);
  await page.waitForSelector('.req.past .pairs');
  assert.equal(await page.locator('.req.past .pair').count(), 2);
  assert.equal(await page.locator('.req.past .pics').count(), 0);
  assert.match(await page.locator('.req.past details.more').textContent(), /all three languages/);
  await shot('answered');
}

// The two answers and Call, in that order, every label whole
async function oneRow(page) {
  const buttons = await page.$$eval('.req .btns button', all =>
    all.map(b => ({ id: b.id, clipped: b.scrollWidth > b.clientWidth })),
  );
  assert.deepEqual(
    buttons.map(b => b.id),
    ['send-answer', 'in-review', 'call-about'],
  );
  assert.deepEqual(
    buttons.filter(b => b.clipped),
    [],
    'no label cut off',
  );
}

// The link under a pair opens the page in HQ's viewer, where review mode runs, and Close comes back to the card
async function linkOpensViewer(page) {
  await page.tap('.req .pair .live a', TAP);
  await page.waitForSelector('#viewer:not([hidden]) iframe');
  assert.match(await page.textContent('#viewer .bar .where'), /front/);
  await page.tap('#viewer [data-close]', TAP);
  assert.ok(await page.locator('#viewer').isHidden());
}

// HQ's two answers, no box to type changes in; "Add notes" answers with review, nothing typed
async function leavesNotes(page) {
  assert.deepEqual(await page.locator('.req .btns .send').allTextContents(), ['Good now', 'Add notes']);
  await oneRow(page);
  assert.equal(await page.locator('.req #answer, .req #answer-mic, .req .choices').count(), 0);
  const before = sent.length;
  await page.tap('#in-review', TAP);
  await page.waitForFunction(() => document.querySelector('.req.done') || !document.querySelector('.req'));
  assert.deepEqual(
    sent.slice(before).map(b => [b.id, b.answer, b.review]),
    [[1, '', true]],
  );
}
