// node --test platform/hq/shell/booksearchwords.test.js   (the book's Search: words found as the board writes; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findIn, marked, termsOf } from './booksearchwords.js';

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const entry = (text, day, at = '') => ({ text, day, at });

test('a query is its words, folded, each once', () => {
  assert.deepEqual(termsOf('  Tear, tear LINE? '), ['tear', 'line']);
  assert.deepEqual(termsOf('Café crème'), ['cafe', 'creme']);
  assert.deepEqual(termsOf(''), []);
  assert.deepEqual(termsOf('?!'), []);
});

test('each word finds a word that starts with it, in any case and with or without accents', () => {
  const said = 'The tear line is too dark, like the Café’s';
  assert.equal(marked(said, termsOf('tea'), esc), 'The <mark>tea</mark>r line is too dark, like the Café’s');
  // (inside a word finds nothing: "ear" isn't a word of it)
  assert.equal(marked(said, termsOf('ear'), esc), said);
  assert.equal(marked(said, termsOf('cafe'), esc), 'The tear line is too dark, like the <mark>Café</mark>’s');
  // (an accent written as its own mark is the letter's: the find ends after it)
  const decomposed = 'Cafe\u0301 au lait';
  assert.equal(marked(decomposed, ['cafe'], esc), '<mark>Cafe\u0301</mark> au lait');
});

test('every word of the query must be found; the newest first; the words around the find', () => {
  const entries = [
    entry('Make the price bigger', '2026-10-24'),
    entry('The tear line is too dark next to the price', '2026-10-25', '2026-10-25T16:40:00Z'),
    entry('Price tag: tear it off', '2026-10-26'),
  ];
  assert.deepEqual(
    findIn(entries, 'price').found.map(e => e.day),
    ['2026-10-26', '2026-10-25', '2026-10-24'],
  );
  assert.deepEqual(
    findIn(entries, 'tear pri').found.map(e => e.day),
    ['2026-10-26', '2026-10-25'],
  );
  assert.deepEqual(findIn(entries, 'tear bigger'), { found: [], total: 0 });
  assert.deepEqual(findIn(entries, ' '), { found: [], total: 0 });
});

test('past the newest finds the rest are counted, never dropped silently', () => {
  const entries = Array.from({ length: 40 }, (_, i) =>
    entry(`Price ${i}`, '2026-10-26', `2026-10-26T10:${String(i).padStart(2, '0')}:00Z`),
  );
  entries.push(...Array.from({ length: 60 }, () => entry('Nothing to see', '2026-10-26')));
  const { found, total } = findIn(entries, 'price');
  assert.equal(total, 40);
  assert.ok(found.length < total, `${found.length} shown`);
  assert.equal(found[0].text, 'Price 39', 'the newest first');
});

test('a long text is cut to the words around its first find, at spaces', () => {
  const long = `${'word '.repeat(40)}the needle here ${'more '.repeat(40)}`.trim(),
    cut = findIn([entry(long, '2026-10-26')], 'needle').found[0].text;
  assert.ok(cut.startsWith('…word') && cut.endsWith('more…'), cut);
  assert.ok(cut.includes('the needle here'));
  assert.ok(cut.length < 150, `${cut.length} characters`);
  assert.equal(findIn([entry('Short one', '2026-10-26')], 'short').found[0].text, 'Short one');
});

test('the finds marked, the rest escaped', () => {
  assert.equal(marked('Tear <b> and tears', ['tear'], esc), '<mark>Tear</mark> &lt;b> and <mark>tear</mark>s');
  assert.equal(marked('Nothing here', ['tear'], esc), 'Nothing here');
});
