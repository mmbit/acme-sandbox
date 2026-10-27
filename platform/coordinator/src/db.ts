// Coordinator storage, schema and migrations.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DATA_DIR, REPO_DIR } from './config.ts';
import { redact, redactJson, keysStamp, REDACT_RULES } from './secrets.ts';

// ---- the connection and its helpers

// Other processes open this file too (infra/report.sh, the backup's copy, reset.py), and a write that finds it locked
// waits a moment instead of failing at once ("database is locked" cut a hand-off to the panel between its round and its
// reviews). Short: the wait blocks the whole server.
export const db = new DatabaseSync(`${DATA_DIR}/hq.db`, { timeout: 1500 });
// Deleted rows (swept mail, an erased care case, a scrubbed key) are overwritten, not left readable in the
// file's free pages. That needs the rollback journal SQLite starts with: a write-ahead log (journal_mode = wal) keeps the
// old pages in hq.db-wal, after a checkpoint too.
db.exec('pragma secure_delete = on');
// Writes that belong together, all or none, and one disk sync for them all: outside a transaction the journal syncs on
// every write, and the server waits for each. One inside another is a savepoint of it, so
// it nests where a plain begin can't. A trial (keep: false) rolls back after reading its answer too.
// What a step does outside the database (afterStep: the events it publishes) waits for the outermost step to be kept,
// and is dropped with a step rolled back. What it took out of memory to write (onUndo: the prediction log's kept rows)
// goes back when a step it's in is rolled back, the outermost's failed commit too.
// The outermost step is undone with a plain rollback, which no lock turns away. Its release is a commit, which another
// process's read can turn away ("database is locked"), and a failed one would leave the connection in a transaction no
// later step commits, every write after it lost when the process ends.
const afterSteps: { kept: (() => void)[]; undone: (() => void)[] }[] = [];
export function inOneStep<T>(run: () => T, { keep = true } = {}): T {
  const undo = db.isTransaction ? 'rollback to step; release step' : 'rollback';
  db.exec('savepoint step');
  const step = { kept: [] as (() => void)[], undone: [] as (() => void)[] };
  afterSteps.push(step);
  try {
    const done = run();
    db.exec(keep ? 'release step' : undo);
    afterSteps.pop();
    const outer = afterSteps.at(-1);
    if (!keep) for (const then of step.undone) then();
    else if (outer) {
      outer.kept.push(...step.kept);
      outer.undone.push(...step.undone);
    } else for (const then of step.kept) then();
    return done;
  } catch (err) {
    afterSteps.pop();
    db.exec(undo);
    for (const then of step.undone) then();
    throw err;
  }
}
// A lookup made many times a second, prepared once and kept: the queue's play (backlog.ts) looks up each open job's
// waits, cards and wakes on every play, and compiling such a statement takes longer than running it. Only for
// get and all: a statement under iterate() is still being read when the next call would reset it.
const kept = new Map<string, ReturnType<typeof db.prepare>>();
export function prepared(sql: string) {
  let statement = kept.get(sql);
  if (!statement) kept.set(sql, (statement = db.prepare(sql)));
  return statement;
}
// Something outside the database: now, or once the step it's in is kept.
export const afterStep = (then: () => void) => (afterSteps.length ? afterSteps.at(-1)!.kept.push(then) : then());
// Something put back outside the database if the step it's in is rolled back; outside a step, nothing to undo.
export const onUndo = (then: () => void) => void afterSteps.at(-1)?.undone.push(then);
// Whether a step is under way, so what's kept in memory goes back with it (onUndo).
export const inStep = () => afterSteps.length > 0;
// A job (`job`, its row's alias) that can still merge: open work, or done with its latest pull request still in review.
// Shared by wait and pause validation and their cycle check.
export function mergePending(job: string) {
  return `(${job}.status in ('queued', 'running', 'blocked') or ${job}.status = 'done' and
    (select status from prs where branch = coalesce(${job}.branch, 'job/' || ${job}.id)
      order by number desc limit 1) in ('open', 'stuck', 'board'))`;
}
// A key's value never stays in the free text an agent can read (secrets.ts redact()): a module that keeps such text names
// its columns once its table exists, and every insert and update of them is redacted as it's written. The triggers are
// this connection's own (temp), so the file holds none: report.sh, the backup's copy or an older coordinator open it
// without redact(). scrub(): the same over what's already written, when a key is saved.
db.function('redact', { varargs: false }, (t: unknown) => redact(t) as string | null);
// (and a JSON column's, string by string: redactedJson.)
db.function('redact_json', { varargs: false }, (t: unknown) => redactJson(t) as string | null);
const guarded: [string, string, string][] = [];
export function redacted(table: string, ...cols: string[]) { guard('redact', table, cols); }
// a column that holds JSON (secrets.ts redactJson()).
export function redactedJson(table: string, ...cols: string[]) { guard('redact_json', table, cols); }
function guard(fn: string, table: string, cols: string[]) {
  for (const col of cols) {
    guarded.push([table, col, fn]);
    for (const on of ['insert', `update of ${col}`]) db.exec(`create temp trigger if not exists redact_${table}_${col}_${on.split(' ')[0]}
      after ${on} on main.${table} when new.${col} is not ${fn}(new.${col})
      begin update ${table} set ${col} = ${fn}(new.${col}) where rowid = new.rowid; end`);
  }
}
// scrub() remembers the keys, rules and columns it ran for, and a start runs it only when those changed (a key put in by
// hand, a new column, a deploy that changed redact()): every write since went through the triggers. That holds only while
// this coordinator is hq.db's one writer (report.sh, the backup and the payments shelf only read; reset.py writes only at
// a reset): a new writer runs scrub() after its writes. Each pass reads every row, seconds on a server's database with its
// keys, while HQ waits for the start.
export function scrub() {
  const keysAndColumns = scrubbedFor();
  for (const [t, c, fn] of guarded) db.exec(`update ${t} set ${c} = ${fn}(${c}) where ${c} is not ${fn}(${c})`);
  remember('scrubbed', keysAndColumns);
}
export function scrubOnStart() {
  if (setting('scrubbed') !== scrubbedFor()) scrub();
}
// The query planner's statistics, so it picks the narrow index for a query (a job's pull request, not its state, which
// every done job shares): once every module's tables exist, then hourly, as SQLite advises a long-running process. Each
// run reads again only the tables that changed much since the last.
export const optimize = () => db.exec('pragma optimize=0x10002');
// a hash, so the settings table holds no key's size (secrets.ts keeps keys out of the database)
const scrubbedFor = (rules = REDACT_RULES) =>
  createHash('sha256').update(JSON.stringify([[...guarded].sort(), rules, keysStamp()])).digest('hex');
// A database made by this start: a new company's first (no tables at all), or the one a fresh start leaves, which holds
// only the board's sign-ins (infra/reset.py KEPT_TABLES, and settings). Neither has run a one-off fix yet. One from before
// the migrations table has others (events, jobs, mail), so its one-off fixes run.
const KEPT_BY_A_FRESH_START = ['credentials', 'sessions', 'enrollments', 'push_subscriptions', 'settings'];
const born = (db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[])
  .every(t => KEPT_BY_A_FRESH_START.includes(t.name));
// ---- schema

