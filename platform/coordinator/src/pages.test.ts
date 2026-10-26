// node --test src/pages.test.ts: HQ's index.html as the brand makes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hqIndex } from './pages.ts';

const html = readFileSync(new URL('../../hq/index.html', import.meta.url), 'utf8');

test("index.html loads no font of its own, and the brand's goes in before HQ's stylesheet", () => {
  assert.doesNotMatch(html, /fonts\.googleapis\.com\/css/);
  assert.equal(hqIndex(html, {}), html);
  const href = 'https://fonts.googleapis.com/css2?family=Inter&display=swap';
  const page = hqIndex(html, { font: { href } });
  assert.ok(
    page.includes(`<link href="${href}" rel="stylesheet" data-brand-font>\n  <link rel="stylesheet" href="style.css">`),
  );
  assert.ok(!hqIndex(html, { font: { href: '"><script>' } }).includes('"><script>'));
});
