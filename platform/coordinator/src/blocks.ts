// Runs blocked on the worker. A job past its share of the worker (memory, processes, or the cores for long: the worker's
// shares.ts) has that run frozen and stopped, and HQ gives the words the worker writes into the run's own output, where
// its agent reads the command's end: what it used, and where to run it instead. That's the deployment's offload machine
// (a lent machine, runs.ts offloadPlaces, by its name and size as HQ has them), even when it's slower there; while it's
// away, hq run waits for it; with none, the work goes in pieces under the share, or the agent says in its report that
// it can't. Never the same run again here: a job blocked STOP_AT times is stopped, so no agent loops against the share.
// What the share can't free (the worker short of memory for long all the same) goes outside HQ: jam.ts.
import {
  ACCOUNTING_FAILURE_REASONS,
  workerAccountingFailure,
  type AccountingFailure,
  type AccountingFailureReason,
} from '../../worker/src/accounting.ts';
import { db, redacted, once, columnsOf, inOneStep } from './db.ts';
import { publish, redact } from './events.ts';
import * as jobs from './jobs.ts';
import { offloadPlaces } from './runs.ts';
import * as diskwarnings from './diskwarnings.ts';

export const STOP_AT = 3;
const COMMAND_MAX = 300;
const MEASURES = ['memory', 'processes', 'cores', 'disk'] as const;
type Measure = (typeof MEASURES)[number];

db.exec(`create table if not exists blocks (id integer primary key, at text not null, job integer not null,
  measure text not null, used real, share real not null, event text, report text, count integer,
  accounting_error integer not null default 0, accounting_failure_reason text)`);
once('blocks-command-free-receipts', () => {
  const columns = columnsOf('blocks');
  if (columns.includes('command')) db.exec('alter table blocks drop column command');
  for (const column of ['event text', 'report text', 'count integer'])
    if (!columns.includes(column.split(' ')[0])) db.exec(`alter table blocks add column ${column}`);
});
once('blocks-unknown-disk-use', () => {
  db.exec(`create table blocks_nullable (id integer primary key, at text not null, job integer not null,
    measure text not null, used real, share real not null, event text, report text, count integer);
    insert into blocks_nullable select id, at, job, measure, used, share, event, report, count from blocks;
    drop table blocks;
    alter table blocks_nullable rename to blocks;`);
});
db.exec('create unique index if not exists blocks_event on blocks (event)');
once('blocks-accounting-failures', () => {
  db.exec('alter table blocks add column accounting_error integer not null default 0');
  db.exec('update blocks set accounting_error = 1 where used is null');
});
once('blocks-accounting-failure-reasons', () => {
  db.exec('alter table blocks add column accounting_failure_reason text');
});
redacted('blocks', 'report');

type Receipt = {
  job: number;
  measure: Measure;
  used: number | null;
  share: number;
  report: string;
  count: number;
  accounting_error: number;
  accounting_failure_reason: AccountingFailureReason | null;
};

// A receipt keeps the command-free report and stop in one step. Retries reuse it even if the job or machines changed.
export function blocked(b: Record<string, unknown>) {
  const job = Number(b.job),
    agent = jobs.jobAgent(job);
  const measure = MEASURES.find(m => m === b.measure);
  const accountingError = b.accountingError !== undefined;
  const accountingFailureReason =
    ACCOUNTING_FAILURE_REASONS.find(reason => reason === (b.accountingError as AccountingFailure | null)?.reason) ??
    null;
  const unknownDisk = b.used === null && measure === 'disk' && accountingError && b.warning !== true;
  const used = unknownDisk ? null : Number(b.used),
    share = Number(b.share);
  const event = b.event;
  if (
    !agent ||
    !measure ||
    (accountingError && (measure !== 'disk' || accountingFailureReason === null || b.warning === true)) ||
    (b.used === null && !unknownDisk) ||
    (used !== null && (!Number.isFinite(used) || !(used >= 0))) ||
    !Number.isFinite(share) ||
    !(share >= 0 && (share > 0 || measure === 'disk')) ||
    typeof event !== 'string' ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(event)
  )
    return 400;
  if (b.warning === true) {
    if (measure !== 'disk') return 400;
    const text = `HQ's worker: this job uses ${amount(measure, used)}, past its disk share of ${amount(measure, share)}. ${clearDisk(job)} Continued writing while over the share will have its command stopped.`;
    return diskwarnings.record(event, job, text);
  }
  const receipt = inOneStep(() => {
    const kept = db
      .prepare(
        'select job, measure, used, share, report, count, accounting_error, accounting_failure_reason from blocks where event = ?',
      )
      .get(event) as Receipt | undefined;
    if (kept)
      return kept.job === job &&
        kept.measure === measure &&
        kept.used === used &&
        kept.share === share &&
        !!kept.accounting_error === accountingError &&
        kept.accounting_failure_reason === accountingFailureReason
        ? kept
        : 409;
    return recordBlock(event, job, agent, measure, used, share, accountingFailureReason);
  });
  if (typeof receipt === 'number') return receipt;
  const command = (redact(String(b.command ?? '')) ?? '').slice(0, COMMAND_MAX);
  return { text: `HQ's worker stopped this command (${command}): ${redact(receipt.report)}`, count: receipt.count };
}

