#!/usr/bin/env node
// The Notebook's pull-in in a real browser with the profiler (shared/profile) on from its first script. The pull tab is
// dragged open and shut over the building, again and again, under each variant (VARIANTS). The variants take turns in
// short blocks, so the machine's load hits them alike. For each variant it prints the profiler's frames and long tasks,
// every frame's gap by phase of the pull, and what the page's animation frames and pointer handlers spent. In Chromium
// it also traces one more turn of each: the renderer's work by kind, and the functions that took the most.
//   node platform/hq/profile-pull.mjs [--engine chromium|webkit] [--look brownstone] [--blocks 3] [--block 16]
//     [--variants drawing,blur,paused,hidden,hover,noselect]
import { parseArgs } from 'node:util';
import { openProfiled, SAMPLE_MS, IPAD_MINI } from './profile-browser.mjs';
import { rendererWork, scriptOf, topFunctions, longTasks } from './profile-trace.mjs';

const { values: options } = parseArgs({
  options: {
    engine: { type: 'string', default: 'chromium' },
    look: { type: 'string', default: 'brownstone' },
    blocks: { type: 'string', default: '3' }, // turns each variant takes
    block: { type: 'string', default: '16' }, // seconds a turn drags for
    variants: { type: 'string', default: 'drawing,blur,paused,hidden,hover' },
  },
});
const MOVE_MS = 16; // a finger's move per frame at 60 Hz
// What each variant does before its turn. pause holds the building (stage.js), and hide hides its #world canvas. blur
// keeps the book's dissolve blurred, which bookswing.js turns off for good once its frames are slow, as they soon are
// here. hover is the control: the same moves with no button down, so the book stays shut and only the moves' own cost
// shows. noselect turns off text selection, since a mouse's drag selects text and a finger's doesn't.
const VARIANTS = {
  drawing: { pause: false, hide: false, blur: false },
  blur: { pause: false, hide: false, blur: true },
  paused: { pause: true, hide: false, blur: false },
  hidden: { pause: true, hide: true, blur: false },
  hover: { pause: true, hide: false, blur: false, hover: true },
  noselect: { pause: true, hide: false, blur: false, noselect: true },
};
const variants = options.variants.split(',');
const { page, errors, samples, cdp, close } = await openProfiled({
  ...options,
  initScripts: [keepGaps, timeCosts, countResizes, keepBlur],
});
// Where the open book's cover edge lies: the pull drags the tab there, never past it (that would widen the book)
await put('openBook', 'open');
const openAt = await lipX();
await put('foldBook', 'folded');
await page.waitForTimeout(3000);

const turns = Object.fromEntries(variants.map(v => [v, { samples: [], cost: {}, pulls: 0, missed: 0, gaps: {} }]));
for (let b = 0; b < Number(options.blocks); b++) for (const v of variants) await turn(v);
const traced = {};
if (cdp) for (const v of variants) traced[v] = await trace(v);
await close();

console.log(
  `The Notebook's pull-in in ${options.look}, ${options.engine}, iPad mini landscape at 2x: ` +
    `${options.blocks} turns of ${options.block} s per variant, the tab dragged to x ${Math.round(openAt)} and back`,
);
console.table(
  Object.fromEntries(
    Object.entries(turns).map(([v, t]) => {
      const sum = k => t.samples.reduce((n, s) => n + k(s), 0),
        seconds = (t.samples.length * SAMPLE_MS) / 1000,
        shown = sum(s => s.frames.shown);
      return [
        v,
        {
          pulls: t.pulls,
          'drags missed': t.missed,
          seconds,
          fps: seconds ? Math.round(shown / seconds) : null,
          'gaps > 60 ms': sum(s => s.frames.slow),
          'gaps > 60 ms %': shown ? Math.round((100 * sum(s => s.frames.slow)) / shown) : null,
          'worst gap ms': Math.max(0, ...t.samples.map(s => s.frames.worst)),
          'long tasks': sum(s => s.longTasks.count),
          'long task ms/s': seconds ? Math.round(sum(s => s.longTasks.ms) / seconds) : null,
          'worst long task ms': Math.max(0, ...t.samples.map(s => s.longTasks.worst)),
          'canvas resizes': t.resized,
        },
      ];
    }),
  ),
);
console.log(
  'frames while the finger holds the tab (held), while the book swings on after it lets go (swing), ' +
    'and while the control moves over the tab with no button down (hovered):',
);
console.table(
  Object.entries(turns).flatMap(([v, t]) =>
    Object.entries(t.gaps).map(([phase, gaps]) => {
      const sorted = gaps.toSorted((a, b) => a - b),
        at = q => Math.round(sorted[Math.floor(q * (sorted.length - 1))] ?? 0);
      return {
        variant: v,
        phase,
        frames: gaps.length,
        'median gap ms': at(0.5),
        'p95 gap ms': at(0.95),
        'gaps > 60 ms %': gaps.length ? Math.round((100 * gaps.filter(g => g > 60).length) / gaps.length) : null,
        'worst gap ms': at(1),
      };
    }),
  ),
);
console.log("animation frames' and pointer handlers' script, ms per second of dragging, by callback:");
console.table(
  Object.fromEntries(
    Object.entries(turns).map(([v, t]) => {
      const seconds = (t.pulls && Number(options.block) * Number(options.blocks)) || 1;
      return [v, Object.fromEntries(Object.entries(t.cost).map(([k, c]) => [k, Math.round(c.ms / seconds)]))];
    }),
  ),
);
if (cdp) {
  console.log(
    "Chromium's renderer (main, compositor and raster threads), ms per second of dragging, one traced turn each:",
  );
  console.table(Object.fromEntries(Object.entries(traced).map(([v, t]) => [v, t.work])));
  for (const [v, t] of Object.entries(traced)) {
    console.log(`${v}: the page's functions that took the most, with what they called (ms per second)`);
    console.table(t.functions);
    console.log(`${v}: the longest tasks on the main thread (ms, and the script in them)`);
    console.table(t.long);
  }
}
if (errors.length) console.log('page errors:', [...new Set(errors)].slice(0, 10));

