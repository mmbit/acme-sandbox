// book-check.mjs's story of a call's notes page in the board's hands on its iPad (shell/ink/bookunits.js,
// bookunitcards.js, bookgroups.css; the store's stacking, notebookstack.js), by hand at 1133 × 744 and 744 × 1133 with
// the Pencil and fingers in either engine (hands.mjs): a call's scraps, a tall crop among them, read as separate
// pieces, each card holding its picture and words with room before the next, none cut at the paper's edge, the tall
// crop no taller than the cap; the board opens a scrap with a finger, writes its words longer there, puts it back, and
// its card still keeps clear of the next. A note the agent adds while the page is idle is scrolled to and pops in; one whose slide a scroll stops on the
// way shows at once; one added while the Pencil is down moves nothing.
import assert from 'node:assert/strict';
import { MINI, UPRIGHT, closeScrap, openScrap, until } from './kit.mjs';
import { mini } from './start.mjs';
import { TALL_WORDS, callSeed, fillCall } from './notespage.mjs';
import { TALL } from '../shell/ink/notebookstack.js';

// c: book-check.mjs's { hqIn, base, shot, settled, noErrorsIn }
export const notesScrapsStories = c => ({
  "a call's notes page by hand on the board's iPad: scraps read apart, a tall crop capped, a new note shown (landscape)":
    browser => apart(browser, c, MINI, 'landscape'),
  "a call's notes page by hand on the board's iPad: scraps read apart, a tall crop capped, a new note shown (portrait)":
    browser => apart(browser, c, UPRIGHT, 'portrait'),
  "a call's notes page on the desktop: every scrap's tape whole at first paint and after a scroll": browser =>
    tapeOnDesktop(browser, c),
});

// At the desktop, the page laid wider: only the tape
async function tapeOnDesktop(browser, c) {
  const viewport = { width: 1440, height: 900 },
    s = await mini(browser, c, { viewport, notebooks: callSeed(new Date().toISOString()), hasTouch: false });
  try {
    await fillCall(s.page, s.page.context().notebook, viewport, { tall: true });
    await s.page.waitForFunction(() => document.querySelectorAll('[data-page="9101"] .bk-words').length === 13, null, {
      timeout: 30_000,
    });
    await s.page.waitForTimeout(1500);
    await c.shot('book-notes-tape-desktop', s.page);
    await tapeWhole(s.page, 'at the desktop');
    await s.page.mouse.move(viewport.width / 2, viewport.height / 2);
    await s.page.mouse.wheel(0, 300);
    await s.page.waitForTimeout(600);
    await tapeWhole(s.page, 'at the desktop after a scroll');
    c.noErrorsIn(s.errors);
  } finally {
    await s.done();
  }
}

