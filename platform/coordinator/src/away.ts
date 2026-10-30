// An alarm for the CEO (alarms.ts) when a lent machine (machines.ts) that was taking work has been away AWAY_FOR: none
// of its helpers asked for work or beat since. Its runs go to this server meanwhile, or wait when only lent machines take
// their kind (runs.ts), and nobody else hears of it. It ends once the machine asks again, or the board paused or removed
// it. The server checks each minute.
import * as alarms from './alarms.ts';
import { db } from './db.ts';
import * as machines from './machines.ts';

// A lent machine's helpers come back on their own within minutes after a helper's restart or a reboot. Half an hour is
// past a reboot with its updates and Docker's start, and early enough to act the same day.
const AWAY_FOR = 30 * 60_000;
const PREFIX = 'away.';

export function awayCheck(now = Date.now()) {
  const lent = new Map(machines.listMachines().map(machine => [`${PREFIX}${machine.id}`, machine]));
  for (const key of alarms.keysOn(PREFIX)) {
    const machine = lent.get(key);
    if (!machine || machine.paused) alarms.end(key, undefined, now);
  }
  for (const [key, machine] of lent) {
    if (machine.paused || !machine.seen) continue;
    if (machines.isPresent(machine.seen, now)) back(key, machine, now);
    else if (now - Date.parse(machine.seen) >= AWAY_FOR || alarms.isOn(key)) away(key, machine, now);
  }
}

function away(key: string, machine: machines.Machine, now: number) {
  const kinds = machines.machineKinds(machine.id).map(helper => helper.kind);
  const since = `${machine.seen!.slice(0, 16).replace('T', ' ')} UTC`;
  const line =
    `${machine.name} hasn't asked for work since ${since} (its ${kinds.join(', ')}): ` +
    `${missed(kinds, machine.seen!)} runs went without it`;
  const prompt =
    `${line}. Its runs go to this server meanwhile, much slower, and a ` +
    "kind only lent machines take waits for it. A machine stops asking when it's off or asleep, or Docker stopped on " +
    "it: the board can check that it's on and Docker runs there. HQ ends this alarm when it asks again.";
  alarms.raise(key, line, { title: `${machine.name} stopped asking for work`, urgent: true, word: null, prompt }, now);
}

function back(key: string, machine: machines.Machine, now: number) {
  if (!alarms.isOn(key)) return;
  const text = `${machine.name} asks for work again: its runs go to it as before.`;
  alarms.end(key, { title: `${machine.name} asks for work again`, prompt: text }, now);
}

// The runs of its kinds since it was last heard from that no lent machine took: this server's, withdrawn or waiting
function missed(kinds: string[], seen: string) {
  const marks = kinds.map(() => '?').join(', ');
  const counted = db
    .prepare(
      `select count(*) as n from helper_runs where created >= ? and coalesce(helper, '') != 'lent'
        and kind in (${marks})`,
    )
    .get(seen, ...kinds) as { n: number };
  return counted.n;
}
