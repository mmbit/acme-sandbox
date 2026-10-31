// The first saved work estimate beside its own runs and attributed whole-task cost.
import type { TaskAudit } from '../../coordinator/src/taskaudit.ts';
import type { TaskTimingFlag } from '../../coordinator/src/tasktime.ts';
import { workDuration, TASK_TIMING_REASONS } from './comparisons.ts';
import { carryLine, duration, spreadWords } from './estimate.ts';
import { plural, print } from './output.ts';

type Task = TaskAudit['rows'][number];

export function printTaskAudit(audit: TaskAudit) {
  const { window, coverage, work_size: work, overhead } = audit;
  print(
    'First saved work estimates against whole tasks.',
    `Tasks finished from ${window.since} (inclusive) up to ${window.until} (exclusive).`,
    `Coverage: ${plural(coverage.finished, 'finished task')}, ${coverage.original_tasks} original tasks, ${coverage.followup_views} follow-up views, ${coverage.private_tasks} private tasks excluded.`,
    `  Missing estimates ${coverage.missing_estimates}, missing runs ${coverage.missing_runs}, incomplete totals ${coverage.incomplete_totals}, unmerged tasks ${coverage.unmerged_tasks}, undated completions ${coverage.undated_completions}.`,
    `First estimates against work time: ${plural(coverage.scored, 'task')}${work.count ? `, ${spreadWords(work)}` : ', no eligible estimates.'}`,
    `Observed whole-task overhead: ${duration(overhead.agent_minutes)} across ${plural(overhead.tasks, 'complete original task')}, ${phaseWords(overhead.split)}.`,
    '  Work-size misses compare the first estimate with own work. The forecast adds shared review and fix overhead once per deliverable.',
    '  Observed overhead stays separate. Follow-up views are excluded from original-task totals.',
  );
  print(
    `Estimate timing: ${countWords(coverage.estimate_timing)}.`,
    `Own-work timing reasons: ${countWords(coverage.timing_reasons)}.`,
    `Whole-task timing reasons: ${countWords(coverage.whole_timing_reasons, true)}.`,
  );
  print(carryLine(audit.carry_checks));
  for (const task of audit.rows) printTask(task);
}

function printTask(task: Task) {
  const estimate = task.first_estimate;
  const first = estimate ? estimateWords(estimate, task.origin) : 'missing';
  const miss = task.work_miss_minutes === null ? 'unscored' : signedMinutes(task.work_miss_minutes, task.origin);
  const quality = task.timing_quality.length ? `; own-work timing: ${task.timing_quality.join(', ')}` : '';
  const flags = task.whole.flags.map(flag => TASK_TIMING_REASONS[flag]);
  const wholeQuality = flags.length ? `; whole-task timing: ${flags.join(', ')}` : '';
  print(
    '',
    `#${task.id} ${task.agent}: ${task.title} (${task.role}${task.origin === 'carry' ? ', mechanical carry check, worker occupancy' : ''})`,
    `  First saved work estimate: ${first}`,
    `  Own work ${task.actual_work_minutes === null ? 'unmeasured' : workDuration(task.actual_work_minutes, task.origin)}, work-size miss ${miss}; whole task ${workDuration(task.whole.agent_minutes, task.origin)} (${task.whole.complete ? 'complete' : 'incomplete'}), overhead ${duration(task.overhead_minutes)}.`,
    `  Phases: work ${workDuration(task.whole.split.work, task.origin)}, ${phaseWords(task.whole.split)}${quality}${wholeQuality}`,
  );
  if (task.revisions.length)
    for (const revision of task.revisions) print(`  Later revision: ${estimateWords(revision, task.origin)}`);
  if (task.prediction && estimate?.source !== 'prediction')
    print(
      `  Default prediction: ${workDuration(task.prediction.agent_ms / 60_000, task.origin)}, ${task.prediction.made} (${task.prediction.timing}, separate from caller size)`,
    );
}

function estimateWords(estimate: NonNullable<Task['first_estimate']>, origin: Task['origin']) {
  const revised = estimate.revised ? ', revised' : '';
  return `${workDuration(estimate.agent_ms / 60_000, origin)} from ${estimate.source}, by ${estimate.by}, ${estimate.at} (${estimate.timing}${revised})`;
}

const phaseWords = (split: TaskAudit['overhead']['split']) =>
  `reviews ${duration(split.reviews)}, fixes ${duration(split.fixes)}, re-syncs ${duration(split.syncs)}, previews ${duration(split.previews)}`;

const countWords = (counts: Record<string, number>, whole = false) =>
  Object.entries(counts)
    .map(([reason, count]) => `${whole ? TASK_TIMING_REASONS[reason as TaskTimingFlag] : reason} ${count}`)
    .join(', ') || 'none';

const signedMinutes = (minutes: number, origin: Task['origin']) =>
  `${workDuration(Math.abs(minutes), origin)} ${minutes >= 0 ? 'over' : 'under'} estimate`;
