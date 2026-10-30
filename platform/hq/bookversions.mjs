// book-check.mjs's versions stories: a note that asks for a change gets versions under it
// (shell/ink/bookversions.js; the coordinator's ink/booktry.ts and groupanswers.ts), on a Notebook of its own played by
// HQ's one stand-in (bookanswersplay.mjs). Pencil dots in a frame still coming, each frame as it lands,
// lettered in order with its live preview, never over the note or under the tools; a try that ended with none says
// why in their place.
import assert from 'node:assert/strict';
import { inStory } from './bookanswers.mjs';
import { FEED_MS, layer, pagePx, triedNote } from './bookanswersplay.mjs';

// c: book-check's { hqIn, base, store, pages, posts, org, shot, settled, settle, MINI, PHONE, DESKTOP }
export function versionStories(c) {
  return {
    'a note asking for a change gets versions under it: dots while one comes, each frame as it lands, its live preview':
      browser => versions(browser, c),
    'a try that ended with no version says why under the note, and no frame': browser => endedEmpty(browser, c),
  };
}

async function versions(browser, c) {
  const { nb, warmer, version } = triedNote(c);
  nb.seed.slips.push(version(4410, 'Sand and honey'), version(4411, 'Brick red'));
  await inStory(browser, c, { viewport: c.MINI, nb }, async (page, play) => {
    const frame = which => layer(page).locator(`.bk-versions .bk-version${which}`);
    await frame('').first().waitFor({ timeout: FEED_MS });
    assert.equal(await frame('[data-answer]').count(), 2, 'two in');
    assert.equal(await frame('[data-empty]').count(), 1, 'one still coming, in pencil dots');
    assert.ok(await frame('[data-empty] .bk-answer-dots').isVisible());
    await under(page, warmer);
    await c.shot('answers-versions-coming', page);
    const { id } = play.answer(warmer.id, version(null, 'Late sun'));
    play.trying(warmer.id, { ...warmer.tried, going: false });
    await frame(`[data-answer="${id}"]`).waitFor({ timeout: FEED_MS });
    assert.equal(await frame('[data-empty]').count(), 0, 'all three in');
    assert.deepEqual(
      await frame('[data-answer] .bk-version-letter').allInnerTexts(),
      ['A', 'B', 'C'],
      'lettered in order',
    );
    // (a preview opens in HQ's viewer, as any preview's link: desk.js)
    const link = frame(`[data-answer="${id}"]`).getByRole('link', { name: /live preview/ });
    assert.equal(await link.getAttribute('href'), 'https://try-late-sun.preview.example.com/');
    await under(page, warmer);
    await c.shot('answers-versions', page);
  });
}
async function endedEmpty(browser, c) {
  const { nb, warmer } = triedNote(c);
  const reason = `${nb.name}'s try ended without a version. Write on the scrap to ask again.`;
  warmer.tried = { ...warmer.tried, going: false };
  await inStory(browser, c, { viewport: c.MINI, nb }, async page => {
    const said = layer(page).locator('.bk-versions .bk-versions-ended');
    await said.waitFor({ timeout: FEED_MS });
    assert.equal(await said.innerText(), reason);
    assert.equal(await layer(page).locator('.bk-version').count(), 0, 'no frame, and no count of none');
    await under(page, warmer);
    await c.shot('answers-versions-empty', page);
  });
}
// The versions under their note, never over it, and wholly on the paper left of the tools floating at its right
async function under(page, g) {
  const at = await pagePx(page, '.bk-versions');
  assert.ok(at && at.y >= g.box.y + g.box.h, `under the note: ${JSON.stringify([at, g.box])}`);
  await clearOfTools(page, '.bk-versions');
}
// Every element at selector left of the tools floating at the paper's right, the islands' stack and the tool strip
// beside it (exported for bookpicks.mjs)
export async function clearOfTools(page, selector) {
  const tools = await page
      .locator('#book .bk-islands .bk-island, #book .bk-strip .bk-island')
      .evaluateAll(els => Math.min(...els.filter(el => el.offsetWidth).map(el => el.getBoundingClientRect().left))),
    rights = await layer(page)
      .locator(selector)
      .evaluateAll(els => els.map(el => el.getBoundingClientRect().right));
  assert.ok(rights.length && rights.every(x => x <= tools), `clear of the tools: ${JSON.stringify([rights, tools])}`);
}
