// node --test src/health.test.ts   The health-detail check's matcher (public/health.js), on lists given
// here: whole words in any case, compounds where a list says so, accents, and what it must leave alone. A company's own
// terms are tested with its plug-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as health from '../public/health.js';

const { healthTerm } = health;
const LISTS = {
  en: 'born early\nnicu\nill\nc-section\nhospitalized   # a comment after a term\n',
  de: '*krankenhaus*\nfrühchen\nkrank\n',
};

test('before it has its lists, the check refuses rather than passing every message', () => {
  assert.throws(() => healthTerm('a week in the NICU'), /no term lists/);
});

test('with no lists at all, nothing is held', () => {
  health.use({});
  assert.equal(healthTerm('a week in the NICU'), null);
});

test('every term in each language’s list holds its own word, in any case', () => {
  health.use(LISTS);
  assert.deepEqual(Object.keys(health.LANG_TERMS), ['en', 'de']);
  for (const [lang, terms] of Object.entries(health.LANG_TERMS) as [string, string[]][]) for (const term of terms) {
    const word = term.replace(/\*/g, '');
    assert.ok(healthTerm(`about the poster: ${word}, really`), `${lang}: ${term}`);
    assert.ok(healthTerm(word.toUpperCase()), `${lang}: ${term} in capitals`);
  }
});

test('whole words, any spacing or hyphen between a term’s words, every language’s list for every message', () => {
  health.use(LISTS);
  for (const s of ['She was born early', 'born  \nearly', 'a week in the NICU.', 'C section', 'c‑section', 'he was ill', 'sie ist krank'])
    assert.ok(healthTerm(s), s);
  for (const s of ['I’ll send it', "I'll check", 'skill', 'pillow', 'early bird', 'Kranich', 'a comment after a term'])
    assert.equal(healthTerm(s), null, s);
});

test('a `*` at an end lets the word go on there, and accents are folded both ways', () => {
  health.use(LISTS);
  for (const s of ['im Kinderkrankenhaus', 'die Krankenhausrechnung', 'unser Frühchen', 'unser Fruhchen', 'UNSER FRÜHCHEN'])
    assert.ok(healthTerm(s), s);
  assert.equal(healthTerm('unser Frühchenkleid'), null, 'no `*`: the word ends there');
});

test('an email address is left out of the check: an address step mustn’t be held for its letters', () => {
  health.use(LISTS);
  assert.equal(healthTerm('ill@example.com'), null);
  assert.equal(healthTerm('my email is born.early@example.com'), null);
  assert.ok(healthTerm('ill, write to anna@example.com'));
});

test('it reports which term matched, for the tests and the eval (never for a log)', () => {
  health.use(LISTS);
  assert.equal(healthTerm('A week in the NICU'), 'nicu');
  assert.equal(healthTerm('im Kinderkrankenhaus'), '*krankenhaus*');
  assert.equal(healthTerm(''), null); assert.equal(healthTerm(undefined), null);
});

test('a long run of letters with no space is checked in linear time (say(), the history and drafts run it on every message)', () => {
  health.use(LISTS);
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) for (const s of ['a'.repeat(2000), 'xyzq'.repeat(500), 'b'.repeat(1999) + '@']) healthTerm(s);
  assert.ok(performance.now() - t0 < 1500, 'quadratic took about 3.4 s for these 120 checks; linear about 0.1 s');
});
