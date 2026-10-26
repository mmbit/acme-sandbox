// node --test src/reviewrows.test.ts   (uses a throwaway DATA_DIR; GitHub is played by the harness)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { harness, until } from './harness.ts';
import { completeTriage } from './reviewfixture.ts';

// (the shop's owner draws the tasks its reviews' findings make)
const h = await harness('reviewrows', {
  before: repo =>
    writeFileSync(`${repo}/company/projects.yaml`, 'projects:\n  - { id: shop, name: The shop, owner: moss }\n'),
});
const { db, github, worker } = h;
const { withFindings } = await import('./reviewrows.ts');
const projects = await import('./projects.ts');
// (a merge runs on after the route that set it off has answered: a test waits until GitHub has been quiet a moment)
let lastAsked = 0;
github.wait = () => {
  lastAsked = Date.now();
};
const settled = () => until(() => Date.now() - lastAsked >= 25, 'GitHub to go quiet');

const FILE = 'products/pebblet/app/src/server.ts';
type Run = { id: number; agent: string; kind: string; seat: string };
// The worker's seat takes each of PR n's ready jobs of a kind, and ends it with its report
const queued = (n: number, kind: string) =>
  (h.jobs.listJobs() as unknown as (Run & { pr: number; status: string; ready: number })[])
    .filter(j => j.pr === n && j.status === 'queued' && j.ready && j.kind === kind)
    .reverse();
async function claim(n: number, kind: string) {
  const runs: Run[] = [];
  for (const j of queued(n, kind)) {
    const r = (await worker('claim', { seat: 'claude-1', engine: 'claude' })).body;
    assert.equal(r?.id, j.id);
    runs.push({ ...r, seat: 'claude-1' });
  }
  return runs;
}
async function end(run: { id: number; seat: string }, output: object = { summary: 'fine', findings: [] }, more = {}) {
  const report = { job: run.id, seat: run.seat, status: 'done', output: JSON.stringify(output), ...more };
  assert.equal((await worker('finish', report)).status, 200);
  await settled();
}
// The author's job on PR n pushes: the first a new job (in thread, if named), a fix the one queued on its branch
async function push(n: number, thread?: string, sha = randomBytes(20).toString('hex')) {
  const [fix] = queued(n, 'work');
  const job = fix ? (await claim(n, 'work'))[0] : await h.start({ agent: 'bolt', branch: `review/${n}`, thread });
  await end(job, {}, { output: undefined, pr: n, branch: `review/${n}`, files: [FILE], sha });
  // (each round's reviewers are chosen first: one here.)
  await completeTriage(h, n);
  await settled();
}
const listed = async (job: number) => (await h.board(`/api/projects/findings?job=${job}`)).body.findings;
const reported = (line: number, issue: string, severity: string) => ({ file: FILE, line, issue, severity });

test("a review's findings list in its reviewer's first sentence, each with what became of it", async () => {
  const n = 81610;
  await push(n);
  const [first, ...rest] = await claim(n, 'review');
  await end(first, {
    summary: 'two',
    findings: [
      reported(11, 'The fee is counted twice. Every basket with a fee pays it again.', 'blocking'),
      reported(40, 'A name reads oddly.', 'nonblocking'),
    ],
  });
  for (const run of rest) await end(run);
  // (a verdict that can't be read runs again: the retry's ruling is the one that counts)
  const [unread] = await claim(n, 'consolidate');
  await end(unread, { decision: 'perhaps' });
  // (five minutes on, when it runs again: no route moves the clock, review.test.ts later)
  db.prepare("update jobs set not_before = 0 where pr = ? and status = 'queued'").run(n);
  const [ruling] = await claim(n, 'consolidate');
  const fee = {
    file: FILE,
    line: 10,
    issue: 'The fee is counted twice.',
    task: 'Count the fee once',
    by: [first.agent],
    from: [{ by: first.agent, finding: 0 }],
  };
  await end(ruling, { decision: 'changes', major_visual: false, blocking: [fee], nonblocking: [] });
  assert.deepEqual(await listed(first.id), [
    { issue: 'The fee is counted twice.', blocking: true, fate: 'open' },
    // (one the ruling left out shows none: a ruling's entries don't say which findings they stand for)
    { issue: 'A name reads oddly.', blocking: false },
  ]);
  const { id } = db.prepare('select id from findings where pr = ?').get(n) as { id: number };
  await push(n);
  for (const run of await claim(n, 'review')) await end(run);
  const [again] = await claim(n, 'consolidate');
  await end(again, {
    decision: 'merge',
    major_visual: false,
    blocking: [],
    outcomes: [{ finding: id, outcome: 'fixed' }],
  });
  const fixed = { issue: 'The fee is counted twice.', blocking: true, fate: 'fixed', round: 2 };
  assert.deepEqual((await listed(first.id))[0], fixed);
  assert.deepEqual(await listed(ruling.id), [fixed]);
});

