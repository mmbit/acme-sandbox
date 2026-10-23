// wordcheck.js: does a generated name or a printed text contain a word we'd never print on purpose?
// (formatted)
// One file for the browser and Node, imported by its path in the repo: Caddy serves it to the browser
// (infra/products.md).
//
//   blocked(text, ...typed)  the first blocked word in `text` that isn't also in what the customer typed, or null.
//
// For a generator, a hit means "try the next option": a false alarm costs one variant, a miss costs a screenshot.
// For customer text we print, a hit means "a human looks before it prints", never an automatic refusal: people are
// really called Dick, Con or Kutlu, and the typed-input exception can't help when the text is all theirs.
// Also run blocked(typed) on the raw typed input, with no exception: the exception would pass "Hitlerland" typed as
// "Hitler". On a hit there too, a human looks (checklist item 9). Expect false alarms on customer text (names, German
// compounds); the ALLOW list below takes the common ones.

// Found anywhere inside a word ("Farnazia" → nazi, "Morgasmina" → orgasm).
// prettier-ignore
const ANYWHERE = [
  // English
  'fuck', 'cunt', 'shit', 'bitch', 'whore', 'slut', 'penis', 'porn', 'orgasm', 'boob', 'arse', 'nigg', 'faggot', 'wank',
  'twat', 'piss', 'dildo', // (piss, dildo)
  // Dutch
  'kanker', 'tyfus', 'pokken', 'kut', 'hoer', 'neuk', 'flikker', 'mongool', 'neger', 'slet', 'klootzak',
  // German
  'fick', 'fotze', 'hure', 'wichs', 'arsch', 'scheis', 'kacke', 'pisse', 'titte', 'schwuchtel', 'spast', 'zigeuner',
  // French
  'merde', 'putain', 'salope', 'connard', 'encule', 'negre',
  // Turkish (a large community in NL, BE and DE)
  'orospu', 'siktir', 'yarrak',
  // Extremist
  'nazi', 'hitler', 'fuhrer', 'fuehrer', 'kkk', '1488',
];
// At the start of a word: Dutch curses build compounds (teringlijer), but "tering" also ends catering and lettering.
const START = ['tering', 'klere'];
// Only as a whole word: too common inside innocent words (unique, computer, connect, Janus, cocktail, grape).
// "88" and "ss" are extremist codes on their own.
// prettier-ignore
const WHOLE = ['con', 'conne', 'cock', 'dick', 'anus', 'rape', 'pute', 'nique', 'lul', 'pik', 'mof', 'heil', 'sik',
  'amk', '88', 'ss',
  'raped', 'rapes', 'rapist', 'fagot', 'homo', 'homos', 'kike', 'kikes', 'paki', 'pakis', 'dago', 'dagos', 'kafir',
  'pedo', 'pedos'];
// Innocent words that contain a stem above. Removed before looking. Never one that starts with a stem and could go on
// into a real bad word ("kutsch" would hide "kutschool", so it's "kutsche").
// prettier-ignore
const ALLOW = ['marseill', 'parse', 'brochure', 'neukolln', 'schwank', 'fickle', 'kutsche', 'scunthorpe',
  'fuhrerschein', 'reisefuhr', 'geschaftsfuhr', 'marsch', 'barsch', 'swank'];
// Innocent only as a whole word or part: "hoera" and "kutter" also start "hoerachtig" and "kutterrein".
const ALLOW_WHOLE = ['hoera', 'kutter', 'kutters'];

const norm = s =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
const alnum = w => w.replace(/[^a-z0-9]/g, '');
// Words: split on spaces and "&", "+", "/", "," ... Each word is checked glued together ("Nèg-re" → negre) and in its
// parts split on hyphens, dashes, apostrophes and underscores ("SS-Totenkopf" → ss).
// A digit that stands in for a letter is also read as that letter ("N4ZI", "H1TLER"). Each 1 is read as i or l on its
// own ("H311" → heil). Only a word or part of three or more characters with letters and digits is read that way, so
// "88", "1488", a year, "Route 55" or "Galaxy S5" stay as typed. The glued word is read as a whole, so a digit-only
// part counts too ("N4Z-1" → nazi). The typed form always matches as well.
// A word becomes a list of what each place can be read as ("h311" → h, 3e, 1il, 1il), and stems are matched against it
// place by place, so no reading is ever spelled out.
const LEET = { 0: 'o', 1: 'il', 3: 'e', 4: 'a', 5: 's', 7: 't' };
const mixed = w => w.length > 2 && /[a-z]/.test(w) && /[0-9]/.test(w);
const places = (w, readDigits) => [...w].map(c => (readDigits ? c + (LEET[c] ?? '') : c));
const at = (word, stem, i) => [...stem].every((c, j) => word[i + j]?.includes(c));
const has = (word, stem) => word.some((_, i) => at(word, stem, i));
const is = (word, stem) => word.length === stem.length && at(word, stem, 0);
const pieces = s =>
  norm(s)
    .split(/[\s&+/,;:.!?()]+/)
    .flatMap(w => {
      const word = alnum(w);
      const parts = w
        .split(/[-\u2010-\u2015\u2212'\u2019_]+/)
        .map(alnum)
        .filter(Boolean);
      if (!word) return [];
      return [
        {
          word: places(word, mixed(word)),
          parts: parts.map(part => places(part, mixed(part))),
          glued: parts.map(part => places(part, mixed(word))),
        },
      ];
    });
// Each allow-list word found becomes one "_" place.
const clean = word =>
  ALLOW.reduce((left, a) => {
    const out = [];
    for (let i = 0; i < left.length;) {
      if (at(left, a, i)) {
        out.push('_');
        i += a.length;
      } else out.push(left[i++]);
    }
    return out;
  }, word);
const cleanParts = parts => parts.map(part => (ALLOW_WHOLE.some(a => is(part, a)) ? ['_'] : clean(part)));

export function blocked(text, ...typed) {
  const own = typed.flatMap(pieces).flatMap(p => [p.word, ...p.parts]);
  const mine = b => own.some(w => has(w, b));
  for (const { word, parts, glued } of pieces(text)) {
    const cleaned = cleanParts(parts);
    const w = clean(cleanParts(glued).flat());
    // Skip what they typed while searching, so an exempted "kut" in "Kutlunazi" can't hide the "nazi" after it.
    // A short whole word is only theirs if they typed exactly that word: "Dickens" doesn't cover "Port Dick".
    const hit =
      ANYWHERE.find(b => has(w, b) && !mine(b)) ||
      START.find(b => [w, ...cleaned].some(x => at(x, b, 0)) && !mine(b)) ||
      [word, ...parts].map(x => WHOLE.find(b => is(x, b) && !own.some(o => is(o, b)))).find(Boolean);
    if (hit) return hit;
  }
  return null;
}
