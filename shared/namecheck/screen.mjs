// A name's quick look in the App Store and the domain registries (shared/namecheck/README.md).
import { setTimeout as pause } from 'node:timers/promises';

const SOURCES = {
  appStore: 'https://itunes.apple.com/search',
  // IANA's list of each top-level domain's RDAP server (RFC 9224).
  rdapBootstrap: 'https://data.iana.org/rdap/dns.json',
};
// Storefronts differ: a Dutch or German app may not be in the US store.
// Exported for the near-match check.
export const COUNTRIES = ['us', 'nl', 'de'];
const RESULTS_PER_COUNTRY = 50;
// Apple's search allows about 20 calls a minute, and each name makes three.
const APP_STORE_PAUSE_MS = 10_000;

async function main(names) {
  if (!names.length) {
    console.error('usage: node shared/namecheck/screen.mjs <name> [name ...]');
    process.exit(2);
  }
  // Every name is checked before the first request, so a refused one never leaves a half-run screen.
  const queries = names.map(querySlug);
  const refusals = queries.filter(query => query.error);
  if (refusals.length) {
    for (const { error } of refusals) console.error(error);
    process.exit(2);
  }
  const registries = await rdapRegistries(SOURCES.rdapBootstrap);
  for (const [i, { name, slug }] of queries.entries()) {
    const domains = await Promise.all(domainsOf(slug).map(domain => domainStatus(domain, registries)));
    const apps = await appStoreHits(slug, SOURCES.appStore, COUNTRIES);
    printScreen(name, slug, apps, domains);
    if (i < names.length - 1) await pause(APP_STORE_PAUSE_MS);
  }
}

// What a name is screened as: { name, slug } ('Vel-mo' → 'velmo', 'Vélmo' → 'velmo': spaces, hyphens and accents
// come off), or { name, error }. A letter with no a–z spelling (Ø, ß, 東) is refused, not dropped, so the screen
// never quietly checks another name (Ølstad as lstad), and nor is a name with nothing left to search.
export function querySlug(name) {
  const letters = [...new Set(name.normalize('NFD').match(/[\p{L}\p{N}]/gu) ?? [])];
  const unsupported = letters.filter(char => !slugOf(char));
  if (unsupported.length) {
    return {
      name,
      error:
        `"${name}": no a–z spelling for ${unsupported.join(' ')}, so the screen can't search it. ` +
        'Spell the name as its domain would be (Ølstad as olstad or oelstad, Straße as strasse) and screen that.',
    };
  }
  const slug = slugOf(name);
  if (!slug) return { name, error: `"${name}": no letters or digits left to screen.` };
  return { name, slug };
}

// ---- domains over RDAP

// Each top-level domain's RDAP server, from IANA's bootstrap file: 'app' → 'https://…/rdap/'.
export async function rdapRegistries(bootstrapUrl) {
  const response = await fetch(bootstrapUrl);
  if (!response.ok) throw new Error(`Could not fetch the RDAP bootstrap ${bootstrapUrl}: HTTP ${response.status}`);
  const bootstrap = await response.json();
  const registries = new Map();
  for (const [tlds, servers] of bootstrap.services) for (const tld of tlds) registries.set(tld, servers[0]);
  return registries;
}

const domainsOf = slug => [`${slug}.app`, `${slug}.studio`, `${slug}apps.com`, `${slug}.com`];

// 'registered' (200), 'unregistered' (404: the registry has no such domain), or 'unclear' with the reason.
export async function domainStatus(domain, registries) {
  const tld = domain.split('.').pop();
  const server = registries.get(tld);
  if (!server) return { domain, status: 'unclear', reason: `no RDAP server for .${tld}` };
  const url = new URL(`domain/${domain}`, server.endsWith('/') ? server : `${server}/`);
  const { response, failure } = await tryFetch(url, { headers: { Accept: 'application/rdap+json' } });
  if (failure) return { domain, status: 'unclear', reason: failure };
  if (response.status === 200) return { domain, status: 'registered' };
  if (response.status === 404) return { domain, status: 'unregistered' };
  return { domain, status: 'unclear', reason: `HTTP ${response.status}` };
}