// ---- in the page, before HQ's scripts and after the profiler's
// Every frame's gap, kept by the pull's phase (window.__phase). Its frames are asked for before timeCosts wraps
// requestAnimationFrame, so they go uncounted there.
function keepGaps() {
  const ask = window.requestAnimationFrame.bind(window);
  window.__gaps = {};
  let before = 0;
  const tick = t => {
    if (window.__phase && before) (window.__gaps[window.__phase] ??= []).push(t - before);
    before = t;
    ask(tick);
  };
  ask(tick);
}
// Each animation frame's callback timed by its name (the building's loop, the swing's frame), and the pointer events'
// handlers by type. The profiler's own frames go uncounted, as it asks for them through the browser's function it kept.
function timeCosts() {
  const ask = window.requestAnimationFrame.bind(window);
  window.__rafCost = {};
  const timedBy = (name, run) => {
    const t0 = performance.now();
    try {
      return run();
    } finally {
      const cost = (window.__rafCost[name] ??= { ms: 0, calls: 0 });
      cost.ms += performance.now() - t0;
      cost.calls++;
    }
  };
  window.requestAnimationFrame = callback => ask(t => timedBy(callback.name || 'anonymous', () => callback(t)));
  const listen = EventTarget.prototype.addEventListener,
    timed = new WeakMap();
  EventTarget.prototype.addEventListener = function (type, handler, ...rest) {
    if (!/^pointer/.test(type) || typeof handler !== 'function') return listen.call(this, type, handler, ...rest);
    if (!timed.has(handler))
      timed.set(handler, function (e) {
        return timedBy(`${type} handlers`, () => handler.call(this, e));
      });
    return listen.call(this, type, timed.get(handler), ...rest);
  };
  const unlisten = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.removeEventListener = function (type, handler, ...rest) {
    return unlisten.call(this, type, timed.get(handler) ?? handler, ...rest);
  };
}
// Big canvases resized: a new size clears the building's, and its renderer lays out again
function countResizes() {
  window.__resized = 0;
  for (const side of ['width', 'height']) {
    const property = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, side);
    Object.defineProperty(HTMLCanvasElement.prototype, side, {
      ...property,
      set(value) {
        if (value !== property.get.call(this) && this.width * this.height > 200000) window.__resized++;
        property.set.call(this, value);
      },
    });
  }
}
// The book's blur kept on while window.__keepBlur says so
function keepBlur() {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (!(window.__keepBlur && key === 'hq.book.blur')) setItem.call(this, key, value);
  };
}

