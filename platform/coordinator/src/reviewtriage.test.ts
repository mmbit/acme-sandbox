// node --test src/reviewtriage.test.ts (uses a throwaway DATA_DIR and local GitHub fixture)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { harness, until } from './harness.ts';
import { leftoverJobs } from './reviewfixture.ts';

const h = await harness('reviewtriage', {
  before: repo => {
    const file = `${repo}/company/org.yaml`;
    writeFileSync(file, readFileSync(file, 'utf8').replace('consolidator: quill', 'consolidator: [quill, tally, nib]'));
  },
});
await h.worker('seat', { seat: 'codex-1', engine: 'codex', state: 'ready' });
const { db } = h;
const review = await import('./review.ts');
const files = ['platform/hq/room.js'];
const sha = () => randomBytes(20).toString('hex');
const pending = (pr: number) => h.jobs.listJobs().filter(job => job.pr === pr && job.status === 'queued');
const readers = (pr: number) =>
  pending(pr)
    .filter(job => job.kind === 'review')
    .map(job => job.agent);
const reader = (agent: string, reason = 'Read the changed behavior') => ({
  agent,
  reason,
  files,
  domain: 'hq',
  security: false,
});
const selection = (reviewers?: ReturnType<typeof reader>[]) => ({
  decision: 'review',
  reason: 'Read the actual diff',
  consolidator: 'quill',
  ...(reviewers && { reviewers }),
});
const cancelLeftovers = leftoverJobs(db);
afterEach(cancelLeftovers);

async function push(pr: number, next = sha(), more = {}) {
  const author = await h.start({ agent: 'bolt', branch: `review/${pr}` });
  assert.equal((await h.finish(author, { pr, branch: `review/${pr}`, files, sha: next, ...more })).status, 200);
  await until(() => pending(pr).some(job => job.stage === 'triage'), 'round triage');
  return next;
}

async function finish(pr: number, stage: string, output: object) {
  const queued = pending(pr).find(job => job.stage === stage)!;
  assert.ok(queued, `a ${stage} is queued`);
  const run = await h.claim(queued.engine, { seat: queued.engine === 'codex' ? 'codex-1' : 'claude-1' });
  assert.equal(run?.id, queued.id);
  assert.equal((await h.finish(run!, { output: JSON.stringify(output) })).status, 200);
  await until(() => h.jobs.findJob(run!.id)?.status === 'done', 'job completion');
  return run!;
}

async function blocked(pr: number, note = false) {
  const head = await push(pr);
  await finish(pr, 'triage', selection([reader('rook')]));
  await until(() => readers(pr).length === 1, 'selected reviewer');
  await finish(pr, 'review', { findings: [{ file: files[0], line: 5, issue: 'The label is hidden' }] });
  await until(() => pending(pr).some(job => job.stage === 'ruling'), 'ruling');
  const ruling = await finish(pr, 'ruling', {
    decision: 'changes',
    blocking: [{ file: files[0], line: 5, issue: 'The label is hidden', by: ['rook'] }],
    nonblocking: note ? [{ file: files[0], line: 6, issue: 'A naming suggestion', by: ['rook'] }] : [],
  });
  await until(() => db.prepare('select 1 from findings where ruling = ?').get(ruling.id), 'recorded blocker');
  cancelLeftovers();
  const finding = db.prepare('select id from findings where ruling = ?').get(ruling.id) as { id: number };
  return { head, finding: finding.id };
}

test('the recorded triage decision chooses the readers, independent of paths or panel size', async () => {
  for (const [pr, agents] of [
    [91, ['rook']],
    [92, ['tally', 'nib']],
  ] as const) {
    await push(pr);
    assert.deepEqual(readers(pr), []);
    await finish(pr, 'triage', selection(agents.map(agent => reader(agent))));
    await until(() => readers(pr).length === agents.length, 'triage dispatch');
    assert.deepEqual(readers(pr).sort(), [...agents].sort());
    const rows = (await h.board('/api/jobs')).body.filter((job: any) => job.pr === pr && job.kind === 'review');
    assert.equal(rows.length, agents.length);
    assert.equal(rows[0].triage.selection.reason, 'Read the actual diff');
    assert.deepEqual(
      rows[0].triage.selection.reviewers.map((read: any) => read.agent),
      agents,
    );
    cancelLeftovers();
  }
});

test('triage rejects a panel that leaves part of its assigned diff unread', async () => {
  const pr = 102,
    checkout = 'kits/payments/checkout.ts',
    readme = 'README.md';
  await push(pr, sha(), { files: [checkout, readme] });
  await finish(pr, 'triage', selection([{ ...reader('rook'), files: [readme] }]));
  assert.deepEqual(readers(pr), []);
  assert.equal(h.github.pr(pr).merged, false);
  const retry = pending(pr).find(job => job.stage === 'triage');
  assert.ok(retry, 'incomplete coverage retries triage before dispatch');
  db.prepare('update jobs set not_before = 0 where id = ?').run(retry.id);
  await finish(
    pr,
    'triage',
    selection([
      { ...reader('rook'), files: [readme] },
      { ...reader('nib'), files: [checkout] },
    ]),
  );
  assert.deepEqual(readers(pr).sort(), ['nib', 'rook']);
});

