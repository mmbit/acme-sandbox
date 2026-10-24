#!/usr/bin/env node
// HQ's pixel check: renders HQ from a git ref and from the working tree, scenario by scenario, and fails on any pixel off by more than 2 levels in a channel (TOLERANCE).
//   node platform/hq/pixel-check.mjs [--ref origin/main] [--only <scenario substring>] [--brand <file>]
// Both sides run in dev mode on the mock data, with a seeded Math.random and a paused clock, so a frame is a pure function of
// the code. It drives HQ only through the dev hooks the refactor keeps (world.paused, frame, cam, hit, S, L, R) and real input.
// Exit 1 on any such difference, with base/new/diff PNGs in a temp dir.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, ROOT } from './serve.mjs';
import { playwright } from '../../shared/browser/browser.mjs';
import { pin, track, settle, progress } from './harness.mjs';

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const REF = arg('--ref') ?? 'origin/main', ONLY = arg('--only');
const SOURCE = process.env.HQ_RENDER_SOURCE && JSON.parse(process.env.HQ_RENDER_SOURCE);
const BRAND = arg('--brand') && await readFile(arg('--brand')); // served as both sides' mock/brand.json

// ---------------------------------------------------------------- the two sides
const git = (...a) => promisify(execFile)('git', ['-C', ROOT, ...a], { encoding: 'buffer', maxBuffer: 1 << 28 }).then(r => r.stdout);
const sha = String(await git('rev-parse', '--verify', `${REF}^{commit}`)).trim(); // pinned: a moving branch can't change mid-run
const files = BRAND ? { 'mock/brand.json': BRAND } : {};
const servers = { base: await serve(p => git('show', `${sha}:${p}`), 0, files), new: await serve(p => readFile(join(ROOT, p)), 0, files) };

// ---------------------------------------------------------------- a page
const CLOCK = Date.parse('2026-06-15T12:00:00Z'); // a Monday in June without a holiday; scenarios pick hour and date in the URL
const DEVICES = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
async function open(browser, side, s) {
  const ctx = await browser.newContext({ ...DEVICES[s.device ?? 'desktop'], locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort()); // the same fallback font on both sides, never a download race
  await pin(ctx, CLOCK, !!s.walls);
  const page = track(await ctx.newPage());
  page.on('pageerror', e => console.error(`${s.name} (${side}): ${e.message}`));
  await page.goto(`http://localhost:${servers[side].address().port}/?${s.q}`);
  await page.waitForFunction(() => window.hq, null, { polling: 100 });
  await settle(page); // the boot's own requests (the desk phone's, the health check) answered before time moves
  return page;
}
// The visible page is the capture contract: a renderer may draw in the DOM, 2D or WebGL.
async function snap(page, label) {
  await settle(page);
  return { label, page: await page.screenshot({ animations: 'disabled', caret: 'hide' }) };
}
// Two PNGs (data URLs) compared in the page: the pixels differing by more than tol in a channel in red over a faded base.
const diff = (page, a, b, tol) => page.evaluate(async ([a, b, tol]) => {
  const px = async u => { const i = new Image(); i.src = u; await i.decode(); const c = Object.assign(document.createElement('canvas'), { width: i.width, height: i.height }), g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height); };
  const [x, y] = await Promise.all([px(a), px(b)]), out = new ImageData(x.width, x.height);
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    const same = x.width === y.width && x.height === y.height && [0, 1, 2, 3].every(k => Math.abs(x.data[i + k] - y.data[i + k]) <= tol);
    if (!same) n++;
    out.data.set(same ? [x.data[i] / 4 + 190, x.data[i + 1] / 4 + 190, x.data[i + 2] / 4 + 190, 255] : [255, 0, 0, 255], i);
  }
  const c = Object.assign(document.createElement('canvas'), { width: x.width, height: x.height });
  c.getContext('2d').putImageData(out, 0, 0);
  return [n, c.toDataURL()];
}, [a, b, tol]);

