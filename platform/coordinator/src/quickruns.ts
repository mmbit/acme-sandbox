// A quick run: one turn of the chat kind for any agent, outside the intercom, on the worker's chat slot (no queue, no
// pacing, no hold), for what's answered within seconds (the book's questions: bookslips.ts). The slot is a Claude seat's,
// so every quick run is on Claude, as its agent with its profile, on Claude's model when the agent's own engine is
// another. Its final message goes back to the module that started it (its purpose's heard), never to the intercom: none
// of the intercom's lines, recap or brief (chat.ts).
import { columnsOf, db, once } from './db.ts';
import { createJob } from './jobs.ts';

// (missed: why its answer didn't come, a key of MISSED, once it has ended without one)
db.exec('create table if not exists quick_runs (job integer primary key, purpose text not null, missed text)');
once('2026-10-28-quick-runs-missed', () => {
  if (!columnsOf('quick_runs').includes('missed')) db.exec('alter table quick_runs add column missed text');
});
// What a purpose does as its quick run is claimed (started) and once it has ended (heard)
type PurposeHooks = {
  started?: (job: { id: number; agent: string }) => void;
  heard: (job: number, status: string, result: string) => void;
};
const purposes = new Map<string, PurposeHooks>();
// (each purpose once, at its module's load)
export const onQuickRun = (purpose: string, hooks: PurposeHooks) => void purposes.set(purpose, hooks);
export function quickRun(agent: string, title: string, prompt: string, purpose: string) {
  if (!purposes.has(purpose)) throw new Error(`no module hears a quick run for ${purpose}`);
  const id = createJob({ agent, kind: 'chat', engine: 'claude', title, prompt }).id;
  db.prepare('insert into quick_runs (job, purpose) values (?, ?)').run(id, purpose);
  return id;
}
const purposeOf = (job: number) =>
  (db.prepare('select purpose from quick_runs where job = ?').get(job) as { purpose: string } | undefined)?.purpose;
// Whether a job is a quick run, or a turn of the intercom: the two kinds of chat job
export const isQuickRun = (job: { id: number; kind: string }) => job.kind === 'chat' && !!purposeOf(job.id);
export const isIntercom = (job: { id: number; kind: string }) => job.kind === 'chat' && !purposeOf(job.id);

// A quick run's turn on the chat slot, counting only the time it ran (one handed back keeps what it had left; a reload
// of the worker keeps the deadline it was given). The slot is the intercom's too (jobs.ts claimable): while a reply
// runs, the board's next line and every question behind it wait. Worked out from the longest answer the briefs ask for,
// a drawing clipped with hq answer after reading the charter, the profile and the page: about 96 s from claim to answer,
// with as long again for a slow model turn. Past it the worker stops the run and the page says how to have the answer
// as work (MISSED.overtime).
export const QUICK_RUN_MS = 3 * 60_000;
// A quick run as it's claimed: its purpose hears it started
export function quickRunStarted(job: { id: number; kind: string; agent: string }) {
  if (isQuickRun(job)) purposes.get(purposeOf(job.id)!)!.started?.(job);
}
// A quick run thinks at QUICK_EFFORT, whatever its agent's own (company/models.yaml), as the board's calls do: the board
// waits for its answer. At the company's high effort a short answer took 30-40 s of Opus (29 Oct), most of it
// thinking between its few reads.
export const QUICK_EFFORT = 'low';
// The turn the worker is given for a quick run as it's claimed: its end, what's left after the runs it had before
// (agenttime.ts runs), and its effort. Undefined for any other job.
export function quickRunTurn(job: { id: number; kind: string }) {
  if (!isQuickRun(job)) return undefined;
  const { ran } = db
    .prepare(
      'select coalesce(sum(julianday(ended) - julianday(started)), 0) * 86400000 ran from runs where job = ? and ended is not null',
    )
    .get(job.id) as { ran: number };
  return { until: Date.now() + QUICK_RUN_MS - Math.round(ran), effort: QUICK_EFFORT };
}

// Why a quick run's answer hasn't come, in the board's words where it asked (bookslips.ts waitingOf, booktyped.ts): its
// job still queued, or how it ended without one (quick_runs.missed). One cancelled, or ended before missed was kept,
// says nothing.
type Missed = 'queued' | 'failed' | 'stopped' | 'empty' | 'overtime';
const MISSED: Record<Missed, string> = {
  queued: 'Waiting for my turn to answer.',
  failed: "I couldn't answer that. Ask again.",
  stopped: 'My answer was stopped. Ask again.',
  empty: 'I finished without an answer. Ask again.',
  overtime: "That took longer than a quick answer can, so I stopped. Send the page and I'll answer it as work.",
};
export function whyMissed(job: number) {
  const r = db
    .prepare('select j.status, q.missed from jobs j join quick_runs q on q.job = j.id where j.id = ?')
    .get(job) as { status: string; missed: Missed | null } | undefined;
  if (r?.status === 'queued') return MISSED.queued;
  return r?.missed ? MISSED[r.missed] : null;
}
// A chat job's run ended (chat.ts ended): a quick run's goes to its purpose, with why no answer came kept; false for an
// intercom turn. overtime: the worker stopped it at its deadline.
export function quickRunEnded(job: number, status: string, result = '', overtime = false) {
  const purpose = purposeOf(job);
  if (!purpose) return false;
  db.prepare('update quick_runs set missed = ? where job = ?').run(missedOf(status, result, overtime), job);
  purposes.get(purpose)!.heard(job, status, result.trim());
  return true;
}
function missedOf(status: string, result: string, overtime: boolean): Missed | null {
  if (overtime) return 'overtime';
  if (status === 'done') return result.trim() ? null : 'empty';
  return status === 'stopped' ? 'stopped' : 'failed';
}
