// A guest's book in their language: what the shell writes for them
import assert from 'node:assert/strict';
import { named, addNote, sendPage, snapshot } from './guestscreen.mjs';
import { openVisitor } from './guestserver.mjs';
import { reviewInvite } from './invitechecks.mjs';
import { until } from '../../../shared/browser/browser.mjs';
import { filled, words } from '../shell/ink/notebookwords.js';

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
  const said = async (key, who) => filled(await named(page, key), { name: who });
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

// Two more of the round's guests, their words on the bar in German and Dutch on a phone held sideways, where the bar
// is at its tightest: Mark done, then Marked done and Undo, on the bar's right before its dots, each broken inside its
// key, none running out of it (signIn: guests.mjs's.)
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
// Every word key the guest has on the bar: on its right, clear of the page's arrows in its middle and before its dots,
// on the bar's row and on the screen, each line of its word inside its key
async function wordsInKeys(page, what) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#book .bk-bar [data-island=send] .bk-text')].some(key => key.offsetParent),
  );
  const seen = await page.evaluate(() => {
    const bar = document.querySelector('#book .bk-bar'),
      [send, pages, dots] = ['[data-island=send]', '[data-island=pages]', '.bk-more'].map(s =>
        bar.querySelector(s).getBoundingClientRect(),
      ),
      row = bar.getBoundingClientRect();
    const keys = [...bar.querySelectorAll('[data-island=send] .bk-text')]
      .filter(key => key.offsetParent)
      .map(key => {
        const k = key.getBoundingClientRect(),
          range = document.createRange();
        range.selectNodeContents(key);
        const past = [...range.getClientRects()].map(r =>
          Math.max(k.top - r.top, r.bottom - k.bottom, k.left - r.left, r.right - k.right),
        );
        return [key.textContent, Math.max(0, ...past)];
      });
    return {
      keys,
      placed: {
        'clear of the arrows': send.left >= pages.right - 0.5,
        'before the dots': send.right <= dots.left + 0.5,
        'on the bar': send.top >= row.top - 0.5 && send.bottom <= row.bottom + 0.5,
        'and the dots on the screen': dots.right <= innerWidth + 0.5,
      },
    };
  });
  assert.ok(seen.keys.length, `${what}: a word key on the bar`);
  for (const [word, past] of seen.keys) assert.ok(past <= 0.5, `${what}: "${word}" runs ${past} px out of its key`);
  for (const [where, ok] of Object.entries(seen.placed)) assert.ok(ok, `${what}: its keys ${where}`);
}
