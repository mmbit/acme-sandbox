// book-check.mjs's story of rule zero (the board's, 2026-10-27): nothing stays drawn on HQ, held like an iPad mini, on
// book-check's played store (shared/review/marks.js paint: the page's ink layer holds only the mark being made).
// A ring drawn round the computer's Mail shows while it's made; once its note is in the book (saved) the page is clean
// at once, its lines only in the note's snip. A ring scribbled out (cancelled) goes as well, and no note is made. Notes
// kept from before, with their lines in the store, show nowhere. Sending the sheet, reloading and another tab bring
// nothing back. nothingDrawn is the assertion, shared with the pairing's and the call's stories (bookpair.mjs,
// bookcall.mjs).
import assert from 'node:assert/strict';
import { savedScrap } from './bookscrap.mjs';
import { pressAlong, ui } from './bookkit.mjs';

const RING = { x: 248, y: 305, rx: 70, ry: 50 },
  ON_RING = [RING.x + RING.rx, RING.y];
// (the ink lifting into the book: lift.js's flight, then gone)
const LIFT_MS = 900;
// (a lift in flight by its own clock let land, however late the machine draws its frames: headless WebKit on a helper
// with no GPU composites on the CPU, and a fresh run, with no shader cache yet, held a page's frames ~0.9 s as the
// first lift took off. A lift still there this long after is one that never lands.)
const LANDS_MS = 5000;

// c: book-check's { browser, hqIn, base, MINI, settled, ring, inkAt, notes, org, posts, shot, noErrorsIn }, and
// look ('&renderer=wire' for Wire)
export async function inkStory(c) {
  const before = keptNotes(c),
    context = await c.hqIn(c.browser, c.MINI),
    errors = [],
    from = c.notes.length;
  try {
    const a = await tab(c, context, errors);
    await nothingDrawn(a.page, 'HQ opened, with notes kept from before');
    await saved(c, a);
    await cancelled(c, a);
    const b = await tab(c, context, errors);
    await show(b.page, 'computer');
    await nothingDrawn(b.page, 'another tab, on the same screen');
    await a.page.reload();
    await a.page.waitForSelector('#loading.gone');
    await c.settled(a.page, 'open');
    await show(a.page, 'computer');
    await nothingDrawn(a.page, 'reloaded');
    c.noErrorsIn(errors);
  } finally {
    c.notes.splice(from);
    for (const n of before) c.notes.splice(c.notes.indexOf(n), 1);
    await context.close();
  }
}

// Nothing drawn over the page: review mode's ink layers blank to the last pixel, a second screen's ink blank, no ring
// or pointer of a call's agent, nothing lifting into the book. Read from the layers themselves, never a guess at what's
// on them; waits up to `within` ms for a lift in flight to land. A lift is held to its own clock: a flight of at most
// LIFT_MS by its animations' timing, waited for while it's flying (LANDS_MS at most), never the machine's frames.
export async function nothingDrawn(page, where, within = LIFT_MS) {
  const left = () =>
    page.evaluate(within => {
      const inked = c => {
        if (!c.width || !c.height) return false;
        const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
        return false;
      };
      const review = document.querySelector('review-mode')?.shadowRoot;
      return [
        ...[...(review?.querySelectorAll('.ui > canvas') ?? [])].filter(inked).map(() => 'review mode’s ink'),
        ...[...document.querySelectorAll('canvas.pair-ink')].filter(inked).map(() => 'the other screen’s ink'),
        ...[...document.querySelectorAll('[data-call-ink]')].map(() => 'a call’s ring'),
        ...[...document.querySelectorAll('.hq-pointer')].map(() => 'a call’s pointer'),
        ...[...document.querySelectorAll('review-lift')].map(l => {
          const flight = l.getAnimations();
          // (by its own clock: a frame held up can see it finished before the frame that lands it)
          const flying = flight.length && flight.every(a => a.effect.getComputedTiming().endTime <= within);
          return flying ? 'ink lifting into the book (flying)' : 'ink lifting into the book';
        }),
      ];
    }, within);
  let found = await left();
  const end = Date.now() + within,
    landed = Date.now() + LANDS_MS;
  const flying = () => found.every(f => f.endsWith('(flying)'));
  for (; found.length && Date.now() < (flying() ? landed : end); found = await left()) await page.waitForTimeout(50);
  assert.deepEqual(found, [], `${where}: nothing drawn on HQ`);
}

