// book-check.mjs's stories of the pen over words in the book (shell/ink/booktexts.js, bookwrite.js): on a desktop with a
// mouse and on an iPad mini with the Pencil, a line over a box of words, or over a scrap's post-it words, is ink on the
// page, the words as they were (nothing reads the board's handwriting or strikes words out: board, call 176), and a
// Pencil's tap in a box puts the caret where it tapped, deleting nothing.
import assert from 'node:assert/strict';
import { freePage, onDesk, savedWhere } from './bookmouse.mjs';
import { MINI, pressAlong, until } from './bookkit.mjs';

const WORDS = 'Order the teal mugs today';
// where a scrap was cut
const ANCHOR = { v: 1, url: 'https://hq.example/', el: null, view: { x: 0, y: 0, w: 1200, h: 800, dpr: 1 }, ink: [] };

// c: book-check.mjs's played store and helpers, as mouseStories gets them, and snipPng(), a scrap's picture
export function editStories(c) {
  return {
    "with a mouse: a line over a box's words is ink, the words as they were": browser => withMouse(browser, c),
    "with the Pencil: a line over a box's words is ink, and a tap in it puts the caret there, deleting nothing":
      browser => withPencil(browser, c),
    "with the Pencil: a line over a scrap's words is ink, the words as they were": browser => scrapInked(browser, c),
    "with a mouse: a scrap's words typed with a space at their end, saved, another screen's words after them kept":
      browser => scrapTyped(browser, c),
  };
}

// ---- the stories

