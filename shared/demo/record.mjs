#!/usr/bin/env node
// node shared/demo/record.mjs flow.json [--out rec.mp4] [--viewport phone|desktop]
// Drives a real app through scripted steps and records it frame by frame at a fixed fps with a faked clock
// (Date, timers, rAF via page.clock; CSS animations/transitions seeked via document.getAnimations()), so
// the result is smooth and identical every run. Shows a finger dot (phone) or a cursor (desktop).
// Flow format: see shared/demo/README.md. Demo data only, never customer data (house rule 7).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { args, playwright, encoder, probe } from './core.mjs';
import { noteRender } from './renders.mjs';
import { keysOf, pricesFor } from './prices.mjs';

const VIEWPORTS = { phone: { width: 360, height: 640, scale: 3, touch: true }, desktop: { width: 1280, height: 720, scale: 1.5 } };
const a = args();
const flowFile = a._[0];
if (!flowFile) { console.error('usage: node shared/demo/record.mjs flow.json [--out rec.mp4] [--viewport phone|desktop]'); process.exit(1); }
const flow = JSON.parse(readFileSync(flowFile, 'utf8'));
const rel = (p) => resolve(dirname(flowFile), p);
const fps = Number(a.fps ?? flow.fps ?? 30);
const vps = [a.viewport ?? flow.viewport ?? 'phone'].flat();

