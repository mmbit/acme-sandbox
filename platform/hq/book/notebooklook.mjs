// book-check.mjs's story of the Notebook's look as the board found it on its iPad: in every HQ look, on an iPad mini on
// its side and held upright. Each post-it one layer of paper; the page scrolls up and down, never sideways; the seen
// mark the agent's own face with a tick drawn as the Notebook's, no HQ pixel icon on the paper; Rename page in the dots
// menu and no pencil by the title; the bookmarks sticking out less than the pull tab, which hangs below them, a press
// anywhere on it the tab's, never a bookmark's; and shut, a finger's pull from the tab opens the book. Recorded with
// --shots: the page open, the pen's card, the dots menu, and the book shut with its pull tab.
import assert from 'node:assert/strict';
import { LOOK_SCHEMES, openScrap, say, until } from './kit.mjs';
import { restsOpen } from './start.mjs';
import { hands, mouseOf } from './hands.mjs';
import { cardInSight } from './mouse.mjs';
import { viewNow } from './canvas.mjs';
import { shapeOf } from '../shell/ink/booklayout.js';
import { typedBoxes } from '../shell/ink/notebookparts.js';

const SIZES = { ipad: { width: 1133, height: 744 }, 'ipad-upright': { width: 744, height: 1133 } };
const T0 = '2026-11-04T13:40:00.000Z';
// a wave of the board's pen across a note, in its own px
const wave = (h, color = '#2a2352') => [
  {
    color,
    size: 3,
    points: Array.from({ length: 30 }, (_, i) => [16 + i * 9, h / 2 + 18 * Math.sin(i / 2.2), 0.5, i * 16]),
  },
];
const note = (id, words, more = {}) => ({
  ...{ id, page: 1, kind: 'note', by: 'board', ink: wave(150), pictures: [], words: '', said: 'typed' },
  ...{ texts: typedBoxes(words, { x: 0, w: 300, color: '#1d1a2f' }), status: 'sent', created: T0, updated: T0 },
  ...{ pos: id, h: 150, ...more },
});
const SEED = {
  notebooks: [{ id: 1, kind: 'mine', name: 'My journal', archived: false, created: T0, updated: T0 }],
  pages: [
    { id: 1, notebook: 1, pos: 0, label: 'Test note to Juno', created: T0, updated: T0, w: 1200, h: 2400 },
    { id: 2, notebook: 1, pos: 1, label: 'Asks', kind: 'asks', created: T0, updated: T0, w: 1200, h: 2400 },
  ],
  groups: [note(1, 'Test note to Juno', { seen: 'juno' }), note(2, 'A second one, for the look')],
  slips: [],
  asks: [],
  names: { juno: 'Juno' },
};

// The book open at size in a look, its page as seeded (shut: the book folded as it last was)
async function lookAt(browser, c, { renderer, colorScheme }, size, { shut = false, seed = SEED } = {}) {
  const context = await c.hqIn(browser, size, {
    notebooks: structuredClone(seed),
    hasTouch: true,
    isMobile: false,
    colorScheme,
  });
  if (shut)
    await context.addInitScript(
      key => localStorage.setItem(key, JSON.stringify({ mode: 'folded' })),
      `hq.book.${shapeOf(size.width, size.height)}`,
    );
  const p = await context.newPage();
  await p.goto(`${c.base}/?intro=0&renderer=${renderer}`);
  if (shut) await c.settled(p, 'folded');
  else {
    await restsOpen(p, c, size);
    await until(() => p.evaluate(() => !!document.querySelector('#book .bk-unit-paper')), 'the notes on the page');
    await p.waitForTimeout(600);
  }
  return { context, p };
}

// c: book-check.mjs's hqIn, base, settled, shot
export function notebookLookStories(c) {
  return {
    "the Notebook's look as the board found it: its notes, the pen's card, the dots menu and the shut book's pull tab, in every look on an iPad":
      async browser => {
        for (const [look, how] of Object.entries(LOOK_SCHEMES))
          for (const [name, size] of Object.entries(SIZES)) {
            const at = `${look}-${name}`;
            {
              const { context, p } = await lookAt(browser, c, how, size);
              await c.shot(`look-${at}-page`, p);
              await onePaper(p, at);
              await seenFace(p, at);
              await noSideways(p, at);
              await clearOfMarks(p, at);
              await p.locator('#book .bk-more').click();
              await p.waitForTimeout(500);
              await c.shot(`look-${at}-more`, p);
              const rows = await p.locator('#book .bk-more-card [role=menuitem]').allInnerTexts();
              assert.ok(
                rows.some(r => r.includes(say('renamePage'))),
                `${at}: Rename page in the dots menu (${rows})`,
              );
              await p.keyboard.press('Escape');
              // (the pen's card on a note opened: the tools an opened scrap's.)
              await openScrap(p, mouseOf(p), undefined, await cardInSight(p));
              await p.locator('#book .bk-strip').getByRole('button', { name: 'Pen' }).first().click();
              await p.locator('#book .bk-palette').waitFor();
              await p.waitForTimeout(400);
              await c.shot(`look-${at}-pen`, p);
              await context.close();
            }
            const { context, p } = await lookAt(browser, c, how, size, { shut: true });
            await c.shot(`look-${at}-shut`, p);
            await pulledOpen(p, c, size);
            await context.close();
          }
      },
  };
}

