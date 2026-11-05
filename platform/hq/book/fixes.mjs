// book-check.mjs's stories of Ink 1.1's answers that ask for nothing but a tick (shell/ink/bookassignlist.js seenHtml,
// shared/review/slip.js; the coordinator's ink/groupanswers.ts seenTick and ink/bookfix.ts), each on a Notebook of
// its own played by HQ's one stand-in (answersplay.mjs), on an iPad mini by finger and a desktop by mouse:
//   - Seen: a note that needs nothing back wears its agent's face with a small tick on it right beside what was read,
//     its words or its ink, gone once an answer comes; a picture's answer says where its numbers came from in one small
//     line under it. (beside what was read)
//   - A fix: a box to tick by its line, or round its drawing; ticked, it's built once the page is sent (from the
//     dots' Tear off and send, Submit), and its slip then says who's building it, its box ticked for good.
import assert from 'node:assert/strict';
import { FEED_MS, notebookOn, underItsNote } from './answersplay.mjs';
import { inStory } from './answers.mjs';
import { tearOffMenu } from './tearing.mjs';
import { say, until } from './kit.mjs';
import { boxOf as inkBox } from '../shell/ink/notebookstack.js';
import { UNIT_W } from '../shell/ink/scrapunit.js';

const SOURCE = "From HQ's speed checker, last 7 days";
// The board's red circle high in its unit, the rest of what was drawn under it rubbed out: the unit as tall as it was
// (in its own px.)
const RING = [
  {
    color: '#d0312d',
    size: 4,
    points: Array.from({ length: 26 }, (_, i) => [70 + 45 * Math.cos(i / 4), 70 + 45 * Math.sin(i / 4), 0.5, i * 16]),
  },
];

// c: book-check's { hqIn, base, shot, MINI, DESKTOP, … }
export function fixStories(c) {
  return {
    'a seen tick on its agent’s face beside what was read, gone once answered; a picture’s source under it, on an iPad mini and a desktop':
      async browser => {
        await seen(browser, c, c.MINI, 'mini');
        await seen(browser, c, c.DESKTOP, 'desktop', { hasTouch: false, deviceScaleFactor: 1 });
      },
    'a fix: a box to tick, written or drawn; the page sent, it’s being built, on an iPad mini by finger and a desktop by mouse':
      async browser => {
        await fixed(browser, c, c.MINI, 'mini', true);
        // (its book spread wide, the two notes side by side: both in sight)
        const wide = { hasTouch: false, deviceScaleFactor: 1, book: 1100 };
        await fixed(browser, c, { width: 1920, height: 1080 }, 'desktop', false, wide);
      },
  };
}

// An answer's slip under its note, as the page draws it (bookgroups.js)
const slipOf = (page, g, id) => page.locator(`#book .bk-under[data-g="${g.id}"] .answer-slip[data-slip="${id}"]`);
const boxOf = el => el.evaluate(e => JSON.parse(JSON.stringify(e.getBoundingClientRect())));
// (scrolled into view, again if the page drew it anew meanwhile: a store's change reads the page again)
const inView = (page, el, what) => {
  let why = '';
  const seen = async () => {
    const r = await el.boundingBox().catch(() => null),
      v = page.viewportSize();
    if (r && r.y >= 0 && r.y + Math.min(r.height, v.height) <= v.height) return true;
    return el.scrollIntoViewIfNeeded({ timeout: 2000 }).then(
      () => false,
      e => void (why = e.message.split('\n')[0]),
    );
  };
  return until(seen, () => `${what} in view: ${why}`);
};

// A seen tick right beside what was read (its box in its unit's own px, from the unit's place on the screen): within a
// few px of it and covering none of it, wherever it is in its unit (a circle drawn high in a tall one has its tick by
// the circle, not at the unit's foot a post-it's height below).
async function besideRead(page, g, tick, what) {
  const unit = await boxOf(page.locator(`#book .bk-unit[data-unit="${g.id}"]`)),
    s = unit.width / UNIT_W,
    b = g.box,
    [left, top] = [unit.left + b.x * s, unit.top + b.y * s],
    face = await boxOf(tick.locator('.bk-answer-face')),
    apart = Math.max(left - face.right, face.left - left - b.w * s, top - face.bottom, face.top - top - b.h * s),
    at = JSON.stringify({ read: { left, top, ...b }, face });
  // (typed words' height an estimate here and on the page: a px or two either way)
  assert.ok(apart > -3, `${what}: covering none of it: ${at}`);
  assert.ok(apart < 16 * s, `${what}: right beside it: ${at}`);
}

