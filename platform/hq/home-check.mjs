#!/usr/bin/env node
// HQ-OS's home screen in a real browser: the apps in the groups and order the brand's computer.apps gives, an app it
// doesn't name after them, including one naming an unknown group. Settings is always last. Without the setting, the
// foundation's own groups set the order. One grid of equal tiles,
// four across at most (squarer, like an old computer's screen), every row full but the last, every label whole, and still
// whole after the phone turns. (Four across)
//   node platform/hq/home-check.mjs        (HQ in dev mode, its brand served as mock/brand.json)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const mock = JSON.parse(await readFile(`${ROOT}/platform/hq/mock/brand.json`, 'utf8'));
const browser = await playwright().chromium.launch();

// the home screen's groups, each a list of app ids, with this brand.computer (and these kits' apps: theme.apps, their files)
async function homeWith(computer, width = 420, kits = {}) {
  const brand = { ...mock, brand: { ...mock.brand, computer }, theme: { ...mock.theme, apps: Object.keys(kits) } };
  const files = Object.fromEntries(Object.entries(kits).map(([id, js]) => [`kits/${id}/app.js`, js]));
  const server = await serve(undefined, 0, { 'mock/brand.json': JSON.stringify(brand), ...files }), base = `http://localhost:${server.address().port}`;
  const { context, page, errors } = await openPage(browser, { viewport: { width, height: 844 } });   // (the fallback font is wider)
  await page.goto(`${base}/?intro=0`);
  await until(page, '#loading.gone');
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer()));
  await page.waitForSelector('[data-app]');
  for (const id of Object.keys(kits)) await page.waitForSelector(`[data-app="${id}"]`);   // (drawn again once they've loaded)
  const grids = await page.$$eval('ul.apps', lists => lists.map(l => [...l.querySelectorAll('[data-app]')].map(b => b.dataset.app)));
  assert.equal(grids.length, 1, 'one grid, the groups one after the other');
  // equal tiles, four across at most and every row full but the last (10 apps: rows of 4, 4 and 2), and no label cut
  const tiles = await page.$$eval('ul.apps button', bs => bs.map(b => { const r = b.getBoundingClientRect(), label = b.querySelector('b');
    return { top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), cut: label.scrollWidth > label.clientWidth }; }));
  const rows = Object.values(Object.groupBy(tiles, t => t.top)).map(row => row.length);
  assert.equal(new Set(tiles.map(t => `${t.w}x${t.h}`)).size, 1, 'every tile the same size');
  assert.ok(rows[0] <= 4 && rows.slice(0, -1).every(n => n === rows[0]) && rows.at(-1) <= rows[0], `rows of ${rows}`);
  if (width >= 420 && tiles.length >= 9) assert.ok(rows.length >= 3, `three rows or more, not ${rows.length}`);
  assert.deepEqual(tiles.filter(t => t.cut), [], 'every label whole on a phone');
  if (width > 560) {   // turned to portrait after opening: the columns are counted again
    const across = () => page.$eval('ul.apps', l => getComputedStyle(l).gridTemplateColumns.split(' ').length);
    // as many across as balanced rows of at most four take (10 apps: 4 across; 9: 3 across, three full rows)
    assert.equal(await across(), Math.ceil(tiles.length / Math.ceil(tiles.length / 4)), 'balanced rows of at most four in landscape');
    await page.setViewportSize({ width: 280, height: 760 }); await page.waitForTimeout(300);
    assert.ok(await across() < 4, 'fewer across once narrower');
    assert.deepEqual(await page.$$eval('ul.apps b', bs => bs.filter(b => b.scrollWidth > b.clientWidth).map(b => b.textContent)), [], 'every label whole after turning');
  }
  await page.click('[data-app=mail]'); await page.waitForSelector('[data-home]');   // a button still opens its app
  assert.match(await page.textContent('.device header b'), /› Mail/);
  await context.close(); server.close();
  assert.deepEqual(errors, []);
  return grids[0];
}

const all = await homeWith(undefined);   // (one grid now)
// without the setting, the foundation's groups: work to look at (the Sketchbook's too), talking, the business (Care and
// Photos name it), the team and the machine (the projects view is the HUD's key, not an app here.)
assert.deepEqual(all, ['notes', 'artifacts', 'sketchbook', 'calls', 'mail', 'onair', 'numbers', 'care', 'studio', 'people', 'seats', 'settings'],
  'related apps side by side, Reviews beside Artifacts');
// a company's own app at the end of the group it names, and one that names none in a group of its own before the team's
const kitApp = group => `export const app = { name: 'Kit', what: '', icon: 'app-mail'${group ? `, group: '${group}'` : ''} };\nexport function draw() {}\n`;
assert.deepEqual(await homeWith(undefined, 420, { chat: kitApp('talk'), misc: kitApp() }),
  ['notes', 'artifacts', 'sketchbook', 'calls', 'mail', 'onair', 'chat', 'numbers', 'care', 'studio', 'misc', 'people', 'seats', 'settings'], 'a company app in its group');
