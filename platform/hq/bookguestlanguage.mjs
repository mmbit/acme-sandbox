// A guest's book in their language: what the shell writes for them
import assert from 'node:assert/strict';
import { named } from './bookguestscreen.mjs';
import { words } from './shell/ink/notebookwords.js';

// An agent's answer slip on a guest's page: its name marked as an AI's, to the eye and to a screen reader, and its reply
// line, in the guest's language
export async function markedSlip(page, lang) {
  const slip = page.locator('#book .answer-slip').first();
  // (on the page shown: one on a page turned away from is no mark the guest sees)
  await slip.waitFor({ state: 'visible' });
  const head = await slip.locator('.slip-by').innerText(),
    name = head.split(' · ')[0];
  assert.equal(await page.locator('html').getAttribute('lang'), lang);
  assert.equal(head, `${name} · ${words[lang].aiAgent}`, `${head}: an agent's answer is marked as an AI's`);
  const said = async (en, who) => (await named(page, en)).replace('{name}', who);
  assert.equal(await slip.getAttribute('aria-label'), await said("{name}'s answer", head));
  assert.equal(await slip.locator('.slip-reply').getAttribute('aria-label'), await said('Reply to {name}', name));
  assert.equal(
    await slip.locator('.slip-reply').getAttribute('placeholder'),
    await named(page, 'Write under it to reply'),
  );
}

// The date under the page's name in the guest's language: today's weekday as their language shortens it ("za", "Sa"),
// not the board's English ("Sat"). Its notes were written today
export async function pageDate(page, lang) {
  const [shown, theirs, english] = await page.evaluate(lang => {
    const weekday = locale => new Date().toLocaleDateString(locale, { weekday: 'short' });
    return [document.querySelector('#book .bk-day').textContent, weekday(lang), weekday('en-GB')];
  }, lang);
  assert.ok(shown.startsWith(theirs), `${shown}: the page's date is in ${lang}`);
  assert.ok(!shown.includes(english), `${shown}: not the board's English`);
}
