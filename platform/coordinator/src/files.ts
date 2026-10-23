// Served files found only inside their folder, by no `..` or symlink out of it.
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { typeOf } from './types.ts';

// The file a URL path names in a folder, with its type, or null (audit N3). The path is still percent-encoded: a
// picture named `a b.png` or `café.png` is found by its own name, and a stray % (`100%.png`) stays as written: decoded
// as the review's missing() reads it.
export function findFile(dir: string, path: string) {
  try { path = decodeURIComponent(path); } catch { /* the path as written */ }
  const file = resolve(dir, '.' + path), type = typeOf(file);
  const found = type ? inside(dir, file) : null;
  return found && { ...found, type };
}

// The real path and size of the file `name` names in `dir`, or null when it isn't a file there (audit N3, and NI1
// for the guest page's look). The repo decides what's in these folders, so a symlink (say to the database) must not
// lead out of them. `base`: the folder whose own place is trusted (a checkout may sit behind a symlink): from there
// down to the file, a link out of the way (`dir` itself a link elsewhere, say) finds nothing. Nor does a folder that
// isn't there.
export function inside(dir: string, name: string, base = dir) {
  const root = resolve(dir), file = resolve(root, name), anchor = resolve(base);
  if (!file.startsWith(root + '/') || (root !== anchor && !root.startsWith(anchor + '/'))) return null;
  const real = (p: string) => { try { return realpathSync(p); } catch { return ''; } };
  const trusted = real(anchor), top = trusted && trusted + root.slice(anchor.length), path = real(file);
  if (!top || !path.startsWith(top + '/')) return null;
  const fileStat = statSync(path, { throwIfNoEntry: false });
  return fileStat?.isFile() ? { real: path, size: fileStat.size } : null;
}

// The Content-Disposition of a download by its file's name (RFC 6266): a plain ASCII name for old browsers, and the whole
// name in UTF-8 (RFC 5987, which leaves ' ( ) * encoded too). Mail's attachments and a card's files.
export const attachment = (name: string) =>
  `attachment; filename="${name.replace(/[^\w. -]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