// ---------------------------------------------------------------- driving HQ
const hold = page => page.evaluate(() => { hq.world.paused = true; });
const frame = (page, t) => page.evaluate(t => hq.frame(t), t);
const run = (page, ms) => page.clock.runFor(ms);
// Where a finger would tap something of a kind (and in a room or agent id): the point nearest the middle of what hq.hit finds
const spot = (page, type, id) => page.evaluate(([type, id]) => {
  const pts = [];
  for (let y = 0; y < innerHeight; y += 4) for (let x = 0; x < innerWidth; x += 4) {
    const h = hq.hit(x, y);
    if (h?.type === type && (id == null || h.room === id || h.agent === id)) pts.push({ x, y });
  }
  if (!pts.length) throw new Error(`nothing of type ${type} ${id ?? ''} on screen`);
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length, my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return pts.reduce((a, p) => Math.hypot(p.x - mx, p.y - my) < Math.hypot(a.x - mx, a.y - my) ? p : a);
}, [type, id]);
// real input (a click on a selector or at a point, keys, the wheel over the middle of the screen), then what it set off
async function tap(page, at, double) {
  if (typeof at === 'string') await page.click(at);
  else await page.mouse[double ? 'dblclick' : 'click'](at.x, at.y);
  // the pointer off the page, as a lifted finger: left where it clicked, whatever opens under it was hovered on one side
  // and not the other, as Chromium's hover update after a layout raced the shot
  await page.mouse.move(0, 0);
  await settle(page);
}
const keys = async (page, list) => { for (const k of list) await page.keyboard.press(k); await settle(page); };
const wheel = async (page, dy) => { await page.mouse.move(640, 400); await page.mouse.wheel(0, dy); await settle(page); };
// a still zoomed in, the camera on what pick returns: a room's id (its middle, found with hq.hit, moved to the middle of
// the screen) or a point in world px
async function zoomOn(page, pick) {
  const id = await page.evaluate(pick);
  const p = typeof id === 'string' && await spot(page, 'room', id);
  await page.evaluate(([p, at]) => {
    const dpr = Math.min(devicePixelRatio, 2), cam = hq.cam;
    Object.assign(cam, p ? { x: cam.x + (p.x - innerWidth / 2) * dpr / cam.z, y: cam.y + (p.y - innerHeight / 2) * dpr / cam.z } : at, { t: null });
    cam.z = Math.round(4 * dpr);
  }, [p, id]);
}

// ---------------------------------------------------------------- scenarios
const still = (name, q, o = {}) => ({ name: `A ${name}`, q: `intro=0&${q}`, ...o, async run(page, shot) {
  await hold(page); await run(page, 100); // (the boot's zero-delay timers, like the Gazette's badge)
  if (o.zoom) await zoomOn(page, o.zoom);
  for (const t of o.at ?? [10]) { await frame(page, t); await shot(`t=${t}`); }
} });
const live = (name, act) => ({ name: `C ${name}`, q: 'intro=0&hour=12&weather=clear', async run(page, shot) {
  await run(page, 1000); await act(page, shot);
} });

