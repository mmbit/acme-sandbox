// Which product's shelf a path on the shop's host is, as Caddy routes it: by the path percent-decoded and cleaned,
// ignoring case, so /pebblet/..%2fplum/ is Plum's.
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { REPO_DIR } from './config.ts';
import { FRONT } from './approvals.ts';

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;

// The path as Caddy routes it, or null when it can't be decoded (a stray %), which each caller refuses in its own way
export function routedPath(pathname: string) {
  try {
    return posix.normalize(decodeURIComponent(pathname)).toLowerCase();
  } catch {
    return null;
  }
}

// The product whose shelf the path is on, or null on the shop's own pages (and a path that can't be decoded)
export function shelfOf(pathname: string) {
  const first = routedPath(pathname)?.split('/')[1] ?? '';
  return first !== FRONT && SLUG.test(first) && existsSync(`${REPO_DIR}/products/${first}/product.yaml`) ? first : null;
}
