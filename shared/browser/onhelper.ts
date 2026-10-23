// A render snapshot on the helper, with its pictures returned as an archive.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { supervise } from './supervise.ts';

const root = process.cwd();
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const output = resolve('../pictures');
mkdirSync(output);
const args: string[] = request.args;
const option = (name: string, value: string) => {
  const index = args.indexOf(name);
  if (index < 0) args.push(name, value);
  else args[index + 1] = value;
};
option('--out', output);
option('--ref', 'origin/main');
if (request.record) option('--record', '../record.md');
if (request.brand) {
  writeFileSync('../brand.json', request.brand);
  option('--brand', resolve('../brand.json'));
}
const code = await supervise(join(root, request.entry), args, {
  cwd: resolve(root, request.cwd),
  env: { HQ_RENDER_SOURCE: JSON.stringify(request.source) },
});
const files = ['pictures'];
if (existsSync('../record.md')) files.push('record.md');
// The returned records name the files where the caller will open them.
for (const file of [join(output, 'index.md'), resolve('../record.md')]) {
  if (existsSync(file)) writeFileSync(file, readFileSync(file, 'utf8').replaceAll(output, request.output));
}
execFileSync('tar', ['-czf', '../render-files.tar.gz', '-C', dirname(root), ...files]);
writeFileSync('../render-outcome.json', JSON.stringify({ output }));
process.exitCode = code;
