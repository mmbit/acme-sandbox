// book-check.mjs's stories of the Pencil on the book's paper by hand, at the board's iPad sizes (shell/ink/booktexts.js,
// bookpan.js, bookscope.js; Ink's folder), with Chromium's own pen events: a Pencil's tap on a box's bin deleting it
// (Undo bringing it back), and a box tapped past its scrap's edge kept, a refusal out of shape
// said plainly. Each asserts what the board sees and what the store keeps.
import assert from 'node:assert/strict';
import { freePage, paperBox, savedWhere } from './bookmouse.mjs';
import { MINI, UPRIGHT, middleOf, mini, until } from './bookkit.mjs';
import { QUIET_MS, editing, key, line, tool } from './bookpen.mjs';

// c: book-check.mjs's played store and helpers
export function handStories(c) {
  return {
    "by hand on an iPad mini, sideways and upright: the text tool's tap makes a box to type in, and a Pencil's tap on its bin deletes it":
      async browser => {
        for (const viewport of [MINI, UPRIGHT]) await keys(browser, c, viewport);
      },
    "by hand on an iPad mini, sideways and upright: a box tapped past its scrap's edge is kept, and the page never shows the store's words":
      async browser => {
        for (const viewport of [MINI, UPRIGHT]) await pastTheEdge(browser, c, viewport);
      },
  };
}

