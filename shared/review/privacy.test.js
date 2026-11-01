// node --test shared/review/privacy.test.js (requires Chromium)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launched, openPage } from '../browser/browser.mjs';
import { fulfilPart } from './parts.mjs';

const browser = await launched();
assert.ok(browser, 'Review privacy checks require Chromium');
after(() => browser.close());
const review = await readFile(new URL('./review.js', import.meta.url), 'utf8');
const origin = 'https://preview.test';

for (const attribute of ['data-private', 'data-watchalong-hide'])
  for (const placement of ['self', 'parent', 'host', 'host parent'])
    test(`${attribute} on the ${placement} keeps text out of a note label and its saved mark`, async () => {
      const { context, page, errors } = await openPage(browser, { viewport: { width: 744, height: 1133 } });
      const notes = [];
      try {
        await context.route(`${origin}/**`, route => {
          const path = new URL(route.request().url()).pathname;
          if (fulfilPart(route, path, review)) return;
          if (path === '/__review/notes') {
            notes.push(route.request().postDataJSON());
            return route.fulfill({ json: { ok: true, id: notes.length } });
          }
          if (path === '/__review/coach') return route.fulfill({ json: { show: false } });
          return route.fulfill({ contentType: 'text/html', body: fixture });
        });
        await page.goto(origin);
        await page.evaluate(
          ({ attribute, placement }) => {
            const parent = document.querySelector('main');
            const code = document.createElement('code');
            code.textContent = 'Synthetic private key for the privacy check';
            if (placement === 'self') code.setAttribute(attribute, '');
            if (placement === 'parent' || placement === 'host parent') parent.setAttribute(attribute, '');
            if (placement.startsWith('host')) {
              const host = document.createElement('key-panel');
              if (placement === 'host') host.setAttribute(attribute, '');
              const nested = document.createElement('key-value');
              host.attachShadow({ mode: 'open' }).append(nested);
              nested.attachShadow({ mode: 'open' }).append(code);
              parent.append(host);
            } else parent.append(code);
          },
          { attribute, placement },
        );
        const target = await page.locator('code').boundingBox();
        await page.locator('review-mode .fab').click({ force: true });
        await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
        await page.locator('review-mode .sheet').waitFor({ state: 'visible' });
        assert.equal(await page.locator('review-mode .chip').textContent(), '<code>');
        await page.locator('review-mode textarea').fill('Check this panel');
        await Promise.all([
          page.waitForResponse(`${origin}/__review/notes`),
          page.locator('review-mode .send').click(),
        ]);
        assert.equal(notes[0].element.el.text, '');
        assert.equal(notes[0].element.html, '');
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

const fixture = `<!doctype html><meta name="viewport" content="width=device-width"><title>Privacy check</title>
  <style>main { margin: 200px 40px; } code { font: 16px monospace; }</style><main></main>
  <script src="/__review/review.js" defer></script>`;
