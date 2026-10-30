#!/usr/bin/env node
// HQ through a long session in a real browser with the profiler (shared/profile) on from its first script: the building
// at rest, then its views opened and closed round after round, then at rest again. Prints what each phase ended with,
// so growth shows round on round. Chromium adds its own counts after a garbage collection (detached elements too).
//   node platform/hq/profile-session.mjs [--engine chromium|webkit] [--look brownstone] [--rounds 10] [--rest 120]
//     [--views book,phone]
import { parseArgs } from 'node:util';
import { openProfiled, SAMPLE_MS } from './profile-browser.mjs';

const { values: options } = parseArgs({
  options: {
    engine: { type: 'string', default: 'chromium' },
    look: { type: 'string', default: 'brownstone' },
    rounds: { type: 'string', default: '10' },
    rest: { type: 'string', default: '120' }, // seconds at rest, before the rounds and after them
    views: { type: 'string', default: '' }, // the views each round opens, by name (VIEWS), else all of them
  },
});
// Each round's views, opened and closed as the board's taps do (desk.js, projects.js, ink/book.js, news.js)
const VIEWS = {
  book: [
    "import('/shell/ink/book.js').then(m => m.openBook())",
    "import('/shell/ink/book.js').then(m => m.foldBook())",
  ],
  phone: ["import('/shell/desk.js').then(m => m.openPhone())", "import('/shell/desk.js').then(m => m.closeTool())"],
  computer: [
    "import('/shell/desk.js').then(m => m.openComputer())",
    "import('/shell/desk.js').then(m => m.closeTool())",
  ],
  intercom: [
    "import('/shell/desk.js').then(m => m.openIntercom())",
    "import('/shell/desk.js').then(m => m.closeTool())",
  ],
  projects: [
    "import('/shell/projects.js').then(m => m.openProjects())",
    "import('/shell/projects.js').then(m => m.closeProjects())",
  ],
  news: ["import('/shell/news.js').then(m => m.openGazette())", "import('/shell/desk.js').then(m => m.closeTool())"],
};

const opened = options.views ? options.views.split(',').map(name => VIEWS[name]) : Object.values(VIEWS);
const { page, errors, samples, cdp, close } = await openProfiled(options);
await cdp?.send('Performance.enable');
const phases = [];
await phase('loaded', 10);
await phase('at rest', Number(options.rest));
for (let round = 1; round <= Number(options.rounds); round++) {
  for (const [open, close] of opened) {
    await page.evaluate(open).catch(e => errors.push(`open: ${e.message}`));
    await page.waitForTimeout(1500);
    await page.evaluate(close).catch(e => errors.push(`close: ${e.message}`));
    await page.waitForTimeout(700);
  }
  if (round === 1 || round % 5 === 0) await phase(`round ${round}`, 6);
}
await phase('at rest again', Number(options.rest));
await close();

console.log(
  `HQ in ${options.look}, ${options.engine}, iPad mini landscape at 2x, ${options.views || 'every view'}: what each phase ended with`,
);
console.table(phases);
const last = samples.at(-1);
console.log('biggest regions at the end:', last?.regions);
console.log('window and document listeners at the end:', last?.listeners);
if (errors.length) console.log('page errors:', [...new Set(errors)].slice(0, 10));

// Waits a phase out (its seconds), then reads the newest sample and, in Chromium, its counts after a collection
async function phase(name, seconds) {
  const from = samples.length;
  await page.waitForTimeout(seconds * 1000 + SAMPLE_MS + 500);
  const taken = samples.slice(from);
  const s = taken.at(-1);
  const shown = taken.reduce((n, t) => n + t.frames.shown, 0),
    slow = taken.reduce((n, t) => n + t.frames.slow, 0);
  const row = {
    phase: name,
    up: s.up,
    nodes: s.nodes,
    listeners: Object.values(s.listeners).reduce((a, b) => a + b, 0),
    observers: s.resize + s.mutation + s.intersection,
    intervals: s.intervals,
    'timeouts/5s': s.timeouts,
    'frames asked/5s': s.animationFrames,
    canvases: s.canvases,
    canvasMb: s.canvasMb,
    audio: s.audio,
    'slow frames %': shown ? Math.round((100 * slow) / shown) : null,
  };
  if (cdp) {
    await cdp.send('HeapProfiler.collectGarbage');
    const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    Object.assign(row, {
      'heap MB (after GC)': Math.round(metrics.JSHeapUsedSize / 1e5) / 10,
      'all nodes (with detached)': metrics.Nodes,
      'all listeners': metrics.JSEventListeners,
    });
  }
  phases.push(row);
}