async function seen(browser, c, viewport, size, options = {}) {
  const nb = notebookOn(c),
    read = Object.assign(nb.typed(4700, 'nice, the shelf looks right now', 60, 60), { seen: nb.ceo }),
    asked = nb.typed(4701, 'is the pen getting faster?', 60, 60),
    circle = { ...nb.typed(4702, '', 0, 0), texts: [], ink: RING, box: inkBox({ ink: RING }), h: 420, seen: nb.ceo };
  nb.groups.push(read, asked, circle);
  nb.seed.slips.push({
    id: 4710,
    ...nb.answer(asked, 'text', 'Yes: down to 17 ms.', { picture: '/mock/book-snip-2.svg', source: SOURCE }),
  });
  await inStory(browser, c, { viewport, nb, options }, async (page, play) => {
    // (wherever the page puts the group's mark)
    const tickOf = g => page.locator(`#book .bk-groups > [data-g="${g.id}"] .bk-tag[data-seen]`),
      tick = tickOf(read);
    await tick.waitFor({ timeout: FEED_MS });
    await tick.scrollIntoViewIfNeeded();
    // (the agent's own face as HQ's look draws them, no letter; a tick drawn as the Notebook's ink, never HQ's pixel
    // icon.)
    const face = tick.locator('.bk-answer-face');
    assert.match(await face.evaluate(el => el.style.backgroundImage), /^url\("data:image\//, 'its face');
    assert.equal((await face.innerText()).trim(), '', 'no letter');
    assert.equal(await tick.getAttribute('aria-label'), say('seenBy', { name: nb.name }));
    assert.equal(await tick.locator('svg.bk-tick:not([data-icon]) path').count(), 1, 'a tick on it');
    await besideRead(page, read, tick, 'the typed note');
    await tickOf(circle).scrollIntoViewIfNeeded();
    await besideRead(page, circle, tickOf(circle), 'the circle');
    assert.equal(await tickOf(asked).count(), 0, 'an answered note: no tick');
    // the picture's source, one small line right under it
    const slip = slipOf(page, asked, 4710);
    await underItsNote(page, asked, '.answer-slip[data-slip="4710"]');
    const source = slip.locator('.slip-source');
    assert.equal(await source.innerText(), SOURCE);
    const [pic, line] = [await boxOf(slip.locator('.slip-pic')), await boxOf(source)];
    assert.ok(
      line.top >= pic.bottom - 1 && line.top - pic.bottom < 8,
      `under the picture: ${JSON.stringify([pic, line])}`,
    );
    assert.ok((await source.evaluate(el => el.offsetHeight)) < 20, 'one small line');
    await c.shot(`answers-seen-${size}`, page);
    // an answer on the read note takes its tick's place
    play.answer(read.id, nb.answer(read, 'text', 'Thanks: Odile moved them.'));
    await tick.waitFor({ state: 'detached', timeout: FEED_MS });
  });
}

// A written fix ticked and unticked and ticked again, a drawn one ticked on its drawing; the page sent from the
// dots' Submit: both being built, their boxes kept
async function fixed(browser, c, viewport, size, finger, options = {}) {
  const nb = notebookOn(c),
    slow = Object.assign(nb.typed(4720, 'why is the iPad slow after an hour?', 60, 60), { column: 0 }),
    cramped = Object.assign(nb.typed(4721, 'too cramped', 60, 60), { column: 1 });
  const sketch = [
    { color: '#2b2230', size: 3, points: [0, 1, 2, 3].map(i => [10 + i * 90, 20, 0.5, i * 20]) },
    { color: '#2b2230', size: 3, points: [0, 1].map(i => [10 + i * 270, 60, 0.5, i * 20]) },
  ];
  const why = 'The building view keeps every stroke in memory, so it slows down.';
  nb.groups.push(slow, cramped);
  nb.seed.slips.push(
    { id: 4730, ...nb.answer(slow, 'text', why, { fix: 'free strokes once saved' }) },
    { id: 4731, ...nb.answer(cramped, 'drawing', '', { ink: sketch, fix: 'room to breathe' }) },
  );
  await inStory(browser, c, { viewport, nb, options }, async (page, play) => {
    const story = {
      page,
      size,
      press: el => (finger ? el.tap() : el.click()),
      tap: (x, y) => (finger ? page.touchscreen.tap(x, y) : page.mouse.click(x, y)),
      written: slipOf(page, slow, 4730),
      drawn: slipOf(page, cramped, 4731),
      // (an answer as the store has it now)
      of: id =>
        play
          .route('/api/notebooks/pages/groups', { page: nb.p.id })
          .groups.flatMap(g => g.children)
          .find(a => a.id === id),
    };
    await writtenTicked(story);
    await drawnTicked(story);
    await c.shot(`answers-fix-ticked-${size}`, page);
    await sentBuilt(story, nb.name);
    await c.shot(`answers-fix-built-${size}`, page);
  });
}
// The written fix: one box, before its line, saying what its tick does; ticked, unticked and ticked again, each press
// once the store has it and the slip is drawn from it again
async function writtenTicked({ page, size, press, written, of }) {
  await written.waitFor({ timeout: FEED_MS });
  await inView(page, written, 'the written fix');
  const box = written.locator('.slip-fix > .slip-tick'),
    said = written.locator('.slip-fix-said');
  assert.equal(await written.locator('.slip-tick').count(), 1, 'one box, by its line: none at the corner');
  assert.equal(
    await written.locator('.slip-fix-words').innerText(),
    say('slipFix', { fix: 'free strokes once saved' }),
  );
  assert.equal(await said.innerText(), say('slipFixSend'));
  const [b, words] = [await boxOf(box), await boxOf(written.locator('.slip-fix-words'))];
  assert.ok(b.right <= words.left, `the box before its words: ${JSON.stringify([b, words])}`);
  assert.ok((await box.evaluate(el => el.offsetWidth)) >= 26, 'a box a finger takes (26 px, and room round it)');
  const tickTo = async (want, what) => {
    await press(box);
    await until(() => !!of(4730).ticked === want, `${what} (${size})`);
    await until(async () => (await box.getAttribute('aria-pressed')) === String(want), `${what}, drawn (${size})`);
  };
  await tickTo(true, 'the fix ticked');
  assert.equal(await said.innerText(), say('slipFixTicked'));
  await tickTo(false, 'the tick taken back');
  await tickTo(true, 'ticked again');
}
// The drawn fix: its drawing in the box, clear of its tick box, ticked by a press on the drawing itself, washed in the
// chosen colour as it eases in
async function drawnTicked({ page, size, tap, drawn, of }) {
  await inView(page, drawn, 'the drawn fix');
  const art = drawn.locator('.slip-fix-art');
  assert.equal(await art.locator('.bk-slip-ink path').count(), 2, 'its drawing in its box');
  assert.equal(await drawn.locator('.slip-fix-words').innerText(), say('slipFix', { fix: 'room to breathe' }));
  const [ink, box] = [await boxOf(art.locator('.bk-slip-ink')), await boxOf(art.locator('.slip-tick'))];
  const apart = ink.right <= box.left || ink.bottom <= box.top;
  assert.ok(apart, `the box covers none of the drawing: ${JSON.stringify([ink, box])}`);
  const a = await boxOf(art),
    wash = () => art.evaluate(el => getComputedStyle(el).backgroundColor),
    unticked = await wash();
  await tap(a.x + a.width / 3, a.y + a.height / 2);
  await until(() => of(4731).ticked, `the drawn fix ticked on its drawing (${size})`);
  assert.equal(await drawn.getAttribute('data-ticked'), '');
  await until(async () => (await wash()) !== unticked, 'washed in the chosen colour');
}
// The page sent from the dots' Tear off and send: both being built, their boxes ticked for good (once the send's
// pictures of the page have gone: bookflip.js copies it whole as it turns.)
async function sentBuilt({ page, size, written, drawn, of }, name) {
  await (await tearOffMenu(page)).getByRole('menuitem', { name: /Submit/ }).click();
  await until(() => of(4730).builder && of(4731).builder, `both being built (${size})`);
  await until(async () => !(await page.locator('#book .bk-turn-picture, #book .bk-fx-plane').count()), 'sent');
  for (const slip of [written, drawn]) {
    await until(
      async () => (await slip.locator('.slip-fix-said').innerText()) === say('slipFixBuilt', { name }),
      `the slip says it's being built (${size})`,
    );
    assert.ok(await slip.locator('.slip-tick').isDisabled(), 'its tick kept');
  }
  await inView(page, written, 'the written fix, built');
}
