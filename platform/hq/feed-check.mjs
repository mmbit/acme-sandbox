#!/usr/bin/env node
// HQ's Numbers printout feed, measured: does the paper come out of the computer smoothly on the board's own screens?
//   node platform/hq/feed-check.mjs [--ref <commit>]… [--browser chromium|webkit] [--screens <file>] [--only <screen>]…
//     [--runs <n>] [--shots <dir>]
// HQ in dev mode (serve.mjs, on its mock data) at the board's screens, in Playwright Chromium and WebKit. On each, three
// times a tap on an app on the computer's Numbers home, each in a fresh page:
// 1. stages: the dashboard's animations paused at four points of the motion, a screenshot each (in --shots, default
//    $TMPDIR/feed-shots); this also says when the motion starts and how long it runs.
// 2. frames: from the tap, 2.5 s (or to 250 ms after the motion ends) of frames timed in the page with
//    requestAnimationFrame, after a second of idle frames for comparison. It times frames, not how the feed is built, so
//    an old feed and a new one measure alike. Chromium also traces it (paints, layouts, style recalcs, layer-tree updates,
//    raster time, long tasks, frames shown whole, partial or dropped) and runs the first phone once more with its CPU
//    slowed 4×.
// 3. reduced motion: with prefers-reduced-motion the dashboard comes with no animation in the computer.
// The screens: as shared/deck/check.mjs has them, a company's board's in company/screens.json (or --screens <file>), each
// { name, width, height, touch, ratio: device pixels per CSS pixel (default 1), mobile: a phone's or tablet's browser };
// without one, a generic phone, tablet, laptop and monitor. A mobile screen under 500 px either way is a phone.
// --only: the screens whose name has that in it (repeat it for more); none matching is an error.
// --ref: the commit to serve HQ from (git show; a file it lacks comes from the working tree); repeat it to compare,
// `worktree` is the working tree (the default). --runs: time each screen n times, show the median run (by its worst frame).
// Exit 1 if a frame of the feed takes over 50 ms (the feed: every frame after the dashboard's first layout and paint,
// which are shown as "render" but not judged), or if reduced motion animates. Not judged: the cpu×4 run, and a screen whose
// idle frames already go over 50 ms (a software renderer on a busy machine can't judge a feed).
// WebKit needs Playwright's WebKit build and the system libraries it lists (`npx playwright install-deps webkit`, or
// unpacked into a folder without root); Chromium needs nothing.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, ROOT } from './serve.mjs';
import { playwright, errorsOf } from '../../shared/browser/browser.mjs';

const { chromium, webkit } = playwright();
const args = process.argv.slice(2), arg = k => args.flatMap((a, i) => a === k ? [args[i + 1]] : []);
const RUNS = Number(arg('--runs')[0] ?? 1), REFS = arg('--ref').length ? arg('--ref') : ['worktree'], ONLY = arg('--only'), SHOTS = arg('--shots')[0] ?? join(tmpdir(), 'feed-shots');
const BROWSERS = { chromium, webkit }, WHICH = arg('--browser').length ? arg('--browser') : ['chromium', 'webkit'];
const WINDOW = 2500, LONG = 25, FAIL = 50, JITTER = 1; // ms (a gap of three 60 Hz frames, 50.0 ms give or take a hair, isn't over 50)

const OWN = arg('--screens')[0] ?? join(ROOT, 'company/screens.json');
if (arg('--screens').length && !existsSync(OWN)) { console.error(`feed-check: no such screens file: ${OWN}`); process.exit(1); }
const SCREENS = (existsSync(OWN) ? JSON.parse(await readFile(OWN)).screens : [
  { name: 'phone portrait', width: 390, height: 844, touch: true, ratio: 3, mobile: true },
  { name: 'tablet portrait', width: 820, height: 1180, touch: true, ratio: 2, mobile: true },
  { name: 'laptop', width: 1440, height: 800, ratio: 2 }, { name: 'QHD monitor', width: 2560, height: 1300 },
]).filter(s => !ONLY.length || ONLY.some(o => s.name.includes(o)))
  .map(s => ({ name: s.name, short: `${s.width}x${s.height}@${s.ratio ?? 1}`, viewport: { width: s.width, height: s.height },
    deviceScaleFactor: s.ratio ?? 1, isMobile: !!s.mobile, hasTouch: !!s.touch }));
