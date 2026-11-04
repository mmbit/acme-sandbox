// The contents of the shared workspaces' files (workspaces.ts), each kept once by its SHA-256 under DATA_DIR, however
// many versions and workspaces name it, while a version that keeps its bytes names it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from './config.ts';
import { afterStep, db, onUndo } from './db.ts';

export const DIR = `${DATA_DIR}/workspaces`;
mkdirSync(DIR, { recursive: true });

// A file (one path in one workspace) keeps the bytes of its newest version and the one before it, to compare with or go
// back to. Every older one would fill both servers. Each HQ clears on its own as it applies a version (clearOld), with
// no entry crossing, so linked HQs keep the same number: a change here is one for every linked company too.
export const KEPT_VERSIONS = 2;

export const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// Kept before the record that names it, so a record never lacks its file; one new in a step that's rolled back (a push
// refused whole) goes with it, as no record names it.
export function keep(bytes: Buffer) {
  const sha256 = sha256Of(bytes);
  const file = `${DIR}/${sha256}`;
  if (!existsSync(file)) {
    writeFileSync(file, bytes);
    onUndo(() => rmSync(file, { force: true }));
  }
  return sha256;
}

export const read = (sha256: string) => readFileSync(`${DIR}/${sha256}`);

// The versions past each file's newest KEPT_VERSIONS lose their bytes (cleared: when), their rows kept as the record.
// Each HQ clears on its own as it posts or applies a version, so no entry for it crosses the link. One of ours their
// HQ hasn't taken yet keeps its bytes till it has (links.ts batchOf sends them, tookUpTo clears after). A blob goes once
// the step is kept and no version that keeps its bytes names it: the same bytes can be another path's, or come again.
export function clearOld() {
  const old = db
    .prepare(
      `select f.id, f.sha256 from (select id, workspace, sha256, ours, seq, cleared,
        row_number() over (partition by workspace, path order by at desc, uid desc) newer from workspace_files) f
      join workspaces w on w.id = f.workspace join links l on l.id = w.link
      where f.newer > ? and f.cleared is null and not (f.ours = 1 and l.state = 'linked' and f.seq > l.sent)`,
    )
    .all(KEPT_VERSIONS) as { id: number; sha256: string }[];
  if (!old.length) return;
  const at = new Date().toISOString();
  for (const { id } of old) db.prepare('update workspace_files set cleared = ? where id = ?').run(at, id);
  afterStep(() => {
    for (const sha256 of new Set(old.map(f => f.sha256)))
      if (!db.prepare('select 1 from workspace_files where sha256 = ? and cleared is null').get(sha256))
        rmSync(`${DIR}/${sha256}`, { force: true });
  });
}
