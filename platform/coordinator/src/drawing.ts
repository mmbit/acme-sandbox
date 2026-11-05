// A drawing an agent writes as SVG, drawn as a picture in the company's look, in the coordinator's own Chromium: its
// shapes and words styled by the stylesheet theme/hq.yaml's `drawing` names (a file of the company's under kits/ or
// theme/), with the platform's plain lines without one. The frame gives every drawing the same few words to style by,
// which the call's draw_picture tool names: accent, shade, arrow, thin and muted. Its ground is clear: on the page it's
// lines on its post-it, not a card of its own in it (bookgroups.css .bk-photo[data-drawing]), unless the company's
// stylesheet gives it one.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, posix } from 'node:path';
import { launch, type Tab } from '../../../shared/chromium/chromium.ts';
import { theme } from './company.ts';
import { REPO_DIR } from './config.ts';
import type { Refused } from './pagechecks.ts';

// The drawing's box in CSS px: a notebook scrap shows a picture at most about 320 px each way (notebookstack.js STACK,
// TALL), so it's drawn at twice that, its words at twice the size they're read at. Its picture's long side in px, sharp
// on a tablet with the page zoomed in.
export const DRAWN_PX = 640;
const LONG_PX = 1280;
// (the frame's own address: every request the page makes is answered here, none reaches a network)
const FRAME = 'https://drawing.invalid';
const COMPANY_FOLDERS = ['kits/', 'theme/'];
const TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// The picture of an SVG drawing ('<svg viewBox="…">…</svg>'), PNG, or why not
export async function drawn(svg: string): Promise<{ png: Buffer; width: number; height: number } | Refused> {
  const markup = svg.trim();
  if (!/^<svg[\s>]/.test(markup) || !markup.endsWith('</svg>'))
    return [400, 'svg: one drawing, from <svg viewBox="0 0 640 480"> to its </svg>'] as Refused;
  const browser = await launch();
  try {
    const tab = await browser.tab(async ({ url, method }) => (method === 'GET' ? answer(url, markup) : null));
    return await pictured(tab);
  } finally {
    await browser.close();
  }
}

// The frame's page and the company's files it loads, or null
function answer(url: string, svg: string) {
  if (url === `${FRAME}/`) return { type: 'text/html', body: Buffer.from(framePage(svg)) };
  const path = url.startsWith(`${FRAME}/`) ? posix.normalize(decodeURIComponent(new URL(url).pathname.slice(1))) : '';
  const file = `${REPO_DIR}/${path}`;
  if (!COMPANY_FOLDERS.some(f => path.startsWith(f)) || !TYPES[extname(path)] || !existsSync(file)) return null;
  return statSync(file).isFile() ? { type: TYPES[extname(path)], body: readFileSync(file) } : null;
}

// The drawing inside its frame: the words it's styled by, the platform's plain look, then the company's
function framePage(svg: string) {
  const look = theme().drawing;
  if (look !== undefined && (typeof look !== 'string' || !COMPANY_FOLDERS.some(f => look.startsWith(f))))
    throw new Error(`theme/hq.yaml's drawing isn't a stylesheet under kits/ or theme/: ${JSON.stringify(look)}`);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'">
<style>${PLAIN}</style>${look ? `<link rel="stylesheet" href="/${look}">` : ''}</head>
<body><svg class="defs" width="0" height="0" aria-hidden="true"><defs>
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path class="arrowhead" d="M1 1 9 5 1 9"/></marker>
<pattern id="shade" width="9" height="9" patternUnits="userSpaceOnUse"><circle class="dot" cx="2" cy="2" r="1.1"/><circle class="dot" cx="6.5" cy="6.5" r="1.1"/></pattern>
</defs></svg><main>${svg}</main></body></html>`;
}
const PLAIN = `
body { margin: 0; }
.defs { position: absolute; }
main { display: inline-block; padding: 16px; color: #000; font: 28px sans-serif; }
main > svg { display: block; width: ${DRAWN_PX}px; height: auto; overflow: visible; }
main :is(rect, circle, ellipse, line, polyline, polygon, path) {
  fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round;
}
main text { fill: currentColor; stroke: none; }
main .accent { fill: #ccc; }
main .shade { fill: url(#shade); }
main .arrow { marker-end: url(#arrow); }
main .thin { stroke-width: 1.5; }
main text.muted { fill: #666; }
.arrowhead { fill: none; stroke: #000; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.dot { fill: #000; }
`;

// The frame drawn, its fonts in, and taken at LONG_PX on its long side
async function pictured(tab: Tab) {
  await tab.send('Runtime.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', {
    width: 800,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // (the page's own white made clear, so only what's drawn is in the picture)
  await tab.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const navigated = await tab.send('Page.navigate', { url: `${FRAME}/` });
  if (navigated.errorText) throw new Error(`The drawing's frame didn't open: ${navigated.errorText}`);
  const box = await evaluate(tab, MEASURED);
  if (!box) return [400, 'svg: nothing to see. Give it a viewBox and something drawn inside it'] as Refused;
  const scale = LONG_PX / Math.max(box.width, box.height);
  const taken = await tab.send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...box, scale },
    captureBeyondViewport: true,
  });
  return {
    png: Buffer.from(taken.data, 'base64'),
    width: Math.round(box.width * scale),
    height: Math.round(box.height * scale),
  };
}
const MEASURED = `new Promise(resolve => {
  const ready = () => document.readyState === 'complete' ? document.fonts.ready.then(() => {
    const svg = document.querySelector('main > svg'), drawn = svg?.getBBox();
    const r = document.querySelector('main').getBoundingClientRect();
    resolve(drawn?.width && drawn.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
  }) : setTimeout(ready, 20);
  ready();
})`;

async function evaluate(tab: Tab, expression: string) {
  const answer = await tab.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (answer.exceptionDetails)
    throw new Error(
      `The drawing's frame failed: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`,
    );
  return answer.result?.value;
}
