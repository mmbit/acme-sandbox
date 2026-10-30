// A chart from a JSON file as a PNG at a scrap answer's size (twice its CSS px, for sharp screens), ready for
// hq answer <note> "<words>" --picture <png> --source "<its source>".
//   node shared/scrapchart/draw.mjs <chart.json> <chart.png>
import { readFileSync, writeFileSync } from 'node:fs';
import { playwright } from '../browser/browser.mjs';
import { chartSvg, HEIGHT, WIDTH } from './chart.js';

const [from, to] = process.argv.slice(2);
if (!from || !to?.endsWith('.png')) {
  console.error('usage: node shared/scrapchart/draw.mjs <chart.json> <chart.png>');
  process.exit(1);
}
const spec = JSON.parse(readFileSync(from, 'utf8'));
let svg;
try {
  svg = chartSvg(spec);
} catch (error) {
  console.error(`Not drawn: ${error.message}`);
  process.exit(1);
}
const browser = await playwright().chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><body style="margin:0">${svg}</body>`);
  writeFileSync(to, await page.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } }));
} finally {
  await browser.close();
}
console.log(
  `${to}: hq answer <note> "<what it shows>" --picture ${to} --source ${JSON.stringify(spec.source.replace(/\s+/g, ' ').trim())}`,
);
