// book-check.mjs's Search story (shell/booksearch.js), on HQ's mock book, held like an iPad mini: the overview holds a
// line to write on that the Pencil can write in (Apple's Scribble: nothing over the field, nothing cancelling a
// pen's touch on it, a field that takes text); a word said while drawing yesterday is found as it's written, with how
// it came, whose sheet and the day, and an answer by its words too; tapped, the book turns to yesterday's page, the
// note in view and its number lit.
import assert from 'node:assert/strict';

// c: book-check's { hq, inBook, shot, noErrorsIn, viewport, settle }
export async function findStory(browser, c) {
  const { page, errors, done } = await c.hq(browser, c.viewport);
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
  await until(() => page.getByRole('search').textContent(), 'Nothing in the book says “purple”');
}
// Tapped, the book turns to yesterday's page at the note, its number lit
async function opened(page, c) {
  await page.getByRole('searchbox', { name: 'Search the book' }).fill('tear');
  await found(page, 'tear line');
  // (the day in the shown page's heading.)
  const shownDay = () => page.locator('#book .bk-page:not([hidden]) .bk-when').textContent();
  const today = await shownDay();
  await page
    .getByRole('search')
    .getByRole('button', { name: /tear line/ })
    .click();
  // (a note alone on its page shows no number: the note itself is lit.)
  const note = page.getByRole('region', { name: 'For Moss' }).getByRole('group', { name: 'Note' }),
    lit = note.locator('[data-lit]');
  await lit.waitFor({ timeout: 5000 });
  await page.waitForTimeout(c.settle);
  assert.equal(await page.getByRole('search').isVisible(), false, 'Search steps aside');
  const day = await shownDay();
  assert.notEqual(day, today, `the book still on ${day}`);
  assert.ok(await c.inBook(page, note), "the note on the book's paper");
  await c.shot('book-search-found', page);
  // (the light goes out when its animation ends)
  await lit.waitFor({ state: 'detached', timeout: 5000 });
}

// On a desktop, in the overview: a word typed finds as it's written; the overview closed and opened again, the words
// and their finds still there; Esc wipes the words.
export async function keptStory(browser, c) {
  const { page, errors, done } = await c.hq(browser, c.desktop, { hasTouch: false });
  try {
    const overview = page.locator('#book').getByRole('button', { name: /^The overview/ }),
      field = page.getByRole('searchbox', { name: 'Search the book' });
    await overview.click();
    await field.click();
    await page.keyboard.type('tea');
    await found(page, 'tear line');
    await overview.click();
    await until(async () => String(await field.isVisible()), 'false');
    await overview.click();
    assert.equal(await field.inputValue(), 'tea', 'the words written last still there');
    await found(page, 'tear line');
    await field.press('Escape');
    assert.equal(await field.inputValue(), '', 'Esc wipes the words');
    await until(async () => String((await finds(page)) === ''), 'true');
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
const found = (page, words) => until(() => finds(page), words);
async function until(read, words, ms = 5000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100)))
    if ((last = await read()).includes(words)) return last;
  assert.fail(`still ${JSON.stringify(last)}`);
}
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
