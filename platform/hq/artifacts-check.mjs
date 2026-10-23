#!/usr/bin/env node
// HQ-OS's Artifacts in a real browser, in every look on a phone and a tablet, on HQ's mock data: the company's heroes on
// a shelf of their own, then every other artifact newest first, the archived ones left out. One row of pills picks: All,
// a line of business (or a project with none), or the archive. The search finds words in a name, a line, a business or a
// project, within the pick. A tap on a pill plays the look's click. In the keys look the search is as white as the tiles.
//   node platform/hq/artifacts-check.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const RENDERERS = ['brownstone', 'holo', 'wire'];
const artifacts = JSON.parse(await readFile(`${ROOT}/platform/hq/mock/artifacts.json`, 'utf8'));
// the same company without businesses: each artifact in its project alone
const flat = artifacts.map(a => ({ ...a, place: a.place.filter(p => p.level === 'project') }));
// and with some projects outside a business, under ids that collide: a project "archive", and a project "stickers" like
// the business
const ids = { office: 'archive', news: 'stickers' };
const mixed = artifacts.map(a => ({
  ...a,
  place: a.place
    .filter(p => p.id !== 'house')
    .map(p => (p.level === 'project' && ids[p.id] ? { ...p, id: ids[p.id] } : p)),
}));
const servers = await Promise.all([
  serve(undefined, 0),
  serve(undefined, 0, { 'mock/artifacts.json': JSON.stringify(flat) }),
  serve(undefined, 0, { 'mock/artifacts.json': JSON.stringify(mixed) }),
]);
const [base, flatBase, mixedBase] = servers.map(s => `http://localhost:${s.address().port}`);
const browser = await playwright().chromium.launch();

async function open(look, [width, height, device], at) {
  const phone = device === 'phone';
  const { context, page, errors } = await openPage(browser, {
    viewport: { width, height },
    hasTouch: phone,
    isMobile: phone,
  });
  await page.goto(`${at}/?intro=0&renderer=${look}`);
  await until(page, '#loading.gone', undefined, 60_000);
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('artifacts')));
  await page.waitForSelector('.artifacts .applist li');
  // the tiles shown, by name, on the heroes' shelf or below it; the pills, the picked one marked *
  const tiles = list =>
    page.$$eval(`.artifacts ${list}:not([hidden]) > li:not([hidden]) .open b`, bs => bs.map(b => b.textContent));
  const shown = async () => [...(await tiles('.heroes')), ...(await tiles('.applist:not(.heroes)'))];
  const pills = () =>
    page.$$eval('.artifacts .pills button', bs =>
      bs.map(b => `${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}${b.textContent}`),
    );
  const press = name => page.locator('.artifacts .pills').getByRole('button', { name, exact: true }).click();
  // tiles or the pills' row past the screen's right edge
  const wide = () =>
    page.$$eval(
      '.artifacts :is(.applist li, .pills)',
      els => els.filter(e => e.getBoundingClientRect().right > innerWidth).length,
    );
  return { context, page, errors, shown, tiles, pills, press, wide };
}
const named = list => list.map(a => a.name);
const current = artifacts.filter(a => !a.archived);

