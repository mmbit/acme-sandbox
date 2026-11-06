// What the book's two islands hold, for bar.mjs's story (shell/ink/bookui.js, bookstrip.css): the bar on the page, the
// tools on an opened scrap, each of use (islands.mjs) and with its own keys. (the islands' checks; the tools, Undo and
// Redo only on an opened scrap, the bar put away there)
import assert from 'node:assert/strict';
import { OVERVIEW } from './kit.mjs';
import { islandsSeen, islandsUsable } from './islands.mjs';

// the tools down their island (the pen or the marker, whichever is in hand; the mic after them where the device can
// record: bookvoice.js), Undo and Redo last (bookscrapopen.js)
const TOOLS = [/^(Pen|Marker)$/, /^Shapes/, 'Eraser', 'Select', 'Text'],
  MIC = 'Voice note',
  HISTORY = ['Undo', 'Redo'];
// the most of a phone's height the tools' island takes, upright: well under half (the Ink README, "The book's frame"),
// Undo and Redo on it too
const TOOLS_OF_PHONE = 0.45;

// The island shown of use and holding its own keys, the other put away: on the page (scrap false) the bar, on an
// opened scrap the tools
export async function fits(page, scrap) {
  const seen = await islandsSeen(page),
    when = scrap ? 'a scrap opened' : 'the page';
  islandsUsable(seen, when);
  assert.deepEqual([seen.tools.shown, seen.bar.shown], [scrap, !scrap], `${when}: the tools shown, the bar shown`);
  if (scrap) toolsHeld(seen);
  else barHeld(seen);
}

// The tools: in their order with one pen, the mic after them where there is one, Undo and Redo last, and well under
// half a phone's height
function toolsHeld({ tools, screen }) {
  const all = tools.keys.map(k => k.name),
    names = all.filter(n => !HISTORY.includes(n)),
    drawn = names.filter(n => n !== MIC);
  assert.deepEqual(all.slice(-2), HISTORY, `Undo and Redo after the tools: ${all.join(', ')}`);
  assert.equal(names.filter(n => /^(Pen|Marker)$/.test(n)).length, 1, `one pen: ${names.join(', ')}`);
  assert.ok(
    drawn.length === TOOLS.length && drawn.every((n, i) => TOOLS[i].test?.(n) ?? TOOLS[i] === n),
    `the tools in their order: ${names.join(', ')}`,
  );
  assert.ok(!names.includes(MIC) || names.at(-1) === MIC, `the mic after the tools: ${names.join(', ')}`);
  if (screen.width < 500)
    assert.ok(
      tools.height < TOOLS_OF_PHONE * screen.height,
      `the tools ${Math.round(tools.height)} px tall, well under half the phone's ${screen.height}`,
    );
}

// The bar: on the paper, the overview at its left, the page's arrows round where it is in its very middle, the dots at
// its right
function barHeld({ bar, where, paper, screen }) {
  assert.ok(
    bar.left >= Math.max(paper.left, 0) - 1 && bar.right <= Math.min(paper.right, screen.width) + 1,
    `the bar on the paper (${JSON.stringify({ bar, paper })})`,
  );
  // (the bar as drawn: the Ink README, The book's frame.)
  assert.deepEqual(bar.start, [OVERVIEW], "the overview at the bar's left");
  assert.ok(
    bar.middle.length === 3 && bar.middle[0] === 'The page before' && bar.middle[2] === 'The page after',
    `the page's arrows round where it is in the bar's middle: ${bar.middle.join(', ')}`,
  );
  const off = middle(where.left, where.right) - middle(bar.left, bar.right);
  assert.ok(Math.abs(off) <= 1, `the page's count in the very middle of the bar: ${off} px off`);
  assert.deepEqual(bar.end, ['More'], "the dots at the bar's right");
}
const middle = (a, b) => (a + b) / 2;

// The page's keys (the bar's left and middle), or an opened scrap's Undo and Redo, where they are on the screen (px)
export const keysOf = (page, keys = '#book :is(.bk-bar-start, .bk-bar-middle) .bk-btn') =>
  page.evaluate(
    keys =>
      [...document.querySelectorAll(keys)].map(b => {
        const r = b.getBoundingClientRect();
        return [
          b.className.split(' ').find(n => n !== 'bk-btn') ?? '',
          ...[r.x, r.y, r.width, r.height].map(Math.round),
        ];
      }),
    keys,
  );
// An opened scrap's Undo and Redo never move: where they were at rest with another tool in use and with the pen's
// card open
export async function historyStays(page, size) {
  const history = '#book .bk-scrap-history .bk-btn',
    rest = await keysOf(page, history),
    stays = async state =>
      assert.deepEqual(await keysOf(page, history), rest, `${size.name}, ${state}: Undo and Redo moved`);
  const tools = page.locator('#book [data-island=tools]');
  for (const name of ['Eraser', 'Text', 'Pen']) {
    await tools.getByRole('button', { name, exact: true }).click();
    await stays(`${name} in use`);
  }
  await tools.getByRole('button', { name: 'Pen', exact: true }).click();
  await page.locator('#book .bk-palette').waitFor({ state: 'visible', timeout: 5000 });
  await stays("the pen's card open");
  await page.keyboard.press('Escape');
  await page.locator('#book .bk-palette').waitFor({ state: 'detached', timeout: 5000 });
}
