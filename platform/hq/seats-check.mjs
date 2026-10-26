#!/usr/bin/env node
// HQ-OS › Seats and Settings › Seats in a real browser, on mock/seats.json and mock/seat-providers.json with dev mode's
// mock worker: the Seats app shows each seat's state in a word and its windows, a
// paced seat's tooltip and even-pace tick, and nothing to change; Settings' Seats row says what needs the board; each seat's
// row reads in a word or two, and its page has its sign-in, Pause, Stop at and Remove, each change saying how it went; Add a seat (a subscription that signs in, a key, a service of the board's own, a refused name); a
// sign-in step by step (a code pasted, a wrong one, a code to type on the provider's page); Remove asks in place and says
// the account stays open; no provider switch (each agent's own page has its model: models-check.mjs); the platform's
// pay-per-use keys offered only once a seat uses one; Pace each week; a key never stays in the page; a field being typed
// in survives the refresh; a login card on the desk phone opens that seat's page; the back button steps back a page at a
// time. In every look, on a phone and a laptop.
//   node platform/hq/seats-check.mjs [looks]  (holo,wire: those only; screenshots go to a temp folder, printed at the end)
// (the CLIs beyond Claude Code and Codex)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { playwright, errorsOf, tap, until } from '../../shared/browser/browser.mjs';

const RENDERERS = process.argv[2]?.split(',') ?? lookNames(); // (node seats-check.mjs wire: one look)
// one login card on the desk phone, as the coordinator files it when a seat loses its sign-in
// (and claude-1's week resetting in 2.5 days, so its even pace is 64% of the week gone)
const mockSeats = JSON.parse(readFileSync(new URL('./mock/seats.json', import.meta.url)));
import { lookNames } from './looks.mjs';
mockSeats.find(s => s.id === 'claude-1').week_resets = Date.now() + 2.5 * 864e5;
const files = {
  'mock/seats.json': Buffer.from(JSON.stringify(mockSeats)),
  'mock/requests.json': Buffer.from(
    JSON.stringify([
      {
        id: 90,
        created: '2026-10-14T08:00:00Z',
        agent: null,
        job: null,
        kind: 'login',
        seat: 'claude-3',
        urgency: 'today',
        title: 'The seat "claude-3" needs signing in again',
        body: 'The seat "claude-3" lost its sign-in, so it runs no work until it\'s signed in again. Sign it in under Settings › Seats: you see there at once whether it worked.',
      },
    ]),
  ),
};
const server = await serve(undefined, 0, files),
  base = `http://localhost:${server.address().port}`;
const out = mkdtempSync(join(tmpdir(), 'seats-check-')),
  browser = await playwright().chromium.launch();
const KEYS = ['sk-ant-api03-CHECK-key-one', 'sk-own-CHECK-key-two', 'sk-ant-api03-CHECK-key-three'];
const row = id => `.seats li[data-seat="${id}"]`;
const text = (page, sel) => page.$eval(sel, e => e.innerText.replace(/\s+/g, ' ').trim());
const crumb = page => page.$eval('.computer header b span', e => e.textContent.trim());
const noKeys = page =>
  page.evaluate(
    keys =>
      keys.filter(
        k =>
          document.documentElement.outerHTML.includes(k) ||
          [...document.querySelectorAll('input')].some(i => i.value.includes(k)),
      ),
    KEYS,
  );

