#!/usr/bin/env node
// HQ's alerts in every look: an error on the intercom's line (the microphone refused) and on a card's (an answer the
// server didn't save) is the shell's alert part, its sign before the words, with no strip down its side, each look
// drawing it its own way. In Slate (renderer wire), dressed in the design system's kit, it's the kit's part: a panel
// with an ink sign and no red, and so are a toast and the desk phone's empty state. On a phone and a laptop, with a
// stand-in /api.
//   node platform/hq/alerts-check.mjs [look …] [--out <folder>]   (all three looks by default)
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const { chromium, devices } = playwright();
const args = process.argv.slice(2),
  out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const looks = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const LOOKS = looks.length ? looks : ['wire', 'brownstone', 'holo'];
const SIZES = { phone: devices['Pixel 7'], laptop: { viewport: { width: 1280, height: 860 } } };

const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const card = {
  id: 7,
  created: new Date(Date.now() - 600_000).toISOString(),
  agent: 'wren',
  kind: 'decision',
  title: 'Blue or green for the sign?',
  body: 'About the sign.',
};
const browser = await chromium.launch();

// A colour as [r, g, b], and whether it reads red: red well above both green and blue
const rgb = c =>
  c
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number);
const red = c => {
  const [r, g, b] = rgb(c);
  return r - Math.max(g, b) > 60;
};
// The alert in a line: its sign, its words, and how it's drawn
const alertIn = (page, line) =>
  page.$eval(line, l => {
    const a = l.querySelector('.alert'),
      s = a?.querySelector('.sign'),
      css = a && getComputedStyle(a);
    return (
      a && {
        kind: a.className,
        role: a.getAttribute('role'),
        words: a.querySelector('.words')?.textContent,
        sign: !!s?.querySelector('svg'),
        background: css.backgroundColor,
        colour: css.color,
        sides: ['Top', 'Right', 'Bottom', 'Left'].map(k => css[`border${k}Width`]),
        round: css.borderTopLeftRadius,
        signBackground: getComputedStyle(s).backgroundColor,
        signRound: getComputedStyle(s).borderTopLeftRadius,
      }
    );
  });

