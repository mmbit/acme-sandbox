// An agent's check inside its helper checkout, preserving the exit and requested screenshots even on failure.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const root = process.cwd();
const began = performance.now();
const checked = spawnSync('sh', ['-c', request.command], {
  cwd: resolve(root, request.cwd),
  stdio: 'inherit',
  // Harness entry points are already on the helper, and must not dispatch another run.
  env: { ...process.env, HQ_RENDER_CHILD: '1' },
});
if (checked.error) throw checked.error;
const files = request.bring.filter((path: string) => existsSync(resolve(root, path)));
for (const path of request.bring) {
  if (!files.includes(path)) console.error(`Check artifact missing: ${path}`);
}
execFileSync('tar', ['-czf', '../check-files.tar.gz', '--files-from', '/dev/null', '--', ...files]);
console.log(`Check command: ${((performance.now() - began) / 1000).toFixed(2)} seconds`);
process.exitCode = checked.status ?? 1;
