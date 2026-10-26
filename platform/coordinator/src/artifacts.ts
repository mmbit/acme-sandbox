// HQ's artifact catalog, placed by line of business and project, with presentation history.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { parse } from 'yaml';
import { REPO_DIR } from './config.ts';
import { PREVIEW } from './preview.ts';
import { db } from './db.ts';
import { CYCLES } from './owed.ts';
import * as apps from './apps.ts';
import * as company from './company.ts';
import { anyProject } from './names.ts';

export const KINDS = ['app', 'prototype', 'deck', 'document', 'art', 'film'] as const;
export type Kind = (typeof KINDS)[number];
const FOLDER = /^[a-z0-9][a-z0-9._-]{0,60}$/i; // a folder an artifact.yaml may sit in (none starting with _ or a dot)
const DEPTH = 3;
const COMPANY = 'company/artifacts.yaml';

type Card = { id: number; title: string; day: string };
type PlaceLevel = 'business' | 'project';
type Place = { id: string; name: string; level: PlaceLevel };
// What an artifact's file says: product.yaml and demo.yaml carry the shared fields and its cover, artifact.yaml and
// company/artifacts.yaml the rest too
type Meta = {
  kind?: Kind;
  project?: string;
  business?: string;
  shown?: string;
  cards?: number[];
  archived?: boolean;
  picture?: string;
};
type Entry = Meta & { name: string; about?: string; open?: string };
export type Artifact = {
  id: string;
  name: string;
  kind: Kind;
  about: string;
  open: string;
  icon: string | null;
  picture: string | null;
  status: string | null;
  waiting: boolean;
  public: string[];
  owner: string | null;
  place: Place[];
  shown: string | null;
  cards: Card[];
  hero: boolean;
  archived: boolean;
};
type Found = Omit<Artifact, 'hero'>;

// The company's heroes first, in company/artifacts.yaml's `heroes:` order. The rest newest first, and one the board's day
// isn't known for comes last, by name.
export function list(): Artifact[] {
  const heroes = heroIds();
  const all = [...fromApps(), ...fromFiles(), ...fromCompany()].map(a => ({ ...a, hero: heroes.includes(a.id) }));
  const rank = (a: Artifact) => (a.hero ? heroes.indexOf(a.id) : heroes.length);
  return all.sort(
    (a, b) => rank(a) - rank(b) || (b.shown ?? '').localeCompare(a.shown ?? '') || a.name.localeCompare(b.name),
  );
}
const heroIds = (): string[] =>
  existsSync(`${REPO_DIR}/${COMPANY}`) ? ((yamlAt(COMPANY) as { heroes?: string[] }).heroes ?? []) : [];

// ---------------------------------------------------------------- the products and demos
function fromApps(): Found[] {
  return apps.list().map(app => {
    const demo = app.status === 'demo';
    const where = demo
      ? `products/_cycles/${app.slug.slice(CYCLES.length + 1)}/demo.yaml`
      : `products/${app.slug}/product.yaml`;
    const meta = yamlAt(where) as Meta;
    const tagged = demo ? null : app.slug;
    const folder = where.slice(0, where.lastIndexOf('/'));
    return {
      id: app.slug,
      name: app.name,
      about: app.about,
      open: app.preview,
      icon: app.icon,
      picture: demo ? cycleCover(folder, meta.picture) : cover(folder, meta.picture, app.slug),
      status: demo ? null : app.status,
      waiting: app.waiting,
      public: app.public,
      owner: app.owner,
      ...placed(meta, meta.kind ?? (demo ? 'prototype' : 'app'), tagged),
    };
  });
}

// ---------------------------------------------------------------- artifact.yaml
function fromFiles(): Found[] {
  const root = 'products/_cycles';
  const cycles = existsSync(`${REPO_DIR}/${root}`) ? folders(root).map(cycle => `${root}/${cycle}`) : [];
  const products = folders('products').map(slug => `products/${slug}`);
  return [
    ...cycles.flatMap(cycle => [cycle, ...below(cycle, DEPTH)]),
    ...products.flatMap(product => below(product, DEPTH)),
  ]
    .filter(dir => existsSync(`${REPO_DIR}/${dir}/artifact.yaml`))
    .map(dir => fromFile(dir, yamlAt(`${dir}/artifact.yaml`) as Entry));
}

// In a cycle folder, no `open` means the folder's own page.
function fromFile(dir: string, entry: Entry): Found {
  const [, top, ...rest] = dir.split('/'),
    cycle = top === '_cycles',
    path = rest.join('/');
  return {
    id: `${top}/${path}`,
    name: entry.name,
    about: entry.about ?? '',
    open: cycle ? `https://${CYCLES}${PREVIEW}/${path}/${entry.open ?? ''}` : `https://${top}${PREVIEW}${entry.open}`,
    icon: null,
    picture: cycle ? cycleCover(dir, entry.picture) : cover(`products/${top}`, entry.picture, `${top}/${path}`),
    status: null,
    waiting: false,
    public: [],
    owner: null,
    ...placed(entry, entry.kind!, cycle && rest.length === 1 ? `${CYCLES}/${rest[0]}` : null),
  };
}

