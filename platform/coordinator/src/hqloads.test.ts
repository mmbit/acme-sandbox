// node --test src/hqloads.test.ts
// HQ's page as the board's browser gets it: through the coordinator itself, signed in, in each look HQ ships. It fails
// on a page error, a script or stylesheet the page asks for and doesn't get, or the loading veil still up. HQ's own
// browser checks (platform/hq/*-check.mjs) run on the dev server, whose routes aren't these, and the push tests run
// only test files: this is the one push test that loads the page (27 October: a module importing a name its target no
// longer exported, and a redirect that sent a file still in place to a 404, each broke HQ past every check).
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { harness } from './harness.ts';

// HQ's own address (config.ts ORIGIN, from PORT): review mode's parts go to the board on HQ's host alone
// (feedback.ts reviewerOn), so the page loads there, through a door that hands each request on to the harness's server
// as it came, its host kept. One the harness's server cuts off as the test ends cuts off its asker too
const door = createServer((req, res) => {
  const onward = request(h.base + req.url, { method: req.method, headers: req.headers, agent: false }, answer => {
    res.writeHead(answer.statusCode!, answer.headers);
    answer.pipe(res);
  });
  onward.on('error', () => res.destroy());
  req.pipe(onward);
}).listen(0);
await new Promise(r => door.once('listening', r));
const hq = `http://localhost:${(door.address() as AddressInfo).port}`;

const h = await harness('hqloads', { env: { PORT: hq.split(':')[2] } });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookNames } from '../../hq/looks.mjs';
import { launched, openPage } from '../../../shared/browser/browser.mjs';

const ASSEMBLED_MS = 20_000;
type Asked = { url(): string; resourceType(): string };
// The push checks require Chromium on both the worker and the tests helper.
const browser = await launched();
assert.ok(browser, 'HQ load checks require Playwright and Chromium');
test.after(async () => {
  await browser?.close();
  // (HQ's event stream stays open, through the door and on the server)
  door.closeAllConnections();
  door.close();
  h.server?.closeAllConnections();
});

for (const look of lookNames())
  test(`HQ loads whole for the board in ${look}: no page error, every script and stylesheet, the veil gone`, async () => {
    const { context, page, errors } = await openPage(browser, { viewport: { width: 1400, height: 900 } });
    await context.addCookies([{ name: 's', value: h.boardCookie.slice(2), url: hq }]);
    const refused: string[] = [];
    const asked = (type: string) => type === 'script' || type === 'stylesheet';
    page.on('requestfailed', (r: Asked) => asked(r.resourceType()) && refused.push(`${r.url()} failed`));
    page.on('response', (r: { url(): string; status(): number; request(): Asked }) => {
      if (asked(r.request().resourceType()) && r.status() >= 400) refused.push(`${r.url()}: ${r.status()}`);
    });
    await page.goto(`${hq}/?renderer=${look}`);
    const assembled = await page.waitForFunction(unveiled, null, { timeout: ASSEMBLED_MS, polling: 100 }).then(
      () => true,
      () => false,
    );
    assert.deepEqual([...errors, ...refused], [], `HQ in ${look}`);
    assert.ok(assembled, `HQ in ${look} still says "Assembling the building" after ${ASSEMBLED_MS / 1000} s`);
    await context.close();
  });

// (in the page, whole: it's sent there) whether HQ's loading veil is gone: its words faded out or not on screen
function unveiled() {
  const shown = (el: Element | null): boolean =>
    !el || (Number(getComputedStyle(el).opacity) > 0.05 && shown(el.parentElement));
  return ![...document.querySelectorAll('body *')].some(
    el => el.childElementCount === 0 && /Assembling the building/.test(el.textContent ?? '') && shown(el),
  );
}
