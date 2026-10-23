// node --test shared/namecheck/nearwords.test.mjs   (small word lists in the test; no network)
// (formatted)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edits, nearWords } from './nearwords.mjs';

const lists = (words, rudeWords = [], code = 'nl') => {
  const empty = { nl: new Map(), en: new Map(), de: new Map() };
  return {
    frequency: { ...empty, [code]: new Map(words.map(word => [word, 100])) },
    rude: { ...empty, [code]: new Map(rudeWords.map(word => [word, 'bad-word list'])) },
  };
};

test('a first sound swapped whole finds the rude word one cluster away', () => {
  assert.ok(edits('Pliemel').has('piemel'));
});

test('one letter swapped, added or dropped, and one sound respelled, are all tried', () => {
  const variants = edits('morvel');
  for (const word of ['morel', 'morvels', 'morval', 'moorvel', 'borvel']) assert.ok(variants.has(word), word);
});

test('only real words come back, a rude one before a commoner plain one', () => {
  const found = nearWords('Pliemel', lists(['pliemels', 'brood', 'piemel'], ['piemel'])).words;
  assert.deepEqual(
    found.map(word => word.variant),
    ['piemel', 'pliemels'],
  );
  assert.deepEqual(found[0].rude, ['Dutch bad-word list']);
});

test('a sound of more than one letter is added and dropped away from the first sound too', () => {
  assert.ok(edits('Pooch').has('poo'));
  assert.ok(edits('Poo').has('pooch'));
  const english = lists(['poo', 'pooch', 'brood'], ['poo'], 'en');
  assert.deepEqual(
    nearWords('Pooch', english).words.map(word => word.variant),
    ['poo'],
  );
  assert.deepEqual(
    nearWords('Poo', english).words.map(word => word.variant),
    ['pooch'],
  );
});

test('every cluster a word starts with replaces the first sound, cr included', () => {
  assert.ok(edits('Flap').has('crap'));
  const found = nearWords('Flap', lists(['crap', 'brood'], ['crap'], 'en')).words;
  assert.deepEqual(
    found.map(word => word.variant),
    ['crap'],
  );
  assert.deepEqual(found[0].rude, ['English bad-word list']);
});

test('any sound is swapped for any other, th and tch included, and th is added and dropped', () => {
  const pairs = [
    ['Bish', 'bitch'],
    ['Pith', 'piss'],
    ['Booth', 'boo'],
    ['Boo', 'booth'],
  ];
  for (const [name, word] of pairs) assert.ok(edits(name).has(word), `${name} → ${word}`);
  const english = lists(['bitch', 'piss', 'boo', 'booth', 'brood'], ['bitch', 'piss'], 'en');
  for (const [name, word] of pairs) {
    assert.ok(
      nearWords(name, english).words.some(found => found.variant === word),
      `${name} → ${word}`,
    );
  }
});

test('a variant in no word list with a rude word inside is a warning, apart from the real words', () => {
  const { words, warnings } = nearWords('Duckling', lists([]));
  assert.deepEqual(words, []);
  const fuckling = warnings.find(warning => warning.variant === 'fuckling');
  assert.equal(fuckling.rudeInside, 'fuck');
});

test('a listed word with a rude word inside stays a real word, flagged rude, and is no warning', () => {
  const { words, warnings } = nearWords('Bish', lists(['bitch'], [], 'en'));
  assert.deepEqual(
    words.map(word => [word.variant, word.rude]),
    [['bitch', ['wordcheck: bitch']]],
  );
  assert.ok(!warnings.some(warning => warning.variant === 'bitch'));
});