// Every create statement includes all of the table's columns. Add a new column to its create statement and add an
// `alter table ... add column` in a once() below for databases that already have the table.
//
// The board's sign-ins: credentials (its passkeys), sessions, enrollments (a sign-up link, used once), and its devices'
// push subscriptions. events: the feed HQ shows.
//
// jobs: one agent's run of work.
// - stage (review.ts Stage): a review-loop job's role, apart from its title.
// - step: the review loop's step beside the work's own title.
// - token: the running job's agent token (sha256 only).
// - room_for: the ready work it last paused to make room for (jobs.ts makesRoom), which gets that room first.
// - writes: the files a ruling may touch itself (JSON, review.ts touch-ups).
// - stopping: who stopped it (hq stop) and why, kept when it ends stopped.
// - suspending: who paused it with its thread (suspendReview) and why, until the run ends.
// - off_worker: its suspending is HQ's, for the worker's room (offWorker), not a pause's.
// - queued_by: the agent who queued it (null: the coordinator's own).
// - customers: it was handed a customer's own details (charter rule 7), never spread.
// - downtime: maintenance on spare capacity only.
// - cut: what a stop of the worker's container cut in its last run, for the next run's prompt.
// - model, effort: a scheduled entry's own (schedule.ts).
// - held_by: the seat whose usage limit holds it (only whether it's set matters).
// - about_keys: its chat session heard a call about a card for keys (chat.ts).
// - instead_of: the job it replaces (a review's retry, a takeover of failed work), whose call item and failure go with it.
// - told: the board's word from a call (message items' ids, JSON) a review, ruling or fix took (review.ts withTold).
// - cli: the CLI it must run on (none: any seat of its engine).
// - is_check: QA, audits and compliance reads (hq job --check, since check is reserved in SQL).
// - seq: its place among its thread's tasks (null: its id's).
// - code: its task's name for the board and calls, its project's prefix and a word (HQ-COVERS), shared by the task's
//   steps (jobcodes.ts).
// - landing: a run that ended well but whose push or pull request the worker couldn't make (JSON: its pull request's
//   body and its report, jobs.ts finish): its next run only lands it.
//
// seats: each seat as the worker last reported it.
// - util, week: windows used (0 to 1), with each reset time in resets and week_resets (ms).
// - pace: 1 while its week runs ahead of its pace (only the board's word and work due before its reset can start).
// - credits: 1 while it runs on credits past its limits (playseats.ts).
//
// requests: the cards on the desk phone.
// - secrets: the keys a credential card asks for (a password field each).
// - approves: what approving grants (approvals.ts: live:<slug> or site:<slug>).
// - pr: the pull request a "needs your call" card decides.
// - photos, documents, zips, questions: what it asks for beside its answer box (each JSON).
//   Their readers are photos.ts, documents.ts, zips.ts and hq/shell/questions.js.
// - address: its four keys are one delivery address (secrets.ts addressKeys).
// - customers: a tool wrote it about one customer.
// - answered: when it left the desk phone.
// - changed: when its open text last changed (shown as new again).
// - closing: HQ's line on a card whose matter ended by itself (endRequest).
// - hidden_until: kept off the desk phone until then (later.ts), still open.
//
// prs: each pull request the review loop runs (review.ts).
// - since: the last job id before its current round started (only later runs are that round's).
// - review_since: the last job id before the board sent it back. Rulings before it belong to the previous review.
// - panel: the current round's panel (toPanel: full, held, light, deck, two, one).
// - review_class: the risk class used to measure review rounds, retained when a later panel is partial.
// - fixes_from: the commit a round reviews the author's fixes from (null: a full review).
//
// calls: a call with the board (call.ts), with a row from its start (status live).
// - processed_at: a follow-up ended done with the items recorded after its transcript came in (lines_at).
// - reply: what the board reads after the call, set by its follow-up (hq reply, ledger.ts reply).
// - line_times: when each of its lines was said (JSON, ms since the epoch on the server's clock, one per line; null for
//   a call from before they were kept), so a walk-through's recording lines up with them (watchalong.ts timeline).
//
// chat: the intercom (chat.ts).
// - shown: the line shown for a call (the CEO hears the whole transcript, text).
// - about_customer, about_keys: the line came from a job that holds a customer's details or heard a call about keys.
//   Only the board and the CEO's session see it.
// - card: a card the CEO put on its reply (hq intake, chat.ts card), as JSON.
// A database from before these columns moved into their tables' creates (a company that last ran the platform before
// 23 October) gets them first, where the table is there already, before anything below indexes or reads them. A new
// database has no such tables yet: the creates give them their columns.
const FOLDED: Record<string, string[]> = {
  calls: ['reply text', 'line_times text'],
  findings: ['cross_project integer not null default 0'],
  jobs: [
    'peak_mb integer',
    'room_for integer',
    'seq real',
    'step text',
    'code text',
    'engine_only text',
    'judges text',
    'off_worker integer not null default 0',
  ],
  memory_docs: ['stamp text'],
  messages: ['held integer'],
  pay_lines: [
    'held text',
    'held_why text',
    'held_words text',
    'held_revision text',
    'held_seen text',
    'held_answer text',
    'held_answered text',
    'held_taken text',
  ],
  proposals: ['project text', 'heard_by integer', 'heard_at text'],
  prs: ['review_since integer not null default 0', 'review_class text', 'merge_refused text'],
  seats: ['credits integer'],
  sizer_tries: ['answered integer not null default 0'],
  test_results: ['began text'],
  threads: ['aim integer', 'branch text'],
};
for (const [table, columns] of Object.entries(FOLDED)) {
  const has = new Set((db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map(c => c.name));
  if (has.size)
    for (const column of columns)
      if (!has.has(column.split(' ')[0])) db.exec(`alter table ${table} add column ${column}`);
}
db.exec(`
  create table if not exists credentials (id text primary key, public_key blob not null, counter integer not null,
    transports text, created text not null);
  create table if not exists sessions (token text primary key, expires integer not null);
  create table if not exists enrollments (hash text primary key, used text not null);
  create table if not exists events (id integer primary key, ts text not null, type text not null, agent text,
    "to" text, text text, state text);
  create table if not exists jobs (id integer primary key, created text not null, agent text not null,
    title text not null, prompt text not null, engine text not null,
    status text not null default 'queued', seat text, branch text, session text, attempts integer not null default 0,
    not_before integer not null default 0, heartbeat integer, request integer, note text, result text,
    kind text not null default 'work', pr integer, round integer, output text, after integer, finished text, token text,
    sha text, peak_mb integer, room_for integer, writes text, stopping text, queued_by text,
    customers integer not null default 0, for_seat text, downtime integer not null default 0, cut text, model text,
    effort text, stage text, started text, held_by text, call integer, item integer, answers integer,
    about_keys integer not null default 0, instead_of integer, told text, voided text, cli text, thread text,
    is_check integer not null default 0, seq real, suspending text, step text,
    code text, landing text, engine_only text, judges text, off_worker integer not null default 0,
    expedite integer not null default 0);
  create table if not exists seats (id text primary key, engine text not null, state text not null,
    until integer, note text, updated integer, util real, resets integer, week real, week_resets integer, pace integer,
    credits integer, cli text);
  create table if not exists requests (id integer primary key, created text not null, agent text, job integer,
    kind text not null, title text not null, body text not null, urgency text not null default 'today',
    status text not null default 'open', answer text, seat text, secrets text, approves text, pr integer, photos text,
    documents text, zips text, address integer, questions text, customers integer not null default 0, answered text,
    changed text, topic text, heard_by integer, closing text, hidden_until text, walk integer not null default 0);
  create table if not exists prs (number integer primary key, branch text not null, author text not null,
    round integer not null default 0, status text not null default 'open', verdict text, sha text,
    since integer not null default 0, review_since integer not null default 0,
    files text not null default '[]', added integer, removed integer, links text not null default '[]', why text,
    panel text, review_class text, gate_fails integer not null default 0, fixes_from text, checks_note text not null default '',
    tests_incomplete integer not null default 0, merged_at text, merge_refused text, expedited integer not null default 0);
  create table if not exists schedule_runs (id text not null, slot text not null, job integer, kind text,
    routine text, primary key (id, slot));
  create table if not exists settings (key text primary key, value text not null);
  create table if not exists push_subscriptions (endpoint text primary key, p256dh text not null, auth text not null,
    device text, created text not null);
  create table if not exists calls (id integer primary key, ts text not null, agent text not null, request integer,
    lines text not null, job integer, status text not null default 'ended', processed_at text,
    attempts integer not null default 0, lines_at text, resumes text, reply text,
    customers integer not null default 0, line_times text, walk integer not null default 0);
  create table if not exists chat (id integer primary key, ts text not null, who text not null, text text not null,
    sent integer not null default 0, call integer, shown text, about_customer integer not null default 0,
    about_keys integer not null default 0, card text);
`);
// A done job's routine and its calls, looked up by job for each done job (matching.ts pastJobs): on stale planner
// statistics each lookup would otherwise read the whole table.
db.exec(`create index if not exists schedule_runs_job on schedule_runs (job) where job is not null;
  create index if not exists calls_job on calls (job) where job is not null`);

// A value a module keeps between runs (the settings table), and remember(key, null) forgets it.
export const setting = (key: string) => (db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
export const remember = (key: string, value: string | null) => value === null ? db.prepare('delete from settings where key = ?').run(key)
  : db.prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);

// The lookups without which each would read the whole jobs table, its outputs too: a pull request's jobs (review.ts,
// windows.ts), a branch's (ledger.ts, the status report), the done jobs' measured memory by agent and kind (room.ts),
// the jobs by state (every claim and HQ's lists), by an agent call's token, and a branch's pull requests with their
// numbers and states (redraws.ts review_branches, every play's: a pull request's verdict sits before the rest of its
// row). And the feed's old lines, which payments.ts's sweep looks for every two
// minutes.
db.exec(`create index if not exists jobs_pr on jobs (pr) where pr is not null;
  create index if not exists jobs_branch on jobs (branch) where branch is not null;
  create index if not exists jobs_work_branch on jobs (coalesce(branch, 'job/' || id)) where kind = 'work';
  create index if not exists jobs_peak on jobs (agent, kind, id) where peak_mb is not null and status = 'done';
  create index if not exists jobs_status on jobs (status, finished);
  create index if not exists jobs_token on jobs (token) where token is not null;
  create index if not exists prs_branch_state on prs (branch, number, status);
  drop index if exists prs_branch;
  create index if not exists events_ts on events (ts)`);
// Covers the jobs columns read by reviewtime.ts and reviewplan.ts (the measured runs, and each pull request's review
// runs), so they skip wide job rows and their briefs. Those queries name this index with `indexed by`. Any jobs columns
// they add belong here too.
db.exec(`create index if not exists jobs_review_runs on jobs (id, status, kind, stage, engine, round, agent, pr, seq);
  drop index if exists jobs_run_sizes`);
// Covers queueRows in backlog.ts, ordered by status then id, so queue reads avoid brief and output overflow pages.
// That query names it with `indexed by`.
db.exec(`create index if not exists jobs_queue on jobs (status, id, kind, agent, title, step, round, engine, for_seat,
  downtime, after, request, not_before, held_by, created, branch, pr, seat, thread, finished, stage, queued_by)`);
// Covers reviewplan.ts records and selections and backlog.ts work in review without reading verdict overflow pages.
// Files and links are fetched separately for PRs in review. Those queries name it with `indexed by`
db.exec(`create index if not exists prs_plan on prs (number, branch, author, panel, review_class, round, status, sha,
  since)`);
// Thread task reads exclude PR jobs before fetching their rows.
db.exec(`create index if not exists jobs_tasks on jobs (thread, coalesce(seq, id), id)
  where kind = 'work' and pr is null and status != 'cancelled'`);
// Wire's work tallies (work.ts) without a row read: each agent's jobs done by day and last finished work job, and the
// merges by day.
db.exec(`create index if not exists jobs_done_by on jobs (finished, agent) where status = 'done';
  create index if not exists jobs_last_work on jobs (agent, finished, title) where status = 'done' and kind = 'work';
  create index if not exists prs_merged on prs (merged_at, author) where merged_at is not null`);
// The CEO's summary (summary.ts, threats.ts, finished.ts) counts and picks jobs by when they came in and ended without a
// row read: status, kind and finished sit after the brief and output. Those queries name it with `indexed by`.
db.exec('create index if not exists jobs_counts on jobs (created, kind, status, finished)');
// And the jobs carrying the board's call items (agreements.ts), each one's kind, status and branch: by id, and by item.
// By id also every job waited for or replacing one in the redraw and wait relations (redraws.ts, jobs.ts waitRelations),
// which each statement wrapped in redraws.query reads whole.
db.exec(`create index if not exists jobs_state on jobs (id, kind, status, branch);
  create index if not exists jobs_carried on jobs (item, kind) where item is not null`);
// A pull request's review loop as the hourly check's summary reads it (threats.ts latestMove, when work last moved),
// without each review's brief. That query names it with `indexed by`.
db.exec(`create index if not exists jobs_pr_loop on jobs (pr, kind, round, sha, stage, created, status, finished, voided)
  where pr is not null`);
// An agent's own work jobs, newest first (memory.ts history: hq history, a call's history tool), without reading other
// agents' job rows. That query names it with `indexed by`.
db.exec(`create index if not exists jobs_agent_work on jobs (agent, id) where kind = 'work'`);
// Whom an agent queued work for lately (jobs.ts inFlight, at each work or chat job's claim): without it the read walks
// every job's brief and output, seconds when they're off the disk. That query names it with `indexed by`.
db.exec('create index if not exists jobs_queued_for on jobs (queued_by, created, agent)');
// Done work as matching.ts pastJobs reads it, every column it takes from a job: without it the read walks every done
// job's brief and output, seconds when they're off the disk (the claim's plan, sizing a job just queued). That query
// names it with `indexed by`. Its own filter's columns too: SQLite reads the row for a term the index's where implies.
db.exec(`create index if not exists jobs_history on jobs (id, agent, title, engine, created, finished, stage, round,
  queued_by, pr, branch, thread, customers, about_keys, kind, status) where kind = 'work' and status = 'done';
  drop index if exists jobs_done_work; drop index if exists jobs_past`);
// Every jobs column the status report (infra/report.sh) reads beside usage and the step log, and for the reviews' run
// times: from the rows, its reads went through every job's brief and report, seconds off a cold disk, and HQ's writes
// waited for them (a 2.9 s stall). Those queries name it with `indexed by`: any jobs columns they add belong here too.
db.exec(`create index if not exists jobs_report on jobs (id, kind, status, agent, pr, round, branch, engine, stage,
  queued_by, downtime, started, finished, title)`);

// The board's saved addresses' labels (addresses.ts; each address itself is in the key store).
db.exec('create table if not exists addresses (id integer primary key autoincrement, label text not null, created text not null)');
redacted('prs', 'checks_note');
// pushes: the files each of a pull request's pushed commits changes against main (review.ts), and the lines it adds or
// alters per file (findings.ts ChangedLines, JSON; null for a touch-up commit, whose lines shift the later ones). `at`:
// when that commit was first pushed (threats.ts, when work last moved). `checked`: 1 when its gates and tests both passed
// on it, else 0 (null: pushed before it was kept): what an expedited merge needs (review.ts checksPassed).
db.exec('create table if not exists pushes (pr integer not null, sha text not null, files text not null, lines text, at text, checked integer, primary key (pr, sha))');
// What a pull request's pushes still owe before a review: work only one engine does that a run on another changed, to
// restore from \`since\` and redo (engineonly.ts), and changed files people see whose previews no push recorded yet
// (visual.ts).
db.exec('create table if not exists engine_redo (pr integer primary key, files text not null, since text)');
db.exec('create table if not exists previews_owed (pr integer primary key, files text not null)');
// The review findings that reached an author (a ruling's "changes"), with what became of each as the next ruling judged
// it, and the pre-existing ones the consolidator confirmed (findings.ts). `by`: the reviewers who reported it, with
// their engines (JSON).
db.exec(`create table if not exists findings (id integer primary key, created text not null, pr integer not null, round integer not null,
  ruling integer not null, kind text not null, file text, line integer, issue text not null, by text not null, outcome text, right text, cross_project integer not null default 0)`);
db.exec('create index if not exists findings_pr on findings (pr)');
// The review follow-up bundle (a proposal) each finding went into (followups.ts).
db.exec('create table if not exists review_followups (finding integer primary key, proposal integer not null)');
// Accepted rulings retain their blocking IDs independently of later finding outcomes.
db.exec('create table if not exists finding_rulings (ruling integer primary key, blocking text not null)');
// The reviewer runs whose reports a ruling was given.
db.exec('create table if not exists ruling_reports (ruling integer not null, report integer not null, primary key (ruling, report))');
db.exec('create table if not exists review_refusals (job integer primary key, at integer not null, reason text not null)');
redacted('review_refusals', 'reason');
// The accepted rulings whose nonblocking findings went to the project's follow-ups, not the author (findings.ts record),
// and what each ruling from the upstream round on said went wrong before review, in its owner's proposal (followups.ts
// upstream).
db.exec('create table if not exists followup_rulings (ruling integer primary key)');
db.exec(`create table if not exists review_upstream (ruling integer primary key, pr integer not null, line text not null,
  proposal integer not null)`);
// The consolidations asked, when they were made, to say what went wrong before review (review.ts roundJob).
db.exec('create table if not exists upstream_owed (job integer primary key)');
redacted('findings', 'file', 'issue');
// A push that waits for its round's ruling while that round's panel is out (reviewpushes.ts): the latest per pull request.
db.exec('create table if not exists review_waiting_pushes (pr integer primary key, push text not null, at text not null)');
redactedJson('review_waiting_pushes', 'push');
// A pass whose branch had moved on by its ruling, for that push (reviewpushes.ts leavePass)
db.exec('create table if not exists review_left_passes (ruling integer primary key)');
// The worker's merge of main into a pull request's reviewed commit, which GitHub merges in its place (review.ts mergeMain).
db.exec('create table if not exists main_merges (pr integer not null, sha text not null, head text not null, primary key (pr, sha))');
// The consolidator's touch-ups (review.ts): the files a ruling may change itself (jobs.writes) and what the worker did
// with them. `head` is the touch-up commit on the reviewed `base`, or null with why it was `refused`. `kept`: its author
// checked it and changed nothing, so it merges in place of the ruled commit.
db.exec(`create table if not exists touchups (job integer primary key, pr integer not null, round integer not null, base text not null,
  head text, files text not null default '[]', refused text, kept integer not null default 0)`);
// More jobs a queued job waits for, besides its own `after` (jobs.ts READY): each
// must end done with its pull request merged. Written by a company's one-offs (company/migrations.sql); hq has no flag.
db.exec('create table if not exists waits (job integer not null, on_job integer not null, primary key (job, on_job))');
// The cards a queued job waits for (hq job --after request:<id>, hq waits <job> add request:<id>). Each card holds the
// job until the card leaves the desk phone. The card's answer goes into the job's prompt (jobs.ts tellWaiting).
db.exec('create table if not exists request_waits (job integer not null, request integer not null, primary key (job, request))');
// The events a queued job waits for (hq job --when, wakes.ts): the next deploys, a deploy that recreated a container, a
// job's or pull request's work deployed, or a time. `since`: when it was queued (ms), what deploys are counted from;
// `met`: what happened, once it has. The deploys are the server's own records (infra/deploys.py), one row per file.
db.exec(`create table if not exists wakes (job integer not null, kind text not null, arg text not null, since integer not null,
  met text, primary key (job, kind, arg))`);
db.exec(`create table if not exists deploys (file text primary key, sha text not null, fetched text not null, finished text not null,
  ok integer not null, recreated text not null default '[]', reloaded text not null default '[]', services text not null default '[]')`);
db.exec('create index if not exists deploys_finished on deploys (finished)');
// The Codex seat each share went to (a job, or a normal review round's Codex review its seat was out for), so the next
// goes to the seat with fewer (jobs.ts codexShare).
db.exec('create table if not exists codex_shares (id integer primary key, seat text not null, at integer not null, job integer)');
// The work an open card waits for, kept off the desk phone until it's merged and deployed (later.ts holdsFor): a
// deployed: wake's arg, '<job>' or 'pr:<n>' (wakes.ts)
db.exec('create table if not exists request_holds (request integer not null, work text not null, primary key (request, work))');

// A live call's agent token (call.ts): only its sha256, the agent it speaks as, until when, and its call. listed: the
// open items the call's briefing numbered (call.ts context(), JSON ids), the only earlier items its replace may change
// (server.ts), with a restart adding the rebuilt briefing's. queued: the jobs the call queued, the only ones its agent may add
// to while it goes on (call.ts addToJob).
db.exec(`create table if not exists call_tokens (hash text primary key, agent text not null, expires integer not null,
  listed text not null default '[]', queued text not null default '[]', call integer)`);
// The call ledger (ledger.ts): what each call asked for, decided or explained, and what was promised on it, one item
// each. `what` is the one plain line the board sees; `quote` (the words on the call, verbatim) and `lines` (the
// transcript range) stay with the agents. An item is open until its job ends done, or it's linked to a request or a ref
// (a decision entry, a note, a commit), or dropped with a `why` the board reads. `replaces`: the earlier item a
// correction replaced (status 'replaced', with the why). by: the job that recorded it (null: the call's own token, or
// the board: board, it added the item after the call in HQ-OS → Calls). acted_at: when the call's follow-up last
// recorded, handed out, linked, dropped or acknowledged it (processed_at needs one since lines_at: ledger.ts recorded()).
// due: the time the board was given for it (ms), which the thread of the job that carries it, or is linked to it, takes
// as its window (ledger.ts link, server.ts hq job). goal: why the board wants it (its goal, or the problem it solves),
// which the work is judged against; null on an item the board added itself, and on one recorded before it was asked for.
// A task or promise whose work ended done is 'ready' since ready_at, and handled only once the CEO records the board's
// yes, in `said` (ledger.ts done).
db.exec(`create table if not exists call_items (id integer primary key, call integer not null, kind text not null, owner text not null,
  what text not null, quote text not null, lines text, status text not null default 'open', job integer, request integer, ref text,
  why text, replaces integer, ts text not null, closed_at text, by integer, acted_at text, board integer, due integer, goal text,
  ready_at text, said text)`);
// (the open ones and their jobs, which the queue's every read asks for: jobs.ts BOARD_CALL)
db.exec('create index if not exists call_items_open on call_items (status, job)');
// The open pull requests' branches, whose jobs carry a board item on until it merges (jobs.ts BOARD_CALL; the statuses
// are jobs.ts OPEN_PRS): a few rows, not every pull request's
db.exec("create index if not exists prs_open on prs (branch) where status in ('open', 'stuck', 'board')");
redacted('jobs', 'title', 'prompt', 'note', 'result', 'output', 'cut', 'stopping', 'suspending'); redactedJson('jobs', 'landing');
redacted('requests', 'title', 'body', 'answer', 'topic'); redactedJson('requests', 'questions');
redactedJson('calls', 'lines'); redacted('calls', 'reply'); redacted('chat', 'text'); redacted('call_items', 'what', 'quote', 'why', 'ref', 'said'); redacted('events', 'text'); // (lines)
// untold: a running job owed the message that its item (call_items.id) was dropped or replaced, until it's sent (ledger.ts
// tell(): a live call's correction has nobody to send it; a refused send is tried again).
db.exec('create table if not exists untold (job integer not null, item integer not null, primary key (job, item))');
// reply_asks: a call's work follow-up briefed before replies were set (hq reply), owed the ask for one until its next run
// reads it (ledger.ts askReplies).
db.exec('create table if not exists reply_asks (job integer primary key)');
// The CEO's hourly follow-through checks (followthrough.ts), one per hour slot: the job, and the verdict it recorded
// with its one line.
db.exec(`create table if not exists followthrough_checks (slot text primary key, job integer not null, created text not null,
  verdict text, said text, at text)`);
redacted('followthrough_checks', 'said');
// (by job: the queue's every read asks whether a job is one, jobs.ts FOLLOW_THROUGH)
db.exec('create index if not exists followthrough_checks_job on followthrough_checks (job)');
// The board's sent notes the CEO routes (routing.ts), one row a note: the routing check that holds it, what it's about
// (slug, its owner and where, and whether it comes back as a product's return, owed.ts), its brief text, and once
// routed the job it went to and how. Here rather than in that module: claim() reads it to let a routing check start
// first (jobs.ts BOARD_CALL).
db.exec(`create table if not exists note_routes (note integer primary key, job integer not null, slug text not null,
  owner text not null, name text not null, place text not null, returns integer not null, text text not null, created text not null,
  routed text, to_job integer, how text, back text, board_why text);
  create index if not exists note_routes_job on note_routes (job)`);
redacted('note_routes', 'text');
// The book's sheets (booknotes.ts): one a page owner while open, in whose book (who), and once sent the job it went to.
// Here rather than in that module, as note_routes: claim() reads it, since a sent sheet is the board's word (jobs.ts
// BOARD_CALL). owner null: pages nobody owns, which go to the CEO's routing check. status: open, sending (its ten
// seconds to undo, until send_at, in ms) or sent; or call: a call's page's notes, numbered there and never sent (the
// agent on the call heard them: bookcalls.ts), one such sheet a call's page beside its owner's open one. page: a free
// page sent on its own, its one-off sheet (booksend.ts sendPage), never an owner's batch: an owner has one open or
// sending batch (book_sheets_batch, below the columns added since). (page)
db.exec(`create table if not exists book_sheets (id integer primary key autoincrement, who text not null default 'board',
  owner text, status text not null default 'open', created text not null, send_at integer, sent text, job integer,
  page integer);
  create index if not exists book_sheets_job on book_sheets (job) where job is not null`);
// The book's notes (booknotes.ts), each on a sheet and a page, here beside their sheets so every reader has them.
// (by: who wrote it, the board or an invited person. review: its sent note on HQ, feedback.ts, once it went to a job.
// asked: its question's quick run. answers: the slip it's a reply under.)
db.exec(`create table if not exists book_notes (id integer primary key autoincrement, sheet integer not null,
  page integer not null, n integer not null, by text not null, anchor text not null, words text not null default '',
  said text, snip text, status text not null default 'open', created text not null, updated text not null,
  review integer, asked integer, answers integer);
  create index if not exists book_notes_sheet on book_notes (sheet, n);
  create index if not exists book_notes_page on book_notes (page);
  create index if not exists book_notes_review on book_notes (review) where review is not null;
  create index if not exists book_notes_asked on book_notes (asked) where asked is not null`);
redacted('book_notes', 'words', 'said'); redactedJson('book_notes', 'anchor');
// A wiped note (booknotes.ts wipeNote) as it was, its row (note, JSON) and the owner of the sheet it was on, kept for its
// Undo (restoreNote), then forgotten with its snip.
db.exec(`create table if not exists book_wiped (id integer primary key, who text not null, owner text,
  sheet integer not null, note text not null, wiped integer not null)`);
redactedJson('book_wiped', 'note');
// The jobs carrying a call item and their replacements, which the follow-through check reads every minute
// (agreements.ts), and a thread's jobs: without these each read every job.
db.exec(`create index if not exists jobs_item on jobs (item) where item is not null;
  create table if not exists job_replacements (job integer not null, replaces integer not null, primary key (job, replaces));
  create index if not exists job_replacements_prior on job_replacements (replaces, job);
  create view if not exists job_replacement_links as select id job, instead_of replaces from jobs where instead_of is not null
    union all select job, replaces from job_replacements;
  create index if not exists jobs_instead_of on jobs (instead_of) where instead_of is not null;
  create index if not exists jobs_thread_state on jobs (thread, status, finished, branch) where thread is not null;
  drop index if exists jobs_thread`);
// (a thread's jobs with their state, end and branch: the projects view, tallies.ts, reads them without a row's prompt and
// output.)
// A branch's work, by its title (reviewrows.ts fixesOf): those queries name it with `indexed by`.
db.exec(`create index if not exists jobs_work_titles on jobs (coalesce(branch, 'job/' || id), id)
  where kind in ('work', 'chat') and stage is null`);
// The open tasks, each with its thread and branch: a redraw's holds (redraws.ts holds) read them by `indexed by`, never
// a row's prompt and output (each a walk through its overflow pages on a cold file).
db.exec(`create index if not exists jobs_open_tasks on jobs (id, thread, branch)
  where kind = 'work' and pr is null and status in ('queued', 'running', 'blocked')`);
// The tasks whose work may still merge, each with its thread, state and branch: a plan change's check for tasks waiting on
// themselves (redraws.ts selfWaitingTasks, named by `indexed by`) reads them twice per hq job move, never every work job's
// row (seconds off a cold disk). Kind and pr are columns too: SQLite reads the row for a term the index's where implies.
db.exec(`create index if not exists jobs_merge_pending on jobs (thread, status, branch, kind, pr)
  where kind = 'work' and pr is null`);
// The covering index keeps claim-time history reads (matching.ts pastJobs, named by `indexed by`) off the jobs table's
// prompt and output overflow pages.
db.exec(`create index if not exists jobs_past on jobs (id, agent, title, engine, created, finished, thread, branch, stage,
  round, queued_by, pr) where kind = 'work' and status = 'done'`);
// goal_told: jobs that heard an item's goal when linked while queued or running (ledger.ts goalTo). They hear it only
// once. They hear when the item is dropped or replaced (ledger.ts stop).
db.exec('create table if not exists goal_told (job integer not null, item integer not null, primary key (job, item))');
// goal_owed: jobs linked to an item whose goal HQ refused to send them (the sender's messages an hour, a full chain).
// Linking the item to the job again tries again, though the job carries it by then (ledger.ts goalTo).
db.exec('create table if not exists goal_owed (job integer not null, item integer not null, primary key (job, item))');
// The tasks whose titles the board reads (boardnames.ts namedTask), newest first: the names' claim (plainnames.ts, every
// 15 s, named by `indexed by`) reads each title without its row's prompt and output.
db.exec(`create index if not exists jobs_named on jobs (id, title, thread, status) where kind = 'work' and customers = 0`);
// The work a pause made room for (jobs.ts makesRoom): every claim that starts a job clears it on the jobs that held it
// for that one, by the index and not by reading every job's row, prompt and output.
db.exec('create index if not exists jobs_room_for on jobs (room_for) where room_for is not null');
// Token use per job run, for Finance's seat economics (usage.ts): numbers and model names only. `totals` is the engine's
// running total for the session at that point, so the next run of the session can be stored as what it added.
db.exec(`create table if not exists usage (id integer primary key, job integer not null, ts text not null, engine text not null,
  seat text, session text, models text not null, input integer not null, cache_write integer not null, cache_read integer not null,
  output integer not null, cost real, totals text not null)`);
// The status report's cost per job looks usage up by job (usage.ts reads by session: usage_session). The index keeps
// that read short, so a report reader doesn't block HQ's writes past its 1.5 s lock wait
db.exec('create index if not exists usage_job on usage (job)');
// The seats' spend in a window (headroom.ts), a seat's and an engine's, read several times a play of the queue: each its
// window's rows, not the whole table.
db.exec(`create index if not exists usage_seat on usage (seat, ts) where seat is not null;
  create index if not exists usage_engine on usage (engine, ts)`);
// A run's base is its session's latest report, whichever job made it (usage.ts recordUsage).
db.exec('create index if not exists usage_session on usage (session) where session is not null');
// The board's seats (seats.ts), kept here and changed in HQ's Settings › Seats: the worker runs jobs on these, each served by a
// provider (the platform's, the company's company/providers.yaml, or one the board added: seat_providers, with the CLI it
// speaks to beside its engine's, none: that engine's own). A removed seat keeps its row until the worker has removed it.
// stop: its stop level in percent of its windows (null: the worker's default). use_credits: 1 once the board lets it spend
// its account's credits past its plan. seat_actions: each change the board made,
// until the worker says how it went.
db.exec(`create table if not exists seat_list (id text primary key, provider text not null, paused integer not null default 0,
    removing integer not null default 0, added text not null, stop integer, use_credits integer not null default 0);
  create table if not exists seat_providers (id text primary key, name text not null, engine text not null, url text not null,
    model text not null, added text not null, cli text);
  create table if not exists seat_actions (id integer primary key, seat text, engine text, what text not null,
    status text not null default 'waiting', words text, at integer not null, done integer)`);
// A project's threads (projects.ts), here rather than in that module: claim() reads their window.
// id: "<project>/<slug>", the name jobs.thread holds. by: the job that started it. done: when it was closed. deadline and
// aim: the thread's window (windows.ts), the time the board was given for its work and the earlier time it's aimed at
// (aim <= deadline, both ms), with who gave the board the time (deadline_by). branch: the thread's branch, once its first
// task starts. Its owner is its project's (projects.ts ownerOf). judge: the job HQ queued its owner to judge it once its
// work merged with nothing left open (threadjudge.ts).
db.exec(`create table if not exists threads (id text primary key, project text not null, name text not null,
  goal text not null, status text not null default 'open', created text not null, by integer, done text, deadline integer,
  deadline_by text, aim integer, branch text, judge integer)`);
// A company's plans (plan.ts), here rather than in that module: company.ts reads the projects, and the claim will read
// the needs and the order. projects: each a line of work with one owner, in the order made (by: the agent who made it,
// or projects.yaml for one lifted from its old `projects:` list). done: when hq project done closed it. thread_needs: a
// thread starts once every thread it needs is done and merged. plan_changes: every change to a plan, who made it and the
// meeting it came from. code: the prefix of its tasks' codes (jobcodes.ts),
// two or three capitals, unique. goal: when the CEO marked it one of the company's goals (goals.ts), else null
db.exec(`create table if not exists projects (id text primary key, name text not null, owner text not null, business text,
    product text, status text not null default 'open', created text not null, by text not null, done text, code text, goal text);
  create table if not exists thread_needs (thread text not null, needs text not null, primary key (thread, needs));
  create table if not exists plan_changes (id integer primary key, at text not null, project text not null, thread text,
    what text not null, by text not null, meeting integer)`);
redacted('plan_changes', 'what');
// A change to a plan, as it's made (plan.ts, and jobs.ts for each task added to a thread).
// The meeting it came from: the live one its agent sits in, unless given.
export function planChange(c: { project: string; thread?: string | null; what: string; by: string; meeting?: number | null }) {
  const meeting = c.meeting !== undefined ? c.meeting : sittingIn(c.by);
  db.prepare('insert into plan_changes (at, project, thread, what, by, meeting) values (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), c.project, c.thread ?? null, c.what, c.by, meeting);
  if (meeting !== null) takeBack(meeting, c.by); // (the chair's, who never hands in, too)
}
// A meeting's inputs changed (a plan change made in it, a hand-in taken back or sent back, an ask joined): its tally goes,
// and the agent's hand-in, if it had one, comes back to it, to hear the meeting again from where it handed in.
export function takeBack(meeting: number, agent: string) {
  db.prepare('update meeting_seats set handed = null, read = coalesce(handed_read, read) where meeting = ? and agent = ? and handed is not null').run(meeting, agent);
  db.prepare('update meetings set tally = null where id = ?').run(meeting);
}
// The meeting an agent sits in now, if any: the hook for plan changes made in a meeting (plan_changes.meeting)
export function sittingIn(agent: string) {
  const row = db
    .prepare(
      `select s.meeting from meeting_seats s join meetings m on m.id = s.meeting join jobs j on j.id = s.job
    where s.agent = ? and m.status = 'live' and j.status = 'running'`, // (a seat marked done is still in it.)
    )
    .get(agent) as { meeting: number } | undefined;
  return row?.meeting ?? null;
}

// The plan changes made in a meeting, each with its owner (the agent who made it).
export const meetingChanges = (meeting: number) =>
  db.prepare('select at, project, thread, what, by from plan_changes where meeting = ? order by id').all(meeting) as
    { at: string; project: string; thread: string | null; what: string; by: string }[];
// The projects whose plans a meeting changed, each with its latest change in it (GET /api/meetings: the meeting room's tags),
// read here beside the changes themselves
export function meetingProjects(meeting: number) {
  return db
    .prepare(
      `select c.project id, coalesce(p.name, c.project) name, max(c.at) changed from plan_changes c
      left join projects p on p.id = c.project where c.meeting = ? group by c.project order by changed`,
    )
    .all(meeting) as { id: string; name: string; changed: string }[];
}

// A paused project or thread (pauses.ts): thread null pauses the whole project. item: the board's call item it carries
// out (hq item link <item> pause:<id>). decision: the board's decision it waits for (decisions.ts). until_time: the time
// that wakes its owner (ISO). woken: the job HQ queued its owner once what it waits for (its time, its pause_until jobs
// settled) was met, to judge what's next, until a re-pause puts it on new conditions; pause_wakes keeps every job that
// woke an owner, which no pause holds (jobs.ts pauseLets). resumed: when it
// ended, by its CEO or owner (resumed_by) or, null, by the board's answer on its decision's card. pause_until.on_main: that job's commits reached main with its pull request
// closed (review.ts close). Here rather than in that module: claim() reads them.
db.exec(`create table if not exists pauses (id integer primary key, project text not null, thread text, why text not null,
    by text not null, at text not null, item integer, resumed text, resumed_by text, decision integer, until_time text,
    woken integer);
  create table if not exists pause_until (pause integer not null, job integer not null, on_main integer not null default 0,
    primary key (pause, job));
  create table if not exists pause_wakes (job integer primary key, pause integer not null)`);
redacted('pauses', 'why');
// A decision of the board's named ahead of its card (decisions.ts), which pauses wait for: request, the card that asks
// it once there is one; answered, when the board answered that card; released, when the board let what it holds go in
// HQ instead; card_job, the card job a visual hold queued; settled, the board's item or card that answered it without
// that card (visualapproval.ts settle).
db.exec(`create table if not exists decisions (id integer primary key, name text not null, by text not null, at text not null,
  request integer, answered text, released text, card_job integer, settled text)`);
redacted('decisions', 'name');
// A review's major visual changes share a decision within their thread. Only their merges wait for it.
 db.exec(`create table if not exists decision_merges (pr integer primary key, decision integer not null,
   sha text not null, scope text not null)`);

// The board's pick of an agent's model on its page in HQ (models.ts): its main model and its one fallback, each a
// model id from the company's list, null for none.
db.exec('create table if not exists agent_models (agent text primary key, main text, fallback text, at text not null)');
// Each push's tests as the worker ran them, by the git trees of the code they tested and of its base (testresults.ts):
// the job whose push it was, whether they passed (null: claimed, running), the report, when, and the current
// claimant's first claim time (began, kept when the same job claims again: at minus began is its wall time).
db.exec(`create table if not exists test_results (tree text not null, base text not null, job integer not null,
  passed integer, report text not null default '', at text not null, began text, primary key (tree, base))`);
redacted('test_results', 'report');
// Base comparisons are kept independently of the push that needed them.
db.exec(`create table if not exists base_test_results (base text not null, test text not null, job integer not null,
  failed integer, primary key (base, test))`);
db.exec('create table if not exists migrations (id text primary key)');
// All or nothing: a fix that throws halfway isn't recorded as done, and runs again at the next start. A one-off fix is
// for the work already in the database of the company that wrote it: a database made by this start, with no work in it
// yet, has nothing to fix, so the fix is recorded as done without running, and never brings another company's jobs or
// requests along. (The columns and tables above aren't one-off: every database gets them.)
const fresh = () => born && !db.prepare('select 1 from jobs union all select 1 from requests union all select 1 from calls union all select 1 from chat limit 1').get();
// The foundation's own one-offs are removed from the code once every company's database has run them (their ids stay recorded).
export function once(id: string, sql: string | (() => void)) {
  db.exec('begin');
  try {
    if (db.prepare('insert or ignore into migrations (id) values (?)').run(id).changes && !fresh()) typeof sql === 'string' ? db.exec(sql) : sql();
    db.exec('commit');
  } catch (err) { db.exec('rollback'); throw err; }
}
// The names of a table's columns, for a once() that adds one an older database lacks.
export const columnsOf = (table: string) =>
  (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map(c => c.name);
once('review-round-state', () => {
  const columns = columnsOf('prs');
  for (const name of columns) {
    if (name === 'merge_rounds' || name === 'final_rounds') db.exec(`alter table prs drop column ${name}`);
  }
  if (!columns.includes('merge_refused')) db.exec('alter table prs add column merge_refused text');
});
once('review-forecast-class', () => {
  const columns = db.prepare('pragma table_info(prs)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'review_class')) db.exec('alter table prs add column review_class text');
  db.exec("update prs set review_class = case panel when 'fix' then 'full' else panel end");
});

// A thread's owner comes from its project (projects.ts ownerOf), and planning has no stored mode.
once('2026-10-22-threads-in-order-only', () => {
  if (columnsOf('threads').includes('owner')) db.exec('alter table threads drop column owner');
  db.prepare("delete from settings where key = 'planning.mode'").run();
});

once('historical-review-sizes', () => {
  for (const [table, columns] of [
    ['predictions', ['review_ms', 'slow_review_ms']],
    ['prediction_log', ['review_ms']],
  ] as const) {
    const kept = columnsOf(table);
    for (const column of columns) if (kept.includes(column)) db.exec(`alter table ${table} drop column ${column}`);
  }
});

// A company's own one-offs (work for its live company: a job for its CEO, a card for its board) go in its
// company/migrations.sql, not here, so they never come upstream and a foundation update never meets them in this file.
// Each starts at a `-- once: <id>` line and runs as once() does. The server runs them at its start (companyOnce), when
// every module's tables are there, and every minute after, so one that lands on main takes effect within a minute.
export function companyOnce(file = `${REPO_DIR}/company/migrations.sql`) {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return; /* none: a company with no one-offs of its own */ }
  for (const part of text.split(/^-- once: /m).slice(1)) {
    const [id, ...sql] = part.split('\n');
    once(id.trim(), sql.join('\n'));
  }
}

// ---- columns added since their table was made
// Each only where its table is older: a database from before the migrations table makes its tables at this start, with
// every column.
// (exported for inbox.ts)
export const lacks = (table: string, column: string) =>
  !(db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).some(c => c.name === column);
once('2026-10-20-jobs-code', () => lacks('jobs', 'code') && db.exec('alter table jobs add column code text'));
once('2026-10-21-jobs-landing', () => lacks('jobs', 'landing') && db.exec('alter table jobs add column landing text'));
once('2026-10-22-findings-routing', () => lacks('findings', 'cross_project') && db.exec('alter table findings add column cross_project integer not null default 0'));
once('2026-10-22-prs-review-since', () => lacks('prs', 'review_since') && db.exec('alter table prs add column review_since integer not null default 0'));
// An expedited fix (jobs.expedite: the CEO's hq job --expedite) and the pull request it merged ahead of its review
// (prs.expedited).
once('2026-10-23-expedite', () => {
  if (lacks('jobs', 'expedite')) db.exec('alter table jobs add column expedite integer not null default 0');
  if (lacks('prs', 'expedited')) db.exec('alter table prs add column expedited integer not null default 0');
});
// A visual decision's card job (decisions.card_job) and the board's word that settled it without a card (settled:
// visualapproval.ts settle). Those from before: the latest card job the hold queued, read from its own prompt's first line
once('2026-10-27-decisions-settled', () => {
  if (lacks('decisions', 'settled')) db.exec('alter table decisions add column settled text');
  if (!lacks('decisions', 'card_job')) return;
  db.exec(`alter table decisions add column card_job integer;
    update decisions set card_job = (select max(j.id) from jobs j where j.kind = 'work'
      and j.title = 'Show the visual changes before they go live'
      and j.prompt like 'Review found a major visual change to something live. Decision #' || decisions.id || ' holds its merge.%')
    where exists (select 1 from decision_merges m where m.decision = decisions.id)`);
});
// A pause's time (pauses.until_time)
once('2026-10-24-pauses-until-time', () => lacks('pauses', 'until_time') && db.exec('alter table pauses add column until_time text'));
// When each push was first pushed (pushes.at): those from before, when the first run on that commit was made.
once('2026-10-23-pushes-at', () => {
  if (!lacks('pushes', 'at')) return;
  db.exec(`alter table pushes add column at text;
    update pushes set at = (select min(created) from jobs where jobs.pr = pushes.pr and jobs.sha = pushes.sha)`);
});
// Whether a pushed commit passed its gates and tests (pushes.checked)
once('2026-10-26-pushes-checked', () => lacks('pushes', 'checked') && db.exec('alter table pushes add column checked integer'));
// Why a note came back to routing from the work it went to, in agents' words and the board's (note_routes.back,
// board_why: routing.ts).
once('2026-10-24-note-routes-back', () => {
  if (lacks('note_routes', 'back')) db.exec('alter table note_routes add column back text');
  if (lacks('note_routes', 'board_why')) db.exec('alter table note_routes add column board_why text');
});
redacted('note_routes', 'back');   // (a job's report in it)
// A seat already running on credits when the board's switch came keeps them: it was the board's to choose, and stays so.
once('2026-10-22-seat-list-credits', () => {
  if (!lacks('seat_list', 'use_credits')) return;
  db.exec('alter table seat_list add column use_credits integer not null default 0');
  db.exec('update seat_list set use_credits = 1 where id in (select id from seats where credits = 1)');
});
// engine_only: the rule of work only one engine does (engineonly.ts) that keeps its job there; judges: the files a review
// judges.
once('2026-10-21-jobs-engine-only', () => {
  if (lacks('jobs', 'engine_only')) db.exec('alter table jobs add column engine_only text');
  if (lacks('jobs', 'judges')) db.exec('alter table jobs add column judges text');
});
// A task's steps share its code (jobcodes.ts), and projects have their prefix.
once('2026-10-21-task-codes', () => {
  db.exec('drop index if exists jobs_code');
  if (lacks('projects', 'code')) db.exec('alter table projects add column code text');
});
// A project the CEO marks a goal
once('2026-10-26-project-goals', () => {
  if (lacks('projects', 'goal')) db.exec('alter table projects add column goal text');
});
db.exec(`create index if not exists jobs_by_code on jobs (code);
  create unique index if not exists projects_code on projects (code)`);
// Every job as HQ lists it, without its prompt and output: the rows of jobs.ts jobRows (listedQuery) and what the projects
// view reads of the same jobs (reviewrows.ts shownOf, boardnames.ts boardJobs), named by `indexed by`. A column they read
// belongs here. (Here, once the columns added since are in: code, expedite.).
db.exec(`create index if not exists jobs_listed on jobs (id, code, created, finished, agent, title, engine, status, seat,
  attempts, request, kind, pr, round, stage, step, downtime, after, thread, seq, is_check, call, item, branch, session,
  not_before, expedite, customers, sha, voided, result)`);
// A call followed up before replies were set kept its notes as its work follow-up's last message: that becomes its reply.
// A work follow-up still open was briefed that way: it's owed the ask for hq reply (reply_asks), which ledger.ts
// askReplies() puts where its next run reads it (finished() needs the reply).
once('2026-10-21-calls-reply', () => {
  if (lacks('calls', 'reply')) db.exec('alter table calls add column reply text');
  db.exec(`update calls set reply = (select nullif(trim(j.result), '') from jobs j where j.id = calls.job and j.kind = 'work' and j.status = 'done')
    where processed_at is not null and reply is null`);
  db.exec(`insert or ignore into reply_asks (job) select id from jobs where kind = 'work' and status in ('queued', 'running', 'blocked')
    and id in (select job from calls where status = 'ended' and processed_at is null)`);
});
// call_items.goal, redacted once it's there.
once('2026-10-24-call-items-goal', () => lacks('call_items', 'goal') && db.exec('alter table call_items add column goal text'));
redacted('call_items', 'goal');
// A live call handed a customer's details by a look-up (jobs.ts readerHanded).
// A pause's condition wakes its owner rather than lifting it (pauses.ts wake)
once('2026-10-25-pauses-wake', () => {
  if (lacks('pauses', 'until_time')) db.exec('alter table pauses add column until_time text');
  if (lacks('pauses', 'woken')) db.exec('alter table pauses add column woken integer');
  if (lacks('pause_until', 'on_main')) db.exec('alter table pause_until add column on_main integer not null default 0');
});
// Every job a pause woke its owner with, kept past a re-pause
once('2026-10-26-pause-wakes', () =>
  db.exec('insert or ignore into pause_wakes (job, pause) select woken, id from pauses where woken is not null'),
);
// A thread's last merge wakes its owner to judge it (threadjudge.ts)
once('2026-10-26-threads-judge', () => lacks('threads', 'judge') && db.exec('alter table threads add column judge integer'));
db.exec('create index if not exists threads_judge on threads (judge) where judge is not null');
once('2026-10-24-calls-customers', () => {
  if (lacks('calls', 'customers')) db.exec('alter table calls add column customers integer not null default 0');
});
// A task or promise ready for the board's yes (ledger.ts done)
once('2026-10-25-items-ready', () => {
  if (lacks('call_items', 'ready_at')) db.exec('alter table call_items add column ready_at text');
  if (lacks('call_items', 'said')) db.exec('alter table call_items add column said text');
});
// A card that offers its maker's walk-through (hq ask --walk), and a call that is one (walkthroughs.ts).
once('2026-10-26-walk', () => {
  if (lacks('requests', 'walk')) db.exec('alter table requests add column walk integer not null default 0');
  if (lacks('calls', 'walk')) db.exec('alter table calls add column walk integer not null default 0');
});
// The card on the CEO's intercom reply in the onboarding (chat.ts card).
once('2026-10-26-chat-card', () => lacks('chat', 'card') && db.exec('alter table chat add column card text'));
// A free page sent on its own is a one-off sheet (book_sheets.page), apart from its owner's one open or sending batch.
once('2026-10-26-book-sheets-page', () => lacks('book_sheets', 'page') && db.exec('alter table book_sheets add column page integer'));
db.exec(`drop index if exists book_sheets_open;
  drop index if exists book_sheets_owner;
  create unique index if not exists book_sheets_batch on book_sheets (who, coalesce(owner, ''))
    where status in ('open', 'sending') and page is null`);
db.exec('drop table if exists call_pins');

// A minute is the worker's reporting cadence. Two weekly windows keep observations on both sides of a reset.
db.exec(`create table if not exists seat_readings (seat text not null, minute integer not null,
  at integer not null, util real, resets integer, week real, week_resets integer, primary key (seat, minute))`);
db.exec('create index if not exists seat_readings_at on seat_readings (seat, at)');
db.exec(`insert or ignore into seat_readings (seat, minute, at, util, resets, week, week_resets)
  select id, updated / 60000, updated, util, resets, week, week_resets from seats
  where updated is not null and (util is not null or week is not null)`);

// Observation tables exist before any request can roll back its first read.
const observedWindowsExist = db.prepare("select 1 from sqlite_master where name = 'seat_window_observations'").get();
db.exec(`create table if not exists seat_window_observations (seat text not null, quota text not null,
  at integer not null, reported_at integer not null, used real not null, resets integer)`);
db.exec('create index if not exists seat_window_observations_at on seat_window_observations (seat, quota, at, reported_at)');
once('2026-10-26-seat-window-observations', () => {
  if (observedWindowsExist) return;
  for (const [quota, usage, reset] of [
    ['five', 'util', 'resets'],
    ['week', 'week', 'week_resets'],
  ]) {
    db.exec(`insert or ignore into seat_window_observations (seat, quota, at, reported_at, used, resets)
      select seat, '${quota}', at, at, ${usage}, ${reset} from seat_readings where ${usage} is not null`);
  }
});