async function apart(browser, c, viewport, held) {
  const s = await mini(browser, c, { viewport, notebooks: callSeed(new Date().toISOString()) });
  try {
    const store = s.page.context().notebook,
      put = words =>
        store.route(
          '/api/notebooks/groups/scrap',
          {},
          { anchor: ANCHOR(viewport), said: 'typed', words, owner: 'juno' },
        );
    await laidApart(s.page, c, store, viewport, held);
    await stoppedOnTheWay(s, put);
    await shown(s, c, put, held);
    await written(s, c, held);
    c.noErrorsIn(s.errors);
  } finally {
    await s.done();
  }
}
// The call's scraps, a tall crop among them: cards apart and whole, the crop at the cap
async function laidApart(page, c, store, viewport, held) {
  await fillCall(page, store, viewport, { tall: true });
  await page.waitForFunction(() => document.querySelectorAll('[data-page="9101"] .bk-words').length === 13, null, {
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
  await c.shot(`book-notes-apart-${held}`, page);
  readApart(await cards(page), 'as the call left them');
  await tapeWhole(page, 'at first paint');
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(600);
  await tapeWhole(page, 'after a scroll');
  await page.mouse.wheel(0, -300);
  const tall = store.route('/api/notebooks/pages/groups', { page: 9101 }).groups.find(g => g.words === TALL_WORDS);
  assert.ok(tall.pictures[0].h <= TALL.h, `the tall crop no taller than the cap: ${tall.pictures[0].h}`);
}
// The agent's next note on the idle page slid into sight and landing; one while the Pencil is down moves nothing
async function shown({ page, pen }, c, put, held) {
  await page.waitForTimeout(3500);
  await page.evaluate(watchLanding, SHOWN);
  put(SHOWN);
  await until(() => page.evaluate(inSight, SHOWN), 'the new note slid into sight');
  assert.ok(await page.evaluate(() => window.landed), 'the new note pops in');
  await page.waitForTimeout(800);
  await c.shot(`book-notes-apart-${held}-shown`, page);
  const paper = await page.locator('#book .bk-desk').boundingBox(),
    at = [paper.x + paper.width / 2, paper.y + paper.height / 2];
  await pen.down(at);
  const still = await page.evaluate(placeOf, SHOWN);
  put(HELD);
  await until(() => page.evaluate(placeOf, HELD), 'the note put while the Pencil is down');
  await page.waitForTimeout(1200);
  assert.deepEqual(await page.evaluate(placeOf, SHOWN), still, 'nothing slides while the Pencil is down');
  // (lifted away from where it came down: no tap, which would open a scrap or make one)
  const away = [at[0] + 40, at[1]];
  await pen.move(away);
  await pen.up(away);
}
// The agent's next note on the idle page, its slide into sight stopped by a scroll the moment it starts: shown at once,
// where it is, nothing of it held unseen
async function stoppedOnTheWay({ page }, put) {
  await page.waitForTimeout(3500);
  await page.evaluate(scrollWhenHeld, STOPPED);
  put(STOPPED);
  await until(() => page.evaluate(() => window.scrolled), 'the scroll as the note slides in');
  await page.waitForTimeout(1000);
  assert.deepEqual(await page.evaluate(heldOf, STOPPED), [], 'the note stopped on its way shows whole');
}
// The board writes a scrap's words in sight longer: a finger's tap on its card opens it, a tap in its words and the
// keyboard there, Klaar puts it back: every card on the grid still apart
async function written({ page, touch }, c, held) {
  const card = await wordsInSight(page);
  assert.ok(card, "a scrap's words in sight");
  const finger = { tap: at => touch.stroke([at], [at]) },
    { gid } = await openScrap(page, finger, undefined, card.at);
  assert.equal(gid, card.gid, 'the scrap tapped opened');
  const field = page.locator(`#book .bk-page[data-focus] .bk-words[data-g="${gid}"] textarea.bk-scrap-words`);
  // (Playwright's tap: a touch the browser itself focuses the field for, as a hand's touch played in the page isn't)
  await field.tap();
  await until(() => field.evaluate(f => f === document.activeElement), 'its words being typed in');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(` ${LONGER}`);
  await page.evaluate(() => document.activeElement.blur());
  await closeScrap(page, finger);
  const onCard = page.locator(`#book .bk-page:not([data-focus]) .bk-words[data-g="${gid}"] textarea.bk-scrap-words`);
  await until(async () => (await onCard.inputValue()).endsWith(LONGER), "the longer words on the scrap's card");
  await page.waitForTimeout(1500);
  await c.shot(`book-notes-apart-${held}-written`, page);
  readApart(await cards(page), 'with a scrap’s words written longer');
}
// A card on the grid whose words show on the paper, under no button, the page scrolled back up to one as
// the board would: its group and the middle of its words ({ gid, at }; null: none)
async function wordsInSight(page) {
  const paper = await page.locator('#book .bk-desk').boundingBox();
  for (let k = 0; k < 12; k++) {
    const card = await page.evaluate(() => {
      for (const t of document.querySelectorAll('[data-page="9101"] .bk-words textarea')) {
        const r = t.getBoundingClientRect(),
          at = [r.x + r.width / 2, r.y + r.height / 2],
          hit = document.elementFromPoint(...at);
        if (r.height && hit?.closest('#book .bk-page:not([data-focus])') && !hit.closest('button'))
          return { gid: Number(t.closest('[data-g]').dataset.g), at };
      }
      return null;
    });
    if (card) return card;
    await page.mouse.move(paper.x + paper.width / 2, paper.y + paper.height / 2);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(400);
  }
  return null;
}

const LONGER =
    'and the price under it in the same grey as the title, with the basket a little to its right so both read as one line',
  SHOWN = 'The scraps have room between them now',
  STOPPED = 'A scroll on the way shows it at once',
  HELD = 'Nothing moves while the board writes';
const ANCHOR = viewport => ({
  v: 1,
  url: '/',
  el: null,
  view: { x: 0, y: 0, w: viewport.width, h: viewport.height, dpr: 1 },
  ink: [],
});

// Nothing a unit's canvas paints is cut at its edges: a scrap's tape over its top edge and its shadow show whole, before
// any stroke
async function tapeWhole(page, when) {
  const cut = await page.evaluate(() =>
    [...document.querySelectorAll('#book .bk-page:not([hidden]) .bk-ink')].flatMap(canvas => {
      const { width: w, height: h } = canvas,
        g = canvas.getContext('2d'),
        edges = [g.getImageData(0, 0, w, 1), g.getImageData(0, h - 1, w, 1), g.getImageData(0, 0, 1, h)];
      edges.push(g.getImageData(w - 1, 0, 1, h));
      const painted = edges.filter(e => e.data.some((v, i) => i % 4 === 3 && v > 8)).length;
      return painted ? [{ top: canvas.style.top, left: canvas.style.left, painted }] : [];
    }),
  );
  assert.deepEqual(cut, [], `${when}: every scrap's tape and shadow whole on its canvas`);
}
// The page's cards, their words and the paper's visible box, in CSS px
const cards = page =>
  page.evaluate(() => {
    const view = document.querySelector('#book .bk-groups[data-page="9101"]').parentElement,
      box = el => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, g: el.dataset.unit ?? el.dataset.g };
      },
      paper = document.querySelector('#book .bk-desk').getBoundingClientRect();
    return {
      units: [...view.querySelectorAll('.bk-unit')].map(box),
      words: [...view.querySelectorAll('.bk-words .bk-scrap-words')].map(el => ({
        ...box(el),
        g: el.closest('[data-g]').dataset.g,
      })),
      // (an agent's note: a post-it reaching 6 px round its words, bookgroups.css .bk-unit[data-note].
      notes: [...view.querySelectorAll('.bk-typed[data-note]')].map(el => {
        const r = el.getBoundingClientRect();
        return { x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12, g: String(el.typed?.g) };
      }),
      paper: { x: paper.left, w: paper.width },
    };
  });
