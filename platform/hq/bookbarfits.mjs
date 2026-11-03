// Where the book's two islands are, for bookbar.mjs's story (shell/ink/bookui.js, bookstrip.css): the tools upright at
// the paper's right and the bar along its foot, measured on the screen and checked against the frame the board drew
// (call 190).
import assert from 'node:assert/strict';
import { OVERVIEW } from './bookkit.mjs';

// the tools down their island (the pen or the marker, whichever is in hand; the mic after them where the device can
// record: bookvoice.js)
const TOOLS = [/^(Pen|Marker)$/, /^Shapes/, 'Eraser', 'Select', 'Text'],
  MIC = 'Voice note';
// a key's reach to the touch, the narrowest a finger needs (px; book.css --bk-touch.); the paper's width from which the overview and New page are on the bar (bookstrip.css's container query)
const TOUCH_PX = 44,
  KEYS_ON_BAR_PX = 460;
// the most of a phone's height the tools' island takes, upright: well under half (the board's own measure)
const TOOLS_OF_PHONE = 0.4;

// Both islands whole on the screen, scrolling nothing, every key 44 px to the touch and nothing to press above --sat;
// the tools and the bar each where the board drew them, and no other island over the page. size: bookbar.mjs's.
// Returns whether the paper is wide enough for the page's keys on the bar.
export async function fits(page, size) {
  const m = { ...(await page.evaluate(islandsSeen, TOUCH_PX)), above: await page.evaluate(pressableAbove) },
    view = page.viewportSize();
  assert.deepEqual(m.scrolls, [], 'no island scrolls');
  assert.deepEqual(m.above, [], `nothing to press under the blurred strip (--sat ${m.sat} px)`);
  for (const k of [...m.tools, ...m.keys]) {
    assert.ok(k.height >= 32 && k.reach, `${k.name} big enough to tap: ${k.width}x${k.height}, ${TOUCH_PX} px`);
    assert.ok(k.top >= m.sat && k.bottom <= view.height && k.left >= 0 && k.right <= view.width, `${k.name} on screen`);
  }
  toolsFit(m, size, view);
  barFits(m, view);
  assert.deepEqual(m.floating, [], 'no island of controls floats over the page');
  return m.across >= KEYS_ON_BAR_PX;
}

// The tools: upright just in from the paper's right edge, centred in the room above the bar, in their order with one
// pen, well under half a phone's height, what's written ending left of them
function toolsFit(m, size, view) {
  const tools = m.tools.map(k => k.name),
    drawn = tools.filter(n => n !== MIC),
    said = JSON.stringify({ strip: m.strip, bar: m.bar, sat: m.sat });
  assert.equal(tools.filter(n => /^(Pen|Marker)$/.test(n)).length, 1, `one pen: ${tools.join(', ')}`);
  assert.ok(
    drawn.length === TOOLS.length && drawn.every((n, i) => TOOLS[i].test?.(n) ?? TOOLS[i] === n),
    `the tools in their order: ${tools.join(', ')}`,
  );
  assert.ok(!tools.includes(MIC) || tools.at(-1) === MIC, `the mic after the tools: ${tools.join(', ')}`);
  m.tools.slice(1).forEach((k, i) => assert.ok(k.top >= m.tools[i].bottom - 1, `${k.name} under the one above`));
  const inFrom = Math.min(m.paper.right, view.width) - m.strip.right;
  assert.ok(inFrom >= 2 && inFrom <= 16, `the tools just in from the paper's right edge: ${inFrom} px (${said})`);
  const room = middle(m.controls.top, m.bar.top);
  assert.ok(
    Math.abs(middle(m.strip.top, m.strip.bottom) - room) <= 2 && m.strip.bottom <= m.bar.top,
    `the tools centred in the room above the bar, at ${room} (${said})`,
  );
  if (size.viewport.width < 500)
    assert.ok(
      m.strip.height < TOOLS_OF_PHONE * view.height,
      `the tools ${Math.round(m.strip.height)} px tall, well under half the phone's ${view.height}`,
    );
  assert.ok(m.desk.right <= m.strip.left + 1, `what's written ends left of the tools: ${m.desk.right} ${m.strip.left}`);
}

