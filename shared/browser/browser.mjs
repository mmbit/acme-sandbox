// Playwright for the browser checks: the module wherever it's installed, a page that keeps its errors, a tap, a wait and
// a sound player's loudness.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// where Playwright's images keep their browsers: a run on a lent machine keeps none of its image's environment
const BROWSERS = '/ms-playwright';

// Playwright (chromium, webkit, devices): the repo's own copy if it has one, else the global one npm installed.
export function playwright() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(BROWSERS)) process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS;
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    const globalRoot = execFileSync('npm', ['root', '-g']).toString().trim();
    return createRequire(join(globalRoot, '/'))('playwright');
  }
}

// A page in a context of its own (options as newContext's), with service workers blocked and Google Fonts answered
// empty, so every run lays out in the same fallback font.
export async function openPage(browser, options = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', ...options });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, route =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const page = await context.newPage();
  return { context, page, errors: errorsOf(page) };
}

// The page's uncaught errors as they happen, and any dialog it opens (a page asks in its own UI, CODE_STYLE.md).
export function errorsOf(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => {
    errors.push(`a dialog opened: ${dialog.message()}`);
    dialog.dismiss();
  });
  return errors;
}

// A click by script, for scenes whose elements never hold still for Playwright's own click.
export const tap = (page, selector) => page.evaluate(s => document.querySelector(s).click(), selector);

// Waits till the selector finds an element and, with a pattern, till its words match it in any case. It polls on a
// timer: a busy scene's frames can hold animation-frame polling back for seconds. A wait that times out fails on what
// the element read then, so the check says which wait it was.
export async function until(page, selector, pattern, timeout) {
  const reads = ([s, source]) => {
    const element = document.querySelector(s);
    return !!element && (!source || new RegExp(source, 'i').test(element.innerText.replace(/\s+/g, ' ')));
  };
  try {
    await page.waitForFunction(reads, [selector, pattern?.source], { timeout, polling: 100 });
  } catch (err) {
    if (err.name !== 'TimeoutError') throw err;
    const words = await page.evaluate(s => document.querySelector(s)?.innerText.replace(/\s+/g, ' ').trim(), selector);
    if (words === undefined) assert.fail(`${selector} never appeared`);
    assert.fail(`${selector} never read ${pattern}: "${words}"`);
  }
}

// A sound player's loudness in Chromium: puts an analyser on window.sfx's output (as window.__an, which a check may
// swap) and returns a measure of it, the loudest RMS over 400 ms in dBFS, to run beside what makes the sound.
export async function listenTo(page) {
  await page.evaluate(() => {
    const analyser = (window.__an = window.sfx.context.createAnalyser());
    analyser.fftSize = 2048;
    window.sfx.output.connect(analyser);
  });
  return () => page.evaluate(loudestOver400Ms);
}

// Runs in the page (page.evaluate sends its source), so it finds the analyser on window.
const loudestOver400Ms = () =>
  new Promise(done => {
    const analyser = window.__an;
    const samples = new Float32Array(analyser.fftSize);
    const started = performance.now();
    let loudest = 0;
    const listen = () => {
      analyser.getFloatTimeDomainData(samples);
      const power = samples.reduce((sum, x) => sum + x * x, 0) / samples.length;
      loudest = Math.max(loudest, Math.sqrt(power));
      if (performance.now() - started < 400) setTimeout(listen, 10);
      else done(20 * Math.log10(loudest + 1e-9));
    };
    listen();
  });
