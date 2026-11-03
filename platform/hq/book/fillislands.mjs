// The tools' island on the board's iPad, for fill.mjs's story: picked from by the Pencil and a finger.
import { middleOf, until } from './kit.mjs';

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
