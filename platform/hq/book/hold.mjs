// node platform/hq/book-check.mjs --stories 'double tap held' [--webkit] [--shots dir]
// book-check.mjs's stories of a voice note at a spot (shell/ink/bookinput.js, bookvoice.js heldAt, booktape.js), at an
// iPad mini on its side and upright and a phone, with the Pencil as Safari hands it over (pointer events on what's
// under it, the same in Chromium and WebKit) and the microphone's stand-in (kit.mjs heard): on HQ's own page a pen
// held still opens no note and listens to nothing; in the book a single press held is only ink, a double tap whose
// second press moves draws, and a double tap held is the mic's voice note, its words writing themselves where it's
// held and landing there as it lifts, no ink left from it. The cog's Hold to
// talk fits on one line in every language.
import assert from 'node:assert/strict';
import { freePage, paperBox, savedWhere } from './mouse.mjs';
import { press } from './bar.mjs';
import { stillFor, stored } from './strip.mjs';
import { MINI, PREFERENCES, QUIET_MS, UPRIGHT, heard, middleOf, ui, wordsHeard } from './kit.mjs';
import { SAID } from './voice.mjs';
import { en } from '../shell/ink/notebookwordsen.js';
import { nl } from '../shell/ink/notebookwordsnl.js';
import { de } from '../shell/ink/notebookwordsde.js';

const PHONE = { width: 390, height: 844 };

// c: book-check.mjs's played store and helpers ({ hqIn, base, settled, shot, notebook, pages, posts })
export function holdStories(c) {
  return Object.fromEntries(
    [MINI, UPRIGHT, PHONE].map(viewport => [
      `a double tap held in the book is a voice note there, a press held on HQ or once in the book waits on nothing, Hold to talk on one line: at ${viewport.width} × ${viewport.height}`,
      browser => story(browser, c, viewport),
    ]),
  );
}

async function story(browser, c, viewport) {
  const free = freePage(c),
    size = `${viewport.width} × ${viewport.height}`;
  const context = await c.hqIn(browser, viewport, { hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await heard(page);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#loading.gone', { state: 'attached' });
    await page.waitForSelector('review-mode .fab', { state: 'attached' });
    await onHq(page, c, size);
    await opened(page, c, viewport);
    const paper = await paperBox(page);
    await inBook(page, c, free, paper, viewport);
    await holdToTalk(page, c, viewport.width);
    // (a made-up pointer can't be captured, as a real one can: webkit.mjs leaves it out too)
    assert.deepEqual(
      errors.filter(e => !/can not be found here|No active pointer/.test(e)),
      [],
    );
  } finally {
    await context.close();
  }
}

// On HQ's own page, outside the notebook, the microphone allowed: the Pencil held still two seconds (longer than the
// longest hold) opens no note, listens to nothing and sends nothing
async function onHq(page, c, size) {
  const at = await bareHq(page),
    from = c.posts.length;
  await pen(page, 'pointerdown', at);
  await page.waitForTimeout(2000);
  assert.equal(await page.locator(ui('.sheet')).isHidden(), true, `at ${size}, the pen held still on HQ opens no note`);
  await pen(page, 'pointerup', at);
  await page.waitForTimeout(QUIET_MS);
  assert.equal(await page.locator(ui('.sheet')).isHidden(), true, `at ${size}, nor once it lifts`);
  assert.equal(c.posts.length, from, `at ${size}, nothing goes into the Notebook from the pen held on HQ`);
}
// A point on HQ's own page with nothing there to press, clear of the book and review mode's own buttons
const bareHq = page =>
  page.evaluate(() => {
    for (let y = innerHeight * 0.8; y > innerHeight * 0.3; y -= 20)
      for (let x = 24; x < innerWidth * 0.5; x += 20) {
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest('#book, button, a, input, textarea, [data-no-ink], review-mode')) return [x, y];
      }
    throw new Error('no bare HQ to hold the pen on');
  });

// The book open: beside HQ on its side, the whole screen upright (its lip tapped)
async function opened(page, c, viewport) {
  if (viewport.width > viewport.height) {
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    return c.settled(page, 'open');
  }
  await c.settled(page, 'folded');
  await page.evaluate(() => document.querySelector('#book .bk-lip').click());
  await c.settled(page, 'spread');
}