// ---- the App Store

// The search matches loosely, so only apps with the name in their title or seller are hits; the rest are counted.
// Returns { hits, others } or { error }: a failed search is never "no apps". An app counts once across countries,
// and is a hit if any storefront's title or seller has the name: "Velmo Timer" in the US is "Focus Timer" in Germany.
export async function appStoreHits(slug, searchUrl, countries) {
  // id → every searched storefront's record of the app.
  const apps = new Map();
  for (const country of countries) {
    const search = await searchAppStore(slug, searchUrl, country);
    if (search.error) return { error: search.error };
    for (const app of search.apps) apps.set(app.id, [...(apps.get(app.id) ?? []), app]);
  }
  const hasName = app => [app.app, app.seller].some(text => slugOf(text ?? '').includes(slug));
  const hits = [...apps.values()]
    .map(records => records.find(hasName))
    .filter(Boolean)
    .map(({ app, seller, url }) => ({ app, seller, url }));
  return { hits, others: apps.size - hits.length };
}

// One storefront's search for a term: { apps: [{ id, app, seller, url, storefront }] } or { error }.
// The near-match check (nearmatch.mjs) runs it too.
export async function searchAppStore(term, searchUrl, country) {
  const url =
    `${searchUrl}?entity=software&limit=${RESULTS_PER_COUNTRY}&country=${country}` +
    `&term=${encodeURIComponent(term)}`;
  const { response, failure } = await tryFetch(url);
  const refusal = failure ?? (response.ok ? null : `HTTP ${response.status}`);
  if (refusal) return { error: `the ${country} search for "${term}" failed: ${refusal}` };
  // A 200 can still break off mid-body (the socket closes) or not be JSON.
  const { responseBody, failure: readFailure } = await tryJson(response);
  if (readFailure) return { error: `the ${country} search for "${term}" failed: ${readFailure}` };
  return {
    apps: responseBody.results.map(app => ({
      id: app.trackId,
      app: app.trackName,
      seller: app.sellerName,
      url: app.trackViewUrl,
      storefront: country,
    })),
  };
}

// A network failure as a value, not an exception: { response } or { failure: 'getaddrinfo ENOTFOUND …' }.
// Exported for the near-match check.
export const tryFetch = (url, init) =>
  fetch(url, init).then(
    response => ({ response }),
    err => ({ failure: reasonOf(err) }),
  );

// A body that breaks off or isn't JSON, as a value: { responseBody } or { failure: 'other side closed' }.
const tryJson = response =>
  response.json().then(
    responseBody => ({ responseBody }),
    err => ({ failure: reasonOf(err) }),
  );

// fetch's own errors say only "fetch failed" or "terminated": the cause says why.
const reasonOf = err => err.cause?.message ?? err.message;

const slugOf = name =>
  name
    .normalize('NFD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// ---- the report

function printScreen(name, slug, apps, domains) {
  console.log(name === slug ? slug : `${name}  (screened as ${slug})`);
  if (apps.error) console.log(`  App Store: unclear (${apps.error})`);
  else {
    console.log(
      `  App Store (${COUNTRIES.join(', ')}): ${apps.hits.length} apps with "${slug}" in the title or ` +
        `seller, ${apps.others} other results`,
    );
    for (const hit of apps.hits) console.log(`    ${hit.app}  by ${hit.seller}  ${hit.url}`);
  }
  for (const domain of domains) {
    console.log(`  ${domain.domain.padEnd(24)} ${domain.status}${domain.reason ? ` (${domain.reason})` : ''}`);
  }
}

// Last, after the arrow consts above, so they exist when main runs.
if (import.meta.main) await main(process.argv.slice(2));
