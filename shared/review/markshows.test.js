// node --test shared/review/markshows.test.js   (whether a mark's element is still what it was drawn on, and where it's tested)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { middleIn, sameWords } from './markshows.js';

test('a card whose time moved on is still the card; another screen in the same box is not', () => {
  const card = 'Get shared screens reaching the call’s agent. Next: check the fix, starts 19:18. 0 of 1 done';
  assert.ok(sameWords(card, card));
  assert.ok(sameWords(card, card.replace('19:18', '19:42')));
  assert.ok(sameWords(card, `${card.toUpperCase()} (1 new)`), 'case and a word more change nothing');
  assert.ok(!sameWords(card, 'Fix the loose ends from the book search review. Next: tidy four, starts 19:48'));
  assert.ok(!sameWords('Lark, Process: HQ and review mode', 'Kit, Product: the shop and its stalls'));
  assert.ok(!sameWords(card, ''), 'an emptied box is not the card');
});

test('an element that had no words (a picture, a private field) is told by where it is alone', () => {
  assert.ok(sameWords('', 'anything at all'));
  assert.ok(sameWords(undefined, ''));
});

test('a mark is tested at its middle, kept inside its element', () => {
  const el = { left: 100, top: 50, right: 300, bottom: 150 };
  assert.deepEqual(middleIn({ x: 150, y: 80, w: 100, h: 40 }, el), [200, 100]);
  assert.deepEqual(middleIn({ x: 280, y: 0, w: 100, h: 40 }, el), [299, 51], 'a ring past its corner: just inside it');
  assert.deepEqual(middleIn({ x: 0, y: 0, w: 0, h: 0 }, { left: 10, top: 10, right: 10, bottom: 10 }), [11, 11]);
});
