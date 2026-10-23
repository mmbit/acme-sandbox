#!/usr/bin/env node
// node platform/hq/seatwarning-check.mjs: warning links open Settings > Seats on load and on a worker message.
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const server = await serve(undefined, 0);
const base = `http://localhost:${server.address().port}`;
const browser = await playwright().chromium.launch();
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    const { context, page, errors } = await openPage(browser, { viewport });
    try {
      await page.goto(`${base}/?intro=0&renderer=wire&open=settings`);
      await page.waitForSelector('.seats-app .seats');
      assert.equal(new URL(page.url()).searchParams.has('open'), false);
      assert.match(await page.textContent('.computer header b'), /Settings.*Seats/);
      await page.goto(`${base}/?intro=0&renderer=wire`);
      await page.waitForSelector('#loading.gone');
      await page.evaluate(() =>
        navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { open: 'settings' } })),
      );
      await page.waitForSelector('.seats-app .seats');
      assert.match(await page.textContent('.computer header b'), /Settings.*Seats/);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log('seatwarning-check: URL and worker message open Seats at phone and desktop sizes');
} finally {
  await browser.close();
  server.close();
}