// The board's way by hand, at its iPad's sizes: a box made with the text tool's tap (placed as it lifts, so the iPad's
// keyboard comes up), typed with the keyboard, and its bin tapped with the Pencil. On an iPad a touch whose move the
// page refuses is no tap, and Scribble takes a Pencil that starts by a field (it looks round the pen's start, stopping
// at the first thing over it that fills that box): so the Pencil's move is refused on the paper and never on the bin,
// which fills that box clear of the words. The bin deletes the box, and Undo brings it back. A Pencil that moves with the
// text tool makes no box.
async function keys(browser, c, viewport) {
  const free = freePage(c);
  const { page, pen, errors, done } = await mini(browser, c, { viewport });
  const size = `${viewport.width} × ${viewport.height}`;
  try {
    const paper = await paperBox(page),
      at = [paper.x + 120, paper.y + 200];
    await tool(page, 'Text');
    await pen.stroke([at, [at[0] + 30, at[1] + 4], [at[0] + 60, at[1] + 8]]);
    await page.waitForTimeout(QUIET_MS);
    assert.equal(await editing(page), false, `a Pencil's line with the text tool makes no box (${size})`);
    await pen.tap(at);
    await until(() => editing(page), `a new box at ${size}`);
    await page.keyboard.type('one more');
    assert.equal(
      await refused(page, [at[0] + 40, at[1] + 240]),
      true,
      `the Pencil's move refused on the paper (${size})`,
    );
    // (every key's taken together, so a run on the old page shows each way it failed)
    const tray = await keysOf(page),
      taken = [];
    for (const k of tray) if (await refused(page, k.at)) taken.push(k.name);
    assert.deepEqual(
      { refused: taken, scribble: await reach(page), keys: tray.map(k => k.name) },
      { refused: [], scribble: [], keys: KEYS },
      `the Pencil's move never refused on the bin, filling the box round a pen's start clear of the words (${size})`,
    );
    await c.shot(`book-pen-keys-${viewport.width}`, page);
    await page.keyboard.press('Escape');
    await savedWhere(c, free.id, p => p.texts.length === 1);
    // tapped again, the box's bin deletes it; Undo brings it back
    await pen.tap(middleOf(await page.locator('#book .bk-typed').boundingBox()));
    await until(() => editing(page), `the box edited again (${size})`);
    await pen.tap(middleOf(await key(page, 'Delete the text box').boundingBox()));
    await savedWhere(c, free.id, p => p.texts.length === 0);
    assert.equal(await page.locator('#book .bk-typed').count(), 0, `the box gone from the page (${size})`);
    await pen.tap(middleOf(await page.locator('#book').getByRole('button', { name: 'Undo' }).first().boundingBox()));
    const back = await savedWhere(c, free.id, p => p.texts.length === 1);
    assert.equal(back.texts[0].text, 'one more', `Undo brings the box back (${size})`);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// The board's way on call 174, by hand at its iPad's sizes: the text tool on, the Pencil taps the paper right of the
// column, past any scrap's edge, and writes. The box once had no width there, the store refused the page's every save
// with its checks' words ("texts are a list of …"), and the page showed them. Now the box sits inside its scrap and is
// kept; and a request the store refuses as out of shape shows a plain line on the page, never the store's words.
async function pastTheEdge(browser, c, viewport) {
  const free = freePage(c);
  const { page, pen, errors, done } = await mini(browser, c, { viewport });
  const size = `${viewport.width} × ${viewport.height}`,
    said = () => page.locator('#book .bk-refusal:not([hidden])').allTextContents();
  try {
    const paper = await paperBox(page);
    await tool(page, 'Text');
    await pen.tap([paper.x + paper.width - 60, paper.y + 220]);
    await until(() => editing(page), `a new box at the paper's right (${size})`);
    await page.keyboard.type('by the edge');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(QUIET_MS);
    assert.deepEqual(await said(), [], `nothing said on the page (${size})`);
    const kept = await savedWhere(c, free.id, p => p.texts.length === 1);
    assert.ok(kept.texts[0].w >= 160, `the box kept a width to write in (${size}): ${JSON.stringify(kept.texts[0])}`);
    await c.shot(`book-pen-edge-box-${viewport.width}`, page);
    // a save the store refuses as out of shape: a plain line, the store's words only in the console
    const words = 'texts are a list of { x, y, w, text, color: "#rrggbb" }, x and y on the page',
      out = r => r.fulfill({ status: 400, json: { error: words } });
    await page.route('**/api/notebooks/groups/*', out);
    await tool(page, 'Pen');
    await pen.stroke(line([paper.x + 160, paper.y + 420], 120));
    await until(async () => (await said()).length > 0, `the refusal said (${size})`);
    assert.deepEqual(await said(), ['That didn’t go through'], `a plain line, not the store's words (${size})`);
    await page.unroute('**/api/notebooks/groups/*', out);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// ---- helpers

const KEYS = ['Delete the text box'];
// Whether the page refuses the Pencil's move from a point on the screen, as an iPad hears it (Chromium's CDP pen has
// no touches, and its touches no touchType: the Pencil's, as Safari gives it)
const refused = (page, [x, y]) =>
  page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y),
        touch = Object.defineProperty(new Touch({ identifier: 7, target: el, clientX: x, clientY: y }), 'touchType', {
          value: 'stylus',
        }),
        fire = type =>
          el.dispatchEvent(
            new TouchEvent(type, { touches: [touch], changedTouches: [touch], bubbles: true, cancelable: true }),
          );
      fire('touchstart');
      const no = !fire('touchmove');
      fire('touchend');
      return no;
    },
    [x, y],
  );
// The keys beside the box being typed in: their names and middles on the screen
const keysOf = page =>
  page.evaluate(() =>
    [...document.querySelectorAll('#book .bk-typed[data-editing] .bk-typed-keys .bk-btn')].map(b => {
      const r = b.getBoundingClientRect();
      return { name: b.getAttribute('aria-label'), at: [r.x + r.width / 2, r.y + r.height / 2] };
    }),
  );
// The keys Scribble would read as the words' (their field and its reach): one that doesn't fill a 40 px box round its
// middle, or comes within 8 px of the field
const reach = page =>
  page.evaluate(() => {
    const field = document.querySelector('#book .bk-typed[data-editing] .bk-typed-words').getBoundingClientRect();
    return [...document.querySelectorAll('#book .bk-typed[data-editing] .bk-typed-keys .bk-btn')]
      .map(b => [b.getAttribute('aria-label'), b.getBoundingClientRect()])
      .filter(
        ([, r]) =>
          r.width < 40 ||
          r.height < 40 ||
          (r.left < field.right + 8 &&
            r.right > field.left - 8 &&
            r.top < field.bottom + 8 &&
            r.bottom > field.top - 8),
      )
      .map(
        ([name, r]) =>
          `${name} ${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.top - field.bottom)} px`,
      );
  });
