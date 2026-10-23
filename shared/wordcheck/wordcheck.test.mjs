// node shared/wordcheck/wordcheck.test.mjs
import assert from 'node:assert/strict';
import { blocked } from './wordcheck.js';

// Real hits, generated from innocent names.
assert.equal(blocked('Farnazia nocturna', 'Farnaz'), 'nazi');
assert.equal(blocked('Morgasmina', 'Morgan & Yasmina'), 'orgasm');
assert.equal(blocked('Boob', 'Bo & Rob'), 'boob');
assert.equal(blocked('Hiroshittany', 'Hiroshi & Brittany'), 'shit');
assert.equal(blocked('Liekuter', 'Lieke & Wouter'), 'kut');
assert.equal(blocked('Larsea vernalis', 'Lars'), 'arse');
// Accents, capitals and hyphens don't hide a word.
assert.equal(blocked('SCHEIß-Insel'), 'scheis');
assert.equal(blocked('Nèg-re'), 'negre');
// What the customer typed themselves isn't held against them.
assert.equal(blocked('Hitchcockland', 'Hitchcock'), null);
assert.equal(blocked('Dickens & Dora', 'Dickens & Dora'), null);
assert.equal(blocked('Kutluland', 'Kutlu & Sem'), null);
// ...but it doesn't hide another word joined to it.
assert.equal(blocked('Kutlunazi', 'Kutlu'), 'nazi');
assert.equal(blocked('Kutluhitler', 'Kutlu'), 'hitler');
assert.equal(blocked('Dickhitler', 'Dick'), 'hitler');
// Customer text: check the output with the exception, and the raw typed input without it. Either hit: a human looks.
assert.equal(blocked('Hitlerland', 'Hitler'), null);
assert.equal(blocked('Hitler'), 'hitler');
// Whole words only for the short ones.
assert.equal(blocked('Isle of Con and Mila'), 'con');
assert.equal(blocked('Constance'), null);
assert.equal(blocked('Heil Hitler'), 'heil');
assert.equal(blocked('Hitler-Insel'), 'hitler');
assert.equal(blocked('Born 1988, loves 88 keys'), '88');
assert.equal(blocked('Teringeiland'), 'tering');
assert.equal(blocked('Mega-teringzooi'), 'tering');
// A hyphen or dash doesn't hide a whole word either.
assert.equal(blocked('SS-Totenkopf'), 'ss');
assert.equal(blocked('SS—Totenkopf'), 'ss');
assert.equal(blocked('Sieg-Heil'), 'heil');
assert.equal(blocked('88-Heil'), '88');
assert.equal(blocked('Tour-88'), '88');
// ...and a typed word only covers exactly that short word.
assert.equal(blocked('Port Dick', 'Dickens'), 'dick');
assert.equal(blocked('Isle of Con', 'Constance & Mila'), 'con');
assert.equal(blocked('Cock Bay', 'Hitchcock'), 'cock');
assert.equal(blocked('Isle of Con', 'Con & Mila'), null);
// The allow list doesn't hide a curse that starts the same way.
assert.equal(blocked('Wat een kutschool'), 'kut');
assert.equal(blocked('Kutschoenen'), 'kut');
assert.equal(blocked('Kutterrein'), 'kut');
assert.equal(blocked('Hoerachtig'), 'hoer');
assert.equal(blocked('Neukollega'), 'neuk');
// A generated code is checked as a whole word too
assert.equal(blocked('RAPED'), 'raped');
assert.equal(blocked('PISSO'), 'piss');
assert.equal(blocked('PAKIS'), 'pakis');
assert.equal(blocked('PEDOS'), 'pedos');
assert.equal(blocked('torpedo pedometer'), null);
// Digits standing in for letters don't hide a word...
assert.equal(blocked('N4ZI'), 'nazi');
assert.equal(blocked('H1TLER'), 'hitler');
assert.equal(blocked('S1UT'), 'slut');
assert.equal(blocked('C0N'), 'con');
assert.equal(blocked('Kutlun4zi', 'Kutlu'), 'nazi');
assert.equal(blocked('Gamer1488'), '1488');
// ...also across a separator with a digit-only part, and with 1 as i and as l in the same word...
assert.equal(blocked('N4Z-1'), 'nazi');
assert.equal(blocked('N4Z_1'), 'nazi');
assert.equal(blocked('5-H1T'), 'shit');
assert.equal(blocked('H311'), 'heil');
assert.equal(blocked('F11KK3R'), 'flikker');
// ...and a real word read from digits is a false alarm we accept: a human looks.
assert.equal(blocked('Sh0er'), 'hoer');
// ...but a gamertag with digits, a year or a number on its own stays clean.
for (const s of [
  'PLAYER1',
  'Class of 2005',
  'Route 55',
  'Tour-55',
  'R2D2',
  'Gamer4life',
  'XxSniper1337xX',
  'Agent 007',
  'Noob123',
  'Ki11er',
  'Pr0gamer',
  'Sh4d0w',
  'Ninja2010',
  'Gh0st_77',
  'J4ck5',
  'Galaxy S5',
  'iPhone 5s',
  'S5',
])
  assert.equal(blocked(s), null, s);
// Innocent words stay innocent, also in customer text.
for (const s of [
  'Our catering, lettering and a unique cocktail',
  'Monique & Janus in Marseille',
  'computer reputation',
  'Kutsche',
  'Kutscher',
  'Kutschen',
  'Kutter',
  'Fischer-Kutter',
  'Hoera!',
  'Hoera-feest',
  'Neukölln',
  'Führer-schein',
  'Constance',
  'Mila, Noor',
  'a bite of cake',
  'sa maison',
  'We got married',
  'Unser Reiseführer',
  'Führerschein',
  'Geschäftsführer',
  'Marschland',
  'Barsch',
  'swanky',
  'Mississippi',
  'grapes',
  'Pakistan',
])
  assert.equal(blocked(s), null, s);
// Clean output.
for (const s of ['Milaland', 'Emmea vernalis', 'Noorjoost', 'Mount Pancake', 'Bay of First Kisses', 'Sannevaland'])
  assert.equal(blocked(s, s), null, s);
console.log('wordcheck: ok');
