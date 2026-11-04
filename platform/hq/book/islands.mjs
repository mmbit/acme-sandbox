// What book-check.mjs's stories read of the book's frame: a home-screen app's blur at the top, the two islands of
// controls over the paper, and whether they are of use.
import assert from 'node:assert/strict';

// a key's reach to the touch, the narrowest a finger needs (px; book.css --bk-touch)
export const TOUCH_PX = 44;

// Every page of context shown as a home-screen app on an iPhone or iPad: the blurred band at the top (style.css's
// --sat) and the home bar at the foot (--sab), px, set where Safari's env() would give them
export const blurred = (context, { sat, sab = 0 }) =>
  context.addInitScript(
    insets =>
      document.addEventListener('DOMContentLoaded', () => {
        for (const [name, px] of Object.entries(insets))
          if (px) document.documentElement.style.setProperty(`--${name}`, `${px}px`);
      }),
    { sat, sab },
  );

// The book's frame as the screen shows it: the blur's foot (sat), the paper, the page drawn on (desk) and the part of it
// its content is laid in (content: below the blur, left of the tools), the tools'
// island and the bar with the keys that show on each, any other island over the page, and what takes a press above
// the blur's foot
export const islandsSeen = async page => ({
  ...(await page.evaluate(frameInPage, TOUCH_PX)),
  underBlur: await page.evaluate(pressableAbove),
  content: await page.evaluate(contentInPage),
});

// The islands of use (when: where, for the messages): each one that shows whole on the screen below the blur and
// scrolling nothing, every key on it whole there and taking a finger's press; the tools and the bar clear of each
// other, no other island over the page, nothing to press under the blur, and nothing laid under the tools
export function islandsUsable(seen, when) {
  const { screen, sat, tools, bar } = seen,
    whole = b => b.top >= sat && b.bottom <= screen.height && b.left >= 0 && b.right <= screen.width;
  for (const island of [tools, bar].filter(i => i.shown)) {
    const { left, top, right, bottom } = island;
    assert.ok(
      whole(island),
      `${when}: ${island.name} whole on the screen, below the blur (${[left, top, right, bottom]})`,
    );
    const { scrollWidth, clientWidth, scrollHeight, clientHeight } = island.room;
    assert.ok(
      !island.scrolls,
      `${when}: ${island.name} scrolls nothing (${scrollWidth} by ${scrollHeight} in ${clientWidth} by ${clientHeight}, the paper ${Math.round(seen.paperWidth)} px wide)`,
    );
    for (const k of island.keys) {
      assert.ok(whole(k), `${when}: ${k.name} whole on the screen, below the blur`);
      assert.ok(k.reach, `${when}: ${k.name} takes a finger's press (${TOUCH_PX} px across)`);
    }
  }
  if (tools.shown && bar.shown) assert.ok(apart(tools, bar), `${when}: the tools and the bar clear of each other`);
  assert.deepEqual(seen.floating, [], `${when}: no other island over the page`);
  assert.deepEqual(seen.underBlur, [], `${when}: nothing to press under the blur (${sat} px)`);
  if (tools.shown) assert.ok(seen.content.right <= tools.left + 1, `${when}: nothing laid under the tools`);
}
const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;

// Whether a box on the screen ({ x, y, width, height }) lies clear of every one of the book's islands
export const islandsClearOf = (page, box) =>
  page.evaluate(
    r =>
      [...document.querySelectorAll('#book .bk-island')].every(i => {
        const b = i.getBoundingClientRect();
        return !b.width || b.right <= r.x || b.left >= r.x + r.width || b.bottom <= r.y || b.top >= r.y + r.height;
      }),
    box,
  );

// (in the page) islandsSeen's frame. A key's reach: a press touchPx wide, centred on it, lands on it, across the tools'
// island (press 'across') and up and down the bar ('down'); a disabled key, such as The page before on the first
// page, needs none.
function frameInPage(touchPx) {
  const $ = s => document.querySelector(`#book ${s}`),
    box = el => el.getBoundingClientRect().toJSON(),
    shows = el => el.checkVisibility({ visibilityProperty: true }) && el.getBoundingClientRect().width > 0,
    sat = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0;
  const keysOf = (el, press) =>
    [...el.querySelectorAll('.bk-btn')].filter(shows).map(b => {
      const r = b.getBoundingClientRect(),
        d = touchPx / 2 - 1,
        on = (dx, dy) =>
          document.elementFromPoint(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy)?.closest('.bk-btn') === b;
      return {
        name: b.getAttribute('aria-label'),
        reach: b.disabled || (press === 'across' ? on(-d, 0) && on(d, 0) : on(0, -d) && on(0, d)),
        ...box(b),
      };
    });
  const island = (name, el, press) => ({
    name,
    ...box(el),
    shown: shows(el),
    scrolls: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
    room: {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    },
    keys: keysOf(el, press),
  });
  const bar = $('.bk-bar'),
    names = part => keysOf(bar.querySelector(`.bk-bar-${part}`), 'down').map(k => k.name);
  return {
    screen: { width: innerWidth, height: innerHeight },
    sat,
    paper: box($('.bk-paper')),
    desk: box($('.bk-pages .bk-desk')),
    // (the paper's own width, as the bar's container query reads it)
    paperWidth: $('.bk-rail').getBoundingClientRect().width,
    tools: island('the tools', $('.bk-strip'), 'across'),
    bar: { ...island('the bar', bar, 'down'), start: names('start'), middle: names('middle'), end: names('end') },
    where: box(bar.querySelector('.bk-where')),
    // (the overview's own Search lies on its paper, scrolling with its pages)
    floating: [...document.querySelectorAll('#book .bk-island')]
      .filter(el => el.getBoundingClientRect().width && !el.closest('.bk-strip, .bk-bar, .bk-far'))
      .map(el => el.dataset.island),
  };
}
// (in the page) The page drawn on less its padding, the room its content keeps clear of (bookdesk.css)
function contentInPage() {
  const desk = document.querySelector('#book .bk-pages .bk-desk'),
    r = desk.getBoundingClientRect(),
    css = getComputedStyle(desk),
    px = side => parseFloat(css[`padding${side}`]) || 0;
  return {
    left: r.left + px('Left'),
    top: r.top + px('Top'),
    right: r.right - px('Right'),
    bottom: r.bottom - px('Bottom'),
  };
}
// (in the page) What of the book's takes a press, or is a field, an island or a send stamp, and shows with any of it
// above the blur's foot (--sat): their names
function pressableAbove() {
  const sat = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0;
  return [
    ...document.querySelectorAll(
      '#book :is(button, input, a[href], [role=button], [role=separator], [role=toolbar], .bk-send-stamp)',
    ),
  ]
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.width && r.height && r.bottom > 0 && r.right > 0 && r.top < sat - 0.5;
    })
    .filter(el => el.checkVisibility({ visibilityProperty: true }))
    .map(el => el.getAttribute('aria-label') || el.className);
}
