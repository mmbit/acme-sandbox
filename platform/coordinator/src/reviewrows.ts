// What the projects view shows of a review round's jobs: a reviewer's findings or a ruling's verdict on its row, and
// on a click each finding in a line with what became of it.
// A fix round's row says what it fixes (fixesOf).
import { db } from './db.ts';
import * as findings from './findings.ts';

type Job = { id: number; kind: string; status: string; pr: number | null; stage?: string | null };
type Shown = {
  id: number;
  agent: string;
  kind: string;
  stage: string | null;
  pr: number;
  round: number;
  sha: string | null;
  output: string | null;
};
type Entry = {
  file?: unknown;
  line?: unknown;
  also?: unknown;
  issue?: unknown;
  severity?: unknown;
  by?: unknown;
  from?: unknown;
  earlier?: unknown;
};
// One of a ruling entry's sources: the reviewer and its finding's index in that reviewer's report (review-panel.md)
type Source = { by?: unknown; finding?: unknown };
type Row = {
  id: number;
  ruling: number;
  kind: string;
  outcome: string | null;
  right: string | null;
  proposal: number | null;
};
// A finding's fate: fixed (and the round that saw it so), kept on purpose, dropped (the ruling left it out, or the
// author showed it wrong), moved to the follow-up job, left for them once the pull request ends, or still open
export type Fate = { fate: 'fixed' | 'kept' | 'dropped' | 'follow-up' | 'later' | 'open'; round?: number };
export type Line = { issue: string; blocking: boolean } & Partial<Fate>;
const RULINGS = "kind = 'consolidate' and stage in ('ruling', 'check', 'recheck', 'merge')";
const VERDICTS = ['merge', 'changes', 'close', 'board', 'panel'];
// A reviewer's place is often a line or two off the one the ruling names (findings.ts NEAR)
const NEAR = 3;

// The jobs of the projects view, each finished review or ruling with its findings counted: blocking, notes (the rest)
// and a ruling's verdict, and each fix round with what it fixes
export function withFindings<J extends Job>(
  jobs: J[],
): (J & { findings?: ReturnType<typeof summaryOf>; fixes?: ReturnType<typeof fixOf> })[] {
  const shown = shownOf(
    jobs.filter(j => j.status === 'done' && j.pr && (j.kind === 'review' || j.kind === 'consolidate')),
    id => !summaries.has(id),
  );
  const fixes = fixesOf(jobs.filter(j => j.stage === 'fix'));
  return jobs.map(j => {
    const summary = shown.has(j.id) && summaryOf(shown.get(j.id)!);
    const fixing = fixes.get(j.id);
    return summary || fixing ? { ...j, ...(summary && { findings: summary }), ...(fixing && { fixes: fixing }) } : j;
  });
}

// ---- what a fix round fixes

type Fixing = {
  id: number;
  pr: number;
  round: number;
  title: string;
  step: string | null;
  work: string | null;
  task: string | null;
  sent: string | null;
};
// Each fix round of a review's findings (a fix job with its round): the round, the findings it takes in a line each
// (those its task names, else the ones the round's ruling sent back), whether it only checks the review's own edits
// (a task with none to fix), and its own title when that names them: not the work's (a step under it), nor the one HQ
// gave a task drawn from the findings before the consolidator named its tasks (reviewinbox.ts until job #8103). None
// for a fix outside a round (bringing the branch up to date and the like), or one whose findings and name aren't known.
// A task drawn from the inbox has its pull request and round in review_fix_tasks, not on its job (reviewinbox.ts), and
// the findings it fixes (task); the blocking findings the round's ruling sent back to the author before this fix
// (findings.ts finding_rulings) are `sent`, none for a ruling not acted on. One read for every fix, and one for their
// findings' words. The fixes through db.ts jobs_listed, never their rows.
function fixesOf(jobs: { id: number }[]) {
  const rows = db
    .prepare(
      `select j.id, coalesce(t.pr, j.pr) pr, coalesce(t.round, j.round) round, j.title, j.step, t.findings task,
        (select w.title from jobs w indexed by jobs_work_titles where w.kind in ('work', 'chat') and w.stage is null
        and coalesce(w.branch, 'job/' || w.id) = coalesce(j.branch, 'job/' || j.id) order by w.id limit 1) work,
        (select r.blocking from finding_rulings r join jobs c on c.id = r.ruling
        where c.pr = coalesce(t.pr, j.pr) and c.round = coalesce(t.round, j.round) and c.id < j.id
        order by c.id desc limit 1) sent
      from jobs j indexed by jobs_listed left join review_fix_tasks t on t.job = j.id where j.id in (select value from json_each(?))
      and j.stage = 'fix' and coalesce(t.pr, j.pr) is not null and coalesce(t.round, j.round) is not null`,
    )
    .all(JSON.stringify(jobs.map(j => j.id))) as Fixing[];
  const findingIds = (job: Fixing) => {
    const task = job.task === null ? undefined : (JSON.parse(job.task) as number[]);
    return { task, ids: task ?? (job.sent === null ? [] : (JSON.parse(job.sent) as number[])) };
  };
  const fixing = rows.map(row => ({ row, ...findingIds(row) }));
  const issues = new Map(
    (
      db
        .prepare('select id, issue from findings where id in (select value from json_each(?))')
        .all(JSON.stringify(fixing.flatMap(f => f.ids))) as { id: number; issue: string }[]
    ).map(f => [f.id, f.issue]),
  );
  return new Map(fixing.map(f => [f.row.id, fixOf(f.row, f, issues)]));
}
function fixOf(job: Fixing, { task, ids }: { task?: number[]; ids: number[] }, issues: Map<number, string>) {
  const drawn = [`Fix ${ids.map(id => `finding ${id}`).join(', ')}`, 'Check the review touch-ups'];
  const named = !job.step && job.title !== job.work && !drawn.includes(job.title);
  if (!task && !ids.length && !named) return undefined;
  return {
    round: job.round,
    findings: [...new Set(ids)].sort((a, b) => a - b).flatMap(id => (issues.has(id) ? [plain(issues.get(id))] : [])),
    ...(task && !task.length && { touchups: true }),
    ...(named && { title: job.title }),
  };
}

