// book-check.mjs's story of the tools' cards and the panels beside the book's islands as the brand guide has them (the
// Ink README, "The book's frame": the tools' cards), on the board's iPhone (390 × 844) and an iPad (1133 × 744, and the
// mini upright), in Slate, Brownstone and Holo: a card that can't be pressed lies flat, never on a key's base (the pen's
// and the shapes' cards, the preferences, the dots menu); in a card the spacing narrows inward,
// its margin at the edge wider than the gaps between its colours and between its icons; with the colours four to a
// line (a phone's), each line of the pen's and the shapes' card as far from its right edge as from its left; the pen's
// and the marker's colour dot clear of its icon on the island; and the shapes' card has only shapes in its first row,
// outline and fill beside the widths behind a rule. Recorded with --shots.
import assert from 'node:assert/strict';
import { PREFERENCES, middleOf, openScrap } from './kit.mjs';
import { mouseOf } from './hands.mjs';
import { paperBox } from './mouse.mjs';
import { SIZES, opened } from './realbook.mjs';

const AT = {
  iphone: SIZES.iphone,
  'iphone-sideways': { width: 844, height: 390 },
  ipad: SIZES.ipad,
  'ipad-upright': SIZES['ipad-upright'],
};
const LOOKS = { slate: '&renderer=wire', brownstone: '&renderer=brownstone', holo: '&renderer=holo' };
// a dot's room from its icon on the island, at least (px)
const CLEAR = 5;
// a card line's margin at its right may differ from its left by this, at most (px)
const EVEN = 3;

// c: book-check.mjs's played store and helpers
export function menuStories(c) {
  return {
    "the tools' cards and panels lie flat, on no key's base, their spacing narrowing inward; the colour dot clear of its tool; the shapes' fill beside the widths":
      async browser => {
        const failed = [];
        for (const [look, address] of Object.entries(LOOKS))
          for (const [name, size] of Object.entries(AT))
            await atSize(browser, c, `${name}-${look}`, { ...size, look: address }, what =>
              failed.push(`${name} in ${look}: ${what}`),
            ).catch(e => failed.push(`${name} in ${look}: ${e.message}`));
        assert.deepEqual(failed, [], failed.join('\n'));
      },
  };
}

// (failed(what): a check that didn't hold, the rest still checked)
async function atSize(browser, c, name, size, failed) {
  const { context, p, errors } = await opened(browser, c, name, size),
    check = async step => step().catch(e => failed(e.message));
  try {
    await p.locator('#book .bk-more').click();
    await p.locator('#book .bk-more-card').waitFor();
    await c.shot(`menus-${name}-dots`, p);
    await check(() => lying(p, '.bk-more-card', 'the dots menu'));
    await p.locator('#book .bk-more-card').getByRole('menuitem', { name: PREFERENCES, exact: true }).click();
    await p.locator('#book .bk-prefs').waitFor();
    await settled(p, '#book .bk-prefs');
    await c.shot(`menus-${name}-preferences`, p);
    await check(() => lying(p, '.bk-prefs', 'the preferences'));
    await p.keyboard.press('Escape');
    await p.locator('#book .bk-prefs').waitFor({ state: 'detached' });
    // (the tools' cards on a scrap opened: the tools an opened scrap's.)
    await openScrap(p, mouseOf(p), undefined, middleOf(await paperBox(p)));
    await check(() => dotsClear(p, 'pen'));
    await opens(p, 'pen');
    await c.shot(`menus-${name}-pen`, p);
    await check(() => lying(p, '.bk-palette', "the pen's card"));
    await check(() => clearOfTools(p, "the pen's card"));
    await check(() => narrowing(p, "the pen's card"));
    await check(() => balanced(p, "the pen's card"));
    await p.locator('#book .bk-palette').getByRole('menuitemradio', { name: 'Marker', exact: true }).click();
    await settled(p, '#book .bk-palette');
    await check(() => narrowing(p, "the marker's card"));
    await p.keyboard.press('Escape');
    await check(() => dotsClear(p, 'highlighter'));
    await c.shot(`menus-${name}-marker`, p);
    await p.locator("#book .bk-strip .bk-btn[data-mode='shapes']").click();
    await opens(p, 'shapes');
    await c.shot(`menus-${name}-shapes`, p);
    await check(() => shapesApart(p));
    await check(() => clearOfTools(p, "the shapes' card"));
    await check(() => narrowing(p, "the shapes' card"));
    await check(() => balanced(p, "the shapes' card"));
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}

// The tool in use pressed again: its card, at rest
async function opens(p, mode) {
  await p.locator(`#book .bk-strip .bk-btn[data-mode='${mode}']`).click();
  await settled(p, '#book .bk-palette');
}
const settled = (p, selector) =>
  p.locator(selector).evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));

