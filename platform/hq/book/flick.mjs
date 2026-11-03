// book-check.mjs's story of a finger's flick on the Notebook's page always gliding on, on an iPad mini at 1133 × 744
// and 744 × 1133 (--stories "always glides on" --webkit: Safari's engine, whose clocks tell whole ms): a call's notes
// page of scraps, a pen used on this iPad first (so a finger pans: prefs.js penUsed), then 16 flicks each way round,
// half begun on a scrap's words and half on bare paper, each lifted a ms later after a frame (so at every ms of one),
// every other pair with the page kept busy 40 ms after the lift. Each glides on well past where the finger lifted. A
// tap on a scrap's words still puts the caret in them, and a finger held still on bare paper brings no Paste bubble.
import assert from 'node:assert/strict';
import { MINI, UPRIGHT, until } from './kit.mjs';
import { restsOpen, watchedPage } from './start.mjs';
import { callSeed, fillCall } from './notespage.mjs';

// flicks each way round; how far past the lift a glide goes at the least (screen px; a flick's own speed carries it
// over a thousand, the page's end allowing)
const FLICKS = 16,
  GLIDES_PX = 120;

// c: book-check.mjs's { hqIn, base, settled, shot, noErrorsIn }
export const flickStories = c => ({
  'a flick on the notebook always glides on, from paper and from a scrap’s words (iPad mini on its side)': browser =>
    flicks(browser, c, MINI, 'landscape'),
  'a flick on the notebook always glides on, from paper and from a scrap’s words (iPad mini upright)': browser =>
    flicks(browser, c, UPRIGHT, 'portrait'),
});

