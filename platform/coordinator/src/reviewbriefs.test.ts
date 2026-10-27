// node --test src/reviewbriefs.test.ts   (a throwaway database): review runs' briefs go a week after their pull request
// settled, their findings and reports stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const { db, pastJob, queue, storedPr } = await harness('reviewbriefs', { serve: false });
const reviewBriefs = await import('./reviewbriefs.ts');

const DAY = 86_400_000;
const brief = (kind: string) => `The brief of a ${kind} run. `.repeat(400);
// the author's work job, whose pull request the review runs are about
const pr = (number: number, status: string) => storedPr(number, pastJob({}), status);
const add = (kind: string, status: string, n: number, finished: number) =>
  pastJob({ kind, status, pr: n, finished, prompt: brief(kind), output: '{"findings":[]}', result: 'Read it.' });
const row = (id: number) =>
  db.prepare('select prompt, output, result from jobs where id = ?').get(id) as {
    prompt: string;
    output: string;
    result: string;
  };

test("a settled pull request's review runs lose their briefs a week after they ended; an open one's, a newer one's and work's keep theirs", () => {
  const now = Date.now();
  pr(1, 'merged');
  pr(2, 'closed');
  pr(3, 'open');
  pr(4, 'stuck');
  const gone = [
    add('review', 'done', 1, now - 8 * DAY),
    add('consolidate', 'done', 1, now - 9 * DAY),
    add('review', 'failed', 2, now - 30 * DAY),
  ];
  const stay = [
    add('review', 'done', 1, now - 6 * DAY), // ended within the week
    add('consolidate', 'done', 3, now - 20 * DAY), // its pull request still open
    add('review', 'done', 4, now - 20 * DAY),
    add('work', 'done', 1, now - 20 * DAY), // the author's own work: its brief is what estimates match on
    queue({ agent: 'quill', kind: 'review', pr: 2, prompt: brief('review') }),
  ];
  reviewBriefs.sweep(now);
  for (const id of gone) {
    const j = row(id);
    assert.equal(j.prompt, '', `job #${id}'s brief is gone`);
    assert.equal(j.output, '{"findings":[]}', `job #${id}'s findings stay`);
    assert.equal(j.result, 'Read it.', `job #${id}'s report stays`);
  }
  for (const id of stay) assert.notEqual(row(id).prompt, '', `job #${id}'s brief stays`);
});
