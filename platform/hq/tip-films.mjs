#!/usr/bin/env node
// The feature tips' films (shell/tips.js): one short silent film per tip with a scene, in every look HQ ships, so a tip
// plays in the look it's shown in. Each is HQ's dev mode on its sample data at a tablet's size, in the company's own
// theme, opened at the place the tip's Show me opens, with a finger using the feature once. It's recorded frame by frame
// on a fake clock (the demo kit's frames.mjs, as record.mjs does), cropped to where the feature happens and encoded small
// enough for a phone, to the company's theme/hq/films/<tip>-<look>.mp4 with its .render.json (HQ serves theme/hq over
// platform/hq, so the address stays films/<tip>-<look>.mp4). The scenes are in films/scenes.mjs. A changed screen gets
// its film again in one run.
//   node platform/hq/tip-films.mjs [tip] [look]     (every film, one tip's in every look, or one)
// A scene with a still also gets theme/hq/films/<tip>-<look>.jpg, the Library manual's tile
//:
//   node platform/hq/tip-films.mjs stills           (only the stills, from the films there)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { mockFiles, serve, ROOT } from './serve.mjs';
import { lookNames } from './looks.mjs';
import { TIPS, filmName } from './shell/tips.js';
import { FILMS, PREVIEW } from './films/scenes.mjs';
import { playwright, encoder, probe, companyTimeZone } from '../../shared/demo/core.mjs';
import { frameClock, tapAt, keystrokes } from '../../shared/demo/frames.mjs';
import { noteRender } from '../../shared/demo/renders.mjs';

const FPS = 24,
  VIEW = { width: 1180, height: 820 },
  SCALE = 1.25, // (the film's pixels per CSS pixel: a crop of the tool window comes out about 700 wide)
  T0 = new Date('2026-10-26T10:00:00Z');
const at = (...p) => join(ROOT, ...p);
// The film's clock is the one HQ shows: its mock org's time zone (the company's mock over the platform's), or with none
// (HQ then keeps the device's) the company's own, org.yaml's
const mockOrg = JSON.parse(
  await readFile(at('theme/hq/mock/org.json'), 'utf8').catch(() => readFile(at('platform/hq/mock/org.json'), 'utf8')),
);
const timezoneId = mockOrg.company?.timeZone ?? (await companyTimeZone());

const { chromium } = playwright();
if (process.argv[2] === 'stills') {
  for (const tip of TIPS.filter(t => FILMS[t.key]?.still != null)) for (const look of lookNames()) still(tip, look);
  process.exit(0);
}
const [onlyTip, onlyLook] = process.argv.slice(2);
const tips = TIPS.filter(t => FILMS[t.key] && (!onlyTip || t.key === onlyTip));
if (onlyTip && !tips.length) throw new Error(`${onlyTip}: no tip with a film by that name`);
const looks = lookNames().filter(l => !onlyLook || l === onlyLook);
// HQ as the company wears it, on the mock data
const server = await serve(undefined, 0, await mockFiles()),
  base = `http://localhost:${server.address().port}`;
// (a stand-in microphone for the call's film)
const browser = await chromium.launch({
  args: [
    '--font-render-hinting=none',
    '--hide-scrollbars',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
try {
  for (const tip of tips) for (const look of looks) await film(tip, look);
} finally {
  await browser.close();
  server.close();
}

async function film(tip, look) {
  const scene = FILMS[tip.key],
    out = at('theme/hq/films', filmName(tip.key, look));
  const { context, page, line, errors } = await open(scene);
  const rec = recorder(page, line, `${tip.key} in ${look}`);
  await page.goto(`${base}/?renderer=${look}&intro=0&hour=11&weather=clear`);
  await rec.until(() => document.querySelector('#loading.gone'));
  await rec.settle(1.5);
  await scene.start(rec.hq);
  await rec.settle(1.2);
  await rec.start(out, await cropOf(scene, rec.box), scene.scale ?? SCALE);
  await scene.play(rec.hq, look).catch(async e => {
    const shot = join(tmpdir(), 'tip-film-failed.png');
    await page.screenshot({ path: shot });
    throw new Error(`${tip.key} in ${look}: ${e.message} (the screen as it stopped: ${shot})`);
  });
  await rec.end();
  await context.close();
  noteRender(out, ['node', 'platform/hq/tip-films.mjs', tip.key, look], ROOT);
  if (scene.still != null) still(tip, look);
  const info = probe(out),
    said = errors.length ? `, page errors: ${errors.join(' | ')}` : '';
  console.log(
    `${tip.key} in ${look}: ${info.width}x${info.height}, ${info.duration.toFixed(1)} s, ${Math.round(info.size / 1024)} KB${said}`,
  );
}

// A film's still for the Library's manual: its frame at the scene's still, a phone screen's width at most.
function still(tip, look) {
  const film = at('theme/hq/films', filmName(tip.key, look)),
    out = at('theme/hq/films', filmName(tip.key, look, 'jpg'));
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-ss',
    `${FILMS[tip.key].still}`,
    '-i',
    film,
    '-frames:v',
    '1',
    '-vf',
    "scale='min(640,iw)':-2",
    '-q:v',
    '5',
    out,
  ]);
  console.log(`${tip.key} in ${look}: its still, ${Math.round(statSync(out).size / 1024)} KB`);
}

// A tablet with HQ's sound off and the book folded (the films show HQ, not the book), on a clock that stands still until
// it's run, with the scene's device and the stand-ins it needs: a preview's page, the coordinator's answers, review
// mode's layer (where HQ's pin lives) with nothing to coach, and the voice line, whose side of a call the film sends
async function open(scene) {
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: SCALE,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
    locale: 'en-GB',
    timezoneId,
  });
  await context.addInitScript(() => {
    localStorage.setItem('hq.sound', 'false');
    localStorage.setItem('hq.book.landscape', JSON.stringify({ mode: 'folded', book: null }));
  });
  if (scene.device) await context.addInitScript(scene.device);
  await context.route('https://*.preview.example.com/**', r => r.fulfill({ contentType: 'text/html', body: PREVIEW }));
  for (const [path, answer] of Object.entries(scene.api ?? {}))
    await context.route(`${base}${path}`, r =>
      r.fulfill({ json: typeof answer === 'function' ? answer(r.request().postDataJSON()) : answer }),
    );
  await context.route(`${base}/__review/**`, async r => {
    const name = new URL(r.request().url()).pathname.slice('/__review/'.length);
    if (name.endsWith('.js'))
      return r.fulfill({ contentType: 'text/javascript', body: await readFile(at('shared/review', name)) });
    if (name === 'mine') return r.fulfill({ json: { notes: 0, list: [], sent: false, more: false } });
    return r.fulfill({ json: name === 'coach' ? { show: false } : [] });
  });
  const line = { ws: null, send: ev => line.ws.send(JSON.stringify(ev)) };
  await context.routeWebSocket(/\/voice\/ws$/, ws => (line.ws = ws));
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(new Date(T0.getTime() + 1000));
  return { context, page, line, errors };
}

