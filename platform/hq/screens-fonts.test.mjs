// node --test platform/hq/screens-fonts.test.mjs
// A kept kit font in the screenshot look (screens-shots.mjs fulfilFonts): HQ's page asks Google Fonts for Pixelify Sans
// and gets the kit's file, at an address HQ's CSP lets it load, so the screen is shot in Pixelify, not a fallback
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launched, openPage } from '../../shared/browser/browser.mjs';

process.env.HQ_RENDER_CHILD = '1'; // (the harness it imports runs here, never sent on to the render helper)
const { fulfilFonts, keptFonts } = await import('./screens-shots.mjs');
const KITS = new URL('../../kits', import.meta.url).pathname;
// (HQ's font and style sources, csp() in platform/coordinator/src/pages.ts)
const CSP =
  "default-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline';" +
  " font-src 'self' https://fonts.gstatic.com";
const PAGE = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@400..700&display=swap">
<p style="font-family: 'Pixelify Sans', monospace">Brownstone</p>`;

const browser = await launched();
const noChromium = browser ? false : 'no Playwright or no Chromium for it here';
test.after(() => browser?.close());

test(
  "Brownstone's Google Fonts request gets the kit's Pixelify, which HQ's CSP loads",
  { skip: noChromium },
  async () => {
    const { context, page } = await openPage(browser);
    const side = { fonts: mkdtempSync(join(tmpdir(), 'screens-fonts-')) },
      kept = keptFonts(KITS),
      unfetched = [];
    await context.route('http://hq.test/', route =>
      route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': CSP }, body: PAGE }),
    );
    await context.route(/fonts\.(googleapis|gstatic)\.com/, route => fulfilFonts(route, side, kept, unfetched));
    const refused = [];
    page.on('console', message => message.type() === 'error' && refused.push(message.text()));
    await page.goto('http://hq.test/');
    const loaded = await page.evaluate(async () =>
      (await document.fonts.load("16px 'Pixelify Sans'")).map(face => face.status),
    );
    assert.deepEqual(loaded, ['loaded']);
    assert.deepEqual(refused, []);
    assert.deepEqual(unfetched, []);
    await context.close();
  },
);
