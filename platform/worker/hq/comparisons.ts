// Past jobs and timing exclusions shown before a queuer judges scope.
import type { TaskTime, TaskTimingFlag } from '../../coordinator/src/tasktime.ts';
import { duration } from './waits.ts';
import { minute, plural, print } from './output.ts';

export type Job = {
  id: number;
  agent: string;
  title: string;
  finished: string;
  agent_minutes: number;
  whole: TaskTime;
  wall_minutes: number | null;
  runs: number;
  rebuilt: boolean;
  spend: number | null;
  unit: string;
  files: number;
  pr: { number: number; status: string; merged_at: string | null } | null;
  tool_bound: boolean;
  brief?: string | null;
  report?: string | null;
  changed_files?: string[];
  added?: number | null;
  removed?: number | null;
  timing_quality?: string[];
};
export type Typical = { agent_minutes: number; low: number; high: number; spend: number | null; unit: string | null };
export type Quality = { total: number; excluded: number; clean: number; reasons: Record<string, number> };

export function printJobs({ job, jobs, typical }: { job?: Job; jobs: Job[]; typical: Typical | null }, words: string) {
  if (job) print(`Job #${job.id} itself:`, ...jobLines(job), '');
  if (!jobs.length) return print('No done job like it.', '');
  print(
    `Clean past jobs found for ${words ? `"${words}"` : 'that'}, search matches first. Compare their scope before choosing a size.`,
  );
  print('Whole time includes reviews, fixes, re-syncs and previews. Queue, seat, deploy and card waits are out.');
  print('--size covers the work split only. The forecast adds review and fix rounds once per deliverable.');
  print(
    'Shared follow-up time is divided equally among the tasks on the branch. A shared preview is divided by branch first.',
  );
  for (const j of jobs) print(...jobLines(j));
  if (typical) {
    const spend = typical.spend === null ? '' : `, ${spendText(typical.spend, typical.unit!)} of seat spend`;
    print(
      `Typical work split of these: ${duration(typical.agent_minutes)} of agent time (the middle half ${duration(typical.low)} to ${duration(typical.high)})${spend}.`,
    );
  }
  print('');
}

function jobLines(j: Job) {
  const wall = j.wall_minutes === null ? '' : `, ${duration(j.wall_minutes)} from its first start to its end`;
  const pr = j.pr
    ? `, ${j.files} files changed, PR #${j.pr.number} ${j.pr.merged_at ? `merged ${minute(j.pr.merged_at)}` : j.pr.status}`
    : ', no pull request';
  const spent = j.spend === null ? 'seat spend not reported' : `${spendText(j.spend, j.unit)} of seat spend`;
  const lines = [
    `#${j.id} ${j.agent}, done ${minute(j.finished)}: ${j.title}`,
    `  ${j.rebuilt ? '≈' : ''}${duration(j.agent_minutes)} of agent time in ${plural(j.runs, 'run')}${wall}; ${spent}${pr}`,
  ];
  lines.push(wholeLine(j.whole));
  if (j.tool_bound)
    lines.push('  Mostly waiting on tools that use no tokens (renders, test suites): its hours cost the seats little.');
  if (j.changed_files?.length) lines.push(`  Files: ${j.changed_files.join(', ')}`);
  if (j.added != null || j.removed != null) lines.push(`  Diff: +${j.added ?? '?'} / -${j.removed ?? '?'} lines`);
  if (j.brief) lines.push(`  Brief: ${j.brief}`);
  if (j.report) lines.push(`  Report: ${j.report}`);
  if (j.timing_quality?.length) lines.push(`  Timing flags: ${j.timing_quality.join(', ')}`);
  return lines;
}

function wholeLine(whole: Job['whole']) {
  const split = Object.entries(whole.split)
    .map(([phase, minutes]) => `${phase} ${duration(minutes)}`)
    .join(', ');
  const state = whole.complete ? 'Whole task' : 'Task so far';
  const shared =
    whole.allocation === 'followup'
      ? 'Follow-up job: its own work and subsequent rounds.'
      : `Shared rounds: 1/${whole.tasks.length} of the branch's follow-up time.`;
  const flags = whole.flags.length
    ? ` Incomplete timing: ${whole.flags.map(flag => TASK_TIMING_REASONS[flag]).join(', ')}.`
    : '';
  return `  ${state}: ${duration(whole.agent_minutes)} of agent time (${split}). ${shared}${flags}`;
}

const TASK_TIMING_REASONS: Record<TaskTimingFlag, string> = {
  missing_runs: 'recorded runs missing',
  open_runs: 'runs still open',
  invalid_time: 'invalid or nonpositive run times',
  rebuilt: 'reconstructed runs or missing seats',
  missing_merge_time: 'merge time missing',
  unattributed_previews: 'historical previews without task links',
};

export function printQuality(quality: Quality) {
  const share = quality.total ? Math.round((quality.excluded / quality.total) * 100) : 0;
  print(
    `Past-job timing audit: ${quality.clean} clean of ${quality.total} done jobs; ${quality.excluded} excluded (${share}%).`,
  );
  for (const [reason, count] of Object.entries(quality.reasons)) print(`  ${reason}: ${count}`);
  print('');
}

const spendText = (amount: number, unit: string) =>
  unit === '$' ? `$${amount.toFixed(2)}` : `${Math.round(amount).toLocaleString('en-GB')} tokens`;