for (const look of LOOKS)
  for (const [size, device] of Object.entries(SIZES)) {
    const { context, page, errors } = await openPage(browser, device);
    page.setDefaultTimeout(90_000);
    let fail = false;
    // the microphone refused, as a browser does when its permission is turned down
    await context.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    await context.route(`${base}/api/**`, r => {
      const path = new URL(r.request().url()).pathname;
      if (path === '/api/org') return r.fetch({ url: `${base}/mock/org.json` }).then(o => r.fulfill({ response: o }));
      if (path === '/api/requests') return r.fulfill({ json: fail === 'empty' ? [] : [card] });
      if (path === '/api/requests/answer') return r.fulfill({ status: 500, body: '' });
      if (path === '/api/seen') return r.fulfill({ json: {} });
      if (path === '/api/chat') return r.fulfill({ json: { messages: [] } });
      if (path === '/api/events') return r.fulfill({ body: 'retry: 600000\n\n', contentType: 'text/event-stream' });
      if (['/api/gazette', '/api/mail', '/api/review/products', '/api/requests/later'].includes(path))
        return r.fulfill({ json: [] });
      return r.fulfill({ status: 404, body: '' });
    });
    await page.goto(`${base}/?renderer=${look}&intro=0`);
    await until(page, '#loading.gone');
    const tag = `${look}-${size}`,
      shot = async name => out && page.screenshot({ path: `${out}/alerts-${tag}-${name}.png` });
    const slate = look === 'wire';
    const tokens = await page.evaluate(() => {
      const b = getComputedStyle(document.body),
        probe = document.body.appendChild(document.createElement('i')),
        colour = v => ((probe.style.color = `var(${v})`), getComputedStyle(probe).color);
      const got = { panel: colour('--k-panel'), ink: colour('--k-ink'), font: b.fontSize };
      probe.remove();
      return got;
    });

    // the intercom: hold the mic with the microphone refused
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openIntercom()));
    await page.waitForSelector('#mic:not([disabled])');
    const mic = await page.locator('#mic').boundingBox();
    await page.mouse.move(mic.x + mic.width / 2, mic.y + mic.height / 2);
    await page.mouse.down();
    await page.waitForSelector('#dir-msg .alert');
    await page.mouse.up();
    const said = await alertIn(page, '#dir-msg');
    assert.equal(said.kind, 'alert problem', `${tag}: the intercom's error is an alert`);
    assert.equal(said.role, 'alert');
    assert.match(
      said.words,
      /^The microphone is blocked for .+\. Allow it in the browser’s site settings, then try again\.$/,
    );
    assert.ok(said.sign, `${tag}: with its sign`);
    assert.equal(new Set(said.sides).size, 1, `${tag}: no strip down one side (${said.sides})`);
    if (slate) {
      assert.deepEqual(
        [said.background, said.colour, said.signBackground, said.round, said.signRound],
        [tokens.panel, tokens.ink, tokens.ink, '24px', '50%'],
        `${tag}: the kit's alert: a panel, an ink sign, the tile's corners`,
      );
      assert.ok(![said.background, said.colour, said.signBackground].some(red), `${tag}: never red`);
    }
    await shot('intercom');
    // and it goes when the board types
    await page.type('#dir-title', 'a');
    assert.equal(await page.$('#dir-msg .alert'), null, `${tag}: typing clears it`);
    await page.evaluate(() => document.querySelector('.device [data-close]').click());

    // a card whose answer the server couldn't save
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
    await page.waitForSelector('#phone-screen h3');
    await page.fill('#answer', 'Green');
    await page.click('#send-answer');
    await page.waitForSelector('#answer-msg .alert');
    const onCard = await alertIn(page, '#answer-msg');
    assert.equal(onCard.kind, 'alert problem', `${tag}: the card's error is an alert`);
    assert.equal(onCard.words, 'The server couldn’t save that (error 500). Try again in a minute.');
    assert.ok(onCard.sign && new Set(onCard.sides).size === 1, `${tag}: with its sign, no strip`);
    if (slate) assert.ok(![onCard.background, onCard.colour, onCard.signBackground].some(red), `${tag}: never red`);
    await shot('card');

    // the empty phone: its state, with its sign where the look draws one
    fail = 'empty';
    await page.evaluate(() => document.querySelector('.device [data-close]').click());
    await page.reload();
    await until(page, '#loading.gone');
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
    await page.waitForSelector('#phone-screen .quiet');
    const state = await page.$eval('#phone-screen .quiet', q => ({
      sign: getComputedStyle(q.querySelector('.sign')).display !== 'none',
      background: getComputedStyle(q).backgroundColor,
    }));
    assert.equal(state.sign, slate, `${tag}: the state's sign shows in Slate alone`);
    if (slate) assert.equal(state.background, tokens.panel, `${tag}: on a panel`);
    await shot('empty');
    await page.evaluate(() => document.querySelector('.device [data-close]').click());

    // a toast: in ink, so it reads over anything
    if (slate) {
      await page.evaluate(() => import('/shell/hud.js').then(h => h.toast('<b>Sent to Thea</b><br>3 notes')));
      const toast = await page.$eval('#toasts .toast', t => [
        getComputedStyle(t).backgroundColor,
        getComputedStyle(t).color,
      ]);
      assert.deepEqual(toast, [tokens.ink, tokens.panel], `${tag}: a toast in ink`);
      await shot('toast');
    }
    assert.deepEqual(
      errors.filter(e => !/icons\/(prev|next|pause|hourglass|download)\.svg/.test(e)),
      [],
      `${tag}: no page errors`,
    );
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
    console.log(`ok ${tag}`);
  }
await browser.close();
server.close();