// GET /api/projects/findings: one review's or ruling's findings, each with what became of it
export function findingsOf(id: number) {
  const job = shownOf([{ id }]).get(id);
  if (!job) return 404;
  return { findings: job.kind === 'review' ? reviewerLines(job) : rulingLines(job) };
}

// (through db.ts jobs_listed, and each one's output only where `read` asks for it: a summary kept needs none.)
const shownOf = (jobs: { id: number }[], read: (id: number) => boolean = () => true) => {
  const rows = db
    .prepare(
      `select id, agent, kind, stage, pr, round, sha from jobs indexed by jobs_listed where id in (select value from json_each(?))
      and status = 'done' and pr is not null and voided is null and (kind = 'review' or ${RULINGS})`,
    )
    .all(JSON.stringify(jobs.map(j => j.id))) as Omit<Shown, 'output'>[];
  const unread = rows.filter(r => read(r.id)).map(r => r.id);
  const outputs = new Map(
    unread.length
      ? (
          db
            .prepare('select id, output from jobs where id in (select value from json_each(?))')
            .all(JSON.stringify(unread)) as { id: number; output: string | null }[]
        ).map(r => [r.id, r.output])
      : [],
  );
  return new Map(rows.map(r => [r.id, { ...r, output: outputs.get(r.id) ?? null }]));
};

// A done job's output never changes, so its summary is kept. None for one that reported no findings or no verdict.
const summaries = new Map<number, ReturnType<typeof countOf>>();
function summaryOf(job: Shown) {
  if (!summaries.has(job.id)) summaries.set(job.id, countOf(job));
  return summaries.get(job.id)!;
}
function countOf(job: Shown) {
  const v = parse(job.output);
  if (job.kind === 'review') {
    if (!Array.isArray(v.findings)) return undefined;
    const reported = told(job);
    return { blocking: reported.filter(f => f.blocking).length, notes: reported.filter(f => !f.blocking).length };
  }
  const touchups = Array.isArray(v.touchups) && v.touchups.length > 0;
  const verdict = v.decision === 'merge' && touchups && job.stage === 'ruling' ? 'changes' : v.decision;
  if (!VERDICTS.includes(verdict as string)) return undefined;
  return {
    verdict: verdict as string,
    blocking: entriesOf(v.blocking).length,
    notes: entriesOf(v.nonblocking).length + entriesOf(v.pre_existing).length,
  };
}

// A reviewer's findings, each with its index in the report as the consolidator was told it (trust.ts weighed): blocking
// as it marked them, unless on code the change doesn't touch (those never block)
function told(job: Shown) {
  const pre = findings.preExisting(findings.changeOf(job.pr, job.sha));
  const list = parse(job.output).findings as unknown[];
  return entriesOf(list).map(f => ({
    entry: f,
    finding: list.indexOf(f),
    issue: plain(f.issue),
    blocking: f.severity === 'blocking' && !pre(f),
  }));
}

// ---- what became of each

// Explicit sources give every reviewer finding a fate, including dropped ones. Older rulings use only unambiguous
// one-to-one place matches. Neither shows a fate before the ruling was acted on. (The ruling acted on, not the first:
// one that couldn't be read stays done beside the retry that replaced it, review.ts retried.)
function reviewerLines(job: Shown): Line[] {
  const ruling = db
    .prepare(
      `select id, agent, kind, stage, pr, round, sha, output from jobs where kind = 'consolidate' and stage = 'ruling'
      and status = 'done' and voided is null and pr = ? and round = ? and id > ?
      and id in (select ruling from finding_rulings) order by id limit 1`,
    )
    .get(job.pr, job.round, job.id) as Shown | undefined;
  const entries = ruling ? ruledEntries(ruling) : [];
  const reported = told(job);
  const explicit = ruling && parse(ruling.output).finding_sources === true;
  if (explicit)
    return reported.map(({ issue, blocking, finding }) => {
      const into = entries.find(r =>
        sourcesOf(r.entry).some(source => source.by === job.agent && source.finding === finding),
      );
      return { issue, blocking, ...(into?.fate ?? { fate: 'dropped' }) };
    });
  const ruled = entries.filter(r => byOf(r.entry).includes(job.agent));
  const into = reported.map(({ entry }) =>
    ruled.filter(r => placesOf(r.entry).some(p => placesOf(entry).some(q => samePlace(p, q)))),
  );
  return reported.map(({ issue, blocking }, i) => {
    const only = into[i].length === 1 && into.filter(rs => rs.includes(into[i][0])).length === 1;
    return { issue, blocking, ...(only && into[i][0].fate) };
  });
}

