// A guest's book in their language: what the shell writes for them
import assert from 'node:assert/strict';
import { named } from './bookguestscreen.mjs';
import { words } from './shell/ink/notebookwords.js';

// An agent's answer slip on a guest's page: its name marked as an AI's, to the eye and to a screen reader, and the room
// to answer it in, in the guest's language
export async function markedSlip(page, lang) {
  const slip = page.locator('#book .answer-slip').first();
  // (on the page shown: one on a page turned away from is no mark the guest sees)
  await slip.waitFor({ state: 'visible' });
  const head = await slip.locator('.slip-by').innerText(),
    name = head.split(' · ')[0];
  assert.equal(await page.locator('html').getAttribute('lang'), lang);
  assert.equal(head, `${name} · ${words[lang].aiAgent}`, `${head}: an agent's answer is marked as an AI's`);
  const said = async (key, who) => (await named(page, key)).replace('{name}', who);
  assert.equal(await slip.getAttribute('aria-label'), await said('slipAnswer', head));
  // (answered in the room pulled out under it, drawn: no field to type in.)
  assert.equal(await slip.locator('.bk-slip-room-pull').getAttribute('aria-label'), await said('slipRoom', name));
  assert.equal(await slip.locator('textarea, input').count(), 0, 'no field under an answer');
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
