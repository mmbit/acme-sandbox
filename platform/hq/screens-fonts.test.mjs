// node --test platform/hq/screens-fonts.test.mjs
// A kept kit font in the screenshot look (keptfonts.mjs fulfilFonts): HQ's page asks Google Fonts for Pixelify Sans
// and gets the kit's file, at an address HQ's CSP lets it load, so the screen is shot in Pixelify, not a fallback
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launched, openPage } from '../../shared/browser/browser.mjs';

import { fulfilFonts, keptFonts } from './keptfonts.mjs';
// A kits folder of the test's own that keeps a Pixelify Sans (the Notebook's Caveat under its name: the page needs a
// real font file, not Pixelify's glyphs), so it passes at a company whose kits keep none, and with no way out to
// Google
const KITS = mkdtempSync(join(tmpdir(), 'screens-fonts-kits-'));
mkdirSync(join(KITS, 'pixel', 'fonts'), { recursive: true });
copyFileSync(
  new URL('shell/ink/fonts/caveat-latin.woff2', import.meta.url),
  join(KITS, 'pixel', 'fonts', 'pixelify-sans.woff2'),
);
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
