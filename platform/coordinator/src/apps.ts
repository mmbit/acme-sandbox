// HQ-OS › Apps: every product in the repo, with its status, owner and addresses (GET /api/apps, the board's login).
// Read from products/<slug>/product.yaml on every request, so a new product shows up in HQ with no change to HQ.
// The cycles' demos too, and each app's icon.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { REPO_DIR } from './config.ts';
import { PREVIEW } from './preview.ts';
import { manifest } from './manifests.ts';
import { FRONT, isPublic, publicAddresses } from './approvals.ts';
import { ownerOf, CYCLES } from './owed.ts';

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;   // a folder starting with _ (the template, the cycles' decks) is no product
const STATUSES = ['live', 'test', 'preview'];   // the order HQ lists them in
const ABOUT_MAX = 160;

const read = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
// the comment block a product.yaml opens with, as one line
const lead = (yaml: string) => (yaml.match(/^(?:#.*\r?\n?)+/)?.[0] ?? '').split('\n').map(l => l.replace(/^#\s?/, '').trim()).filter(Boolean).join(' ');
// a README's first line of prose (its title is the name)
const prose = (md: string) => md.split('\n').map(l => l.trim()).find(l => l && !/^(#|<|!\[|---)/.test(l)) ?? '';

// A line or two for the board: the comment's opening sentences (or the README's), as many whole ones as fit, without
// their bookkeeping (job and request numbers, cycles, dates: they're for the team) and without the name they start
// with, which the row shows already.
function about(slug: string, name: string) {
  const template = lead(read(`${REPO_DIR}/products/_template/product.yaml`)), own = lead(read(`${REPO_DIR}/products/${slug}/product.yaml`));
  const s = own && own !== template ? own : prose(read(`${REPO_DIR}/products/${slug}/README.md`));   // a copied template's comment says nothing
  return oneLine(s, name);
}
// (a demo's line too)
function oneLine(s: string, name: string) {
  s = s.replace(/\*\*|__|`/g, '').replace(/\s*\([^()]*(?:job #|request #|cycle \d|\d{4}-\d\d-\d\d)[^()]*\)/g, '');
  const named = s.match(/^([^:]{1,40}):\s+(.*)$/);
  if (named && name.toLowerCase().startsWith(named[1].toLowerCase())) s = named[2];
  const [first, ...more] = s.split(/(?<=[.!?])\s+(?=["“A-Z])/);
  s = first.length > ABOUT_MAX ? first.slice(0, Math.max(first.lastIndexOf(' ', ABOUT_MAX - 1), ABOUT_MAX / 2)).replace(/[,;:]$/, '') + '…' : first;
  for (const next of more) { if (s.length + 1 + next.length > ABOUT_MAX) break; s += ` ${next}`; }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// What infra/products.py serves: a `status: live` product is public only with the board's launch or site approval
// (otherwise it stays a preview), at its public addresses (approvals.ts).
function app(slug: string) {
  const p = manifest(slug) ?? {}, name = typeof p.name === 'string' ? p.name : slug;
  const said = STATUSES.includes(p.status as string) ? p.status as string : 'preview';
  const open = isPublic(slug);
  return {
    slug, name, about: about(slug, name),
    status: said === 'live' && !open ? 'preview' : said,
    waiting: said === 'live' && !open,   // set to go live, but the board hasn't approved it
    owner: typeof p.owner === 'string' ? p.owner : null,
    platform: p.platform === true,      // a piece of the platform, never a site of its own (product.yaml `platform: true`)
    front: slug === FRONT,   // the front door, which HQ lists first, on its own
    preview: `https://${slug}${PREVIEW}`,
    public: open ? publicAddresses(slug) : [],
    numbers: existsSync(`${REPO_DIR}/products/${slug}/app/metrics.json`),   // HQ's Numbers has a dashboard for it
    icon: existsSync(`${REPO_DIR}/products/${slug}/icon.png`) ? `/api/apps/icon?app=${slug}` : null,
  };
}

// A demo in a venture cycle's folder (products/_cycles/<cycle>/<demo>/) that carries a demo.yaml, its name and a line
// about it: listed with the apps until the file goes, owned by the cycle folder's maker, who gets its notes too (owed.ts).
// Its icon is the demo's own icon.png, which HQ's /cycles/ already serves.
function demos() {
  const root = `${REPO_DIR}/products/_cycles`;
  const paths = folders(root).flatMap(cycle => folders(`${root}/${cycle}`).map(dir => `${cycle}/${dir}`)).filter(path => existsSync(`${root}/${path}/demo.yaml`));
  return paths.map(path => {
    let meta: any = {};
    try { meta = parse(readFileSync(`${root}/${path}/demo.yaml`, 'utf8')) ?? {}; } catch { /* no name: its folder's */ }
    const [cycle, dir] = path.split('/'), name = typeof meta.name === 'string' ? meta.name : dir;
    return {
      slug: `${CYCLES}/${path}`, name, about: typeof meta.about === 'string' ? oneLine(meta.about, name) : '',
      status: 'demo', waiting: false, owner: ownerOf(`${CYCLES}/${cycle}`).agent, platform: false, front: false,
      preview: `https://${CYCLES}${PREVIEW}/${path}/`, public: [], numbers: false,
      icon: existsSync(`${root}/${path}/icon.png`) ? `/${CYCLES}/${path}/icon.png` : null,
    };
  });
}
// the folders in path a slug could name (no _template, no dot folders)
function folders(path: string) {
  try { return readdirSync(path, { withFileTypes: true }).filter(d => d.isDirectory() && SLUG.test(d.name)).map(d => d.name); } catch { return []; }
}

// The icon a product carries next to its product.yaml (HQ shows it in Apps), or null.
export const iconOf = (slug: string) => SLUG.test(slug) && existsSync(`${REPO_DIR}/products/${slug}/product.yaml`)
  && existsSync(`${REPO_DIR}/products/${slug}/icon.png`) ? `${REPO_DIR}/products/${slug}` : null;

// Live first, then test, then preview; the platform's pieces after every product; by name within each. The demos last.
export function list() {
  let slugs: string[] = [];
  try { slugs = readdirSync(`${REPO_DIR}/products`).filter(s => SLUG.test(s) && existsSync(`${REPO_DIR}/products/${s}/product.yaml`)); } catch { /* no products yet */ }
  return [...slugs.map(app).sort((a, b) => Number(a.platform) - Number(b.platform) || STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status)
    || a.name.localeCompare(b.name)), ...demos().sort((a, b) => a.name.localeCompare(b.name))];   // (demos)
}