// On the page: a single press held is a dot; a double tap whose second press moves draws its line; a double tap held
// records, the mic red and the words writing themselves where it's held as they're heard, and lifted, they land there,
// no ink left from it
async function inBook(page, c, free, paper, viewport) {
  const size = `${viewport.width} × ${viewport.height}`,
    mid = middleOf(paper),
    downAt = p => pen(page, 'pointerdown', p),
    upAt = p => pen(page, 'pointerup', p);
  await stillFor(page, [mid[0] + 40, mid[1] - 120], downAt, upAt);
  await savedWhere(c, free.id, p => p.ink.length === 1);
  // (a double tap whose second press moves draws its line, and nothing listens)
  const moving = [mid[0] - 40, mid[1] - 60],
    before = stored(c, free).ink.length;
  await doubleTap(page, moving);
  await penSteps(page, [
    ...Array.from({ length: 10 }, (_, i) => ['pointermove', [moving[0] + (i + 1) * 8, moving[1] + 2]]),
    ['pointerup', [moving[0] + 80, moving[1] + 2]],
  ]);
  const drawn = (await savedWhere(c, free.id, p => p.ink.length > before)).ink.length;
  await page.waitForTimeout(QUIET_MS);
  assert.equal(await page.locator('#book .bk-heard').count(), 0, `at ${size}, a second press that moves only draws`);
  // a double tap held, low on the paper's left, away from where words land unheld (under the line drawn last)
  const at = [paper.x + paper.width * 0.2, paper.y + paper.height * 0.7];
  await doubleTap(page, at);
  await page.locator('#book .bk-heard').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#book .bk-mic').getAttribute('data-listening'), '', `at ${size}, the mic records`);
  await wordsHeard(page);
  await c.shot(`book-voice-held-${viewport.width}`, page);
  await upAt(at);
  const kept = await savedWhere(c, free.id, p => p.texts.length === 1);
  assert.equal(kept.texts[0].text, SAID, `at ${size}, the words heard`);
  assert.equal(kept.ink.length, drawn, `at ${size}, no ink from the double tap held`);
  const box = await page.locator('#book .bk-typed').boundingBox();
  assert.ok(
    at[0] >= box.x - 24 && at[0] <= box.x + box.width && at[1] >= box.y - 8 && at[1] <= box.y + box.height,
    `at ${size}, the words land where the double tap was held: ${JSON.stringify({ at, box })}`,
  );
  await c.shot(`book-voice-landed-${viewport.width}`, page);
  await page.locator('#book .bk-heard').waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await page.locator('#book .bk-mic').getAttribute('aria-pressed'), 'false', `at ${size}, the mic let go`);
  assert.equal(stored(c, free).texts.length, 1, `at ${size}, one box of words`);
}

// The cog's card: Hold to talk on one line, in English as the board reads it and in Dutch and German too, and each
// choice on one line
async function holdToTalk(page, c, width) {
  const size = `${width} px wide`;
  await press(page, PREFERENCES);
  const card = page.getByRole('dialog', { name: PREFERENCES });
  await card.waitFor();
  await card.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished))); // (come to rest, as the board sees it)
  const lines = await card.evaluate(
    (el, words) => {
      // (the lines each run of words in it takes: an input or a small beside them sits on their line)
      const linesOf = node => {
        const runs = document.createTreeWalker(node, NodeFilter.SHOW_TEXT),
          range = document.createRange();
        let most = 0;
        for (let t = runs.nextNode(); t; t = runs.nextNode()) {
          if (!t.textContent.trim()) continue;
          range.selectNodeContents(t);
          const bottoms = [...range.getClientRects()].filter(r => r.width).map(r => Math.round(r.bottom));
          most = Math.max(most, new Set(bottoms).size);
        }
        return most;
      };
      const legend = el.querySelector('legend'),
        said = legend.textContent;
      const counts = words.map(w => {
        legend.textContent = w;
        return [w, linesOf(legend)];
      });
      legend.textContent = said;
      return [...counts, ...[...el.querySelectorAll('fieldset label')].map(l => [l.textContent.trim(), linesOf(l)])];
    },
    [en.voiceHold, nl.voiceHold, de.voiceHold],
  );
  for (const [said, n] of lines) assert.equal(n, 1, `at ${size}, "${said}" on one line`);
  await c.shot(`book-hold-to-talk-${width}`, page);
  await page.keyboard.press('Escape');
}

// ---- helpers

// Pointer events as Safari hands over the Pencil's (pointerId 7, as webkit.mjs's), each on what's at its point,
// one after another in the page: steps [type, [x, y]]
const penSteps = (page, steps) =>
  page.evaluate(steps => {
    for (const [type, [x, y]] of steps)
      (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
        new PointerEvent(type, {
          ...{ pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: x, clientY: y },
          ...{ pressure: type === 'pointerup' ? 0 : 0.5, buttons: type === 'pointerup' ? 0 : 1 },
          ...{ bubbles: true, composed: true, cancelable: true },
        }),
      );
  }, steps);
const pen = (page, type, at) => penSteps(page, [[type, at]]);
// A tap and a double tap's second press, the second left down. (sent at once: the helper's page runs its timers
// hundreds of ms late, which would make a tap of a 60 ms press)
const doubleTap = (page, at) =>
  penSteps(page, [
    ['pointerdown', at],
    ['pointerup', at],
    ['pointerdown', at],
  ]);
