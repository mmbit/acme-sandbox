// book-check.mjs's story of the two cards beside the book's islands (shell/ink/bookprefs.js, bookpalette.js): the
// preferences (from the bar's dots menu) and the pen's colours (the pen in use pressed again) open whole on the iPad
// mini upright, on its side and on a short screen (a finger's tap and the Pencil's), and on a desktop (a mouse), the
// tools never scrolling; and what's picked in them takes; a tooltip goes with its card; and each left open while the
// iPad turns on its side and its screen gets shorter. (the islands) The pen's colours are an opened scrap's, as its
// tools are: a scrap is opened for them.
import assert from 'node:assert/strict';
import { onDesk } from './mouse.mjs';
import { press } from './bar.mjs';
import { MINI, PREFERENCES, UPRIGHT, middleOf, openScrapInMiddle } from './kit.mjs';
import { mouseOf } from './hands.mjs';
import { mini } from './start.mjs';

const SHORT = { width: MINI.width, height: 560 };

// c: book-check.mjs's played store and helpers
export function cardStories(c) {
  return {
    "the islands' cards: the preferences and the colours open whole on the iPad mini and a desktop": browser =>
      cards(browser, c),
    "the islands' cards: the preferences and the colours stay whole while the iPad mini turns": browser =>
      turned(browser, c),
  };
}

