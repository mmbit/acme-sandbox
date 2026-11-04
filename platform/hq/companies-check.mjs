#!/usr/bin/env node
// Settings › Companies and the Companies app in a real browser, on mock/links.json and mock/workspaces.json: our name
// and address at the top; each linked company with its HQ's answers and Unlink, which asks in place before it unlinks;
// the unlinked ones quieter; Make an invitation shows it once and Copy puts it on the clipboard; Withdraw asks first; a
// pasted invitation that isn't one is refused in words. The app is on the home screen only with a link or an
// invitation, lists the workspaces with the other company's name and what's unread, and a workspace opens with its
// threads (their words as text, never markup; urgent marked; ours arrived, read or on its way) and its files with every
// version, the newest two to download and an older one cleared, its line kept with nothing to download. Nothing covered
// and nothing off the screen. In every look, at desktop and phone width.
//   node platform/hq/companies-check.mjs [looks] [--out dir]  (screenshots to a temp folder, printed at the end)
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { playwright, errorsOf, tap, until } from '../../shared/browser/browser.mjs';
import { lookNames } from './looks.mjs';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'companies-check-'));
mkdirSync(out, { recursive: true });
const RENDERERS = args[0] && !args[0].startsWith('--') ? args[0].split(',') : lookNames();
const SIZES = [
  [1280, 800, 'desktop'],
  [390, 844, 'phone'],
];
const NO_LINKS = { name: 'New Company', address: 'https://hq.new-company.example', links: [], invitations: [] };

const server = await serve(undefined, 0),
  base = `http://localhost:${server.address().port}`;
// (WebGL on SwiftShader, as screens-check.mjs has it: without it the holo look takes minutes a page)
const browser = await playwright().chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const text = (page, sel) => page.$eval(sel, e => e.innerText.replace(/\s+/g, ' ').trim());
const desk = (page, fn, ...a) => page.evaluate(([fn, a]) => import('/shell/desk.js').then(m => m[fn](...a)), [fn, a]);

for (const look of RENDERERS)
  for (const [width, height, device] of SIZES) {
    const at = `${look}, ${device}`;
    console.log(`${at}…`);
    const page = await opened(look, width, height);
    const errors = errorsOf(page);
    // (once the overlay has faded in)
    const shot = name =>
      page.waitForTimeout(700).then(() => page.screenshot({ path: `${out}/${look}-${device}-${name}.png` }));
    await settingsPage(page, at, shot);
    await appPages(page, at, shot);
    await unlinking(page, at);
    assert.deepEqual(errors, [], at);
    await page.close();
  }
await withoutLinks(RENDERERS[0]);
await browser.close();
server.close();
console.log(`companies-check: all good (${RENDERERS.length} looks × desktop and phone). Screenshots: ${out}`);