// a company that turns the Sketchbook off: not on its computer
assert.deepEqual(await homeWith({ sketchbook: false }), all.filter(a => a !== 'sketchbook'), 'the Sketchbook off');
// An app naming an unknown group still shows after the groups, with or without the setting.
assert.deepEqual(await homeWith(undefined, 420, { odd: kitApp('games') }), [...all.slice(0, -1), 'odd', 'settings'], 'an app in an unknown group');
assert.deepEqual(await homeWith({ apps: [['mail']] }, 420, { odd: kitApp('games') }),
  ['mail', ...all.filter(a => !['mail', 'settings'].includes(a)), 'odd', 'settings'], 'an app in an unknown group, with the setting');
assert.deepEqual(await homeWith(undefined, 360), all, 'a narrow phone: the same order, every label whole');
assert.deepEqual(await homeWith(undefined, 844), all, 'a phone turned back upright after opening');

const placed = await homeWith({ apps: [['settings', 'mail'], ['people']] });
assert.deepEqual(placed, ['mail', 'people', ...all.filter(a => !['settings', 'mail', 'people'].includes(a)), 'settings'],
  'the brand\'s groups in its order, then the apps it leaves out, and Settings last wherever the brand puts it');

const odd = await homeWith({ apps: [['mail', 'no-such-app', 'mail'], 'not a group', []] });
assert.deepEqual(odd, ['mail', ...all.filter(a => a !== 'mail')], 'an unknown id, a repeat and a non-list are skipped');

// Mail's count: the mail since Mail was last open on any device (the read marks: mock/seen.json), on its icon and in
// the computer button's sum; before anything's recorded, the last day's. Opening
// Mail marks it seen, unless the board
// left before its mail came: with `leave`, dev mode's mail list (fetched until one answer is cached) is held until then.
async function mailCount(seen, leave = false) {
  const at = h => new Date(Date.now() - h * 36e5).toISOString();
  const mail = [3, 2, 1].map(id => ({ id, received: at([0, 1, 2, 48][id]), sender: 'a@example.com', recipient: 'hello@example.com', subject: `Mail ${id}`, length: 9 }));
  const marks = JSON.stringify(seen == null ? {} : { mail: seen });
  const server = await serve(undefined, 0, { 'mock/mail.json': JSON.stringify(mail), 'mock/seen.json': marks }), base = `http://localhost:${server.address().port}`;
  const { context, page, errors } = await openPage(browser, { viewport: { width: 390, height: 844 } });
  let release, held = 0; const gate = new Promise(r => release = r);
  if (leave) await context.route(/\/mock\/mail\.json/, async r => { held++; await gate; await r.continue(); });
  await page.goto(`${base}/?intro=0`);
  await until(page, '#loading.gone');
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer()));
  if (leave) {
    await page.click('[data-app=mail]'); const asked = held;
    while (held === asked) await page.waitForTimeout(50);   // Mail's own request is on its way
    await page.click('[data-home]'); await page.waitForSelector('[data-app=notes]');
    release(); await page.waitForTimeout(500);
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer()));   // a fresh home screen, counted again
  }
  const icon = () => page.$eval('[data-app=mail]', b => b.parentElement.querySelector('.count')?.getAttribute('aria-label') ?? null);
  const total = () => page.$eval('#computer-count', b => b.hidden ? 0 : parseInt(b.getAttribute('aria-label')));
  // (the count painted, at 0 too: a company with nothing else waiting shows none once Mail's is seen)
  await page.waitForFunction(() => document.querySelector('[data-app=notes]') && document.querySelector('#computer-count[aria-label]'));
  await page.waitForTimeout(300);
  const mailSeen = () => page.evaluate(() => import('/shell/seen.js').then(m => m.seen?.mail ?? null));
  const before = { icon: await icon(), total: await total(), seen: await mailSeen() };
  if (leave) { await context.close(); server.close(); assert.deepEqual(errors, []); return { before }; }
  await page.click('[data-app=mail]'); await page.waitForSelector('.rows [data-mail]');
  await page.click('[data-home]'); await page.waitForSelector('[data-app=notes]'); await page.waitForTimeout(300);
  const after = { icon: await icon(), total: await total(), seen: await mailSeen() };
  await context.close(); server.close();
  assert.deepEqual(errors, []);
  return { before, after };
}
const first = await mailCount(null);
assert.equal(first.before.icon, '2 waiting in Mail', 'nothing recorded: the last day\'s mail is new');
assert.equal(first.after.icon, null, 'opening Mail marks it seen');
assert.equal(first.before.total - first.after.total, 2, 'the computer\'s button sums Mail\'s count');
assert.equal(first.after.seen, 3);
assert.equal((await mailCount(2)).before.icon, '1 waiting in Mail', 'only the mail since the last one shown');
assert.equal((await mailCount(3)).before.icon, null, 'all seen: no count');
const left = await mailCount(2, true);
assert.equal(left.before.seen, 2, 'Mail left before its mail came: nothing seen');
assert.equal(left.before.icon, '1 waiting in Mail', 'and the count stays');

await browser.close();
console.log('home-check: ok');
