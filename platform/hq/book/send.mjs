// book-check.mjs's story of a page torn to Submit (shell/ink/booktear.js, bookpagesend.js), on the played Notebook
// seeded as dev mode's (My journal's three pages, the first sent), on a phone, the iPad mini upright and on its side,
// and a desktop: the page torn off at its spine, a small copy carried over Submit, PDF and PNG over the paper while the
// controls' islands make way; let go on Submit, it folds into a paper plane and flies off, and the page stays shown,
// stamped SENT and the time within about two seconds, locked (the tools gone, and none of them changes it; no lock and
// words in their place, no Undo or Redo, the dots without Tear off and send), no page made, none
// turned to. With asks still open on it a card asks first: Answer them first sends nothing, Send now moves them to a
// new page and sends the rest. A sent sketch page offers Duplicate in its tools' place, on the iPad mini both ways and
// a desktop: a new, open page at the Sketch tab's end with everything on it, opened, that takes ink, the page sent as
// it was.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clipped, pageAt, turnTo, where } from './notebookscreen.mjs';
import { dragTo, targetsShown, tearOffMenu } from './tearing.mjs';
import { DESKTOP, MINI, UPRIGHT, inkAt, pressAlong, until } from './kit.mjs';
import { en } from '../shell/ink/notebookwordsen.js';
import { watchedPage } from './start.mjs';

const SEED = JSON.parse(await readFile(new URL('../mock/notebook.json', import.meta.url), 'utf8'));
// the seed's open page with groups in My journal (mock/notebook.json), and a group on it
const SENT = 1,
  SECOND = 2,
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
    'Duplicate a sent sketch page: under its lock, a new open page at the tab’s end with everything on it, opened':
      async browser => {
        for (const size of SIZES.filter(s => s.name !== 'phone')) await duplicated(browser, c, size);
      },
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
    // (the tool in use as the page goes: Shapes. Its key is named for its shape)
    await page.locator('#book [data-mode=shapes]').click();
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
// The copy carried over the targets, over the paper in view while the islands make way, and let go on Submit: a plane
async function carried(c, page, size) {
  await watch(page, true);
  await dragTo(page, size.touch ? 'touch' : 'mouse', 'submit', async () => {
    const m = await targetsOf(page),
      shown = await targetsShown(page);
    assert.match(m.submit, /^\w ?Submit → \w+$/, `Submit names the CEO (${size.name}): ${m.submit}`);
    assert.deepEqual(m.kinds, ['submit', 'pdf', 'png'], `Submit, PDF and PNG (${size.name})`);
    assert.ok(shown.overPaper, `over the paper, whole in view (${size.name})`);
    assert.deepEqual(shown.islands, [], `the islands made way: the tools, the bar (${size.name})`);
    await c.shot(`tear-carried-${size.name}`, page);
  });
  await page.waitForFunction(() => window.__sent.held, null, { timeout: 10_000 });
  await c.shot(`tear-plane-${size.name}`, page);
  await page.evaluate(() => window.__sent.held.forEach(a => a.play()));
}
// The page sent: locked (the tools gone, nothing but a sketch's Duplicate in their place: the stamp says it's sent),
// the stamp in view over nothing written; no Send key, no Undo or Redo, and nothing in the dots' menu to send it again
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
  assert.ok(s.toolsHidden, `locked: the tools gone (${size.name})`);
  assert.ok(!s.lock, `no lock and words in the tools' place: the stamp says it (${size.name})`);
  assert.deepEqual(s.history, [], `no Undo or Redo on the bar (${size.name})`);
  assert.ok(inside(s.box, s.paper), `the stamp on the paper in view (${size.name}): ${JSON.stringify(s.box)}`);
  // (its ink shows only within its box, its mask's: the turned outline whole inside it)
  assert.ok(inside(s.ink, s.box), `the stamp whole, uncropped (${size.name}): ${JSON.stringify([s.ink, s.box])}`);
  const under = s.over.filter(b => overlaps(s.ink, b));
  assert.ok(!under.length, `the stamp over nothing written (${size.name}): ${JSON.stringify([s.ink, under])}`);
  await c.shot(`tear-stamped-${size.name}`, page);
  assert.equal(await page.locator('#book .bk-send').count(), 0, `no Send key (${size.name})`);
  await page.locator('#book .bk-more').click();
  const rows = await page.locator('#book .bk-more-card').getByRole('menuitem').allInnerTexts();
  assert.ok(rows.length && !rows.includes(en.tearOff), `no ${en.tearOff} in the dots' menu (${size.name}): ${rows}`);
  await page.keyboard.press('Escape');
  await untouched(page, size);
}
// No tool changes the sent page: the one in use as it went (Shapes), and on a desktop each by its key; no ink lands,
// not even wet as it's drawn, no box of words, nothing picked, and Select's ⌘A and Delete take nothing off
async function untouched(page, size) {
  const desk = await page.locator('#book .bk-desk').boundingBox(),
    [x, y] = [desk.x + desk.width / 2, desk.y + desk.height / 2],
    type = size.touch ? 'pen' : 'mouse',
    box = { x: desk.x, y: desk.y, w: desk.width, h: desk.height },
    before = await onPage(page, box);
  for (const key of size.touch ? ['S'] : ['P', 'M', 'S', 'E', 'V', 'T']) {
    if (!size.touch) {
      await page.mouse.move(x, y);
      await page.keyboard.press(key.toLowerCase());
    }
    const held = await pressAlong(
      page,
      [
        [x - 80, y - 60],
        [x, y],
        [x + 80, y + 60],
      ],
      { lift: false, type },
    );
    const wet = await page.evaluate(wetInk);
    await held.up();
    await page.waitForTimeout(300);
    assert.equal(wet, 0, `no wet line on the sent page, tool ${key} (${size.name})`);
    assert.deepEqual(await onPage(page, box), before, `the sent page as it went, tool ${key} (${size.name})`);
  }
  if (size.touch) return;
  await page.keyboard.press('v');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  assert.deepEqual(await onPage(page, box), before, `⌘A and Delete take nothing off the sent page (${size.name})`);
}
// What's on the shown page: its inked pixels in box, its boxes of words, and anything picked
const onPage = async (page, box) => ({
  ink: await page.evaluate(inkAt, box),
  ...(await page.evaluate(() => ({
    typed: document.querySelectorAll('#book .bk-page:not([hidden]) .bk-typed').length,
    picked: document.querySelectorAll('#book .bk-sel').length,
  }))),
});
// (in the page) The inked pixels of the line being drawn
function wetInk() {
  const cv = document.querySelector('#book .bk-wet'),
    { data } = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) n += data[i] > 0;
  return n;
}

