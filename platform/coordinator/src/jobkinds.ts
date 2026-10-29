// A job's kind for where the tokens went, as SQL over `jobs j`: the status report's usage tables (infra/report.sh) and
// Numbers' Tokens dashboard (tokens.ts) read the same kinds. The review loop's
// jobs for an author ('pr fix': a fix, bringing a branch up to date, a re-land) carry the pull request's number; the
// board's notes on one are its own kind. Downtime is maintenance on spare capacity; 'scheduled' is the rest of
// schedule.ts's jobs (titled '<entry> (<slot>)'). An entry's own kind (schedule.yaml's kind: refactoring) comes first and
// takes its pull request's reviews and fixes along (the process review checks refactoring's share). Every lookup goes through an index of schedule_runs (job, slot), so
// HQ can read a week of runs while it serves. scheduleKinds: whether schedule_runs has its kind column (a database from
// before it doesn't).
// No imports: the status report imports it beside its own database connection.
export function kindOf(scheduleKinds = true) {
  const byJob = 'select s.kind from schedule_runs s where s.job = j.id and s.kind is not null';
  const byBranch =
    "select s.kind from schedule_runs s where s.job = cast(substr(j.branch, 5) as integer) and j.branch = 'job/' || s.job and s.kind is not null";
  const rest =
    "case when j.kind <> 'work' then j.kind when j.stage = 'feedback' then 'board notes' " +
    "when j.pr is not null and j.queued_by is null then 'pr fix' when j.downtime then 'downtime' " +
    `when j.queued_by is null and exists (select 1 from schedule_runs s where s.slot = ${SLOT}) then 'scheduled' ` +
    "else 'work' end";
  return scheduleKinds ? `coalesce((${byJob}), (${byBranch}), ${rest})` : rest;
}

// A title's last ' (<slot>)': rtrim with every character but '(' cuts it back to its last '('.
const LAST_OPEN = "rtrim(j.title, replace(j.title, '(', ''))";
const SLOT = `iif(j.title like '%)' and ${LAST_OPEN} like '% (', substr(j.title, length(${LAST_OPEN}) + 1, length(j.title) - length(${LAST_OPEN}) - 1), null)`;
