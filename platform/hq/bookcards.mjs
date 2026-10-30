// book-check.mjs's story of the two cards over the tool rail (shell/ink/bookprefs.js, bookpalette.js): the page bar's
// cog's preferences and the pen's colours (the pen in use pressed again) open whole on the iPad mini upright, on its
// side and on a short screen (a finger's tap and the Pencil's), and on a desktop (a mouse), the rail never scrolling;
// and what's picked in them takes; and each left open while the iPad turns on its side and its screen gets shorter.
import assert from 'node:assert/strict';
import { onDesk } from './bookmouse.mjs';
import { heard, touchOf } from './bookstrip.mjs';
import { MINI, chromiumPen } from './bookkit.mjs';

const UPRIGHT = { width: MINI.height, height: MINI.width },
  SHORT = { width: MINI.width, height: 560 };

// c: book-check.mjs's played store and helpers
export function cardStories(c) {
  return {
    "the rail's cards: the preferences and the colours open whole on the iPad mini and a desktop": browser =>
      cards(browser, c),
    "the rail's cards: the preferences and the colours stay whole while the iPad mini turns": browser =>
      turned(browser, c),
  };
}

async function cards(browser, c) {
  for (const viewport of [UPRIGHT, MINI, SHORT]) await onIPad(browser, c, viewport);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    await strip(page, 'Preferences on this device').click();
    await whole(page, '.bk-prefs', 'the preferences on a desktop');
    await page.keyboard.press('Escape');
    await strip(page, 'Pen').click();
    await whole(page, '.bk-palette', 'the colours on a desktop');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
async function onIPad(browser, c, viewport) {
  const pad = await iPad(browser, c, viewport),
    { page, errors, done } = pad,
    size = `${viewport.width}x${viewport.height}`;
  try {
    const scrolls = await page.locator('#book .bk-strip .bk-island').evaluate(el => el.scrollWidth > el.clientWidth);
    assert.equal(scrolls, false, `the rail never scrolls (${size})`);
    await preferencesTapped(pad, size);
    await c.shot(`book-prefs-${size}`, page);
    await page.keyboard.press('Escape');
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
    ['Preferences on this device', '.bk-prefs'],
    ['Pen', '.bk-palette'],
  ]) {
    const { page, touch, errors, done } = await iPad(browser, c, UPRIGHT);
    try {
      await tapped(touch, await at(page, name));
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
// The cog's card opened by a finger and by the Pencil, a hold time picked by the finger
async function preferencesTapped({ page, pen, touch }, size) {
  const COG = 'Preferences on this device',
    long = () => page.locator('#book .bk-prefs').getByLabel('Long');
  await tapped(touch, await at(page, COG));
  await whole(page, '.bk-prefs', `the preferences at ${size}, a finger's tap`);
  await tapped(touch, centre(await long().boundingBox()));
  assert.equal(await long().isChecked(), true, 'Long picked by a finger');
  await tapped(touch, await at(page, COG));
  await pen.tap(await at(page, COG));
  await whole(page, '.bk-prefs', `the preferences at ${size}, the Pencil's tap`);
}
// The colours opened by the Pencil and by a finger (the pen's in hand: penOnOpen), each picking one
async function coloursTapped({ page, pen, touch }, size) {
  await pen.tap(await at(page, 'Pen'));
  await whole(page, '.bk-palette', `the colours at ${size}, the Pencil's tap`);
  await pen.tap(centre(await ink(page, 'Red').boundingBox()));
  await page.keyboard.press('Escape');
  await tapped(touch, await at(page, 'Pen'));
  await whole(page, '.bk-palette', `the colours at ${size}, a finger's tap`);
  assert.equal(await ink(page, 'Red').getAttribute('aria-pressed'), 'true', 'Red picked by the Pencil');
  await tapped(touch, centre(await ink(page, 'Blue').boundingBox()));
  assert.equal(await ink(page, 'Blue').getAttribute('aria-pressed'), 'true', 'Blue picked by a finger');
}

// The iPad mini as a touch screen with a pen (Chromium's own touch and pen events, trusted), the book open: upright it
// starts folded, and its lip opens it as the spread over HQ
async function iPad(browser, c, viewport) {
  const context = await c.hqIn(browser, viewport, { hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await heard(page);
  await page.goto(`${c.base}/?intro=0`);
  if (viewport.width > viewport.height) await c.settled(page, 'open');
  else {
    await c.settled(page, 'folded');
    await page.evaluate(() => document.querySelector('#book .bk-lip').click());
    await c.settled(page, 'spread');
  }
  const cdp = await context.newCDPSession(page);
  return { page, pen: chromiumPen(cdp), touch: touchOf(cdp), errors, done: () => context.close() };
}
// (a button of the rail's or the page bar's)
const strip = (page, name) => page.locator('#book .bk-lane .bk-island').getByRole('button', { name, exact: true });
const ink = (page, name) => page.locator('#book .bk-palette').getByRole('menuitemradio', { name, exact: true });
// A rail's or bar's button's middle on the screen
const at = async (page, name) => centre(await strip(page, name).boundingBox());
async function tapped(touch, point) {
  await touch.down([point]);
  await touch.up();
}
const centre = box => [box.x + box.width / 2, box.y + box.height / 2];

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
    return points.filter(([, x, y]) => !card.contains(document.elementFromPoint(x, y))).map(([name]) => name);
  }, selector);
  assert.deepEqual(hidden, [], `${what}: whole`);
}
