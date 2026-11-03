// The contents of the shared workspaces' files (workspaces.ts), each kept once by its SHA-256 under DATA_DIR, however
// many versions and workspaces name it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from './config.ts';
import { onUndo } from './db.ts';

export const DIR = `${DATA_DIR}/workspaces`;
mkdirSync(DIR, { recursive: true });

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