async function withMouse(browser, c) {
  const free = wordsPage(c);
  // No microphone allowed here. With it, a mouse pressed on the paper and held still is a voice note
  // (shell/ink/bookinput.js). On a loaded worker Playwright's moves can come that late, and the line would be lost.
  const { page, errors, done } = await onDesk(browser, c, { permissions: [] });
  try {
    // a drag along the middle of "teal", from inside the box: the line once struck the word out
    await drag(page, along(await wordBox(page, 'teal')));
    const inked = await savedWhere(c, free.id, p => p.ink.length === 1);
    assert.equal(inked.texts[0].text, WORDS, 'the words kept as they were');
    assert.equal(await shownWords(page), WORDS, 'the board sees its words as they were');
    await c.shot('book-edits-mouse-inked', page);
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
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    await c.settled(page, 'open');
    await pressAlong(page, along(await wordBox(page, 'teal')));
    await savedWhere(c, free.id, p => p.ink.length === 1);
    const [teal, mugs] = [await wordBox(page, 'teal'), await wordBox(page, 'mugs')];
    await pressAlong(page, down(teal, mugs));
    await pressAlong(page, scrawl({ x: teal.left, y: teal.top, h: teal.bottom - teal.top }));
    const inked = await savedWhere(c, free.id, p => p.ink.length === 3);
    assert.equal(inked.texts[0].text, WORDS, 'the words kept as they were');
    assert.equal(await shownWords(page), WORDS, 'the board sees its words as they were');
    // a tap just inside the end of "teal": the caret there, and the keyboard's letter goes in, nothing taken out
    const at = await wordBox(page, 'teal');
    await pressAlong(page, [[at.right - 1, (at.top + at.bottom) / 2]]);
    await until(() => page.evaluate(() => !!document.querySelector('#book .bk-typed[data-editing]')), 'the box edited');
    await page.keyboard.type('s');
    await page.keyboard.press('Escape');
    await savedWhere(c, free.id, p => p.texts[0]?.text === 'Order the teals mugs today');
    await c.shot('book-edits-pencil-caret', page);
    c.noErrorsIn(errors);
  } finally {
    await context.close();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

// A scrap on a free page of today's, its post-it's words a field under it: a Pencil line over a word is ink the store
// keeps on the scrap, its words as they were
async function scrapInked(browser, c) {
  const free = freePage(c);
  const scrap = c.notebook.route(
    '/api/notebooks/groups/scrap',
    {},
    { anchor: ANCHOR, words: WORDS, said: 'typed', snip: c.snipPng() },
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
    // (a scrap's words in its body: .bk-words.)
    const field = page.locator(`#book .bk-words[data-g="${scrap.id}"] textarea.bk-scrap-words`);
    await field.waitFor();
    assert.equal(await field.getAttribute('data-pen'), '', 'the field kept from Scribble for the pen');
    const edits = [];
    page.on('request', r => r.url().includes('/api/notebooks/groups/edit') && edits.push(r.postDataJSON()));
    await pressAlong(page, along(await scrapWordBox(page, 'teal')));
    const edit = await until(() => edits.find(b => b.id === scrap.id), "the scrap's edit sent");
    assert.equal(edit.ink.length, 1, 'the line goes as ink on the scrap');
    assert.equal(edit.words, undefined, "the scrap's words not changed");
    await until(() => kept().find(g => g.id === scrap.id)?.ink.length === 1, 'the store keeps the line on the scrap');
    assert.equal(kept().find(g => g.id === scrap.id)?.words, WORDS, "the scrap's words kept as they were");
    assert.equal(await page.locator('#book .bk-refusal:visible').count(), 0, 'no save refused');
    assert.equal(await field.inputValue(), WORDS, 'the board sees its words as they were');
    await c.shot('book-edits-scrap-inked', page);
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
    { anchor: ANCHOR, words: WORDS, said: 'typed', snip: c.snipPng() },
  );
  const kept = () =>
    c.notebook.route('/api/notebooks/pages/groups', { page: free.id }).groups.find(g => g.id === scrap.id);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    // (a scrap's words in its body: .bk-words.)
    const field = page.locator(`#book .bk-words[data-g="${scrap.id}"] textarea.bk-scrap-words`);
    await field.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' soon ');
    await until(() => kept().words === `${WORDS} soon`, "the scrap's words saved, trimmed");
    const line = {
      points: [
        [620, 200, 0.5, 0],
        [700, 240, 0.5, 40],
      ],
      size: 3,
      color: '#2f6bdc',
    };
    // (two lines, one group: its unit shows it's drawn)
    const under = { ...line, points: line.points.map(([x, y, ...more]) => [x, y + 40, ...more]) },
      units = page.locator('#book .bk-page:not([hidden]) .bk-unit'),
      before = await units.count();
    c.notebook.route('/api/notebooks/groups/create', {}, { page: free.id, ink: [line, under] });
    await until(async () => (await units.count()) === before + 1, "the other screen's lines drawn");
    assert.equal(await field.inputValue(), `${WORDS} soon `, 'the space typed still under the caret');
    c.notebook.route(
      '/api/notebooks/groups/edit',
      {},
      { id: scrap.id, since: kept().updated, words: 'Order the mugs', said: 'typed' },
    );
    await until(async () => (await field.inputValue()) === 'Order the mugs', "the other screen's words shown");
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

// A free page of today's with a box of words on it
function wordsPage(c) {
  const free = freePage(c);
  free.texts.push({ x: 160, y: 180, w: 420, text: WORDS, color: '#2a2352' });
  return free;
}
// A word's box on screen, in the box of words. (once the page is read: the book is open before its page's words are
// drawn, bookpages.js read)
async function wordBox(page, word) {
  await page.waitForFunction(w => document.querySelector('#book .bk-typed-words')?.textContent.includes(w), word);
  return page.evaluate(word => {
    const words = document.querySelector('#book .bk-typed-words'),
      text = words.firstChild,
      at = text.data.indexOf(word),
      range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, at + word.length);
    const r = range.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }, word);
}
// A word's box on screen, in a scrap's words (a field: its words laid out in a copy over it, measured, gone again)
const scrapWordBox = (page, word) =>
  page.evaluate(word => {
    const field = document.querySelector('#book textarea.bk-scrap-words'),
      style = getComputedStyle(field),
      copy = document.createElement('div');
    for (const p of [
      'boxSizing',
      'width',
      'paddingTop',
      'paddingRight',
      'paddingLeft',
      'borderTopWidth',
      'borderRightWidth',
      'borderLeftWidth',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'fontStyle',
      'letterSpacing',
      'wordSpacing',
      'lineHeight',
      'textAlign',
      'overflowWrap',
    ])
      copy.style[p] = style[p];
    Object.assign(copy.style, {
      position: 'fixed',
      margin: '0',
      borderStyle: 'solid',
      borderColor: 'transparent',
      whiteSpace: 'pre-wrap',
      visibility: 'hidden',
    });
    const f = field.getBoundingClientRect();
    Object.assign(copy.style, { left: `${f.left}px`, top: `${f.top}px` });
    const at = field.value.indexOf(word);
    copy.append(field.value.slice(0, at), Object.assign(document.createElement('span'), { textContent: word }));
    document.body.append(copy);
    const r = copy.lastChild.getBoundingClientRect();
    copy.remove();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }, word);
const shownWords = page => page.evaluate(() => document.querySelector('#book .bk-typed-words').textContent);
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
