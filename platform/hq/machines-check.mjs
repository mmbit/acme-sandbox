#!/usr/bin/env node
// Settings › Machines in a real browser, on mock/machines.json and mock/machine-setup.json: Settings' Machines row says
// how many the board lends; each machine's row reads its state in a word, what it has and its speed next to this
// server's; a machine's page shows its load, a graph of the last minutes, its run and that run's newest output as text
// (never markup), and redraws on the coordinator's 'machines' event with nothing typed lost; Pause, Rename (a taken name
// refused), Colours (Wire's key wears them), Install again (asked in place, then its install command); Add a machine
// shows its install command once; Remove asks in place with the command that clears the machine, and the list says so; the back button steps back a page at a time;
// nothing is off the screen. In every look, on a phone and a tablet.
//   node platform/hq/machines-check.mjs [looks]  (holo,wire: those only; screenshots go to a temp folder, printed at the end)
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
// (WebGL on SwiftShader, as screens-check.mjs has it: without it the holo look takes minutes a page)
const out = mkdtempSync(join(tmpdir(), 'machines-check-')),
  browser = await playwright().chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
const text = (page, sel) => page.$eval(sel, e => e.innerText.replace(/\s+/g, ' ').trim());
const crumb = page => page.$eval('.computer header b span', e => e.textContent.trim());

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
    await page.waitForTimeout(1200);
    const shot = async (name, sel) => {
      if (sel) await page.$eval(sel, e => e.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${out}/${look}-${device}-${name}.png` });
    };
    const open = async name => {
      await page.evaluate(
        n => [...document.querySelectorAll('[data-open]')].find(b => b.querySelector('b').textContent === n).click(),
        name,
      );
      await page.waitForSelector('.machines-app .seat-top');
    };
    const back = async () => {
      await tap(page, '[data-home]');
      await page.waitForSelector('.machines-app .machines');
    };

    // Wire's board: the machines' keys after everyone's, beside the mascots; its first row under the HUD, with the
    // views' switch, also where the tools fit on one row
    if (look === 'wire') {
      const RANK = ['company', 'agent', 'machine', 'mascot'];
      const kinds = await page.$$eval('.wire .board .key', keys =>
        keys.map(k => ['company', 'agent', 'machine', 'mascot'].find(c => k.classList.contains(c))),
      );
      assert.ok(kinds.includes('machine'), at);
      assert.deepEqual(
        kinds,
        kinds.toSorted((a, b) => RANK.indexOf(a) - RANK.indexOf(b)),
        at,
      );
      for (const width of device === 'phone' ? [w, 440] : [w]) {
        await page.setViewportSize({ width, height: h });
        await page.waitForTimeout(300);
        const [first, hud] = await page.evaluate(() => [
          document.querySelector('.wire .board .slot').getBoundingClientRect().top,
          Math.max(
            ...['#hud .tools', '#hud .brand'].map(s => document.querySelector(s).getBoundingClientRect().bottom),
          ),
        ]);
        assert.ok(first >= hud, `${at}, ${width} wide: the board starts at ${first}, under the HUD at ${hud}`);
      }
      await page.setViewportSize({ width: w, height: h });
    }

    // Settings has Machines, after Seats, with how many the board lends
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('settings')));
    await until(page, '[data-section="sys:machines"]', /Machines 4/);
    assert.deepEqual(
      await page.$$eval('[data-section]', l => l.slice(0, 2).map(b => b.dataset.section)),
      ['sys:seats', 'sys:machines'],
      at,
    );
    await tap(page, '[data-section="sys:machines"]');
    await page.waitForSelector('.machines li[data-machine]');
    assert.equal(await crumb(page), '› Settings › Machines', at);

    // each row: its state in a word, what it has and its speed next to this server's; this server isn't one of them
    const reads = {
      1: /The rig Running one › 24 cores · 40 GB · NVIDIA GeForce RTX 4090 · 8\.4× this server/,
      2: /The study’s laptop Taking runs › 4 cores · 8 GB · 1\.0× this server/,
      3: /Old tower Away › 8 cores · 16 GB · 1\.7× this server/,
      4: /Spare mini PC Paused ›/,
    };
    assert.equal(await page.$$eval('.machines li[data-machine]', l => l.length), 4, at);
    for (const [id, re] of Object.entries(reads))
      assert.match(await text(page, `.machines li[data-machine="${id}"]`), new RegExp(re.source, 'i'), `${at}: ${id}`);
    assert.match(await text(page, '.machines-app'), /The fastest free machine takes each run/, at);
    await shot('list');

    // a machine's page: its load, the graph, its run and its output as text
    await open('The rig');
    assert.equal(await crumb(page), '› Settings › Machines › The rig', at);
    assert.match(await text(page, '.machine-live .use'), /CPU .*% Memory .*% GPU 16%/, at);
    assert.equal(await page.$$eval('.machine-graph polyline', l => l.length), 2, at);
    assert.match(await text(page, '.machine-run'), /wren: Venture sizing: 400 seeds simulation, since \d\d:\d\d/, at);
    const output = await page.$eval('.machine-lines', pre => ({ text: pre.textContent, tags: pre.children.length }));
    assert.equal(output.tags, 0, `${at}: the output is never markup`);
    assert.match(output.text, /<b>not markup<\/b> & a line that stays text$/, at);
    assert.equal(
      await page.$eval('.machine-lines', pre => Math.abs(pre.scrollHeight - pre.clientHeight - pre.scrollTop) < 2),
      true,
      `${at}: the newest output in view`,
    );
    await shot('machine');

    // the coordinator's 'machines' event redraws it, with a field being typed in left alone
    const said = async lines =>
      page.evaluate(async more => {
        const world = await import('/world/world.js');
        const list = structuredClone(await (await import('/shell/data.js')).loadMachines(true));
        list[0].live.lines.push(...more);
        list[0].live.cpu = 99;
        world.apply({ type: 'machines', machines: list });
      }, lines);
    await said(['seed 340: done']);
    await until(page, '.machine-lines', /seed 340: done$/);
    assert.match(await text(page, '.machine-live .use'), /CPU 99%/, at);
    // a run of a job with no title names its job, a link to it, here and on Wire's key
    await page.evaluate(async () => {
      const world = await import('/world/world.js');
      const list = structuredClone(await (await import('/shell/data.js')).loadMachines(true));
      list[0].run.title = null;
      world.apply({ type: 'machines', machines: list });
    });
    await until(page, '.machine-run', /^wren: job EN-SEEDS/);
    assert.equal(await page.$eval('.machine-run a.job-link', a => a.dataset.job), '61', at);
    if (look === 'wire')
      assert.deepEqual(
        await page.$$eval('.wire .board .key.machine .doing a.job-link', a =>
          a.map(e => [e.textContent, e.dataset.job]),
        ),
        [['EN-SEEDS', '61']],
        at,
      );
    await tap(page, '[data-do="rename"]');
    await page.fill('[data-rename-form] input', 'The big ri');
    await said(['seed 341: done']);
    await page.waitForTimeout(300);
    assert.equal(await page.inputValue('[data-rename-form] input'), 'The big ri', `${at}: kept through the event`);
    // Rename: a taken name refused in place, then the new name
    await page.fill('[data-rename-form] input', 'old TOWER');
    await tap(page, '[data-rename-form] .cta');
    await until(page, '[data-rename-form]', /Didn’t go through\. There’s a machine called old TOWER already\./);
    await page.fill('[data-rename-form] input', 'The big rig');
    await page.keyboard.press('Enter');
    await until(page, '.seat-top', /The big rig/);
    assert.equal(await page.$('[data-rename-form]'), null, `${at}: the form closes`);
    assert.equal(await crumb(page), '› Settings › Machines › The big rig', at);
    // Pause: a switch, the state word follows
    await tap(page, '[data-toggle="pause"]');
    assert.equal(await page.$eval('[data-toggle="pause"]', b => b.getAttribute('aria-checked')), 'true', at);
    await until(page, '.seat-top', /Paused/);
    await tap(page, '[data-toggle="pause"]');
    await until(page, '.seat-top', /Running one/);
    // Colours: a swatch a finish, the looks' own pressed till one is tapped; the rig's key wears it at the next event
    const pressed = () => page.$$eval('.swatch[aria-pressed=true]', l => l.map(b => b.getAttribute('aria-label')));
    assert.deepEqual(await pressed(), ['HQ violet'], at);
    await tap(page, '.swatch[aria-label="Black and red"]');
    await until(page, '.machine-colours', /Colours Black and red/);
    assert.deepEqual(await pressed(), ['Black and red'], at);
    await shot('colours', '.machine-colours');
    if (look === 'wire') {
      await said([]);
      await page.waitForTimeout(300);
      const key = await page.$eval('.wire .board .key.machine', k => ({
        face: getComputedStyle(k.querySelector('.face')).backgroundColor,
        ring: getComputedStyle(k.querySelector('.avatar circle')).stroke,
        tower: [...k.querySelector('.tower').classList],
        cards: k.querySelectorAll('.tower .card').length,
      }));
      assert.deepEqual(
        key,
        { face: 'rgb(17, 17, 20)', ring: 'rgb(229, 36, 59)', tower: ['tower', 'size-3'], cards: 1 },
        `${at}: 24 cores and a GPU, black and red`,
      );
    }
    await tap(page, '.swatch[aria-label="HQ violet"]');
    await until(page, '.machine-colours', /Colours HQ violet/);
    // Install again asks in place, then shows the new install command, through a redraw
    await tap(page, '[data-do="install"]');
    assert.match(
      await text(page, '.seat-ask'),
      /A new key and install command: its helpers stop until it’s pasted/,
      at,
    );
    await tap(page, '[data-do="install-sure"]');
    await page.waitForSelector('.machine-setup');
    await said(['seed 342: done']);
    await until(page, '.machine-lines', /seed 342: done$/);
    assert.match(
      await page.$eval('.machine-setup [data-copy]', b => b.dataset.copy),
      /^docker run --rm .*-e MANAGER=install .*helper_MOCK1/,
      at,
    );
    await shot('install', '.machine-setup');
    await back();
    assert.match(await text(page, '.machines li[data-machine="1"]'), /The big rig/, at);

    // Add a machine: its name, then its page with its install command, this once
    await tap(page, '[data-add]');
    await page.waitForSelector('[data-add-form]');
    assert.equal(await crumb(page), '› Settings › Machines › Add a machine', at);
    await tap(page, '[data-add-form] .cta');
    assert.equal(await page.evaluate(() => document.activeElement?.name), 'machine-name', `${at}: a name first`);
    await shot('add');
    await page.fill('[data-add-form] input', 'Garage NUC');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.machine-setup');
    assert.equal(await crumb(page), '› Settings › Machines › Garage NUC', at);
    const setup = await page.$$eval('.machine-setup [data-copy]', l => l.map(b => b.dataset.copy));
    assert.equal(setup.length, 1, at);
    assert.match(setup[0], /^docker run --rm .*-e MANAGER=install .*helper_MOCK5/, at);
    assert.match(
      await text(page, '.machine-setup'),
      /paste this once\. It holds the machine’s key, and HQ shows it only now/,
      at,
    );
    await shot('added');
    await back();
    assert.match(await text(page, '.machines li[data-machine="5"]'), /Garage NUC Away › Not heard from yet/, at);
    await open('Garage NUC');
    assert.equal(await page.$('.machine-setup'), null, `${at}: the install command was shown once`);
    assert.deepEqual(await pressed(), ['HQ violet'], `${at}: a new machine has the looks’ own colours`);
    await back();

    // Remove asks in place, with the commands that clear the machine; then the list says so
    await open('Old tower');
    await tap(page, '[data-do="remove"]');
    assert.match(
      await text(page, '.seat-ask'),
      /Its key stops working at once, so HQ lets its helpers in no more\. On the machine, remove them with: .*-e MANAGER=remove .* Remove Old tower Cancel/,
      at,
    );
    await shot('remove-ask', '.seat-settings');
    await tap(page, '[data-do="keep"]');
    assert.equal(await page.$('.seat-ask'), null, `${at}: Cancel`);
    await tap(page, '[data-do="remove"]');
    await tap(page, '[data-do="remove-sure"]');
    await page.waitForSelector('.machines-app .machines');
    await until(page, '.machines-app', /✓ Old tower removed\. Its key no longer works\./);
    assert.equal(await page.$('.machines li[data-machine="3"]'), null, at);

    // nothing off the screen, on the list and on a machine's page
    for (const where of ['list', 'machine']) {
      if (where === 'machine') await open('The big rig');
      const over = await page.evaluate(() => {
        const s = document.querySelector('#crt').getBoundingClientRect();
        return [...document.querySelectorAll('#crt li, #crt button, #crt input, #crt pre, #crt svg, #crt code')]
          .filter(e => {
            const r = e.getBoundingClientRect();
            return r.width && (r.left < s.left - 1 || r.right > s.right + 1);
          })
          .map(e => e.outerHTML.slice(0, 80));
      });
      assert.deepEqual(over, [], `${at}: something is off the screen (${where})`);
    }
    // the back button: a machine's page, then Machines, then Settings
    await back();
    await tap(page, '[data-home]');
    await page.waitForSelector('[data-section="sys:machines"]');
    assert.equal(await crumb(page), '› Settings', at);
    assert.deepEqual(errors, [], at);
    await page.close();
  }
await browser.close();
server.close();
console.log(`machines-check: all good (${RENDERERS.length} looks × phone and tablet). Screenshots: ${out}`);
