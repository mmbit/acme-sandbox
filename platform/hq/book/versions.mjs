// book-check.mjs's versions stories: a note that asks for a change gets versions under it
// (shell/ink/bookversions.js; the coordinator's ink/booktry.ts and groupanswers.ts), on a Notebook of its own played by
// HQ's one stand-in (answersplay.mjs). Pencil dots in a frame still coming, each frame as it lands,
// lettered in order with its live preview, never over the note or under the tools; a try that ended with none says
// why in their place.
import assert from 'node:assert/strict';
import { inStory } from './answers.mjs';
import { FEED_MS, clearOfTools, layer, triedNote } from './answersplay.mjs';

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
  nb.seed.slips.push({ id: 4410, ...version('Sand and honey') }, { id: 4411, ...version('Brick red') });
  await inStory(browser, c, { viewport: c.MINI, nb }, async (page, play) => {
    const frame = which => layer(page).locator(`.bk-versions .bk-version${which}`);
    await frame('').first().waitFor({ timeout: FEED_MS });
    assert.equal(await frame('[data-answer]').count(), 2, 'two in');
    assert.equal(await frame('[data-empty]').count(), 1, 'one still coming, in pencil dots');
    assert.ok(await frame('[data-empty] .bk-answer-dots').isVisible());
    await under(page, warmer);
    await c.shot('answers-versions-coming', page);
    const { id } = play.answer(warmer.id, version('Late sun'));
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
// The versions under their note's unit as the page draws them on the screen, never over it nor out of its column, and
// wholly on the paper left of the tools floating at its right.
async function under(page, g) {
  const [at, unit] = await page.evaluate(id => {
    const box = el => {
      const r = el?.getBoundingClientRect();
      return r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    return [
      box(document.querySelector('#book .bk-answers .bk-versions')),
      box(document.querySelector(`#book .bk-unit[data-unit="${id}"]`)),
    ];
  }, g.id);
  assert.ok(
    at && unit && at.top >= unit.bottom && at.left >= unit.left - 1 && at.right <= unit.right + 1,
    `under the note's unit: ${JSON.stringify([at, unit])}`,
  );
  await clearOfTools(page, '.bk-versions');
}
