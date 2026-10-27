#!/usr/bin/env node
// The Library's manual in every look HQ ships (looks.mjs), at a tablet's size with a stand-in /api: How HQ works is
// the first shelf, every tip on it (four tiles with their films' stills, the rest as keys), then Things you can ask for. A tile's
// Show me runs its tip from the Library, a key opens its card there (the desk phone's with Show me on the card it's about),
// and an ask key opens the intercom with its sentence started. In a company without the tips' films, the first look's
// shelf has every tip as a key and its cards no film, and HQ asks for none. With a folder, it saves the shelf per look.
//   node platform/hq/manual-check.mjs [screenshot-folder]
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';
import { lookNames } from './looks.mjs';
import { TIPS, ASKS, tipOf } from './shell/tips.js';

const { chromium } = playwright();
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const LOOKS = lookNames();
const TABLET = { width: 1180, height: 820 },
  PHONE = { width: 390, height: 820 },
  NARROW = { width: 1024, height: 768 },
  DESKTOP = { width: 1440, height: 820 };
const decision = {
  id: 3,
  created: new Date().toISOString(),
  agent: 'wren',
  kind: 'decision',
  title: 'A new bench for the garden?',
  body: 'About a bench.',
  urgency: 'today',
};
const library = [
  { path: 'company/CHARTER.md', title: 'Handbook', shelf: 'Handbook', author: 'lyra', html: '<p>Rules.</p>' },
];

const SHELVED = TIPS.filter(t => t.key !== 'asking')
  .map(t => t.name)
  .sort();

const browser = await chromium.launch();
for (const look of LOOKS) await checkLook(look);
await checkWithoutFilms(LOOKS[0]);
await browser.close();
server.close();
console.log('manual-check: passed in', LOOKS.join(', '));

