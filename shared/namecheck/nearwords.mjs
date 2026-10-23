// A name's near-words: one letter or sound away, real words in Dutch, English or German (shared/namecheck/README.md).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { blocked } from '../wordcheck/wordcheck.js';

const CACHE = process.env.NEARWORDS_CACHE ?? join(homedir(), '.cache', 'nearwords');
const LANGUAGES = { nl: 'Dutch', en: 'English', de: 'German' };
const frequencyUrl = code =>
  `https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/${code}/${code}_50k.txt`;
const badWordsUrl = code =>
  `https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/${code}`;
const WIKTIONARY_CATEGORIES = ['vulgarities', 'offensive terms', 'ethnic slurs'];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
// Wikimedia answers 429 to clients that don't say who they are, and to quick runs of calls.
const USER_AGENT = 'nearwords/1 (a name check; one fetch per list)';
const WIKTIONARY_PAUSE_MS = 1_000;
const RETRIES = 5;
const RETRY_PAUSE_MS = 10_000;

// One sound written with more than one letter, as Dutch, English or German readers spell it. Each of these and each
// letter is swapped for every other, added and dropped, anywhere in the name (Bish → bitch, Pith → piss, Pooch → poo).
// prettier-ignore
const SPELLINGS = [
  'aa', 'ah', 'ai', 'au', 'aw', 'ay', 'ea', 'ee', 'eau', 'ei', 'eu', 'ew', 'ey', 'ie', 'igh', 'ij', 'oa', 'oe', 'oh',
  'oo', 'ou', 'ow', 'oy', 'ue', 'ui', 'uu',
  'bb', 'ch', 'ck', 'cks', 'dd', 'dg', 'dge', 'ff', 'gg', 'gh', 'kk', 'kn', 'ks', 'll', 'mm', 'ng', 'nn', 'ph', 'pp',
  'qu', 'rr', 'sch', 'sh', 'sj', 'ss', 'tch', 'th', 'tj', 'ts', 'tsj', 'tt', 'tz', 'wh', 'wr', 'zz',
];
const SOUNDS = [...ALPHABET, ...SPELLINGS];
// A first sound replaced whole: any single consonant or one of the clusters a Dutch, English or German word starts
// with (Pliemel → piemel, Flap → crap).
// prettier-ignore
const ONSETS = ['bl', 'br', 'chr', 'cl', 'cr', 'dr', 'dw', 'fl', 'fr', 'gl', 'gn', 'gr', 'kl', 'kn', 'kr', 'kw', 'pf',
  'pfl', 'pfr', 'pl', 'pr', 'ps', 'qu', 'sc', 'sch', 'schl', 'schm', 'schn', 'schr', 'schw', 'scr', 'sk', 'sl', 'sm',
  'sn', 'sp', 'spl', 'spr', 'squ', 'st', 'str', 'sw', 'tr', 'ts', 'tw', 'vl', 'vr', 'wh', 'wr', 'zw', 'sh', 'shr',
  'sj', 'ch', 'th', 'thr', 'tj', 'ph'];

async function main(argv) {
  const refresh = argv.includes('--refresh');
  const names = argv.filter(arg => arg !== '--refresh');
  if (!names.length) {
    console.error('usage: node shared/namecheck/nearwords.mjs [--refresh] <name> [name ...]');
    process.exit(2);
  }
  const lists = await loadLists(refresh);
  for (const name of names) printNearWords(name, nearWords(name, lists));
}

// ---- the word lists, fetched once

async function loadLists(refresh) {
  await mkdir(CACHE, { recursive: true });
  const frequency = {};
  const rude = {};
  for (const [code, language] of Object.entries(LANGUAGES)) {
    const frequencyText = await cached(`frequency-${code}.txt`, refresh, () => fetchText(frequencyUrl(code)));
    frequency[code] = new Map(
      frequencyText
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [word, count] = line.trim().split(' ');
          return [word, Number(count)];
        }),
    );
    const badText = await cached(`bad-${code}.txt`, refresh, () => fetchText(badWordsUrl(code)));
    const wiktionaryText = await cached(`wiktionary-${code}.txt`, refresh, () => wiktionaryTerms(language));
    // A bad-word list wins over Wiktionary, whose categories take in every word with one rude sense ("handy").
    rude[code] = new Map([...wordsOf(wiktionaryText, 'has a rude sense'), ...wordsOf(badText, 'bad-word list')]);
  }
  return { frequency, rude };
}

async function cached(file, refresh, fetchList) {
  const path = join(CACHE, file);
  if (!refresh) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      /* not fetched yet */
    }
  }
  const text = await fetchList();
  await writeFile(path, text);
  return text;
}