function recordBlock(
  event: string,
  job: number,
  agent: string,
  measure: Measure,
  used: number | null,
  share: number,
  accountingFailureReason: AccountingFailureReason | null,
) {
  const accountingError = accountingFailureReason !== null;
  const workerFailure = workerAccountingFailure(accountingFailureReason);
  db.prepare(
    'insert into blocks (at, job, measure, used, share, event, accounting_error, accounting_failure_reason) values (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(new Date().toISOString(), job, measure, used, share, event, Number(accountingError), accountingFailureReason);
  const count = (
    db
      .prepare(
        "select count(*) n from blocks where job = ? and coalesce(accounting_failure_reason, '') not in ('worker-ancestor', 'worker-scanner')",
      )
      .get(job) as { n: number }
  ).n;
  publish({
    type: 'log',
    agent,
    text: accountingError
      ? `The worker blocked a run of job #${job}: disk accounting unavailable.`
      : `The worker blocked a run of job #${job}: ${amount(measure, used)}, past a job's share of ${amount(measure, share)}${count > 1 ? `, block ${count} of the job` : ''}.`,
  });
  const off =
    !workerFailure &&
    count >= STOP_AT &&
    jobs.offWorker(job, `blocked ${count} times for running past its share of the worker: it runs here no more`);
  const what = accountingError ? SLOT_ACCOUNTING_FAILURE : overuseWords(measure, used, share);
  const report = workerFailure ? WORKER_ACCOUNTING_FAILURE : words(measure, what, count, off, job);
  db.prepare('update blocks set report = ?, count = ? where event = ?').run(report, count, event);
  return { report, count };
}

const WORKER_ACCOUNTING_FAILURE =
  'Disk accounting is unavailable because the worker could not read its own infrastructure.\n' +
  'The command is held while disk accounting is unavailable. This adds no overuse strike.';
const SLOT_ACCOUNTING_FAILURE =
  'Disk accounting is unavailable for this live command. Restore readable process counters and job directories before running it again.';
type Off = ReturnType<typeof jobs.offWorker> | false;
function overuseWords(measure: Measure, used: number | null, share: number) {
  const took = measure === 'cores' ? `kept ${amount(measure, used)} busy for long` : `used ${amount(measure, used)}`;
  return used === null
    ? 'Further writing is held while disk accounting is unavailable.'
    : `this job ${took} on the HQ server's worker, past a job's share ` +
        `of ${amount(measure, share)}. ` +
        (measure === 'disk'
          ? 'Further writing is held while the job stays over its disk share.'
          : 'It runs here no more, whole or in bigger pieces.');
}

// What the run's output says: what happened, where to run it instead, and what comes of running it here again. At
// STOP_AT, what HQ did with the job (jobs.ts offWorker): stopped it, put it back in the queue (a review), or nothing.
function words(measure: Measure, what: string, count: number, off: Off, job: number) {
  const strikes = !off
    ? `This is this job's block ${count} of ${STOP_AT}: at ${STOP_AT}, HQ stops the job.`
    : typeof off === 'string'
      ? `That was this job's block ${count}, but HQ can't stop the job: ${off}.`
      : 'yields' in off
        ? `That was this job's block ${count}: HQ puts it back in the queue at its next step, to go on in its session ` +
          'once the worker has room. Run nothing heavy here meanwhile.'
        : `That was this job's block ${count}: HQ is stopping the job, and its work so far stays on its branch.`;
  return [what, measure === 'disk' ? clearDisk(job) : off ? '' : instead(), strikes].filter(Boolean).join('\n');
}

// Where it can go now: a lent machine taking work, with the kinds there; one that's away (hq run waits for it); or none,
// and then this server's own helper for the kinds it takes, or pieces under the share.
function instead() {
  const { machines, kinds } = offloadPlaces();
  const about = (name: string) => {
    const kind = kinds.find(k => k.name === name);
    return kind?.about ? `${name} (${kind.about})` : name;
  };
  const taking = machines.filter(m => m.kinds.length);
  const server = kinds.filter(k => k.server).map(k => k.name);
  const serverLine = server.length
    ? ` This server's own helper takes ${list(server)} runs (hq run --kind <kind>), outside the worker's share.`
    : '';
  if (taking.length)
    return (
      `Offload it, even if it takes longer there: hq run --kind <kind> -- <command>, in the background, and go on with ` +
      `the rest. ${taking.map(m => `${m.name}${size(m)} takes ${list(m.kinds.map(about))}`).join('; ')}. ` +
      'hq run helper shows each kind.'
    );
  if (machines.length)
    return (
      `Offload it with hq run --kind <kind> -- <command>, even if it takes longer: ${list(machines.map(m => m.name))} ` +
      `${machines.length === 1 ? "isn't" : "aren't"} taking work now, and hq run waits for ${machines.length === 1 ? 'it' : 'them'}.` +
      `${serverLine} Go on with what doesn't need the result; if nothing can, say so in your report.`
    );
  return (
    `This deployment has no offload machine.${serverLine} Otherwise run it here only in pieces that each stay under ` +
    "the share, one at a time; if it can't be split, don't run it: say so in your report."
  );
}

const size = (m: { cpus: number | null; memoryGb: number | null }) =>
  m.cpus && m.memoryGb ? ` (${m.cpus} cores, ${m.memoryGb} GB)` : m.memoryGb ? ` (${m.memoryGb} GB)` : '';
const clearDisk = (job: number) =>
  `Clear disposable caches, build output and temporary files from /work/jobs/${job}, /work/homes/${job} and /work/tests/${job}. Keep source and session files. Cleanup commands may run. Offload further builds with hq run.`;
const amount = (measure: Measure, n: number | null) =>
  n === null
    ? 'unknown disk use'
    : measure === 'disk'
      ? `${(n / 2 ** 30).toFixed(2)} GiB of disk`
      : measure === 'memory'
        ? `${Math.round(n).toLocaleString('en-GB')} MB`
        : measure === 'cores'
          ? `${Math.round(n * 10) / 10} cores`
          : `${Math.round(n)} processes`;
const list = (items: string[]) => new Intl.ListFormat('en-GB', { type: 'conjunction' }).format(items);
