#!/usr/bin/env node
// HQ's search in a real browser: / opens the field in every look (not while a field has the keys), a task's code finds
// that task first and Enter opens it in the projects view, a typed prefix picks its chip, Escape closes the field alone,
// keywords rank in under 100 ms, a company app's own category (its finds) has its chip, its prefix and its things, and a
// place that didn't answer (Mail's list, the search by meaning) says so in every look, never "Nothing found". A machine's
// name opens its page in Settings, a look's name Settings › Look, and Settings is found when its seats don't load. A
// card answered a week ago waits behind "n more" while a fresh one shows, and shows when nothing fresher matches. A card
// waiting a week is never behind. An answered card beyond the first 50 is found and opens.
//   node platform/hq/finder-check.mjs        (HQ in dev mode, on its mock data)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';
import { lookNames } from './looks.mjs';

const KEYWORDS_MS = 100;
// a stand-in company app whose finds list one kite, which opens it at that kite
const THINGS = `let opened = 'the list';
export const app = { name: 'Things', what: 'A stand-in', icon: 'app-care' };
export async function draw(el) { el.innerHTML = '<p data-thing>' + opened + '</p>'; }
export const finds = { name: 'Kites', prefix: 'k', async list(hq) {
  return [{ key: '1', title: 'A torn kite', codes: ['K-7'], sub: 'Pinwheel', open() { opened = 'K-7'; hq.open('things'); } }];
} };`;
const mock = JSON.parse(await readFile(`${ROOT}/platform/hq/mock/brand.json`, 'utf8'));
const brand = { ...mock, theme: { ...mock.theme, apps: ['things'] } };
// three cards a word finds: one waiting for eight days, one for an hour, and one answered eight days ago
const HOUR = 3600_000,
  ago = ms => new Date(Date.now() - ms).toISOString();
