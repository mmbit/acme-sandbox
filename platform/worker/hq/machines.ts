// hq run helper: the machines the board lends, each kind of run's helpers on them and this server's, and the install
// command that sets a machine up (the coordinator's runs.ts helperState)
import * as api from './api.ts';
import { minute, print } from './output.ts';

export type Presence = {
  present: boolean;
  seen: string | null;
  cpus: number | null;
  memoryGb: number | null;
  running: number | null;
};
// The lent machines, each kind's helpers on them, and this server's of each kind
export type Machine = {
  name: string;
  lent: number;
  takeMinutes: number;
  maxMinutes: number;
  machineMemoryGb?: number; // (0: no cap but each kind's)
  machines: {
    name: string;
    state: 'taking' | 'running' | 'away' | 'paused';
    speed: number | null;
    cpus: number | null;
    memoryGb: number | null;
    gpu: string | null;
    // the kinds whose helpers on it are asking for work or beating
    kinds: string[];
    // its manager while its helpers ask: in step, on code HQ no longer serves, or not heard from for hours (null: none)
    manager?: { state: 'current' | 'old' | 'quiet'; seen: string } | null;
  }[];
  kinds: (Presence & {
    name: string;
    about: string;
    image: string;
    gpus: boolean;
    lentOnly: boolean;
    checkout: boolean;
    browsers: boolean;
    server: Presence;
    serverTakes: boolean;
    // the work this kind holds in the queue until a lent machine has finished a run of it, in a line ('' for none)
    holds: string;
  })[];
  leftOut: { name: string; why: string }[];
  // the install command (without a machine's key) and the one that takes it all away again
  install: string;
  remove: string;
};

export const SERVER = "this server's helper";

export async function showHelper() {
  const machine: Machine = await api.getJson('runs/helper');
  const asking = (present: boolean) => (present ? 'asking for work' : "isn't asking");
  const lent = machine.lent === 1 ? 'one machine' : `${machine.lent} machines`;
  print(
    machine.lent
      ? `${machine.name}: ${lent} (the board's, in HQ's Settings › Machines), one helper per kind of run on each`
      : `${machine.name}: no machine yet (the board adds them in HQ's Settings › Machines)`,
    ...machine.machines.map(one => `  ${one.name}: ${one.state}${machineLine(one)}${managerLine(one)}`),
    ...machine.kinds.map(kind => `  ${kind.name}: ${asking(kind.present)}${presenceLine(kind)}`),
    ...machine.leftOut.map(kind => `  ${kind.name}: left out of org.yaml's runs.kinds: ${kind.why}`),
    `${SERVER}, one per kind of run in the kind's image:`,
    ...machine.kinds.map(kind => {
      const hold = kind.lentOnly
        ? `, none: this kind runs on ${machine.name} alone`
        : kind.serverTakes
          ? ''
          : `, takes none until ${machine.name} has finished a run of it`;
      return `  ${kind.name}: ${asking(kind.server.present)}${presenceLine(kind.server)}${hold}`;
    }),
    ...machine.kinds.filter(kind => kind.holds).map(kind => kind.holds),
    `The fastest free machine takes a run. A slower one takes it after ${machine.takeMinutes} min while a faster one is busy.`,
    `${SERVER} takes a run only when its kind allows it, after ${machine.takeMinutes} min or while no machine is asking for work.`,
    `A run takes ${machine.maxMinutes} min at most.`,
    ...(machine.kinds.some(kind => kind.checkout)
      ? ['A checkout check stopped at its --minutes limit brings no files back.']
      : []),
    ...(machine.machineMemoryGb
      ? [`A machine's runs hold ${machine.machineMemoryGb} GB at most together: one that would pass it waits.`]
      : []),
  );
  for (const kind of machine.kinds)
    print(
      '',
      `${kind.name}${kind.about ? `: ${kind.about}` : ''} (${kind.image}${kind.gpus ? ', GPUs' : ''}${kind.checkout ? ', this checkout' : ''}${kind.browsers ? ", the worker's Chromium" : ''})`,
    );
  if (!machine.kinds.length) return;
  print(
    '',
    `install: ${machine.install}`,
    "         pasted once on a machine, with its key (HQ's Settings › Machines shows it when the board adds the machine,",
    "         or makes a new one): it keeps the machine's helpers in step with HQ from then on. As it is here, without a",
    "         key, it starts a machine's stopped or old manager again on the key it has (HQ cards the board with it)",
    `remove:  ${machine.remove}`,
  );
}

function machineLine({ speed, cpus, memoryGb, gpu, kinds }: Machine['machines'][number]) {
  const size = cpus ? `, ${cpus} cores and ${memoryGb} GB${gpu ? `, ${gpu}` : ''}` : '';
  return `${speed ? `, speed ${speed}` : ''}${size}${kinds.length ? `, helpers of ${kinds.join(', ')}` : ''}`;
}

function managerLine({ manager }: Machine['machines'][number]) {
  if (!manager || manager.state === 'current') return '';
  const what =
    manager.state === 'old'
      ? "runs old code (it stops at the machine's next restart)"
      : `stopped (last heard ${minute(manager.seen)})`;
  return `, its manager ${what}: paste the install command on it, without a key`;
}

function presenceLine({ seen, cpus, memoryGb, running }: Presence) {
  const size = cpus ? `, ${cpus} cores and ${memoryGb} GB` : '';
  return `, ${seen ? `last asked ${minute(seen)}` : 'never seen'}${size}${running ? `, running #${running}` : ''}`;
}
