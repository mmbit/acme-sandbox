// node --test shared/watchalong/media.test.ts (needs the coordinator's npm ci and Playwright Chromium).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { playwright } from '../browser/browser.mjs';

const COORDINATOR = new URL('../../platform/coordinator/', import.meta.url);
const REPLAY = new URL('node_modules/@rrweb/replay/dist/replay.js', COORDINATOR);
const RECORD = new URL('node_modules/@rrweb/record/dist/record.js', COORDINATOR);
const skip = !existsSync(REPLAY) ? "needs the coordinator's npm ci" : false;
const ORIGIN = 'http://media.test';
const PAGE = `<!doctype html><style>
body { margin: 0 }
#choices { position: fixed; left: 20px; top: 10px }
button { display: block; width: 160px; height: 24px }
@media (pointer: coarse) { button { height: 70px } }
@media (hover: none) { @media (orientation: portrait) { #choices { top: 130px } } }
@media (hover: hover), (prefers-reduced-motion: reduce) { #choices { left: 70px } }
</style><div id="choices"><button>First</button><button id="pointed">Pointed control</button><button>Last</button></div>
<div id="shadow" style="position:fixed;left:250px;top:10px"></div>
<script type="module">
import { watch } from '/watchalong.js';
const root = document.querySelector('#shadow').attachShadow({ mode: 'open' });
root.innerHTML = '<style>button { display:block;height:24px } @media (any-pointer: coarse) {button {height:80px}}</style><button>Shadow first</button><button id="shadow-pointed">Shadow control</button>';
window.events = [];
window.watching = watch({url: '/events', typed:'shown'});
window.ready = true;
</script>`;
const PLAYER = `<!doctype html><script type="module">
window.process = {env:{}};
const { Replayer } = await import('/replayer.js');
const { applyMedia, mediaAt } = await import('/media.js');
window.show = async events => {
  const replayer = new Replayer(events, {root:document.body,useVirtualDom:false,showWarning:false});
  replayer.pause(events.at(-1).timestamp - events[0].timestamp + 1);
  await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  applyMedia(replayer, mediaAt(events, Infinity));
  window.doc = replayer.iframe.contentDocument;
};
window.hit = ([x,y]) => {
  let element = window.doc.elementFromPoint(x,y);
  while (element?.shadowRoot) element = element.shadowRoot.elementFromPoint(x,y);
  return element?.textContent;
};
window.ready = true;
</script>`;

test(
  'a control pointed at on touch and desktop stays under that point in replay, through rotation and late styles',
  { skip },
  async () => {
    const browser = await playwright().chromium.launch();
    try {
      for (const hasTouch of [true, false]) {
        const context = await browser.newContext({
          viewport: { width: 744, height: 1133 },
          hasTouch,
          reducedMotion: 'reduce',
        });
        const events: any[] = [];
        await context.route(`${ORIGIN}/**`, async (route: any) => {
          const path = new URL(route.request().url()).pathname;
          if (path === '/events') {
            events.push(...route.request().postDataJSON().events);
            return route.fulfill({ json: {} });
          }
          if (path === '/' || path === '/player')
            return route.fulfill({ contentType: 'text/html', body: path === '/' ? PAGE : PLAYER });
          const file =
            path === '/replayer.js'
              ? REPLAY
              : path === '/vendor/rrweb-record.js'
                ? RECORD
                : new URL(path.slice(1), import.meta.url);
          return route.fulfill({ contentType: 'text/javascript', body: await readFile(file) });
        });
        const page = await context.newPage();
        await page.goto(ORIGIN);
        await page.waitForFunction(() => (window as any).ready);
        // The viewer has its own desktop environment, regardless of the recording device.
        const viewer = await browser.newContext({
          viewport: { width: 1133, height: 1133 },
          reducedMotion: 'no-preference',
        });
        await viewer.route(`${ORIGIN}/**`, async (route: any) => {
          const path = new URL(route.request().url()).pathname;
          const file = path === '/replayer.js' ? REPLAY : new URL(path.slice(1), import.meta.url);
          return route.fulfill({
            contentType: path === '/player' ? 'text/html' : 'text/javascript',
            body: path === '/player' ? PLAYER : await readFile(file),
          });
        });
        for (const viewport of [
          { width: 744, height: 1133 },
          { width: 1133, height: 744 },
        ]) {
          await page.setViewportSize(viewport);
          await page.evaluate(() => {
            const style = document.createElement('style');
            style.textContent = '@media (min-width: 900px) and (pointer: coarse) { #choices { top: 230px } }';
            document.head.append(style);
          });
          await page.waitForTimeout(1100);
          const targets = [];
          for (const selector of ['#pointed', '#shadow-pointed']) {
            const control = page.locator(selector);
            const box = (await control.boundingBox())!;
            targets.push({
              point: [box.x + box.width / 2, box.y + box.height / 2],
              label: await control.textContent(),
            });
          }
          await page.evaluate(() => (window as any).watching.mark('check', {}));
          await page.waitForTimeout(1100);
          for (const includeMedia of [true, false]) {
            const replay = await viewer.newPage();
            await replay.goto(`${ORIGIN}/player`);
            await replay.waitForFunction(() => (window as any).ready);
            const recording = includeMedia
              ? events
              : events.filter(event => !(event.type === 5 && event.data.tag === 'media'));
            await replay.evaluate((events: any[]) => (window as any).show(events), recording);
            const hits: (string | null)[] = await Promise.all(
              targets.map(target => replay.evaluate((point: number[]) => (window as any).hit(point), target.point)),
            );
            if (includeMedia)
              assert.deepEqual(
                hits,
                targets.map(target => target.label),
                'each pointed control remains under the recorded point',
              );
            else if (hasTouch)
              assert.notDeepEqual(
                hits,
                targets.map(target => target.label),
                'the missing media environment loses the pointed control',
              );
            await replay.close();
          }
        }
        await page.evaluate(() => (window as any).watching.stop());
        await viewer.close();
        await context.close();
      }
    } finally {
      await browser.close();
    }
  },
);
