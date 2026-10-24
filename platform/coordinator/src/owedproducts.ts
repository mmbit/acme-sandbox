// What takes the board's feedback like a product (owed.ts): our products, and the venture cycles' pages, each with its
// owner and folder.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { REPO_DIR } from './config.ts';
import * as jobs from './jobs.ts';
import { ceo, infra } from './company.ts';

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
// The venture cycles' pages (products/_cycles, at cycles.preview.<zone>: decks, brand directions, sketched sites) take the
// board's feedback like a product, under their host's label (infra/products.py reserves it, so no product has it). No
// product.yaml: each folder in it is one of its own, `cycles/<folder>`, its maker's (maker()); the pages outside any
// folder (`cycles`) and a folder none of our agents made are the CEO's, who hands them on.
export const CYCLES = 'cycles';
const CYCLE = /^cycles\/([a-z0-9][a-z0-9-]{0,60})$/;
export const folder = (slug: string) =>
  slug === CYCLES
    ? 'products/_cycles'
    : CYCLE.test(slug)
      ? `products/_cycles/${slug.slice(CYCLES.length + 1)}`
      : `products/${slug}`;
export const isProduct = (slug: unknown) =>
  typeof slug === 'string' &&
  (CYCLE.test(slug)
    ? isDir(`${REPO_DIR}/${folder(slug)}`)
    : SLUG.test(slug) &&
      existsSync(slug === CYCLES ? `${REPO_DIR}/products/_cycles` : `${REPO_DIR}/products/${slug}/product.yaml`));
// A product's slug or a cycle folder's key, whether or not it's there now.
export const isKey = (slug: unknown) => typeof slug === 'string' && (SLUG.test(slug) || CYCLE.test(slug));
const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
// What a note on one of slug's pages is about: the product, or the cycle folder the page is in (`/<folder>/...`).
export function about(slug: string, page: string) {
  if (slug !== CYCLES) return slug;
  const key = `${CYCLES}/${page.split(/[/?#]/)[1] ?? ''}`;
  return isProduct(key) ? key : CYCLES;
}
export function ownerOf(slug: string) {
  const cycle = CYCLE.exec(slug)?.[1];
  if (cycle) return { agent: maker(cycle) ?? ceo(), name: cycle };
  let meta: any = {};
  try {
    meta = parse(readFileSync(`${REPO_DIR}/products/${slug}/product.yaml`, 'utf8')) ?? {};
  } catch {
    /* no yaml: the CEO's */
  }
  const agent = typeof meta.owner === 'string' && jobs.findAgent(meta.owner) ? meta.owner : ceo();
  return { agent, name: typeof meta.name === 'string' ? meta.name : slug === CYCLES ? 'Venture cycle pages' : slug };
}
// Who made a cycle folder: the author of the first commit that added a file to it, among our agents on a desk (the worker
// commits a job's work as <agent>@<AGENT_EMAIL_DOMAIN>, and agents commit their own under the same name). A folder's first
// commit never changes, so git is read once for it; a folder without a maker yet (none of its authors is on a desk, or
// git can't be read) is asked again after MAKER_AGAIN.
const makers = new Map<string, { agent: string | null; at: number }>(),
  MAKER_AGAIN = 10 * 60e3;
function maker(name: string) {
  const onDesk = (id: string | null) => !!id && !!jobs.findAgent(id) && !jobs.findAgent(id)!.temp;
  const known = makers.get(name);
  if (known && (known.agent || Date.now() - known.at < MAKER_AGAIN)) return onDesk(known.agent) ? known.agent : null;
  const domain = `@${String(infra().AGENT_EMAIL_DOMAIN ?? '').toLowerCase()}`;
  let agent: string | null = null;
  try {
    // safe.directory: the checkout is root's on the server, mounted read-only (as committed.ts reads it)
    const authors = execFileSync(
      'git',
      [
        '-c',
        `safe.directory=${REPO_DIR}`,
        '--literal-pathspecs',
        '-C',
        REPO_DIR,
        'log',
        '--reverse',
        '--diff-filter=A',
        '--format=%ae',
        'HEAD',
        '--',
        `products/_cycles/${name}`,
      ],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 },
    );
    agent =
      authors
        .split('\n')
        .map(email => email.trim().toLowerCase())
        .filter(email => domain.length > 1 && email.endsWith(domain))
        .map(email => email.slice(0, -domain.length))
        .find(onDesk) ?? null;
  } catch (err) {
    console.error(`Could not read who made products/_cycles/${name}:`, (err as Error).message);
  }
  makers.set(name, { agent, at: Date.now() });
  return agent;
}
// A card's --product / --back slugs: real products (or the cycles' pages), at most 12; null if any isn't.
export function slugs(value: unknown) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? [...new Set(value)] : null;
  return list && list.length <= 12 && list.every(isProduct) ? (list as string[]) : null;
}
