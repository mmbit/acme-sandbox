// Reclaim remote-check staging after the worker has killed its owning command tree.
import { execFile } from 'node:child_process';
import type { Ids } from './slots.ts';

export function removeBundles(ids: Required<Ids>, tmpdir: string, stopped: { pid: number; start: string }[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      // Match the staging prefix written by sendRun in shared/gates/lent.ts outside the deployed worker tree.
      ['-e', CLEAN, tmpdir, ...stopped.map(owner => `lent-bundle-${owner.pid}-${owner.start}-`)],
      { ...ids, env: { PATH: '/usr/bin:/bin' }, timeout: 10_000, killSignal: 'SIGKILL' },
      error => (error ? reject(error) : resolve()),
    );
  });
}

// Delete as the slot, so substituted directories cannot grant worker filesystem privileges.
const CLEAN = `
const fs = require('node:fs');
const path = require('node:path');
const [tmpdir, ...prefixes] = process.argv.slice(1);
let names;
try { names = fs.readdirSync(tmpdir); }
catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
for (const name of names) {
  if (prefixes.some(prefix => name.startsWith(prefix))) {
    fs.rmSync(path.join(tmpdir, name), { recursive: true, force: true });
  }
}
`;
