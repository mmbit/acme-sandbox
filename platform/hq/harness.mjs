// HQ in a Playwright page as a pure function of its code: a paused clock, a seeded Math.random, and a wait for what the
// paused clock doesn't cover. pixel-check.mjs and room-preview.mjs drive HQ with it.

import { render } from '../../shared/browser/render.ts';
await render();
export const progress = () => process.send?.({ render: 'progress' });

// Time moves only when the caller says so: runFor fires timers and animation frames in order. The clock's ticks must
// start at the same value on every run, or the 16 ms animation frames fall differently between the timers. pauseAt
// alone (after install() the ticks would start at the real time between the two calls), and Date.now() in the first
// script: until its first call the page's clock runs on real time. walls: the outside walls on, as a viewer left them.
export async function pin(context, at, walls = false) {
  progress();
  await context.clock.pauseAt(at);
  await context.addInitScript(walls => {
    Date.now();
    let a = 1; // mulberry32: the same sequence every run, so a reordered Math.random call shows as a difference
    Math.random = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    if (walls) localStorage.setItem('hq.walls', 'true');
  }, walls);
}

// The page's requests in flight, for settle
export function track(page) {
  const inflight = new Set();
  page
    .on('request', r => inflight.add(r))
    .on('requestfinished', r => inflight.delete(r))
    .on('requestfailed', r => inflight.delete(r));
  page.inflight = inflight;
  return page;
}

// Real time for what the paused clock doesn't cover, so it lands at the same point on every run: input (Chromium hands
// pointer moves, wheels and keys to the page at its next real frame, after Playwright's call has returned), requests
// (mock data, images) and what the page does with their answers. A 50 ms Web Animation runs on the real timeline.
export async function settle(page) {
  progress();
  do {
    await page.evaluate(() => document.body.animate([], 50).finished);
    while (page.inflight.size) await new Promise(r => setTimeout(r, 10));
    await page.evaluate(() =>
      Promise.all([
        document.fonts.ready,
        ...[...document.images].map(i => i.decode().catch(() => {})),
        globalThis.hq?.picturesLoaded?.(),
      ]),
    );
  } while (page.inflight.size);
}
