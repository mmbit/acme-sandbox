// node --test src/entry.test.ts   (one knowledge entry, read once for the chat and a page alike: its cases, its places,
// its question and answer per language, the chat's part; a conversation's view of it in its own language, its word-for-word
// quotes in that language only)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry, inLanguage, quotes } from './entry.ts';

const ENTRY = `---
question: Can I cancel my order?
question.nl: "Kan ik mijn bestelling annuleren?"
question.de: Kann ich meine Bestellung stornieren?
faq: shop, hubbub-jigsaw
source: the Terms of sale
verified: 2026-10-21
answers: "H-1001, H-12"
---
Yes, until printing starts.

## nl
Ja, tot het drukken begint.

## de
Ja, bis der Druck beginnt.

## chat
Only the chat reads this.
`;

test('an entry: its cases, its places, its question and answer per language, and the chat part apart', () => {
  const e = parseEntry(ENTRY);
  assert.deepEqual(e.answers, ['H-1001'], 'case ids only');
  assert.deepEqual(e.places, ['shop', 'hubbub-jigsaw']);
  assert.deepEqual(e.question, {
    en: 'Can I cancel my order?',
    nl: 'Kan ik mijn bestelling annuleren?',
    de: 'Kann ich meine Bestellung stornieren?',
  });
  assert.deepEqual(e.answer, {
    en: 'Yes, until printing starts.',
    nl: 'Ja, tot het drukken begint.',
    de: 'Ja, bis der Druck beginnt.',
  });
  assert.equal(e.chat, 'Only the chat reads this.');
  assert.deepEqual(e.front, ['source: the Terms of sale', 'verified: 2026-10-21']);
});

test("a conversation's view: its language's question and answer, the chat part, no case ids or places", () => {
  const e = parseEntry(ENTRY);
  assert.equal(
    inLanguage(e, 'nl'),
    '---\nquestion: Kan ik mijn bestelling annuleren?\nsource: the Terms of sale\nverified: 2026-10-21\n---\nJa, tot het drukken begint.\nOnly the chat reads this.',
  );
  assert.equal(inLanguage(e, 'fr'), inLanguage(e, 'en'), 'English where it has none');
  const old = parseEntry('---\nquestion: Old one?\nsource: a page\n---\nJust English.');
  assert.deepEqual(
    [old.places, inLanguage(old, 'de')],
    [[], '---\nquestion: Old one?\nsource: a page\n---\nJust English.'],
  );
  assert.equal(inLanguage(parseEntry('No frontmatter.'), 'en'), 'No frontmatter.');
});

const QUOTED = `---
question: How long does a refund take?
source: the Terms of sale
---
EN: Refunds go back to the card.

NL: Het bedrag gaat terug naar de kaart.

DE: Der Betrag geht zurück auf die Karte.

## chat
Say it plainly, then:

NL: Alleen in het Nederlands.

DE: Nur auf Deutsch.

Then what Poppy can do here.`;

test("a page's quotes: a conversation reads its own language's of each run (the English where a run has none), the rest on asking", () => {
  const e = parseEntry(QUOTED);
  const view = (lang: string) => inLanguage(e, lang).split('---\n').at(-1);
  assert.equal(
    view('nl'),
    'NL: Het bedrag gaat terug naar de kaart.\nSay it plainly, then:\n\nNL: Alleen in het Nederlands.\n\nThen what Poppy can do here.',
  );
  assert.equal(
    view('en'),
    'EN: Refunds go back to the card.\nSay it plainly, then:\n\nNL: Alleen in het Nederlands.\n\nDE: Nur auf Deutsch.\n\nThen what Poppy can do here.',
    'a run with no English stays whole',
  );
  assert.match(view('fr')!, /^EN: Refunds/);
  assert.equal(
    quotes(e, 'de'),
    '---\nquestion: How long does a refund take?\nsource: the Terms of sale\n---\nDE: Der Betrag geht zurück auf die Karte.\nDE: Nur auf Deutsch.',
  );
  assert.equal(quotes(e, 'fr'), '');
  assert.equal(quotes(parseEntry(ENTRY), 'nl'), '', "a page's own languages aren't quotes");
});
