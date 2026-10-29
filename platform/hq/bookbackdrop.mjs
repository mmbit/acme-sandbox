// book-check.mjs's story of the book lying over HQ (the spread) on the iPad mini: drawn out to the screen's full width
// on its side, and opened upright, nothing of HQ's page (its logo, menus, unread badges) shows round the book, its
// head still clear of Safari's top strip; the table round it comes in over HQ as the book lowers; and opened, the
// book is one size from the moment it shows till after it lands. The
// board saw HQ's buttons peeking over the notebook; a book that grew as it landed wouldn't feel like one (the board's
// call 161). Run it in WebKit too (--webkit).
import assert from 'node:assert/strict';
import { MINI } from './bookkit.mjs';

const UPRIGHT = { width: MINI.height, height: MINI.width };
// The points sampled round the book (px apart)
const GRID = 12;

// c: book-check.mjs's played store and helpers
export function backdropStories(c) {
  return {
    "the spread on the iPad mini: nothing of HQ's page shows round it, and the book never changes size": browser =>
      spread(browser, c),
  };
}

async function spread(browser, c) {
  for (const viewport of [MINI, UPRIGHT]) {
    const size = `${viewport.width}x${viewport.height}`,
      context = await c.hqIn(browser, viewport, { deviceScaleFactor: 1, pen: false }),
      page = await context.newPage(),
      errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(`${c.base}/?intro=0`);
      const sideways = viewport === MINI;
      await c.settled(page, sideways ? 'open' : 'folded');
      if (sideways) {
        // (its cover's edge drawn left as far as it goes: the board's "the full width of my screen")
        await drag(page, await middle(page, '#book .bk-edge'), -(viewport.width - 60));
        await rests(page, c, 'spread', `drawn out by its edge (${size})`);
        await covered(page, `pulled out to full width (${size})`);
        await c.shot?.(`book-backdrop-${size}-wide`, page);
        await page.locator('#book .bk-lip').evaluate(lip => lip.click());
        await rests(page, c, 'folded', `shut (${size})`);
      }
      // opened from shut (on its side it opens beside HQ again: the spread drawn by the edge isn't kept)
      await watch(page);
      // (its tab tapped: the same swing as a pull's, without a pull's timing, which a loaded engine's slow frames
      // upset)
      await page.locator('#book .bk-lip').evaluate(lip => lip.click());
      await rests(page, c, sideways ? 'open' : 'spread', `opened (${size})`);
      const { sizes, cover } = await watched(page);
      assert.equal(sizes.length, 1, `the book changed size as it opened (${size}): ${sizes.join(', ')}`);
      if (!sideways) {
        await covered(page, `opened (${size})`);
        // (the table came in over HQ as the book lowered, never all at once as it landed)
        const jump = Math.max(...cover.slice(1).map((o, i) => o - cover[i]));
        assert.ok(jump < 0.5, `the table over HQ jumped ${jump.toFixed(2)} in a frame: ${cover.join(' ')}`);
      }
      await c.shot?.(`book-backdrop-${size}`, page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

// The book's size and the table's cover over HQ's page every frame from now, till watched() reads them
function watch(page) {
  return page.evaluate(() => {
    const paper = document.querySelector('#book .bk-paper'),
      table = document.querySelector('#book .bk-table'),
      seen = (window.__seen = { sizes: new Set(), cover: [] });
    const frame = () => {
      // (shut, it's out of sight past the screen's edge)
      if (!document.querySelector('#book.bk-away'))
        seen.sizes.add(`${paper.offsetWidth}x${paper.offsetHeight} at ${paper.parentElement.offsetTop}`);
      seen.cover.push(table.offsetWidth ? Number(getComputedStyle(table).opacity) : 0);
      if (window.__seen === seen) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
const watched = page =>
  page.evaluate(() => {
    const { sizes, cover } = window.__seen;
    window.__seen = null;
    return { sizes: [...sizes], cover };
  });

// Nothing of HQ's page at any point round the book, and its head below Safari's strip (style.css's --sat) by the
// table's margin, as before
async function covered(page, when) {
  const seen = await page.evaluate(GRID => {
    const book = document.querySelector('#book .bk-leaf').getBoundingClientRect(),
      peeks = [];
    for (let y = 1; y < innerHeight; y += GRID)
      for (let x = 1; x < innerWidth; x += GRID) {
        const hit = document.elementFromPoint(x, y);
        if (!hit?.closest('#book')) peeks.push(`${x},${y} ${hit?.tagName.toLowerCase()}.${hit?.className}`);
      }
    const probe = document.createElement('div');
    probe.style.cssText = 'position: fixed; top: calc(var(--sat) + var(--bk-gap))';
    document.getElementById('book').append(probe);
    const head = probe.getBoundingClientRect().top;
    probe.remove();
    return { peeks, top: book.top, head };
  }, GRID);
  assert.deepEqual(seen.peeks.slice(0, 8), [], `HQ's page shows round the book ${when}: ${seen.peeks.length} points`);
  assert.equal(seen.top, seen.head, `the book's head ${when}`);
}

// The book at rest in a mode, or what it is instead
const rests = (page, c, mode, when) =>
  c.settled(page, mode).catch(async () => {
    const is = await page.evaluate(() => document.documentElement.dataset.book);
    assert.fail(`the book isn't ${mode} once ${when}, but ${is}`);
  });
const middle = async (page, selector) => {
  const r = await page.locator(selector).boundingBox();
  return [r.x + r.width / 2, r.y + r.height / 2];
};
// A drag, a move a frame, held still a moment before it's let go (no flick): the cover's edge stays where it's let go
async function drag(page, [x, y], dx) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(x + (dx * i) / 14, y);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await page.waitForTimeout(250);
  await page.mouse.up();
}
