#!/usr/bin/env node
// A kit that dresses a look, failing to load in a real browser: its stylesheet or sounds that don't load, or a kit name
// that isn't one, fail the change of look (Brownstone stays on stage, no kit's sheet left linked, and the console says
// so); names.json that doesn't load fails its icons loudly and is fetched again for the next one drawn. A look's Google
// Font that doesn't load fails nothing: HQ starts on the company's look and changes to another in the fallback font.
//   node platform/hq/kitload-check.mjs        (HQ in dev mode, on its mock data, with theme/hq.yaml's kit on Wire)
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const browser = await playwright().chromium.launch();
const server = await serve(undefined, 0),
  base = `http://localhost:${server.address().port}`;
const kit = await kitOfWire();

for (const file of ['style.css', 'sounds.js']) {
  const { page, swap, fetched } = await opened(`/kits/${kit}/${file}`);
  assert.equal(await swap(), false, `${file} that doesn't load: the change of look fails`);
  await keptBrownstone(page, `${file} that doesn't load`);
  assert.ok(fetched.length, `${file}: asked for`);
  await page.close();
}

{
  const { page, swap } = await opened();
  await page.evaluate(() =>
    import('/shell/brand.js').then(m => {
      m.theme.wire = { ...m.theme.wire, kit: 'Not a kit' };
    }),
  );
  assert.equal(await swap(), false, "a kit name that isn't one: the change of look fails");
  await keptBrownstone(page, "a kit name that isn't one");
  await page.close();
}

{
  const { page, swap, errors, fetched } = await opened(`/kits/${kit}/icons/names.json`);
  assert.equal(await swap(), true, "names.json that doesn't load leaves the look's change to its icons");
  const failed = e => e.includes('names.json: HTTP 503');
  if (!errors.some(failed)) await page.waitForEvent('pageerror', { predicate: e => failed(e.message) });
  await page.evaluate(() =>
    import('/shell/icons.js').then(m => document.body.insertAdjacentHTML('beforeend', m.icon('mobile', 'kitload'))),
  );
  const drawn = await page
    .waitForFunction(() => document.querySelector('svg.kitload').dataset.drawn)
    .then(h => h.jsonValue());
  assert.equal(drawn, `/kits/${kit}/icons/mobile`, 'the next icon drawn fetches names.json again');
  assert.equal(fetched.length, 2, 'names.json asked for twice: the failure, then the next drawing');
  await page.close();
}

{
  // Google Fonts that don't load (a blocker, a firewall, no network): the looks start in their fallback fonts
  const { page } = await openPage(browser, { viewport: { width: 1280, height: 900 } });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await page.goto(`${base}/?intro=0`);
  await until(page, '#loading.gone');
  const { look, company } = await page.evaluate(async () => ({
    look: (await import('/shell/stage.js')).look,
    company: (await import('/shell/brand.js')).theme.renderer,
  }));
  assert.equal(look, company, "Google Fonts that don't load: HQ starts on the company's look");
  const holo = await page.evaluate(() => import('/shell/stage.js').then(m => m.mount('holo')));
  assert.equal(holo, true, "Google Fonts that don't load: the change to Holo goes through");
  await page.close();
}

await browser.close();
server.close();
console.log('kitload-check: a kit that fails to load fails loudly, and a font that fails leaves its fallback');

// HQ on Brownstone, with `failing` answering 503 the first time it's asked for; swap: Wire on stage (mount's answer)
async function opened(failing) {
  const { page, errors } = await openPage(browser, { viewport: { width: 1280, height: 900 } });
  const fetched = [];
  if (failing)
    await page.route(`${base}${failing}`, route => {
      fetched.push(route.request().url());
      return fetched.length === 1 ? route.fulfill({ status: 503, body: 'busy' }) : route.continue();
    });
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${base}/?intro=0&renderer=brownstone`);
  await until(page, '#loading.gone');
  const swap = () => page.evaluate(() => import('/shell/stage.js').then(m => m.mount('wire')));
  return { page, errors, fetched, swap };
}

async function keptBrownstone(page, at) {
  const { look, sheets } = await page.evaluate(async () => ({
    look: (await import('/shell/stage.js')).look,
    sheets: [...document.querySelectorAll('link:is([data-skin], [data-kit])')].map(l => l.href),
  }));
  assert.equal(look, 'brownstone', `${at}: Brownstone stays on stage`);
  assert.deepEqual(sheets, [], `${at}: no look's or kit's sheet left linked`);
  assert.ok(await page.getByText("That view didn't load").count(), `${at}: says so`);
}

async function kitOfWire() {
  const { page } = await openPage(browser);
  await page.goto(`${base}/?intro=0&renderer=brownstone`);
  await until(page, '#loading.gone');
  const name = await page.evaluate(() => import('/shell/brand.js').then(m => m.theme.wire?.kit));
  await page.close();
  assert.ok(name, 'theme/hq.yaml dresses Wire in a kit (this check needs one)');
  return name;
}
