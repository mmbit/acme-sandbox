// node platform/hq/book-check.mjs --stories 'the pen reaches every overlay' [--webkit] [--shots dir]
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { recording, cross, screen, sameInk } from './picture.mjs';
import { playLine } from './call.mjs';
import { MINI, UPRIGHT, DESKTOP, PREFERENCES, middleOf, until, bookOpen } from './kit.mjs';
import { minimiseCall } from './callview.mjs';

export function overlayStories(c) {
  return Object.fromEntries(
    [MINI, UPRIGHT].map(viewport => [
      `the pen reaches every overlay and the call sees it at ${viewport.width} × ${viewport.height}`,
      browser => overlays(browser, c, viewport),
    ]),
  );
}

export function mediaStories(c) {
  return Object.fromEntries(
    [MINI, UPRIGHT, DESKTOP].map(viewport => [
      `the shared picture keeps the device's controls at ${viewport.width} × ${viewport.height}`,
      browser => mediaPicture(browser, c, viewport),
    ]),
  );
}

async function mediaPicture(browser, c, viewport) {
  const s = await recording(browser, c, viewport, { hasTouch: viewport !== DESKTOP });
  const { page } = s;
  try {
    const line = await prepare(s, true);
    await page.locator('#book .bk-lip').click();
    await page.waitForFunction(() => !['folded', 'shut'].includes(document.documentElement.dataset.book));
    await page.waitForTimeout(900);
    await page.locator('#book [data-island=tools]').getByRole('button', { name: 'Pen', exact: true }).click();
    const control = page.locator('.bk-palette').getByRole('menuitemradio', { name: 'Blue', exact: true });
    await control.waitFor();
    const centre = middleOf(await control.boundingBox());
    const box = { x: centre[0] - 50, y: centre[1] - 35, width: 100, height: 70 };
    await cross(s.hand, box);
    await until(() => s.notes.length > 0, 'the marked control reaches the call');
    const picture = await screen(s, 'media-controls');
    const matches = s.events.filter(e => e.type === 5 && e.data.tag === 'media');
    assert.ok(
      matches.some(e => e.data.payload.matches['(pointer: coarse)'] === (viewport !== DESKTOP)),
      'the recording keeps this device’s pointer environment',
    );
    await sameInk(s, picture.bytes, box, true);
    await mediaComparison(s);
    line.send({ type: 'note', id: s.notes.length, state: 'done' });
    await page.keyboard.press('Escape');
    await page.locator('.cb-hangup').click();
    c.noErrorsIn(s.errors);
  } finally {
    await s.done();
  }
}

async function mediaComparison(s) {
  const { viewport, c } = s;
  const past = await s.mirrors.at(
    s.events,
    s.events.at(-1).timestamp,
    { long: Math.max(viewport.width, viewport.height), png: true },
    () => true,
  );
  assert.ok(past, 'the past picture is available');
  if (c.shots) {
    await writeFile(`${c.shots}/past-${viewport.width}-media-controls.png`, past.bytes);
    // The same recording without its media environment shows the previous replay behavior.
    const before = await s.mirrors.at(
      s.events.filter(e => !(e.type === 5 && e.data.tag === 'media')),
      s.events.at(-1).timestamp,
      { long: Math.max(viewport.width, viewport.height), png: true },
      () => true,
    );
    await writeFile(`${c.shots}/before-${viewport.width}-media-controls.png`, before.bytes);
  }
}

async function overlays(browser, c, viewport) {
  const s = await recording(browser, c, viewport);
  const { page, hand } = s;
  const line = await prepare(s);
  try {
    await bookOpen(page, true);
    await controlTapped(page, 'Tips');
    await page.waitForSelector('.tb-book:not(.tb-shut)');
    await page.waitForTimeout(900);
    await marked(s, line, '.tb-title', 'tips');
    // Finger navigation and a pen tap still work after drawing on the book.
    await page.locator('.tb-on').tap();
    await page.waitForTimeout(600);
    const home = await page.locator('.tb-home').boundingBox();
    const centre = [home.x + home.width / 2, home.y + home.height / 2];
    await hand.stroke('pen', [centre, [centre[0] + 5, centre[1]], centre]);
    await page.waitForFunction(() => !document.querySelector('.tb-spread').hidden);
    await page.waitForTimeout(450); // Let the pen tap's native click finish before the next finger tap.
    await page.keyboard.press('Escape');
    await page.waitForSelector('.tb', { state: 'detached' });
    await cardMarked(s, line, PREFERENCES, '.bk-prefs', 'preferences');
    await cardMarked(s, line, 'Pen', '.bk-palette', 'colours');
    await bookOpen(page, false);
    await pageOverlays(s, line);
    await dialogs(s, line);
    await futureSurfaces(s, line);
    await page.locator('.cb-hangup').tap();
    c.noErrorsIn(s.errors);
  } catch (error) {
    await c.shot(`overlay-${viewport.width}-failed`, page);
    throw error;
  } finally {
    await s.done();
  }
}

