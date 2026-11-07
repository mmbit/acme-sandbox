// Agent commands on a lent checkout helper, with dependencies and artifacts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unpackInto } from './unpack.ts';
import { print, stop, warn } from './output.ts';
import type { Spec } from './runs.ts';

export async function checkOnHelper(root: string, spec: Spec, tree: string, includeBrowsers: boolean) {
  // The installed HQ contains only platform/worker. Check tooling belongs to the agent's checkout.
  const load = (name: string) => import(pathToFileURL(join(root, 'shared/gates', `${name}.ts`)).href);
  const { onLent } = await load('lent');
  const { git } = await load('repo');
  const { helperBundle } = await load('bundle');
  print(`Check queued on the ${spec.kind} helper, with this checkout`);
  const ran = await onLent(root, {
    what: 'Agent check',
    kind: spec.kind,
    base: git(root, 'rev-parse', 'origin/main^{commit}').trim(),
    tree: git(root, 'rev-parse', `${tree}^{tree}`).trim(),
    script: 'checks',
    args: ['../check-request.json'],
    minutes: spec.minutes,
    bring: [],
    binary: ['check-files.tar.gz'],
    ...helperBundle({ tools: true, browsers: includeBrowsers ? 'all' : 'none' }),
    inputs: {
      'check-request.json': JSON.stringify(spec),
      'check-command.ts': readFileSync(new URL('./checkcommand.ts', import.meta.url), 'utf8'),
    },
    exitIsResult: true,
    waitWhilePresent: true,
    limitIsResult: true,
    fallback: false,
  });
  if (!ran) stop('The check did not run on the helper. Check hq run helper and try again there.');
  print(ran.output);
  if (!ran.timedOut) {
    const restored = unpackInto(root, ran.binary!.get('check-files.tar.gz')!, spec.bring);
    if (restored.leftOut.length) stop(`Check files refused: ${restored.leftOut.join(', ')}`);
  }
  if (ran.timedOut) warn('The check stopped at its --minutes limit. No files were brought back.');
  print(`Check ended on ${ran.machine} with exit ${ran.exitCode}`);
  return ran.exitCode;
}