for (const look of RENDERERS)
  for (const size of [
    [320, 800, 'phone'],
    [360, 800, 'phone'],
    [390, 844, 'phone'],
    [1180, 820, 'tablet'],
  ]) {
    const where = `${look}, ${size[2]}, ${size[0]}px`;
    const { context, page, errors, shown, tiles, pills, press, wide } = await open(look, size, base);

    assert.deepEqual(await tiles('.heroes'), named(current.filter(a => a.hero)), `${where}: the heroes, in order`);
    assert.deepEqual(await shown(), named(current), `${where}: then the rest, newest first, none archived`);
    assert.equal(await page.locator('.crt .tilegroup, .crt p.cap').count(), 0, `${where}: no sections or captions`);
    assert.equal(await wide(), 0, `${where}: every tile and the pills on the screen`);
    assert.equal(await page.locator('.artifacts .pills').count(), 1, `${where}: one row of pills`);
    assert.deepEqual(
      await pills(),
      ['*All', 'In house', 'Sticker Co', 'Archive'],
      `${where}: all, by name, the archive`,
    );

    // a line of business: its artifacts alone, its heroes still first; one pick at a time
    await page.evaluate(() => {
      window.clicks = 0;
      import('/shell/audio.js').then(m => {
        const blip = m.sfx.blip;
        m.sfx.blip = (...a) => (window.clicks++, blip(...a));
      });
    });
    await press('Sticker Co');
    assert.deepEqual(await shown(), named(current.filter(a => a.place[0]?.id === 'stickers')), where);
    assert.deepEqual(await tiles('.heroes'), ['Front Door', 'Tiny Atlas'], `${where}: its heroes`);
    assert.equal(await page.evaluate(() => window.clicks), 1, `${where}: a pill clicks`);
    await press('In house');
    assert.deepEqual(await pills(), ['All', '*In house', 'Sticker Co', 'Archive'], `${where}: one pick`);
    assert.deepEqual(await shown(), named(current.filter(a => a.place[0]?.id === 'house')), where);

    // the archive: what's archived, and no heroes' shelf
    await press('Archive');
    assert.deepEqual(await shown(), named(artifacts.filter(a => a.archived)), `${where}: the archive`);
    assert.ok(!(await page.locator('.artifacts .heroes').isVisible()), `${where}: no shelf in the archive`);
    await press('All');
    assert.deepEqual(await shown(), named(current), where);

    // the search: every word somewhere in it, in any case or accent; nothing left says so
    await page.fill('.artifacts .tilefilter', 'BACKUP');
    assert.deepEqual(await shown(), ['Backup plan'], where);
    await page.fill('.artifacts .tilefilter', 'newsletter banner');
    assert.deepEqual(await shown(), ['Banner set'], `${where}: a project's name counts`);
    await page.fill('.artifacts .tilefilter', 'sticker co front');
    assert.deepEqual(await shown(), ['Front Door'], `${where}: a business's name counts`);
    await page.fill('.artifacts .tilefilter', 'lanternfold');
    assert.deepEqual(await shown(), [], `${where}: the archive only in the archive`);
    assert.ok(await page.locator('.artifacts .none').isVisible(), `${where}: Nothing matches`);
    await press('Archive');
    assert.deepEqual(await shown(), ['Lanternfold'], `${where}: the search in the archive`);
    await page.fill('.artifacts .tilefilter', '');

    // a refresh keeps the pick and what's typed
    await press('Sticker Co');
    await page.fill('.artifacts .tilefilter', 'pebble');
    await page.evaluate(() =>
      import('/shell/artifacts.js').then(m => m.artifactList(document.querySelector('#crt'), { dev: true })),
    );
    assert.deepEqual(await pills().then(p => p.filter(x => x.startsWith('*'))), ['*Sticker Co'], where);
    assert.deepEqual(await shown(), ['Pebble Pals', 'Pebble Pals film'], where);

    // white, never grey: the search is the tiles' colour
    if (look === 'wire') {
      const [field, tile] = await page.evaluate(() =>
        ['.artifacts .tilefilter', '.artifacts .applist .pic'].map(
          s => getComputedStyle(document.querySelector(s)).backgroundColor,
        ),
      );
      assert.equal(field, tile, `${where}: the search is as white as the tiles`);
    }
    assert.deepEqual(errors, [], where);
    await context.close();

    // a company without businesses: its projects
    const company = await open(look, size, flatBase);
    assert.deepEqual(
      await company.pills(),
      ['*All', 'Gift wrap', 'The newsletter', 'The office', 'The sticker shop', 'Archive'],
      `${where}, no businesses: every project`,
    );
    await company.press('The office');
    assert.deepEqual(
      await company.shown(),
      named(flat.filter(a => !a.archived && a.place[0]?.id === 'office')),
      `${where}, no businesses`,
    );
    assert.deepEqual(company.errors, [], `${where}, no businesses`);
    await company.context.close();

    // a project without a business sits in the row beside the businesses, and one pick is one pill, whatever its id
    const unassigned = await open(look, size, mixedBase);
    const pickOf = (level, id) => mixed.filter(a => !a.archived && a.place[0]?.level === level && a.place[0].id === id);
    assert.deepEqual(
      await unassigned.pills(),
      ['*All', 'Sticker Co', 'The newsletter', 'The office', 'Archive'],
      `${where}, mixed`,
    );
    for (const [name, level, id] of [
      ['The office', 'project', 'archive'],
      ['The newsletter', 'project', 'stickers'],
      ['Sticker Co', 'business', 'stickers'],
    ]) {
      await unassigned.press(name);
      assert.deepEqual(
        (await unassigned.pills()).filter(p => p.startsWith('*')),
        [`*${name}`],
        `${where}, mixed: ${name} alone`,
      );
      assert.deepEqual(await unassigned.shown(), named(pickOf(level, id)), `${where}, mixed: ${name}'s artifacts`);
    }
    await unassigned.press('Archive');
    assert.deepEqual(await unassigned.shown(), named(mixed.filter(a => a.archived)), `${where}, mixed: the archive`);
    assert.deepEqual(unassigned.errors, [], `${where}, mixed`);
    await unassigned.context.close();
  }

await browser.close();
servers.forEach(s => s.close());
console.log(`artifacts-check: ok (${RENDERERS.length} looks × three phone widths and tablet)`);
