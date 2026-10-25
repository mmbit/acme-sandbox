#!/usr/bin/env node
// A walk-through call watched back in HQ (shell/callplayer.js on shared/watchalong/player.js): the call log's Watch it
// back opens the player on the call's recording, streamed as the coordinator sends it (gzipped NDJSON, its head first).
// Checks, on an iPad mini (744 × 1133, touch) and a laptop (1280 × 800), in every look: the replay draws the recorded
// page, the scrubber has its ticks (taps, pages, ink), a moment jumps the replay there (the basket page shows once its
// moment is tapped), the pen's stroke is drawn over the replay as it was drawn, play moves the time on, a drag on the
// scrubber (a mouse, and a finger in Chromium) moves the replay, the keys (Space, the arrows) and speed work, the notes
// and what we heard are beside the moments, and Escape closes the player alone. In Chromium it measures the frame times
// while playing and dragging with the CPU slowed 4×.
//   node platform/hq/callplayer-check.mjs [--shots dir]   (BROWSER=webkit for Safari's engine; both: BROWSER=all)
// The recording: shared/watchalong/walk.test.json.gz (moments.test.ts says what's in it) with a pen stroke added,
// circling "Add to basket".
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage, until, tap } from '../../shared/browser/browser.mjs';
import { Moments } from '../../shared/watchalong/moments.ts';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const LOOKS = process.env.LOOK ? [process.env.LOOK] : ['brownstone', 'wire', 'holo'];
const VIEWS = {
  ipad: { viewport: { width: 744, height: 1133 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  laptop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
};

// ---- the recording: the walk-through and a stroke circling the button it tapped
const WALK = JSON.parse(
  gunzipSync(await readFile(join(ROOT, 'shared/watchalong/walk.test.json.gz'))).toString('utf8'),
).flat();
const T0 = WALK[0].timestamp;
const add = WALK.find(e => e.type === 5 && e.data.tag === 'tap' && e.data.payload.label === 'Add to basket').data
  .payload;
const INK_AT = T0 + 6500,
  INK_MS = 700;
const ring = Array.from({ length: 29 }, (_, i) => {
  const a = (i / 28) * Math.PI * 2 - Math.PI / 2;
  return [add.x + Math.cos(a) * 70, add.y + Math.sin(a) * 30, 0.55, Math.round((i / 28) * INK_MS)];
});
const stroke = { color: '#ff5a5f', size: 5, points: ring };
const inkEvent = (dt, payload) => ({
  type: 5,
  timestamp: INK_AT + dt,
  data: { tag: 'ink', payload: { n: 1, id: 1, ...payload } },
});
const INK = [
  inkEvent(0, { phase: 'start', stroke: { ...stroke, points: ring.slice(0, 1) }, left: 0, top: 0, halo: true }),
  ...[1, 2, 3, 4, 5, 6].map(k =>
    inkEvent(k * 100, { phase: 'move', points: ring.filter(p => p[3] > (k - 1) * 100 && p[3] <= k * 100) }),
  ),
  inkEvent(INK_MS, {
    phase: 'end',
    stroke,
    left: 0,
    top: 0,
    halo: true,
    box: { x: add.x - 72, y: add.y - 32, width: 144, height: 64 },
    under: [{ label: 'Add to basket', role: 'button' }],
  }),
];
const EVENTS = [...WALK, ...INK].sort((a, b) => a.timestamp - b.timestamp);
const moments = new Moments();
moments.add(EVENTS);
moments.settle(Infinity);
const MOMENTS = moments.list;
const CALLS = JSON.parse(await readFile(join(ROOT, 'platform/hq/mock/calls.json'), 'utf8'));
const CALL = CALLS.find(c => c.reply && c.items?.length);
const HEAD = {
  clockMs: 0,
  moments: MOMENTS,
  start: T0,
  end: EVENTS.at(-1).timestamp,
  agent: CALL.agent,
  ts: CALL.ts,
  request: CALL.request,
  notes: CALL.reply,
  items: CALL.items,
};
const BODY = gzipSync([HEAD, ...EVENTS].map(line => `${JSON.stringify(line)}\n`).join(''));
const momentOf = words => MOMENTS.findIndex(m => m.words.includes(words));
assert.ok(momentOf('circled "Add to basket"') >= 0, `the stroke is a moment: ${MOMENTS.map(m => m.words).join(' | ')}`);

// The shop's mug, as a picture
const MUG = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
<rect width="96" height="96" rx="12" fill="#f6efe4"/><path d="M26 30h38v34a12 12 0 0 1-12 12H38a12 12 0 0 1-12-12z" fill="#e8574f"/>
<path d="M64 38h6a9 9 0 0 1 0 18h-6" fill="none" stroke="#e8574f" stroke-width="6"/><path d="M36 22c0-5 6-5 6-10M48 22c0-5 6-5 6-10" fill="none" stroke="#c9b9a6" stroke-width="3" stroke-linecap="round"/></svg>`;

// ---- HQ in dev mode, with the player's files and the recording's route as the coordinator serves them
const REPLAY = join(ROOT, 'platform/coordinator/node_modules/@rrweb/replay/dist');
const files = { 'mock/calls.json': JSON.stringify(CALLS.map(c => ({ ...c, recorded: c.id === CALL.id }))) };
for (const name of ['player.js', 'scrubber.js', 'strokes.js', 'replay.html', 'replay.js'])
  files[`shared/watchalong/${name}`] = await readFile(join(ROOT, 'shared/watchalong', name));
for (const name of ['watchalong.js', 'canvas.js'])
  files[`shared/watchalong/${name}`] = await readFile(join(ROOT, 'shared/watchalong', name));
files['shared/watchalong/vendor/rrweb-record.js'] = await readFile(
  join(ROOT, 'platform/coordinator/node_modules/@rrweb/record/dist/record.js'),
);
files['shared/watchalong/vendor/rrweb-replay.js'] = await readFile(join(REPLAY, 'replay.js'));
files['shared/watchalong/vendor/rrweb-replay.css'] = await readFile(join(REPLAY, 'style.css'));
const server = await serve(undefined, 0, files);
const hq = server.listeners('request')[0];
server.removeAllListeners('request');
let asked = 0,
  served = BODY; // (the walk-through, or HQ's own recording for the frame times)
server.on('request', (req, res) => {
  if (!req.url.startsWith('/api/calls/recording')) return hq(req, res);
  asked++;
  assert.equal(new URL(req.url, 'http://x').searchParams.get('call'), String(CALL.id));
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'content-encoding': 'gzip' });
  // (in two parts, a moment apart: the player starts on the first)
  const body = served,
    cut = Math.floor(body.length / 2);
  res.write(body.subarray(0, cut));
  setTimeout(() => res.end(body.subarray(cut)), 300);
});
const base = `http://localhost:${server.address().port}`;

const { chromium, webkit } = playwright();
const engines = process.env.BROWSER === 'all' ? ['chromium', 'webkit'] : [process.env.BROWSER ?? 'chromium'];
const timings = [];
for (const engine of engines) {
  const browser = await (engine === 'webkit' ? webkit : chromium).launch();
  for (const [view, options] of Object.entries(VIEWS))
    for (const look of LOOKS) await watch(browser, engine, view, options, look);
  if (engine === 'chromium') timings.push(await frameTimes(browser));
  await browser.close();
}
// (a step that fails says what the page said meanwhile)
async function watch(browser, engine, view, options, look) {
  const { context, page, errors } = await openPage(browser, options);
  if (engine === 'webkit') await context.addInitScript(isoDays);
  // (the recorded shop's picture, as the board's browser would load it: without it the page shifts up and the stroke,
  // drawn where the button was, lands below it)
  await context.route('http://shop.test/mug.png', route => route.fulfill({ contentType: 'image/svg+xml', body: MUG }));
  page.on(
    'console',
    m => m.type() === 'error' && !/favicon|Failed to load resource|preconnect/.test(m.text()) && errors.push(m.text()),
  );
  try {
    await watchBack(page, errors, engine, view, look);
  } catch (err) {
    console.error(`${engine} ${view} ${look}: the page's errors: ${errors.join(' | ') || 'none'}`);
    if (shots) await page.screenshot({ path: join(shots, `failed-${engine}-${view}-${look}.png`) });
    throw err;
  } finally {
    await context.close();
  }
}
server.close();
for (const t of timings) console.log(t);
console.log(
  `callplayer-check: ok (${engines.join(', ')}; ${Object.keys(VIEWS).length} screens × ${LOOKS.length} looks)`,
);

async function watchBack(page, errors, engine, view, look) {
  const label = `${engine} ${view} ${look}`;
  await page.goto(`${base}/?renderer=${look}&intro=0&hour=12&weather=clear&open=computer`);
  await page.click('[data-app="calls"]');
  await page.waitForSelector('.cp-watch');
  assert.equal(await page.locator('.cp-watch').count(), 1, `${label}: one call to watch back`);
  if (shots && view === 'ipad') await shot(page.locator('.device'), `calllog-${look}`, engine);
  await tap(page, '.cp-watch'); // (the call log redraws now and then)
  await page.waitForSelector('dialog.cp[open] .wp-replay', { state: 'attached' });
  await page.waitForFunction(() => document.querySelector('.wp-replay')?.style.visibility === '', null, {
    timeout: 15_000,
  });
  const replayed = () =>
    page.evaluate(
      () =>
        document.querySelector('.wp-replay').contentDocument.querySelector('.replayer-wrapper iframe')?.contentDocument
          ?.body?.innerText ?? '',
    );
  await page.waitForFunction(
    () =>
      /mug/i.test(
        document.querySelector('.wp-replay').contentDocument.querySelector('.replayer-wrapper iframe')?.contentDocument
          ?.body?.innerText ?? '',
      ),
    null,
    { timeout: 10_000 },
  );
  assert.equal(asked > 0, true);

  // the scrubber's ticks, the moments and the notes beside them
  const ticks = await page.$$eval('.wp-tick', ts => ts.map(t => t.className.replace('wp-tick ', '')));
  for (const kind of ['wp-tick-tap', 'wp-tick-page', 'wp-tick-ink'])
    assert.ok(ticks.includes(kind), `${label}: a ${kind} on the scrubber (${ticks})`);
  assert.equal(await page.locator('.wp-moment').count(), MOMENTS.length, `${label}: every moment listed`);
  await until(page, '.wp-more', /notes/);
  assert.equal(await page.locator('.wp-more .heard li').count(), CALL.items.length, `${label}: what we heard`);
  // (it all loads: the scrubber's loaded bar full)
  await page.waitForFunction(
    () => /scaleX\(1(\.0+)?\)/.test(document.querySelector('.wp-loaded').style.transform),
    null,
    { timeout: 10_000 },
  );

  // a moment jumps there: the basket page
  await page.locator('.wp-moment').nth(momentOf('on /basket')).click();
  await page.waitForFunction(
    () =>
      /basket/i.test(
        document.querySelector('.wp-replay').contentDocument.querySelector('.replayer-wrapper iframe')?.contentDocument
          ?.body?.innerText ?? '',
      ),
    null,
    { timeout: 5_000 },
  );
  assert.match(await page.textContent('.wp-moment[aria-current]'), /basket/, `${label}: the moment marked`);
  assert.match(await replayed(), /Pay/, `${label}: the basket page on the replay`);
  if (shots) await shot(page.locator('.wp-stage'), `basket-${view}-${look}`, engine);

  // the ink, drawn by the end of its stroke: red on the canvas around the button, nothing before the stroke began
  await page.locator('.wp-moment').nth(momentOf('circled')).click();
  const red = () =>
    page.evaluate(() => {
      const c = document.querySelector('.wp-ink'),
        d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] < 140) n++;
      return n;
    });
  await page.waitForTimeout(150);
  assert.ok((await red()) > 200, `${label}: the stroke drawn (${await red()} red pixels)`);
  if (shots) await shot(page.locator('dialog.cp'), `player-${view}-${look}`, engine);
  await page.locator('.wp-moment').nth(momentOf('tapped "Name on the mug"')).click();
  await page.waitForTimeout(150);
  assert.equal(await red(), 0, `${label}: no ink before the stroke`);

  // play: the time goes on, and the scrubber with it
  const seconds = () => page.$eval('.wp-scrub', s => Number(s.getAttribute('aria-valuenow')));
  const before = await seconds();
  await page.click('.wp-play');
  await page.waitForTimeout(2200);
  assert.ok((await seconds()) >= before + 1, `${label}: playing (${before} → ${await seconds()})`);
  assert.equal(await page.$eval('.wp-play', b => b.classList.contains('playing')), true, `${label}: still playing`);
  await page.keyboard.press(' ');
  assert.equal(await page.$eval('.wp-play', b => b.classList.contains('playing')), false, `${label}: Space pauses`);
  // the arrows: 5 s back and on
  const at = await seconds();
  await page.keyboard.press('ArrowRight');
  assert.equal(await seconds(), at + 5, `${label}: → goes 5 s on`);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await seconds(), at, `${label}: ← goes 5 s back`);
  await page.click('.wp-speed');
  assert.equal(await page.textContent('.wp-speed'), '2×');

  // a drag on the scrubber, with a mouse (a pen's and a finger's pointer events are the same)
  const track = await page.locator('.wp-track').boundingBox();
  const y = track.y + track.height / 2;
  await page.mouse.move(track.x + track.width * 0.1, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(track.x + track.width * (0.1 + i * 0.08), y);
  assert.equal(await page.$eval('.wp-scrub', s => s.classList.contains('held')), true, `${label}: held while dragged`);
  await page.mouse.up();
  const span = (HEAD.end - HEAD.start) / 1000;
  assert.ok(Math.abs((await seconds()) - span * 0.9) <= 1, `${label}: dragged to 90% (${await seconds()} of ${span})`);
  assert.match(await replayed(), /Pay|basket/i, `${label}: the replay followed the drag`);
  if (engine === 'chromium' && view === 'ipad') await fingerDrag(page, track, label);

  // Escape closes the player alone: the call log is still there
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog.cp', { state: 'detached' });
  assert.equal(await page.locator('.cp-watch').count(), 1, `${label}: back on the call log`);
  assert.deepEqual(errors, [], `${label}: no errors`);
}