// ---------------------------------------------------------------- company/artifacts.yaml
function fromCompany(): Found[] {
  if (!existsSync(`${REPO_DIR}/${COMPANY}`)) return [];
  return (yamlAt(COMPANY) as { artifacts: Entry[] }).artifacts.map(entry => ({
    id: entry.open!,
    name: entry.name,
    about: entry.about ?? '',
    open: entry.open!,
    icon: null,
    picture: cover('company', entry.picture, entry.open!),
    status: null,
    waiting: false,
    public: [],
    owner: null,
    ...placed(entry, entry.kind!, null),
  }));
}

// ---------------------------------------------------------------- covers
// (a product's and company/artifacts.yaml's covers, and every cover's address
// stamped)
// An artifact's cover: its `picture`, a path from its folder (a product's for anything in one, company/ for
// company/artifacts.yaml's). Its address carries the file's time, so HQ keeps it until it changes (GET
// /api/artifacts/picture sends it as never changing) and a new shot shows at once. One that isn't there fails the list.
const stamp = (file: string) => Math.floor(statSync(file).mtimeMs).toString(36);
function cover(dir: string, picture: string | undefined, id: string) {
  const v = picture && safe(picture, /\.(png|jpe?g|webp)$/i) && stamp(`${REPO_DIR}/${dir}/${picture}`);
  return v ? `/api/artifacts/picture?id=${encodeURIComponent(id)}&v=${v}` : null;
}
// The cycles host serves a cycle folder's covers itself (/cycles/), and those may be SVG
function cycleCover(dir: string, picture: string | undefined) {
  const v = picture && safe(picture, /\.(png|jpe?g|webp|svg)$/i) && stamp(`${REPO_DIR}/${dir}/${picture}`);
  return v ? `/${CYCLES}/${dir.slice('products/_cycles/'.length)}/${picture}?v=${v}` : null;
}
const safe = (picture: string, types: RegExp) => !picture.split('/').includes('..') && types.test(picture);

// The cover of the artifact with this id (GET /api/artifacts/picture): the folder it's a path from and the file in it,
// or null. These come from HQ's own origin, so never an SVG.
export function pictureOf(id: string) {
  const entry = existsSync(`${REPO_DIR}/${COMPANY}`)
    ? (yamlAt(COMPANY) as { artifacts: Entry[] }).artifacts.find(e => e.open === id)
    : undefined;
  const parts = id.split('/');
  const found = entry
    ? { dir: 'company', picture: entry.picture }
    : parts.length <= DEPTH + 1 && parts.every(part => FOLDER.test(part))
      ? fileOf(parts)
      : null;
  return found?.picture && safe(found.picture, /\.(png|jpe?g|webp)$/i)
    ? { dir: `${REPO_DIR}/${found.dir}`, file: `/${found.picture}` }
    : null;
}
// a product's own (product.yaml) or an artifact's in a product's folder (artifact.yaml)
function fileOf(parts: string[]) {
  const file = `products/${parts.join('/')}/${parts.length === 1 ? 'product' : 'artifact'}.yaml`;
  return existsSync(`${REPO_DIR}/${file}`)
    ? { dir: `products/${parts[0]}`, picture: (yamlAt(file) as Entry).picture }
    : null;
}

// ---------------------------------------------------------------- place and history
// A child artifact uses its own cards. Only a product or cycle root inherits folder-tagged cards. Its own day wins, else
// its first card's.
function placed(meta: Meta, kind: Kind, tag: string | null) {
  const cards = cardsOf(tag, meta.cards ?? []);
  const first = cards.map(c => c.day).sort()[0];
  const archived = meta.archived === true;
  return { kind, place: placeOf(meta), shown: meta.shown ?? first ?? null, cards, archived };
}

// `project:` places it under its project's business, then the project. `business:` places it under the line of business
// alone. A company without businesses has the project alone.
function placeOf(meta: Meta): Place[] {
  const { businesses } = company.projects();
  if (meta.project) {
    // (a done project's artifacts keep their place.)
    const project = anyProject(meta.project)!,
      business = businesses.find(b => b.id === project.business);
    return [...(business ? [placeFor(business, 'business')] : []), placeFor(project, 'project')];
  }
  if (!meta.business) return [];
  const business = businesses.find(b => b.id === meta.business)!;
  return [placeFor(business, 'business')];
}
const placeFor = (place: { id: string; name: string }, level: PlaceLevel): Place => ({
  id: place.id,
  name: place.name,
  level,
});

// The cards the board has seen (one held back until later counts from then), oldest first
function cardsOf(tag: string | null, own: number[]): Card[] {
  const rows = db
    .prepare(
      `select id, title, max(created, coalesce(hidden_until, '')) day from requests
      where (id in (select value from json_each(?)) or id in (select request from request_products where slug = ?))
      and coalesce(hidden_until, '') <= ? order by id`,
    )
    .all(JSON.stringify(own), tag, new Date().toISOString()) as { id: number; title: string; day: string }[];
  return rows.map(r => ({ id: r.id, title: r.title, day: r.day.slice(0, 10) }));
}

// ---------------------------------------------------------------- files
// A YAML file of ours, as it says (one that doesn't parse throws)
const yamlAt = (path: string): unknown => parse(readFileSync(`${REPO_DIR}/${path}`, 'utf8'));
const folders = (path: string) =>
  readdirSync(`${REPO_DIR}/${path}`, { withFileTypes: true })
    .filter(d => d.isDirectory() && FOLDER.test(d.name) && d.name !== 'node_modules')
    .map(d => d.name);
const below = (path: string, depth: number): string[] =>
  depth ? folders(path).flatMap(name => [`${path}/${name}`, ...below(`${path}/${name}`, depth - 1)]) : [];
