#!/usr/bin/env node
// HQ's scene under what covers it, in a real browser on an iPad mini's size: how often the scene draws, the time its
// update and draw take, and the CPU the browser spends (its GPU process too, which renders in software here), with
// nothing over it, beside the book, on a call (small, and its window over the scene), after the call, and under the
// book's spread. Chromium adds its renderer's main-thread time. Read the numbers against each other, not as the iPad's.
//   node platform/hq/profile-covered.mjs [--engine chromium|webkit] [--look brownstone] [--seconds 8]
import { readFile, readdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { openProfiled } from './profile-browser.mjs';
import { playLine } from './bookcall.mjs';
import { bookAtRest } from './bookkit.mjs';

const { values: options } = parseArgs({
  options: {
    engine: { type: 'string', default: 'chromium' },
    look: { type: 'string', default: 'brownstone' },
    seconds: { type: 'string', default: '8' }, // how long each phase is measured, after a second to settle
  },
});
const SETTLE_MS = 1000;
const TICKS_PER_S = 100; // (Linux's clock ticks in /proc/<pid>/stat)

// The scene's update and draw, counted and timed in the page (stage.js's scene, the one on stage)
const meter = () =>
  import('/shell/stage.js').then(({ scene }) => {
    const m = (window.__scene = { draws: 0, ms: 0 });
    for (const name of ['update', 'draw']) {
      const own = scene[name].bind(scene);
      scene[name] = (...args) => {
        const t0 = performance.now();
        own(...args);
        m.ms += performance.now() - t0;
        if (name === 'draw') m.draws++;
      };
    }
  });
const inPage = code => page.evaluate(code);
const book = (call, mode) =>
  inPage(`import('/shell/ink/book.js').then(m => m.${call}())`).then(() => bookAtRest(page, mode));
// Each phase: its name and what brings it on
const PHASES = [
  ['nothing over it (book folded)', () => book('foldBook', 'folded')],
  ['book open beside it', () => book('openBook', 'open')],
  ['intercom over it', () => inPage("import('/shell/desk.js').then(m => m.openIntercom())")],
  [
    'on a call, small',
    async () => {
      // (HQ's sounds start at a tap, as on iOS: audio.js)
      await inPage("import('/shell/audio.js').then(m => m.unlock())");
      await inPage("import('/shell/call.js').then(m => m.callAgent())");
      // (headless WebKit's microphone doesn't start here, which ends the call at once: its phases measure no call)
      await page.waitForSelector('#call-layer', { timeout: 5000 }).catch(() => {});
      await inPage("import('/shell/call.js').then(m => m.minimiseCall())");
    },
  ],
  ['call window over it', () => inPage("import('/shell/call.js').then(m => m.callAgent())")],
  ['call small again', () => inPage("import('/shell/call.js').then(m => m.minimiseCall())")],
  [
    'after the call',
    async () => {
      // (a call the line lost has ended already)
      await inPage(
        "import('/shell/call.js').then(m => m.inCall() && (m.callAgent(), document.querySelector('#call-end').click()))",
      );
      await page.waitForFunction(() => !document.querySelector('#call-layer'));
    },
  ],
  [
    'upright, book folded',
    async () => {
      await page.setViewportSize({ width: 744, height: 1133 });
      await book('foldBook', 'folded');
    },
  ],
  ['upright, book over it (spread)', () => book('openBook', 'spread')],
];

// The CPU time, in seconds, of every process this one started (the browser's), not its own
async function browserCpu() {
  const parents = new Map(),
    cpu = new Map();
  for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
    if (!stat) continue;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // (field 3 on: state, ppid, ...)
    parents.set(pid, fields[1]);
    cpu.set(pid, (Number(fields[11]) + Number(fields[12])) / TICKS_PER_S);
  }
  const ours = pid => {
    for (let p = parents.get(pid); p; p = parents.get(p)) if (p === String(process.pid)) return true;
    return false;
  };
  return [...cpu].reduce((sum, [pid, s]) => sum + (ours(pid) ? s : 0), 0);
}
// Chromium's renderer main thread: its task and script time so far, in seconds
async function mainThread() {
  if (!cdp) return null;
  const { metrics } = await cdp.send('Performance.getMetrics');
  const of = name => metrics.find(m => m.name === name).value;
  return { task: of('TaskDuration'), script: of('ScriptDuration') };
}

// (the call's line answers it, as the voice line does: bookcall.mjs)
const { page, errors, cdp, close } = await openProfiled({ ...options, before: playLine });
if (cdp) await cdp.send('Performance.enable');
await page.evaluate(meter);
const seconds = Number(options.seconds),
  rows = {};
for (const [name, bringOn] of PHASES) {
  await bringOn();
  await page.waitForTimeout(SETTLE_MS);
  const read = () => Promise.all([page.evaluate(() => ({ ...window.__scene })), browserCpu(), mainThread()]);
  const [scene0, cpu0, main0] = await read();
  await page.waitForTimeout(seconds * 1000);
  const [scene1, cpu1, main1] = await read();
  rows[name] = {
    call: await page.evaluate(() => {
      const layer = document.querySelector('#call-layer');
      return !layer ? 'none' : layer.hidden ? 'small' : 'window';
    }),
    'scene fps': +((scene1.draws - scene0.draws) / seconds).toFixed(1),
    'scene ms/s': +((scene1.ms - scene0.ms) / seconds).toFixed(1),
    'browser CPU %': Math.round(((cpu1 - cpu0) / seconds) * 100),
    ...(main0 && {
      'main task ms/s': Math.round(((main1.task - main0.task) / seconds) * 1000),
      'main script ms/s': Math.round(((main1.script - main0.script) / seconds) * 1000),
    }),
  };
}
await close();

console.log(
  `HQ's scene under what covers it, ${options.look} in ${options.engine}, iPad mini at 2x: ${seconds} s a phase`,
);
console.table(rows);
if (errors.length) console.log('page errors:', errors);