async function cards(browser, c) {
  for (const viewport of [UPRIGHT, MINI, SHORT]) await onIPad(browser, c, viewport);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    await press(page, PREFERENCES);
    await whole(page, '.bk-prefs', 'the preferences on a desktop');
    await page.keyboard.press('Escape');
    await openScrapInMiddle(page, mouseOf(page));
    await press(page, 'Pen');
    await whole(page, '.bk-palette', 'the colours on a desktop');
    await tipGoes(page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
async function onIPad(browser, c, viewport) {
  const pad = await mini(browser, c, { viewport }),
    { page, errors, done } = pad,
    size = `${viewport.width}x${viewport.height}`;
  try {
    await preferencesTapped(pad, size);
    await c.shot(`book-prefs-${size}`, page);
    await page.keyboard.press('Escape');
    await openScrapInMiddle(page, pad.touch);
    const scrolls = await page.locator('#book .bk-strip').evaluate(el => el.scrollHeight > el.clientHeight + 1);
    assert.equal(scrolls, false, `the tools never scroll (${size})`);
    await coloursTapped(pad, size);
    await c.shot(`book-colours-${size}`, page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
// Each card opened upright and left open while the iPad turns on its side, then while its screen gets shorter
async function turned(browser, c) {
  for (const [name, selector] of [
    [PREFERENCES, '.bk-prefs'],
    ['Pen', '.bk-palette'],
  ]) {
    const { page, touch, errors, done } = await mini(browser, c, { viewport: UPRIGHT });
    try {
      if (name === 'Pen') await openScrapInMiddle(page, touch);
      await tapOn(page, touch.tap, name);
      await whole(page, selector, `${selector} upright`);
      for (const viewport of [MINI, SHORT]) {
        const size = `${viewport.width}x${viewport.height}`;
        await page.setViewportSize(viewport);
        await c.settled(page, 'open');
        await whole(page, selector, `${selector} turned to ${size}`);
        await c.shot(`book-turned-${selector.slice(4)}-${size}`, page);
      }
      assert.deepEqual(errors, []);
    } finally {
      await done();
    }
  }
}
// The preferences opened from the dots menu by a finger and by the Pencil, a hold time picked by the finger
async function preferencesTapped({ page, pen, touch }, size) {
  const long = () => page.locator('#book .bk-prefs').getByLabel('Long');
  await tapOn(page, touch.tap, PREFERENCES);
  await whole(page, '.bk-prefs', `the preferences at ${size}, a finger's tap`);
  await touch.tap(middleOf(await long().boundingBox()));
  assert.equal(await long().isChecked(), true, 'Long picked by a finger');
  await page.keyboard.press('Escape');
  await page.locator('#book .bk-prefs').waitFor({ state: 'detached' });
  await tapOn(page, pen.tap, PREFERENCES);
  await whole(page, '.bk-prefs', `the preferences at ${size}, the Pencil's tap`);
}
// The colours opened by the Pencil and by a finger (the pen's in hand: penOnOpen), each picking one
async function coloursTapped({ page, pen, touch }, size) {
  await pen.tap(await at(page, 'Pen'));
  await whole(page, '.bk-palette', `the colours at ${size}, the Pencil's tap`);
  await pen.tap(middleOf(await ink(page, 'Red').boundingBox()));
  await page.keyboard.press('Escape');
  await touch.tap(await at(page, 'Pen'));
  await whole(page, '.bk-palette', `the colours at ${size}, a finger's tap`);
  assert.equal(await ink(page, 'Red').getAttribute('aria-pressed'), 'true', 'Red picked by the Pencil');
  await touch.tap(middleOf(await ink(page, 'Blue').boundingBox()));
  assert.equal(await ink(page, 'Blue').getAttribute('aria-pressed'), 'true', 'Blue picked by a finger');
}

// A colour's tooltip, shown under the mouse, goes with the card when a tool's key puts the card away (Escape and a press
// on the paper hide it on their own)
async function tipGoes(page) {
  await ink(page, 'Blue').hover();
  await page.locator('#bk-tip').waitFor();
  await page.keyboard.press('e');
  assert.equal(await page.locator('#book .bk-palette').count(), 0, 'the card put away by the eraser');
  assert.equal(await page.locator('#bk-tip').isHidden(), true, "the colour's tooltip gone with its card");
}

// (a key on the book's islands)
const key = (page, name) => page.locator('#book .bk-controls').getByRole('button', { name, exact: true });
const ink = (page, name) => page.locator('#book .bk-palette').getByRole('menuitemradio', { name, exact: true });
// A key's middle on the screen
const at = async (page, name) => middleOf(await key(page, name).boundingBox());
// A control tapped by a finger or the Pencil (tap(point)): its key on the islands, or its row in the dots menu
async function tapOn(page, tap, name) {
  if (await key(page, name).isVisible()) return tap(await at(page, name));
  await tap(await at(page, 'More'));
  const row = page.locator('#book .bk-more-card').getByRole('menuitem', { name, exact: true });
  await row.waitFor({ timeout: 5000 });
  await tap(middleOf(await row.boundingBox()));
}

// The card open and nothing of it hidden: its corners (inside their rounding) and both ends of each of its lines and
// buttons are the card's own on the screen, so neither a clipping box nor the screen's edge nor anything over it hides
// a part
async function whole(page, selector, what) {
  await page.locator(`#book ${selector}`).waitFor({ timeout: 5000 });
  const hidden = await page.evaluate(selector => {
    const card = document.querySelector(`#book ${selector}`),
      r = card.getBoundingClientRect(),
      INSET = 16;
    const points = [
      ['top left', r.left + INSET, r.top + INSET],
      ['top right', r.right - INSET, r.top + INSET],
      ['bottom left', r.left + INSET, r.bottom - INSET],
      ['bottom right', r.right - INSET, r.bottom - INSET],
    ];
    for (const part of card.querySelectorAll('p, legend, label, button')) {
      const b = part.getBoundingClientRect(),
        name = part.textContent.trim() || part.getAttribute('aria-label');
      points.push(
        [`${name}'s start`, b.left + 2, b.top + b.height / 2],
        [`${name}'s end`, b.right - 2, b.top + b.height / 2],
      );
    }
    // (each with what's there instead)
    const over = el => (el ? `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}` : 'off the screen');
    return points
      .map(([name, x, y]) => [name, document.elementFromPoint(x, y)])
      .filter(([, el]) => !card.contains(el))
      .map(([name, el]) => `${name} (under ${over(el)})`);
  }, selector);
  assert.deepEqual(hidden, [], `${what}: whole`);
}
