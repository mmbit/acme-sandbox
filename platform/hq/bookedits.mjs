// book-check.mjs's stories of handwriting's words edited with the pen (shared/review/penwords.js, shell/ink/bookamend.js):
// on a desktop with a mouse and on an iPad mini with the Pencil, a box of words on a page has a word struck out (gone
// from what the board sees and from what the store keeps, no ink left), Undo brings it back, and a slice between two
// words opens them where new words go: typed on the desktop, written on the iPad and read by the handwriting reader
// (played here). And a scrap's post-it words under it on an open page have a word struck out with the Pencil, saved to
// its group. (the scrap's words: job #20856)
import assert from 'node:assert/strict';
import { freePage, onDesk, savedWhere } from './bookmouse.mjs';

const MINI = { width: 1133, height: 744 };
const WORDS = 'Order the teal mugs today';
// where a scrap was cut, and its picture (a pixel of paper)
const ANCHOR = { v: 1, url: 'https://hq.example/', el: null, view: { x: 0, y: 0, w: 1200, h: 800, dpr: 1 }, ink: [] };
const SNIP =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';

// c: book-check.mjs's played store and helpers, as mouseStories gets them
export function editStories(c) {
  return {
    'with a mouse: a word struck out, Undo bringing it back, a slice typed into': browser => withMouse(browser, c),
    'with the Pencil: a word struck out, Undo bringing it back, a slice written into and read': browser =>
      withPencil(browser, c),
    "with the Pencil: a word of a scrap's words struck out, saved to its group": browser => scrapStruck(browser, c),
    "with a mouse: a scrap's words typed with a space at their end, saved, another screen's words after them kept":
      browser => scrapTyped(browser, c),
    "a gap closed while its writing is read: what waits on it has the words, and a reset's drop puts none in":
      browser => gapClosed(browser, c),
    'a gap closed as its pen writes: the close waits for every reading, and a line lifted after it is never read':
      browser => lateLine(browser, c),
  };
}

// ---- the stories