test('fix-round coverage uses the supplied fix scope instead of the whole pull request', async () => {
  const pr = 103,
    readme = 'README.md';
  const { head } = await blocked(pr);
  await push(pr, sha(), { files: [...files, readme], pushedSince: { sha: head, files: [readme] } });
  await finish(pr, 'triage', selection([reader('rook')]));
  assert.deepEqual(readers(pr), [], 'the old blocker file does not cover the changed readme');
  const retry = pending(pr).find(job => job.stage === 'triage');
  assert.ok(retry);
  db.prepare('update jobs set not_before = 0 where id = ?').run(retry.id);
  await finish(pr, 'triage', selection([{ ...reader('rook'), files: [readme] }]));
  assert.deepEqual(readers(pr), ['rook'], 'the fix scope is sufficient without the old pull request files');
});

test('a visual HQ fix rechecks only its finder unless triage explicitly adds another reader', async () => {
  const { head } = await blocked(93);
  await push(93, sha(), { pushedSince: { sha: head, files } });
  await finish(93, 'triage', selection());
  await until(() => readers(93).length > 0, 'finder recheck');
  assert.deepEqual(readers(93), ['rook']);
  const run = await h.claim('claude', { seat: 'claude-1' });
  assert.ok(run!.prompt.includes(head));
  assert.ok(run!.prompt.includes('caused_by'));
  await h.finish(run!, { output: JSON.stringify({ findings: [] }) });

  cancelLeftovers();
  await push(93);
  await finish(
    93,
    'triage',
    selection([reader('rook'), { ...reader('nib', 'Fix introduces unescaped outside text'), security: true }]),
  );
  await until(() => readers(93).length === 2, 'named added risk read');
  assert.deepEqual(readers(93).sort(), ['nib', 'rook']);
});

test('triage cannot assign an author or silently omit a blocker finder, and retries decide nothing', async () => {
  await blocked(94);
  await push(94);
  const invalid = await finish(94, 'triage', selection([reader('bolt')]));
  await until(() => pending(94).some(job => job.stage === 'triage'), 'invalid triage retry');
  await review.reviewFinished({
    ...invalid,
    kind: 'consolidate',
    status: 'done',
    pr: 94,
    round: 2,
    branch: 'review/94',
    sha: invalid.sha,
  });
  assert.equal((db.prepare('select status from prs where number = 94').get() as { status: string }).status, 'open');
  assert.deepEqual(readers(94), []);
  assert.equal(h.github.pr(94).merged, false);
  const retry = pending(94).find(job => job.stage === 'triage')!;
  db.prepare('update jobs set not_before = 0 where id = ?').run(retry.id);
  await finish(94, 'triage', selection([reader('tally')]));
  await until(
    () => (db.prepare('select status from prs where number = 94').get() as { status: string }).status === 'stuck',
    'invalid triage hold',
  );
  assert.deepEqual(readers(94), []);
});

test('a superseded triage cannot dispatch readers for a new head and duplicate completion dispatches once', async () => {
  await push(95);
  const queued = pending(95).find(job => job.stage === 'triage')!;
  const old = await h.claim(queued.engine, { seat: queued.engine === 'codex' ? 'codex-1' : 'claude-1' });
  await push(95);
  await h.finish(old!, { output: JSON.stringify(selection([reader('tally')])) });
  assert.deepEqual(readers(95), []);
  const fresh = await finish(95, 'triage', selection([reader('rook')]));
  await until(() => readers(95).length === 1, 'fresh readers');
  await review.reviewFinished({
    ...fresh,
    kind: 'consolidate',
    status: 'done',
    pr: 95,
    round: 1,
    branch: 'review/95',
    sha: fresh.sha,
  });
  assert.deepEqual(readers(95), ['rook']);
});

test('triage can stop another panel for an owner decision without closing the pull request', async () => {
  await push(96);
  await finish(96, 'triage', {
    ...selection(),
    decision: 'escalate',
    reason: 'Repeated fixes need an owner scope decision',
  });
  await until(
    () => (db.prepare('select status from prs where number = 96').get() as { status: string }).status === 'stuck',
    'owner decision hold',
  );
  assert.deepEqual(readers(96), []);
  assert.equal(h.github.pr(96).state, 'open');
  await until(() => (db.prepare('select count(*) n from proposals').get() as { n: number }).n > 0, 'owner inbox');
});

