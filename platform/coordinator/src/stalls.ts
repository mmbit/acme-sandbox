// Engines with ready seats and waiting work that have stopped starting jobs: HQ's feed says so once a spell, and the CEO's
// summary (summary.ts) lists each while it lasts.
import { db, remember, setting } from './db.ts';
import { publish } from './events.ts';
import { readyOn, type ReadySeat } from './jobs.ts';
import { cap, ceo, companyFormats } from './company.ts';

export const STALLED_FOR_MS = 15 * 60_000;
type Spell = { since: number; told?: number; line?: string };
export function stallSweep(t = Date.now()) {
  const { seats, engines } = stallInputs(t);
  for (const engine of engines) {
    const readySeats = seats.filter(s => s.engine === engine);
    const waiting = readySeats.length ? readyOn(engine, readySeats) : 0;
    const busy = (
      db
        .prepare("select count(*) n from jobs where status = 'running' and engine = ? and kind != 'chat'")
        .get(engine) as { n: number }
    ).n;
    const spell = spellOf(engine);
    if (!waiting || busy) {
      if (spell) remember(key(engine), null);
      continue;
    }
    // (a run that started and ended between two sweeps ends the spell too)
    const started = (
      db
        .prepare(
          "select max(r.started) at from runs r join jobs j on j.id = r.job where j.engine = ? and j.kind != 'chat'",
        )
        .get(engine) as {
        at: string | null;
      }
    ).at;
    if (!spell || (started && Date.parse(started) >= spell.since)) {
      remember(key(engine), JSON.stringify({ since: t }));
      continue;
    }
    if (t - spell.since < STALLED_FOR_MS) continue;
    const line =
      `${cap(engine)} has started nothing for ${Math.round((t - spell.since) / 60_000)} min (since ${companyFormats().time(spell.since, 'en')}): ` +
      `${readySeats.map(s => s.id).join(', ')} ready, ${waiting} job${waiting === 1 ? '' : 's'} ready for it, none running.`;
    if (!spell.told) publish({ type: 'log', agent: ceo(), text: line });
    remember(key(engine), JSON.stringify({ since: spell.since, told: spell.told ?? t, line }));
  }
}

function stallInputs(t: number) {
  // the seats that would take a job now: ready (or past a drain or sleep), and not paused by the board
  const seats = db
    .prepare(
      `select s.id, s.engine, coalesce(s.cli, s.engine) cli, iif(s.pace is null or s.week_resets <= ?, null, s.week_resets) pacedUntil from seats s
      left join seat_list l on l.id = s.id
      where coalesce(l.paused, 0) = 0 and (s.state = 'ready' or s.state in ('draining', 'sleeping') and s.until <= ?)`,
    )
    .all(t, t) as (ReadySeat & { engine: string })[];
  const engines = new Set([
    ...(db.prepare('select distinct engine from seats').all() as { engine: string }[]).map(s => s.engine),
    ...(db.prepare("select key from settings where key like 'stall.%'").all() as { key: string }[]).map(s =>
      s.key.slice(key('').length),
    ),
  ]);
  return { seats, engines };
}

const spellOf = (engine: string) => JSON.parse(setting(key(engine)) ?? 'null') as Spell | null;
const key = (engine: string) => `stall.${engine}`;

// The summary's lines: each engine stalled for STALLED_FOR_MS or more, as the last sweep found it.
export const stalled = () =>
  (db.prepare("select value from settings where key like 'stall.%' order by key").all() as { value: string }[]).flatMap(
    s => (JSON.parse(s.value) as Spell).line ?? [],
  );