// A card lying flat: no key's base under it (the Ink README, the tools' cards: if it looks like a key, it presses), a
// key's base being a hard shadow straight below it, unblurred, as the look draws a key's lip
async function lying(p, selector, what) {
  const lips = await p.locator(`#book ${selector}`).evaluate(el =>
    getComputedStyle(el)
      .boxShadow.split(/,(?![^(]*\))/)
      .map(s => s.trim())
      .filter(s => {
        if (s === 'none' || s.includes('inset')) return false;
        const [x, y, blur = 0] = s
          .replace(/\w+\([^)]*\)/g, '')
          .match(/-?[\d.]+px/g)
          .map(parseFloat);
        return x === 0 && y > 0 && blur === 0;
      }),
  );
  assert.deepEqual(lips, [], `${what} lies flat, on no key's base`);
}

// In the open card, each row's drawn things (a colour's disc, an icon's lines) further from the card's edge than from
// each other: a row's margin (from the card's left edge, from its top for the first row, from its right for a row as
// wide as the card) wider than the widest gap between two of its things side by side, or between two colours one
// over the other
async function narrowing(p, what) {
  const rows = await p.locator('#book .bk-palette').evaluate(card => {
    const c = card.getBoundingClientRect(),
      // (what a button draws: a colour's own disc, else its icon's lines)
      drawn = b =>
        (b.querySelector('circle:last-of-type[stroke]') ?? b.querySelector('svg > *')).getBoundingClientRect(),
      rows = [...card.querySelectorAll('.bk-palette-row')],
      widest = Math.max(...rows.map(r => r.getBoundingClientRect().right));
    return rows.map((r, n) => {
      const things = [...r.querySelectorAll('.bk-btn')].map(drawn);
      let margin = things[0].left - c.left,
        gap = 0;
      if (n === 0) margin = Math.min(margin, Math.min(...things.map(t => t.top)) - c.top);
      if (r.getBoundingClientRect().right === widest) margin = Math.min(margin, c.right - things.at(-1).right);
      for (let i = 1; i < things.length; i++)
        if (Math.abs(things[i].top - things[i - 1].top) < 2) gap = Math.max(gap, things[i].left - things[i - 1].right);
        else {
          // (a colour on the line under the last: its gap down to the one over it)
          const over = things.filter(t => Math.abs(t.left - things[i].left) < 2 && t.bottom <= things[i].top).at(-1);
          gap = Math.max(gap, things[i].top - (over?.bottom ?? things[i].top));
        }
      return { row: r.getAttribute('aria-label'), margin: Math.round(margin), gap: Math.round(gap) };
    });
  });
  for (const { row, margin, gap } of rows)
    assert.ok(
      margin > gap,
      `${what}, its ${row}: the margin at the card's edge (${margin} px) wider than the gaps inside (${gap} px)`,
    );
}