// A ruling's findings: blocking first, then its notes, each with its fate once the ruling was acted on
const rulingLines = (job: Shown): Line[] =>
  ruledEntries(job).map(({ entry, list, fate }) => ({
    issue: plain(entry.issue),
    blocking: list === 'blocking',
    ...(findings.accepted(job.id) ? fate : {}),
  }));

// A ruling's entries in its lists, each with the finding it was stored as (findings.ts record): one marked "earlier" is
// the finding sent before it, the others take its rows of their kind in order
function ruledEntries(ruling: Shown) {
  const v = parse(ruling.output),
    rows = rowsOf(ruling.pr),
    judged = judgedRounds(ruling.pr);
  const ofRuling = (kinds: string[]) => rows.filter(r => r.ruling === ruling.id && kinds.includes(r.kind));
  const lists = [
    { list: 'blocking', entries: entriesOf(v.blocking), stored: ofRuling(['blocking']) },
    { list: 'nonblocking', entries: entriesOf(v.nonblocking), stored: ofRuling(['nonblocking', 'follow-up']) },
    { list: 'pre_existing', entries: entriesOf(v.pre_existing), stored: ofRuling(['pre-existing']) },
  ];
  return lists.flatMap(({ list, entries, stored }) => {
    let next = 0;
    return entries.map(entry => {
      const earlier =
        list === 'pre_existing' ? undefined : rows.find(r => r.ruling < ruling.id && r.id === Number(entry.earlier));
      const row = earlier ?? stored[next++];
      return { entry, list, fate: row ? fateOf(row, judged) : ({ fate: 'dropped' } as Fate) };
    });
  });
}

const rowsOf = (pr: number) =>
  db
    .prepare(
      `select f.id, f.ruling, f.kind, f.outcome, f.right, coalesce(u.proposal, v.job) proposal from findings f
      left join review_followups u on u.finding = f.id left join review_followup_jobs v on v.finding = f.id
      where f.pr = ? order by f.id`,
    )
    .all(pr) as Row[];

function fateOf(row: Row, judged: Map<number, number>): Fate {
  if (row.proposal !== null) return { fate: 'follow-up' };
  if (row.kind === 'pre-existing' || row.kind === 'follow-up') return { fate: 'later' };
  if (row.outcome === 'fixed') return { fate: 'fixed', round: judged.get(row.id) };
  if (row.outcome === 'kept') return { fate: 'kept' };
  if (row.outcome === 'disputed' && row.right === 'author') return { fate: 'dropped' };
  return { fate: 'open' };
}

// The round whose ruling last judged each finding (its "outcomes")
function judgedRounds(pr: number) {
  const rulings = db
    .prepare(
      `select j.round, j.output from jobs j join finding_rulings r on r.ruling = j.id where j.pr = ? order by j.id`,
    )
    .all(pr) as { round: number; output: string | null }[];
  const rounds = new Map<number, number>();
  for (const r of rulings)
    for (const o of entriesOf(parse(r.output).outcomes))
      rounds.set(Number((o as { finding?: unknown }).finding), r.round);
  return rounds;
}

// ---- model output

const parse = (out: string | null): Record<string, unknown> => {
  try {
    const v = JSON.parse(out ?? '');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
const entriesOf = (list: unknown) =>
  Array.isArray(list) ? (list as unknown[]).filter((e): e is Entry => !!e && typeof e === 'object') : [];
const sourcesOf = (e: Entry): Source[] => e.from as Source[];
const byOf = (e: Entry) => (Array.isArray(e.by) ? (e.by as unknown[]) : []);
const placesOf = (e: Entry): Entry[] => [e, ...entriesOf(e.also)];
// (a place with no line is no place: it would be any finding in its file)
const samePlace = (a: Entry, b: Entry) =>
  typeof a.file === 'string' &&
  typeof b.file === 'string' &&
  (a.file === b.file || a.file.endsWith(`/${b.file}`) || b.file.endsWith(`/${a.file}`)) &&
  Number(a.line) > 0 &&
  Number(b.line) > 0 &&
  Math.abs(Number(a.line) - Number(b.line)) <= NEAR;
// A finding's issue in one line: its first sentence, the reviewer's own words
const plain = (issue: unknown) => {
  const text = String(issue ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? text;
};
