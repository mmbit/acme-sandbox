// book-check.mjs's story of a page torn to Submit (shell/ink/bookdogear.js, bookpagesend.js), on the played Notebook
// seeded as dev mode's (My journal's three pages, the first sent), on a phone, the iPad mini upright and on its side,
// and a desktop: the dog-ear drawn away, a torn copy carried over Submit, PDF and PNG in the rail's place, never over the
// tools; let go on Submit, it folds into a paper plane and flies off, and the page stays shown, stamped SENT and the time
// within about two seconds, locked (the tools gone, "Sent, locked" in their place), no page made, none turned to. With
// asks still open on it a card asks first: Answer them first sends nothing, Send now moves them to a new page and sends
// the rest.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clipped, turnTo, where } from './booknotebookscreen.mjs';
import { cornerOf, dragTo } from './bookshare.mjs';
import { DESKTOP, MINI, UPRIGHT, until } from './bookkit.mjs';

const SEED = JSON.parse(await readFile(new URL('./mock/notebook.json', import.meta.url), 'utf8'));
// the seed's open page with groups in My journal (mock/notebook.json), and a group on it
const SECOND = 2,
  NEWEST = 3,
  ASKING = 6;
const SIZES = [
  { name: 'phone', viewport: { width: 390, height: 844 }, touch: true, folded: true, isMobile: true },
  { name: 'mini-upright', viewport: UPRIGHT, touch: true, folded: true },
  { name: 'mini-side', viewport: MINI, touch: true },
  { name: 'desktop', viewport: DESKTOP, touch: false },
];
// the stamp pressed this soon after the copy is let go, at most, in the page's own time (a loaded worker's timers come
// late: some room)
const STAMP_MS = 2600;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function sendStories(c) {
  return {
    'Tear to Submit: the copy carried over Submit, PDF and PNG; a plane flies, the page stays, stamped and locked, no page made':
      async browser => {
        for (const size of SIZES) await torn(browser, c, size);
      },
    'Tear to Submit with asks still open: a card asks first; Answer them first sends nothing, Send now moves them on':
      browser => withAsks(browser, c),
  };
}