const freePort = () => new Promise((ok) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function startServer() {
  if (!flow.serve) return { origin: '', stop() {} };
  const port = await freePort();
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', rel(flow.serve)], { env: { ...process.env, PORT: String(port) }, stdio: 'inherit' });
  // localhost, not 127.0.0.1: a payment engine run locally may send a buyer back to localhost only
  const origin = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(origin + (flow.url ?? '/')); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  return { origin, stop: () => p.kill() };
}

// In-page overlay: finger dot / cursor and tap ripples, drawn from state we pass each frame. Its look is a constructed
// stylesheet and its positions are set through the element's style, both of which a page's CSP allows: a <style> or a
// style="" in markup would be dropped under `style-src 'self'`, and the cursor drawn as a huge unstyled blob
function overlay(s) {
  let host = document.getElementById('__demo_cursor');
  if (!host) {
    host = document.createElement('div'); host.id = '__demo_cursor';
    Object.assign(host.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
    const root = host.attachShadow({ mode: 'open' }), sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      .f{position:absolute;width:40px;height:40px;margin:-20px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#fff,#e8e8ee);
        opacity:.8;box-shadow:0 3px 10px rgba(0,0,0,.35),inset 0 0 0 1.5px rgba(0,0,0,.12)}
      .c{position:absolute;width:24px;height:24px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
      .r{position:absolute;border-radius:50%;border:3px solid rgba(255,255,255,.95);box-shadow:0 0 0 2px rgba(0,0,0,.18)}`);
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = '<div class="f"></div><svg class="c" viewBox="0 0 24 24"><path d="M3 2l17 10.5-7.3 1.3 4.3 7.7-3.2 1.7-4.2-7.7L3 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><div class="rs"></div>';
    document.documentElement.append(host);
  }
  const r = host.shadowRoot, f = r.querySelector('.f'), c = r.querySelector('.c');
  f.style.display = s.touch ? '' : 'none'; c.style.display = s.touch ? 'none' : '';
  f.style.transform = `translate(${s.x}px,${s.y}px) scale(${1 - 0.18 * s.press})`; f.style.opacity = 0.82 * s.show;
  c.style.transform = `translate(${s.x - 3}px,${s.y - 2}px) scale(${1 - 0.1 * s.press})`; c.style.opacity = s.show;
  r.querySelector('.rs').replaceChildren(...s.ripples.map(({ x, y, k }) => { const d = (s.touch ? 30 : 16) + k * (s.touch ? 60 : 40);
    const ring = document.createElement('div'); ring.className = 'r';
    Object.assign(ring.style, { left: `${x - d / 2}px`, top: `${y - d / 2}px`, width: `${d}px`, height: `${d}px`, opacity: (1 - k) ** 1.5 });
    return ring; }));
}
// Seek every CSS animation/transition to our virtual clock. A paused one never finishes, so once the clock passes the
// end of one that plays forward and ends, finish() it: its `finished` promise and finish/animationend events fire on
// that frame. finish() throws for a zero playback rate, so a stopped or reversed one is only seeked. One the page plays
// again (no longer finished) is picked up afresh.
function syncAnimations(now) {
  for (const an of document.getAnimations()) {
    if (an.__demoDone && an.playState === 'finished') continue;
    if (an.__demoStart === undefined || an.__demoDone) {
      an.__demoStart = now - (an.currentTime ?? 0);
      an.__demoDone = false;
      an.pause();
    }
    const elapsed = now - an.__demoStart, endTime = an.effect?.getComputedTiming().endTime;
    if (an.playbackRate > 0 && Number.isFinite(endTime) && elapsed >= endTime) {
      an.finish();
      an.__demoDone = true;
    } else {
      an.currentTime = elapsed;
    }
  }
}

const ease = (k) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);
const T0 = new Date(flow.time ?? '2026-09-27T10:00:00');

async function recordOne(name) {
  const vp = typeof name === 'object' ? name : VIEWPORTS[name];
  const out = a.out ? resolve(a.out) : rel(flow.out ?? flowFile.replace(/\.json$/, '.mp4')).replace(/\.mp4$/, vps.length > 1 ? `-${name}.mp4` : '.mp4');
  const srv = await startServer();
  const { chromium } = playwright();
  // date and time fields follow the browser process's language, not the context's locale: without LANG they show US
  // formats (03/14/2026, 02:30 PM) whatever `locale` says. flow.locale: 'en-GB' (14/03/2026, 14:30) or 'nl-NL' (14-03-2026)
  const locale = flow.locale ?? 'en-GB', posix = locale.replace('-', '_');
  // flow.camera: a Y4M film the page's camera shows instead of a real one, already allowed
  const camera = flow.camera ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${rel(flow.camera)}`] : [];
  const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--hide-scrollbars', ...camera], env: { ...process.env, LANG: `${posix}.UTF-8`, LANGUAGE: posix } });
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.scale, hasTouch: !!vp.touch, isMobile: !!vp.touch, locale, timezoneId: 'Europe/Amsterdam', permissions: flow.camera ? ['camera'] : [] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(new Date(T0.getTime() + 1000));
  const cdp = await ctx.newCDPSession(page);
  const enc = encoder(out, { fps, duration: 0, crf: Number(flow.crf ?? 18), maxrate: '10M', level: '4.2' });
  const cur = { touch: !!vp.touch, x: vp.width * 0.62, y: vp.height * 0.8, show: vp.touch ? 0 : 1, press: 0, ripples: [] };
  let vt = 0, frame = 0;
  const events = [], mark = (type, what) => events.push({ t: +(frame / fps).toFixed(3), type, ...what }); // when each action shows, for syncing sounds

  // A frame's script, run again on the next page when the app has moved on (a tap that opens a checkout on another
  // address, and the payment page that sends it back): the navigation that replaced the page fails the first try
  async function inPage(fn, arg) {
    for (let tries = 1; ; tries++) {
      try { return await page.evaluate(fn, arg); }
      catch (e) { if (tries === 3) throw e; await page.waitForLoadState('load'); }
    }
  }
  async function tick() {
    const ms = Math.round(((frame + 1) * 1000) / fps) - Math.round((frame * 1000) / fps);
    frame++; vt += ms;
    await page.clock.runFor(ms);
    cur.ripples = cur.ripples.map((r) => ({ ...r, k: r.k + 1 / (0.5 * fps) })).filter((r) => r.k < 1);
    // eslint-disable-next-line no-eval -- the kit's own functions go to the page as source: Playwright can't pass functions inside an argument
    const [x, y] = await inPage(([now, s]) => { (0, eval)(`(${s.sync})`)(now); (0, eval)(`(${s.draw})`)(s.cur);
      return [visualViewport.pageLeft, visualViewport.pageTop]; }, [vt, { sync: syncAnimations.toString(), draw: overlay.toString(), cur }]);
    // The clip is in document coordinates: follow the scroll, or a scrolled page comes out half painted.
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 93, optimizeForSpeed: true, clip: { x, y, width: vp.width, height: vp.height, scale: vp.scale } });
    await enc.drained();
    enc.write(Buffer.from(data, 'base64'));
  }
  async function during(s, fn = () => {}) { const n = Math.max(1, Math.round(s * fps)); for (let i = 1; i <= n; i++) { await fn(i / n); await tick(); } }
  async function point(target) {
    if (Array.isArray(target)) return { x: target[0], y: target[1] };
    const el = page.locator(target).first();
    let b = await el.boundingBox();
    if (!b) throw new Error(`not found: ${target}`);
    if (b.y < 0 || b.y + b.height > vp.height) { await scroll({ y: b.y + b.height / 2 - vp.height / 2, s: 0.7 }); b = await el.boundingBox(); }
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  async function scroll({ y, s = 1, in: sel }) {
    const from = await page.evaluate((sel) => (sel ? document.querySelector(sel) : document.scrollingElement).scrollTop, sel ?? null);
    await during(s, (k) => page.evaluate(([sel, top]) => { (sel ? document.querySelector(sel) : document.scrollingElement).scrollTop = top; }, [sel ?? null, from + y * ease(k)]));
  }
  async function moveTo(p, s) {
    const x0 = cur.x, y0 = cur.y, d = Math.hypot(p.x - x0, p.y - y0);
    s ??= 0.3 + Math.min(0.6, d / 1400);
    await during(s, async (k) => { const e = ease(k), arc = Math.sin(Math.PI * e) * d * 0.08;
      cur.x = x0 + (p.x - x0) * e + ((y0 - p.y) / (d || 1)) * arc; cur.y = y0 + (p.y - y0) * e + ((p.x - x0) / (d || 1)) * arc;
      if (cur.press) await page.mouse.move(cur.x, cur.y); });
  }
  async function tap(target, step = {}) {
    const p = await point(target);
    if (cur.touch) { // finger comes down near the target, presses, lifts
      cur.x = p.x + 26; cur.y = p.y + 34;
      await during(0.22, (k) => { const e = ease(k); cur.show = e; cur.x = p.x + 26 * (1 - e); cur.y = p.y + 34 * (1 - e); });
    } else await moveTo(p, step.s);
    await during(0.1, (k) => { cur.press = k; });
    if (cur.touch) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y);
    mark('tap', { target });
    cur.ripples.push({ x: p.x, y: p.y, k: 0 });
    await during(0.14, (k) => { cur.press = 1 - k; });
    if (cur.touch) await during(0.2, (k) => { cur.show = 1 - k; cur.y = p.y + 10 * k; });
  }

  const steps = {
    wait: (s) => during(s.wait),
    waitFor: (s) => page.waitForSelector(s.waitFor),
    go: async (s) => { await page.goto(new URL(s.go, srv.origin + (flow.url ?? '/')).href); await page.waitForLoadState('load'); },
    tap: (s) => tap(s.tap, s),
    type: async (s) => {
      if (s.into) await tap(s.into);
      let rnd = 7;
      for (const ch of s.type) { await page.keyboard.type(ch); mark('key', { key: ch }); rnd = (rnd * 16807) % 2147483647;
        await during((1 / (s.cps ?? 11)) * (0.6 + (rnd % 1000) / 1250)); }
    },
    press: async (s) => { await page.keyboard.press(s.press); mark('key', { key: s.press }); await tick(); },
    scroll: async (s) => { mark('scroll', { by: s.scroll }); await scroll({ y: s.scroll, s: s.s, in: s.in }); mark('scrolled'); },
    drag: async (s) => {
      const p0 = await point(s.drag), p1 = await point(s.to);
      if (cur.touch) { cur.x = p0.x; cur.y = p0.y; await during(0.2, (k) => { cur.show = k; }); } else await moveTo(p0);
      await page.mouse.move(p0.x, p0.y); await page.mouse.down(); cur.press = 1; mark('drag', { target: s.drag });
      await moveTo(p1, s.s ?? 0.8);
      await page.mouse.up(); cur.press = 0; mark('drop', { target: s.to });
      if (cur.touch) await during(0.2, (k) => { cur.show = 1 - k; });
    },
    eval: async (s) => { const v = await page.evaluate(s.eval); if (s.mark) mark(s.mark, { value: v }); }, // `mark`: keep the result in events.json
  };

  try {
    await page.goto(srv.origin + (flow.url ?? '/'), { waitUntil: 'load', timeout: 20000 });
    process.stderr.write(`  ${name}: loaded ${page.url()}\n`);
    await page.evaluate(() => document.fonts.ready);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    if (sw > vp.width) console.warn(`  ${name}: warning: the page is ${sw} px wide in a ${vp.width} px viewport, so its right edge is cut off`);
    for (const step of flow.steps) {
      const verb = Object.keys(steps).find((k) => k in step);
      if (!verb) throw new Error('unknown step ' + JSON.stringify(step));
      process.stderr.write(`  ${name}: ${JSON.stringify(step)} @ ${(frame / fps).toFixed(2)} s\n`);
      await steps[verb](step);
    }
    await enc.end();
    // <out>.events.json: when every tap, key, scroll and drag shows in the video, so an ad's sound cues can land on them
    writeFileSync(out.replace(/\.[^./]+$/, '') + '.events.json', JSON.stringify({ fps, duration: +(frame / fps).toFixed(3), events }, null, 0) + '\n');
  } finally {
    await browser.close();
    srv.stop();
  }
  const info = probe(out);
  // its .render.json, committed in its place (renders.mjs), with the prices the app shows that the flow names (prices.mjs)
  noteRender(out, undefined, undefined, await pricesFor(keysOf(flow.prices), flow.lang ?? locale.slice(0, 2)));
  console.log(`${out}: ${info.width}x${info.height}, ${info.duration.toFixed(2)} s, ${(info.size / 1e6).toFixed(2)} MB`);
}

for (const v of vps) await recordOne(v);