// The part of the screen a scene shows, in whole CSS pixels that make whole, even film pixels for the encoder
async function cropOf(scene, box) {
  const scale = scene.scale ?? SCALE,
    step = [...Array(100).keys()].find(k => k && Number.isInteger((k * scale) / 2)),
    whole = n => Math.floor(n / step) * step;
  const b =
    typeof scene.clip === 'function'
      ? await scene.clip(box)
      : scene.clip
        ? await box(scene.clip)
        : { x: 0, y: 0, ...VIEW };
  return { x: Math.round(b.x), y: Math.round(b.y), width: whole(b.width), height: whole(b.height) };
}

// The page's clock run in 100 ms steps, nothing recorded: until the page has what's waited for, or for a while
function unrecorded(page, what) {
  const step = () => page.clock.runFor(100).then(() => page.waitForTimeout(5));
  return {
    async until(test) {
      for (let t = 0; t < 20_000; t += 100) {
        if (await page.evaluate(test)) return;
        await step();
      }
      throw new Error(`${what}: waited 20 s for ${test}`);
    },
    async settle(s) {
      for (let t = 0; t < s * 1000; t += 100) await step();
    },
  };
}

// Frame by frame into the film, the page's clock run a frame at a time, with the finger drawn over it (frames.mjs)
function recorder(page, line, what) {
  const finger = { touch: true, x: 0, y: 0, show: 0, press: 0, ripples: [] };
  let cdp, enc, clip, scale;
  const clock = frameClock({
    page,
    fps: FPS,
    finger,
    capture: async () => {
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 92,
        clip: { ...clip, scale },
      });
      await enc.drained();
      enc.write(Buffer.from(data, 'base64'));
    },
  });
  const { until, settle } = unrecorded(page, what);
  const box = boxOn(page);
  return {
    until,
    settle,
    box,
    hq: actions(page, line, { until, box, clock, finger }),
    async start(out, crop, at) {
      clip = crop;
      scale = at;
      cdp = await page.context().newCDPSession(page);
      enc = encoder(out, { fps: FPS, duration: 0, crf: 30, maxrate: '1M', tune: 'animation' });
    },
    end: () => enc.end(),
  };
}

// A control's box on the page: a selector, a function finding it in the page, or a point
function boxOn(page) {
  return async target => {
    if (Array.isArray(target)) return { x: target[0], y: target[1], width: 0, height: 0 };
    if (typeof target === 'function') return (await page.evaluateHandle(target)).asElement().boundingBox();
    const found = page.locator(target).first();
    await found.waitFor({ state: 'visible', timeout: 5000 });
    return found.boundingBox();
  };
}

// What a scene does: wait, a finger's tap, typing at a person's pace, the voice line's side of a call, and anything run
// in the page
function actions(page, line, { until, box, clock, finger }) {
  return {
    page,
    wait: s => clock.during(s),
    eval: js => page.evaluate(js),
    until,
    line: ev => line.send(ev),
    async tap(target) {
      const b = await box(target),
        p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      await tapAt(clock, finger, p, { press: () => page.touchscreen.tap(p.x, p.y) });
    },
    async type(text, into, cps = 12) {
      if (into) await page.locator(into).first().focus();
      for (const [key, pause] of keystrokes(text, cps)) {
        await page.keyboard.type(key);
        await clock.during(pause);
      }
    },
  };
}
