#!/usr/bin/env node
// HQ's icons in a real browser: in every look, every icon on the HUD, the computer's home screen, the desk phone, the
// intercom and the projects view (a business in it too, with its way back up) drawn from that look's own style
// (icons/<style>/), or from the kit the theme dresses it in (/kits/<kit>/icons/), none missing, and a change of look
// redrawing them all.
//   node platform/hq/icons-check.mjs        (HQ in dev mode, on its mock data)
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';
import { STYLES } from './shell/icons.js';

// (the projects view first: the devices open over it)
const SCREENS = {
  projects: page => page.evaluate(() => import('/shell/projects.js').then(m => m.openProjects())),
  business: page => page.click('#projects [data-business]').then(() => page.waitForSelector('#projects [data-up]')),
  home: page => page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer())),
  phone: page => page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone())),
  intercom: page => page.evaluate(() => import('/shell/desk.js').then(m => m.openIntercom())),
};

const browser = await playwright().chromium.launch();
const server = await serve(undefined, 0),
  base = `http://localhost:${server.address().port}`;
for (const look of Object.keys(STYLES)) await checkLook(look);
await swapLook();
await browser.close();
server.close();
console.log('icons-check: every icon from its look’s own style');

async function checkLook(look) {
  const { page, errors } = await opened(look),
    from = await sourceOf(page, look);
  for (const [screen, open] of Object.entries(SCREENS)) {
    await open(page);
    const drawn = await drawnIcons(page);
    assert.ok(drawn.length, `${look}, ${screen}: icons on the page`);
    assert.deepEqual(
      drawn.filter(d => !d.startsWith(from)),
      [],
      `${look}, ${screen}: only icons from ${from}`,
    );
  }
  assert.deepEqual(errors, [], `${look}: no icon missing`);
  await page.close();
}

// Brownstone to Wire on stage: every icon already drawn is drawn again in Wire's style
async function swapLook() {
  const { page, errors } = await opened('brownstone');
  await SCREENS.home(page);
  await page.evaluate(() => import('/shell/stage.js').then(m => m.pick('wire')));
  const from = await sourceOf(page, 'wire'),
    drawn = await drawnIcons(page, from);
  assert.deepEqual(
    drawn.filter(d => !d.startsWith(from)),
    [],
    'a change of look redraws every icon',
  );
  assert.deepEqual(errors, []);
  await page.close();
}

async function opened(look) {
  const { page, errors } = await openPage(browser, { viewport: { width: 1280, height: 900 } });
  page.on('console', m => m.type() === 'error' && /icon/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${base}/?intro=0&renderer=${look}`);
  await until(page, '#loading.gone');
  return { page, errors };
}

// Where a look's icons come from: the kit the theme dresses it in, else its style's folder
async function sourceOf(page, look) {
  const kit = await page.evaluate(l => import('/shell/brand.js').then(m => m.theme[l]?.kit), look);
  return kit ? `/kits/${kit}/icons/` : `icons/${STYLES[look]}/`;
}

// Each icon's folder/name once every one on the page is drawn (in `style`, when given)
async function drawnIcons(page, style = '') {
  await page
    .waitForFunction(
      s => [...document.querySelectorAll('svg[data-icon]')].every(i => i.dataset.drawn?.startsWith(s)),
      style,
    )
    .catch(() => {
      // The assertions below name each icon left undrawn.
    });
  return page.$$eval('svg[data-icon]', icons => icons.map(i => i.dataset.drawn ?? `undrawn/${i.dataset.icon}`));
}
