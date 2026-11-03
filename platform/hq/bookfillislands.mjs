// The book's two islands on the board's iPad, for bookfill.mjs's story: floating over the paper, and picked from by the
// Pencil and a finger.
import assert from 'node:assert/strict';
import { middleOf, until } from './bookkit.mjs';

// The islands are on-screen toolbars floating over the paper, never a strip of it (board, calls 174 and 190): HQ's
// panels with their round ends and shadow; the tools slim and upright just in from the paper's right edge, the paper
// running on past them, the bar along its foot, both in from the paper's head and foot; what's written ending left of
// the tools. The tools on their island, the page's arrows on the bar, so what the tools show never moves the arrows.
export async function islandsFloat(page) {
  const seen = await islandsSeen(page),
    said = JSON.stringify(seen),
    [tools, bar] = seen.islands;
  assert.ok(seen.tools && seen.arrows, `the tools on their island, the arrows on the bar (${said})`);
  for (const island of seen.islands) {
    assert.ok(
      island.background === seen.panel && island.image === 'none',
      `the islands HQ's panels, not paper (${said})`,
    );
    assert.ok(
      Math.abs(island.corner - Math.min(island.width, island.height) / 2) <= 1 && island.shadow !== 'none',
      `the islands float, round-ended, with a shadow (${said})`,
    );
  }
  assert.ok(tools.width <= 56 && tools.height > tools.width, `the tools slim and upright (${said})`);
  assert.ok(bar.width > bar.height && tools.bottom < bar.top, `the bar along the foot, under the tools (${said})`);
  assert.ok(seen.paper.right - tools.right >= 4, `the paper running on past the tools to the book's edge (${said})`);
  assert.ok(
    tools.top - Math.max(seen.paper.top, seen.sat) >= 4 && Math.min(seen.paper.bottom, seen.screen) - bar.bottom >= 4,
    `the islands in from the paper's head, under the blur, and its foot (${said})`,
  );
  assert.ok(seen.desk.right <= tools.left, `what's written ending left of the tools (${said})`);
}
// The two islands and their look, the look's own panel, and the paper and the page beside them
const islandsSeen = page =>
  page.evaluate(() => {
    const controls = document.querySelector('#book .bk-controls'),
      probe = Object.assign(document.createElement('div'), { style: 'background: var(--bk-ui-bg)' });
    controls.append(probe);
    const { backgroundColor: panel } = getComputedStyle(probe);
    probe.remove();
    const box = el => {
      const { left, top, right, bottom, width, height } = el.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    const [tools, bar] = ['.bk-strip', '.bk-bar'].map(s => controls.querySelector(s));
    return {
      islands: [tools, bar].map(el => {
        const look = getComputedStyle(el);
        return {
          ...box(el),
          ...{ background: look.backgroundColor, image: look.backgroundImage },
          ...{ corner: parseFloat(look.borderTopLeftRadius), shadow: look.boxShadow },
        };
      }),
      tools: !!tools.querySelector('[data-island=tools]'),
      arrows: !!bar.querySelector('[data-island=pages]'),
      paper: box(document.querySelector('#book .bk-paper')),
      desk: box(document.querySelector('#book .bk-desk')),
      sat: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0,
      screen: innerHeight,
      panel,
    };
  });

// The Pencil's tap picks the eraser on the tools, a finger's the pen again
export async function picksByHand(page, { pen, touch }) {
  const tool = mode => page.locator(`#book .bk-strip .bk-btn[data-mode='${mode}']`).first(),
    picked = async mode => (await tool(mode).getAttribute('aria-pressed')) === 'true',
    at = async mode => middleOf(await tool(mode).boundingBox());
  await pen.stroke([await at('eraser')]);
  await until(() => picked('eraser'), "the Pencil's tap picking the eraser on the tools");
  await touch.down([await at('pen')]);
  await touch.up();
  await until(() => picked('pen'), "a finger's tap picking the pen again");
}