const SCENARIOS = [
  still('03:00', 'hour=3'),
  still('07:00 fog, Halloween', 'hour=7&date=2026-10-30&weather=fog'),
  still('12:00 clear', 'hour=12&weather=clear'),
  still('16:00 rain', 'hour=16&weather=rain'),
  still('19:30', 'hour=19.5'),
  still('23:00', 'hour=23'),
  still('12-24 17:00 snow', 'hour=17&date=2026-12-24&weather=snow'),
  still('12-31 23:30', 'hour=23.5&date=2026-12-31'),
  still('09-25 bunting', 'hour=12&date=2026-09-25&weather=clear'),
  still('walls on', 'hour=12&weather=clear', { walls: true }),
  still('zoomed on the lobby', 'hour=12&weather=clear', { zoom: () => hq.L().rooms.find(r => r.kind === 'lobby').id }),
  still('zoomed on the penthouse', 'hour=21&weather=clear', { zoom: () => hq.L().pent.id }),
  still('zoomed on the basement', 'hour=12&weather=clear', { zoom: () => hq.L().rooms.find(r => r.level < 0 && r.wing !== 'core').id }),
  still('billboard', 'hour=12&weather=clear', { walls: true, at: [1.8, 5.3, 9, 13, 16.5, 19.8, 23.6, 27.6] }),
  // what the brand draws: the rooftop sign, the plaque over the front door, the billboard's logo and a slide of words
  still('zoomed on the sign', 'hour=21&weather=clear', { walls: true, zoom: () => { const h = hq.R.sign.hot; return { x: (h.x0 + h.x1) / 2, y: (h.y0 + h.y1) / 2 }; } }),
  still('zoomed on the plaque', 'hour=12&weather=clear', { walls: true, zoom: () => { const e = hq.R.facade.levels[0].extra; return { x: e.x + e.img.width / 2, y: e.y }; } }),
  still('zoomed on the billboard', 'hour=12&weather=clear', { walls: true, at: [1.8, 10], zoom: () => { const m = hq.R.facade.screen.mask; return { x: m.x + m.img.width / 2, y: m.y + m.img.height / 2 }; } }),
  still('iPhone', 'hour=12&weather=clear', { device: 'phone' }),
  still('tablet at night', 'hour=22&weather=clear', { device: 'tablet' }),

  // the loop from boot (the floors dropping in) with the dev event script: chats, paper planes, posts, people walking
  { name: 'B the loop with the event script', q: 'hour=12&weather=clear', async run(page, shot) {
    for (const s of [10, 20, 30]) { await run(page, 10_000); await shot(`${s} s`); }
  } },

  live('tap an agent', async (page, shot) => { await tap(page, await spot(page, 'agent')); await run(page, 3000); await shot('3 s'); }),
  live('double-tap a room', async (page, shot) => { await tap(page, await spot(page, 'room'), true); await run(page, 3000); await shot('3 s'); }),
  live('wheel', async (page, shot) => {
    await wheel(page, -120); await run(page, 2000); await shot('in');
    await wheel(page, 120); await run(page, 2000); await shot('out');
  }),
  live('arrow keys', async (page, shot) => { await keys(page, ['+', 'ArrowLeft', 'ArrowLeft', 'ArrowUp']); await run(page, 2000); await shot('panned'); }),
  live('zoom buttons', async (page, shot) => {
    for (const b of ['#zin', '#zin', '#zout', '#zfit']) { await tap(page, b); await run(page, 1500); await shot(`after ${b}`); }
  }),
  live('tour', async (page, shot) => { await tap(page, '#btn-tour'); await run(page, 8000); await shot('8 s'); }),
  live('walls', async (page, shot) => {
    await tap(page, '#btn-walls'); await run(page, 400); await shot('lowering'); await run(page, 1000); await shot('on');
  }),
  live('konami', async (page, shot) => {
    await keys(page, ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']);
    await run(page, 3000); await shot('3 s');
  }),
  live('orb', async (page, shot) => { await tap(page, await spot(page, 'orb')); await run(page, 3000); await shot('3 s'); }),
  live('water tower', async (page, shot) => {
    for (let i = 1; i <= 3; i++) { await tap(page, await spot(page, 'weather')); await run(page, 2000); await shot(`pick ${i}`); }
  }),
  live('pet the mascot', async (page, shot) => { await tap(page, await spot(page, 'cat')); await run(page, 1500); await shot('1.5 s'); }),
  live('cocktail bar', async (page, shot) => { // a round shaken, poured and slid along; a second tap pours the next drink
    const at = await spot(page, 'bar');
    await tap(page, at); await run(page, 600); await shot('shaken'); await run(page, 700); await shot('poured');
    await tap(page, at); await run(page, 2500); await shot('two rounds');
  }),
  live('the lent machine', async (page, shot) => { // the rig, tapped: its own page in the machines' settings
    await tap(page, await spot(page, 'machine', await page.evaluate(() => globalThis.hq.L().rig))); await run(page, 1500); await shot('its settings');
  }),
  live('directory, fly to', async (page, shot) => {
    await tap(page, '#btn-computer'); await tap(page, '[data-app=people]'); await run(page, 300); await shot('directory');
    await tap(page, '#crt section:nth-of-type(2) [data-person]'); await run(page, 3000); await shot('flown');
  }),
  live('HQ-OS apps', async (page, shot) => {
    await tap(page, '#btn-computer'); await run(page, 300); await shot('home');
    for (const app of await page.$$eval('[data-app]', bs => bs.map(b => b.dataset.app))) {
      await tap(page, `[data-app=${app}]`); await run(page, 300); await shot(app);
      if (await page.$('[data-home]')) await tap(page, '[data-home]');
      else { await tap(page, '#btn-computer'); await run(page, 300); } // an app that's a view (Projects): the computer made way
    }
  }),
  live('Gazette', async (page, shot) => {
    await tap(page, '#btn-news'); await run(page, 500); await shot('list');
    await tap(page, '#panel .card'); await run(page, 500); await shot('post');
  }),
  live('Library', async (page, shot) => { await tap(page, await spot(page, 'search')); await run(page, 500); await shot('open'); }),
  live('phone', async (page, shot) => { await tap(page, '#btn-desk'); await run(page, 1000); await shot('open'); }),
  live('intercom', async (page, shot) => { await tap(page, '#btn-intercom'); await run(page, 1000); await shot('open'); }),
];

// ---------------------------------------------------------------- the check
let out = arg('--out'); // the temp dir, made at the first difference
// A page shot may differ by 2 levels in a channel: Chromium's compositor draws the same rounded corner's edge pixel a
// level or two apart now and then, the same code on both sides, more often on a machine with more cores
const TOLERANCE = 2;
async function report(page, name, label, a, b) {
  const url = buf => `data:image/png;base64,${buf.toString('base64')}`;
  const [n, d] = await diff(page, url(a), url(b), TOLERANCE);
  if (!n) return [];
  const base = join(out ??= await mkdtemp(join(tmpdir(), 'pixel-check-')), name.replace(/[^\w.=-]+/g, '-'));
  const png = u => Buffer.from(u.split(',')[1], 'base64');
  await Promise.all([writeFile(`${base}-base.png`, a), writeFile(`${base}-new.png`, b), writeFile(`${base}-diff.png`, png(d))]);
  return [`${label}: ${n} px`];
}
async function check(browser, s) {
  const sides = await Promise.all(['base', 'new'].map(async side => {
    const page = await open(browser, side, s), shots = [];
    await s.run(page, async label => { shots.push(await snap(page, label)); });
    return { page, shots };
  }));
  const [a, b] = sides, bad = [];
  for (const [i, x] of a.shots.entries()) {
    const y = b.shots[i], name = `${s.name} ${i + 1} ${x.label}`;
    if (!x.page.equals(y.page)) {
      bad.push(...await report(a.page, name, x.label, x.page, y.page));
    }
  }
  await Promise.all(sides.map(x => x.page.context().close()));
  return { n: a.shots.length, bad };
}

const todo = SCENARIOS.filter(s => !ONLY || s.name.includes(ONLY)), started = Date.now();
const browser = await playwright().chromium.launch({ args: ['--font-render-hinting=none'] });
let failed = 0, shots = 0;
await Promise.all(Array.from({ length: 2 }, async () => {
  for (let s; (s = todo.shift());) {
    const r = await check(browser, s).catch(e => ({ n: 0, bad: [`error: ${e.message.split('\n')[0]}`] }));
    progress();
    shots += r.n; if (r.bad.length) failed++;
    console.log(`${r.bad.length ? 'DIFF' : 'ok  '}  ${s.name} (${r.n} shots)${r.bad.map(b => `\n        ${b}`).join('')}`);
  }
}));
await browser.close();
for (const s of Object.values(servers)) s.close();
console.log(`${failed ? `${failed} scenarios differ` : 'no differences'}: ${shots} shots against ${SOURCE?.ref ?? REF} (${(SOURCE?.baseCommit ?? sha).slice(0, 8)}) in ${Math.round((Date.now() - started) / 1000)} s${out ? `; PNGs in ${out}` : ''}`);
process.exit(failed ? 1 : 0);