async function checkLook(look) {
  const { context, page, errors, openShelf } = await openHq(look);

  // the shelf: first, every tip but asking (the shelf's second half), each once
  await openShelf();
  const shelf = await shelfOf(page);
  assert.equal(shelf.first, 'How HQ works', `${look}: the Library opens on How HQ works`);
  assert.deepEqual(shelf.heads, ['How HQ works', 'Things you can ask for']);
  assert.equal(shelf.tiles.length, 4, `${look}: four tiles`);
  assert.deepEqual([...shelf.tiles, ...shelf.keys].sort(), SHELVED, `${look}: every tip on the shelf`);
  assert.equal(shelf.keys[0], 'The desk phone', `${look}: the desk phone's first among the keys`);
  assert.deepEqual(
    shelf.asks,
    ASKS.map(a => a.key),
  );
  await page
    .waitForFunction(
      () => [...document.querySelectorAll('.manual .frame img')].filter(i => i.naturalWidth > 0).length === 4,
      null,
      { timeout: 5000 },
    )
    .catch(() => assert.fail(`${look}: every tile shows its film's still`));
  const tile = await page.$eval('.manual .tiles li', li => li.getBoundingClientRect().toJSON());
  assert.ok(tile.width > 120 && tile.height > 80, `${look}: a tile has room: ${JSON.stringify(tile)}`);
  await checkNamesClear(page, look);
  await page.waitForTimeout(400);
  if (process.argv[2]) {
    await page.screenshot({ path: `${process.argv[2]}/manual-${look}.png` });
    await page.$eval('.manual .asks', e => e.scrollIntoView({ block: 'end' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${process.argv[2]}/manual-${look}-asks.png` });
  }

  // a tile's Show me runs its tip: the Library makes way and each step points at its real control
  await page.click('.manual [data-show="machines"]');
  for (const at of tipOf('machines').steps.map(s => s.at)) {
    await page.waitForSelector('.showme-step:not([hidden])');
    await page.waitForTimeout(300);
    const [ring, control] = await page.evaluate(
      at =>
        [
          document.querySelector('.showme-ring'),
          [...document.querySelectorAll(at)].find(e => e.getBoundingClientRect().width > 0),
        ].map(e => e.getBoundingClientRect().toJSON()),
      at,
    );
    assert.ok(
      ring.left <= control.left && ring.right >= control.right && ring.top <= control.top,
      `${look}: the ring round ${at}`,
    );
    await page.click(at);
  }
  await page.waitForFunction(() => !document.querySelector('.showme-veil'));
  assert.ok(await page.$eval('#panel', p => p.hidden), `${look}: the Library made way`);
  await page.keyboard.press('Escape');

  // a key opens its card in the Library: the desk phone's Show me goes to the card it's about
  await openShelf();
  await page.click('.manual [data-tip="deskphone"]');
  await page.waitForSelector('#panel-body .req.tip [data-show-me]');
  assert.equal(await page.textContent('#panel-body .req.tip h3'), 'The desk phone');
  await page.waitForTimeout(500); // (the card's bounce settled)
  if (process.argv[2]) await page.screenshot({ path: `${process.argv[2]}/manual-${look}-card.png` });
  await page.click('#panel-body .req.tip [data-got]');
  await page.waitForSelector('#panel-body .manual'); // (Got it: back to the shelf)
  await page.click('.manual [data-tip="deskphone"]');
  await page.click('#panel-body [data-show-me]');
  await page.waitForSelector('.showme-step:not([hidden])');
  assert.equal(await page.textContent('#phone-screen h3'), decision.title, `${look}: on the card it's about`);
  await page.click('.showme-step .got');
  await page.waitForFunction(() => !document.querySelector('.showme-veil'));
  await page.keyboard.press('Escape');

  // an ask key: the intercom, the sentence started
  await openShelf();
  await page.click('.manual [data-ask="0"]');
  await page.waitForSelector('#dir-title');
  assert.equal(await page.inputValue('#dir-title'), ASKS[0].starts, `${look}: the sentence started`);
  await page.waitForFunction(() => document.querySelector('#panel').hidden); // (the Library made way)
  assert.deepEqual(errors, [], `${look}: no page errors`);
  await context.close();
  console.log(`manual-check: ${look}`);
}

// The first look in a company that hasn't recorded the tips' films: the tiles' tips join the keys, a tip's card has no
// film, and HQ asks for no film or still
async function checkWithoutFilms(look) {
  const { context, page, errors, openShelf } = await openHq(look, []);
  const asked = [];
  page.on('request', r => /\/films\/.+\.(mp4|jpg)$/.test(r.url()) && asked.push(r.url()));
  await openShelf();
  const shelf = await shelfOf(page);
  assert.deepEqual(shelf.tiles, [], `${look} without films: no tiles`);
  assert.deepEqual([...shelf.keys].sort(), SHELVED, `${look} without films: every tip a key`);
  await page.click('.manual [data-tip="machines"]');
  await page.waitForSelector('#panel-body .req.tip [data-show-me]');
  assert.equal(await page.$('#panel-body .req.tip .film'), null, `${look} without films: the card has no film`);
  assert.deepEqual(asked, [], `${look} without films: no film asked for`);
  assert.deepEqual(errors, [], `${look} without films: no page errors`);
  await context.close();
  console.log(`manual-check: ${look} without films`);
}

// HQ in a look on the stand-in /api, the desk phone's one card waiting. films: the company's tip films as
// films/films.json names them, when not its own.
async function openHq(look, films) {
  const { context, page, errors } = await openPage(browser, {
    viewport: TABLET,
    deviceScaleFactor: 1.5,
    hasTouch: true,
  });
  await context.addInitScript(() => localStorage.setItem('hq.sound', 'false'));
  if (films) await context.route(`${base}/films/films.json`, r => r.fulfill({ json: films }));
  await context.route(`${base}/api/**`, async r => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/org') return r.fulfill({ json: await (await r.fetch({ url: `${base}/mock/org.json` })).json() });
    if (path === '/api/requests') return r.fulfill({ json: [decision] });
    if (path === '/api/library') return r.fulfill({ json: library });
    if (path === '/api/tips') return r.fulfill({ json: { off: false } });
    if (path === '/api/book') return r.fulfill({ json: { day: null, today: null, days: [], pages: [] } }); // (the board's book, empty)
    const mocked = await r.fetch({ url: `${base}/mock${path.slice(4)}.json` });
    if (mocked.ok()) return r.fulfill({ response: mocked });
    if (path === '/api/seen') return r.fulfill({ json: {} });
    if (['/api/gazette', '/api/mail', '/api/review/products', '/api/requests/later'].includes(path))
      return r.fulfill({ json: [] });
    return r.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${base}/?renderer=${look}&intro=0&hour=11&weather=clear`);
  await until(page, '#loading.gone');
  await page.waitForFunction(() => document.querySelector('#desk-count')?.dataset.n === '1');
  const openShelf = async () => {
    await page.evaluate(() => import('/shell/news.js').then(m => m.openLibrary()));
    await page.waitForSelector('#panel-body .manual');
  };
  return { context, page, errors, openShelf };
}

// The Library's first shelf as it reads: its headings, its tiles' and keys' names and its ask keys
function shelfOf(page) {
  return page.evaluate(() => ({
    first: document.querySelector('#panel-body .shelves h3').textContent,
    tiles: [...document.querySelectorAll('.manual .tiles b')].map(b => b.textContent),
    keys: [...document.querySelectorAll('.manual .keys:not(.asks) button')].map(b => b.textContent),
    asks: [...document.querySelectorAll('.manual .asks button')].map(b => b.textContent),
    heads: [...document.querySelectorAll('.manual h3')].map(h => h.textContent),
  }));
}

// Each tile's name clear of its Show me, beside or under it, on a phone, a narrow screen and a desktop (with a folder, saved
// per size), then back at the tablet the rest of the check runs at. The narrow screen is there because its rows mix the two:
// some names have their Show me beside them, some under them.
async function checkNamesClear(page, look) {
  for (const viewport of [PHONE, NARROW, DESKTOP]) {
    await checkNamesClearAt(page, look, viewport);
    if (process.argv[2]) await page.screenshot({ path: `${process.argv[2]}/manual-${look}-${viewport.width}.png` });
  }
  await checkNamesClearAt(page, look, TABLET);
}

// the name's text is measured, not its box, which fills the row
async function checkNamesClearAt(page, look, viewport) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(200);
  const tiles = await page.$$eval('.manual .tiles li', lis =>
    lis.map(li => {
      const nameText = document.createRange();
      nameText.selectNodeContents(li.querySelector('b'));
      return {
        name: nameText.toString(),
        nameBox: nameText.getBoundingClientRect().toJSON(),
        showBox: li.querySelector('.show').getBoundingClientRect().toJSON(),
      };
    }),
  );
  for (const { name, nameBox, showBox } of tiles)
    assert.ok(
      nameBox.right <= showBox.left || nameBox.bottom <= showBox.top,
      `${look} at ${viewport.width}: ${name} runs into its Show me: ${JSON.stringify({ nameBox, showBox })}`,
    );
}
