// A guest notebook's session refusal in the page's language, through the real coordinator.
import assert from 'node:assert/strict';
import { until } from '../../../shared/browser/browser.mjs';
import { readyNotebook } from './guestscreen.mjs';

export async function refusalStory(state, visitor, lang, name) {
  const { createInvitedNotebook } = await import('../../coordinator/src/notebookguests.ts');
  const made = createInvitedNotebook({
    name: 'Session refusals',
    people: [{ name, email: `${name.toLowerCase()}@example.org` }],
  });
  const page = visitor.page;
  await page.goto(`${state.origin}/guest/notebooks/?notebook=${made.notebook.id}`);
  await readyNotebook(page);
  // (the book's tools load after it shows: signed out only once they're in)
  await page.waitForLoadState('networkidle');
  await visitor.context.clearCookies();
  await until(
    page,
    '[data-notebook-status]',
    lang === 'nl' ? /Meld je opnieuw aan via je uitnodigingslink/ : /Melde dich über deinen Einladungslink erneut an/,
  );
  if (state.shots) await page.screenshot({ path: `${state.shots}/guest-refusal-${lang}-phone.png` });
  assert.equal(await page.locator('#book').count(), 0);
}
