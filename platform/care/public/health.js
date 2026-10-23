// The health-detail check: does a customer's own message hold a health term? The widget runs it before a message
// leaves the device, and care runs it again before anything reaches the model (engine.ts say(), the helper's history),
// so a script that skips the widget gets no further. It reads only what the customer typed, never the model's words.
// Plain JS with no imports, so the widget and care use this one file.
//
// The terms are the company's, one list per language (its plug-in's `public/plugin.js` `health`: { en, nl, … }, each a
// text with one term per line), given by use(): widget.js does in the browser, the server's plug-in loader at start.
// Every message is checked against all of them: customers write in any language, whatever the page's. A term matches as
// a whole word (or whole words, any space or hyphen between them), in any case, with or without accents ("fruhchen" is
// "Frühchen"). A `*` at either end lets the word go on there, for compounds ("*krankenhaus" also matches
// "Kinderkrankenhaus"). `#` starts a comment. Email addresses are left out of the check (a step waiting for one mustn't
// be held for "ill@…").

const fold = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const terms = (list) => list.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
function pattern(term) {
  const t = fold(term), pre = t.startsWith('*'), post = t.endsWith('*');
  const core = t.replace(/^\*|\*$/g, '').split(/[\s-]+/).map(escape).join('[\\s\\p{Pd}]+');
  // a leading `*` needs nothing before the term: a match may start mid-word (`\p{L}*` there would rescan a long run of
  // letters from every start, quadratic in it). Otherwise the character before the term is taken (Safari has lookbehind

  return `${pre ? '' : '(?:^|[^\\p{L}\\p{N}])'}${core}${post ? '\\p{L}*' : ''}(?![\\p{L}\\p{N}])`;
}
let ALL = null, ANY = null;
export let LANG_TERMS = {}; // each language's terms, for the tests and the eval
export function use(lists = {}) {
  LANG_TERMS = Object.fromEntries(Object.entries(lists).map(([lang, list]) => [lang, terms(list)]));
  ALL = Object.values(LANG_TERMS).flat();
  ANY = ALL.length ? new RegExp(ALL.map((t) => `(${pattern(t)})`).join('|'), 'u') : null;
}
// from the start of a run only: tried at every letter, it would rescan a long run without an @ from each (quadratic).
// Safari before 16.4 has no lookbehind. The pattern matches the character before the address, and the replacement
// puts it back as $1.
const EMAIL = /(^|[\s@<>(),;:"'])[^\s@<>(),;:"']+@[^\s@<>(),;:"']+/g;

// The list's term the message holds (the first one found), or null. Callers never log it: it says what someone wrote.
// Called before use(), it throws: a check that was never given its lists must not pass every message.
export function healthTerm(text) {
  if (!ALL) throw new Error('The health check has no term lists: call use() first');
  const m = ANY?.exec(fold(String(text ?? '').replace(EMAIL, '$1 ')));
  return m ? ALL[m.slice(1).findIndex((g) => g !== undefined)] : null;
}
