#!/usr/bin/env node
// Settings › Voices in a real browser, on mock/voices.json: Settings' Voices row says how many are saved; each saved
// voice's row reads its name, the day it was saved on which call and when it was last heard, with a Delete named for
// it; a Delete takes that voice off the list and the rest stay; the last one gone says there are none and how one is
// saved; nothing is off the screen. In every look, on a phone and a tablet.
//   node platform/hq/voices-check.mjs [looks]  (holo,wire: those only; screenshots go to a temp folder, printed at the end)
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { playwright, errorsOf, tap, until } from '../../shared/browser/browser.mjs';
import { lookNames } from './looks.mjs';

const RENDERERS = process.argv[2]?.split(',') ?? lookNames();
const server = await serve(undefined, 0),
  base = `http://localhost:${server.address().port}`;
// (WebGL on SwiftShader, as machines-check.mjs has it: without it the holo look takes minutes a page)
const out = mkdtempSync(join(tmpdir(), 'voices-check-')),
  browser = await playwright().chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
const text = (page, sel) => page.$eval(sel, e => e.innerText.replace(/\s+/g, ' ').trim());
const crumb = page => page.$eval('.computer header b span', e => e.textContent.trim());
const names = page => page.$$eval('.push-app li b', l => l.map(b => b.textContent));

for (const look of RENDERERS)
  for (const [w, h, device] of [
    [390, 844, 'phone'],
    [820, 1180, 'tablet'],
  ]) {
    const page = await browser.newPage({
      viewport: { width: w, height: h },
      hasTouch: true,
      isMobile: device === 'phone',
    });
    const errors = errorsOf(page);
    const at = `${look}, ${device}`;
    console.log(`${at}…`);
    await page.goto(`${base}/?intro=0&renderer=${look}`);
    // (the look on stage first: Settings' Look row names it)
    await page.evaluate(() => import('/shell/stage.js').then(m => (window.stageNow = m)));
    await page.waitForFunction(() => window.stageNow.look, null, { timeout: 60_000 });
    const shot = async name => {
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${out}/${look}-${device}-${name}.png` });
    };

    // Settings has Voices, with how many are saved
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('settings')));
    await until(page, '[data-section="sys:voices"]', /Voices 3/);
    await tap(page, '[data-section="sys:voices"]');
    await page.waitForSelector('.push-app li [data-delete]');
    assert.equal(await crumb(page), '› Settings › Voices', at);

    // each row: the name, when and on which call it was saved, when last heard; newest first
    assert.deepEqual(await names(page), ['Anna', 'Bram', 'Cleo'], at);
    const rows = await page.$$eval('.push-app li', l => l.map(li => li.innerText.replace(/\s+/g, ' ').trim()));
    assert.match(rows[0], /^Anna Delete saved \d+ [A-Z][a-z]+, on call 248 · not heard since$/, at);
    assert.match(
      rows[1],
      /^Bram Delete saved \d+ [A-Z][a-z]+, on call 241 · last heard (\d+ (min|h|d) ago|just now)$/,
      at,
    );
    assert.equal(await page.$eval('[data-delete="2"]', b => b.getAttribute('aria-label')), 'Delete Bram’s voice', at);
    await shot('list');

    // nothing off the screen
    const over = await page.evaluate(() => {
      const s = document.querySelector('#crt').getBoundingClientRect();
      return [...document.querySelectorAll('#crt li, #crt button')]
        .filter(e => {
          const r = e.getBoundingClientRect();
          return r.width && (r.left < s.left - 1 || r.right > s.right + 1);
        })
        .map(e => e.outerHTML.slice(0, 80));
    });
    assert.deepEqual(over, [], `${at}: something is off the screen`);

    // a Delete takes that voice away, the others stay; the last one gone says how a voice is saved
    await tap(page, '[data-delete="2"]');
    await page.waitForFunction(() => !document.querySelector('[data-delete="2"]'));
    assert.deepEqual(await names(page), ['Anna', 'Cleo'], at);
    for (const id of [3, 1]) {
      await tap(page, `[data-delete="${id}"]`);
      await page.waitForFunction(i => !document.querySelector(`[data-delete="${i}"]`), id);
    }
    assert.equal(await text(page, '.push-app'), 'No saved voices. Ask the agent on a call to enrol someone.', at);
    await shot('none');

    // Settings counts none now
    await tap(page, '[data-home]');
    await until(page, '[data-section="sys:voices"]', /Voices 0/);
    assert.equal(await crumb(page), '› Settings', at);
    assert.deepEqual(errors, [], at);
    await page.close();
  }
await browser.close();
server.close();
console.log(`voices-check: all good (${RENDERERS.length} looks × phone and tablet). Screenshots: ${out}`);
