// node --test platform/hq/shell/ink/notebookwords.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { words, refusal } from './notebookwords.js';

test('invitation counts use the singular only for one in each guest language', () => {
  for (const [lang, singular, plural] of [
    ['en', 'invitation left', 'invitations left'],
    ['nl', 'uitnodiging over', 'uitnodigingen over'],
    ['de', 'Einladung übrig', 'Einladungen übrig'],
  ]) {
    for (const count of [0, 1, 2, 3]) {
      assert.equal(
        words[lang].invitations('example.org', count).split(' · ')[1],
        `${count} ${count === 1 ? singular : plural}`,
      );
    }
  }
});

test('guest limit messages quote the supplied server limits in every language', () => {
  for (const [lang, text] of Object.entries(words)) {
    for (const value of [17, 31]) {
      const limits = {
        noteCharacters: value,
        replyCharacters: value + 1,
        typedNotes: value + 2,
      };
      assert.match(text.refusals.noteLong(limits), new RegExp(String(limits.noteCharacters)));
      assert.match(text.refusals.replyLong(limits), new RegExp(String(limits.replyCharacters)));
      assert.match(text.refusals.notesFull(limits), new RegExp(String(limits.typedNotes)));
      assert.equal(refusal(lang, 'noteLong', limits), text.refusals.noteLong(limits));
    }
  }
});