// The second page torn out for the pictures (the copy carried, the plane held mid-flight), the third timed with none
// (a shot holds up the page's own timers)
async function torn(browser, c, size) {
  const { page, play, errors, done } = await open(browser, c, size);
  try {
    const count = pagesOf(play).length;
    await carried(c, page, size);
    await turnTo(page, NEWEST);
    const at = await where(page);
    await watch(page);
    await dragTo(page, size.touch ? 'touch' : 'mouse', 'submit');
    await until(async () => /^Sent \d\d:\d\d$/.test((await stampOf(page)).label), `stamped (${size.name})`);
    const seen = await page.evaluate(() => window.__sent),
      late = Math.round(seen.stamped - seen.dropped);
    assert.ok(late > 0 && late < STAMP_MS, `stamped within about two seconds (${size.name}): ${late} ms`);
    assert.ok(pageOf(play, NEWEST).sent, `sent at once (${size.name})`);
    await until(async () => !(await page.locator('#book .bk-fx-plane').count()), `the plane gone (${size.name})`);
    assert.deepEqual([seen.planes, seen.turns], [1, []], `one plane, turned to nothing (${size.name})`);
    assert.equal(await where(page), at, `the page stays shown (${size.name})`);
    assert.equal(pagesOf(play).length, count, `no page made (${size.name})`);
    await locked(c, page, size);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
// The copy carried over the targets, in view and clear of the rail's controls, and let go on Submit: a plane
async function carried(c, page, size) {
  await watch(page, true);
  await dragTo(page, size.touch ? 'touch' : 'mouse', 'submit', async () => {
    const m = await lane(page);
    assert.match(m.submit, /^\w ?Submit → \w+$/, `Submit names the CEO (${size.name}): ${m.submit}`);
    assert.deepEqual(m.kinds, ['submit', 'pdf', 'png'], `Submit, PDF and PNG (${size.name})`);
    assert.deepEqual(m.covering, [], `clear of the rail's controls: the tools, the page bar, More (${size.name})`);
    const t = m.targets;
    assert.ok(
      t.left >= 0 && t.top >= 0 && t.right <= m.view.width && t.bottom <= m.view.height,
      `whole in view (${size.name}): ${JSON.stringify(m)}`,
    );
    await c.shot(`tear-carried-${size.name}`, page);
  });
  await page.waitForFunction(() => window.__sent.held, null, { timeout: 10_000 });
  await c.shot(`tear-plane-${size.name}`, page);
  await page.evaluate(() => window.__sent.held.forEach(a => a.play()));
}
// The page sent: locked (the tools gone, "Sent, locked" in their place), the stamp in view over nothing written; no
// Send key, and the corner's menu without Submit
async function locked(c, page, size) {
  // (the stamp pressed all the way down)
  await page.evaluate(() =>
    Promise.all(
      document
        .querySelectorAll('#book [data-slot=stamp]')
        .values()
        .flatMap(n => n.getAnimations().map(a => a.finished)),
    ),
  );
  const s = await stampOf(page);
  assert.ok(s.locked && s.toolsHidden, `locked: the tools gone, "Sent, locked" in their place (${size.name})`);
  assert.ok(inside(s.box, s.paper), `the stamp on the paper in view (${size.name}): ${JSON.stringify(s.box)}`);
  assert.ok(!s.over.some(b => overlaps(s.box, b)), `the stamp over nothing written (${size.name})`);
  await c.shot(`tear-stamped-${size.name}`, page);
  assert.equal(await page.locator('#book .bk-send').count(), 0, `no Send key (${size.name})`);
  await (await cornerOf(page)).click();
  const menu = page.getByRole('menu', { name: 'Where this page goes' });
  await menu.waitFor({ timeout: 10_000 });
  const kinds = await menu
    .getByRole('menuitem')
    .evaluateAll(items => items.filter(i => !i.hidden).map(i => i.dataset.share));
  assert.deepEqual(kinds, ['pdf', 'png'], `only PDF and PNG (${size.name})`);
  await page.keyboard.press('Escape');
}

// Asks still open on the page: a card from Submit asks first. Answer them first: nothing sent, the copy back in the
// corner. Send now (from the corner's menu): the open ask moved to a new page, the rest sent.
async function withAsks(browser, c) {
  const seed = structuredClone(SEED);
  Object.assign(
    seed.groups.find(g => g.id === ASKING),
    { note: 99 },
  );
  seed.asks.push({ ...seed.asks[0], id: 2, note: 99, agent: 'juno', name: 'Juno', title: 'Logo left or centred?' });
  for (const size of [SIZES[0], SIZES.at(-1)]) {
    const { page, play, errors, done } = await open(browser, c, size, seed);
    try {
      const count = pagesOf(play).length;
      await dragTo(page, size.touch ? 'touch' : 'mouse', 'submit');
      const card = page.getByRole('dialog', { name: 'Asks still open' });
      await card.waitFor({ timeout: 3000 });
      assert.match(await card.innerText(), /1 ask is still open\s+Juno’s ask waits on you/);
      // (shown all the way in)
      await card.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
      await c.shot(`tear-asks-open-${size.name}`, page);
      await card.getByRole('button', { name: 'Answer it first' }).click();
      await until(async () => !(await page.locator('#book > .bk-held').count()), `the copy back (${size.name})`);
      assert.ok(!pageOf(play, SECOND).sent, `nothing sent (${size.name})`);
      await (await cornerOf(page)).click();
      await page.getByRole('menuitem', { name: /Submit/ }).click();
      await card.getByRole('button', { name: 'Send now, move it to a new page' }).click();
      await until(() => pageOf(play, SECOND).sent, `sent (${size.name})`);
      const moved = play.route('/api/notebooks/pages/groups', { page: pagesOf(play).at(-1).id }).groups;
      assert.equal(pagesOf(play).length, count + 1, `a new page for the ask (${size.name})`);
      assert.deepEqual(
        moved.map(g => [g.id, g.status]),
        [[ASKING, 'open']],
        `the open ask on it, to answer there (${size.name})`,
      );
      c.noErrorsIn(errors);
    } finally {
      await done();
    }
  }
}

// ---- the page

// HQ at a size on the played Notebook, the book open on the seed's second page (folded ones opened by the lip, as
// booknotebook.mjs's open)
async function open(browser, c, { viewport, touch, folded, isMobile }, seed = structuredClone(SEED)) {
  const context = await c.hqIn(browser, viewport, { notebooks: seed, hasTouch: touch, ...(isMobile && { isMobile }) }),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#book .bk-desk', { state: 'attached', timeout: 30_000 });
  if (folded) {
    await c.settled(page, 'folded');
    await page.locator('#book .bk-lip').evaluate(lip => lip.click());
  }
  await c.settled(page, folded ? 'spread' : 'open');
  await until(async () => (await clipped(page)).length, 'the groups drawn');
  await turnTo(page, SECOND);
  return { page, play: context.notebook, errors, done: () => context.close() };
}
// What the book does from here: planes flying (hold: the plane held mid-flight, its animations kept in held), pages turned to (book:turn),
// when the copy was let go and the stamp pressed (the page's own time)
const watch = (page, hold = false) =>
  page.evaluate(hold => {
    const seen = (window.__sent = { planes: 0, turns: [], dropped: 0, stamped: 0, held: null });
    document.addEventListener('book:turn', e => seen.turns.push(e.detail.page));
    addEventListener(
      'pointerup',
      () => {
        seen.dropped = performance.now();
        if (hold)
          setTimeout(() => {
            seen.held = document.querySelector('#book .bk-fx-plane')?.getAnimations({ subtree: true }) ?? [];
            // (at the same point of its flight however late the page's timers came: a dart in the air, on its way up)
            seen.held.forEach(a => {
              a.pause();
              a.currentTime = 720;
            });
          }, 550);
      },
      { capture: true, once: true },
    );
    new MutationObserver(changes => {
      for (const n of changes.flatMap(m => [...m.addedNodes])) {
        if (n.classList?.contains('bk-fx-plane')) seen.planes++;
        // (the shown page's stamp once the copy is let go: another's is drawn again as the pages are read)
        if (seen.dropped && n.parentElement?.matches('.bk-page:not([hidden]) [data-slot=stamp]'))
          seen.stamped ||= performance.now();
      }
    }).observe(document.getElementById('book'), { childList: true, subtree: true });
  }, hold);
// The lane while the copy is carried: the targets and what shows on them, the rail's controls still showing over
// them, the screen
const lane = page =>
  page.evaluate(() => {
    const box = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }),
      overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
      targets = document.querySelector('#book .bk-share'),
      at = box(targets.getBoundingClientRect()),
      shown = [...targets.querySelectorAll('[data-share]')].filter(b => !b.hidden);
    return {
      kinds: shown.map(b => b.dataset.share),
      submit: shown[0].innerText.replace(/\s+/g, ' ').trim(),
      targets: at,
      covering: [...document.querySelector('#book .bk-column').children]
        .filter(el => el.checkVisibility({ visibilityProperty: true }) && overlaps(box(el.getBoundingClientRect()), at))
        .map(el => el.dataset.island ?? el.className),
      view: { width: innerWidth, height: innerHeight },
    };
  });
// The shown page's stamp: its words and box, the paper's, what's written on the page (its title and units), and whether
// it's locked
const stampOf = page =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden),
      node = shown.querySelector('[data-slot=stamp]'),
      box = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    return {
      label: node.querySelector('svg')?.getAttribute('aria-label') ?? '',
      box: box(node.getBoundingClientRect()),
      paper: box(document.querySelector('#book .bk-desk').getBoundingClientRect()),
      // (the title by its words' own box: its line runs the page's width)
      over: [...shown.querySelectorAll('.bk-unit, .bk-page-title, .bk-day')].map(el => {
        const words = document.createRange();
        words.selectNodeContents(el);
        return box(el.matches('.bk-unit') ? el.getBoundingClientRect() : words.getBoundingClientRect());
      }),
      locked: !!document.querySelector('#book .bk-locked')?.checkVisibility(),
      toolsHidden: !document.querySelector('#book .bk-strip')?.checkVisibility(),
    };
  });
const inside = (a, b) => a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// ---- the played store
const pagesOf = play => play.route('/api/notebooks/pages', { notebook: 1 }).pages;
const pageOf = (play, id) => pagesOf(play).find(p => p.id === id);
