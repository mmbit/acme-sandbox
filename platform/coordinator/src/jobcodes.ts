// Each task's code (jobs.code): its project's prefix and a word for what it does (HQ-COVERS, GM-FLIGHT), so the board, a
// call and the intercom can name a task without its number, and say it ("HQ covers"). The prefix is the project's
// (projects.code, given as the CEO makes it: plan.ts newProject), projects.yaml's groups.unsorted.code for work in no
// thread, none in a company without one. Whoever queues a task names its word (hq job --code); a standing task of HQ's
// (a watch, a routine) has one of its own that each run of it carries (createJob's `word`), and a task HQ makes for
// something that happened once (a bug report, a call's follow-up) is named by the agent doing it, who has read it (hq
// code: name). The jobs HQ makes for a task (its reviews, fix rounds, retries, bringing it up to date, what follows on
// from it) are steps of it and carry its code (createJob codeFrom). A code is given once and never changes, a task moved
// to another project included. Jobs done before codes meant something keep their made-up word (KOHOG): it has no dash,
// so it never meets a new one.
import { prepared } from './db.ts';
import { projects } from './company.ts';
import { entries } from './schedule.ts';

// A word: plain capitals, a real word or an obvious short form; a prefix: two or three
export const WORD = /^[A-Z]{2,8}$/;
export const PREFIX = /^[A-Z]{2,3}$/;
const CODE = /^(?:[A-Z]{2,3}-)?[A-Z]{2,8}$|^[A-Z]{5}(?:[A-Z]{2})*$/;

// The prefix of a task in `thread` (null: in none) or in a thread to start in `project`: its project's,
// groups.unsorted.code for work in no thread, else none
export function prefixOf(where: string | null | { project: string }) {
  if (where === null) return projects().groups.unsorted?.code ?? null;
  const row = (
    typeof where === 'string'
      ? prepared('select p.code from threads t join projects p on p.id = t.project where t.id = ?').get(where)
      : prepared('select code from projects where id = ?').get(where.project)
  ) as { code: string | null } | undefined;
  return row?.code ?? null;
}
export const codeIn = (where: string | null | { project: string }, word: string) => {
  const prefix = prefixOf(where);
  return prefix ? `${prefix}-${word}` : word;
};

// The words of HQ's standing tasks, those that come back (a watch's alarm, an hourly check, a studio kind's keeper job):
// each run of one carries its code, made from its word here, which its producer takes from this list
export const STANDING = {
  disk: 'DISK',
  backup: 'NOBACKUP',
  backupWarn: 'BACKWARN',
  backupJob: 'BACKUP',
  repoCopy: 'REPOCOPY',
  records: 'RECORDS',
  chat: 'CHAT',
  meetingAsks: 'ASKS',
  followThrough: 'FOLLOW',
  checksBroken: 'CHECKFIX',
  mailPlan: 'MAILPLAN',
  refunds: 'REFUNDS',
  moneySwing: 'SWING',
  scanner: 'SCANNER',
  studioShots: 'SHOTS',
  studioDevelop: 'DEVELOP',
  studioPlace: 'PLACE',
  studioTakedown: 'TAKEDOWN',
} as const;
// Those, and the company's own standing tasks' words: schedule.yaml's and shows.yaml's `code:` (schedule.ts entries).
// No queuer may claim one, in any project and before its task first runs: where a standing task's runs go
// (projects.yaml's made and groups.unsorted) can change, its word can't.
export const standingWords = () =>
  new Set<string>([
    ...Object.values(STANDING),
    ...entries().flatMap(e => (e.code ? [String(e.code).toUpperCase()] : [])),
  ]);

// The code a task queued in `where` (as prefixOf) takes from the word its queuer gave, or why not: a word in capitals
// (what's given, in capitals), not a standing task's word, and no task holding that code already (HQ never adds a number
// to make one up)
export function claim(
  given: unknown,
  where: string | null | { project: string },
): { code: string } | { refused: string } {
  const word = String(given ?? '')
    .trim()
    .toUpperCase();
  if (!word)
    return {
      refused:
        'a task needs its code: --code WORD, a word for what the task does (COVERS, FLIGHT, IMPRINT), up to 8 letters',
    };
  if (!WORD.test(word))
    return {
      refused: `--code takes one word of 2 to 8 letters A to Z, a real word or an obvious short form (not ${given})`,
    };
  if (standingWords().has(word))
    return { refused: `${word} is the word of a standing task of HQ's: name this one another word` };
  const code = codeIn(where, word);
  const holder = taskOf(code);
  return holder
    ? { refused: `${code} is task #${holder.id}'s (${holder.agent}: ${holder.title}): name this one another word` }
    : { code };
}

// The task a code names: the first job given it (the rest are its steps)
const taskOf = (code: string) =>
  prepared('select id, agent, title from jobs where code = ? order by id limit 1').get(code) as
    { id: number; agent: string; title: string } | undefined;

// A job's code (null for no job, or one with none), and the job's number and code as agents' lines name it ("#6218
// HQ-COVERS")
export const codeOf = (job: number | null) =>
  job === null ? null : (prepared('select code from jobs where id = ?').get(job) as { code: string | null }).code;
export const numbered = (job: { id: number; code: string | null }) =>
  job.code ? `#${job.id} ${job.code}` : `#${job.id}`;
// The jobs a code names (its task and its steps), as a query's whole text (hq history HQ-COVERS): in capitals, as codes
// are, since a lower-case word may be one too (token, model). Undefined when the query isn't a code.
export function jobsOfCode(query: string) {
  if (!CODE.test(query)) return undefined;
  const rows = prepared('select id from jobs where code = ? order by id').all(query) as { id: number }[];
  return rows.length ? rows.map(r => r.id) : undefined;
}

// The agent doing a task HQ made without a code names it, once, as claim() gives a queued task its own: in the
// project of the task's thread
export function name(job: number, given: unknown) {
  const { code, thread } = prepared('select code, thread from jobs where id = ?').get(job) as {
    code: string | null;
    thread: string | null;
  };
  if (code) return `this task's code is ${code}: a code never changes`;
  const named = claim(given, thread);
  if ('refused' in named) return named.refused;
  prepared('update jobs set code = ? where id = ?').run(named.code, job);
  return named;
}
