// node platform/hq/book-check.mjs --stories 'the pen reaches every overlay' [--webkit] [--shots dir]
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { recording, fold, cross, screen, sameInk } from './bookpicture.mjs';
import { playLine } from './bookcall.mjs';
import { until } from './bookkit.mjs';

export function overlayStories(c) {
  return Object.fromEntries(
    [
      { width: 1133, height: 744 },
      { width: 744, height: 1133 },
    ].map(viewport => [
      `the pen reaches every overlay and the call sees it at ${viewport.width} × ${viewport.height}`,
      browser => overlays(browser, c, viewport),
    ]),
  );
}

async function overlays(browser, c, viewport) {
  const s = await recording(browser, c, viewport);
  const { page, hand } = s;
  const line = await prepare(s);
  try {
    await page.locator('#book .bk-lip').tap();
    await page.waitForFunction(() => !['folded', 'shut'].includes(document.documentElement.dataset.book));
    await page.waitForTimeout(900);
    await railButton(page, 'Tips');
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
    await rail(s, line, 'Preferences on this device', '.bk-prefs', 'preferences');
    await rail(s, line, 'Pen', '.bk-palette', 'colours');
    await fold(page);
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
  await page.evaluate(() => import('/shell/zoom.js').then(m => m.zoom('/theme/hq/tips/pen-button.jpg', 'Picture')));
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

async function prepare(s) {
  const { page } = s;
  if (process.argv.includes('--original-pen')) {
    for (const file of [
      'shared/review/layer.js',
      'shared/review/pentouch.js',
      'shared/review/dock.js',
      'platform/hq/shell/ink/book.js',
    ]) {
      const path = file.startsWith('shared/') ? `/__review/${file.split('/').at(-1)}` : '/shell/ink/book.js';
      await s.context.route(`${s.c.base}${path}`, async r =>
        r.fulfill({
          contentType: 'text/javascript',
          body: await readFile(
            `${process.argv[process.argv.indexOf('--original-pen') + 1]}/${file.split('/').at(-1)}`,
            'utf8',
          ),
        }),
      );
    }
  }
  const line = await playLine(s.context);
  await page.goto(`${s.c.base}/?intro=0&open=intercom&renderer=wire`);
  await page.waitForSelector('#loading.gone');
  await fold(page);
  await page.locator('#call').tap();
  await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled);
  await page.locator('#call-screenshare').tap();
  await page.locator('#call-min').tap();
  await page.waitForSelector('.callbubble');
  return line;
}

async function rail(s, line, name, selector, label) {
  await railButton(s.page, name);
  await marked(s, line, selector, label);
  await s.page.keyboard.press('Escape');
}

async function railButton(page, name) {
  const button = page.locator('#book').getByRole('button', { name, exact: true, includeHidden: true });
  if (await button.isVisible()) return button.tap();
  await page.locator('#book .bk-more').tap();
  await page.locator('.bk-more-card').getByRole('menuitem', { name, exact: true }).tap();
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
