// node --test platform/hq/shell/ink/notebookwords.test.js   (the guest words a guest reads, in every language; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { words, refusal } from './notebookwords.js';

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

// Every word with its key path ('refusals.signIn'), the nested lists (refusals, round) walked
const entries = (table, at = '') =>
  Object.entries(table).flatMap(([key, said]) =>
    typeof said === 'object' ? entries(said, `${at}${key}.`) : [[`${at}${key}`, said]],
  );
const english = new Map(entries(words.en));
const places = said => (said.match(/\{\w+\}/g) ?? []).sort();

test('Dutch and German hold every English key, and no other', () => {
  for (const lang of ['nl', 'de'])
    assert.deepEqual([...new Map(entries(words[lang])).keys()].sort(), [...english.keys()].sort(), lang);
});

test('each word in Dutch and German is said the way its English is: a function, or words with the same places to fill', () => {
  for (const lang of ['nl', 'de'])
    for (const [key, said] of entries(words[lang])) {
      const en = english.get(key);
      assert.equal(typeof said, typeof en, `${lang} ${key}`);
      if (typeof en === 'function') assert.equal(said.length, en.length, `${lang} ${key}: the same arguments`);
      else {
        assert.ok(said.trim(), `${lang} ${key}`);
        assert.deepEqual(places(said), places(en), `${lang} ${key}`);
      }
    }
});