// Playwright's Linux WebKit has no en-CA locale data (Safari has), so its days come out as 10/24/2026: they're made
// YYYY-MM-DD from their parts, as the company's clock (shared/format) reads them
function isoDays() {
  const Format = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function (locale, options) {
    const format = new Format(locale === 'en-CA' ? 'en-US' : locale, options);
    if (locale !== 'en-CA') return format;
    const iso = at => {
      const part = type => format.formatToParts(at).find(p => p.type === type)?.value;
      return `${part('year')}-${part('month')}-${part('day')}`;
    };
    return {
      format: iso,
      formatToParts: at => format.formatToParts(at),
      resolvedOptions: () => format.resolvedOptions(),
    };
  };
  Intl.DateTimeFormat.prototype = Format.prototype;
  Intl.DateTimeFormat.supportedLocalesOf = Format.supportedLocalesOf;
}

// A finger's drag on the scrubber (Chromium's touch events, through DevTools)
async function fingerDrag(page, track, label) {
  const cdp = await page.context().newCDPSession(page);
  const y = track.y + track.height / 2,
    point = f => [{ x: track.x + track.width * f, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(0.8) });
  for (let i = 1; i <= 8; i++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(0.8 - i * 0.08) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const span = (HEAD.end - HEAD.start) / 1000,
    now = await page.$eval('.wp-scrub', s => Number(s.getAttribute('aria-valuenow')));
  assert.ok(Math.abs(now - span * 0.16) <= 1, `${label}: a finger dragged it to 16% (${now} of ${span})`);
  await cdp.detach();
}

// HQ itself recorded on an iPad's screen as the board's call records it (its canvas at 0.5 frames a second) while the
// computer's apps and the desk phone open, for the frame times: a heavier recording than the walk-through
async function recordHq(browser) {
  const { context, page } = await openPage(browser, VIEWS.ipad);
  const batches = [];
  await context.route(`${base}/watchalong-events`, route => {
    batches.push(JSON.parse(route.request().postData()));
    route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${base}/?renderer=brownstone&intro=0&hour=12&weather=clear`);
  await until(page, '#loading.gone');
  await page.evaluate(async () => {
    const { watch } = await import('/shared/watchalong/watchalong.js');
    window.watching = watch({ url: '/watchalong-events', typed: 'shown', canvasFps: 0.5 });
  });
  const desk = (fn, ...a) => page.evaluate(([fn, a]) => import('/shell/desk.js').then(m => m[fn](...a)), [fn, a]);
  for (const app of ['calls', 'notes', 'mail', 'people', 'projects', 'seats']) {
    await desk('openComputer', app, { force: true });
    await page.waitForTimeout(2500);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(1500);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.watching.stop());
  await context.close();
  return batches.flatMap(batch => batch.events);
}

// Frame times with the CPU slowed 4× (an iPad mini's A15 runs Safari some 2–4× slower than this machine's Chromium), on
// HQ's own recording: from Watch it back to the first screen, playing at 1× and 4×, a finger scrubbing back and forth,
// and the longest jump back (a seek back rebuilds the replay from its snapshot)
async function frameTimes(browser) {
  const events = await recordHq(browser);
  const kept = new Moments();
  kept.add(events);
  kept.settle(Infinity);
  const head = { ...HEAD, moments: kept.list, start: events[0].timestamp, end: events.at(-1).timestamp };
  served = gzipSync([head, ...events].map(line => `${JSON.stringify(line)}\n`).join(''));
  const canvases = events.filter(e => e.type === 3 && e.data.source === 9).length;
  const { context, page } = await openPage(browser, VIEWS.ipad);
  const cdp = await context.newCDPSession(page);
  await page.goto(`${base}/?renderer=brownstone&intro=0&hour=12&weather=clear&open=computer`);
  await page.click('[data-app="calls"]');
  await page.waitForSelector('.cp-watch');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const opened = Date.now();
  await tap(page, '.cp-watch');
  await page.waitForFunction(() => document.querySelector('.wp-replay')?.style.visibility === '', null, {
    timeout: 30_000,
  });
  const firstScreen = Date.now() - opened;
  await page.waitForFunction(
    () => /scaleX\(1(\.0+)?\)/.test(document.querySelector('.wp-loaded').style.transform),
    null,
    { timeout: 30_000 },
  );
  const record = () =>
    page.evaluate(() => {
      window.frames_ = [];
      let last = performance.now();
      const step = now => {
        window.frames_.push(now - last);
        last = now;
        window.frameStep_ = requestAnimationFrame(step);
      };
      window.frameStep_ = requestAnimationFrame(step);
    });
  const stats = name =>
    page.evaluate(name => {
      cancelAnimationFrame(window.frameStep_);
      const f = window.frames_.slice(2).sort((a, b) => a - b),
        q = p => f[Math.min(f.length - 1, Math.floor(p * f.length))].toFixed(1);
      return `${name}: ${f.length} frames, median ${q(0.5)} ms, 95th ${q(0.95)} ms, worst ${f.at(-1).toFixed(1)} ms, over 50 ms: ${f.filter(t => t > 50).length}`;
    }, name);
  const lines = [
    `HQ's own recording: ${events.length} events, ${canvases} canvas pictures, ${(served.length / 1e6).toFixed(1)} MB gzipped, ${((head.end - head.start) / 1000).toFixed(0)} s; the first screen ${firstScreen} ms after the tap (CPU 4× slower)`,
  ];
  for (const speed of ['1×', '4×']) {
    while ((await page.textContent('.wp-speed')) !== speed) await page.click('.wp-speed');
    await page.locator('.wp-moment').first().click();
    await record();
    await page.click('.wp-play');
    await page.waitForTimeout(speed === '1×' ? 6000 : 4000);
    await page.click('.wp-play');
    lines.push(await stats(`playing at ${speed}`));
  }
  const track = await page.locator('.wp-track').boundingBox();
  const y = track.y + track.height / 2;
  await record();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: track.x + 4, y }] });
  for (let i = 0; i < 120; i++) {
    const f = 0.5 - 0.5 * Math.cos((i / 60) * Math.PI);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: track.x + 4 + f * (track.width - 8), y }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  lines.push(await stats('a finger scrubbing back and forth'));
  // the longest jump back: from the last moment to the first
  await page.locator('.wp-moment').last().click();
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => {
    const t = performance.now();
    document.querySelector('.wp-moment').click();
    return performance.now() - t;
  });
  lines.push(`the last moment to the first: ${back.toFixed(0)} ms`);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await context.close();
  served = BODY;
  return lines.join('\n');
}

// A small JPEG of a part of the page (under 200 KB), once it holds still
async function shot(locator, name, engine) {
  const file = join(shots, `${name}${engine === 'chromium' ? '' : `-${engine}`}.jpg`);
  await locator.page().waitForTimeout(500);
  const clip = await locator.boundingBox();
  await writeFile(file, await locator.page().screenshot({ type: 'jpeg', quality: 70, scale: 'css', clip }));
}
