// The worker really short of memory (its lowmemory.ts judges each look): every running agent hears it once a spell, at
// its next step (hq inbox --hook), so none starts anything heavy, and hears again when memory is back. The job that
// brought it down hears that too, more firmly each spell it causes. Nothing is stopped, blocked or retried here: the
// shares' block (blocks.ts) stays the only stop.
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
let latest: { at: number; low: boolean; freeMb: number } | undefined;

// The worker's verdict in its room report (room.ts): low opens a spell unless one is open, calm ends it, and anything
// between leaves it as it is. A worker that sends none (an older one) changes nothing.
export function report(memory: unknown, freeMb: number, now = Date.now()) {
  const { verdict, cause } = (memory ?? {}) as { verdict?: unknown; cause?: Record<string, unknown> };
  if (verdict !== 'low' && verdict !== 'between' && verdict !== 'calm') return;
  latest = { at: now, low: verdict === 'low', freeMb };
  const open = openSpell();
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
const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// What a running work job's hook takes now, each said once: its own nudge for a spell it caused (whenever its next
// step comes, the spell over or not), the spell while memory is low now, or that memory is back after one it heard.
// Never as the session stops: it would keep a finished session going a turn for a line about work it won't start.
export function take(job: number, stopping: boolean, now = Date.now()) {
  if (stopping || !db.prepare("select 1 from jobs where id = ? and kind = 'work' and status = 'running'").get(job))
    return [];
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
      const spell = lowNow && caused.id === open.id ? `${lowLine(latest!.freeMb)}\n` : '';
      return [{ memory: caused.id, text: `${spell}${nudgeLine(caused, job)}` }];
    }
    if (lowNow && tell(open, job, false)) return [{ memory: open.id, text: lowLine(latest!.freeMb) }];
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

function lowLine(freeMb: number) {
  return (
    `HQ: the server is short of memory right now (${gb(freeMb)} GB free). Don't start anything heavy (a build, a ` +
    `big test run, a render, a simulation): ${offload()}wait a few minutes and carry on. Light work goes on as ` +
    'usual, and HQ says here when memory is back.'
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
  `HQ: the server has memory again${freeMb ? ` (${gb(freeMb)} GB free)` : ''}: heavy work may start, one thing at a time.`;

// Where heavy work can go instead: the deployment's lent machines by name, or none
function offload() {
  const machines = offloadPlaces().machines.map(m => m.name);
  return machines.length ? `run it on ${list(machines)} with hq run (hq run helper shows what each takes), or ` : '';
}
const gb = (mb: number) => (mb / 1024).toFixed(1);
const list = (items: string[]) => new Intl.ListFormat('en-GB', { type: 'disjunction' }).format(items);
