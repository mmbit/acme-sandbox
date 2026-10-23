#!/usr/bin/env node
// An agent's model on its page in a real browser, on mock/agent-models.json: its main model and its one fallback as two
// fields, offering only the models a seat runs; the fallback leaves out the main model's own seats, and a main model on
// the fallback's seats clears it; each pick says how it went; a status update doesn't redraw the fields under the board;
// the board, a temporary team member and an agent off the seats (Poppy) have none. In each look, on a phone and a laptop.
//   node platform/hq/models-check.mjs [looks]  (wire: that one only; screenshots go to a temp folder, printed at the end)
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { playwright, errorsOf } from '../../shared/browser/browser.mjs';

const RENDERERS = process.argv[2]?.split(',') ?? ['brownstone', 'holo', 'wire'];
const server = await serve(undefined, 0),
  base = `http://localhost:${server.address().port}`;
const out = mkdtempSync(join(tmpdir(), 'models-check-')),
  browser = await playwright().chromium.launch();
const options = (page, field) =>
  page.$$eval(`[data-model="${field}"] option`, o => o.map(x => `${x.textContent}${x.selected ? ' ✓' : ''}`));
const said = page => page.$eval('.model-said', e => e.innerText.trim()).catch(() => '');
const openAgent = (page, id) =>
  page.evaluate(
    id =>
      Promise.all([import('/shell/panel.js'), import('/world/world.js')]).then(([panel, world]) =>
        panel.openAgent(world.agents.get(id)),
      ),
    id,
  );

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
    console.log(`${at}…`);
    await page.goto(`${base}/?intro=0&renderer=${look}`);
    await page.waitForTimeout(1200);
    const shot = async name => {
      await page.$eval('.models', e => e.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/${look}-${device}-${name}.png` });
    };

    // Vera: Opus 5.5 with GPT-6.1 Sol to fall back on; Mistral's and Google's models have no seat, so aren't offered
    await openAgent(page, 'vera');
    await page.waitForSelector('.models select');
    assert.deepEqual(await options(page, 'main'), ['Opus 5.5 ✓', 'Sonnet 5.5', 'GPT-6.1 Sol', 'GPT-6 Astra'], at);
    assert.deepEqual(
      await options(page, 'fallback'),
      ['None', 'GPT-6.1 Sol ✓', 'GPT-6 Astra'],
      `${at}: no Claude model to fall back on`,
    );
    assert.match(await page.$eval('.models', e => e.innerText), /MODEL\s+Main\s+.*Fallback/is, at);
    await shot('vera');

    // a main model on the fallback's seats clears the fallback, and says what runs now
    await page.selectOption('[data-model="main"]', 'gpt-6.1-sol');
    await page.waitForFunction(() => /✓/.test(document.querySelector('.model-said')?.textContent ?? ''));
    assert.equal(await said(page), '✓ Its next work runs on GPT-6.1 Sol.', at);
    assert.deepEqual(await options(page, 'fallback'), ['None ✓', 'Opus 5.5', 'Sonnet 5.5'], at);
    await page.selectOption('[data-model="fallback"]', 'claude-opus-5-5');
    await page.waitForFunction(() => /Opus/.test(document.querySelector('.model-said')?.textContent ?? ''));
    assert.equal(
      await said(page),
      '✓ Its next work runs on GPT-6.1 Sol, and on Opus 5.5 while GPT-6.1 Sol’s seats are out or short.',
      at,
    );
    await shot('picked');
    // a status update redraws the panel with the pick, and not while the board has a field open
    await page.evaluate(() => import('/shell/panel.js').then(p => p.refreshAgent('vera')));
    assert.deepEqual(await options(page, 'fallback'), ['None', 'Opus 5.5 ✓', 'Sonnet 5.5'], at);
    await page.focus('[data-model="main"]');
    await page.$eval('[data-model="main"]', s => s.setAttribute('data-kept', '1'));
    await page.evaluate(() => import('/shell/panel.js').then(p => p.refreshAgent('vera')));
    assert.equal(
      await page.$eval('[data-model="main"]', s => s.dataset.kept),
      '1',
      `${at}: not redrawn under the board`,
    );

    // a reviewer's main model stays on its panel engine; a fallback picked alone leaves its main model the files'
    await openAgent(page, 'rook');
    await page.waitForSelector('.models select');
    assert.deepEqual(
      await options(page, 'main'),
      ['Opus 5.5 ✓', 'Sonnet 5.5'],
      `${at}: only Claude models for a Claude reviewer`,
    );
    await page.selectOption('[data-model="fallback"]', 'gpt-6.1-sol');
    await page.waitForFunction(() => /✓/.test(document.querySelector('.model-said')?.textContent ?? ''));
    const rook = await page.evaluate(() =>
      import('/shell/data.js').then(d => d.loadAgentModels(true)).then(l => l.models.rook),
    );
    assert.deepEqual(rook, { main: 'claude-opus-5-5', picked: false, fallback: 'gpt-6.1-sol', engine: 'claude' }, at);

    // nothing to pick for the board, a team member of a lead's, or an agent whose work doesn't run on the seats
    for (const id of ['board', 'poppy']) {
      await openAgent(page, id);
      await page.waitForTimeout(300);
      assert.equal(await page.$$eval('.models select', s => s.length), 0, `${at}: ${id}`);
    }
    assert.deepEqual(errors, [], at);
    await page.close();
  }
await browser.close();
server.close();
console.log(`models-check: all good (${RENDERERS.length} looks × phone and laptop). Screenshots: ${out}`);
