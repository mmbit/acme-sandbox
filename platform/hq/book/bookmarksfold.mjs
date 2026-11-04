// book-check.mjs's stories of a book's bookmarks as real ribbon (shell/ink/bookmarks.css; the Ink README, Bookmarks). On
// a phone, all the while the book swings open (and held mid-swing by a finger), they stick straight out of its
// fore-edge, never over its page, out of a page block thicker for them, and fold in at the screen's left edge only once
// it has landed. Folded, all three alike: as strong (Asks with no pages as strong as the others), the same
// shade, the same length out, each icon as clear of the screen's edge. And no outline on any of them, folded or out on
// the phone, on an iPad upright and sideways and on a desktop: their shade alone sets them off the paper. On My journal
// with no Asks page yet, open on a sketch (Sketch the page's own). Recorded with --shots: the phone mid-swing,
// landed and folded.
import assert from 'node:assert/strict';
import { LOADED_MS, pressAlong, until } from './kit.mjs';
import { blurred } from './islands.mjs';
import { SEED, SIZES, onBook, tabs } from './bookmarks.mjs';
import { SIZES as REAL, opened } from './realbook.mjs';

// My journal with no Asks page, so its tab is an empty chapter's, as on the board's phone
const NO_ASKS = { ...SEED, pages: SEED.pages.filter(p => p.kind !== 'asks') };
// the page block's thickness a marked book shows from the side as it swings (px), at least
const THICK_PX = 24;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function bookmarksFoldStories(c) {
  return {
    "the book's bookmarks on a phone: out of the book's fore-edge while it swings open, its page block thicker for them, folded at the screen's edge only once it lands":
      browser => swingIn(browser, c),
    "the book's bookmarks folded alike: as strong and the same shade, the same length out, each icon clear of the screen's edge":
      async browser => {
        for (const name of ['phone', 'ipad-mini-upright'])
          await onBook(browser, c, name, SIZES[name], NO_ASKS, p => alike(p, c, name));
      },
    "the book's bookmarks the same ribbons in every look, Slate, Brownstone and Holo, folded and out, beside HQ's page and on a desktop":
      async browser => {
        for (const name of ['iphone', 'ipad', 'ipad-upright', 'desktop']) await inEveryLook(browser, c, name);
      },
    "the book's bookmarks have no outline, only their shade, folded and out, beside HQ's page and on a desktop":
      async browser => {
        for (const name of ['phone', 'ipad-mini-sideways', 'desktop-wide'])
          await onBook(browser, c, name, SIZES[name], NO_ASKS, (p, press) => unlined(p, c, name, press));
      },
  };
}