// Every scrap's words inside its own card, every card in sight of the paper's sides, and cards one above the other in a
// column with space between
function readApart({ units, words, notes, paper }, when) {
  const of = new Map(units.map(u => [u.g, u]));
  for (const w of [...words, ...notes]) {
    const u = of.get(w.g);
    assert.ok(
      w.x >= u.x - 0.5 && w.x + w.w <= u.x + u.w + 0.5 && w.y + w.h <= u.y + u.h + 0.5,
      `${when}: #${w.g}'s words inside its card: ${JSON.stringify([w, u])}`,
    );
  }
  for (const u of units)
    assert.ok(
      u.x >= paper.x && u.x + u.w <= paper.x + paper.w,
      `${when}: card #${u.g} whole on the paper: ${JSON.stringify([u, paper])}`,
    );
  for (const a of units)
    for (const b of units) {
      if (a === b || b.x + b.w <= a.x || a.x + a.w <= b.x || b.y < a.y) continue;
      assert.ok(b.y - (a.y + a.h) > 0.5, `${when}: cards #${a.g} and #${b.g} apart: ${JSON.stringify([a, b])}`);
    }
}
// Where what an agent put on the page is on the screen (its words: a scrap's, or a note's typed post-it; each function
// here runs in the page, so it names them itself)
function placeOf(words) {
  const r = [...document.querySelectorAll('#book .bk-words, #book .bk-typed[data-note]')]
    .find(e => e.textContent.includes(words))
    ?.getBoundingClientRect();
  return r ? [Math.round(r.left), Math.round(r.top)] : null;
}
// Whether a scrap's words are whole on the paper shown
function inSight(words) {
  const w = [...document.querySelectorAll('#book .bk-words, #book .bk-typed[data-note]')].find(e =>
    e.textContent.includes(words),
  );
  if (!w) return false;
  const r = w.getBoundingClientRect(),
    paper = document.querySelector('#book .bk-desk').getBoundingClientRect();
  return r.top >= paper.top && r.bottom <= paper.bottom;
}
// Kept on the window as scrolled: a wheel's scroll on the paper the frame a scrap's words first show held for landing
function scrollWhenHeld(words) {
  window.scrolled = false;
  const look = () => {
    const w = [...document.querySelectorAll('#book .bk-words, #book .bk-typed[data-note]')].find(e =>
      e.textContent.includes(words),
    );
    if (!(w?.matches('.bk-landing') || w?.getAnimations().length)) return requestAnimationFrame(look);
    const desk = document.querySelector('#book .bk-desk'),
      r = desk.getBoundingClientRect();
    desk.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 120, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true }),
    );
    window.scrolled = true;
  };
  look();
}
// What of a scrap's words, and of its group on the page, is still held off it: landing, or not fully seen
function heldOf(words) {
  const w = [...document.querySelectorAll('#book .bk-words, #book .bk-typed[data-note]')].find(e =>
      e.textContent.includes(words),
    ),
    g = w?.typed?.g ?? w?.closest('[data-g]')?.dataset.g;
  if (!w) return ['its words'];
  return [w, ...document.querySelectorAll(`#book .bk-groups > [data-g="${g}"]`)]
    .filter(el => el.matches('.bk-landing') || getComputedStyle(el).opacity !== '1')
    .map(el => el.className);
}
// Kept on the window as landed: whether a scrap's words came in animated, a frame at a time till they're in sight
function watchLanding(words) {
  window.landed = false;
  const look = () => {
    const w = [...document.querySelectorAll('#book .bk-words, #book .bk-typed[data-note]')].find(e =>
      e.textContent.includes(words),
    );
    if (w?.matches('.bk-landing') || w?.getAnimations().length) window.landed = true;
    else requestAnimationFrame(look);
  };
  look();
}