// One variant's turn: set up, dragged for a block, and the profiler's samples taken wholly inside it kept
async function turn(v) {
  const t = turns[v];
  await setUp(VARIANTS[v]);
  await page.evaluate(() => {
    window.__rafCost = {};
    window.__resized = 0;
    window.__gaps = {};
  });
  const from = Date.now();
  const { pulls, missed } = await dragFor(Number(options.block) * 1000, VARIANTS[v]);
  t.pulls += pulls;
  t.missed += missed;
  const to = Date.now();
  t.resized = (t.resized ?? 0) + (await page.evaluate(() => window.__resized));
  const gaps = await page.evaluate(() => window.__gaps);
  for (const k in gaps) (t.gaps[k] ??= []).push(...gaps[k]);
  for (const [k, c] of Object.entries(await page.evaluate(() => window.__rafCost))) {
    const sum = (t.cost[k] ??= { ms: 0, calls: 0 });
    sum.ms += c.ms;
    sum.calls += c.calls;
  }
  await page.waitForTimeout(SAMPLE_MS + 500); // (the sample that ends after the turn sent)
  t.samples.push(...samples.filter(s => s.at - SAMPLE_MS >= from && s.at <= to));
  await setUp(VARIANTS.drawing);
}
async function setUp({ pause, hide, blur, noselect = false }) {
  await page.evaluate(
    async ({ pause, hide, blur, noselect }) => {
      (await import('/shell/stage.js')).pause(pause);
      document.getElementById('world').style.visibility = hide ? 'hidden' : '';
      document.documentElement.style.webkitUserSelect = document.documentElement.style.userSelect = noselect
        ? 'none'
        : '';
      window.__keepBlur = blur;
      if (blur) localStorage.setItem('hq.book.blur', 'true');
    },
    { pause, hide, blur, noselect },
  );
}

// The pull tab pulled open and shut until the time's up, or only hovered over in the control: how many pulls, and how
// many drags missed
async function dragFor(ms, { hover = false }) {
  const end = Date.now() + ms;
  let pulls = 0,
    missed = 0;
  for (; Date.now() < end; pulls++) missed += hover ? await hoverPull() : await pull();
  return { pulls, missed };
}
// The tab dragged open, then shut: how many of the two drags missed
async function pull() {
  await drag(await lipX(), openAt + 4);
  const missedOpen = await missedDrag('openBook', 'open');
  await drag(await lipX(), IPAD_MINI.viewport.width - 4);
  return missedOpen + (await missedDrag('foldBook', 'folded'));
}
// The control's pull: the same moves with no button down, so the book stays shut and no drag can miss
async function hoverPull() {
  const shut = await lipX();
  await drag(shut, openAt + 4, false);
  await drag(openAt + 4, shut, false);
  return 0;
}
// 1 when the drag didn't leave the book at rest in this mode. The book is then put there, so the next drag starts right.
async function missedDrag(call, mode) {
  if (await settled(mode)) return 0;
  await put(call, mode);
  return 1;
}
async function put(call, mode) {
  await page.evaluate(call => import('/shell/ink/book.js').then(m => m[call]()), call);
  if (!(await settled(mode))) throw new Error(`the book never came to rest ${mode}`);
}
// A finger on the tab, moved to x a frame at a time, held a moment and let go (press false: the moves alone)
async function drag(from, to, press = true) {
  const y = await page.evaluate(() => {
    const r = document.querySelector('#book .bk-lip').getBoundingClientRect();
    return r.top + r.height / 2;
  });
  await page.mouse.move(from, y);
  await page.evaluate(phase => (window.__phase = phase), press ? 'held' : 'hovered');
  if (press) await page.mouse.down();
  const steps = 40;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from + ((to - from) * i) / steps, y);
    await page.waitForTimeout(MOVE_MS);
  }
  await page.waitForTimeout(150);
  if (press) await page.mouse.up();
  await page.evaluate(phase => (window.__phase = phase), press ? 'swing' : null);
}
function lipX() {
  return page.evaluate(() => {
    const r = document.querySelector('#book .bk-lip').getBoundingClientRect();
    return Math.min(innerWidth - 2, r.left + r.width / 2);
  });
}
// The book come to rest in this mode (book.js's data-book), its swing over
function settled(mode) {
  return page
    .waitForFunction(
      m => document.documentElement.dataset.book === m && !document.querySelector('#book.bk-swinging'),
      mode,
      { timeout: 15000 },
    )
    .then(
      () => true,
      () => false,
    )
    .then(async rested => {
      await page.evaluate(() => (window.__phase = null));
      return rested;
    });
}

// Chromium: one more turn of a variant, traced, and what its renderer and its functions spent per second
async function trace(v) {
  await setUp(VARIANTS[v]);
  const events = [];
  cdp.on('Tracing.dataCollected', e => events.push(...e.value));
  const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,v8.execute',
    transferMode: 'ReportEvents',
  });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  await dragFor(Number(options.block) * 1000, VARIANTS[v]);
  const seconds = (Date.now() - t0) / 1000;
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.send('Tracing.end');
  await done;
  cdp.removeAllListeners('Tracing.dataCollected');
  await setUp(VARIANTS.drawing);
  const scriptSamples = scriptOf(profile);
  return {
    work: rendererWork(events, seconds),
    functions: topFunctions(scriptSamples, seconds),
    long: longTasks(events, scriptSamples),
  };
}
