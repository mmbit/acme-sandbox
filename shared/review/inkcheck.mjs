// wetDry(page): does a pen's line stay just as it is when it goes dry? In a Playwright page of its own making, ink.js
// (served to it through a route) draws lines with synthetic pen events on a patterned box: a dry canvas (.ink), a
// canvas under it for the live line's white edge (.halo) and the live one over it (.wet), as review mode has them. At
// each lift the box is photographed twice: just before the dry canvas takes the line (the live line on screen, its
// lift's last piece drawn), and just after (the dry canvas only). Each line gives { name, worst, changed }: the largest
// difference in any colour channel between the two (0–255), and how many device pixels differ by more than 24. A line
// that stays as it was changes at most STILL of them (soft edges' rounding: a few stray pixels where a rasteriser
// fills the line's part a hair differently from its whole); one that moves, thickens or fades changes hundreds.
// platform/hq/book-check.mjs calls it; shared/review/ink.test.js checks the same thing as shapes, without a browser.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const HOST = 'https://ink.test';
const CLOSE = 24; // (a channel's difference above it is a change an eye could see, not a soft edge's rounding)
export const STILL = 5;

// The lines, [name, ink, points, the point i: x, y, pressure]: a pen pressing harder and lighter, one crossing it, a
// loop crossing itself, a highlighter over them all. Each lifts with pressure 0, as a Pencil does on iPad Safari.
const LINES = [
  [
    'red, pressing harder and lighter',
    '#ff5a5f',
    68,
    i => [30 + i * 5, 90 + Math.sin(i / 7) * 45, 0.15 + 0.8 * Math.sin((i / 68) * Math.PI)],
  ],
  ['black, crossing it', '#2b2230', 70, i => [60 + i * 4, 30 + i * 3.4, 0.35 + 0.5 * Math.abs(Math.sin(i / 11))]],
  [
    'blue, a loop crossing itself',
    '#2f6bdc',
    64,
    i => [230 + Math.cos(i / 6) * (30 + i * 0.6), 160 + Math.sin(i / 6) * 34, 0.25 + ((i * 7) % 10) / 14],
  ],
  [
    'highlighter, over them all',
    { color: '#ffd23f', size: 20, alpha: 0.45 },
    60,
    i => [20 + i * 6, 210 - i * 1.5, 0.6],
  ],
];

const html = gpu => `<!doctype html><meta name="viewport" content="width=device-width"><style>
  body { margin: 0; }
  #box { position: absolute; left: 20px; top: 20px; width: 400px; height: 300px; touch-action: none;
    background: repeating-linear-gradient(35deg, #e8f1ff 0 9px, #fff4d6 9px 15px, #2f2a3a 15px 17px),
      #e8f1ff; }
  #box canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
</style><div id="box"><canvas class="halo"></canvas><canvas class="ink"></canvas><canvas class="wet"></canvas></div>
<script type="module">
  import * as inkjs from '${HOST}/ink.js';
  const box = document.querySelector('#box'),
    [under, dry, wet] = box.querySelectorAll('canvas'),
    strokes = [];
  // (on the CPU, unless asked: headless WebKit's GPU canvas, Skia on Mesa, fills a path with four samples a pixel or
  // with exact soft edges as it sees fit, which neither Safari nor the line's shape does)
  if (!${gpu}) for (const c of [under, dry, wet]) c.getContext('2d', { willReadFrequently: true });
  window.__ink = null;
  const pen = inkjs.pen(box, wet, {
    halo: true,
    under,
    ink: () => window.__ink,
    end: s => strokes.push(s),
  });
  // the lift's second half, once the live line has been photographed: the dry canvas takes it, as review mode's does
  window.__dry = () => {
    inkjs.draw(inkjs.fit(dry), strokes, { halo: true });
    pen.clear();
  };
  window.__ready = true;
</script>`;

// A line drawn with synthetic pointer events, each move its own coalesced sample and two predicted ones on past it
// (the pen's tail, which must be gone by the lift), then lifted with pressure 0
const drawLine = (page, ink, points) =>
  page.evaluate(
    async ([ink, points]) => {
      window.__ink = ink;
      const box = document.querySelector('#box'),
        b = box.getBoundingClientRect();
      const send = (type, [x, y, pressure], [px, py] = [x, y]) => {
        const pen = { pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true },
          at = (x, y) => new PointerEvent(type, { ...pen, clientX: b.left + x, clientY: b.top + y, pressure }),
          e = at(x, y),
          ahead = [1, 2].map(j => at(x + (x - px) * j * 2, y + (y - py) * j * 2));
        Object.defineProperty(e, 'getCoalescedEvents', { value: () => [e] });
        Object.defineProperty(e, 'getPredictedEvents', { value: () => (type === 'pointermove' ? ahead : []) });
        box.dispatchEvent(e);
      };
      const frame = () => new Promise(r => requestAnimationFrame(() => r()));
      send('pointerdown', points[0]);
      for (let i = 1; i < points.length; i++) {
        send('pointermove', points[i], points[i - 1]);
        if (i % 4 === 0) await frame();
      }
      const last = points[points.length - 1];
      send('pointerup', [last[0], last[1], 0]);
      await frame();
      await frame();
    },
    [ink, points],
  );

// Two PNGs of the same size compared in the page: the largest channel difference, and the pixels past CLOSE
const compare = (page, a, b) =>
  page.evaluate(
    async ([a, b, close]) => {
      const pixels = async png => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const c = document.createElement('canvas');
        Object.assign(c, { width: img.naturalWidth, height: img.naturalHeight });
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const [p, q] = [await pixels(a), await pixels(b)];
      let worst = 0,
        changed = 0;
      for (let i = 0; i < p.length; i += 4) {
        const d = Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2]));
        worst = Math.max(worst, d);
        if (d > close) changed++;
      }
      return { worst, changed };
    },
    [a.toString('base64'), b.toString('base64'), CLOSE],
  );

// file: the ink.js to try (another version of it, to compare, with the files it imports beside it), by default the
// one beside this file; gpu: the canvases as a page has them, on the GPU where the browser puts them
export async function wetDry(page, { file = new URL('./ink.js', import.meta.url), gpu = false } = {}) {
  const headers = { 'access-control-allow-origin': '*' },
    ink = file instanceof URL ? file : pathToFileURL(file);
  // (each file by its name, from beside the ink.js)
  await page.route(`${HOST}/**`, async route => {
    const asked = new URL(route.request().url()).pathname.slice(1),
      body = await readFile(new URL(asked, ink), 'utf8');
    return route.fulfill({ contentType: 'text/javascript', headers, body });
  });
  await page.setContent(html(gpu));
  await page.waitForFunction(() => window.__ready);
  const box = page.locator('#box'),
    results = [];
  for (const [name, ink, n, at] of LINES) {
    const points = Array.from({ length: n }, (_, i) => at(i));
    await drawLine(page, typeof ink === 'string' ? { color: ink, size: 5 } : ink, points);
    const wet = await box.screenshot({ animations: 'disabled' });
    await page.evaluate(() => window.__dry());
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const dry = await box.screenshot({ animations: 'disabled' });
    results.push({ name, ...(await compare(page, wet, dry)) });
  }
  await page.unroute(`${HOST}/**`);
  return results;
}