async function pageOverlays(s, line) {
  const { page } = s;
  for (const [button, name] of [
    ['#btn-desk', 'desk-phone'],
    ['#btn-intercom', 'intercom'],
    ['#btn-computer', 'computer'],
  ]) {
    await page.locator(button).tap();
    await marked(s, line, '#tool .device', name);
    await page.locator('#tool [data-close]').first().tap();
  }
  await page.locator('#btn-news').tap();
  await marked(s, line, '#panel-body', 'newsletter-and-library-panel');
  await page.locator('#panel-close').tap();
  await page.waitForFunction(() => document.querySelector('#panel').hidden);
  await page.locator('#btn-find').tap();
  await marked(s, line, '.finder-chips', 'finder');
  await page.keyboard.press('Escape');
  await page.locator('#btn-projects').tap();
  await marked(s, line, '#projects .pj-modal', 'projects');
  await page.evaluate(() => import('/shell/projects.js').then(m => m.closeProjects()));
}

async function dialogs(s, line) {
  const { page } = s;
  await page.evaluate(async () => {
    const { stylesheet } = await import('/util.js');
    await stylesheet('shell/tips.css');
    const { showMe } = await import('/shell/showme.js');
    showMe([{ at: '#btn-intercom', say: 'Open the intercom' }], {}, () => {});
  });
  await marked(s, line, '.showme-step', 'show-me');
  await page.locator('.showme-step button').tap();
  await page.evaluate(src => import('/shell/zoom.js').then(m => m.zoom(src, 'Picture')), s.c.SNIP);
  await page.locator('dialog.zoom > img').evaluate(img => img.decode());
  await marked(s, line, 'dialog.zoom', 'picture');
  await page.locator('.zoom-close').tap();
  await s.context.route('**/api/notebooks/guests', r => r.fulfill({ json: { notebooks: [] } }));
  await page.evaluate(() => import('/shell/ink/bookinvites.js').then(m => m.watchGuestBook(1)));
  await marked(s, line, '.bi-dialog', 'guest-book');
  await page.locator('.bi-dialog [data-close]').tap();
  await s.context.route('**/api/calls/recording?*', r => r.fulfill({ status: 404, body: '' }));
  await page.evaluate(() => import('/shell/callplayer.js').then(m => m.openCallPlayer({ id: 1, agent: 'lyra' })));
  await marked(s, line, 'dialog.cp', 'call-player');
  await page.locator('.cp-close').tap();
}

async function prepare(s, mouse = false) {
  const { page } = s;
  const line = await playLine(s.context);
  await page.goto(`${s.c.base}/?intro=0&open=intercom&renderer=wire`);
  await page.waitForSelector('#loading.gone');
  await bookOpen(page, false, mouse);
  const press = selector => (mouse ? page.locator(selector).click() : page.locator(selector).tap());
  await press('#call');
  await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled);
  await press('#call-screenshare');
  await minimiseCall(page, mouse);
  return line;
}

// A card of the book's controls opened and marked by the pen
async function cardMarked(s, line, name, selector, label) {
  await controlTapped(s.page, name);
  await marked(s, line, selector, label);
  await s.page.keyboard.press('Escape');
}

// A control of the book's tapped: its key on the islands, or its row in the bar's dots menu
async function controlTapped(page, name) {
  const button = page.locator('#book .bk-controls').getByRole('button', { name, exact: true });
  if (await button.isVisible()) return button.tap();
  await page.locator('#book .bk-more').tap();
  await page.locator('#book .bk-more-card').getByRole('menuitem', { name, exact: true }).tap();
}

async function marked(s, line, selector, name) {
  const target = s.page.locator(selector).first();
  await target.waitFor();
  await s.page.waitForTimeout(350);
  const b = await target.boundingBox();
  const box = { x: b.x + 12, y: b.y + 12, width: Math.min(100, b.width - 24), height: Math.min(50, b.height - 24) };
  const before = s.notes.length;
  await cross(s.hand, box);
  await until(() => s.notes.length > before, `${name} note reaches the call`);
  const note = s.notes.at(-1);
  assert.ok(note.anchor.ink.length, `${name} has ink`);
  assert.ok(note.snip?.startsWith('data:image/jpeg'), `${name} has a screenshot`);
  const picture = await screen(s, `overlay-${name}`);
  await sameInk(s, picture.bytes, box, true);

  line.send({ type: 'note', id: s.notes.length, state: 'done' });
  await s.page.waitForTimeout(250);
  const cleared = await screen(s, `overlay-${name}-cleared`);
  await sameInk(s, cleared.bytes, box, false);
  console.log(`Pen and shared picture: ${name}`);
}

async function futureSurfaces(s, line) {
  await s.page.evaluate(() => {
    dispatchEvent(new CustomEvent('review:cover', { detail: true }));
    const surface = document.createElement('section');
    surface.id = 'future-surface';
    surface.style.cssText = 'position:fixed;inset:120px 80px;background:#faf5e7;z-index:2147483647';
    surface.textContent = 'A future HQ surface above a preview';
    document.documentElement.append(surface);
  });
  await marked(s, line, '#future-surface', 'future-surface-over-viewer');
  await s.page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'future-dialog';
    dialog.style.cssText = 'width:350px;height:250px;background:#faf5e7';
    dialog.innerHTML =
      '<div popover="manual" style="width:280px;height:180px;background:#e0e9db">A nested future popover</div>';
    document.querySelector('#book .bk-paper').append(dialog);
    dialog.showModal();
    dialog.firstElementChild.showPopover();
  });
  await marked(s, line, '#future-dialog [popover]', 'nested-popover');
  await s.page.evaluate(() => {
    document.querySelector('#future-dialog').remove();
    document.querySelector('#future-surface').remove();
    dispatchEvent(new CustomEvent('review:cover', { detail: false }));
  });
}
