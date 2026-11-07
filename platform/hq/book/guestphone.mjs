import assert from 'node:assert/strict';
import { openVisitor } from './guestserver.mjs';
import { createNotebook } from './invitechecks.mjs';
import { contrastChannels, cssChannels } from '../../../shared/contrast/contrast.js';
import { closeVisitor, emailSignIn, snapshot } from './guestscreen.mjs';

// A guest's book on a phone, light and dark: its pull tab painted in the book's accent, not only its shadow (the guest's
// room loads booklook.css after book.css: bookguest.js), and an opened scrap's Klaar in ink that reads on its key,
// never white on white (bookscrapopen.css).
export async function phoneLookStory(state) {
  for (const [colorScheme, name] of [
    ['light', 'Lena'],
    ['dark', 'Nora'],
  ]) {
    const book = await createNotebook(state, `Moodboard ${colorScheme}`, name);
    const visitor = await openVisitor(state, { width: 390, height: 844 }, '', state.browser, { colorScheme });
    await emailSignIn(state, visitor, book.people[0].link);
    const page = visitor.page;
    const tab = await page.locator('#book .bk-lip').evaluate(el => getComputedStyle(el).backgroundImage);
    assert.notEqual(tab, 'none', `${colorScheme}: the pull tab painted`);
    const desk = await page.locator('#book .bk-desk').boundingBox();
    await page.touchscreen.tap(desk.x + desk.width / 2, desk.y + desk.height / 2);
    await page.locator('#book .bk-sheet-done').waitFor({ state: 'visible' });
    const [ink, ground] = await page
      .locator('#book .bk-sheet-done')
      .evaluate(el => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
    assert.ok(
      contrastChannels(cssChannels(ink), cssChannels(ground)) >= 4.5,
      `${colorScheme}: Klaar reads on its key (${ink} on ${ground})`,
    );
    await snapshot(state, `guest-scrap-${colorScheme}-phone`, page);
    await closeVisitor(visitor);
    state.opened.splice(state.opened.indexOf(visitor), 1);
  }
}