test('a new fix-round blocker without a regression cause decides nothing and an unrelated note goes to follow-ups', async () => {
  const { head, finding } = await blocked(97, true);
  const next = await push(97, sha(), { pushedSince: { sha: head, files } });
  h.github.pr(97).head = next;
  await finish(97, 'triage', {
    ...selection([]),
    exceptions: [{ agent: 'rook', reason: 'The finder delegated this read to the consolidator' }],
  });
  await until(() => pending(97).some(job => job.stage === 'ruling'), 'solo ruling');
  await finish(97, 'ruling', {
    decision: 'changes',
    outcomes: [{ finding, outcome: 'fixed' }],
    blocking: [{ file: files[0], line: 12, issue: 'An unrelated problem' }],
  });
  assert.equal(
    (db.prepare('select outcome from findings where id = ?').get(finding) as { outcome: string | null }).outcome,
    null,
  );
  assert.equal(h.github.pr(97).merged, false);
  const retry = pending(97).find(job => job.stage === 'ruling')!;
  assert.ok(retry, 'the ruling retries, independently of triage');
  db.prepare('update jobs set not_before = 0 where id = ?').run(retry.id);
  await finish(97, 'ruling', {
    decision: 'merge',
    outcomes: [{ finding, outcome: 'fixed' }],
    blocking: [],
    nonblocking: [{ file: files[0], line: 12, issue: 'An unrelated problem' }],
  });
  await until(() => h.github.pr(97).merged, 'merge after blocker fix');
  assert.equal(
    (db.prepare("select kind from findings where pr = 97 and issue = 'An unrelated problem'").get() as { kind: string })
      .kind,
    'follow-up',
  );
  await until(
    () =>
      (db.prepare("select count(*) n from proposals where brief like '%A naming suggestion%'").get() as { n: number })
        .n > 0,
    'the optional first-round note reaches follow-ups without another outcome',
  );
});

test('a newly discovered secret blocks a fix round without a regression cause', async () => {
  const pr = 104;
  const { head, finding } = await blocked(pr);
  await push(pr, sha(), { lines: { [files[0]]: [[5, 5]] }, pushedSince: { sha: head, files } });
  await finish(pr, 'triage', selection());
  const secret = { file: files[0], line: 200, issue: 'A credential is committed', secret: true, by: ['rook'] };
  await finish(pr, 'review', { findings: [secret] });
  const ruling = pending(pr).find(job => job.stage === 'ruling')!;
  const { prompt } = db.prepare('select prompt from jobs where id = ?').get(ruling.id) as { prompt: string };
  const report = JSON.parse(prompt.split('### rook\n')[1].split('\n')[0]);
  assert.deepEqual(
    report.findings.map((finding: { secret?: boolean }) => finding.secret),
    [true],
    'the untouched secret remains in the blocking review',
  );
  assert.equal(report.pre_existing, undefined);
  await finish(pr, 'ruling', {
    decision: 'changes',
    outcomes: [{ finding, outcome: 'fixed' }],
    blocking: [secret],
  });
  assert.equal(
    (db.prepare('select outcome from findings where id = ?').get(finding) as { outcome: string }).outcome,
    'fixed',
  );
  assert.equal(
    (db.prepare('select kind from findings where pr = ? and issue = ?').get(pr, secret.issue) as { kind: string }).kind,
    'blocking',
  );
  assert.equal(
    pending(pr).some(job => job.stage === 'ruling'),
    false,
    'the security ruling is accepted',
  );
  assert.equal(h.github.pr(pr).merged, false);
  assert.ok(
    pending(pr).some(job => job.kind === 'work'),
    'the secret reaches the author for repair',
  );
});

test('the ruling sweep recovers a completed triage whose dispatch was lost', async () => {
  const author = h.ended({ agent: 'bolt' });
  const head = sha();
  h.storedPr(98, author, 'open', files, { sha: head, round: 1, since: author });
  const job = h.ended({
    agent: 'quill',
    kind: 'consolidate',
    pr: 98,
    round: 1,
    sha: head,
    branch: `job/${author}`,
    stage: 'triage',
    judges: files,
  });
  // A shared historical fixture records the worker's completed output without invoking its lost handoff.
  const { completedTriage } = await import('./reviewfixture.ts');
  completedTriage(db, job, selection([reader('rook')]));
  await review.actOnRulings();
  assert.deepEqual(readers(98), ['rook']);
  await review.actOnRulings();
  assert.deepEqual(readers(98), ['rook']);
});

test('the triage chooses the eligible consolidator and its actual engine for the ruling', async () => {
  for (const [pr, agent, engine] of [
    [99, 'tally', 'claude'],
    [100, 'nib', 'codex'],
  ] as const) {
    await push(pr);
    await finish(pr, 'triage', { ...selection([]), consolidator: agent });
    const ruling = pending(pr).find(job => job.stage === 'ruling')!;
    assert.deepEqual([ruling.agent, ruling.engine], [agent, engine]);
    cancelLeftovers();
  }
});

test('a newly triaged ruling cannot replace its panel with another triage read', async () => {
  await push(101);
  await finish(101, 'triage', selection([]));
  await finish(101, 'ruling', { decision: 'panel', summary: 'Read again' });
  assert.equal(pending(101).filter(job => job.stage === 'triage').length, 0);
  assert.equal(pending(101).filter(job => job.stage === 'ruling').length, 1);
  assert.deepEqual(readers(101), []);
  assert.equal(h.github.pr(101).merged, false);
});
