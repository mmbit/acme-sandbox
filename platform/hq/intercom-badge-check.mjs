#!/usr/bin/env node
// The intercom's unread badge: a reply from the CEO arrives while the intercom is shut → its button shows 1, drawn on
// top where it can be seen → opening the intercom clears it, and the coordinator keeps that it was seen → after a reload
// it's still gone. In every look, on a phone and a tablet.
//   node platform/hq/intercom-badge-check.mjs [--shots dir] [--only look[:width]]   (HQ's files from serve.mjs, its /api
//   played here; --only runs one look, or one look at one size)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';
import { lookNames } from './looks.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const browser = await playwright().chromium.launch();
const ceo = (await (await fetch(`${base}/mock/org.json`)).json()).company.ceo;

for (const look of lookNames())
  for (const [width, height] of [
    [390, 844],
    [1180, 820],
  ]) {
    if (only && only !== look && only !== `${look}:${width}`) continue;
    const where = `${look} ${width}`;
    // the coordinator as this check plays it: the conversation so far, read up to its last line
    const ts = new Date().toISOString();
    const messages = [
      { id: 1, ts, who: 'board', text: 'How is the badge coming along?' },
      { id: 2, ts, who: ceo, text: 'Nearly there.' },
    ];
    const marks = { intercom: 2 };
    const { context, page, errors } = await openPage(browser, {
      viewport: { width, height },
      deviceScaleFactor: shots ? 2 : 1,
    });
    page.setDefaultTimeout(90_000); // (the stage draws behind it: slow on a busy machine's software GL)
    await context.route(`${base}/api/**`, async r => {
      const path = new URL(r.request().url()).pathname,
        get = r.request().method() === 'GET';
      if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
      if (path === '/api/chat' && get) return r.fulfill({ json: { messages, thinking: false } });
      if (path === '/api/seen' && get) return r.fulfill({ json: { ...marks } });
      if (path === '/api/seen') {
        const b = r.request().postDataJSON();
        if (marks[b.list] == null || b.newest > marks[b.list]) marks[b.list] = b.newest;
        return r.fulfill({ json: { ...marks } });
      }
      if (path === '/api/requests' || path === '/api/review/products' || path === '/api/gazette')
        return r.fulfill({ json: [] });
      return r.fulfill({ status: 404, body: '' });
    });
    const badge = () => page.$eval('#intercom-count', b => (b.hidden ? 0 : Number(b.dataset.n)));
    const hq = `${base}/?intro=0&renderer=${look}`;
    await page.goto(hq);
    await until(page, '#loading.gone');
    await page.waitForTimeout(500);
    assert.equal(await badge(), 0, `${where}: nothing new to begin with`);

    // a reply arrives on the event stream, as the coordinator publishes it (chat.ts answered())
    messages.push({ id: 3, ts: new Date().toISOString(), who: ceo, text: 'Done: the badge is in.' });
    await page.evaluate(
      who =>
        import('/shell/events.js').then(m =>
          m.onEvent({ type: 'chat', agent: who, to: 'board', text: 'Done: the badge is in.' }),
        ),
      ceo,
    );
    await page.waitForFunction(() => !document.querySelector('#intercom-count').hidden);
    assert.equal(await badge(), 1, `${where}: the reply counts`);
    // seen, not cut off by the buttons beside it: the badge's middle is the badge
    const onTop = await page.$eval('#intercom-count', b => {
      const r = b.getBoundingClientRect();
      return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });
    assert.ok(onTop, `${where}: the badge is drawn on top`);
    assert.equal(await page.getAttribute('#intercom-count', 'aria-label'), '1 new reply');
    // (the HUD's buttons around it, clipped from the page: the stage behind keeps moving)
    if (shots) {
      const r = await page.$eval('#btn-intercom', b => b.getBoundingClientRect().toJSON());
      const x = Math.max(0, r.x - 120),
        y = Math.max(0, r.y - 30);
      await page.screenshot({
        path: `${shots}/${look}-${width}.png`,
        clip: { x, y, width: Math.min(width - x, r.width + 240), height: r.height + 60 },
      });
    }

    // opening the intercom shows the reply: seen, here and on the coordinator
    await page.click('#btn-intercom');
    await page.waitForSelector('#chat li.ceo');
    await page.waitForFunction(() => document.querySelector('#intercom-count').hidden);
    assert.equal(marks.intercom, 3, `${where}: the coordinator keeps it as seen`);

    // a reload (or the board's other device) reads the same mark
    await page.goto(hq);
    await until(page, '#loading.gone');
    await page.waitForTimeout(800);
    assert.equal(await badge(), 0, `${where}: still gone after a reload`);
    assert.deepEqual(errors, [], `${where}: no errors`);
    console.log(`${where}: ok`);
    await context.close();
  }
console.log('intercom-badge-check: ok');
await browser.close();
server.close();