if (!SCREENS.length) { console.error(`feed-check: no screen ${ONLY.length ? `named like ${ONLY.map(o => `"${o}"`).join(' or ')} ` : ''}in ${OWN}`); process.exit(1); }
const PHONE = SCREENS.find(s => s.isMobile && Math.min(s.viewport.width, s.viewport.height) < 500); // (slowed 4× too, in Chromium)

const git = (...a) => promisify(execFile)('git', ['-C', ROOT, ...a], { encoding: 'buffer', maxBuffer: 1 << 28 }).then(r => r.stdout);
const fromTree = p => readFile(join(ROOT, p));
async function reader(ref) {
  if (ref === 'worktree') return fromTree;
  const sha = String(await git('rev-parse', '--verify', `${ref}^{commit}`)).trim();
  return p => git('show', `${sha}:${p}`).catch(() => fromTree(p));
}

// ---------------------------------------------------------------- one screen in one browser
// HQ open on the Numbers home, settled, with a recorder in the page: frame times and the moment the dashboard went in.
// window: how long after the tap to record; cpu: Chromium's CPU slowed that many times.
async function numbersHome(browser, base, screen, { reducedMotion = 'no-preference', window = WINDOW } = {}) {
  const { short, name, cpu = 1, ...device } = screen;
  const ctx = await browser.newContext({ ...device, reducedMotion, serviceWorkers: 'block', locale: 'en-GB' });
  const page = await ctx.newPage(), errors = errorsOf(page);
  if (cpu > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: cpu });
  await page.goto(`${base}/?intro=0&open=computer`);
  await tap(page, screen, '[data-app="numbers"]');
  await page.waitForSelector('[data-nx-app]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800); // HQ's own loading settles
  await page.evaluate(window => {
    const f = self.feed = { click: null, dash: null, frames: [] };
    // what's animating in the computer on its way in (a cursor's endless blink isn't)
    f.moving = () => document.getAnimations().filter(a => a.effect?.target?.closest?.('#crt') && isFinite(a.effect.getComputedTiming().endTime));
    document.addEventListener('click', () => { f.click ??= performance.now(); console.timeStamp('feed-click'); }, { capture: true });
    new MutationObserver(() => { if (f.click && !f.dash && !document.querySelector('#crt [data-nx-app]')) f.dash = performance.now(); })
      .observe(document.querySelector('#crt'), { childList: true, subtree: true });
    const tick = t => { f.frames.push(t); if (!f.click || t < f.click + window) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, window);
  return { ctx, page, errors };
}
const tap = (page, screen, sel) => screen.hasTouch ? page.tap(sel) : page.click(sel);

// The frames from the tap on. The dashboard goes in between two frames (r-1, r) and is laid out and painted around frame r,
// so render is the longer of the two gaps around it; the feed is every frame after that (from: its start, page time).
function frames({ click, dash, frames }) {
  // (the frames over the feed alone: fps, worst, and how many over 25 and over 50 ms)
  const gaps = t => t.slice(1).map((x, i) => x - t[i]), fps = t => (t.length - 1) / ((t.at(-1) - t[0]) / 1000);
  const idle = frames.filter(x => x < click), t = frames.filter(x => x >= click), g = gaps(t), r = t.findIndex(x => x > dash);
  const render = r < 0 ? [] : g.slice(Math.max(r - 1, 0), r + 1), feed = r < 0 ? [] : g.slice(r + 1);
  return { idle: fps(idle), idleWorst: Math.max(...gaps(idle)), fps: fps(t.slice(r + 1)), dash: dash - click, render: Math.max(...render),
    from: t[r + 1] - click, worst: Math.max(...feed), over: feed.filter(x => x > LONG).length, fail: r < 0 ? 1 : feed.filter(x => x > FAIL + JITTER).length };
}

// Chromium's trace over the feed (from: ms after the tap): what the page's main thread and the compositor did.
const CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'cc', 'viz', 'benchmark', 'toplevel'];
function trace(events, viewport, after, window) {
  const mark = events.find(e => e.name === 'TimeStamp' && e.args?.data?.message === 'feed-click'); // the tap, in trace time (µs)
  if (!mark || !isFinite(after)) return null;
  const from = mark.ts + after * 1000, to = mark.ts + window * 1000, on = e => e.ts >= from && e.ts <= to;
  const main = events.filter(e => on(e) && e.pid === mark.pid && e.tid === mark.tid), count = n => main.filter(e => e.name === n).length;
  const paints = main.filter(e => e.name === 'Paint'), nodes = {};
  paints.forEach(e => { const n = e.args?.data?.nodeName ?? '?'; nodes[n] = (nodes[n] ?? 0) + 1; });
  const area = paints.reduce((s, e) => { // a paint's clip is a quad (maybe endless): its box, cut to the screen's size
    const c = e.args?.data?.clip ?? [], xs = c.filter((_, i) => i % 2 === 0), ys = c.filter((_, i) => i % 2);
    const w = Math.min(viewport.width, Math.max(...xs) - Math.min(...xs)), h = Math.min(viewport.height, Math.max(...ys) - Math.min(...ys));
    return s + (xs.length ? w * h : 0);
  }, 0) / (viewport.width * viewport.height);
  // a frame's state, per frame: whole beats partial beats dropped across the reporters of one frame
  const state = {};
  for (const e of events) if (e.name === 'PipelineReporter' && e.ph === 'b' && on(e)) {
    const r = e.args?.frame_reporter ?? {}, s = r.state ?? '';
    if (s === 'STATE_NO_UPDATE_DESIRED') continue;
    const rank = { STATE_PRESENTED_ALL: 3, STATE_PRESENTED_PARTIAL: 2, STATE_DROPPED: 1 }[s] ?? 0;
    state[r.frame_sequence] = Math.max(state[r.frame_sequence] ?? 0, rank);
  }
  const st = Object.values(state);
  return { paint: paints.length, nodes, area, layout: count('Layout'), style: count('UpdateLayoutTree'), layers: count('Layerize'),
    raster: events.filter(e => on(e) && e.name === 'RasterTask').reduce((s, e) => s + (e.dur ?? 0) / 1000, 0),
    long: main.filter(e => /RunTask$/.test(e.name) && e.dur > 50000).length,
    whole: st.filter(x => x === 3).length, partial: st.filter(x => x === 2).length, dropped: st.filter(x => x === 1).length };
}

async function measure(browser, kind, base, screen, window) {
  const { ctx, page, errors } = await numbersHome(browser, base, screen, { window });
  if (kind === 'chromium') await browser.startTracing(page, { categories: CATEGORIES });
  await page.waitForTimeout(1000); // a second of frames before the tap: what this page does idle, here
  await tap(page, screen, '[data-nx-app]');
  await page.waitForFunction(w => self.feed.click && performance.now() > self.feed.click + w, window, { timeout: 30000 });
  const f = frames(await page.evaluate(() => self.feed));
  const t = kind === 'chromium' ? trace(JSON.parse(await browser.stopTracing()).traceEvents, screen.viewport, f.from, window) : null;
  await ctx.close();
  return { ...f, trace: t, errors };
}

// The motion's stages: tap again, catch the dashboard's animations as they start, pause them at four points, a shot each.
// (Wall-clock shots if the feed has no Web Animations, say if a script moves it.)
async function stages(browser, kind, base, screen, label) {
  const { ctx, page } = await numbersHome(browser, base, screen);
  await tap(page, screen, '[data-nx-app]');
  const start = await page.evaluate(async wait => {
    for (;;) {
      const now = performance.now(), on = self.feed.moving();
      if (on.length) { on.forEach(a => a.pause()); return { at: now - self.feed.click, end: Math.max(...on.map(a => a.effect.getComputedTiming().endTime)) }; }
      if (now > self.feed.click + wait) return null;
      await new Promise(r => requestAnimationFrame(r));
    }
  }, WINDOW + 1500);
  const shot = (i, ms) => page.screenshot({ path: join(SHOTS, `${label}-${kind}-${file(screen.short)}-${i}-${Math.round(ms)}ms.png`) });
  for (const [i, part] of [0.1, 0.35, 0.6, 0.9].entries()) {
    if (start) await page.evaluate(t => self.feed.moving().forEach(a => { a.pause(); a.currentTime = t; }), part * start.end);
    else await page.waitForFunction(t => performance.now() > self.feed.click + t, part * 1800);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await shot(i + 1, start ? start.at + part * start.end : part * 1800);
  }
  await ctx.close();
  return start; // when it started moving after the tap, and for how long (ms)
}

// Reduced motion: the dashboard is there at once, and nothing in the computer animates on its way in.
async function still(browser, kind, base, screen, label) {
  const { ctx, page } = await numbersHome(browser, base, screen, { reducedMotion: 'reduce' });
  await tap(page, screen, '[data-nx-app]');
  const seen = await page.evaluate(async () => {
    const found = new Set();
    while (performance.now() < self.feed.click + 1500) {
      self.feed.moving().forEach(a => found.add(a.animationName || a.id || a.constructor.name));
      await new Promise(r => requestAnimationFrame(r));
    }
    return [...found];
  });
  const dash = await page.evaluate(() => self.feed.dash && self.feed.dash - self.feed.click);
  await page.screenshot({ path: join(SHOTS, `${label}-${kind}-${file(screen.short)}-reduced.png`) });
  await ctx.close();
  return { ok: !seen.length && dash != null, seen, dash };
}

// ---------------------------------------------------------------- all of it
await mkdir(SHOTS, { recursive: true });
const ms = x => isFinite(x) ? `${Math.round(x)}` : '-', file = x => x.replace(/[^\w.-]+/g, '_'), fails = [], notes = [];
for (const ref of REFS) {
  const label = file(ref), server = await serve(await reader(ref)), base = `http://localhost:${server.address().port}`;
  for (const kind of WHICH) {
    const browser = await BROWSERS[kind].launch().catch(e => { fails.push(`${kind} won't start: ${e.message.split('\n')[0]}`); });
    if (!browser) continue;
    // each page in a browser of its own, and a second go if the page crashes: headless WebKit's web process here sometimes
    // dies on the tap when the machine is busy (seen on the phone, old feed and new alike)
    const once = async f => { const b = await BROWSERS[kind].launch(); try { return await f(b); } finally { await b.close().catch(() => {}); } };
    const fresh = f => once(f).catch(e => { if (!/closed|crash/i.test(e.message)) throw e; notes.push(`${kind}: a page crashed, run again`); return once(f); });
    const trace = kind === 'chromium' ? ['paint', 'area', 'layout', 'style', 'layers', 'raster', 'long', 'whole/part/drop'] : [];
    console.log(`\n${ref} · ${kind} ${browser.version()}${RUNS > 1 ? ` · the median of ${RUNS} runs` : ''}`);
    console.log(['screen'.padEnd(18), 'idle', 'in', 'render', 'fps', 'worst', `>${LONG}`, `>${FAIL}`, 'moves', ...trace, 'reduced'].join('\t'));
    const runs = SCREENS.flatMap(s => [s, ...(kind === 'chromium' && s === PHONE ? [{ ...s, short: `${s.short} cpu×4`, cpu: 4 }] : [])]);
    for (const screen of runs) try {
      // the stages first: when the motion starts and ends sets how long to record (at least 2.5 s from the tap)
      const st = await fresh(b => stages(b, kind, base, screen, label)), window = Math.max(WINDOW, st ? st.at + st.end + 250 : 0);
      const all = []; for (let i = 0; i < RUNS; i++) all.push(await fresh(b => measure(b, kind, base, screen, window)));
      const m = all.sort((a, b) => a.worst - b.worst)[RUNS >> 1], t = m.trace; // the median run, by its worst frame
      const rm = screen.cpu ? null : await fresh(b => still(b, kind, base, screen, label));
      console.log([screen.short.padEnd(18), `${ms(m.idle)}/${ms(m.idleWorst)}`, ms(m.dash), ms(m.render), ms(m.fps), ms(m.worst), m.over, m.fail,
        st ? `${ms(st.at)}+${ms(st.end)}` : 'none',
        ...(t ? [t.paint, t.area.toFixed(1), t.layout, t.style, t.layers, ms(t.raster), t.long, `${t.whole}/${t.partial}/${t.dropped}`] : trace.map(() => '?')),
        rm ? (rm.ok ? 'still' : 'MOVES') : ''].join('\t'));
      if (t?.paint) console.log(`  painted in the feed: ${Object.entries(t.nodes).map(([n, c]) => `${n} ×${c}`).join(', ')}`);
      const at = `${ref} ${kind} ${screen.short}`;
      if (m.errors.length) fails.push(`${at}: page errors: ${m.errors.join('; ')}`);
      // judged only where this machine shows the page smoothly when idle (a slow software renderer can't judge a feed)
      if (m.fail && !screen.cpu) (m.idleWorst > FAIL ? notes : fails).push(`${at}: ${m.fail} frame(s) over ${FAIL} ms in the feed (worst ${ms(m.worst)} ms)${m.idleWorst > FAIL ? `, not judged: idle frames here already reach ${ms(m.idleWorst)} ms` : ''}`);
      if (rm && !rm.ok) fails.push(`${at}: with reduced motion ${rm.dash == null ? 'no dashboard came' : `it still animates (${rm.seen.join(', ')})`}`);
    } catch (e) { console.log(`${screen.short.padEnd(18)}\tbroke: ${e.message.split('\n')[0]}`); fails.push(`${ref} ${kind} ${screen.short}: ${e.message.split('\n')[0]}`); }
    await browser.close();
  }
  server.close();
}
console.log(`
idle: fps / longest frame (ms) in the second before the tap · in: ms from the tap to the dashboard going in
render: the longest frame (ms) around the dashboard's first layout and paint, not judged
the feed: every frame after render, to ${WINDOW} ms after the tap or 250 ms after the motion ends · fps, worst (ms), >${LONG}, >${FAIL}: its frames
moves: when the feed's animations start after the tap + how long they run (ms) · reduced: with prefers-reduced-motion
Chromium, over the feed: paint: Paint events · area: painted area, in screens · layout · style: style recalcs · layers: layer-tree updates
(Layerize) · raster: ms rasterising · long: tasks over 50 ms · whole/part/drop: frames shown whole, partial (without the main thread's
update) or dropped · cpu×4: the CPU slowed 4×, not judged · shots: ${SHOTS}`);
if (notes.length) console.log(`\n- ${notes.join('\n- ')}`);
if (fails.length) { console.log(`\nfeed-check: FAIL\n- ${fails.join('\n- ')}`); process.exit(1); }
console.log(`\nfeed-check: no frame of the feed over ${FAIL} ms${notes.length ? ' where judged' : ''}, and reduced motion stays still`);
