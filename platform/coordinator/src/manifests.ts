// Products' manifests (products/<slug>/product.yaml), read as infra/products.py reads them, and whether a product's own
// domain is one it serves. A leaf module, so approvals.ts can tell where a product is public without importing
// payments.ts, which imports approvals.ts.
import { readdirSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import { REPO_DIR, ZONE } from './config.ts';

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function manifest(slug: string): Record<string, unknown> | null {
  try {
    const text = readFileSync(`${REPO_DIR}/products/${slug}/product.yaml`, 'utf8');
    const p = YAML.parse(text, { uniqueKeys: false }); // like PyYAML: the last key wins
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

// A product's own domain counts only where infra/products.py serves it (keep this in step with servable() there): a
// plain host outside our zone (every <slug>.<zone> is HQ's or some product's standard address) that no other product's
// manifest names too. So a return URL can't point at HQ or at another product.
export function servedDomain(domain: unknown): domain is string {
  if (typeof domain !== 'string' || !HOST.test(domain) || domain === ZONE || domain.endsWith(`.${ZONE}`)) return false;
  return manifests().filter(p => p.manifest.domain === domain).length === 1;
}

// Every product's manifest with its slug (a folder without one has none).
export function manifests() {
  let slugs: string[] = [];
  try {
    slugs = readdirSync(`${REPO_DIR}/products`);
  } catch {
    /* no products */
  }
  return slugs.flatMap(slug => {
    const read = manifest(slug);
    return read ? [{ slug, manifest: read }] : [];
  });
}