test("a reviewer's finding shows a fate only where it is the one finding at one entry", async () => {
  const n = 81611;
  await push(n);
  const [first, ...rest] = await claim(n, 'review');
  await end(first, {
    summary: 'five',
    findings: [
      reported(10, 'The fee is counted twice.', 'blocking'),
      reported(12, 'The total rounds down.', 'blocking'),
      { ...reported(20, 'The basket keeps a stale price.', 'blocking'), also: [{ file: FILE, line: 40 }] },
      { file: FILE, issue: 'The file has no tests.', severity: 'blocking' },
      reported(60, 'A refund skips the fee.', 'blocking'),
    ],
  });
  for (const run of rest) await end(run);
  const [ruling] = await claim(n, 'consolidate');
  const kept = (line: number, issue: string) => ({ file: FILE, line, issue, task: `Fix: ${issue}`, by: [first.agent] });
  await end(ruling, {
    decision: 'changes',
    major_visual: false,
    blocking: [kept(10, 'The fee is counted twice.'), kept(40, 'A stale price.'), kept(60, 'A refund skips the fee.')],
  });
  assert.deepEqual(await listed(first.id), [
    // two findings near one entry: which one it kept isn't known (case A)
    { issue: 'The fee is counted twice.', blocking: true },
    { issue: 'The total rounds down.', blocking: true },
    // kept at the place it also named (case B)
    { issue: 'The basket keeps a stale price.', blocking: true, fate: 'open' },
    // a place with no line is none
    { issue: 'The file has no tests.', blocking: true },
    { issue: 'A refund skips the fee.', blocking: true, fate: 'open' },
  ]);
});

test('explicit sources give same-place findings separate fates and follow a moved merged class', async () => {
  const n = 85650;
  await push(n);
  const [first, ...rest] = await claim(n, 'review');
  await end(first, {
    findings: [
      reported(10, 'The fee is counted twice.', 'blocking'),
      reported(10, 'The total rounds down.', 'blocking'),
      reported(60, 'The refund counts the fee twice.', 'blocking'),
    ],
  });
  for (const run of rest) await end(run);
  assert.deepEqual(
    (await listed(first.id)).map((f: { fate?: string }) => f.fate),
    [undefined, undefined, undefined],
  );
  const [ruling] = await claim(n, 'consolidate');
  await end(ruling, {
    decision: 'changes',
    major_visual: false,
    finding_sources: true,
    blocking: [
      {
        file: FILE,
        line: 100,
        issue: 'Fees are counted twice.',
        task: 'Count fees once',
        by: [first.agent],
        from: [
          { by: first.agent, finding: 0 },
          { by: first.agent, finding: 2 },
        ],
      },
    ],
  });
  assert.deepEqual(await listed(first.id), [
    { issue: 'The fee is counted twice.', blocking: true, fate: 'open' },
    { issue: 'The total rounds down.', blocking: true, fate: 'dropped' },
    { issue: 'The refund counts the fee twice.', blocking: true, fate: 'open' },
  ]);
  const { id } = db.prepare('select id from findings where pr = ?').get(n) as { id: number };
  await push(n);
  for (const run of await claim(n, 'review')) await end(run);
  const [again] = await claim(n, 'consolidate');
  await end(again, {
    decision: 'merge',
    major_visual: false,
    blocking: [],
    outcomes: [{ finding: id, outcome: 'fixed' }],
  });
  assert.deepEqual(await listed(first.id), [
    { issue: 'The fee is counted twice.', blocking: true, fate: 'fixed', round: 2 },
    { issue: 'The total rounds down.', blocking: true, fate: 'dropped' },
    { issue: 'The refund counts the fee twice.', blocking: true, fate: 'fixed', round: 2 },
  ]);
});

