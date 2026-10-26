#!/usr/bin/env node
// HQ-OS › On Air in a real browser, on mock/onair.json and mock/schedule.json: each show with who makes it, when and
// for whom, its newest episodes with a player each in the language picked (kept), Watch for one with a video, a speed
// kept for every player, one episode playing at a time and no redraw under it, Make one now and the podcast links;
// nothing off the screen. In every look, on a phone and a tablet.
//   node platform/hq/onair-check.mjs        (screenshots go to a temp folder, printed at the end)
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { playwright, errorsOf, tap } from '../../shared/browser/browser.mjs';

const server = await serve(undefined, 0),
  base = `http://localhost:${server.address().port}`;
import { lookNames } from './looks.mjs';
const out = mkdtempSync(join(tmpdir(), 'onair-check-')),
  browser = await playwright().chromium.launch();
const texts = (page, sel) => page.$$eval(sel, els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));

for (const look of lookNames())
  for (const [w, h, device] of [
    [390, 844, 'phone'],
    [1180, 820, 'tablet'],
  ]) {
    const page = await browser.newPage({
      viewport: { width: w, height: h },
      hasTouch: device === 'phone',
      isMobile: device === 'phone',
    });
    const errors = errorsOf(page);
    await page.goto(`${base}/?intro=0&renderer=${look}`);
    await page.waitForTimeout(1200);
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('onair')));
    await page.waitForSelector('.oa');
    const at = `${look}, ${device}`,
      shot = name => page.screenshot({ path: `${out}/${look}-${device}-${name}.png` });

    assert.deepEqual(await texts(page, '.oa .cap'), ['> THE MORNING DIGEST', '> FRIDAY AT THE STUDIO'], at);
    assert.match(
      (await texts(page, '.oa > p.dim'))[0],
      /^Juno · daily 06:45, next tomorrow 06:45 · for colleagues$/,
      at,
    );
    assert.deepEqual(
      await texts(page, '[data-show=digest] .rows b'),
      ['Thursday: the shop opens its doors', 'Wednesday: a softer sound'],
      at,
    );
    assert.equal(await page.$$eval('[data-show=digest] audio', a => a.length), 2, at);
    assert.deepEqual(
      await texts(page, '[data-show=friday] .dim'),
      ['Juno and Wren · Fridays 15:45, next Friday 15:45 · for you', 'No episodes yet.'],
      at,
    );
    assert.equal(await page.$('[data-show=friday] [data-lang]'), null, `${at}: one language, no picker`);
    await shot('shows');

    // an episode with a video: Watch puts the video in its player's place, at the same speed, and Listen takes it back
    assert.deepEqual(await texts(page, '[data-show=digest] [data-watch]'), ['Watch'], at);
    await tap(page, '[data-show=digest] [data-watch]');
    assert.deepEqual(
      await page.$$eval('[data-show=digest] li', lis => lis.map(li => li.querySelector('audio, video').tagName)),
      ['VIDEO', 'AUDIO'],
      at,
    );
    await shot('watch');
    await tap(page, '[data-show=digest] [data-watch]');
    assert.deepEqual(await texts(page, '[data-show=digest] [data-watch]'), ['Watch'], at);
    assert.equal(await page.$$eval('[data-show=digest] video', v => v.length), 0, at);

    // Nederlands: the Dutch titles, and it stays picked
    await tap(page, '[data-show=digest] [data-lang=nl]');
    await page.waitForFunction(
      () => document.querySelector('[data-show=digest] [data-lang=nl]')?.getAttribute('aria-checked') === 'true',
    );
    assert.deepEqual(
      await texts(page, '[data-show=digest] .rows b'),
      ['Donderdag: de winkel gaat open', 'Woensdag: een zachter geluid'],
      at,
    );
    // speed: every player, and kept
    await tap(page, '[data-speed]');
    assert.deepEqual(await page.$$eval('audio', a => [...new Set(a.map(x => x.playbackRate))]), [1.25], at);
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('onair')));
    await page.waitForSelector('.oa');
    assert.deepEqual(await texts(page, '[data-speed]'), ['Speed 1.25×'], at);
    assert.equal(
      await page.$eval('[data-show=digest] [data-lang=nl]', b => b.getAttribute('aria-checked')),
      'true',
      `${at}: the language stays`,
    );
    // the redraw leaves a playing episode alone
    const playing = await page.evaluate(async () => {
      const a = document.querySelector('[data-show=digest] audio');
      a.muted = true;
      await a.play().catch(() => {});
      a.dataset.mark = 'kept';
      await (await import('/shell/onair.js')).onair(document.querySelector('#crt'), { dev: true, who: x => x });
      return [!a.paused, document.querySelector('[data-show=digest] audio')?.dataset.mark];
    });
    if (playing[0]) assert.equal(playing[1], 'kept', `${at}: not redrawn while it plays`);

    // Make one now says which job it started, by its code; a podcast link is copied (or shown)
    await tap(page, '[data-show=digest] [data-run]');
    await page.waitForFunction(() =>
      /^Started (?:[A-Z]{2,3}-)?[A-Z]{2,8}$/.test(document.querySelector('[data-show=digest] [data-run]').textContent),
    );
    assert.deepEqual(
      await texts(page, '[data-show=digest] [data-feed]'),
      ['Podcast link, English', 'Video podcast link, English', 'Podcast link, Nederlands'],
      at,
    );
    await tap(page, '[data-show=digest] [data-renew]');
    assert.deepEqual(
      await texts(page, '[data-show=digest] [data-renew]'),
      ['The old link stops working · tap again'],
      at,
    );
    await shot('picked');

    const wide = await page.$$eval('.oa *', els =>
      els
        .filter(e => e.getBoundingClientRect().right > document.querySelector('#crt').getBoundingClientRect().right + 1)
        .map(e => e.outerHTML.slice(0, 60)),
    );
    assert.deepEqual(wide, [], `${at}: nothing off the screen`);
    assert.deepEqual(errors, [], at);
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('hq.onair')) localStorage.removeItem(k);
    });
    await page.close();
  }
await browser.close();
server.close();
console.log(`On Air: ok (screenshots in ${out})`);