// Two notes kept from before rule zero, open and sent, with their lines, on the ring's own screen and place: drawn by
// nothing now
function keptNotes(c) {
  const line = Array.from({ length: 21 }, (_, i) => [RING.x - 100 + i * 10, RING.y, 0.5, i * 16]);
  const anchor = {
    v: 1,
    url: '/?intro=0',
    el: {
      selector: 'div#tool > div.device.computer',
      tag: 'div',
      text: 'Mail',
      box: { x: 150, y: 250, w: 200, h: 120 },
    },
    view: { w: 1133, h: 744, x: 0, y: 0, dpr: 2 },
    ink: [{ color: '#ff5a5f', size: 5, points: line }],
  };
  const kept = ['open', 'sent'].map((status, i) => ({
    ...{ id: 9500 + i, n: 1, page: 9500, anchor, words: `Left ${status}`, said: 'typed', by: 'board', status },
    ...{ snip: null, slips: [], created: '2026-10-25T08:10:00Z', updated: '2026-10-25T08:16:00Z' },
  }));
  c.notes.push(...kept);
  return kept;
}

// HQ in a tab of the context, its book open, its feed played: tab.feed takes the events the coordinator would publish
async function tab(c, context, errors) {
  const page = await context.newPage(),
    feed = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(`${c.base}/api/events`, r =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: `retry: 150\n\n${feed
        .splice(0)
        .map(e => `data: ${JSON.stringify(e)}\n\n`)
        .join('')}`,
    }),
  );
  await page.goto(`${c.base}/?intro=0${c.look}`);
  await page.waitForSelector('#loading.gone');
  await page.waitForSelector('review-mode .fab', { state: 'attached' }); // (away till summoned: job #20358)
  await c.settled(page, 'open');
  assert.equal(await page.evaluate(() => document.body.classList.contains('brownstone')), !c.look, 'the look');
  return { page, feed };
}

// One of HQ's screens open (the computer's home), or none: HQ's own view
async function show(page, screen) {
  await page.evaluate(async screen => {
    const desk = await import('/shell/desk.js');
    if (screen === 'computer') desk.openComputer('home');
    else desk.closeTool();
  }, screen);
  await (screen
    ? page.waitForSelector(`#tool .device.${screen}`, { state: 'visible' })
    : page.waitForSelector('#tool', { state: 'hidden' }));
  await page.waitForTimeout(400); // (its pop)
}

// A ring round the computer's Mail: drawn while it's made, and once it rests into the book (saved) the page is clean at
// once, the ring only in its note's snip
async function saved(c, { page }) {
  await show(page, 'computer');
  await nothingDrawn(page, 'the computer open, notes kept from before on it');
  const from = c.posts.length;
  await pressAlong(page, c.ring(RING.x, RING.y, RING.rx, RING.ry));
  assert.ok((await c.inkAt(page, ...ON_RING)) > 0, 'the ring shows while it’s made');
  await c.shot('book-ink-making', page);
  // (its post-it saved: a scrap in the Notebook, the page clean at once.)
  const note = await savedScrap({ page, posts: c.posts }, from, 'the ring');
  assert.ok(note?.anchor.el?.selector, 'the ring went into the book on what it was drawn round');
  assert.ok(note.snip, '...its lines in its snip');
  await c.shot('book-ink-saved', page);
}

// A ring's post-it cancelled: gone at once, and nothing goes into the book
async function cancelled(c, { page }) {
  const posted = c.posts.length;
  await pressAlong(page, c.ring(RING.x, RING.y, RING.rx, RING.ry));
  const sheet = page.locator(ui('.sheet'));
  await sheet.waitFor({ state: 'visible', timeout: 15_000 });
  await sheet.locator('[data-cancel]').dispatchEvent('click');
  await nothingDrawn(page, 'cancelled', 0);
  await page.waitForTimeout(2000); // (past a mark's settle: nothing goes)
  assert.deepEqual(
    c.posts
      .slice(posted)
      .map(p => p.path)
      .filter(p => p.startsWith('/api/book/note') || p.startsWith('/api/notebooks/groups')),
    [],
    'a cancelled ring makes no note',
  );
  await nothingDrawn(page, 'cancelled, past its settle', 0);
}