const requests = JSON.parse(await readFile(`${ROOT}/platform/hq/mock/requests.json`, 'utf8')).map(r =>
  r.id === 31
    ? { ...r, title: 'Zephyr: the waiting card', created: ago(8 * 24 * HOUR) }
    : r.id === 32
      ? { ...r, title: 'Zephyr: the fresh card', created: ago(HOUR) }
      : r,
);
const [first, ...archive] = JSON.parse(await readFile(`${ROOT}/platform/hq/mock/archive.json`, 'utf8'));
const answered = [
  ...Array.from({ length: 60 }, (_, i) => ({ ...first, id: 1000 + i, title: `Filed card ${i}`, answered: ago(HOUR) })),
  ...archive,
  { ...first, title: 'Zephyr: the old card', created: ago(8 * 24 * HOUR), answered: ago(8 * 24 * HOUR) },
];
const browser = await playwright().chromium.launch();
const server = await serve(undefined, 0, {
  'mock/brand.json': JSON.stringify(brand),
  'kits/things/app.js': THINGS,
  'mock/requests.json': JSON.stringify(requests),
  'mock/archive.json': JSON.stringify(answered),
});
const base = `http://localhost:${server.address().port}`;
const { context, page, errors } = await openPage(browser, { viewport: { width: 1280, height: 800 } });
try {
  for (const look of lookNames()) {
    await openHq(page, look);
    await page.keyboard.press('/');
    await until(page, '#finder:not([hidden])');
    assert.ok(
      await page.evaluate(() => document.activeElement === document.querySelector('#finder input')),
      `${look}: / puts the keys in the field`,
    );
    await page.keyboard.press('Escape');
    await until(page, '#finder[hidden]');
  }

  // A task's code: that task first, and Enter opens it, its card over the projects view
  await openHq(page, 'brownstone');
  await page.keyboard.press('/');
  await until(page, '#finder [role=option]');
  await page.keyboard.type('SH-DOMAIN');
  await until(page, '#finder-row-0', /SH-DOMAIN/);
  assert.match(await page.textContent('#finder-row-0'), /Pick a domain for the sticker shop/);
  await page.keyboard.press('Enter');
  await until(page, '#finder[hidden]');
  await until(page, '#projects .pj-card', /Pick a domain for the sticker shop/);
  await page.keyboard.press('Escape');

  // Keywords rank in under KEYWORDS_MS, each list already read: the field's input to its rows
  await page.keyboard.press('Escape');
  await page.keyboard.press('/');
  await until(page, '#finder [role=option]');
  const ms = await page.evaluate(() => {
    const input = document.querySelector('#finder input'),
      times = [];
    for (const word of ['s', 'st', 'sti', 'stic', 'sticker', 'sticker shop']) {
      const at = performance.now();
      input.value = word;
      input.dispatchEvent(new Event('input'));
      times.push(performance.now() - at);
    }
    return Math.max(...times);
  });
  assert.ok(ms < KEYWORDS_MS, `keywords ranked in ${ms.toFixed(1)} ms`);

  // A prefix picks its chip (the people's), and the field keeps only the words; Escape leaves the open device as it was
  await page.fill('#finder input', '');
  await page.keyboard.type('p:');
  await until(page, '#finder [data-only="people"][aria-pressed="true"]');
  assert.equal(await page.inputValue('#finder input'), '');
  await page.keyboard.press('Escape');
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer()));
  await until(page, '#tool:not([hidden]) [data-app]');
  await page.locator('#tool [data-app]').first().focus();
  await page.keyboard.press('/');
  await until(page, '#finder:not([hidden])');
  await page.keyboard.press('Escape');
  await until(page, '#finder[hidden]');
  assert.ok(
    await page.isVisible('#tool [data-app]'),
    'Escape in the field closes the field, not the computer under it',
  );

  // A company app's category: its prefix picks its chip, and its thing opens in the app; Care's tickets the same way
  await page.keyboard.press('Escape');
  await page.keyboard.press('/');
  await page.keyboard.type('k:');
  await until(page, '#finder [data-only="things"][aria-pressed="true"]');
  await page.keyboard.type('K-7');
  await until(page, '#finder-row-0', /A torn kite/);
  await page.keyboard.press('Enter');
  await until(page, '#tool [data-thing]', /K-7/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('/');
  await page.keyboard.type('t:H-1001');
  await until(page, '#finder [data-only="care"][aria-pressed="true"]');
  await until(page, '#finder-row-0', /H-1001/);
  await page.keyboard.press('Enter');
  await until(page, '#tool header', /Care › H-1001/);
  await page.keyboard.press('Escape');

  // Settings: a machine's name opens its page, a look's name the looks (on the Look row, that look's name as its code)
  await openHq(page, 'wire');
  await page.keyboard.press('/');
  await page.keyboard.type('The rig');
  await until(page, '#finder-row-0', /The rig.*Settings › Machines/);
  await page.keyboard.press('Enter');
  await until(page, '#tool header', /Settings › Machines › The rig/);
  await until(page, '#tool .seat-name', /The rig/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('/');
  await page.keyboard.type('brownstone');
  await until(page, '#finder-row-0', /^Look\s*Brownstone/);
  await page.keyboard.press('Enter');
  await until(page, '#tool header', /Settings › Look/);
  await until(page, '#tool [data-look="brownstone"]');
  await page.keyboard.press('Escape');
  // Seats that don't load: the rest of Settings is still found, and the field names what wasn't
  await context.route(/\/mock\/seats\.json$/, route => route.fulfill({ status: 503, body: '' }));
  await openHq(page, 'wire');
  await page.keyboard.press('/');
  await page.keyboard.type('brownstone');
  await until(page, '#finder-row-0', /^Look\s*Brownstone/);
  await until(page, '#finder .finder-failed', /Settings › Seats didn’t load, so it isn’t searched/);
  await page.keyboard.press('Escape');
  await context.unroute(/\/mock\/seats\.json$/);

  // A card answered a week ago: behind "1 more" while fresher ones match, on the chip after them, and shown when nothing
  // fresher matches. One waiting a week is up front.
  await page.keyboard.press('/');
  await page.keyboard.type('zephyr');
  await until(page, '#finder-list', /Zephyr: the fresh card/);
  await until(page, '#finder .finder-more[data-only="cards"]', /1 more/, 5000);
  const fresher = ['Zephyr: the waiting card', 'Zephyr: the fresh card'];
  assert.deepEqual(await group(page, 'cards'), { rows: fresher, more: '1 more in' });
  await page.click('#finder .finder-more[data-only="cards"]');
  await until(page, '#finder [data-only="cards"][aria-pressed="true"]');
  assert.deepEqual((await group(page, 'cards')).rows, [...fresher, 'Zephyr: the old card']);
  await page.fill('#finder input', '');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('zephyr old');
  await until(page, '#finder-list', /Zephyr: the old card/);
  assert.deepEqual(await group(page, 'cards'), { rows: ['Zephyr: the old card'], more: null });
  await page.keyboard.press('Escape');

  // A whole old title or code ranks first and opens the card beyond the first page.
  for (const query of ['Zephyr: the old card', `#${first.id}`, String(first.id)]) {
    await page.keyboard.press('/');
    await page.fill('#finder input', query);
    await until(page, '#finder-row-0', /Zephyr: the old card/);
    await page.keyboard.press('Enter');
    await until(page, '#phone-screen article.past h3', /Zephyr: the old card/);
    await page.keyboard.press('Escape');
  }

  // In a field that has the keys, / is a character
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openIntercom()));
  await page.focus('#tool textarea');
  await page.keyboard.press('/');
  assert.ok(await page.isHidden('#finder'), 'a / typed in a field stays there');

  // A place that didn't answer: its line, never "Nothing found" for it; an empty field is no failed search. (In dev mode
  // the search by meaning reads mock/meaning.json, the stand-in for /api/search/meaning.)
  await context.route(/\/mock\/(mail|meaning)\.json$/, route => route.fulfill({ status: 503, body: '' }));
  for (const look of lookNames()) {
    await openHq(page, look);
    await page.keyboard.press('/');
    await until(page, '#finder [role=option]');
    assert.equal(await page.locator('#finder .finder-failed').count(), 0, `${look}: an empty field shows no failure`);
    await page.keyboard.type('m:welcome');
    await until(page, '#finder .finder-failed', /Mail didn’t load, so it isn’t searched/);
    assert.equal(
      await page.locator('#finder .finder-none').count(),
      0,
      `${look}: no "Nothing found" in a Mail that failed`,
    );
    await page.fill('#finder input', '');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('unmatched-semantic-fixture');
    await until(page, '#finder-list', /Search by meaning didn’t answer\./);
    await until(
      page,
      '#finder-list',
      /Mail didn’t load.*Nothing found for “unmatched-semantic-fixture” in the places that answered/,
    );
    await page.keyboard.press('Escape');
  }
  await context.unroute(/\/mock\/(mail|meaning)\.json$/);

  assert.deepEqual(errors, []);
  console.log('finder-check: passed');
} finally {
  await context.close();
  await browser.close();
  server.close();
}

// A category's rows as the field shows them (each title), and its "n more" button's words up to the category's name
function group(page, id) {
  return page.evaluate(id => {
    const name = document.querySelector(`.finder-chips [data-only="${id}"]`).textContent;
    const items = [...document.querySelectorAll('#finder-list > li')];
    const at = items.findIndex(li => li.matches('.finder-cap') && li.textContent === name);
    const end = items.findIndex((li, i) => i > at && li.matches('.finder-cap'));
    const own = items.slice(at + 1, end < 0 ? undefined : end);
    const more =
      own
        .find(li => li.querySelector('.finder-more'))
        ?.textContent.replace(name, '')
        .trim() ?? null;
    return { rows: own.filter(li => li.matches('[role=option]')).map(li => li.querySelector('b').textContent), more };
  }, id);
}
async function openHq(page, look) {
  await page.goto(`${base}/?intro=0&renderer=${look}`);
  await until(page, '#loading.gone');
}