let refreshChecked = false;
for (const look of RENDERERS)
  for (const [w, h, device] of [
    [390, 844, 'phone'],
    [1280, 800, 'laptop'],
  ]) {
    const page = await browser.newPage({
      viewport: { width: w, height: h },
      hasTouch: device === 'phone',
      isMobile: device === 'phone',
    });
    const errors = errorsOf(page);
    const at = `${look}, ${device}`;
    page.on('crash', () => console.log(`${at}: the page crashed (out of memory?)`));
    console.log(`${at}…`);
    await page.goto(`${base}/?intro=0&renderer=${look}`);
    await page.waitForTimeout(1200);
    const shot = async (name, sel) => {
      if (sel) await page.$eval(sel, e => e.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${out}/${look}-${device}-${name}.png` });
    };
    const open = async id => {
      await tap(page, `[data-open="${id}"]`);
      await page.waitForSelector('.seat-top');
    };
    const back = async () => {
      await tap(page, '[data-home]');
      await page.waitForSelector('.seats-app .seats');
    };

    // HQ-OS › Seats: each seat's state in a word, its windows, nothing to change; the worker's note a tooltip
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('home')));
    await page.waitForSelector('.apps');
    await tap(page, '[data-app="seats"]');
    await page.waitForSelector('.seat-status li');
    assert.equal(await crumb(page), '› Seats', at);
    const states = {
      'claude-1': 'paced',
      'claude-2': 'stopped',
      'claude-3': 'signed out',
      'codex-2': 'paused',
      'claude-key-1': 'ready',
      'eu-host-1': 'needs key',
      'claude-5': 'setting up',
      'claude-6': 'closed',
      'codex-3': 'removing',
    };
    for (const [id, word] of Object.entries(states))
      assert.match(
        await text(page, `.seat-status [data-seat="${id}"] .st`),
        new RegExp(`^${word}$`, 'i'),
        `${at}: ${id}`,
      );
    assert.equal(
      await page.$$eval('.seat-status :is(button, a, input, select)', l => l.length),
      0,
      `${at}: nothing to change`,
    );
    assert.match(
      await text(page, '.seat-status [data-seat="claude-2"]'),
      /until (\w{3} )?\d\d:\d\d\s*5-hour\s*91%\s*↻ (\w{3} )?\d\d:\d\d\s*Week\s*71%\s*↻/,
      at,
    );
    assert.equal(
      await page.$eval('.seat-status [data-seat="claude-3"] .st', e => e.title),
      'Waiting for the board to sign in',
      at,
    );
    assert.doesNotMatch(await text(page, '.seat-status'), /Waiting for the board/, `${at}: no sentences`);
    // claude-1 is paced: what it still takes till its week resets as its tooltip, and its week past an even pace
    const paced = await page.$eval('.seat-status [data-seat="claude-1"]', li => ({
      says: li.querySelector('.st').title,
      tick: parseFloat(li.querySelector('.pace-at').style.left),
      week: parseFloat(li.querySelectorAll('.bar i')[1].style.width),
    }));
    assert.match(paced.says, /^Takes only your work and what must start before \S/, at);
    assert.ok(
      paced.tick > 50 && paced.tick < paced.week,
      `${at}: the week (${paced.week}%) past its even pace (${paced.tick}%)`,
    );
    assert.equal(await page.$('.seat-status [data-seat="claude-2"] .pace-at'), null, `${at}: not paced`);
    await shot('status');

    // Settings has Seats, first, with what needs the board
    await tap(page, '[data-home]');
    await page.waitForSelector('[data-app="settings"]');
    await tap(page, '[data-app="settings"]');
    await until(page, '[data-section="sys:seats"]', /Seats 3 need you/);
    await shot('settings');
    await tap(page, '[data-section="sys:seats"]');
    await page.waitForSelector('.seats li');
    assert.equal(await crumb(page), '› Settings › Seats', at);

    // every row in a word or two
    assert.equal(await page.$$eval('.seats > li[data-seat]', l => l.length), 12, at);
    const reads = {
      'claude-1': /Claude subscription/,
      'claude-2': /Claude subscription/,
      'claude-3': /Sign in/,
      'codex-1': /Sign in/,
      'claude-4': /Sign in/,
      'codex-2': /Paused/,
      'claude-key-1': /API key, pay per use/,
      'eu-host-1': /Needs a key/,
      'claude-5': /Setting up/,
      'claude-6': /Closed/,
      'codex-3': /Removing…/,
      'mistral-1': /Le Chat subscription/,
    };
    for (const [id, re] of Object.entries(reads))
      assert.match(await text(page, row(id)), new RegExp(re.source, 'i'), `${at}: ${id}`); // (a word shows in capitals in some looks)
    assert.equal(await page.$eval(`${row('codex-3')} button`, b => b.disabled), true, `${at}: a seat being removed`);
    assert.doesNotMatch(await text(page, '.seats-app'), /PROVIDERS|Main work|Second opinion|Not in use/i, at);
    await shot('list');
    await page.$eval('#crt', e => (e.scrollTop = 1e4));
    await shot('list-end');
    // a seat's page: claude-1 and its settings
    await open('claude-1');
    assert.equal(await crumb(page), '› Settings › Seats › claude-1', at);
    assert.match(
      await text(page, '.seats-app'),
      /^claude-1 Anthropic: Claude subscription Pause ✓ Resumed\. It takes work again\. Stop at 80% 85% 90% 95% 99% Sign in again › Remove seat$/i,
      at,
    );
    assert.equal(await page.$eval('[data-stop="90"]', b => b.getAttribute('aria-pressed')), 'true', at);
    await shot('seat');
    // Stop at: the level taps in at once, then the worker's words under it
    await tap(page, '[data-stop="95"]');
    assert.equal(await page.$eval('[data-stop="95"]', b => b.getAttribute('aria-pressed')), 'true', at);
    await until(page, '.seats-app', /Changing it: waiting for the worker|✓ Stops at 95%/); // (holo's busy frames can outlast the wait)
    await until(page, '.seats-app', /✓ Stops at 95% of its limits now\./);
    assert.equal(await page.$eval('[data-stop="95"]', b => b.getAttribute('aria-pressed')), 'true', at);
    await shot('stop');
    // Pause: a switch, its words under it
    await tap(page, '[data-toggle="pause"]');
    assert.equal(await page.$eval('[data-toggle="pause"]', b => b.getAttribute('aria-checked')), 'true', at);
    await until(page, '.seats-app', /✓ Paused\. It finishes its job and takes no new ones\./);
    await shot('paused');
    await tap(page, '[data-toggle="pause"]');
    await until(page, '.seats-app', /✓ Resumed\. It takes work again\./);
    // the back button: a seat's page, then Seats, then Settings
    await back();
    assert.match(await text(page, row('claude-1')), /Claude subscription/, at);
    await tap(page, '[data-home]');
    await page.waitForSelector('[data-section="sys:seats"]');
    assert.equal(await crumb(page), '› Settings', at);
    await tap(page, '[data-section="sys:seats"]');
    await page.waitForSelector('.seats li');

    // a field being typed in survives the refresh (the app's own, every 15 s or 2 s while something moves) and a redraw
    await open('claude-3');
    await page.fill('input[name="code-claude-3"]', 'half-typed-code');
    if (!refreshChecked) {
      await page.waitForTimeout(16500);
      refreshChecked = true;
    } else await page.waitForTimeout(2500);
    assert.equal(
      await page.inputValue('input[name="code-claude-3"]'),
      'half-typed-code',
      `${at}: kept through the refresh`,
    );
    await page.evaluate(() => document.activeElement.blur());
    await tap(page, '[data-do="remove"]');
    await page.waitForSelector('.seat-ask');
    assert.equal(
      await page.inputValue('input[name="code-claude-3"]'),
      'half-typed-code',
      `${at}: kept through a redraw`,
    );
    await tap(page, '[data-do="keep"]');
    assert.match(
      await text(page, '.seat-signin'),
      /Use an account no other seat uses\. Open the sign-in page ↗ Code from the page Send Blank page\? Sign in at claude\.ai first\./,
      at,
    );
    assert.equal(await page.$eval('.seat-link', a => a.target), '_blank', at);
    await shot('signin', '.seat-top');
    // the sign-in: a code pasted, checked, signed in
    await page.fill('input[name="code-claude-3"]', 'the-right-code');
    await tap(page, '[data-code-form] .cta');
    await until(page, '.seats-app', /Checking…/);
    await until(page, '.seats-app', /✓ Signed in\. claude-3 takes work now\./);
    await back();
    // Try again: starting, open, a wrong code, and the sign-in tool's words
    await open('claude-4');
    await tap(page, '.seat-acts [data-do="sign-in"]');
    await until(page, '.seats-app', /Starting the sign-in/);
    await until(page, '.seats-app', /Open the sign-in page/);
    await page.fill('input[name="code-claude-4"]', 'wrong');
    await tap(page, '[data-code-form] .cta');
    await until(page, '.seats-app', /Sign-in didn’t work\. The sign-in tool said: Invalid code\..*Try again/);
    await shot('signin-failed');
    await back();
    // a Codex sign-in: a code to type on the provider's page
    await open('codex-1');
    assert.match(
      await text(page, '.seat-signin'),
      /Open the sign-in page ↗ Type this code there: WXYZ-48213 Waiting for you/,
      at,
    );
    await back();

    // Pace each week: a switch for every seat, the worker's words under it
    assert.equal(await page.$eval('[data-toggle="pacing"]', b => b.getAttribute('aria-checked')), 'true', at);
    await tap(page, '[data-toggle="pacing"]');
    assert.equal(await page.$eval('[data-toggle="pacing"]', b => b.getAttribute('aria-checked')), 'false', at);
    await until(page, '.seats-app', /✓ Pacing is off\./);
    await shot('pacing', '[data-toggle="pacing"]');
    await tap(page, '[data-toggle="pacing"]');
    await until(page, '.seats-app', /✓ Pacing is on\./);

    // Add a seat: a subscription (its sign-in starts by itself on its page)
    await tap(page, '[data-add]');
    await page.waitForSelector('[data-add-form]');
    assert.equal(await crumb(page), '› Settings › Seats › Add a seat', at);
    assert.equal(await page.inputValue('[data-form=id]'), 'claude-7', `${at}: a free name`);
    assert.equal(await page.$('[name=add-key]'), null, `${at}: no key for a subscription`);
    assert.deepEqual(
      await page.$$eval('[data-form=provider] option', o => o.map(x => x.value)),
      ['anthropic', 'anthropic-key', 'openai', 'mistral', 'google', 'eu-host', 'new'],
      `${at}: no pay-per-use key no seat uses`,
    );
    await shot('add');
    await tap(page, '[data-add-form] .cta');
    await page.waitForSelector('.seat-top');
    assert.equal(await crumb(page), '› Settings › Seats › claude-7', `${at}: the new seat's page`);
    await until(page, '.seats-app', /Setting it up/); // (waiting for the worker, then under way: a slow machine may miss the first)
    await until(page, '.seats-app', /Open the sign-in page.*Code from the page/, 20000);
    await back();
    // a key: kept nowhere in the page once sent
    await tap(page, '[data-add]');
    await page.selectOption('[data-form=provider]', 'anthropic-key');
    assert.equal(await page.inputValue('[data-form=id]'), 'claude-8', at);
    assert.equal(await page.getAttribute('[name=add-key]', 'type'), 'password', at);
    assert.equal(await page.getAttribute('[name=add-key]', 'autocomplete'), 'off', at);
    await page.fill('[name=add-key]', KEYS[0]);
    await tap(page, '[data-add-form] .cta');
    await until(page, '.seats-app', /✓ The key works\. claude-8 takes work now\./);
    assert.deepEqual(await noKeys(page), [], `${at}: a key left in the page`);
    await back();
    // a refused name: the coordinator's words in the form
    await tap(page, '[data-add]');
    await page.fill('[data-form=id]', 'claude-1');
    await tap(page, '[data-add-form] .cta');
    await until(
      page,
      '[data-add-form]',
      /Didn’t go through\. There’s a seat called claude-1 already\. Pick another name\./,
    );
    await shot('add-refused');
    // a service of the board's own: its name, the API it speaks, address, model and key
    await page.selectOption('[data-form=provider]', 'new');
    await page.fill('[data-form=name]', 'Test cloud');
    assert.equal(await page.inputValue('[data-form=id]'), 'claude-1', `${at}: a name the board typed stays`);
    await page.fill('[data-form=id]', 'testcloud-1');
    await page.selectOption('[data-form=cli]', 'codex');
    await page.fill('[data-form=url]', 'https://api.test-cloud.example/v1');
    await page.fill('[data-form=model]', 'coder-large');
    await page.fill('[name=add-key]', KEYS[1]);
    await page.evaluate(() => document.activeElement.blur());
    await shot('add-own');
    await tap(page, '[data-add-form] .cta');
    await until(page, '.seats-app', /Test cloud.*✓ The key works/);
    assert.deepEqual(await noKeys(page), [], `${at}: a key left in the page`);
    await back();

    // a key: given, refused, changed
    await open('eu-host-1');
    await tap(page, '.seat-acts [data-do=key]');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'key-eu-host-1', `${at}: ready to paste in`);
    await page.fill('[name="key-eu-host-1"]', 'wrong');
    await tap(page, '[data-key-form] .cta');
    await until(page, '.seats-app', /Testing the key/);
    await until(page, '.seats-app', /Didn’t work\. The service refused the key/);
    await back();
    await open('claude-key-1');
    await tap(page, '.seat-settings [data-do=key]');
    await page.fill('[name="key-claude-key-1"]', KEYS[2]);
    await page.keyboard.press('Enter');
    await until(page, '.seats-app', /✓ The key works/);
    assert.deepEqual(await noKeys(page), [], `${at}: a key left in the page`);
    await back();

    // Remove asks in place, and says the account stays open; then back to the list, which says so
    await open('claude-2');
    await tap(page, '[data-do=remove]');
    assert.match(
      await text(page, '.seat-ask'),
      /Its sign-in is deleted from our server\. The account stays open with Anthropic\. Remove claude-2 Cancel/,
      at,
    );
    await shot('remove-ask', '.seat-settings');
    await tap(page, '[data-do=keep]');
    assert.equal(await page.$('.seat-ask'), null, `${at}: Cancel`);
    await tap(page, '[data-do=remove]');
    await tap(page, '[data-do=remove-sure]');
    await until(page, '.seats-app', /Removing it/);
    await page.waitForSelector('.seats-app .seats', { timeout: 15000 });
    await until(page, '.seats-app', /✓ claude-2 removed\./);
    assert.equal(await page.$(row('claude-2')), null, at);

    // nothing off the screen, on the list and on a seat's page
    for (const where of ['list', 'seat']) {
      if (where === 'seat') await open('claude-1');
      const over = await page.evaluate(() => {
        const s = document.querySelector('#crt').getBoundingClientRect();
        return [...document.querySelectorAll('#crt li, #crt button, #crt input, #crt select, #crt a')]
          .filter(e => {
            const r = e.getBoundingClientRect();
            return r.width && (r.left < s.left - 1 || r.right > s.right + 1);
          })
          .map(e => e.outerHTML.slice(0, 80));
      });
      assert.deepEqual(over, [], `${at}: something is off the screen (${where})`);
    }

    // the desk phone's login card: its words and Open Seats, nothing to answer, and the button opens the seat's page
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
    await page.waitForSelector('#open-seats');
    assert.deepEqual(
      await page.evaluate(() =>
        ['#answer', '#answer-mic', '#send-answer', '.req a.signin'].filter(s => document.querySelector(s)),
      ),
      [],
      `${at}: a login card takes no answer`,
    );
    assert.match(await text(page, '.req'), /lost its sign-in/, at);
    await tap(page, '#open-seats');
    await page.waitForSelector('.seat-top');
    assert.equal(await crumb(page), '› Settings › Seats › claude-3', at);
    assert.deepEqual(errors, [], at);
    await page.close();
  }
await browser.close();
server.close();
console.log(`seats-check: all good (${RENDERERS.length} looks × phone and laptop). Screenshots: ${out}`);