// With the colours four to a line (a phone's), each line of the open card as far from the card's right edge as from its
// left (its first key's room to the left edge, its last's to the right), within EVEN px. (Six to a line, the colours
// are the card's width and the narrower lines keep to their columns from the left: booktools.css.)
async function balanced(p, what) {
  const lines = await p.locator('#book .bk-palette').evaluate(card => {
    const c = card.getBoundingClientRect(),
      colours = card.querySelector('.bk-palette-row[data-colours]');
    if (getComputedStyle(colours).gridTemplateColumns.split(' ').length !== 4) return [];
    return [...card.querySelectorAll('.bk-palette-line')].map(line => {
      const keys = [...line.querySelectorAll('.bk-btn')].map(b => b.getBoundingClientRect());
      return {
        line: [...line.querySelectorAll('.bk-palette-row')].map(r => r.getAttribute('aria-label')).join(' and '),
        left: Math.round(Math.min(...keys.map(k => k.left)) - c.left),
        right: Math.round(c.right - Math.max(...keys.map(k => k.right))),
      };
    });
  });
  for (const { line, left, right } of lines)
    assert.ok(
      Math.abs(left - right) <= EVEN,
      `${what}, its ${line}: as far from the card's right edge (${right} px) as from its left (${left} px)`,
    );
}

// The open tool's card left of the tools, clear of them and of the bookmarks beside it (folded at a phone's left edge),
// and on the screen
async function clearOfTools(p, what) {
  const [card, tools] = await Promise.all(
    ['#book .bk-palette', '#book .bk-strip'].map(s => p.locator(s).evaluate(el => el.getBoundingClientRect().toJSON())),
  );
  assert.ok(
    card.left >= 0 && card.right <= tools.left,
    `${what} left of the tools, clear of them (${Math.round(card.left)} to ${Math.round(card.right)}, the tools from ${Math.round(tools.left)})`,
  );
  const marks = await p
    .locator('#book .bk-marks button')
    .evaluateAll(bs => bs.map(b => ({ chapter: b.dataset.chapter, ...b.getBoundingClientRect().toJSON() })));
  for (const m of marks.filter(m => m.bottom > card.top && m.top < card.bottom))
    assert.ok(
      m.right <= card.left,
      `${what} clear of the ${m.chapter} bookmark (the card from ${Math.round(card.left)}, the bookmark to ${Math.round(m.right)})`,
    );
}

// The ink's colour dot under its tool on the island, clear of the icon's lines by CLEAR px (mode: the pen or the marker,
// the one in use)
async function dotsClear(p, mode) {
  const room = await p.locator(`#book .bk-strip .bk-btn[data-mode='${mode}']`).evaluate(b => {
    const svg = b.querySelector('svg'),
      scale = svg.getBoundingClientRect().height / svg.viewBox.baseVal.height,
      lines = [...svg.querySelectorAll('g > *')].filter(el => getComputedStyle(el).display !== 'none'),
      width = el => +(el.getAttribute('stroke-width') ?? el.parentNode.getAttribute('stroke-width') ?? 0),
      foot = Math.max(...lines.map(el => el.getBoundingClientRect().bottom + (width(el) / 2) * scale)),
      dot = getComputedStyle(b, '::before'),
      top = b.getBoundingClientRect().bottom - parseFloat(dot.bottom) - parseFloat(dot.height);
    return Math.round((top - foot) * 10) / 10;
  });
  assert.ok(room >= CLEAR, `the ${mode}'s colour dot ${CLEAR} px clear of its icon (${room} px)`);
}

// The shapes' card: its first row the shapes alone; outline and fill on the widths' line, a rule upright between them
async function shapesApart(p) {
  const { shapes, beside, rule } = await p.locator('#book .bk-palette').evaluate(card => {
    const row = name => card.querySelector(`.bk-palette-row[aria-label='${name}']`),
      fill = row('Fill'),
      width = row('Width'),
      between = fill.previousElementSibling,
      r = between?.getBoundingClientRect();
    return {
      shapes: [...row('Shape').querySelectorAll('.bk-btn')].map(b => b.getAttribute('aria-label')),
      beside: fill.parentNode === width.parentNode,
      rule: between?.localName === 'hr' && r.height > r.width,
    };
  });
  assert.equal(shapes.length, 4, `the shapes' row holds the shapes alone (${shapes.join(', ')})`);
  assert.ok(beside, "outline and fill on the widths' line");
  assert.ok(rule, 'an upright rule between the widths and outline and fill');
}