// The bar: along the foot on the paper, Undo and Redo at its left, the page's arrows and where it is in its very middle
// (to the px), the overview and New page at its right where the paper is wide enough, then the dots
function barFits(m, view) {
  const said = JSON.stringify({ bar: m.bar, where: m.where }),
    foot = view.height - m.bar.bottom;
  assert.ok(foot >= 4 && foot <= 40, `the bar along the foot, ${foot} px up (${said})`);
  assert.ok(
    m.bar.left >= Math.max(m.paper.left, 0) - 1 && m.bar.right <= Math.min(m.paper.right, view.width) + 1,
    `the bar on the paper (${said})`,
  );
  assert.deepEqual(m.start, ['Undo', 'Redo'], "Undo and Redo at the bar's left");
  assert.ok(
    m.middle.length === 3 && m.middle[0] === 'The page before' && m.middle[2] === 'The page after',
    `the page's arrows round where it is in the bar's middle: ${m.middle.join(', ')}`,
  );
  const off = middle(m.where.left, m.where.right) - middle(m.bar.left, m.bar.right);
  assert.ok(Math.abs(off) <= 1, `the page's count in the very middle of the bar: ${off} px off (${said})`);
  const keys = m.across >= KEYS_ON_BAR_PX ? [OVERVIEW, 'New page', 'More'] : ['More'];
  assert.deepEqual(m.end, keys, `the bar's right on a paper ${Math.round(m.across)} px wide`);
}
const middle = (a, b) => (a + b) / 2;

// (in the page) The islands, the paper and the page under them, and every key that shows on each island (the screen's
// px). A key's reach: a press TOUCH_PX across the island, centred on it, lands on it; a disabled key, such as The page
// before on the first page, needs none.
function islandsSeen(touchPx) {
  const box = el => el && el.getBoundingClientRect().toJSON(),
    strip = document.querySelector('#book .bk-strip'),
    bar = document.querySelector('#book .bk-bar');
  const keysOf = (el, across) =>
    [...el.querySelectorAll('.bk-btn')]
      .filter(b => b.checkVisibility({ visibilityProperty: true }))
      .map(b => {
        const r = b.getBoundingClientRect(),
          on = (dx, dy) =>
            document.elementFromPoint(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy)?.closest('.bk-btn') === b,
          d = touchPx / 2 - 1;
        return {
          name: b.getAttribute('aria-label'),
          reach: b.disabled || (across ? on(-d, 0) && on(d, 0) : on(0, -d) && on(0, d)),
          ...box(b),
        };
      });
  const names = part => keysOf(bar.querySelector(`.bk-bar-${part}`), false).map(k => k.name);
  return {
    sat: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0,
    paper: box(document.querySelector('#book .bk-paper')),
    desk: box(document.querySelector('#book .bk-pages .bk-desk')),
    controls: box(document.querySelector('#book .bk-controls')),
    // (the paper's own width, as the bar's container query reads it)
    across: document.querySelector('#book .bk-rail').getBoundingClientRect().width,
    strip: box(strip),
    bar: box(bar),
    where: box(bar.querySelector('.bk-where')),
    scrolls: [strip, bar]
      .filter(el => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)
      .map(el => el.className),
    tools: keysOf(strip, true),
    keys: keysOf(bar, false),
    start: names('start'),
    middle: names('middle'),
    end: names('end'),
    // (the overview's own tools are in its head)
    floating: [...document.querySelectorAll('#book .bk-island')]
      .filter(el => el.getBoundingClientRect().width && !el.closest('.bk-strip, .bk-bar, .bk-far-head'))
      .map(el => el.dataset.island),
  };
}
// (in the page) What takes a press in the book and shows, any of it above the blurred strip's foot (--sat): their names
function pressableAbove() {
  const sat = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0;
  return [...document.querySelectorAll('#book :is(button, input, a[href], [role=button], [role=separator])')]
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.width && r.height && r.bottom > 0 && r.right > 0 && r.top < sat - 0.5 && el.checkVisibility();
    })
    .map(el => el.getAttribute('aria-label') || el.className);
}
