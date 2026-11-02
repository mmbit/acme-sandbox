// The tool rail on the board's iPad, for bookfill.mjs's story: floating by the paper's right edge, and picked from by
// the Pencil and a finger.
import assert from 'node:assert/strict';
import { middleOf, until } from './bookkit.mjs';

// The tool rail on-screen toolbars floating over the paper, never a strip of it (board, call 174): HQ's panels with
// their corners and shadow, slim, in from the paper's head, foot and edge, the paper running on past them to the book's
// edge, and what's written ending left of them. The tools at the rail's head, the page's controls at its foot, so what
// the head shows never moves the page's arrows.
export async function railFloats(page) {
  const seen = await railSeen(page),
    said = JSON.stringify(seen),
    [head, foot] = seen.bars;
  assert.ok(
    seen.bars.length === 2 && seen.tools && seen.arrows,
    `the tools at the head, the arrows at the foot (${said})`,
  );
  for (const bar of seen.bars) {
    assert.ok(bar.background === seen.panel && bar.image === 'none', `the rail HQ's panels, not paper (${said})`);
    assert.ok(
      bar.corner === seen.round && bar.shadow !== 'none',
      `the rail floats, the look's corners and shadow (${said})`,
    );
    assert.ok(bar.width <= 52, `the rail slim (${said})`);
  }
  assert.ok(
    head.bottom < foot.top && Math.abs(foot.bottom - seen.rail.bottom) <= 1,
    `the foot's at the rail's foot (${said})`,
  );
  assert.ok(seen.paper.right - seen.rail.right >= 4, `the paper running on past the rail to the book's edge (${said})`);
  assert.ok(
    seen.rail.top - Math.max(seen.paper.top, 0) >= 4 &&
      Math.min(seen.paper.bottom, seen.screen) - seen.rail.bottom >= 4,
    `the rail in from the paper's head and foot (${said})`,
  );
  assert.ok(seen.desk.right <= seen.rail.left, `what's written ending left of the rail (${said})`);
}
// The rail's column, its toolbars and their look, the look's own panel, and the paper and the page beside them
const railSeen = page =>
  page.evaluate(() => {
    const column = document.querySelector('#book .bk-column'),
      probe = Object.assign(document.createElement('div'), {
        style: 'background: var(--bk-ui-bg); border-radius: var(--r-lg, 13px)',
      });
    column.append(probe);
    const { backgroundColor: panel, borderTopLeftRadius: round } = getComputedStyle(probe);
    probe.remove();
    const box = el => {
      const { left, top, right, bottom, width } = el.getBoundingClientRect();
      return { left, top, right, bottom, width };
    };
    return {
      rail: box(column),
      bars: [...column.children].map(el => {
        const look = getComputedStyle(el);
        return {
          ...box(el),
          ...{ background: look.backgroundColor, image: look.backgroundImage, corner: look.borderTopLeftRadius },
          shadow: look.boxShadow,
        };
      }),
      tools: !!column.firstElementChild.querySelector('[data-island=tools]'),
      arrows: !!column.lastElementChild.querySelector('.bk-turns'),
      paper: box(document.querySelector('#book .bk-paper')),
      desk: box(document.querySelector('#book .bk-desk')),
      screen: innerHeight,
      panel,
      round,
    };
  });

// The Pencil's tap picks the eraser on the rail, a finger's the pen again
export async function picksByHand(page, { pen, touch }) {
  const tool = mode => page.locator(`#book .bk-strip .bk-btn[data-mode='${mode}']`).first(),
    picked = async mode => (await tool(mode).getAttribute('aria-pressed')) === 'true',
    at = async mode => middleOf(await tool(mode).boundingBox());
  await pen.stroke([await at('eraser')]);
  await until(() => picked('eraser'), "the Pencil's tap picking the eraser on the rail");
  await touch.down([await at('pen')]);
  await touch.up();
  await until(() => picked('pen'), "a finger's tap picking the pen again");
}
