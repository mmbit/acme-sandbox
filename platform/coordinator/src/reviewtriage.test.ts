// node --test src/reviewtriage.test.ts (uses a throwaway DATA_DIR and local GitHub fixture)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { harness, until } from './harness.ts';
import { leftoverJobs, retryNow } from './reviewfixture.ts';

const h = await harness('reviewtriage', {
  before: repo => {
    const file = `${repo}/company/org.yaml`;
    writeFileSync(file, readFileSync(file, 'utf8').replace('consolidator: quill', 'consolidator: [quill, tally, nib]'));
    appendFileSync(
      file,
      '\nreview:\n  visual:\n' +
        '    - { paths: ["platform/hq/renderers/**"], run: "node preview.mjs", look: "lit in the dark", record: "qa/previews" }\n' +
        '\nengineOnly:\n  - { id: pixels, what: pixel work, engine: claude, model: claude-opus-5-5, paths: ["platform/hq/renderers/**"] }\n',
    );
  },
});
await h.worker('seat', { seat: 'codex-1', engine: 'codex', state: 'ready' });
const { db } = h;
const review = await import('./review.ts');
const panel = await import('./panel.ts');
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

async function push(pr: number, next = sha(), more = {}, engine?: string) {
  const author = await h.start({ agent: 'bolt', branch: `review/${pr}`, ...(engine && { engine }) });
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
  retryNow(db, retry.id);
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

test('the looker follows visual files moved by engine constraints, and each reader keeps their lens', async () => {
  const pr = 116,
    room = 'platform/hq/renderers/brownstone/rooms.js',
    readme = 'README.md',
    record = `qa/previews/review-${pr}.md`;
  const read = (agent: string, files: string[], domain = 'hq') => ({ ...reader(agent), files, domain });
  await push(pr, sha(), { files: [room, readme, record] }, 'claude');
  // Codex keeps the code read while the pixel rule hands the visual files and their look to tally.
  await finish(pr, 'triage', {
    ...selection([
      { ...read('nib', [room, readme], 'readability'), reason: 'Read the names' },
      read('tally', [record]),
    ]),
    looker: 'nib',
  });
  assert.deepEqual(readers(pr).sort(), ['nib', 'tally'], 'the triage dispatches without a retry');
  assert.ok(!pending(pr).some(job => job.stage === 'triage'));
  const rows = (await h.board('/api/jobs')).body.filter((job: any) => job.pr === pr && job.kind === 'review');
  assert.equal(rows[0].triage.selection.looker, 'tally');
  assert.deepEqual(rows[0].triage.selection.reviewers.find((read: any) => read.agent === 'nib').files, [readme]);
  assert.deepEqual(rows[0].triage.selection.reviewers.find((read: any) => read.agent === 'tally').files, [
    record,
    room,
  ]);
  const brief = (agent: string) =>
    (
      db
        .prepare("select prompt from jobs where pr = ? and kind = 'review' and agent = ? and status = 'queued'")
        .get(pr, agent) as { prompt: string }
    ).prompt;
  assert.ok(brief('nib').includes('## Your lens: readability') && brief('nib').includes('Read the names'));
  assert.ok(!brief('nib').includes('node preview.mjs'));
  assert.ok(brief('tally').includes('node preview.mjs'));
});

test('triage keeps a valid looker or no looker and refuses a reader with no visual scope', async () => {
  for (const [pr, looker] of [
    [118, 'rook'],
    [119, null],
    [120, 'nib'],
  ] as const) {
    const room = 'platform/hq/renderers/brownstone/rooms.js',
      readme = 'README.md',
      record = `qa/previews/review-${pr}.md`;
    await push(pr, sha(), { files: [room, readme, record] }, 'claude');
    await finish(pr, 'triage', {
      ...selection([
        { ...reader('rook'), files: [room] },
        { ...reader('nib'), files: [readme, record] },
      ]),
      looker,
    });
    if (looker === 'nib') {
      assert.deepEqual(readers(pr), []);
      assert.ok(pending(pr).some(job => job.stage === 'triage'));
    } else {
      assert.deepEqual(readers(pr).sort(), ['nib', 'rook']);
      const rows = (await h.board('/api/jobs')).body.filter((job: any) => job.pr === pr && job.kind === 'review');
      assert.equal(rows[0].triage.selection.looker, looker);
    }
    cancelLeftovers();
  }
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
  retryNow(db, retry.id);
  await finish(pr, 'triage', selection([{ ...reader('rook'), files: [readme] }]));
  assert.deepEqual(readers(pr), ['rook'], 'the fix scope is sufficient without the old pull request files');
});

test('a visual HQ fix rechecks only its co-author finder unless triage explicitly adds another reader', async () => {
  const { head } = await blocked(93);
  h.ended({ agent: 'rook', branch: 'review/93' });
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

test('triage cannot assign a sole author or silently omit a blocker finder, and retries decide nothing', async () => {
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
  retryNow(db, retry.id);
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
  retryNow(db, retry.id);
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

test('triage offers and accepts co-authors when all listed consolidators and the CEO wrote the branch', async () => {
  const authors = ['quill', 'tally', 'nib', 'juno', 'rook'];
  for (const [pr, consolidator, decision] of [
    [105, 'quill', 'review'],
    [106, 'nib', 'review'],
    [107, 'tally', 'escalate'],
  ] as const) {
    for (const agent of authors) h.ended({ agent, branch: `review/${pr}` });
    await push(pr);
    const triage = pending(pr).find(job => job.stage === 'triage')!;
    assert.equal(triage.agent, 'quill');
    const run = await h.claim(triage.engine, { seat: triage.engine === 'codex' ? 'codex-1' : 'claude-1' });
    assert.equal(run?.id, triage.id);
    const offered = JSON.parse(run!.prompt.match(/Eligible consolidators: (\[[^\n]*\])/u)![1]) as string[];
    assert.ok(offered.includes(consolidator));
    assert.ok(offered.every(agent => panel.authorsOf(pr).has(agent)));
    assert.ok(!offered.some(agent => ['poppy', 'rivet', 'unknown'].includes(agent)));
    const output = JSON.stringify({ ...selection([reader('rook')]), decision, consolidator });
    assert.equal((await h.finish(run!, { output })).status, 200);
    await until(() => h.jobs.findJob(run!.id)?.status === 'done', 'co-authored triage completion');
    assert.equal(panel.consolidator(pr), consolidator);
    assert.equal(
      pending(pr).some(job => job.stage === 'triage'),
      false,
    );
    if (decision === 'review') {
      assert.deepEqual(readers(pr), ['rook']);
      await finish(pr, 'review', { findings: [] });
      const ruling = pending(pr).find(job => job.stage === 'ruling')!;
      assert.equal(ruling.agent, consolidator);
    } else {
      assert.equal(
        (db.prepare('select status from prs where number = ?').get(pr) as { status: string }).status,
        'stuck',
      );
      assert.equal(h.github.pr(pr).state, 'open');
    }
    cancelLeftovers();
  }
});

test('triage rejects a sole author as its solo consolidator', async () => {
  const pr = 108;
  await push(pr);
  await finish(pr, 'triage', { ...selection([]), consolidator: 'bolt' });
  assert.deepEqual(readers(pr), []);
  assert.ok(pending(pr).some(job => job.stage === 'triage'));
  assert.ok(!pending(pr).some(job => job.stage === 'ruling'));
  assert.equal(h.github.pr(pr).merged, false);
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