test('an explicit ruling that retains no entries drops every reviewer finding', async () => {
  const n = 85651;
  await push(n);
  const [first, ...rest] = await claim(n, 'review');
  await end(first, { findings: [reported(10, 'The total rounds down.', 'blocking')] });
  for (const run of rest) await end(run);
  const [ruling] = await claim(n, 'consolidate');
  await end(ruling, {
    decision: 'merge',
    major_visual: false,
    finding_sources: true,
    blocking: [],
    nonblocking: [],
    pre_existing: [],
  });
  assert.deepEqual(await listed(first.id), [{ issue: 'The total rounds down.', blocking: true, fate: 'dropped' }]);
});

test("explicit sources count a reviewer's findings by their place in its report, entries that aren't findings too", async () => {
  const n = 85652;
  await push(n);
  const [first, ...rest] = await claim(n, 'review');
  await end(first, {
    findings: [
      null,
      reported(10, 'The fee is counted twice.', 'blocking'),
      reported(60, 'The total rounds down.', 'blocking'),
    ],
  });
  for (const run of rest) await end(run);
  const [ruling] = await claim(n, 'consolidate');
  await end(ruling, {
    decision: 'changes',
    major_visual: false,
    finding_sources: true,
    blocking: [
      {
        file: FILE,
        line: 10,
        issue: 'The fee is counted twice.',
        task: 'Count the fee once',
        by: [first.agent],
        from: [{ by: first.agent, finding: 1 }],
      },
    ],
  });
  assert.deepEqual(await listed(first.id), [
    { issue: 'The fee is counted twice.', blocking: true, fate: 'open' },
    { issue: 'The total rounds down.', blocking: true, fate: 'dropped' },
  ]);
});

const invalidSources: { name: string; field: string; from?: (by: string) => unknown; duplicate?: boolean }[] = [
  { name: 'missing blocking sources', field: 'blocking' },
  { name: 'missing nonblocking sources', field: 'nonblocking' },
  { name: 'missing pre-existing sources', field: 'pre_existing' },
  { name: 'a case-origin label as sources', field: 'pre_existing', from: () => 'outside' },
  { name: 'a string finding index', field: 'blocking', from: by => [{ by, finding: '1' }] },
  { name: 'a fractional finding index', field: 'nonblocking', from: by => [{ by, finding: 1.5 }] },
  { name: 'a negative finding index', field: 'blocking', from: by => [{ by, finding: -1 }] },
  { name: 'an index past the report', field: 'blocking', from: by => [{ by, finding: 3 }] },
  { name: 'an index naming no finding', field: 'blocking', from: by => [{ by, finding: 0 }] },
  { name: 'a reviewer outside the panel', field: 'blocking', from: () => [{ by: 'outsider', finding: 1 }] },
  { name: 'a missing reviewer', field: 'blocking', from: () => [{ finding: 1 }] },
  { name: 'a null source', field: 'blocking', from: () => [null] },
  {
    name: 'a repeated source in an entry',
    field: 'blocking',
    from: by => [
      { by, finding: 1 },
      { by, finding: 1 },
    ],
  },
  { name: 'a repeated source across lists', field: 'nonblocking', from: by => [{ by, finding: 1 }], duplicate: true },
];
for (const [index, invalid] of invalidSources.entries()) {
  test(`a ruling with ${invalid.name} decides nothing and its replacement supplies the fates`, async () => {
    const n = 87770 + index;
    await push(n);
    const [first, ...rest] = await claim(n, 'review');
    await end(first, {
      findings: [
        null,
        reported(10, 'The fee is counted twice.', 'blocking'),
        reported(60, 'The total rounds down.', 'blocking'),
      ],
    });
    for (const run of rest) await end(run);
    const [ruling] = await claim(n, 'consolidate');
    const source = { by: first.agent, finding: 1 };
    const entry = {
      file: FILE,
      line: 10,
      issue: 'The fee is counted twice.',
      task: 'Count the fee once',
      by: [first.agent],
      from: [source],
    };
    await end(ruling, {
      decision: 'changes',
      major_visual: false,
      finding_sources: true,
      blocking: [invalid.duplicate ? entry : { ...entry, from: [] }],
      [invalid.field]: [{ ...entry, from: invalid.from?.(first.agent) }],
    });
    assert.deepEqual(await listed(first.id), [
      { issue: 'The fee is counted twice.', blocking: true },
      { issue: 'The total rounds down.', blocking: true },
    ]);
    assert.equal(queued(n, 'work').length, 0);
    assert.equal((db.prepare('select count(*) n from findings where pr = ?').get(n) as { n: number }).n, 0);
    const review = await import('./review.ts');
    await review.actOnRulings();
    db.prepare("update jobs set not_before = 0 where pr = ? and status = 'queued'").run(n);
    const [replacement] = await claim(n, 'consolidate');
    assert.ok(replacement, 'the invalid ruling is retried');
    await end(replacement, {
      decision: 'changes',
      major_visual: false,
      finding_sources: true,
      blocking: [entry],
      nonblocking: [{ ...entry, line: 100, from: [] }],
      pre_existing: [{ ...entry, line: 200, from: [] }],
    });
    assert.deepEqual(await listed(first.id), [
      { issue: 'The fee is counted twice.', blocking: true, fate: 'open' },
      { issue: 'The total rounds down.', blocking: true, fate: 'dropped' },
    ]);
  });
}

