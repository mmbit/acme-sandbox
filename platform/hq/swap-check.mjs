#!/usr/bin/env node
// HQ's hot swap check: swaps the renderer at least 10 times and fails unless each renderer's frames after its first and
// last swap are the same, listeners, canvases and timers stay level, and nothing reaches the console as an error.
//   node platform/hq/swap-check.mjs [renderer …]   (swaps to each in turn, whole rounds; brownstone by default)
// Dev mode on the mock data, with a paused clock and a Math.random that restarts before every swap, so a leftover
// from an earlier scene shows as a difference. Before each swap a post comes in (the scene sends people on errands).
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const NAMES = process.argv.length > 2 ? process.argv.slice(2) : ['brownstone'];
const SWAPS = Math.ceil(10 / NAMES.length) * NAMES.length; // every renderer twice at least, so first and last differ
const server = await serve();

const browser = await playwright().chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }); // (WebGL renderers)
// no web fonts, quietly (a renderer that loads its own lettering on a swap sees an empty sheet, not a console error)
const { context, page, errors } = await openPage(browser, { viewport: { width: 1280, height: 800 } });
await context.clock.pauseAt(Date.parse('2026-06-15T12:00:00Z'));
await context.addInitScript(() => {
  Date.now(); // (the paused clock starts here, see pixel-check.mjs)
  let a = 1;
  Math.random = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  window.reseed = () => { a = 1; };
  // DOM listeners per target, and the timers a renderer's code set that haven't run
  const listeners = new Map(), timers = new Set(), { addEventListener: add, removeEventListener: remove } = EventTarget.prototype;
  EventTarget.prototype.addEventListener = function (...a) { listeners.set(this, (listeners.get(this) || 0) + 1); return add.apply(this, a); };
  EventTarget.prototype.removeEventListener = function (...a) { listeners.set(this, (listeners.get(this) || 0) - 1); return remove.apply(this, a); };
  const set = setTimeout, clear = clearTimeout;
  window.setTimeout = (fn, ms, ...a) => {
    const id = set(() => { timers.delete(id); fn(...a); }, ms);
    if (/\/renderers\//.test(new Error().stack)) timers.add(id);
    return id;
  };
  window.clearTimeout = id => { timers.delete(id); clear(id); };
  window.counts = () => ({
    listeners: [...listeners].filter(([t]) => t === window || t === document || t.isConnected).reduce((n, [, k]) => n + k, 0),
    canvases: document.querySelectorAll('canvas').length,
    timers: timers.size,
    skins: document.querySelectorAll('link[data-skin]').length, // the look's own skin.css, if it has one: never two
  });
});
await page.goto(`http://localhost:${server.address().port}/?intro=0&hour=12&weather=clear`);
await page.waitForFunction(() => window.hq, null, { polling: 100 });
await page.evaluate(() => { hq.world.paused = true; });
// (from here: the boot's own 404s, for the /api dev mode doesn't have, aren't the swaps')
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

// One swap: a post, the swap, a frame. Then what's there: the frame's pixels, the counts, and how many scenes hear
// the world (each one listening puts a '...' over someone's head for a log line: a text part, or a 'dots' icon).
// The pixels go through a 2d canvas, in the frame's own task, so a WebGL canvas reads the same way.
const swap = name => page.evaluate(async name => {
  const old = document.querySelector('#world');
  hq.world.emit('post', { agent: 'kit', title: 'Swap check' });
  reseed(); await hq.swap(name); hq.frame(10);
  const c = document.querySelector('#world'), g = new OffscreenCanvas(c.width, c.height).getContext('2d');
  g.drawImage(c, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', px)), b => b.toString(16).padStart(2, '0')).join('');
  const S = hq.S(), people = [...S.people.values()], id = (people.find(A => A.hit) || people[0]).id;
  const dots = () => S.parts.filter(p => p.s === '...' || p.cell === 'dots').length + people.filter(A => A.icon?.kind === 'dots').length, n = dots();
  hq.event({ type: 'log', agent: id, text: 'swap check' });
  return { name, swapped: c !== old, hash, counts: { ...counts(), scenes: dots() - n } };
}, name);
const after = [];
for (let i = 0; i < SWAPS; i++) after.push(await swap(NAMES[i % NAMES.length]));
await browser.close(); server.close();

const bad = [], level = [];
if (!after.every(s => s.swapped)) bad.push('a swap kept the old canvas');
if (after.some(s => s.counts.skins > 1)) bad.push('a skin outlived its look');
for (const name of NAMES) {
  const mine = after.filter(s => s.name === name), [first, last] = [mine[0], mine.at(-1)];
  if (first.hash !== last.hash) bad.push(`${name}: the frame after its last swap differs from the one after its first`);
  const [a, b] = [JSON.stringify(first.counts), JSON.stringify(last.counts)];
  if (a !== b || first.counts.scenes !== 1) bad.push(`${name}: after its first swap ${a}; after its last ${b}`);
  level.push(`${name} ${a}`);
}
bad.push(...errors.map(e => `console: ${e}`));
console.log(bad.length ? `FAIL\n  ${bad.join('\n  ')}` : `ok: ${SWAPS} swaps, the same frame after each renderer's first and last; ${level.join('; ')}`);
process.exit(bad.length ? 1 : 0);