async function flicks(browser, c, viewport, held) {
  const { context, page, errors } = await opened(browser, c, viewport);
  try {
    for (let k = 0; k < FLICKS; k++) await glides(page, held, k);
    await c.shot(`book-flick-${held}`, page);
    // (a tap on a scrap's words is still theirs: the caret in them)
    const words = await wordsInSight(page);
    await page.touchscreen.tap(...words.at);
    await until(
      () => page.evaluate(() => document.activeElement?.matches('.bk-words textarea')),
      "the caret in the scrap's words",
      5000,
    );
    // (a finger held still on bare paper brings nothing: Paste is Select's tap, bookselect.js)
    const paper = await page.evaluate(startOn, 'paper');
    assert.ok(!(await page.evaluate(offersPaste, paper)), 'a hold on paper offers no Paste');
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`book-flick-${held}-failed`, page);
    throw e;
  } finally {
    await context.close();
  }
}
// HQ on the iPad mini held this way, a pen used on it before (so a finger pans, as on the board's iPad), the book open
// on a call's notes page filled with scraps
async function opened(browser, c, viewport) {
  const context = await c.hqIn(browser, viewport, {
    hasTouch: true,
    deviceScaleFactor: 1,
    notebooks: callSeed(new Date().toISOString()),
  });
  await context.addInitScript(() => {
    localStorage.setItem('ink.prefs', JSON.stringify({ penSeen: true, penPans: true }));
    // (the call page's top on the screen, which restOf and flick read)
    window.viewTop = () =>
      document.querySelector('#book .bk-groups[data-page="9101"]').parentElement.getBoundingClientRect().top;
  });
  const { page, errors } = await watchedPage(context);
  await page.goto(`${c.base}/?intro=0`);
  await restsOpen(page, c, viewport);
  await fillCall(page, context.notebook, viewport, { tall: true });
  await page.waitForFunction(() => document.querySelectorAll('[data-page="9101"] .bk-words').length === 13, null, {
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
  return { context, page, errors };
}
// The k-th flick, from a scrap's words (odd k) or bare paper, begun k ms after a frame and busy after every other pair:
// it glides on well past the lift, the page's end allowing
async function glides(page, held, k) {
  const on = k % 2 ? 'words' : 'paper',
    busy = k % 4 > 1,
    from = await page.evaluate(startOn, on);
  assert.ok(from.at, `a place to flick from on ${on}, in sight: ${JSON.stringify(from)}`);
  const lifted = await page.evaluate(flick, { ...from, ms: k, busy }),
    rest = await restOf(page),
    went = Math.abs(rest - lifted.top);
  assert.ok(
    went >= Math.min(GLIDES_PX, from.room * 0.8),
    `flick ${k + 1} (${held}, from ${on}, ${k} ms after a frame${busy ? ', busy' : ''}) glides on: ` +
      `${went} px past the lift, ${JSON.stringify({ from, lifted, rest })}`,
  );
}
// A scrap's words in sight to tap and hold on: the page flicked back up from bare paper while none show (flicked to
// its end, the screen is nearly all empty page under the last note, bookview.js FOOT_SHOWN.)
async function wordsInSight(page) {
  for (let k = 0; k < 8; k++) {
    const words = await page.evaluate(startOn, 'words');
    if (words.at) return words;
    await page.evaluate(flick, { ...(await page.evaluate(startOn, 'paper')), ms: 0, busy: false });
    await restOf(page);
  }
  assert.fail("a scrap's words in sight, the page flicked back up to them");
}
// The page at rest after a glide: the call page's top on the screen once ten frames in a row leave it where it was
// (counted in frames, not time: headless WebKit's come a third of a second apart at times, which a clock would take
// for the glide's end)
const restOf = page =>
  page.evaluate(async () => {
    let was = window.viewTop(),
      still = 0;
    for (let k = 0; k < 2000 && still < 10; k++) {
      await new Promise(r => requestAnimationFrame(r));
      const now = window.viewTop();
      still = Math.abs(now - was) < 0.5 ? still + 1 : 0;
      was = now;
    }
    return was;
  });

// (each function below runs in the page, so it names what it reads itself)
// Where a flick begins, on a scrap's words or on bare paper, in the paper's middle band: { at: [x, y] (null: none in
// sight), dir (the finger's way, -1 up: the page on down), room (how far the page can go that way, screen px) }
function startOn(on) {
  const desk = document.querySelector('#book .bk-desk').getBoundingClientRect(),
    view = document.querySelector('#book .bk-groups[data-page="9101"]').parentElement.getBoundingClientRect();
  // (the way with more page to go)
  const down = view.bottom - desk.bottom,
    up = desk.top - view.top,
    dir = down >= up ? -1 : 1;
  // (room for the finger's 150 px its way)
  const band = y => (dir < 0 ? y > desk.top + 190 && y < desk.bottom - 30 : y > desk.top + 30 && y < desk.bottom - 190),
    clear = el =>
      el &&
      document.querySelector('#book .bk-desk').contains(el) &&
      !el.closest('.bk-unit, .bk-words, .bk-under, .bk-typed, button, a, label, select, textarea, input');
  let at = null;
  if (on === 'words')
    for (const f of document.querySelectorAll('#book [data-page="9101"] .bk-words .bk-scrap-words')) {
      const r = f.getBoundingClientRect(),
        x = r.left + r.width / 2;
      // (any row of its words in the band)
      for (let y = r.top + 6; y < r.bottom - 6 && !at; y += 8)
        if (band(y) && x > desk.left && x < desk.right && document.elementFromPoint(x, y)?.closest('.bk-words'))
          at = [x, y];
    }
  else
    for (let y = desk.top + 60; y < desk.bottom - 60 && !at; y += 12)
      for (let x = desk.left + 20; x < desk.right - 20 && !at; x += 12)
        if (band(y) && clear(document.elementFromPoint(x, y))) at = [x, y];
  return { at, dir, room: dir < 0 ? down : up };
}
// A finger's flick as Safari hands it over (pointer events on what's under it), begun ms after a frame, then the page
// kept busy 40 ms (busy): fast moves, 150 px in 24 ms, its lift with them. Returns the page's top as it lifted (and
// before, whether the pan took the press, and what the finger was on: for a failure's words).
async function flick({ at: [x, y], dir, ms, busy }) {
  const el = document.elementFromPoint(x, y),
    wait = t => {
      for (const end = performance.now() + t; performance.now() < end;);
    },
    fire = (type, dy) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 11,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: y + dy,
          pressure: type === 'pointerup' ? 0 : 0.5,
          buttons: type === 'pointerup' ? 0 : 1,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
  const before = window.viewTop();
  fire('pointerdown', 0);
  const pan = document.querySelector('#book .bk-desk').dataset.pan;
  await new Promise(r => requestAnimationFrame(r));
  wait(ms);
  for (let i = 1; i <= 4; i++) {
    wait(6);
    fire('pointermove', dir * 30 * i);
  }
  fire('pointermove', dir * 150);
  const top = window.viewTop();
  fire('pointerup', dir * 150);
  if (busy) wait(40);
  return { top, before, pan, on: `${el.tagName}.${el.className}` };
}
// A finger held still a second where a flick would begin, then lifted: whether a Paste bubble came
async function offersPaste({ at: [x, y] }) {
  const el = document.elementFromPoint(x, y),
    fire = type =>
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 12,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: y,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
  fire('pointerdown');
  await new Promise(r => setTimeout(r, 1000));
  const offered = !!document.querySelector('#book .bk-paste');
  fire('pointerup');
  return offered;
}
