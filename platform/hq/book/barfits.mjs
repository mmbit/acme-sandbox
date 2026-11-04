// What the book's two islands hold, for bar.mjs's story (shell/ink/bookui.js, bookstrip.css): the tools and the
// bar, each of use (islands.mjs) and with its own keys. (the islands' checks)
import assert from 'node:assert/strict';
import { OVERVIEW } from './kit.mjs';
import { islandsSeen, islandsUsable } from './islands.mjs';

// the tools down their island (the pen or the marker, whichever is in hand; the mic after them where the device can
// record: bookvoice.js)
const TOOLS = [/^(Pen|Marker)$/, /^Shapes/, 'Eraser', 'Select', 'Text'],
  MIC = 'Voice note';
// the most of a phone's height the tools' island takes, upright: well under half (the Ink README, "The book's frame":
const TOOLS_OF_PHONE = 0.4;

// Both islands of use, and each holding its own keys
export async function fits(page) {
  const seen = await islandsSeen(page);
  islandsUsable(seen, 'at rest');
  toolsHeld(seen);
  barHeld(seen);
}

// The tools: in their order with one pen, the mic last where there is one, and well under half a phone's height
function toolsHeld({ tools, screen }) {
  const names = tools.keys.map(k => k.name),
    drawn = names.filter(n => n !== MIC);
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

// The bar: on the paper, Undo and Redo at its left, the page's arrows round where it is in its very middle, the
// overview and the dots at its right, two keys at each end at every size
function barHeld({ bar, where, paper, screen }) {
  assert.ok(
    bar.left >= Math.max(paper.left, 0) - 1 && bar.right <= Math.min(paper.right, screen.width) + 1,
    `the bar on the paper (${JSON.stringify({ bar, paper })})`,
  );
  assert.deepEqual(bar.start, ['Undo', 'Redo'], "Undo and Redo at the bar's left");
  assert.ok(
    bar.middle.length === 3 && bar.middle[0] === 'The page before' && bar.middle[2] === 'The page after',
    `the page's arrows round where it is in the bar's middle: ${bar.middle.join(', ')}`,
  );
  const off = middle(where.left, where.right) - middle(bar.left, bar.right);
  assert.ok(Math.abs(off) <= 1, `the page's count in the very middle of the bar: ${off} px off`);
  assert.deepEqual(bar.end, [OVERVIEW, 'More'], "the overview and the dots at the bar's right");
}
const middle = (a, b) => (a + b) / 2;
