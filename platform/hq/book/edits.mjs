// book-check.mjs's stories of the pen over words in the book (shell/ink/booktexts.js, bookwrite.js): on a desktop with a
// mouse and on an iPad mini with the Pencil, a line over a box of words, or over a scrap's post-it words, is ink on the
// page, the words as they were (handwriting stays ink: nothing reads it or strikes words out), and a
// Pencil's tap in a box puts the caret where it tapped, deleting nothing. The pen writes in the scrap opened by its card.
import assert from 'node:assert/strict';
import { freePage, inScrap, onDesk, savedWhere } from './mouse.mjs';
import { MINI, closeScrap, openScrap, pressAlong, until } from './kit.mjs';
import { watchedPage } from './start.mjs';

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
    "with a mouse: a scrap's words typed with a space at their end in it opened, saved, another screen's words after them kept":
      browser => scrapTyped(browser, c),
  };
}

// ---- the stories

async function withMouse(browser, c) {
  const free = wordsPage(c);
  const { page, errors, done } = await onDesk(browser, c, { permissions: [] });
  try {
    await inScrap(page, c, free);
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
  const { page, errors } = await watchedPage(context);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    await c.settled(page, 'open');
    await inScrap(page, c, free, at => pressAlong(page, [at]));
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
  const { page, errors } = await watchedPage(context);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    await c.settled(page, 'open');
    const { gid } = await openScrap(page, { tap: at => pressAlong(page, [at]) }, scrap.id);
    assert.equal(gid, scrap.id, 'the scrap opened');
    // (a scrap's words in its body: .bk-words.)
    const field = page.locator(`#book .bk-page[data-focus] .bk-words[data-g="${scrap.id}"] textarea.bk-scrap-words`);
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

// A scrap's words typed on a desktop in the scrap opened by a click on its card, ending in a space: saved trimmed, the
// space still under the caret once saved, and let go once saved, so words another screen gives the scrap later are
// shown on its card and when it's opened again, and kept, never edited back.
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
  const mouse = { tap: ([x, y]) => page.mouse.click(x, y) },
    // (a scrap's words in its body: .bk-words; the opened scrap's, or its card's on the grid)
    words = on => page.locator(`#book .bk-page${on} .bk-words[data-g="${scrap.id}"] textarea.bk-scrap-words`);
  try {
    const { gid } = await openScrap(page, mouse, scrap.id);
    assert.equal(gid, scrap.id, 'the scrap opened');
    const field = words('[data-focus]');
    await field.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' soon ');
    await until(() => kept().words === `${WORDS} soon`, "the scrap's words saved, trimmed");
    // (past a save's wait: the space still there)
    await page.waitForTimeout(1500);
    assert.equal(await field.inputValue(), `${WORDS} soon `, 'the space typed still under the caret');
    await closeScrap(page, mouse);
    c.notebook.route(
      '/api/notebooks/groups/edit',
      {},
      { id: scrap.id, since: kept().updated, words: 'Order the mugs', said: 'typed' },
    );
    // (the grid read again as the scrap's put back, and as the store tells of a change)
    await until(
      async () => (await words(':not([hidden])').first().inputValue()) === 'Order the mugs',
      "the other screen's words shown on its card",
    );
    await openScrap(page, mouse, scrap.id);
    assert.equal(await words('[data-focus]').inputValue(), 'Order the mugs', 'and on it opened again');
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
// A word's box on screen, in the box of words on the opened scrap. (once the page is read: the book is open before its
// page's words are drawn, bookpages.js read)
async function wordBox(page, word) {
  await page.waitForFunction(
    w => document.querySelector('#book .bk-page[data-focus] .bk-typed-words')?.textContent.includes(w),
    word,
  );
  return page.evaluate(word => {
    const words = document.querySelector('#book .bk-page[data-focus] .bk-typed-words'),
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
    const field = document.querySelector('#book .bk-page[data-focus] textarea.bk-scrap-words'),
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
const shownWords = page =>
  page.evaluate(() => document.querySelector('#book .bk-page[data-focus] .bk-typed-words').textContent);
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
