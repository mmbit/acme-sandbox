// A try's version as a branch of its own (Ink 1.1, piece 6: one branch and one staging preview per version, trypreview.ts.). A try run clips a version with its patch (hq answer --version --patch,
// bookanswer.ts), which must apply to the deployed main as regular files (overMain: refused otherwise), and HQ makes
// the branch try/v<slip> on GitHub: the deployed main with the patch applied, one commit. The board's pick builds from
// it (bookpick.ts pickedLine), and it's removed with the version's preview once the version is cleared (bookpick.ts
// clear): the others when the page goes with a pick, all of them when the board crosses every one out. Where GitHub
// refuses it twice, the slip keeps why (branch_failed) and the version's foot says it has none.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_DIR } from '../config.ts';
import { db } from '../db.ts';
import { branchFrom, deleteBranch } from '../github.ts';
import type { Slip } from './bookslips.ts';
import { forget, linkOf } from './trypreview.ts';

// The checkout's git, as server.ts reads it (root's on the server, mounted read-only): its output, or its error with
// git's stderr
const git = (args: string[], { env = process.env, input = '' } = {}) =>
  execFileSync('git', ['-c', `safe.directory=${REPO_DIR}`, '-C', REPO_DIR, ...args], {
    env,
    input,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: 'pipe',
    maxBuffer: 64 << 20,
  });

export const branchName = (slip: number) => `try/v${slip}`;
export type Version = { base: string; files: { path: string; text: string | null; mode: string }[] };

// A version's patch over the deployed main: the commit and the files it leaves, or why it can't be a version
export function overMain(patch: string): Version | string {
  const base = git(['rev-parse', 'HEAD']).trim();
  const files = applied(patch, base);
  return typeof files === 'string' ? files : { base, files };
}
// The version's branch made, and kept on its slip with the commit it's on and its preview's address (trypreview.ts:
// HQ serves it from then on); or why GitHub refused it twice, kept on the slip; nothing once it was cleared meanwhile
export async function branchVersion(id: number, { base, files }: Version) {
  const s = db.prepare('select * from book_slips where id = ?').get(id) as Slip;
  const name = branchName(id),
    message = `A try's version “${s.version ?? id}”: ${s.text}`;
  // (a network failure or a refusal alike: one more try)
  const attempt = () => branchFrom(name, base, files, message).catch(err => ({ ok: false as const, why: String(err) }));
  const first = await attempt();
  const made = first.ok ? first : await attempt();
  if (!made.ok) {
    console.error(`Version ${id}: no branch: ${made.why}`);
    db.prepare('update book_slips set branch_failed = ? where id = ?').run(made.why, id);
    return null;
  }
  const link = linkOf(
    id,
    files.map(f => f.path),
  );
  const kept = db
    .prepare('update book_slips set branch = ?, base = ?, link = coalesce(link, ?) where id = ? and cleared is null')
    .run(name, base, link, id).changes;
  // (cleared while it was made: it goes again)
  if (!kept) await deleteBranch(name);
  else if (link) void warm(id, link);
  return kept ? name : null;
}
// The preview's first visit, so its host has its certificate before the board opens it (Caddy gets it then): an answer
// of any kind (the preview login's redirect) shows the way to it works
async function warm(id: number, link: string) {
  try {
    await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    console.error(`Version ${id}: its preview ${link} doesn't answer yet:`, String(err));
  }
}
// A cleared version's preview gone at once (its host serves nothing once it's cleared), and its branch removed from
// GitHub and its slip
export async function dropBranch(s: Pick<Slip, 'id' | 'branch'>) {
  db.prepare('update book_slips set link = null where id = ?').run(s.id);
  forget(s.id);
  if (!s.branch) return;
  const gone = await deleteBranch(s.branch);
  if (gone.ok) db.prepare('update book_slips set branch = null where id = ?').run(s.id);
  else console.error(`Version ${s.id}: its branch ${s.branch} stays: ${gone.why}`);
}

// The files a patch leaves over the commit base, read as Git keeps them: each path it touches with its new text (null
// where it's removed) and mode, or why it can't be a version. git apply works on a scratch index over base's tree, its
// new blobs in a scratch object store beside the checkout's (read-only on the server), so no file is ever read from
// the disk: a symlink or a submodule the patch would add is refused, never followed.
export function applied(patch: string, base: string) {
  const dir = mkdtempSync(join(tmpdir(), 'try-'));
  mkdirSync(join(dir, 'objects'));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(dir, 'index'),
    GIT_OBJECT_DIRECTORY: join(dir, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: checkoutObjects(),
  };
  const scratch = (args: string[], input = '') => git(args, { env, input });
  try {
    scratch(['read-tree', base]);
    try {
      scratch(['apply', '--cached', '--whitespace=nowarn', '-'], patch);
    } catch (err) {
      const why = String((err as { stderr?: string }).stderr ?? err).trim();
      return `the patch doesn't apply to main: ${why}; rebase it on main and clip again`;
    }
    // (diff-index -z: ":<old mode> <new mode> <old blob> <new blob> <status>", then the path)
    const fields = scratch(['diff-index', '--cached', '--no-renames', '-z', base]).split('\0');
    const files = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [was, mode, , blob, status] = fields[i].slice(1).split(' '),
        path = fields[i + 1];
      if (status === 'D') files.push({ path, text: null, mode: was });
      else if (!REGULAR.has(mode))
        return `the patch makes ${path} a ${KINDS[mode] ?? `mode ${mode}`}: a version's files are regular files only; make it one and clip again`;
      else files.push({ path, text: scratch(['cat-file', 'blob', blob]), mode });
    }
    return files.length ? files : 'the patch changes no file';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// The checkout's object store, which the scratch one reads base's tree and blobs from
let objects: string | undefined;
const checkoutObjects = () =>
  (objects ??= git(['rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim());
const REGULAR = new Set(['100644', '100755']);
const KINDS: Record<string, string> = { '120000': 'symlink', '160000': 'submodule' };
