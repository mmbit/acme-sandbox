// The near-match check: apps a letter away from a name in the App Store and Google Play (shared/namecheck/README.md).
import { setTimeout as pause } from 'node:timers/promises';
import * as screen from './screen.mjs';

const SOURCES = {
  appStore: 'https://itunes.apple.com/search',
  // Google Play has no search API. Its robots.txt allows the search page, and the page lists each app's link.
  googlePlay: 'https://play.google.com/store/search',
};
// Apple's search allows about 20 calls a minute. Google Play gets the same pace, out of courtesy.
const SEARCH_PAUSE_MS = 3_000;
// A failed search is tried once more after this pause. Google Play now and then answers a search with its own
// "Error 500" page, in a 200.
const RETRY_PAUSE_MS = 10_000;
// This many searches in a row without an answer means the store refuses or is down: it isn't asked again.
const FAILURES_IN_A_ROW = 3;

const VOWELS = 'aeiouy';
const CONSONANTS = 'bcdfghjklmnprstvwz';
// Letters an ear takes for one another.
const SOUNDALIKES = {
  b: 'p',
  c: 'ks',
  d: 't',
  f: 'v',
  g: 'k',
  i: 'y',
  k: 'cg',
  m: 'n',
  n: 'm',
  p: 'b',
  s: 'cz',
  t: 'd',
  v: 'fw',
  w: 'v',
  y: 'i',
  z: 's',
};

async function main(names) {
  if (!names.length) {
    console.error('usage: node shared/namecheck/nearmatch.mjs <name> [name ...]');
    process.exit(2);
  }
  const queries = names.map(screen.querySlug);
  const refusals = queries.filter(query => query.error);
  if (refusals.length) {
    for (const { error } of refusals) console.error(error);
    process.exit(2);
  }
  const retryPause = () => pause(RETRY_PAUSE_MS);
  const appStore = { turn: pacer(SEARCH_PAUSE_MS), retryPause };
  const googlePlay = { turn: pacer(SEARCH_PAUSE_MS), retryPause };
  for (const { name, slug } of queries) {
    const terms = [slug, ...neighboursOf(slug)];
    const [appStoreFound, googlePlayFound] = await Promise.all([
      nearMatches(slug, appStoreSearches(terms, SOURCES.appStore, screen.COUNTRIES), appStore),
      nearMatches(slug, googlePlaySearches(terms, SOURCES.googlePlay, screen.COUNTRIES), googlePlay),
    ]);
    printNearMatches(name, slug, terms, { 'App Store': appStoreFound, 'Google Play': googlePlayFound });
  }
}

// A turn per search at most every ms, across all names: await turn() before each one, a retry included.
export function pacer(ms) {
  let nextTurn = 0;
  return async () => {
    const wait = nextTurn - Date.now();
    nextTurn = Math.max(Date.now(), nextTurn) + ms;
    if (wait > 0) await pause(wait);
  };
}

// The neighbours worth a search, in this order, each once and never the name itself:
// - a letter dropped (Bofla → Bofa)
// - two letters side by side swapped (Molbi → Mobli)
// - a consonant turned into the consonant beside it, which doubles that one (Molbi → Mobbi)
// - a vowel changed (Molbi → Malbi)
// - the first letter changed, consonant for consonant or vowel for vowel: a rhyme (Tomli → Fomli)
// - a letter turned into one that sounds alike (Molbi → Molpi)
// - a vowel added at the end (Molbi → Molbio)
// Other one-letter edits (a consonant in the middle for any other) are left out: a store's search often returns
// them anyway, and any result a letter away is a hit, whichever search brought it.
export function neighboursOf(slug) {
  const letters = [...slug];
  const replaced = (i, letter) => letters.with(i, letter).join('');
  const neighbours = [];
  for (const i of letters.keys()) neighbours.push(letters.toSpliced(i, 1).join(''));
  for (const i of letters.keys()) {
    if (i > 0) neighbours.push(slug.slice(0, i - 1) + letters[i] + letters[i - 1] + slug.slice(i + 1));
  }
  const isConsonant = letter => CONSONANTS.includes(letter);
  for (const [i, letter] of letters.entries()) {
    if (!isConsonant(letter)) continue;
    const besides = [letters[i - 1], letters[i + 1]].filter(isConsonant);
    for (const beside of besides) neighbours.push(replaced(i, beside));
  }
  for (const [i, letter] of letters.entries()) {
    if (VOWELS.includes(letter)) {
      for (const vowel of VOWELS) neighbours.push(replaced(i, vowel));
    }
  }
  const rhymes = VOWELS.includes(letters[0]) ? VOWELS : CONSONANTS;
  for (const letter of rhymes) neighbours.push(replaced(0, letter));
  for (const [i, letter] of letters.entries()) {
    for (const soundalike of SOUNDALIKES[letter] ?? '') neighbours.push(replaced(i, soundalike));
  }
  for (const vowel of VOWELS) neighbours.push(slug + vowel);
  return [...new Set(neighbours)].filter(neighbour => neighbour && neighbour !== slug);
}

// ---- the searches

// One search per term and storefront, each a function that returns { apps } or { error }.
export const appStoreSearches = (terms, searchUrl, countries) =>
  terms.flatMap(term => countries.map(country => () => screen.searchAppStore(term, searchUrl, country)));

export const googlePlaySearches = (terms, searchUrl, countries) =>
  terms.flatMap(term => countries.map(country => () => searchGooglePlay(term, searchUrl, country)));

