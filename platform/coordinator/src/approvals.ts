// Approval records (house rule 2): what the board approved on the desk phone, by pressing Approve on an approval
// request that names a grant. Only the board's answer writes one; agents can ask, never grant. One small file per
// grant in the coordinator's data volume, so the deploy (infra/products.py, on the host) and the gated tools here
// read the same record.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR, PUBLIC_HOST, ZONE as OWN_ZONE } from './config.ts';
import { manifest, servedDomain } from './manifests.ts';

const DIR = process.env.APPROVALS_DIR ?? `${DATA_DIR}/approvals`;
export const FRONT = 'front';
// No zone on a server's IP host: its products wait for a domain (infra/products.py), so they have no address yet.
// Development on localhost keeps www.localhost.
const ZONE = OWN_ZONE || (PUBLIC_HOST === 'localhost' ? 'localhost' : '');
mkdirSync(DIR, { recursive: true, mode: 0o700 });

// live:<slug>: the product's first launch (AUTHORITY.md): its public site, live payments and live Print API orders.
// site:<slug>: only its public site, with ordering closed (no live payments, no partner keys), for example so Stripe can
// review it before the board opens the account. Taking orders still needs live:<slug>. ("no live payments": the front
// keeps test ones for its basket.) One card may grant one kind to several products, comma-separated (site:a,b,c): the
// board approves them together, and each gets its own record.
const SLUG = '[a-z0-9][a-z0-9-]{0,40}';
export const GRANT = new RegExp(`^(live|site):${SLUG}(,${SLUG})*$`);
const SINGLE_GRANT = new RegExp(`^(live|site):${SLUG}$`);
const kindOf = (grant: string) => grant.split(':')[0];
// a grant's products, each once
const slugsOf = (grant: string) => [...new Set(grant.split(':')[1].split(','))];
const list = new Intl.ListFormat('en-GB', { type: 'conjunction' });
// Credential grants: a company's own tool registers one (a one-off test order to an
// address, say). Not an approval request's grant: the board gives it by saving all of its keys on the one credential request
// that asks for exactly those keys, and the record is a file here like an approval's. The tool says, in the board's words,
// what saving them approves and what happens next, and closes its keys when it's done with them: then no request may ask for
// them, the desk phone says why, and saving one keeps nothing.
export type CredentialGrant = {
  keys: string[];                 // the key store's names (the tool registers them in secrets.ts too)
  approves: string;               // what saving them all approves (describe())
  saved: string;                  // the answer once all are saved: what happens next
  closed: () => boolean;          // whether its keys are closed now
  closedCard: string;             // the desk phone's line on a request for them once closed
  closedAnswer: string;           // the answer to it then (nothing saved)
};
const credentials = new Map<string, CredentialGrant>();
export function registerCredential(grant: string, c: CredentialGrant) {
  if (!/^[a-z0-9-]{1,40}:[a-z0-9-]{1,40}$/.test(grant) || GRANT.test(grant) || credentials.has(grant) || tools.has(grant.split(':')[0])
    || !c.keys.length)
    throw new Error(`approvals: ${grant} can't be a credential grant`);
  credentials.set(grant, { ...c, keys: [...c.keys] });
}
export const credential = (grant: string) => credentials.get(grant);
// the closed credential grant a request for these keys would touch (one of its keys is among them), if any
export const closedFor = (names: string[]) => [...credentials.values()].find(c => names.some(n => c.keys.includes(n)) && c.closed());
// Grants a gated tool decides itself: a company's own module registers a prefix (say remedy:<n>, a remedy waiting for
// the board's tap). The coordinator files those cards itself (kind = the tool's kind), never an agent; Approve or Not
// now goes to the tool, which keeps its own record, not a file here. A tool whose grant may be about a customer's case
// says which with caseOf (the case's reference, or null): Care then shows its open requests, on that case's card
// (care.ts).
type Tool = { kind: string; describe(grant: string): string; decide(grant: string, yes: boolean, request: number): boolean;
  caseOf?(grant: string): string | null };
