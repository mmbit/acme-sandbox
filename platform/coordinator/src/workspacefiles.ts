// The contents of the shared workspaces' files (workspaces.ts), each kept once by its SHA-256 under DATA_DIR, however
// many versions and workspaces name it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from './config.ts';

export const DIR = `${DATA_DIR}/workspaces`;
mkdirSync(DIR, { recursive: true });

export const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function keep(bytes: Buffer) {
  const sha256 = sha256Of(bytes);
  const file = `${DIR}/${sha256}`;
  if (!existsSync(file)) writeFileSync(file, bytes);
  return sha256;
}

export const read = (sha256: string) => readFileSync(`${DIR}/${sha256}`);