test('a rejected ruling keeps its own reports when its round restarts on the same commit', async () => {
  const n = 88460;
  await push(n);
  const [first, ...rest] = await claim(n, 'review');
  await end(first, { findings: [reported(10, 'The fee is counted twice.', 'blocking')] });
  for (const run of rest) await end(run);
  const rejected = {
    decision: 'changes',
    major_visual: false,
    finding_sources: true,
    blocking: [
      {
        file: FILE,
        line: 10,
        issue: 'The fee is counted twice.',
        task: 'Count the fee once',
        from: [{ by: first.agent, finding: 1 }],
      },
    ],
  };
  await end((await claim(n, 'consolidate'))[0], rejected);
  db.prepare("update jobs set not_before = 0 where pr = ? and status = 'queued'").run(n);
  await end((await claim(n, 'consolidate'))[0], rejected);
  const before = db.prepare('select sha, round, status from prs where number = ?').get(n) as {
    sha: string;
    round: number;
    status: string;
  };
  assert.equal(before.status, 'stuck');
  await push(n, undefined, before.sha);
  const review = await import('./review.ts');
  await review.actOnRulings();
  assert.deepEqual(
    { ...db.prepare('select round, status from prs where number = ?').get(n) },
    {
      round: before.round,
      status: 'open',
    },
  );
  assert.equal(queued(n, 'review').length, 1);
  assert.equal(github.pr(n).state, 'open');
  const [fresh, ...others] = await claim(n, 'review');
  await end(fresh, {
    findings: [
      reported(10, 'The fee is counted twice.', 'blocking'),
      reported(60, 'The total rounds down.', 'blocking'),
    ],
  });
  for (const run of others) await end(run);
  await review.actOnRulings();
  assert.deepEqual(await listed(first.id), [{ issue: 'The fee is counted twice.', blocking: true }]);
  await push(n, undefined, before.sha);
  assert.deepEqual(
    { ...db.prepare('select round, status from prs where number = ?').get(n) },
    {
      round: before.round,
      status: 'open',
    },
  );
  assert.deepEqual(queued(n, 'review'), [], 'a push of the commit its panel read leaves the round as it is');
  const [ruling] = await claim(n, 'consolidate');
  assert.ok(ruling, 'the new reports still need their own ruling');
  await end(ruling, { decision: 'merge', major_visual: false, finding_sources: true, blocking: [] });
  assert.deepEqual(await listed(fresh.id), [
    { issue: 'The fee is counted twice.', blocking: true, fate: 'dropped' },
    { issue: 'The total rounds down.', blocking: true, fate: 'dropped' },
  ]);
});

