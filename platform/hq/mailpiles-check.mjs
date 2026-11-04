#!/usr/bin/env node
// Mail in piles (mail.ts PILES, mailsort.ts): Mail opens on the board's own pile
// alone, each other pile is one tap away with its count, and under an open mail one row of buttons moves it to another
// pile (its own pressed): the move is posted once, the mail leaves the pile it was in, and Team says which job has it.
// Nothing clipped: the piles and the move row stay inside the screen. In every look, on a phone and a laptop.
//   node platform/hq/mailpiles-check.mjs [out dir for shots]   (HQ's files from serve.mjs, its /api played here)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';
import { lookNames } from './looks.mjs';
const { chromium } = await import('/usr/local/lib/node_modules/playwright/index.mjs').catch(
  () => import('/opt/node22/lib/node_modules/playwright/index.mjs'),
);
const out = process.argv[2];
if (out) mkdirSync(out, { recursive: true });
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
const iso = h => new Date(Date.now() - h * 36e5).toISOString();
const row = (id, h, sender, recipient, subject, board, pile, extra = {}) => ({
  id,
  received: iso(h),
  sender,
  recipient,
  subject,
  board,
  pile,
  pile_by: 'model',
  ...extra,
});
const mail = () => [
  row(
    9,
    0.2,
    'quarterly-returns@accountancy-partners.example.net',
    'board@example.com',
    'Quarterly VAT return: two figures to check before Friday',
    1,
    'board',
  ),
  row(8, 0.5, 'domains@indexhelper.example', 'hello@example.com', 'Submit example.com to Search Engines', 0, 'spam'),
  row(
    7,
    2,
    'bounces+1@em.ads.example',
    'board@example.com',
    '[REGISTER NOW] Turn your data into buyer-ready deals',
    1,
    'spam',
  ),
  row(6, 3, 'ops@printer.example', 'partners@example.com', 'Which file format will you send?', 0, 'team', {
    pile_agent: 'dex',
    handed: 4321,
  }),
  row(5, 5, 'sam@mail.example', 'hello@example.com', 'My mug arrived chipped', 0, 'customer'),
  row(
    4,
    8,
    '0100abc-def@bounce.stripe.com',
    'invoices@example.com',
    'Your receipt from Anthropic Ireland, Limited #2497-1461-7420',
    0,
    'filed',
  ),
  row(
    3,
    9,
    '0100abd-def@bounce.stripe.com',
    'board@example.com',
    'someone@example.nl has accepted your invitation',
    1,
    'filed',
  ),
  row(2, 20, 'no-reply@accounts.example', 'board@example.com', 'A new sign-in on a Mac', 1, 'board', {
    pile_agent: 'penny',
  }),
  row(1, 30, 'old@example.org', 'hello@example.com', 'From before the sorter', 0, null),
];
for (const look of lookNames())
  for (const [width, height, device] of [
    [390, 844, 'phone'],
    [1280, 800, 'laptop'],
  ]) {
    const at = `${look}, ${device}`,
      moves = [],
      rows = mail();
    const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
    await ctx.route(`${base}/api/**`, async r => {
      const path = new URL(r.request().url()).pathname;
      if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
      if (path === '/api/brand') {
        const b = await (await r.fetch({ url: `${base}/mock/brand.json` })).json();
        // (the mail's own domain, as live: board@ for board@example.com)
        Object.assign(b.brand.mail, { forwardTo: 'juno', domain: 'example.com' });
        return r.fulfill({ json: b });
      }
      if (path === '/api/mail') return r.fulfill({ json: rows });
      // (each pile's whole count: 300 older spam than the list holds)
      if (path === '/api/mail/piles') {
        const counts = { board: 0, team: 0, customer: 0, filed: 0, spam: 300 };
        for (const m of rows) counts[m.pile ?? 'board']++;
        return r.fulfill({ json: counts });
      }
      if (path === '/api/mail/one')
        return r.fulfill({
          json: {
            id: Number(new URL(r.request().url()).searchParams.get('id')),
            body: 'Please check the two figures by Friday.',
            attachments: '[]',
          },
        });
      if (path === '/api/mail/move') {
        const { id, pile } = r.request().postDataJSON();
        moves.push([id, pile]);
        const m = rows.find(x => x.id === id);
        Object.assign(m, { pile, pile_by: 'board' }, pile === 'team' ? { handed: 16300 } : {});
        return r.fulfill({ json: pile === 'team' ? { job: 16300, already: false } : { pile } });
      }
      if (path === '/api/seen') return r.fulfill({ json: {} });
      if (path === '/api/gazette') return r.fulfill({ json: [] });
      if (path === '/api/requests' || path === '/api/review/products') return r.fulfill({ json: [] });
      return r.fulfill({ status: 404, body: '' });
    });
    const page = await ctx.newPage(),
      errors = [];
    // a shot once the window has finished opening, not half faded in
    const shot = async name => {
      if (!out) return;
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter(a => a.effect?.getTiming().iterations !== Infinity)
            .map(a => a.finished.catch(() => {})), // (one cancelled meanwhile is done too)
        ),
      );
      await page.screenshot({ path: `${out}/${look}-${device}-${name}.png` });
    };
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/?intro=0&renderer=${look}`);
    await page.waitForFunction(() => document.querySelector('#loading')?.classList.contains('gone'), null, {
      timeout: 30_000,
    });
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('mail')));
    await page.waitForSelector('.rows [data-mail]');
    const shown = () => page.$$eval('.rows [data-mail]', ds => ds.map(d => Number(d.dataset.mail)));
    const pills = () =>
      page.$$eval('[data-pile]', bs =>
        bs.map(b => [b.dataset.pile, b.querySelector('i').textContent, b.getAttribute('aria-checked')]),
      );
    const inside = sel =>
      page.$$eval(sel, els =>
        els.every(e => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.left >= 0 && r.right <= innerWidth;
        }),
      );
    assert.deepEqual(await shown(), [9, 2, 1], `${at}: the board's own pile, and mail not sorted yet`);
    assert.deepEqual(
      (await pills()).map(p => p.slice(0, 2)),
      [
        ['board', '3'],
        ['team', '1'],
        ['customer', '1'],
        ['filed', '2'],
        ['spam', '302'],
      ],
      at,
    );
    assert.ok(await inside('[data-pile]'), `${at}: every pile on screen`);
    // the board's lock and whom it's to stay on its line, the sender gives way
    const lockShown = id =>
      page.$eval(`[data-mail="${id}"] summary`, s => {
        const line = s.closest('.rows').getBoundingClientRect(),
          lock = s.querySelector('.lock').getBoundingClientRect(),
          to = s.querySelector('.mailto');
        return lock.width > 0 && lock.right <= Math.min(line.right, innerWidth) && to.scrollWidth <= to.clientWidth;
      });
    assert.ok(await lockShown(9), `${at}: the lock on a long sender's line`);
    const tall = sel => page.$$eval(sel, bs => bs.map(b => Math.round(b.getBoundingClientRect().height)));
    for (const h of await tall('[data-pile]')) assert.ok(h >= 40, `${at}: a pile ${h} px tall`);
    await shot('for-you');

    const open = async id => {
      await page.click(`[data-mail="${id}"] > summary`);
      await page.waitForSelector(`[data-mail="${id}"][data-loaded]`);
    };
    const moveRow = id =>
      page.$$eval(`[data-mail="${id}"] [data-move]`, bs => bs.map(b => [b.dataset.move, b.textContent, b.disabled]));
    await open(2);
    assert.deepEqual(
      await moveRow(2),
      [
        ['board', 'For you', true],
        ['team', 'To Penny', false],
        ['customer', 'Customer', false],
        ['filed', 'Filed', false],
        ['spam', 'Spam', false],
      ],
      `${at}: its pile pressed, Team names whom the sorter would hand it to`,
    );
    assert.ok(await inside('[data-mail="2"] [data-move]'), `${at}: the move row on screen`);
    for (const h of await tall('[data-mail="2"] [data-move]')) assert.ok(h >= 40, `${at}: a move ${h} px tall`);
    // the pile it's in reads as here, not as a key that's off: its words as bright as the others'
    const ink = await page.$$eval('[data-mail="2"] [data-move]', bs =>
      bs.map(b => [getComputedStyle(b).color, getComputedStyle(b).opacity]),
    );
    assert.deepEqual(ink[0], ink[1], `${at}: the pressed pile not dimmed`);
    await shot('open');
    await page.click('[data-mail="2"] [data-move="filed"]');
    await page.waitForSelector('.mailsaid');
    assert.deepEqual(await shown(), [9, 1], `${at}: moved out of the board's pile`);
    assert.match(await page.textContent('.mailsaid'), /Moved to Filed/);

    await page.click('[data-pile="spam"]');
    await page.waitForFunction(
      () => document.querySelector('[data-pile="spam"]')?.getAttribute('aria-checked') === 'true',
    );
    assert.deepEqual(await shown(), [8, 7], `${at}: Spam, one tap away`);
    assert.match(
      await page.textContent('.rows.mail + p'),
      /The latest 2 of 302\./,
      `${at}: a pile's count past its list`,
    );
    await open(8);
    await page.click('[data-mail="8"] [data-move="customer"]');
    await page.waitForFunction(() => !document.querySelector('[data-mail="8"]'));
    await page.click('[data-pile="team"]');
    await page.waitForFunction(
      () => document.querySelector('[data-pile="team"]')?.getAttribute('aria-checked') === 'true',
    );
    assert.match(await page.textContent('[data-mail="6"] .mailfrom'), /· Dex, job #4321 · ops@/, `${at}: who has it`);
    await shot('team');
    await page.click('[data-pile="board"]');
    await page.waitForFunction(
      () => document.querySelector('[data-pile="board"]')?.getAttribute('aria-checked') === 'true',
    );
    await open(9);
    await page.click('[data-mail="9"] [data-move="team"]');
    await page.waitForSelector('.mailsaid');
    assert.match(await page.textContent('.mailsaid'), /Moved to Team: job #16300 has it/, at);
    assert.deepEqual(
      moves,
      [
        [2, 'filed'],
        [8, 'customer'],
        [9, 'team'],
      ],
      `${at}: one post per move`,
    );
    assert.deepEqual(errors, [], at);
    await ctx.close();
  }
console.log('mailpiles-check: ok');
await browser.close();
server.close();
