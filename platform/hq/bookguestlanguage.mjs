// A guest's book in their language: what the shell writes for them
import assert from 'node:assert/strict';
import { named, addNote, sendPage, snapshot } from './bookguestscreen.mjs';
import { openVisitor } from './bookguestserver.mjs';
import { reviewInvite } from './bookinvitechecks.mjs';
import { until } from '../../shared/browser/browser.mjs';
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

// Two more of the round's guests, their words on the rail in German and Dutch on a phone held sideways, where the rail
// is at its tightest: Mark done, then Marked done and Undo, each broken inside its key, none running out of it
// (signIn: bookguests.mjs's)
export async function roundWords(state, board, signIn) {
  const people = [
    ['Dirk', 'de'],
    ['Eva', 'nl'],
  ];
  await reviewInvite(state, board);
  for (const [person] of people) {
    await board.locator('form.invite [name=name]').fill(person);
    await board.locator('form.invite [name=email]').fill(`${person.toLowerCase()}@example.org`);
    await board.locator('form.invite [type=submit]').click();
    await until(board, '.invites ul', new RegExp(person));
  }
  await board.evaluate(() => document.querySelector('dialog[open]').remove());
  const invited = (await state.h.board('/api/review/shares')).body.flatMap(share => share.people);
  for (const [person, lang] of people) {
    state.h.db.prepare('update guests set lang = ? where name = ?').run(lang, person);
    const guest = await openVisitor(state, { width: 844, height: 390 });
    await signIn(state, guest, invited.find(one => one.name === person).link);
    assert.equal(await guest.page.locator('html').getAttribute('lang'), lang);
    await addNote(guest.page, 'A guest note');
    await wordsInKeys(guest.page, `${lang} Mark done`);
    await sendPage(guest.page);
    await guest.page.locator('#book .bk-guest-undo').waitFor({ state: 'visible' });
    await wordsInKeys(guest.page, `${lang} Undo`);
    await snapshot(state, `round-words-${lang}-sideways`, guest.page);
  }
}
// Every word key shown on the tight rail with each line of its word inside it
async function wordsInKeys(page, what) {
  await page.waitForFunction(() => document.querySelector('#book .bk-column').dataset.fit === 'tight');
  const out = await page.evaluate(() =>
    [...document.querySelectorAll('#book .bk-column .bk-text')]
      .filter(key => key.offsetParent)
      .map(key => {
        const k = key.getBoundingClientRect(),
          range = document.createRange();
        range.selectNodeContents(key);
        const past = [...range.getClientRects()].map(r =>
          Math.max(k.top - r.top, r.bottom - k.bottom, k.left - r.left, r.right - k.right),
        );
        return [key.textContent, Math.max(0, ...past)];
      }),
  );
  assert.ok(out.length, `${what}: a word key on the rail`);
  for (const [word, past] of out) assert.ok(past <= 0.5, `${what}: "${word}" runs ${past} px out of its key`);
}