// Asks still open on the page: a card from Submit asks first. Answer them first: nothing sent, the copy back at the
// spine. Send now (from the dots' Tear off and send): the open ask moved to a new page, the rest sent.
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
      await (await tearOffMenu(page)).getByRole('menuitem', { name: /Submit/ }).click();
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

// The sent page duplicated from its lock: the copy at the Sketch tab's end, open, with the same units, turned to and
// drawn on; the page sent unchanged. An open page has no Duplicate.
async function duplicated(browser, c, size) {
  const { page, play, errors, done } = await open(browser, c, size),
    key = page.locator('#book').getByRole('button', { name: 'Duplicate this page' });
  try {
    const before = pagesOf(play),
      sent = unitsOf(play, before[0].id);
    assert.ok(!(await key.isVisible()), `no Duplicate on an open page (${size.name})`);
    await turnTo(page, SENT);
    assert.ok((await stampOf(page)).toolsHidden, `the sent page locked (${size.name})`);
    await until(() => key.isVisible(), `Duplicate in the tools' place (${size.name})`);
    await c.shot(`duplicate-offered-${size.name}`, page);
    await (size.touch ? key.tap() : key.click());
    const copy = await until(() => pagesOf(play)[before.length], `a page made (${size.name})`);
    assert.equal(copy.chapter, 'sketch', `the copy in the Sketch tab (${size.name})`);
    assert.ok(!copy.sent && !copy.sending, `the copy open (${size.name})`);
    assert.deepEqual(unitsOf(play, copy.id), sent, `everything on it, where it was (${size.name})`);
    await until(
      async () => (await pageAt(page))?.join() === `${before.length + 1},${before.length + 1}`,
      () => `turned to the copy (${size.name})`,
    );
    const shown = await stampOf(page);
    assert.ok(
      !shown.toolsHidden && shown.history.length === 2 && !(await key.isVisible()),
      `the tools back (${size.name})`,
    );
    await until(async () => !(await page.locator('#book .bk-turn-picture').count()), `the leaf turned (${size.name})`);
    const desk = await page.locator('#book .bk-desk').boundingBox(),
      [x, y] = [desk.x + desk.width / 2, desk.y + desk.height * 0.7];
    await pressAlong(
      page,
      [
        [x - 60, y],
        [x, y - 20],
        [x + 60, y],
      ],
      { type: size.touch ? 'pen' : 'mouse' },
    );
    await until(
      () => unitsOf(play, copy.id).flatMap(u => u.ink).length > sent.flatMap(u => u.ink).length,
      `ink on the copy (${size.name})`,
    );
    await c.shot(`duplicate-made-${size.name}`, page);
    assert.ok(pageOf(play, before[0].id).sent, `the page sent stays sent (${size.name})`);
    assert.deepEqual(unitsOf(play, before[0].id), sent, `the page sent as it was (${size.name})`);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
// HQ at a size on the played Notebook, the book open on the seed's second page (folded ones opened by the lip, as
// notebook.mjs's open)
async function open(browser, c, { viewport, touch, folded, isMobile }, seed = structuredClone(SEED)) {
  const context = await c.hqIn(browser, viewport, { notebooks: seed, hasTouch: touch, ...(isMobile && { isMobile }) });
  const { page, errors } = await watchedPage(context);
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
// The targets while the copy is carried: their kinds shown and Submit's words
const targetsOf = page =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('#book .bk-share [data-share]')].filter(b => !b.hidden);
    return { kinds: shown.map(b => b.dataset.share), submit: shown[0].innerText.replace(/\s+/g, ' ').trim() };
  });
