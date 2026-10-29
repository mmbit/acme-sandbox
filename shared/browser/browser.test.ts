// node --test shared/browser/browser.test.ts (requires Chromium, intentionally crashes one isolated page).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { errorsOf, launched } from './browser.mjs';

test('a real Chromium renderer crash makes the check fail', { timeout: 30_000 }, async context => {
  const browser = await launched({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  assert.ok(browser, 'this regression requires Chromium');
  context.after(() => browser.close());
  const page = await browser.newPage();
  const errors = errorsOf(page);
  const session = await page.context().newCDPSession(page);
  const crashed = once(page, 'crash');
  // Chromium intentionally closes the DevTools command's target, so that command may reject after the event.
  void session.send('Page.crash').catch(() => {});
  await crashed;
  assert.ok(errors.includes('Browser page crashed'));
});