async function wiktionaryTerms(language) {
  const terms = [];
  for (const category of WIKTIONARY_CATEGORIES) {
    let next = '';
    do {
      const url =
        'https://en.wiktionary.org/w/api.php?action=query&list=categorymembers&cmlimit=500&format=json' +
        `&cmtitle=${encodeURIComponent(`Category:${language} ${category}`)}${next ? `&cmcontinue=${next}` : ''}`;
      const page = JSON.parse(await fetchText(url));
      terms.push(...page.query.categorymembers.map(member => member.title));
      next = page.continue?.cmcontinue ?? '';
      await pause(WIKTIONARY_PAUSE_MS);
    } while (next);
  }
  return terms.join('\n');
}

async function fetchText(url) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (response.ok) return response.text();
    if (response.status !== 429 || attempt === RETRIES) {
      throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
    }
    await pause(attempt * RETRY_PAUSE_MS);
  }
}

const wordsOf = (text, source) =>
  text
    .split('\n')
    .map(word => word.trim().toLowerCase())
    .filter(Boolean)
    .map(word => [word, source]);

// ---- the near-words

// Two lists: words, the variants some word list has (rude ones first, then the commonest), and warnings, the variants
// in no list that the word check finds a rude word inside (Snabit → snabitch, heard as "snab, bitch").
export function nearWords(name, lists) {
  const words = [];
  const warnings = [];
  for (const [variant, how] of edits(name)) {
    const languages = Object.keys(LANGUAGES).filter(code => lists.frequency[code].has(variant));
    const rude = Object.keys(LANGUAGES)
      .filter(code => lists.rude[code].has(variant))
      .map(code => `${LANGUAGES[code]} ${lists.rude[code].get(variant)}`);
    const rudeInside = blocked(variant);
    if (!languages.length && !rude.length) {
      if (rudeInside) warnings.push({ variant, how, rudeInside });
      continue;
    }
    if (rudeInside) rude.push(`wordcheck: ${rudeInside}`);
    const counts = languages.map(code => ({ language: LANGUAGES[code], count: lists.frequency[code].get(variant) }));
    words.push({ variant, how, rude, counts });
  }
  const commonness = word => Math.max(0, ...word.counts.map(entry => entry.count));
  words.sort((a, b) => (b.rude.length > 0) - (a.rude.length > 0) || commonness(b) - commonness(a));
  return { words, warnings };
}

export function edits(name) {
  const word = name.toLowerCase();
  const found = new Map();
  const add = (variant, how) => {
    if (variant && variant !== word && !found.has(variant)) found.set(variant, how);
  };
  for (let i = 0; i <= word.length; i++) {
    for (const sound of SOUNDS) {
      add(word.slice(0, i) + sound + word.slice(i), `add ${sound}`);
      if (!word.startsWith(sound, i)) continue;
      const after = word.slice(i + sound.length);
      add(word.slice(0, i) + after, `drop ${sound}`);
      for (const other of SOUNDS) if (other !== sound) add(word.slice(0, i) + other + after, `${sound} → ${other}`);
    }
  }
  const onset = word.match(/^[^aeiouy]*/)[0];
  const rest = word.slice(onset.length);
  for (const replacement of ['', ...ALPHABET.replace(/[aeiouy]/g, ''), ...ONSETS]) {
    add(replacement + rest, `first sound ${onset || '(none)'} → ${replacement || '(none)'}`);
  }
  return found;
}

// ---- the report

function printNearWords(name, { words, warnings }) {
  const ownWord = blocked(name);
  console.log(
    `${name}${ownWord ? `  BLOCKED by the word check (${ownWord})` : ''}: ${words.length} near-words, ` +
      `${warnings.length} rude-substring warnings`,
  );
  for (const word of words) {
    const where = word.counts.map(entry => `${entry.language} ${entry.count}`).join(', ');
    const flag = word.rude.length ? `  RUDE (${word.rude.join(', ')})` : '';
    console.log(`  ${word.variant.padEnd(14)} ${word.how.padEnd(28)} ${where}${flag}`);
  }
  if (!warnings.length) return;
  console.log('  Rude-substring warnings: in no word list, but the word check finds a rude word inside');
  for (const warning of warnings) {
    console.log(`  ${warning.variant.padEnd(14)} ${warning.how.padEnd(28)} has "${warning.rudeInside}" inside`);
  }
}

// Last, after the arrow consts above, so they exist when main runs.
if (import.meta.main) await main(process.argv.slice(2));
