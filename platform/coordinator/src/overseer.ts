// The CEO's notes to the Overseer, kept by HQ, which the Overseer reads (oversight.ts).
//
import { db, redacted } from './db.ts';
import { ceo } from './company.ts';
import * as jobs from './jobs.ts';
import { hasTeam } from './team.ts';

const SHOWN_NOTES = 20;
const MAX_NOTE_CHARACTERS = 20_000;

// Held till its run ends (run: runs.id, estimates.ts), and let out only if the worker reports that run solo: released
// numbers them in the order they were let out.
// released_at: when it was let out, for a reader asking what's new since its last read (oversight.ts).
db.exec(
  'create table if not exists overseer_notes (id integer primary key, at text not null, job integer not null, run integer, text text not null, released integer, released_at text)',
);
// a note goes outside the company, to the Overseer
redacted('overseer_notes', 'text');

type Note = { id: number; at: string; job: number; text: string };

// A note from the CEO's own job (`who`: the speaker, a team member of the job if it said --as), held till its run ends.
// A run's team members share its token, so neither `as` nor the team list (a member report HQ refused, or one that
// hasn't arrived yet) can tell them from the CEO. Only the worker's finish can: it read the run's whole stream, and says
// whether the run started anyone (worker.ts delegated). So the note goes out at runEnded, from a run reported solo, and
// is dropped otherwise; a run that started a member HQ knows of is refused here already.
export function send(text: string, me: { id: number }, who: string | undefined) {
  const why = refusal(text, me, who);
  if (why) return why;
  const id = Number(
    db
      .prepare('insert into overseer_notes (at, job, run, text) values (?, ?, ?, ?)')
      .run(new Date().toISOString(), me.id, currentRun(me.id), text.trim()).lastInsertRowid,
  );
  return { id, held: true };
}

// A run of `job` ended (the worker's finish, server.ts): its held notes are let out if the worker reported it solo, and
// are dropped if not. A note an earlier run left held (one cut off before its finish) is dropped too.
export function runEnded(job: number, solo: boolean) {
  const held = db.prepare('select id, run from overseer_notes where job = ? and released is null').all(job) as {
    id: number;
    run: number | null;
  }[];
  if (!held.length) return;
  const run = currentRun(job),
    out = held.filter(n => solo && n.run !== null && n.run === run).map(n => n.id);
  const release = db.prepare('update overseer_notes set released = ?, released_at = ? where id = ?');
  for (const id of out) release.run(latest() + 1, new Date().toISOString(), id);
  drop(
    held.filter(n => !out.includes(n.id)).map(n => n.id),
    solo ? 'an earlier run left it held' : 'its run may have had team members',
  );
}

// The newest notes for the CLI (held: waiting for their run's end).
export function list() {
  const notes = db
    .prepare('select id, at, job, text, released from overseer_notes order by id desc limit ?')
    .all(SHOWN_NOTES) as (Note & { released: number | null })[];
  return { notes: notes.map(({ released, ...n }) => ({ ...n, held: released === null })) };
}

// The notes let out after `since` (an ISO time; all of them without), for the Overseer's read of HQ (oversight.ts). A
// note let out before its time was kept has its writing time.
export function releasedSince(since?: string) {
  const notes = db
    .prepare(
      'select id, at, job, text from overseer_notes where released is not null and coalesce(released_at, at) > ? order by id desc',
    )
    .all(since ?? '') as Note[];
  return outbox(notes);
}

// Each minute (server.ts): held notes of a job no longer running go (its run ended without a finish).
export function sweep() {
  const stale = db
    .prepare(
      "select id from overseer_notes where released is null and job not in (select id from jobs where status = 'running')",
    )
    .all() as { id: number }[];
  drop(
    stale.map(n => n.id),
    'its run ended without a finish',
  );
}

function refusal(text: string, me: { id: number }, who: string | undefined): [number, string] | undefined {
  if (!ceo() || who !== ceo()) return [403, 'only the CEO writes to the Overseer'];
  if (hasTeam(me.id))
    return [
      403,
      'this run has started team members, who hold its token too: only the CEO writes to the Overseer, so send it from a job without a team',
    ];
  if (jobs.holdsCustomerData(me.id))
    return [
      403,
      "this job holds a customer's details, and the Overseer's notes go outside the company: send it from a job without them",
    ];
  if (!text.trim()) return [400, 'the note is empty'];
  if (text.length > MAX_NOTE_CHARACTERS) return [413, `a note is ${MAX_NOTE_CHARACTERS} characters at most`];
}

function outbox(notes: Note[]) {
  const head = `# To the Overseer, from the CEO

The CEO's retained notes, newest first. Only the CEO's own jobs can write here: HQ checks the sender and
lets a note out when its run ends. Times are UTC. A note asks; the Overseer decides as it always does.
`;
  return [
    head,
    ...notes.map(n => `## #${n.id}, ${n.at.slice(0, 16).replace('T', ' ')} (job #${n.job})\n\n${n.text}\n`),
  ].join('\n');
}

function drop(ids: number[], why: string) {
  if (!ids.length) return;
  db.prepare(`delete from overseer_notes where id in (${ids.map(() => '?').join(',')})`).run(...ids);
  console.log(`Overseer's notes ${ids.map(id => `#${id}`).join(', ')}: dropped, ${why}`);
}

const latest = () => (db.prepare('select max(released) n from overseer_notes').get() as { n: number | null }).n ?? 0;
const currentRun = (job: number) =>
  (db.prepare('select max(id) n from runs where job = ?').get(job) as { n: number | null }).n;
