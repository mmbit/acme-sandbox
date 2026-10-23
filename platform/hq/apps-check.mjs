#!/usr/bin/env node
// HQ-OS's Apps screen in a real browser on a phone: the front door's row, then the groups the brand's
// computer.appGroups gives, under their captions in its order, an app they don't name in a group after them, and one
// line above them counting our apps and the live ones. Without the setting, the groups by status, the count as our
// apps' caption. Filtering by name hides a group with nothing left.
//   node platform/hq/apps-check.mjs        (HQ in dev mode, its brand served as mock/brand.json)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const mock = JSON.parse(await readFile(`${ROOT}/platform/hq/mock/brand.json`, 'utf8'));
const apps = JSON.parse(await readFile(`${ROOT}/platform/hq/mock/apps.json`, 'utf8'));
const demo = {
  ...apps.find(a => a.slug === 'lanternfold'),
  slug: 'cycle-demo',
  name: 'Cycle Demo',
  status: 'demo',
  numbers: false,
};
const browser = await playwright().chromium.launch();

// What Apps shows with this brand.computer: its captions and lines, each with the tiles under it, and a function to
// type into the filter
async function appsWith(computer) {
  const brand = { ...mock, brand: { ...mock.brand, computer } };
  const files = { 'mock/brand.json': JSON.stringify(brand), 'mock/apps.json': JSON.stringify([...apps, demo]) };
  const server = await serve(undefined, 0, files),
    base = `http://localhost:${server.address().port}`;
  const { context, page, errors } = await openPage(browser, { viewport: { width: 390, height: 844 } });
  await page.goto(`${base}/?intro=0`);
  await until(page, '#loading.gone');
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('apps')));
  await page.waitForSelector('.applist [data-tile]');
  // the screen from top to bottom: a caption or line as its words, a list of tiles as their names
  const screen = () =>
    page.$$eval('.tiles > p.cap, .tilegroup:not([hidden]) > :is(p.cap, ul)', parts =>
      parts.map(part =>
        part.matches('ul')
          ? [...part.querySelectorAll('[data-tile]:not([hidden]) b')].map(b => b.textContent)
          : part.textContent.replace(/^> /, ''),
      ),
    );
  const shown = await screen();
  const wide = await page.$$eval(
    '.applist [data-tile]',
    tiles => tiles.filter(t => t.getBoundingClientRect().right > innerWidth).length,
  );
  assert.equal(wide, 0, "every tile on the phone's screen");
  await page.fill('.tilefilter', 'paper');
  const filtered = await screen();
  await context.close();
  server.close();
  assert.deepEqual(errors, []);
  return { shown, filtered };
}

const fallback = await appsWith(undefined);
assert.deepEqual(
  fallback.shown,
  [
    ['Front Door'],
    '4 APPS · 1 LIVE',
    ['Pebble Pals', 'Paper Moon', 'Lanternfold', 'Tiny Atlas'],
    'DEMOS · FROM THE VENTURE CYCLES',
    ['Cycle Demo'],
    'PLATFORM · THE PIECES BEHIND THE APPS',
    ['Hello (platform test)'],
  ],
  "without the setting: grouped by status, the count as our apps' caption",
);
assert.deepEqual(fallback.filtered, ['4 APPS · 1 LIVE', ['Paper Moon']], 'a filter hides the groups it empties');

const groups = [
  { caption: 'Prints', apps: ['tiny-atlas', 'paper-moon', 'no-such-app'] },
  { caption: 'The platform', apps: ['hello', 'front'] },
  { caption: 'Nothing here', apps: ['no-such-app'] },
];
const grouped = await appsWith({ appGroups: groups });
assert.deepEqual(
  grouped.shown,
  [
    ['Front Door'],
    '4 APPS · 1 LIVE',
    'PRINTS',
    ['Paper Moon', 'Tiny Atlas'],
    'THE PLATFORM',
    ['Hello (platform test)'],
    'OTHER APPS',
    ['Pebble Pals', 'Lanternfold'],
    'DEMOS · FROM THE VENTURE CYCLES',
    ['Cycle Demo'],
  ],
  "the brand's groups in its order, /api/apps' order in each, the count above them, then what they leave out",
);
assert.deepEqual(grouped.filtered, ['4 APPS · 1 LIVE', 'PRINTS', ['Paper Moon']], 'the count stays while filtering');

const unknown = await appsWith({ appGroups: [{ caption: 'Nothing here', apps: ['no-such-app'] }, 'not a group'] });
assert.deepEqual(unknown.shown, fallback.shown, 'groups that name no app: as without the setting');

await browser.close();
console.log('apps-check: ok');
