// hq run --fallback here: a run no helper may take runs in the job itself, as it would on the helper (runs.ts)
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as api from './api.ts';
import { print } from './output.ts';
import type { Machine, Spec } from './runs.ts';

// set for the command run here, so a tool that sends itself off with hq run (the demo kit's renders) runs as it is
const HERE_ENV = 'HQ_RUN_HERE';

export type Here = { root: string; spec: Spec };

// Why no helper may take a run of this kind now, or null when one may: the kind isn't declared, or neither a lent
// machine's helper of it nor this server's (where it takes the kind) is asking for work
export async function noTakerNow(kindName: string) {
  const machine: Machine = await api.getJson('runs/helper');
  const only = !kindName && machine.kinds.length === 1 ? machine.kinds[0] : undefined;
  const kind = machine.kinds.find(one => one.name === kindName) ?? only;
  // (several kinds and none named: HQ's refusal says which there are)
  if (!kind) return kindName ? `HQ declares no ${kindName} kind of run` : null;
  if (kind.present || (kind.server.present && kind.serverTakes)) return null;
  return kind.serverTakes ? `no helper of ${kind.name} is asking for work` : `${machine.name} isn't asking for work`;
}

// The command in this job, from the folder the run would start in, its files written in the tree itself. --minutes is a
// helper's limit: here the job's own life bounds it.
export function runHere({ root, spec }: Here, why: string) {
  print(`${why}: running it here`);
  const ran = spawnSync('sh', ['-c', spec.command], {
    cwd: join(root, spec.cwd),
    stdio: 'inherit',
    env: { ...process.env, [HERE_ENV]: '1' },
  });
  if (ran.error) throw ran.error;
  return ran.status ?? 1;
}
