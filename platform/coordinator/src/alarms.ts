// The platform's alarms, for the company's executive (company.ts ceo()): the disk filling up (disk.ts), an app down or
// unable to sell (watch.ts), the off-site backup failing (backup.ts) and a lent machine gone away (away.ts). Each incident is one job for the CEO and a line
// in the CEO's summary while it lasts. Nothing on a timer reaches the board itself: whether the board hears is the CEO's
// call.
import { db, inOneStep, once } from './db.ts';
import * as jobs from './jobs.ts';
import { ceo } from './company.ts';
import { made, madeCode } from './made.ts'; // (madeCode)
import { codeOf } from './jobcodes.ts';

// key: the incident's (the disk, an app's outage). line: where it stands, for the summary. job: the CEO's job about it.
// ended: when it was over, kept while that job is open, so the incident coming back meanwhile makes no second job.
db.exec(`create table if not exists alarms (key text primary key, line text not null, since text not null,
  job integer not null, ended text)`);
// Ready alarms must not remain in the executive's summary.
once('2026-10-20-no-ready-alarms', "delete from alarms where key glob 'ready.*'");

type Alarm = { key: string; line: string; since: string; job: number; ended: string | null };
// word: its job's task code word (jobcodes.ts), the watch's that raises it each time it's on; null for an incident that
// is one of many (an app's outage), which the CEO names.
export type Incident = { title: string; prompt: string; urgent: boolean; word: string | null };
type Notice = { title: string; prompt: string };

const YOUR_CALL =
  'HQ told nobody else. Whether the board hears of it, with a card if it needs a decision, is your call (the Board ' +
  'requests playbook).';

// The incident's line as it stands. A new incident is a job for the CEO, due now when it's urgent, unless the job
// about the last one is still open.
export function raise(key: string, line: string, incident: Incident, now = Date.now()) {
  const was = db.prepare('select * from alarms where key = ?').get(key) as Alarm | undefined;
  if (was && !was.ended) {
    db.prepare('update alarms set line = ? where key = ?').run(line, key);
    return;
  }
  const code = incident.word ? madeCode('alarms', 'hq', incident.word) : undefined;
  const job = was && isOpen(was.job) ? was.job : toCeo({ ...incident, code }, now);
  db.prepare('insert or replace into alarms (key, line, since, job, ended) values (?, ?, ?, ?, null)').run(
    key,
    line,
    new Date(now).toISOString(),
    job,
  );
}

// The incident is over: its line leaves the summary. notice: a short job telling the CEO, for an end the board may
// want to hear of when it heard of the incident, which follows on from the job about it (its code).
export function end(key: string, notice?: Notice, now = Date.now()) {
  const on = db.prepare('select job from alarms where key = ? and ended is null').get(key) as
    { job: number } | undefined;
  db.prepare('update alarms set ended = ? where key = ? and ended is null').run(new Date(now).toISOString(), key);
  if (on && notice) toCeo({ ...notice, code: codeOf(on.job) ?? undefined }, now);
  db.prepare(`delete from alarms where ended is not null and job not in ${OPEN}`).run();
}

export const isOn = (key: string) => !!db.prepare('select 1 from alarms where key = ? and ended is null').get(key);

// The keys of the alarms on that start with prefix
export const keysOn = (prefix: string) =>
  (
    db.prepare('select key from alarms where substr(key, 1, length(?)) = ? and ended is null').all(prefix, prefix) as {
      key: string;
    }[]
  ).map(alarm => alarm.key);

// The summary's lines: each alarm on, oldest first, with the CEO's job about it
export const lines = () =>
  (db.prepare('select line, job from alarms where ended is null order by since').all() as Alarm[]).map(
    a => `${a.line} (your job #${a.job})`,
  );

// A job for the CEO about an alarm, which a company pause lets through (jobs.ts PAUSE_LETS reads its allow list): with
// the company paused, the executive still hears the platform's alarms. On a one-task thread (made.ts made), an urgent
// one's window as soon as it can from now, in one step with the job: with no project for it, neither is made.
// (code: its task's, jobcodes.ts.)
function toCeo({ title, prompt, urgent, code }: Notice & { urgent?: boolean; code: string | undefined }, now: number) {
  return inOneStep(() => {
    const { id } = jobs.createJob({ agent: ceo(), code, title, prompt: `${prompt}\n\n${YOUR_CALL}` });
    made('alarms', 'hq', { id }, urgent ? { asap: now } : undefined);
    db.prepare(
      "update settings set value = json_set(value, '$.allow', json_insert(coalesce(json_extract(value, '$.allow'), json('[]')), '$[#]', ?)) where key = 'company.paused'",
    ).run(id);
    return id;
  });
}

const OPEN = `(select id from jobs where status in ${jobs.OPEN_JOBS})`;
const isOpen = (job: number) =>
  !!db.prepare(`select 1 from jobs where id = ? and status in ${jobs.OPEN_JOBS}`).get(job);