// The phone's book tapped open from shut, every frame of its swing watched; then shut and lifted by a finger on its
// pull tab, held mid-swing. Every picture taken before the story fails on what it saw.
async function swingIn(browser, c) {
  const { sat, width, height } = SIZES.phone,
    context = await c.hqIn(
      browser,
      { width, height },
      { notebooks: structuredClone(NO_ASKS), hasTouch: true, isMobile: true },
    );
  await blurred(context, { sat });
  const p = await context.newPage(),
    errors = [];
  p.on('pageerror', e => errors.push(e.message));
  try {
    await p.goto(`${c.base}/?intro=0`);
    await c.settled(p, 'folded');
    await until(async () => (await tabs(p)).length === 3, 'three bookmarks in the shut book', LOADED_MS);
    const failed = [...(await swungOpen(p, c)), ...(await heldMidSwing(p, c))];
    c.noErrorsIn(errors);
    assert.deepEqual(failed, [], failed.join('\n'));
  } catch (e) {
    await c.shot('bookmarksfold-phone-failed', p);
    e.message = `phone: ${e.message} (page errors: ${errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await context.close();
  }
}
// What's wrong of what each check says (an assertion's message), the rest of the story played on regardless
const judged = (failed, what) => {
  try {
    what();
  } catch (e) {
    failed.push(e.message);
  }
};
// The shut book tapped open, every frame of its swing watched, and landed: → what's wrong
async function swungOpen(p, c) {
  const failed = [];
  await watched(p);
  await p.locator('#book .bk-lip').tap({ timeout: LOADED_MS });
  await c.settled(p, 'spread');
  const frames = await p.evaluate(() => window.__swung),
    seen = frames.filter(f => f.edge.x > 2 && f.edge.right < f.width - 2);
  judged(failed, () => assert.ok(seen.length >= 2, `the swing seen: ${seen.length} of ${frames.length} frames`));
  judged(failed, () => seen.forEach(f => out(f, 'swinging open')));
  // (landed, they fold in from past the screen's edge: never further out than folded on the way)
  await until(() => p.evaluate(() => window.__landed.length >= 40), 'the frames after the landing');
  for (const f of await p.evaluate(() => window.__landed))
    for (const t of f.tabs)
      judged(failed, () => assert.ok(t.right <= 23, `${t.chapter} folding in as it lands, ${t.right} px out`));
  await atRest(p);
  await c.shot('bookmarksfold-phone-landed', p);
  for (const t of await tabs(p))
    judged(failed, () =>
      assert.ok(t.box.x < 0 && t.box.right > 8 && t.box.right < t.box.width / 2, `landed, ${t.chapter} folded`),
    );
  return failed;
}
// The open book shut, then lifted by a finger on its pull tab and held mid-swing: the picture. → what's wrong
async function heldMidSwing(p, c) {
  const failed = [],
    lip = p.locator('#book .bk-lip');
  await lip.tap({ timeout: LOADED_MS });
  await c.settled(p, 'folded');
  const at = await lip.boundingBox(),
    y = at.y + at.height / 2,
    held = await pressAlong(
      p,
      [
        [at.x + at.width / 2, y],
        [at.x - 40, y],
        [p.viewportSize().width * 0.45, y],
      ],
      { lift: false, type: 'touch' },
    );
  await still(p);
  const mid = await p.evaluate(() => window.__frame());
  await c.shot('bookmarksfold-phone-midswing', p);
  judged(failed, () => out(mid, 'held mid-swing'));
  await held.up();
  return failed;
}
// Every frame drawn while the book swings, into __swung, from the next swing on, and the 40 after it lands into
// __landed; __frame(), one: the cover's edge, the paper, the page block's side and each tab as the screen shows them
const watched = p =>
  p.evaluate(() => {
    const book = document.getElementById('book'),
      box = el => {
        const r = el.getBoundingClientRect();
        return { x: r.left, right: r.right, width: r.width };
      };
    window.__frame = () => ({
      width: innerWidth,
      edge: box(book.querySelector('.bk-edge')),
      paper: box(book.querySelector('.bk-paper')),
      block: book.querySelector('.bk-block').offsetWidth,
      tabs: [...book.querySelectorAll('.bk-marks button')].map(b => ({ chapter: b.dataset.chapter, ...box(b) })),
    });
    window.__swung = [];
    window.__landed = [];
    const frame = () => {
      const swinging = book.classList.contains('bk-swinging');
      if (swinging) window.__swung.push(window.__frame());
      else if (window.__swung.length) window.__landed.push(window.__frame());
      if (window.__landed.length < 40) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
// A frame of the swing as the board must see it: each tab out past the cover's edge, never over the page, and the page
// block it comes out of THICK_PX thick at least
function out(f, when) {
  const at = `${when} (${JSON.stringify(f)})`;
  for (const t of f.tabs) {
    assert.ok(t.x < f.edge.x - 1, `${t.chapter} out past the book's edge, ${when}: ${t.x} by ${f.edge.x}`);
    assert.ok(t.right <= f.paper.x + 1, `${t.chapter} never over the page, ${at}`);
  }
  assert.ok(f.block >= THICK_PX, `the page block ${f.block} px thick for its bookmarks, ${when}`);
}
// The board held under the finger: the cover's edge where it was a moment ago
const still = p =>
  until(async () => {
    const was = await p.evaluate(() => document.querySelector('#book .bk-edge').style.transform);
    await p.waitForTimeout(300);
    return was && was === (await p.evaluate(() => document.querySelector('#book .bk-edge').style.transform));
  }, 'the book held still mid-swing');
// Nothing on the tabs moving any more (WebKit's transitions can stall a moment under load)
const atRest = p =>
  until(
    () =>
      p.evaluate(() => {
        const nav = document.querySelector('#book .bk-marks');
        return !document.querySelector('#book.bk-swinging') && !nav.getAnimations({ subtree: true }).length;
      }),
    'the bookmarks at rest',
    LOADED_MS,
  );

