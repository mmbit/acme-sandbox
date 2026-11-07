#!/usr/bin/env node
// A card's files on an iPhone: its sounds play on the card in their own player (play and pause, where it is, how long
// it lasts), one at a time; in HQ pinned to the home screen every download (a card's file, a sound's save key, a
// page's export) opens in HQ's own file sheet with a close, and Save hands the file to the share sheet, or downloads one
// it won't take; a refused play or save is said. In the browser a download stays a download.
//   node platform/hq/deskfiles-check.mjs [--webkit]
// HQ on its own files with a fake /api (so it isn't in dev mode), the phone open on a card with two sounds, a PDF and
// a zip.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const dir = mkdtempSync(`${tmpdir()}/deskfiles-`);
const tone = (name, hz) => {
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${hz}:duration=3`,
    '-q:a',
    '6',
    `${dir}/${name}`,
  ]);
  return readFileSync(`${dir}/${name}`);
};
const FILES = [
  tone('stem-a.mp3', 440),
  tone('stem-b.mp3', 550),
  Buffer.from('%PDF-1.4\n%%EOF\n'),
  Buffer.from('PK\x05\x06'),
];
const card = {
  id: 7,
  created: new Date().toISOString(),
  agent: 'wren',
  kind: 'action',
  title: 'Which voice',
  body: 'Listen to both voices.',
  urgency: 'today',
  files: [
    { n: 0, name: 'stem-a.mp3', size: FILES[0].length, kept: true },
    { n: 1, name: 'stem-b.mp3', size: FILES[1].length, kept: true },
    { n: 2, name: 'script.pdf', size: FILES[2].length, kept: true },
    { n: 3, name: 'takes.zip', size: FILES[3].length, kept: true },
  ],
};

const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const browser = await playwright()[engine].launch();
try {
  const phone = {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    ...(engine === 'webkit' ? { isMobile: true } : {}),
  };
  await inTheBrowser(await desk(phone));
  await pinned(await desk(phone, { pinned: true }));
} finally {
  await browser.close();
  server.close();
}
console.log(`deskfiles-check (${engine}): ok`);

// The phone open on the card; pinned: as a home-screen app (navigator.standalone), with a share sheet that counts its
// files and takes no zip, and window.refuse to have the browser refuse the next play and share
async function desk(options, { pinned = false } = {}) {
  const { context, page, errors } = await openPage(browser, { ...options, acceptDownloads: true });
  await context.route(`${base}/api/**`, async r => {
    const url = new URL(r.request().url());
    if (url.pathname === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
    if (url.pathname === '/api/requests') return r.fulfill({ json: [card] });
    if (url.pathname === '/api/gazette') return r.fulfill({ json: [] }); // (HQ's boot waits for it)
    if (url.pathname === '/api/requests/file') return fileAnswer(r, Number(url.searchParams.get('n')));
    return r.fulfill({ status: 404, body: '' });
  });
  if (pinned)
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true });
      // (every sound made, to see it stop)
      const Made = window.Audio;
      window.sounds = [];
      window.Audio = function (...src) {
        const sound = new Made(...src);
        window.sounds.push(sound);
        return sound;
      };
      window.refuse = false;
      const refused = () => Promise.reject(new DOMException('Not allowed.', 'NotAllowedError'));
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        return window.refuse ? refused() : play.call(this);
      };
      window.shared = [];
      navigator.canShare = ({ files }) => !files.some(f => f.name.endsWith('.zip'));
      navigator.share = async ({ files }) =>
        window.refuse ? refused() : void window.shared.push(...files.map(f => [f.name, f.type, f.size]));
    });
  await page.goto(`${base}/?intro=0&open=phone`);
  await page.waitForSelector('.req .files');
  return { context, page, errors };
}
// As the coordinator answers (cardfiles.ts): a sound with its type, by the byte range asked
function fileAnswer(r, n) {
  const bytes = FILES[n],
    type = n < 2 ? 'audio/mpeg' : 'application/octet-stream';
  const range = /^bytes=(\d+)-(\d*)$/.exec(r.request().headers().range ?? '');
  const disposition = {
    'content-disposition': `attachment; filename="${card.files[n].name}"`,
    'accept-ranges': 'bytes',
  };
  if (!range) return r.fulfill({ status: 200, contentType: type, headers: disposition, body: bytes });
  const start = Number(range[1]),
    end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  return r.fulfill({
    status: 206,
    contentType: type,
    headers: { ...disposition, 'content-range': `bytes ${start}-${end}/${bytes.length}` },
    body: bytes.subarray(start, end + 1),
  });
}

// In the browser: the sounds play on the card, one at a time, and a PDF is a download by its name
async function inTheBrowser({ context, page, errors }) {
  const players = page.locator('.req .files .listen');
  assert.deepEqual(await players.locator('.listen-name').allTextContents(), ['stem-a.mp3', 'stem-b.mp3']);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.listen-time')].every(t => / \/ 0:03$/.test(t.textContent)),
  );
  await shot(page, 'card');

  await players.nth(0).locator('.listen-play').tap();
  await page.waitForFunction(
    () => document.querySelector('.listen[data-playing] .listen-name')?.textContent === 'stem-a.mp3',
  );
  await page.waitForFunction(() =>
    /^0:01 /.test(document.querySelector('.listen').querySelector('.listen-time').textContent),
  );
  await shot(page, 'playing');
  await players.nth(1).locator('.listen-play').tap();
  await page.waitForFunction(
    () => document.querySelector('.listen[data-playing] .listen-name')?.textContent === 'stem-b.mp3',
  );
  assert.equal(await page.locator('.listen[data-playing]').count(), 1, 'one sound plays at a time');
  assert.equal(
    await players.nth(0).locator('.listen-time').textContent(),
    '0:00 / 0:03',
    'the first stopped, back at its start',
  );
  await players.nth(1).locator('.listen-play').tap();
  await page.waitForSelector('.listen[data-playing]', { state: 'detached' });
  // a drag along the bar goes there
  await players.nth(0).locator('.listen-at').fill('2.5');
  await page.waitForFunction(() => /^0:02 /.test(document.querySelector('.listen .listen-time').textContent));

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.req .files a', { hasText: 'script.pdf' }).tap(),
  ]);
  assert.equal(download.suggestedFilename(), 'script.pdf');
  assert.equal(await page.locator('dialog.fileview').count(), 0, 'no sheet in the browser');
  assert.deepEqual(errors, []);
  await context.close();
}

// Pinned to the home screen: each download opens in HQ's file sheet and closes back to the card, and the page stays
async function pinned({ context, page, errors }) {
  // (headless Chromium has no PDF viewer: the sheet's frame saves its PDF, under its blob's name)
  const downloads = [];
  page.on('download', d => downloads.push(d.suggestedFilename()));
  const address = page.url();

  await page.locator('.req .files a', { hasText: 'script.pdf' }).tap();
  const sheet = page.locator('dialog.fileview');
  await sheet.locator('iframe[title="script.pdf"]').waitFor();
  assert.equal(await sheet.locator('header .fn').textContent(), 'script.pdf');
  await shot(page, 'pinned-pdf');
  await sheet.locator('.fileview-save').tap();
  await page.waitForFunction(() => window.shared.length === 1);
  await sheet.locator('.fileview-close').tap();
  await sheet.waitFor({ state: 'detached' });

  // a sound's save key: the sound in the sheet, playing there, and stopping as the sheet closes
  await page.locator('.req .files .listen .save').first().tap();
  await sheet.locator('.listen-play').tap();
  await page.waitForFunction(() => /^0:01 /.test(document.querySelector('dialog.fileview .listen-time')?.textContent));
  await shot(page, 'pinned-sound');
  await sheet.locator('.fileview-save').tap();
  await page.waitForFunction(() => window.shared.length === 2);
  await sheet.locator('.fileview-close').tap();
  await sheet.waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.sounds.every(a => a.paused));

  // a play and a save the system refuses are said, on the player and the sheet's line
  await page.evaluate(() => (window.refuse = true));
  await page.locator('.req .files .listen-play').first().tap();
  await page.waitForFunction(
    () => document.querySelector('.listen-time').textContent === 'Can’t play this here: save it',
  );
  await page.locator('.req .files a', { hasText: 'script.pdf' }).tap();
  await sheet.locator('.fileview-save').tap();
  await sheet.locator('.fileview-said', { hasText: 'Couldn’t save it: Not allowed.' }).waitFor();
  await shot(page, 'pinned-refused');
  await sheet.locator('.fileview-close').tap();
  await sheet.waitFor({ state: 'detached' });
  await page.evaluate(() => (window.refuse = false));

  // a file the share sheet won't take: Save downloads it, the sheet stays
  await page.locator('.req .files a', { hasText: 'takes.zip' }).tap();
  await sheet.locator('.fileview-note', { hasText: 'can’t be shown here' }).waitFor();
  const [zip] = await Promise.all([page.waitForEvent('download'), sheet.locator('.fileview-save').tap()]);
  assert.equal(zip.suggestedFilename(), 'takes.zip');
  await sheet.locator('.fileview-close').tap();
  await sheet.waitFor({ state: 'detached' });

  // a page's export: the link Ink makes and clicks itself (bookshare.js downloaded)
  await page.evaluate(async () => {
    const { downloaded } = await import('/shell/ink/bookshare.js');
    const canvas = Object.assign(document.createElement('canvas'), { width: 300, height: 400 });
    const png = await new Promise(done => canvas.toBlob(done, 'image/png'));
    await downloaded(Promise.resolve(new File([png], 'Notebook page.png', { type: 'image/png' })));
  });
  await sheet.locator('img[alt="Notebook page.png"]').waitFor();
  await sheet.locator('.fileview-close').tap();

  assert.deepEqual(await page.evaluate(() => window.shared), [
    ['script.pdf', 'application/pdf', FILES[2].length],
    ['stem-a.mp3', 'audio/mpeg', FILES[0].length],
  ]);
  const named = ['script.pdf', 'stem-a.mp3', 'Notebook page.png'];
  assert.deepEqual(
    downloads.filter(name => named.includes(name)),
    [],
    'no file of ours downloads in the pinned app',
  );
  assert.equal(page.url(), address, 'HQ stays on its page');
  assert.ok(await page.locator('.req .files').isVisible(), 'back on the card');
  assert.deepEqual(errors, []);
  await context.close();
}

async function shot(page, name) {
  await page.screenshot({ path: `${process.env.TMPDIR ?? '/tmp'}/deskfiles-${engine}-${name}.png` });
}