const tools = new Map<string, Tool>();
export const register = (prefix: string, tool: Tool) => { tools.set(prefix, tool); };
export const toolFor = (grant: string | null | undefined) => grant ? tools.get(grant.split(':')[0]) : undefined;
// what an agent may never ask for: a request of a tool's kind, or one naming a tool's grant
export const toolKind = (kind: string) => [...tools.values()].some(t => t.kind === kind);
// a request that names a grant: an approval with live:/site:, or a tool's own kind with its own grant
export const grantable = (kind: string, grant: string) => kind === 'approval' ? GRANT.test(grant) : toolFor(grant)?.kind === kind;
// Not now on a request with a grant: a tool's grant is told (an approval's simply isn't recorded)
export const decline = (grant: string, request: number) => { toolFor(grant)?.decide(grant, false, request); };
const valid = (grant: string) => SINGLE_GRANT.test(grant) || credentials.has(grant);
const file = (grant: string) => `${DIR}/${grant.replace(':', '-')}.json`;

// The grant a credential request carries: a registered one's, when it asks for exactly its keys
export const credentialGrant = (names: string[]) => [...credentials].find(([, c]) =>
  names.length === c.keys.length && c.keys.every(k => names.includes(k)))?.[0] ?? null;

// What pressing Approve (or saving the address) does, in the coordinator's words: the board reads this, not the agent's own description.
export function describe(grant: string) {
  const tool = toolFor(grant);
  if (tool) return tool.describe(grant);
  const c = credentials.get(grant);
  if (c) return c.approves;
  // the addresses they will have once approved, and a launch shows the site as its preview does (the look switch)
  const slugs = slugsOf(grant), single = slugs.length === 1;
  const names = list.format(slugs);
  const where = list.format(slugs.flatMap(slug => publicAddresses(slug, true)).map(address => address.replace(/^https:\/\//, '')));
  const website = single ? `${names}'s website` : `the websites of ${names}`;
  const launch = single ? 'its' : "each one's";
  const sitesUp = single ? 'the site is' : 'the sites are';
  const previews = single ? 'its preview' : 'their previews';
  const preview = single ? 'the site as its preview shows it' : 'each site as its preview shows it';
  const at = ZONE ? `at ${where}` : 'once the company has a domain (it has none yet)';
  const description = kindOf(grant) === 'site'
    ? `Approving puts ${website} up for the public ${at}, without the preview login. It takes no orders and no money: ordering stays closed, with no card payments and no Print API orders, until you approve ${launch} launch. While ${sitesUp} up, ordering is closed on ${previews} too.`
    : `Approving puts ${names} live: ${preview}, public ${at} without the preview login, real card payments through Stripe and real Print API orders.`;
  if (!slugs.includes(FRONT) || !ZONE) return description;
  const host = shopHost(true);
  if (host === `www.${ZONE}`) return description;
  return `${description} Approving also moves our other public apps to ${host}, each at its own path there, and sends visitors to www.${ZONE} on to ${host}.`;
}

// Where infra/products.py serves a public product. Our front door (FRONT) is at the shop's host. Every other product
// is on its shelf there (<shop host>/<slug>/), or at its own domain alone when it has one that can be served, since its
// shelf then sends page loads there. With approving set, it gives the addresses
// the product will have once the board approves its grant. None while the company has no domain.
export function publicAddresses(slug: string, approving = false) {
  if (!ZONE) return [];
  const domain = manifest(slug)?.domain;
  const own = servedDomain(domain) ? [`https://${domain}`] : [];
  if (slug !== FRONT && own.length) return own;
  const host = shopHost(isPublic(FRONT) || (approving && slug === FRONT));
  const shelf = slug === FRONT ? `https://${host}` : `https://${host}/${slug}/`;
  return [...new Set([shelf, ...own])];
}
// The shop's host: the front's own domain while the front is public there, else www.<zone>
function shopHost(frontPublic: boolean) {
  const domain = manifest(FRONT)?.domain;
  return frontPublic && servedDomain(domain) ? domain : `www.${ZONE}`;
}
// Live in its manifest, with the board's launch or site approval: infra/products.py serves it to the public
export const isPublic = (slug: string) =>
  manifest(slug)?.status === 'live' && !!(approved(`live:${slug}`) || approved(`site:${slug}`));

export function record(grant: string, request: number) {
  const tool = toolFor(grant);
  if (tool) return tool.decide(grant, true, request);
  const grants = GRANT.test(grant) ? slugsOf(grant).map(slug => `${kindOf(grant)}:${slug}`) : valid(grant) ? [grant] : [];
  for (const each of grants) writeFileSync(file(each), JSON.stringify({ grant: each, request, approved: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return grants.length > 0;
}

export function approved(grant: string): { grant: string; request: number; approved: string } | null {
  if (!valid(grant)) return null;
  try {
    const a = JSON.parse(readFileSync(file(grant), 'utf8'));
    return a?.grant === grant ? a : null;
  } catch { return null; }
}