// HQ in a look, with the look on stage (stage.js stage:look) before anything opens
async function opened(look, width, height, links = null) {
  const page = await browser.newPage({
    viewport: { width, height },
    hasTouch: width < 500,
    isMobile: width < 500,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  if (links) await page.route('**/mock/links.json', r => r.fulfill({ json: links }));
  await page.addInitScript(() => document.addEventListener('stage:look', e => (window.staged = e.detail.look)));
  await page.goto(`${base}/?intro=0&renderer=${look}`);
  await page.waitForFunction(l => window.staged === l, look, { polling: 100 });
  await page.waitForTimeout(800);
  return page;
}

async function openSettings(page) {
  await desk(page, 'openComputer', 'settings');
  await page.waitForSelector('[data-section="sys:companies"]');
  await tap(page, '[data-section="sys:companies"]');
  await page.waitForSelector('.companies .co-links');
}

// Settings › Companies: the links, an invitation made and copied, Withdraw asked, a wrong invitation refused
async function settingsPage(page, at, shot) {
  await openSettings(page);
  assert.match(await text(page, '.co-us'), /New Company · hq\.new-company\.example/, at);
  assert.match(await text(page, '.co-links [data-link="1"]'), /Mossgate Works Linked .*1 workspace · 2 unread/, at);
  assert.match(await text(page, '.co-links [data-link="2"]'), /2 entries waiting for its HQ since/, at);
  assert.match(await text(page, '.co-gone [data-link="3"]'), /Copperkite .* They unlinked/, at);
  await fits(page, at, 'settings', ['[data-invite]', '[data-join]', '[data-unlink="1"]']);
  await shot('settings');

  await tap(page, '[data-invite]');
  await page.waitForSelector('.co-made [data-copy]');
  await page.$eval('.co-made', e => e.scrollIntoView({ block: 'center' }));
  assert.equal(await page.$$eval('.co-invitations li', l => l.length), 2, `${at}: the new invitation is listed`);
  await tap(page, '.co-made [data-copy]');
  await until(page, '.co-made [data-copy]', /Copied/);
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^https:\/\/\S+#invite_\S{43}$/, at);
  await shot('invited');

  await tap(page, '[data-withdraw="4"]');
  await until(page, '[data-invitation="4"]', /Tap again to withdraw/);
  await page.waitForTimeout(600); // (a second tap within ask.js's SETTLE_MS is the same gesture)
  await tap(page, '[data-withdraw="4"]');
  await page.waitForFunction(() => !document.querySelector('[data-invitation="4"]'), null, { polling: 100 });

  await page.fill('[name="invitation"]', 'not an invitation');
  await tap(page, '[data-join]');
  await until(page, '.co-said', /An invitation is the whole line/, 10_000);
  // (a field with words in it, or the focus, keeps the computer where it is)
  await page.fill('[name="invitation"]', '');
  await page.$eval('[name="invitation"]', e => e.blur());
}

// The app: on the home screen, its list, a workspace with its threads and files, and back
async function appPages(page, at, shot) {
  await desk(page, 'openComputer', 'home');
  await page.waitForSelector('[data-app="companies"]');
  await tap(page, '[data-app="companies"]');
  await page.waitForSelector('.co-list');
  const rows = await page.$$eval('.co-list li', l => l.map(e => e.innerText.replace(/\s+/g, ' ')));
  assert.equal(rows.length, 3, at);
  assert.match(
    rows[0],
    /Autumn ad for the pocket notebooks › Mossgate Works · 2 threads · 2 files .* 2 unread · 1 urgent/,
    at,
  );
  assert.match(rows[2], /Unlinked/i, at);
  await fits(page, at, 'list', ['[data-workspace="1"]']);
  await shot('list');

  await tap(page, '[data-workspace="1"]');
  await page.waitForSelector('.co-workspace');
  assert.match(await page.$eval('.computer header b span', e => e.textContent), /Companies › Autumn ad/, at);
  assert.equal(await page.$$eval('.co-thread', l => l.length), 2, at);
  const musicMessage = await page.$eval('.co-thread .co-msg:nth-child(2) .co-text', e => ({
    tags: e.children.length,
    text: e.textContent,
  }));
  assert.equal(musicMessage.tags, 0, `${at}: their words are never markup`);
  assert.match(musicMessage.text, /<b>music<\/b>/, at);
  assert.match(musicMessage.text, /\n1\. May the notebook/, `${at}: line breaks kept`);
  assert.match(await text(page, '.co-thread'), /Read by them .* Arrived .*not read yet/, at);
  assert.match(await text(page, '.co-msg.urgent'), /Marlo \(Mossgate Works\) .* Urgent New/i, at);
  const files = await page.$$eval('.co-files > li', l =>
    l.map(e => ({
      path: e.querySelector('.co-path').textContent,
      versions: e.querySelectorAll('.co-versions > li').length,
      downloads: e.querySelectorAll('.co-get[href]').length,
    })),
  );
  assert.deepEqual(
    files,
    [
      { path: 'brief/brief.md', versions: 3, downloads: 2 },
      { path: 'assets/notebook-cover-front.png', versions: 2, downloads: 2 },
    ],
    at,
  );
  assert.match(await text(page, '.co-files > li:first-child .co-versions > li:last-child'), /^v1.* · cleared/, at);
  await fits(page, at, 'workspace', ['.co-msg.urgent', '.co-get']);
  await shot('workspace');
  await page.$eval('.co-files', e => e.scrollIntoView({ block: 'start' }));
  await shot('files');

  await tap(page, '[data-home]');
  await page.waitForSelector('.co-list');
  await tap(page, '[data-workspace="2"]');
  await until(page, '.co-workspace', /On its way/);
  await fits(page, at, 'a long title', ['.co-get']);
  await tap(page, '[data-home]');
  await page.waitForSelector('.co-list');
}

// Unlink asks in place, then the company moves to the unlinked ones
async function unlinking(page, at) {
  await openSettings(page);
  await tap(page, '[data-unlink="1"]');
  await until(page, '[data-link="1"]', /Tap again to unlink.*keep what was shared so far, and nothing more crosses/);
  await page.waitForTimeout(600);
  await tap(page, '[data-unlink="1"]');
  await until(page, '.co-gone', /Mossgate Works We unlinked/);
  assert.equal(await page.$('.co-links:not(.co-gone) [data-link="1"]'), null, at);
}

// No link and no invitation: no app on the home screen, until an invitation is made
async function withoutLinks(look) {
  const page = await opened(look, 1280, 800, NO_LINKS);
  const errors = errorsOf(page);
  await desk(page, 'openComputer', 'home');
  await page.waitForSelector('[data-app="settings"]');
  await page.waitForTimeout(500);
  assert.equal(await page.$('[data-app="companies"]'), null, 'no app without a link');
  await desk(page, 'openComputer', 'settings', { section: 'sys:companies' });
  await until(page, '.companies', /None yet/);
  await tap(page, '[data-invite]');
  await page.waitForSelector('.co-made');
  await desk(page, 'openComputer', 'home');
  await page.waitForSelector('[data-app="companies"]');
  assert.deepEqual(errors, [], 'without links');
  await page.close();
}

// Nothing off the screen inside the computer's, and each element named reachable: at its centre, scrolled into view,
// it's the one a tap finds
async function fits(page, at, where, needed) {
  const over = await page.evaluate(() => {
    const s = document.querySelector('#crt').getBoundingClientRect();
    return [...document.querySelectorAll('#crt *')]
      .filter(e => {
        const r = e.getBoundingClientRect();
        return r.width && (r.left < s.left - 1 || r.right > s.right + 1);
      })
      .map(e => e.outerHTML.slice(0, 80));
  });
  assert.deepEqual(over, [], `${at}: something is off the screen (${where})`);
  for (const selector of needed) {
    const covered = await page.$eval(selector, e => {
      e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      const found = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const view = innerWidth >= r.right && innerHeight >= r.bottom && r.left >= 0 && r.top >= 0;
      return !view || !e.contains(found) ? (found?.outerHTML.slice(0, 80) ?? 'off the page') : null;
    });
    assert.equal(covered, null, `${at}: ${selector} is covered (${where})`);
  }
}