test('a fix round says what it fixes: the findings its ruling sent back', async () => {
  const n = 81920;
  await push(n);
  const [first, ...rest] = await claim(n, 'review');
  await end(first, { summary: 'one', findings: [reported(11, 'The fee is counted twice. Twice.', 'blocking')] });
  for (const run of rest) await end(run);
  const [ruling] = await claim(n, 'consolidate');
  await end(ruling, {
    decision: 'changes',
    major_visual: false,
    blocking: [{ file: FILE, line: 11, issue: 'The fee is counted twice.', task: 'Count the fee once' }],
  });
  // the round's fix, under the task its ruling named: the findings it sent back
  assert.deepEqual(fixesOf(queued(n, 'work')[0].id), {
    round: 1,
    findings: ['The fee is counted twice.'],
    title: 'Count the fee once',
  });
  // a fix outside a round says its step
  const update = h.queue({ agent: 'bolt', stage: 'fix', step: 'Bringing up to date', pr: n, branch: `review/${n}` });
  assert.equal(fixesOf(update), undefined);
});

// Tasks drawn from a ruling's findings in the owner's inbox, as the owner draws them (hq inbox accept, hq job
// --findings): by the title HQ draws them with, named, and checking the review's own edits.
test("a task drawn from the inbox says what it fixes: its findings, or its own name, never HQ's title", async () => {
  // a ruling's findings in the shop's thread, for its owner to draw
  const rule = async (n: number, slug: string, ruling: object) => {
    projects.createThread({ project: 'shop', name: `Fee ${slug}`, goal: `The fee is ${slug}`, slug });
    await push(n, `shop/${slug}`);
    const [first, ...rest] = await claim(n, 'review');
    await end(first, { summary: 'one', findings: [reported(11, 'The fee is counted twice. Twice.', 'blocking')] });
    for (const run of rest) await end(run);
    const [consolidate] = await claim(n, 'consolidate');
    await end(consolidate, ruling);
    assert.equal(queued(n, 'work').length, 0); // (none drawn for it: the owner draws them)
  };
  const fee = { file: FILE, line: 11, issue: 'The fee is counted twice.', task: 'Count the fee once' };
  await rule(85670, 'counted', { decision: 'changes', major_visual: false, blocking: [fee] });
  await rule(85671, 'touched', { decision: 'changes', major_visual: false, blocking: [], nonblocking: [fee] });
  const [id] = (db.prepare('select id from findings where pr = 85670').all() as { id: number }[]).map(f => f.id);
  const owner = await h.start({ agent: 'moss', title: 'Draw the fixes' });
  const drawn = async (reply: Promise<{ status: number; body: { job?: number; id?: number } }>) => {
    const { status, body } = await reply;
    assert.equal(status, 200, JSON.stringify(body));
    return fixesOf(body.job ?? body.id!);
  };
  const accept = (n: number, findings?: string, title?: string) =>
    drawn(h.agent('proposals/accept', owner.token, { id: `findings:${n}`, for: 'bolt', findings, title }));
  // (under the task the reviewer named)
  assert.deepEqual(await accept(85670, String(id)), {
    round: 1,
    findings: ['The fee is counted twice.'],
    title: 'Count the fee once',
  });
  h.cancelQueued();
  const named = h.agent('job', owner.token, {
    agent: 'bolt',
    title: 'Count the fee once',
    prompt: 'Count it once',
    thread: 'shop/counted',
    findings: String(id),
  });
  assert.deepEqual(await drawn(named), {
    round: 1,
    findings: ['The fee is counted twice.'],
    title: 'Count the fee once',
  });
  // (no touch-ups named by the reviewer: the accepter names the check.)
  assert.deepEqual(await accept(85671, undefined, 'Check the review touch-ups'), {
    round: 1,
    findings: [],
    touchups: true,
  });
});

// A fix job's row as the board's view reads it: what it fixes
function fixesOf(job: number) {
  const listed = h.jobs.listJobs().filter(j => j.id === job) as unknown as {
    id: number;
    kind: string;
    status: string;
    pr: number;
    stage: string;
  }[];
  return withFindings(listed)[0]?.fixes;
}
