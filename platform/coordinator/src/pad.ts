// The CEO's page (hq pad): its memory across all its work, one text it rewrites whole. It holds what it runs the company
// by (its goals and why, the bets on each, what it watches and when it judges it, what it does next) and anything a
// later call, check or follow-up must still know. Every job of the CEO starts with it (jobs.ts claimed, the hourly
// check's too), a call with the CEO has it in its briefing (call.ts), and the board reads it at the top of HQ's projects
// view. A call with the CEO adds to it as the board settles things (addToPad). Every version is kept, with its time
// and the job or call that wrote it.
import { db, redacted, columnsOf } from './db.ts';
import { ceo } from './company.ts';

db.exec(
  'create table if not exists pad_versions (id integer primary key, text text not null, by text not null, job integer, at text not null, call integer)',
);
if (!columnsOf('pad_versions').includes('call')) db.exec('alter table pad_versions add column call integer');
redacted('pad_versions', 'text');

export type PadVersion = { id: number; text: string; by: string; job: number | null; at: string; call: number | null };
// Who writes: one of the CEO's jobs, or the CEO on a live call with the board (job null, its call's number)
type Writer = { agent: string; job: number | null; call?: number };

// The page as it is now, or null before the CEO first writes it
export const pad = () =>
  (db.prepare('select * from pad_versions order by id desc limit 1').get() as PadVersion | undefined) ?? null;

// hq pad --history: every version, newest first
export const padHistory = () => db.prepare('select * from pad_versions order by id desc').all() as PadVersion[];

// hq pad write - --version <id>: the whole page anew, from one of the CEO's jobs, on the version it read. A call or
// another job may have written the page since, and a rewrite from an older copy would drop what they put on it, so
// only a rewrite of the newest version goes on. No length cap: the instructions keep it short, because everything
// the CEO does reads it. (the version)
export function writePad(text: unknown, version: unknown, writer: Writer) {
  if (writer.agent !== ceo()) return "the page is the CEO's: only its jobs rewrite it";
  const page = String(text ?? '').trim();
  if (!page) return 'the page is empty: give it whole on stdin (hq pad write - < page.md)';
  const now = pad();
  if (now && version == null) return 'name the version you rewrite (hq pad prints it): hq pad write - --version <id>';
  if (now && Number(version) !== now.id)
    return 'the page changed since you read it (a call or another job added to it): read hq pad and write it again';
  if (page === now?.text) return 'the page reads that already';
  return save(page, writer);
}

// hq pad add -: words added at the page's end, the CEO's call tool (the voice line's page tool): what the board settles
// is on the page before the call ends, for a check or job that runs before its follow-up. Added to the page as it is
// now, never a whole page from the call's briefing, so a job's rewrite during the call isn't lost; the follow-up then
// rewrites the page whole with them in place.
export function addToPad(words: unknown, writer: Writer) {
  if (writer.agent !== ceo()) return "the page is the CEO's: only its jobs and calls write on it";
  const added = String(words ?? '').trim();
  if (!added) return 'nothing to add: give the words on stdin (hq pad add - < words.md)';
  const now = pad()?.text;
  if (now?.endsWith(added)) return 'the page ends with those words already';
  return save(now ? `${now}\n${added}` : added, writer);
}

function save(page: string, writer: Writer) {
  const at = new Date().toISOString();
  const { lastInsertRowid } = db
    .prepare('insert into pad_versions (text, by, job, call, at) values (?, ?, ?, ?, ?)')
    .run(page, writer.agent, writer.job, writer.call ?? null, at);
  return { id: Number(lastInsertRowid), at };
}

// The page as the CEO's prompts carry it, with the one instruction that makes it its memory: no list of cases, whatever
// a later run must know, for whatever reason. `write` says how this run writes it: a job with hq, on the version it
// reads right before, a call its own way (call.ts).
export function padBriefing(
  write = 'rewrite the page whole the moment you learn it: read `hq pad` right before, as a call or another job may have added to it since, and write on the version it names (`hq pad write - --version <id>`, on stdin)',
) {
  const page = pad();
  const head = `Your page (hq pad) is your memory across all your work: every job, check and call of yours starts with it, and
the board reads it atop its projects. It holds what you run the company by (the goals and the bets on each, what you
watch and when you judge it, what you do next) and anything a later call, check or follow-up must still know, for
whatever reason: ${write}. Keep it short, as everything you do reads it. A time lives in a queued job or a
deliverable's window, which the page names.`;
  return page
    ? `${head}\nVersion ${page.id}, as you wrote it at ${page.at.slice(0, 16).replace('T', ' ')} UTC:\n${page.text}`
    : `${head}\nIt's empty so far.`;
}