// Folded at the screen's left edge, the three alike: as strong (each in its own colours) and the same shade, as far
// out, each icon as far in from the screen's edge and clear of it; each tab's first fault, all of them told
async function alike(p, c, name) {
  await atRest(p);
  const t = await tabs(p),
    looks = await p.evaluate(() =>
      [...document.querySelectorAll('#book .bk-marks button')].map(b => {
        const s = getComputedStyle(b);
        return { shade: s.filter, opacity: s.opacity };
      }),
    );
  await c.shot(`bookmarksfold-${name}-folded`, p);
  const [first] = looks,
    failed = [];
  assert.equal(t.find(a => a.chapter === 'asks')?.here, false, `${name}: Asks not the page's own`);
  for (const [i, a] of t.entries())
    judged(failed, () => {
      assert.deepEqual(looks[i], first, `${name}: ${a.chapter} as strong and shaded as ${t[0].chapter}`);
      assert.ok(Math.abs(a.box.right - t[0].box.right) < 0.5, `${name}: ${a.chapter} out ${a.box.right} px, as far`);
      assert.ok(Math.abs(a.icon.x - t[0].icon.x) < 0.5, `${name}: ${a.chapter}'s icon ${a.icon.x} px in, as far`);
      assert.ok(a.icon.x >= 3, `${name}: ${a.chapter}'s icon clear of the screen's edge (${a.icon.x} px in)`);
    });
  assert.deepEqual(failed, [], failed.join('\n'));
}

// The bookmarks at a size (realbook.mjs's) in Slate, Brownstone and Holo: drawn alike in each, their colours, shape
// and shade the book's own, never the look's (the Ink README, The book's icons). Shot in each look, a phone's out too.
async function inEveryLook(browser, c, name) {
  const drawn = [];
  for (const look of ['wire', 'brownstone', 'holo']) {
    const { context, p, errors } = await opened(browser, c, name, { ...REAL[name], look: `&renderer=${look}` });
    try {
      await atRest(p);
      drawn.push(await ribbons(p));
      await c.shot(`bookmarks-look-${name}-${look}`, p);
      if (name === 'iphone') {
        await p.locator('#book .bk-marks [data-chapter=calls] .bk-mk-icon').click();
        await p.locator('#book .bk-marks[data-out]').waitFor({ timeout: LOADED_MS });
        await atRest(p);
        await c.shot(`bookmarks-look-${name}-${look}-out`, p);
      }
      c.noErrorsIn(errors);
    } finally {
      await context.close();
    }
  }
  for (const d of drawn.slice(1)) assert.deepEqual(d, drawn[0], `${name}: the bookmarks the same in every look`);
}
// Each bookmark as it's drawn: its cloth's colours and cut, its icon's colour, its shade
const ribbons = p =>
  p.evaluate(() =>
    [...document.querySelectorAll('#book .bk-marks button')].map(b => {
      const s = getComputedStyle(b),
        cloth = getComputedStyle(b, '::before');
      return {
        chapter: b.dataset.chapter,
        cloth: [cloth.backgroundImage, cloth.backgroundColor, cloth.clipPath],
        ink: getComputedStyle(b.querySelector('svg')).color,
        shade: s.filter,
        size: [b.offsetWidth, b.offsetHeight],
      };
    }),
  );

// No outline on any tab, folded and out on a page the whole screen, beside HQ's page and on a desktop: card set off the
// paper by its shade
async function unlined(p, c, name, press) {
  await atRest(p);
  await noOutline(p, name);
  if (await p.evaluate(() => matchMedia('(orientation: portrait)').matches)) {
    await press(p.locator('#book .bk-marks [data-chapter=sketch] .bk-mk-icon'));
    await p.locator('#book .bk-marks[data-out]').waitFor({ timeout: LOADED_MS });
    await atRest(p);
    await noOutline(p, `${name}, out`);
  }
  await c.shot(`bookmarksfold-${name}-unlined`, p);
}
const noOutline = async (p, name) => {
  const drawn = await p.evaluate(() =>
    [...document.querySelectorAll('#book .bk-marks button')].map(b => {
      const s = getComputedStyle(b),
        sides = ['Top', 'Right', 'Bottom', 'Left'];
      return {
        chapter: b.dataset.chapter,
        outline: sides.filter(
          k => parseFloat(s[`border${k}Width`]) > 0 && !/, 0\)$|transparent/.test(s[`border${k}Color`]),
        ),
        shade: s.filter,
      };
    }),
  );
  for (const d of drawn) {
    assert.deepEqual(d.outline, [], `${name}: ${d.chapter} with no outline`);
    assert.notEqual(d.shade, 'none', `${name}: ${d.chapter} shaded`);
  }
};