// Each post-it one layer: its unit's paper, and its typed words on it with no paper of their own
async function onePaper(p, at) {
  const notes = await p.evaluate(() =>
    [...document.querySelectorAll('#book .bk-typed[data-note]')].map(el => ({
      under: getComputedStyle(el, '::before').content,
      fill: getComputedStyle(el).backgroundColor,
    })),
  );
  assert.equal(notes.length, 2, `${at}: both post-its' words`);
  for (const n of notes) {
    assert.equal(n.under, 'none', `${at}: a post-it's words have no paper of their own`);
    assert.match(n.fill, /rgba\(0, 0, 0, 0\)|transparent/, `${at}: nor a fill`);
  }
  assert.equal(await p.locator('#book .bk-unit .bk-unit-paper').count(), 2, `${at}: one paper a post-it`);
  // (the words on their paper, a margin round them: the words' own extent, not their box's)
  const held = await p.evaluate(() =>
    [...document.querySelectorAll('#book .bk-typed[data-note] .bk-typed-words')].map(w => {
      const range = document.createRange();
      range.selectNodeContents(w);
      const b = range.getBoundingClientRect(),
        a = [...document.querySelectorAll('#book .bk-unit .bk-unit-paper')]
          .map(paper => paper.getBoundingClientRect())
          .find(r => b.top >= r.top - 1 && b.top < r.bottom && b.left >= r.left - 1 && b.left < r.right);
      return a ? Math.min(b.left - a.left, b.top - a.top, a.right - b.right, a.bottom - b.bottom) : -1;
    }),
  );
  for (const margin of held)
    assert.ok(margin >= 4, `${at}: a post-it's words on its paper, a margin round them (${margin})`);
}
// The seen mark: the agent's own face, no letter, a tick drawn as the Notebook's, no HQ icon on the tags
async function seenFace(p, at) {
  const tag = p.locator('#book .bk-seen .bk-tag[data-seen]'); // (its own)
  await tag.waitFor();
  assert.equal(await tag.getAttribute('aria-label'), say('seenBy', { name: 'Juno' }), at);
  const face = tag.locator('.bk-answer-face');
  assert.match(await face.evaluate(el => el.style.backgroundImage), /^url\("data:image\//, `${at}: Juno's face`);
  assert.equal((await face.innerText()).trim(), '', `${at}: no letter`);
  const icons = p.locator('#book :is(.bk-tags, .bk-seen) svg[data-icon]');
  assert.equal(await icons.count(), 0, `${at}: no HQ icon on the paper's tags`);
  assert.equal(
    await p.locator('#book .bk-view-head :is(svg:not(.bk-view-locked *), button)').count(),
    0,
    `${at}: no title key`,
  );
}
// A swipe and a trackpad's sideways scroll leave the page where it is across
async function noSideways(p, at) {
  const across = async () => (await viewNow(p)).x;
  const was = await across();
  await p.evaluate(async () => {
    const desk = document.querySelector('#book .bk-desk'),
      r = desk.getBoundingClientRect();
    for (let i = 0; i < 8; i++) {
      desk.dispatchEvent(
        new WheelEvent('wheel', {
          ...{ deltaX: 120, bubbles: true, cancelable: true },
          ...{ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 },
        }),
      );
      await new Promise(go => requestAnimationFrame(go));
    }
  });
  await p.waitForTimeout(400);
  assert.equal(await across(), was, `${at}: the page doesn't move sideways`);
}
// Beside HQ's page, the bookmarks stick out less than the pull tab, which hangs below the last of them; a press
// anywhere on the tab is the tab's, never a bookmark's
async function clearOfMarks(p, at) {
  const { tabs, lip, whole, pressed } = await p.evaluate(() => {
    const box = el => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, right: r.right, bottom: r.bottom };
    };
    const lip = document.querySelector('#book .bk-lip'),
      r = lip.getBoundingClientRect(),
      across = [0.1, 0.5, 0.9];
    return {
      tabs: [...document.querySelectorAll('#book .bk-marks .bk-mk-tab')].map(box),
      lip: box(lip),
      whole: 'whole' in document.querySelector('#book').dataset,
      // (what a press takes, over the tab's whole face)
      pressed: across.flatMap(fx =>
        across.map(fy => {
          const hit = document.elementFromPoint(r.left + fx * r.width, r.top + fy * r.height);
          return hit?.closest('.bk-lip') ? 'tab' : hit?.closest('.bk-marks') ? 'a bookmark' : 'something else';
        }),
      ),
    };
  });
  assert.equal(tabs.length, 3, `${at}: the three bookmarks`);
  assert.deepEqual(new Set(pressed), new Set(['tab']), `${at}: a press on the pull tab is the tab's (${pressed})`);
  const last = tabs.at(-1);
  assert.ok(lip.y >= last.bottom, `${at}: the pull tab below the bookmarks (${last.bottom} to ${lip.y})`);
  if (whole) return;
  for (const t of tabs) assert.ok(lip.x < t.x, `${at}: the pull tab out further than a bookmark (${lip.x}, ${t.x})`);
}
// Shut, a finger's pull from the tab most of the way across the screen opens the book
async function pulledOpen(p, c, size) {
  const lip = await p.locator('#book .bk-lip').boundingBox(),
    from = [lip.x + lip.width / 2, lip.y + lip.height / 2],
    { touch } = await hands(p);
  await touch.stroke([from], [[size.width / 5, from[1]]]);
  // (open beside HQ's page, or upright as the spread over it, as restsOpen waits)
  await c.settled(p, size.width > size.height ? 'open' : 'spread');
}