// The shown page's stamp: its words, box and ink (its turned outline), the paper's, what's written on the page (its
// title and units), and whether it's locked: its lock and words in the tools' place, the tools hidden, and Undo and
// Redo on the bar
const stampOf = page =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden),
      node = shown.querySelector('[data-slot=stamp]'),
      box = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    return {
      label: node.querySelector('svg')?.getAttribute('aria-label') ?? '',
      box: box(node.getBoundingClientRect()),
      ink: node.querySelector('rect') && box(node.querySelector('rect').getBoundingClientRect()),
      paper: box(document.querySelector('#book .bk-desk').getBoundingClientRect()),
      // (the title by its words' own box: its line runs the page's width)
      over: [...shown.querySelectorAll('.bk-unit, .bk-page-title, .bk-day')].map(el => {
        const words = document.createRange();
        words.selectNodeContents(el);
        return box(el.matches('.bk-unit') ? el.getBoundingClientRect() : words.getBoundingClientRect());
      }),
      lock: !!document.querySelector('#book .bk-locked')?.checkVisibility(),
      history: [...document.querySelectorAll('#book .bk-bar :is(.bk-undo, .bk-redo)')]
        .filter(b => b.checkVisibility())
        .map(b => b.ariaLabel),
      toolsHidden: !document
        .querySelector("#book .bk-island[data-island='tools']")
        ?.checkVisibility({ visibilityProperty: true }),
    };
  });
const inside = (a, b) => a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// ---- the played store
const pagesOf = play => play.route('/api/notebooks/pages', { notebook: 1 }).pages;
const pageOf = (play, id) => pagesOf(play).find(p => p.id === id);
// A page's units as the store keeps them, what makes them the same on a copy
const unitsOf = (play, id) =>
  play
    .route('/api/notebooks/pages/groups', { page: id })
    .groups.map(({ kind, ink, texts, pictures, words, h, place }) => ({ kind, ink, texts, pictures, words, h, place }));
