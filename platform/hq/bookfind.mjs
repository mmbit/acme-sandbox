// book-check.mjs's Search story (shell/ink/booksearch.js; Ink's folder), held
// like an iPad mini, on a played Notebook of its own: the overview holds a line to write on that the Pencil can write
// in (Apple's Scribble: nothing over the field, nothing cancelling a pen's touch on it, a field that takes text); a
// scrap's words said while drawing yesterday are found as they're written, with how they came, who the scrap went to
// and the day, and an answer under it by its words too; tapped, the book turns to yesterday's page, the scrap in view.
// (the Notebook's groups)
import assert from 'node:assert/strict';
import { errorsOf } from '../../shared/browser/browser.mjs';
import { until } from './bookkit.mjs';

// c: book-check's { hqIn, base, inBook, shot, noErrorsIn, viewport, settle }
export async function findStory(browser, c) {
  const { page, errors, done } = await searchable(browser, c, c.viewport);
  try {
    await written(page, c);
    await opened(page, c);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// The line to write on, the Pencil's; the finds as the words are written, a note's said words and an answer's
async function written(page, c) {
  // (Search in the overview)
  await page
    .locator('#book')
    .getByRole('button', { name: /^The overview/ })
    .click();
  const field = page.getByRole('searchbox', { name: 'Search the book' });
  await field.waitFor();
  assert.ok(await c.inBook(page, field), 'the line to write on is on the book');
  const pen = await penOn(field);
  assert.deepEqual(pen, { under: true, cancelled: false, touch: false, text: true }, "the Pencil's to write in");
  assert.equal(await finds(page), '', 'nothing found before a word');
  // written a letter at a time on a keyboard
  await field.click();
  await page.keyboard.type('tea', { delay: 60 });
  assert.equal(await found(page, 'tear line'), '1 “The tear line is too dark” Said · For Moss · Yesterday');
  await c.shot('book-search', page);
  // and a word at a time, as Scribble lands it: text put in, no key pressed
  await field.fill('');
  await page.keyboard.insertText('lighter');
  assert.equal(await found(page, 'answer'), '1 Lighter now, half the old ink Moss’s answer · For Moss · Yesterday');
  await field.fill('purple');
  await reads(() => page.getByRole('search').textContent(), 'Nothing in the book says “purple”');
}
// Tapped, the book turns to yesterday's page, the scrap on it in view
async function opened(page, c) {
  await page.getByRole('searchbox', { name: 'Search the book' }).fill('tear');
  await found(page, 'tear line');
  const where = () =>
    page
      .locator('#book')
      .getByRole('button', { name: /^The notebook's pages/ })
      .getAttribute('aria-label');
  await page
    .getByRole('search')
    .getByRole('button', { name: /tear line/ })
    .click();
  await reads(where, 'Tear-off cards, 1 of 2');
  await page.waitForTimeout(c.settle);
  assert.equal(await page.getByRole('search').isVisible(), false, 'Search steps aside');
  const scrap = page.locator('#book .bk-page:not([hidden]) .bk-scrap-words', { hasText: 'tear line' });
  assert.ok(await c.inBook(page, scrap), "the scrap on the book's paper");
  await c.shot('book-search-found', page);
}

// HQ on a Notebook of its own: yesterday's page, sent, a spoken scrap on it for Moss and Moss's answer under it, and
// today's with a drawing
async function searchable(browser, c, viewport, options = {}) {
  const context = await c.hqIn(browser, viewport, { ...options, notebooks: seeded() });
  const page = await context.newPage(),
    errors = errorsOf(page);
  await page.goto(`${c.base}/?intro=0`);
  // (the newest page's groups drawn)
  await page.waitForSelector('#book .bk-groups[data-page]', { state: 'attached', timeout: 30_000 });
  return { page, errors, done: () => context.close() };
}
function seeded() {
  const now = new Date(),
    at = d => d.toISOString(),
    yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12),
    then = at(yesterday);
  const anchor = { v: 1, url: '/gazette', el: null, view: { x: 0, y: 0, w: 1280, h: 800, dpr: 2 }, ink: [] },
    snip = { file: 'book-snip-1.svg', x: 60, y: 120, w: 360, h: 154, tilt: 0 },
    said = { words: 'The tear line is too dark', said: 'spoken', owner: 'moss' },
    line = {
      color: '#2a2352',
      size: 4,
      points: [0, 1, 2, 3].map(i => [300 + i * 30, 300 + (i % 2) * 12, 0.5, i * 16]),
    };
  return {
    notebooks: [{ id: 1, kind: 'mine', name: 'My journal', created: then, updated: at(now) }],
    pages: [
      { id: 1, notebook: 1, pos: 0, label: 'Tear-off cards', send_at: yesterday.getTime() + 3_600_000, created: then },
      { id: 2, notebook: 1, pos: 1, created: at(new Date(now - 60_000)) },
    ].map(p => ({ updated: p.created, x: 0, y: 0, w: 1200, h: 1600, ...p })),
    groups: [
      { id: 1, page: 1, kind: 'scrap', pictures: [snip], anchor, ...said, status: 'sent', note: 1, created: then },
      { id: 2, page: 2, kind: 'drawing', ink: [line], created: at(now) },
    ].map(g => ({ updated: g.created, ...g })),
    slips: [
      {
        ...{ id: 1, note: 1, by: 'moss', name: 'Moss', text: 'Lighter now, half the old ink' },
        ...{ picture: null, link: null, preview: null, now: null, now_at: null, ticked: null },
        created: at(new Date(yesterday.getTime() + 7_200_000)),
      },
    ],
    names: { moss: 'Moss' },
  };
}

// On a desktop, in the overview: a word typed finds as it's written; the overview closed and opened again, the words
// and their finds still there; Esc wipes the words.
export async function keptStory(browser, c) {
  const { page, errors, done } = await searchable(browser, c, c.desktop, { hasTouch: false });
  try {
    const overview = page.locator('#book').getByRole('button', { name: /^The overview/ }),
      field = page.getByRole('searchbox', { name: 'Search the book' });
    await overview.click();
    await field.click();
    await page.keyboard.type('tea');
    await found(page, 'tear line');
    await overview.click();
    await until(async () => !(await field.isVisible()), 'the field gone with the overview');
    await overview.click();
    assert.equal(await field.inputValue(), 'tea', 'the words written last still there');
    await found(page, 'tear line');
    await field.press('Escape');
    assert.equal(await field.inputValue(), '', 'Esc wipes the words');
    await until(async () => (await finds(page)) === '', 'no finds left');
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// The finds as the board reads them, one line each
const finds = page =>
  page
    .locator('#book [role=search] ol li')
    .evaluateAll(lis => lis.map(li => li.innerText.replace(/\s+/g, ' ').trim()).join('\n'));
// The finds once they hold some words
const found = (page, words) => reads(() => finds(page), words);
// What read gives (awaited) once it holds the words
const reads = (read, words) =>
  until(async () => {
    const text = await read();
    return text.includes(words) && text;
  }, `reading “${words}”`);
// A pen's touch on the field, as iPad Safari hands it over: whether the field is what's under it, whether anything of
// HQ's cancelled its pointer or its touches (Scribble needs the touch left to Safari), and whether the field takes text
const penOn = field =>
  field.evaluate(input => {
    const r = input.getBoundingClientRect(),
      x = r.left + r.width / 2,
      y = r.top + r.height / 2,
      under = document.elementFromPoint(x, y) === input;
    const down = new PointerEvent('pointerdown', {
      pointerId: 31,
      pointerType: 'pen',
      isPrimary: true,
      clientX: x,
      clientY: y,
      pressure: 0.4,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    input.dispatchEvent(down);
    // (and its touches, as a stylus's: Safari scrolls and selects under a pen until one is cancelled.)
    const touch = ['touchstart', 'touchmove', 'touchend'].map(type => {
      const e = new Event(type, { bubbles: true, composed: true, cancelable: true }),
        t = [{ identifier: 31, touchType: 'stylus', clientX: x + 4, clientY: y, target: input, force: 0.4 }];
      Object.defineProperties(e, { touches: { value: type === 'touchend' ? [] : t }, changedTouches: { value: t } });
      input.dispatchEvent(e);
      return e.defaultPrevented;
    });
    input.dispatchEvent(new PointerEvent('pointerup', { pointerId: 31, pointerType: 'pen', bubbles: true }));
    const style = getComputedStyle(input);
    return {
      under,
      cancelled: down.defaultPrevented,
      touch: touch.some(Boolean),
      text: !input.readOnly && !input.disabled && style.webkitUserSelect !== 'none' && style.touchAction !== 'none',
    };
  });