// One storefront's Google Play search: { apps: [{ id, app, seller, url, storefront }] } or { error }. A page with no
// apps counts as an answer only when it says "No results for": anything else may be a page whose layout changed.
export async function searchGooglePlay(term, searchUrl, country) {
  const url = `${searchUrl}?c=apps&hl=en&gl=${country}&q=${encodeURIComponent(term)}`;
  const failed = reason => ({ error: `the ${country} search for "${term}" failed: ${reason}` });
  const { response, failure } = await screen.tryFetch(url);
  if (failure) return failed(failure);
  if (!response.ok) return failed(`HTTP ${response.status}`);
  const { page, failure: readFailure } = await response.text().then(
    page => ({ page }),
    err => ({ failure: err.cause?.message ?? err.message }),
  );
  if (readFailure) return failed(readFailure);
  const apps = googlePlayApps(page, new URL(url).origin, country);
  if (!apps.length && !page.includes('No results for')) return failed('the page lists no apps and no "No results"');
  return { apps };
}

// Each app link on a search page, with its title and seller: the link's first two texts.
function googlePlayApps(page, origin, country) {
  const apps = new Map();
  for (const [, id, inner] of page.matchAll(/<a [^>]*href="\/store\/apps\/details\?id=([\w.]+)"[^>]*>(.*?)<\/a>/gs)) {
    const [app, seller] = [...inner.matchAll(/>([^<>]+)</g)]
      .map(([, text]) => unescapeHtml(text.trim()))
      .filter(Boolean);
    if (!app || apps.has(id)) continue;
    apps.set(id, { id, app, seller, url: `${origin}/store/apps/details?id=${id}`, storefront: country });
  }
  return [...apps.values()];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const unescapeHtml = text =>
  text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (entity, code) => {
    if (code[0] !== '#') return ENTITIES[code] ?? entity;
    const codePoint = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return String.fromCodePoint(codePoint);
  });

// The apps a letter away from the name (or the name itself), from every search in turn: { hits, total, failures,
// notRun }. A search that fails twice is a failure, and FAILURES_IN_A_ROW of them leave the rest not run. The retry
// takes a turn of its own after its pause, so it keeps the spacing with the search after it.
export async function nearMatches(slug, searches, { turn, retryPause }) {
  // id → the hit, with every storefront it showed in.
  const hits = new Map();
  const failures = [];
  let failuresInARow = 0;
  for (const [i, search] of searches.entries()) {
    if (failuresInARow === FAILURES_IN_A_ROW) {
      return { hits: [...hits.values()], total: searches.length, failures, notRun: searches.length - i };
    }
    await turn();
    let found = await search();
    if (found.error) {
      await retryPause();
      await turn();
      found = await search();
    }
    if (found.error) {
      failures.push(found.error);
      failuresInARow++;
      continue;
    }
    failuresInARow = 0;
    for (const app of found.apps) {
      const word = nearWord(slug, app);
      if (!word) continue;
      const hit = hits.get(app.id) ?? { ...app, word, storefronts: [] };
      if (!hit.storefronts.includes(app.storefront)) hit.storefronts.push(app.storefront);
      hits.set(app.id, hit);
    }
  }
  return { hits: [...hits.values()], total: searches.length, failures, notRun: 0 };
}

// The first word of an app's title or seller that is the name or a letter away from it, or undefined.
const nearWord = (slug, app) => [app.app, app.seller].flatMap(wordsOf).find(word => withinOneEdit(word, slug));

const wordsOf = text =>
  (text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/);

// True when a and b are the same, or one letter apart: one swapped, added, dropped, or two side by side transposed.
export function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length > b.length) return a.slice(i + 1) === b.slice(i);
  if (a.length < b.length) return a.slice(i) === b.slice(i + 1);
  const swapped = a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  return a.slice(i + 1) === b.slice(i + 1) || swapped;
}

// ---- the report

export function printNearMatches(name, slug, terms, bySource) {
  console.log(name === slug ? slug : `${name}  (checked as ${slug})`);
  for (const [source, found] of Object.entries(bySource)) {
    const hitsLine = `${found.hits.length} ${found.hits.length === 1 ? 'app' : 'apps'} with the name or a letter away`;
    const unanswered = found.failures.length + found.notRun;
    if (unanswered) {
      const stopped = found.notRun ? `, ${FAILURES_IN_A_ROW} failures in a row stopped it` : '';
      console.log(
        `  ${source}: unclear, ${unanswered} of ${found.total} searches without an answer${stopped}. ` +
          `${hitsLine} in the rest. Search the unanswered ones again later.`,
      );
      for (const failure of found.failures) console.log(`    no answer: ${failure}`);
    } else {
      console.log(`  ${source} (${screen.COUNTRIES.join(', ')}): ${hitsLine}`);
    }
    for (const [word, hits] of Map.groupBy(found.hits, hit => hit.word)) {
      console.log(`    "${word}": ${hits.length}`);
      for (const hit of hits) {
        console.log(
          `      ${hit.app}  by ${hit.seller ?? 'no seller shown'}  (${hit.storefronts.join(', ')})  ${hit.url}`,
        );
      }
    }
  }
  console.log(`  Searched ${terms.length}: ${terms.join(' ')}`);
}

// Last, after the arrow consts above, so they exist when main runs.
if (import.meta.main) await main(process.argv.slice(2));
