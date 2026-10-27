// The briefs HQ writes for a pull request's review runs: each triage's, reviewer's and ruling's prompt (review.ts), the
// review's instructions with the push's checks and, for a ruling, every reviewer's report in it. About a thousand a day,
// each some 10 KB and more, kept forever: by their count and size most of the jobs table's 25 MB a day (21 to 27
// October), which the off-site backup's nightly copy of the whole database carried (infra/backup.py). Nothing reads one
// again once its pull request is settled: a retry or a retriage reads its own round's while the pull request is open.
// A week after such a run finished on a merged or closed pull request, its brief goes (an empty prompt); its findings
// and ruling (output) and its report (result) stay.
import { db } from './db.ts';

const KEEP_DAYS = 7;
// (a few hundred a minute, each a short write: the sweeps after a start on an older database catch up in an hour or two)
const BATCH = 200;

// The briefs still kept, by their pull request: what the sweep reads, without a row or its brief. SQLite checks the
// query's kind and prompt terms again on each entry, so the index holds them too ("prompt != ''", always true here),
// else each would read a kept brief whole.
db.exec(`create index if not exists jobs_review_briefs on jobs (pr, status, finished, kind, prompt != '')
  where kind in ('review', 'consolidate') and prompt != ''`);

export function sweep(now = Date.now()) {
  db.prepare(
    `update jobs set prompt = '' where id in (select j.id from jobs j indexed by jobs_review_briefs
      join prs p on p.number = j.pr
      where j.kind in ('review', 'consolidate') and j.prompt != '' and j.status in ('done', 'failed', 'stopped', 'cancelled')
        and j.finished < ? and p.status in ('merged', 'closed')
      limit ${BATCH})`,
  ).run(new Date(now - KEEP_DAYS * 86_400_000).toISOString());
}