async function withMouse(browser, c) {
  const free = wordsPage(c);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    // a drag along the middle of "teal", from inside the box: struck out, no ink
    await drag(page, along(await wordBox(page, 'teal')));
    const struck = await savedWhere(c, free.id, p => p.texts[0]?.text === 'Order the mugs today');
    assert.equal(struck.ink.length, 0, 'the strike left no ink');
    assert.equal(await shownWords(page), 'Order the mugs today', 'the board sees the word go');
    await c.shot('book-edits-mouse-struck', page);
    await page.keyboard.press('Control+z');
    await savedWhere(c, free.id, p => p.texts[0]?.text === WORDS);
    assert.equal(await shownWords(page), WORDS, 'Undo brings the word back');
    // a drag down between "teal" and "mugs", from the paper above: the caret there, the words opened
    await drag(page, down(await wordBox(page, 'teal'), await wordBox(page, 'mugs')));
    await until(() => opened(page), 3000, 'the words opened with the caret in the gap');
    await c.shot('book-edits-mouse-sliced', page);
    await page.keyboard.type('blue');
    await page.keyboard.press('Escape');
    const typed = await savedWhere(c, free.id, p => p.texts[0]?.text === 'Order the teal blue mugs today');
    assert.equal(typed.ink.length, 0, 'the slice left no ink');
    c.noErrorsIn(errors);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

async function withPencil(browser, c) {
  const free = wordsPage(c);
  const context = await c.hqIn(browser, MINI, { hasTouch: true });
  const page = await context.newPage(),
    errors = [],
    inks = [];
  page.on('pageerror', e => errors.push(e.message));
  // (the handwriting reader: whatever's written reads as "blue")
  await page.route('**/api/book/read', r => {
    inks.push(r.request().postDataJSON().ink);
    return r.fulfill({ json: { writing: true, words: 'blue' } });
  });
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    await c.settled(page, 'open');
    await pen(page, along(await wordBox(page, 'teal')));
    const struck = await savedWhere(c, free.id, p => p.texts[0]?.text === 'Order the mugs today');
    assert.equal(struck.ink.length, 0, 'the strike left no ink');
    assert.equal(await shownWords(page), 'Order the mugs today', 'the board sees the word go');
    await page.locator('#book').getByRole('button', { name: 'Undo' }).first().tap();
    await savedWhere(c, free.id, p => p.texts[0]?.text === WORDS);
    assert.equal(await shownWords(page), WORDS, 'Undo brings the word back');
    // a slice between "teal" and "mugs": a gap there, and a word written in it read and put in
    const [teal, mugs] = [await wordBox(page, 'teal'), await wordBox(page, 'mugs')];
    await pen(page, down(teal, mugs));
    await until(() => opened(page), 3000, 'the words opened with a gap');
    const gap = await page.evaluate(() => {
      const r = document.querySelector('#book .bk-typed span[style*="inline-block"]').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await pen(page, scrawl(gap));
    await c.shot('book-edits-pencil-written', page);
    const written = await savedWhere(c, free.id, p => p.texts[0]?.text === 'Order the teal blue mugs today');
    assert.equal(written.ink.length, 0, 'what was written went into the words, not the page');
    assert.equal(inks.length, 1, 'one reading of what was written');
    // a tap elsewhere closes the gap; Undo takes the words written back out
    await page.locator('#book').getByRole('button', { name: 'Undo' }).first().tap();
    await until(async () => !(await opened(page)), 3000, 'the gap closed by a tap elsewhere');
    await savedWhere(c, free.id, p => p.texts[0]?.text === WORDS);
    c.noErrorsIn(errors);
  } finally {
    await context.close();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

// A post-it's Send waits on its gap's close (postit.js pinIt), its reset drops it (postitpen.js unpen): a gap with a
// line written in it, closed twice (as Send's press, then Send itself, do) and waited on; another dropped as its line
// is being read.
async function gapClosed(browser, c) {
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const got = await page.evaluate(async () => {
      const { openGap } = await import('/__review/penwords.js');
      const field = Object.assign(document.createElement('textarea'), { value: 'Order the mugs' });
      Object.assign(field.style, { position: 'fixed', left: '200px', top: '200px', width: '300px', zIndex: 99 });
      document.body.append(field);
      const r = field.getBoundingClientRect(),
        line = [
          [r.left + 20, r.top + 10, 0.5],
          [r.left + 40, r.top + 12, 0.5],
        ];
      const gap = () =>
        openGap(field, field.value.length, {
          text: () => field.value,
          put: text => (field.value = text),
          read: () => new Promise(read => setTimeout(() => read('teal'), 300)),
          lines: [line],
        });
      const first = gap();
      first.close();
      await first.close();
      const closed = field.value;
      const second = gap();
      await new Promise(rest => setTimeout(rest, 1300)); // (past the pen's rest: its reading under way)
      await second.drop();
      await new Promise(read => setTimeout(read, 600));
      field.remove();
      return { closed, dropped: field.value };
    });
    assert.equal(got.closed, 'Order the mugs teal', 'closed again, the gap is waited on till its words are in');
    assert.equal(got.dropped, 'Order the mugs teal', "a dropped gap's reading puts nothing in");
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// The words written after a post-it's Send stay out of it: a gap closed while its first line is read and a second
// waits, with a third pressed before the close and lifted after it (the finger's, which the pad writes as the pen's:
// the field is on HQ's page, where review mode takes the pen).
async function lateLine(browser, c) {
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const got = await page.evaluate(async () => {
      const { openGap } = await import('/__review/penwords.js');
      const field = Object.assign(document.createElement('textarea'), { value: 'Order the mugs' });
      Object.assign(field.style, { position: 'fixed', left: '200px', top: '200px', width: '300px', zIndex: 99 });
      document.body.append(field);
      const r = field.getBoundingClientRect(),
        at = dx => ({ clientX: r.left + 20 + dx, clientY: r.top + 10, pressure: 0.5 }),
        reads = [],
        words = ['teal', 'big', 'late'];
      const gap = openGap(field, field.value.length, {
        text: () => field.value,
        put: text => (field.value = text),
        read: lines => (
          reads.push(lines.length),
          new Promise(read => setTimeout(() => read(words[reads.length - 1]), 300))
        ),
        lines: [[Object.values(at(0)), Object.values(at(20))]],
      });
      await new Promise(rest => setTimeout(rest, 1300)); // (past the pen's rest: the first reading under way)
      const pad = [...document.body.children].find(el => el.style.touchAction === 'none'),
        touch = (type, pointerId, dx) =>
          pad.dispatchEvent(new PointerEvent(type, { pointerId, pointerType: 'touch', isPrimary: true, ...at(dx) }));
      touch('pointerdown', 7, 40);
      touch('pointermove', 7, 60);
      touch('pointerup', 7, 60);
      touch('pointerdown', 8, 80);
      touch('pointermove', 8, 100);
      const closing = gap.close();
      touch('pointerup', 8, 100);
      await closing;
      const closed = field.value; // (what the close itself waited for)
      await new Promise(rest => setTimeout(rest, 1600)); // (past the pen's rest again: a late line would be read by now)
      field.remove();
      return { reads, closed, value: field.value };
    });
    assert.deepEqual(got.reads, [1, 1], 'the close waits for both readings, the line lifted after it never read');
    assert.equal(got.closed, 'Order the mugs teal big', '...both readings in by the time the close returns');
    assert.equal(got.value, 'Order the mugs teal big', "...the late line's words none");
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// A scrap on a free page of today's, its post-it's words a field under it: a word struck out with the Pencil goes from
// the field and from the words the store keeps for its group, and leaves no ink
async function scrapStruck(browser, c) {
  const free = freePage(c);
  const scrap = c.notebook.route(
    '/api/notebooks/groups/scrap',
    {},
    { anchor: ANCHOR, words: WORDS, said: 'typed', snip: SNIP },
  );
  const kept = () => c.notebook.route('/api/notebooks/pages/groups', { page: free.id }).groups;
  const context = await c.hqIn(browser, MINI, { hasTouch: true });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    await c.settled(page, 'open');
    const field = page.locator(`#book .bk-under[data-g="${scrap.id}"] textarea.bk-scrap-words`);
    await field.waitFor();
    assert.equal(await field.getAttribute('data-pen'), '', 'the field kept from Scribble for the pen');
    await pen(page, along(await scrapWordBox(page, 'teal')));
    await until(
      () => kept().find(g => g.id === scrap.id)?.words === 'Order the mugs today',
      6000,
      "the scrap's words saved without the word",
    );
    assert.equal(await field.inputValue(), 'Order the mugs today', 'the board sees the word go');
    assert.ok(
      kept().every(g => !g.ink.length),
      'the strike left no ink',
    );
    await c.shot('book-edits-scrap-struck', page);
    c.noErrorsIn(errors);
  } finally {
    await context.close();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

// A scrap's words typed on a desktop, ending in a space: saved trimmed, the space still under the caret when the page
// is drawn again (another screen's line on it), and let go once saved, so words another screen gives the scrap later
// are shown and kept, never edited back.
async function scrapTyped(browser, c) {
  const free = freePage(c);
  const scrap = c.notebook.route(
    '/api/notebooks/groups/scrap',
    {},
    { anchor: ANCHOR, words: WORDS, said: 'typed', snip: SNIP },
  );
  const kept = () =>
    c.notebook.route('/api/notebooks/pages/groups', { page: free.id }).groups.find(g => g.id === scrap.id);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const field = page.locator(`#book .bk-under[data-g="${scrap.id}"] textarea.bk-scrap-words`);
    await field.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' soon ');
    await until(() => kept().words === `${WORDS} soon`, 6000, "the scrap's words saved, trimmed");
    const line = {
      points: [
        [620, 200, 0.5, 0],
        [700, 240, 0.5, 40],
      ],
      size: 3,
      color: '#2f6bdc',
    };
    c.notebook.route('/api/notebooks/groups/create', {}, { page: free.id, ink: [line] });
    await until(
      async () => (await page.locator('#book .bk-clip').count()) === 2,
      6000,
      "the other screen's line drawn",
    );
    assert.equal(await field.inputValue(), `${WORDS} soon `, 'the space typed still under the caret');
    c.notebook.route(
      '/api/notebooks/groups/edit',
      {},
      { id: scrap.id, since: kept().updated, words: 'Order the mugs', said: 'typed' },
    );
    await until(async () => (await field.inputValue()) === 'Order the mugs', 6000, "the other screen's words shown");
    // (past a save's wait: nothing edits them back)
    await page.waitForTimeout(1500);
    assert.equal(kept().words, 'Order the mugs', "the other screen's words kept");
    c.noErrorsIn(errors);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

// ---- helpers

// A read of the page (async) true in time
async function until(read, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100)))
    if (await read()) return;
  throw new Error(`not ${what}`);
}

// A free page of today's with a box of words on it
function wordsPage(c) {
  const free = freePage(c);
  free.texts.push({ x: 160, y: 180, w: 420, text: WORDS, color: '#2a2352' });
  return free;
}
// A word's box on screen, in the box of words
const wordBox = (page, word) =>
  page.evaluate(word => {
    const words = document.querySelector('#book .bk-typed-words'),
      text = words.firstChild,
      at = text.data.indexOf(word),
      range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, at + word.length);
    const r = range.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }, word);
// A word's box on screen, in a scrap's words (a field: measured as the pen's edits measure it)
const scrapWordBox = (page, word) =>
  page.evaluate(async word => {
    const { wordsOf } = await import('/__review/penedit.js');
    const { text, words } = wordsOf(document.querySelector('#book textarea.bk-scrap-words'));
    return words.find(w => text.slice(w.start, w.end) === word).rects[0];
  }, word);
const shownWords = page => page.evaluate(() => document.querySelector('#book .bk-typed-words').textContent);
// Whether the box of words shows a gap opened in it
const opened = page => page.evaluate(() => !!document.querySelector('#book .bk-typed span[style*="inline-block"]'));
// A hand's line along a word's middle, from a little before it to a little past it
const along = w => {
  const y = (w.top + w.bottom) / 2;
  return Array.from({ length: 17 }, (_, i) => [w.left - 8 + ((w.right - w.left + 16) * i) / 16, y + Math.sin(i) * 0.8]);
};
// ...and down between two words, from above their line to below it
const down = (a, b) => {
  const x = (a.right + b.left) / 2;
  return Array.from({ length: 13 }, (_, i) => [x + Math.sin(i) * 0.6, a.top - 14 + ((a.bottom - a.top + 28) * i) / 12]);
};
// A word written in a gap, as a zigzag of a hand's letters
const scrawl = g => Array.from({ length: 24 }, (_, i) => [g.x + 4 + i * 3, g.y + g.h * (i % 2 ? 0.25 : 0.8)]);
// The mouse along points, pressed
async function drag(page, points) {
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...p);
  await page.mouse.up();
}
// The Pencil along points, as Safari hands it over (bookdraw.mjs's)
const pen = (page, points) =>
  page.evaluate(pts => {
    const at = (kind, [x, y], pressure) =>
      (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
        new PointerEvent(kind, {
          pointerId: 7,
          pointerType: 'pen',
          isPrimary: true,
          clientX: x,
          clientY: y,
          pressure,
          buttons: kind === 'pointerup' ? 0 : 1,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
    at('pointerdown', pts[0], 0.4);
    pts.slice(1).forEach(p => at('pointermove', p, 0.5));
    at('pointerup', pts.at(-1), 0);
  }, points);
