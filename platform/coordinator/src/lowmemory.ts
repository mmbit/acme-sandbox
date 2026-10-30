// Server pressure reaches each running agent once a spell through its next-step inbox hook, followed by one all-clear.
// A job that brings memory down hears its cause too. Nothing is stopped, blocked or retried here.
import { db, inOneStep } from './db.ts';
import { offloadPlaces } from './runs.ts';

// cause: the job that took the most since memory was last calm, when that was a third of what was free then (took_mb
// of cause_free_mb). told: the jobs that heard a spell, and whether they've heard it end (back).
db.exec(`create table if not exists memory_spells (id integer primary key, began text not null, ended text,
  free_mb integer not null, cause integer, took_mb integer, cause_free_mb integer)`);
db.exec(`create table if not exists memory_told (spell integer not null, job integer not null,
  back integer not null default 0, primary key (spell, job))`);

const STALE_MS = 3 * 60_000; // a report older than this says nothing: the worker is restarting, or gone (room.ts)
type Spell = {
  id: number;
  ended: string | null;
  free_mb: number;
  cause: number | null;
  took_mb: number | null;
  cause_free_mb: number | null;
};
// The worker's last report: when, whether it said low, and the free memory it gave
let latest: { at: number; low: boolean; freeMb: number; reasons: string[] } | undefined;

// The worker's verdict in its room report (room.ts): low opens a spell unless one is open, calm ends it, and anything
// between leaves it as it is. A worker that sends none (an older one) changes nothing.
export function report(memory: unknown, freeMb: number, now = Date.now()) {
  const { verdict, cause, reasons } = (memory ?? {}) as {
    verdict?: unknown;
    cause?: Record<string, unknown>;
    reasons?: string[];
  };
  if (verdict !== 'low' && verdict !== 'between' && verdict !== 'calm') return;
  const open = openSpell();
  latest = {
    at: now,
    low: verdict === 'low' || (verdict === 'between' && !!open),
    freeMb,
    reasons: reasons ?? [`memory short: ${gb(freeMb)} GB free`],
  };
  if (verdict === 'calm' && open)
    db.prepare('update memory_spells set ended = ? where id = ?').run(new Date(now).toISOString(), open.id);
  if (verdict !== 'low' || open) return;
  const known = cause && Number.isInteger(cause.job) && positive(cause.tookMb) && positive(cause.freeMb);
  const [job, tookMb, causeFreeMb] = known ? [Number(cause.job), Number(cause.tookMb), Number(cause.freeMb)] : [];
  db.prepare('insert into memory_spells (began, free_mb, cause, took_mb, cause_free_mb) values (?, ?, ?, ?, ?)').run(
    new Date(now).toISOString(),
    freeMb,
    job ?? null,
    tookMb === undefined ? null : Math.round(tookMb),
    causeFreeMb === undefined ? null : Math.round(causeFreeMb),
  );
}
export const inspectMemory = (now = Date.now()) => ({
  latest: latest ?? null,
  stale: latest ? now - latest.at > STALE_MS : null,
});

const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// What a running job's hook takes now, each said once: its own nudge for a spell it caused (whenever its next
// step comes, the spell over or not), the spell while memory is low now, or that memory is back after one it heard.
// Never as the session stops: it would keep a finished session going a turn for a line about work it won't start.
export function take(job: number, stopping: boolean, now = Date.now()) {
  if (stopping || !db.prepare("select 1 from jobs where id = ? and status = 'running'").get(job)) return [];
  return inOneStep(() => {
    const caused = db
      .prepare(
        'select * from memory_spells where cause = ? and id not in (select spell from memory_told where job = ?) order by id desc limit 1',
      )
      .get(job, job) as Spell | undefined;
    const open = openSpell(),
      lowNow = !!open && !!latest?.low && now - latest.at <= STALE_MS;
    if (caused) {
      tell(caused, job, !!caused.ended);
      const spell = lowNow && caused.id === open.id ? `${lowLine(latest!.reasons)}\n` : '';
      return [{ memory: caused.id, text: `${spell}${nudgeLine(caused, job)}` }];
    }
    if (lowNow && tell(open, job, false)) return [{ memory: open.id, text: lowLine(latest!.reasons) }];
    if (open) return [];
    const heard = db
      .prepare('select spell from memory_told where job = ? and back = 0 order by spell desc limit 1')
      .get(job) as { spell: number } | undefined;
    if (!heard) return [];
    db.prepare('update memory_told set back = 1 where job = ?').run(job);
    return [{ memory: heard.spell, text: backLine(latest?.freeMb) }];
  });
}

const openSpell = () =>
  db.prepare('select * from memory_spells where ended is null order by id desc limit 1').get() as Spell | undefined;
// (false: the job had heard it already)
const tell = (spell: Spell, job: number, back: boolean) =>
  db.prepare('insert or ignore into memory_told (spell, job, back) values (?, ?, ?)').run(spell.id, job, Number(back))
    .changes > 0;

function lowLine(reasons: string[]) {
  return (
    `HQ: the server is full right now (${reasons.join('; ')}). Heavy checks here slow everyone's work. ` +
    `${offload()}Light work can continue. HQ says here when server pressure is clear again.`
  );
}

// Gentle the first time; firmer for a job that has brought memory down before
function nudgeLine(spell: Spell, job: number) {
  const before = (
    db.prepare('select count(*) n from memory_spells where cause = ? and id < ?').get(job, spell.id) as { n: number }
  ).n;
  const took = `it took ${gb(spell.took_mb!)} GB of the ${gb(spell.cause_free_mb!)} GB that was free`;
  if (!before)
    return (
      `HQ: this job's own use is what brought the server's memory down: ${took}. If it's something that will ` +
      `run again (a check, a render, a run you or others repeat), make it a helper that runs it off this server with ` +
      'hq run. Otherwise just be careful with it.'
    );
  return (
    `HQ: this job has now brought the server short of memory ${before + 1} times: this time ${took}. Run ` +
    "nothing heavy on this server for the rest of the job: offload it with hq run, and if it's something that comes " +
    'back, make it a helper that does.'
  );
}

const backLine = (freeMb: number | undefined) =>
  `HQ: server pressure is clear again${freeMb ? ` (${gb(freeMb)} GB free)` : ''}. Heavy work may start, one thing at a time.`;

// Names come from the deployment's lent machines, so the platform stays generic.
function offload() {
  const places = offloadPlaces();
  const machines = places.machines.map(machine => machine.name);
  if (!machines.length) return 'Wait a few minutes before starting one. ';
  const checkoutKinds = places.kinds.filter(kind => kind.checkout);
  const commands = checkoutKinds.map(
    kind => `hq run --kind ${kind.name} -- <command>${kind.about ? ` (${kind.about})` : ''}`,
  );
  if (!commands.length) return `Please send heavy work to ${list(machines)} with hq run. `;
  return `Please run checks on ${list(machines)} with ${list(commands)}. `;
}
const gb = (mb: number) => (mb / 1024).toFixed(1);
const list = (items: string[]) => new Intl.ListFormat('en-GB', { type: 'disjunction' }).format(items);
