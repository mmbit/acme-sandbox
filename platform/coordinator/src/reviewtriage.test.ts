// node --test src/reviewtriage.test.ts (uses a throwaway DATA_DIR and local GitHub fixture)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { harness, until } from './harness.ts';
import { leftoverJobs, retryNow } from './reviewfixture.ts';
import * as reviewrefusals from './reviewrefusals.ts';

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
await h.worker('seat', { seat: 'claude-1', engine: 'claude', state: 'ready' });
const { db } = h;
const review = await import('./review.ts');
const panel = await import('./panel.ts');
const reviewtriage = await import('./reviewtriage.ts');
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

async function push(
  pr: number,
  next = sha(),
  more = {},
  work: { agent?: string; engine?: string; thread?: string } = {},
) {
  const author = await h.start({ agent: 'bolt', branch: `review/${pr}`, ...work });
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

async function blocked(pr: number, note = false, finder = 'rook', agent = 'bolt') {
  const head = await push(pr, sha(), {}, { agent });
  await finish(pr, 'triage', selection([reader(finder)]));
  await until(() => readers(pr).length === 1, 'selected reviewer');
  await finish(pr, 'review', { findings: [{ file: files[0], line: 5, issue: 'The label is hidden' }] });
  await until(() => pending(pr).some(job => job.stage === 'ruling'), 'ruling');
  const ruling = await finish(pr, 'ruling', {
    decision: 'changes',
    blocking: [{ file: files[0], line: 5, issue: 'The label is hidden', task: 'Show the label', by: [finder] }],
    nonblocking: note ? [{ file: files[0], line: 6, issue: 'A naming suggestion', by: ['rook'] }] : [],
  });
  await until(() => db.prepare('select 1 from findings where ruling = ?').get(ruling.id), 'recorded blocker');
  cancelLeftovers();
  const finding = db.prepare('select id from findings where ruling = ?').get(ruling.id) as { id: number };
  return { head, finding: finding.id };
}

test('a running triage corrects unreadable answers against the live roster before it finishes', async () => {
  const pr = 155;
  await push(pr);
  const queued = pending(pr).find(job => job.stage === 'triage')!;
  const run = await h.claim(queued.engine, { seat: `${queued.engine}-1` });
  assert.equal(run?.id, queued.id);
  const check = (output: string) => h.agent('review-output', run!.token, { output });
  assert.equal((await check('The panel should read this.')).body.error, 'not a JSON object');
  assert.equal(
    (await check(JSON.stringify(selection([reader('bolt')])))).body.error,
    'ineligible or duplicate reviewer',
  );
  const output = JSON.stringify(selection([reader('rook')]));
  assert.equal((await check(output)).body.error, null);
  assert.equal(h.jobs.findJob(run!.id)?.status, 'running');
  assert.equal(
    (db.prepare('select output from jobs where id = ?').get(run!.id) as { output: string | null }).output,
    null,
  );
  assert.deepEqual(readers(pr), []);
  assert.equal((await h.finish(run!, { output })).status, 200);
  await until(() => readers(pr).includes('rook'), 'the checked triage dispatches');
  assert.ok(!pending(pr).some(job => job.stage === 'triage'));
  const reviewer = await h.claim('claude', { seat: 'claude-1' });
  assert.equal(reviewer?.agent, 'rook');
  const readerCheck = (output: string) => h.agent('review-output', reviewer!.token, { output });
  assert.ok((await readerCheck('No findings.')).body.error);
  const report = JSON.stringify({ findings: [{ file: files[0], line: 1, issue: 'The control is hidden' }] });
  assert.equal((await readerCheck(report)).body.error, null);
  await h.finish(reviewer!, { output: report });
  await until(() => pending(pr).some(job => job.stage === 'ruling'), 'the checked reviewer reports');
  const ruling = pending(pr).find(job => job.stage === 'ruling')!;
  const ruler = await h.claim(ruling.engine, { seat: `${ruling.engine}-1` });
  assert.equal(ruler?.id, ruling.id);
  const rulingCheck = (output: object) => h.agent('review-output', ruler!.token, { output: JSON.stringify(output) });
  assert.ok((await rulingCheck({ decision: 'review' })).body.error);
  assert.ok(
    (
      await rulingCheck({
        decision: 'merge',
        finding_sources: true,
        blocking: [{ from: [{ by: 'outsider', finding: 0 }] }],
      })
    ).body.error,
  );
  const verdict = { decision: 'merge', finding_sources: true, blocking: [], nonblocking: [] };
  assert.equal((await rulingCheck(verdict)).body.error, null);
  assert.equal(h.jobs.findJob(ruler!.id)?.status, 'running');
  await h.finish(ruler!, { output: JSON.stringify(verdict) });
});

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
  const first = await finish(pr, 'triage', selection([{ ...reader('rook'), files: [readme] }]));
  assert.deepEqual(readers(pr), []);
  assert.equal(h.github.pr(pr).merged, false);
  const retry = pending(pr).find(job => job.stage === 'triage');
  assert.ok(retry, 'incomplete coverage retries triage before dispatch');
  const reason = "the review triage can't be read: reviewers must cover every assigned file";
  assert.ok(reviewrefusals.report(db).includes(reason), 'the refusal is reported while its retry is pending');
  retryNow(db, retry.id);
  const second = await finish(
    pr,
    'triage',
    selection([
      { ...reader('rook'), files: [readme] },
      { ...reader('nib'), files: [checkout] },
    ]),
  );
  assert.ok(second.prompt.includes(reason), 'the retry names the check that refused the first answer');
  assert.deepEqual(readers(pr).sort(), ['nib', 'rook']);
  const report = reviewrefusals.report(db);
  assert.ok(report.includes(reason), 'a recovered pull request still reports the refusal');
  const entry = JSON.parse(report.split('\n').find(line => line.startsWith('{') && JSON.parse(line).pr === pr)!);
  assert.deepEqual(entry, { job: first.id, pr, round: 1, stage: 'triage', reason });
  assert.ok(!reviewrefusals.report(db, Date.now() + 86_400_001).includes(reason), 'only the last day is listed');
});

test('the looker follows visual files moved by engine constraints, and each reader keeps their lens', async () => {
  const pr = 116,
    room = 'platform/hq/renderers/brownstone/rooms.js',
    readme = 'README.md',
    record = `qa/previews/review-${pr}.md`;
  const read = (agent: string, files: string[], domain = 'hq') => ({ ...reader(agent), files, domain });
  await push(pr, sha(), { files: [room, readme, record] }, { engine: 'claude' });
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

test('triage keeps its chosen looker or no looker and refuses a looker outside the panel', async () => {
  for (const [pr, looker] of [
    [118, 'rook'],
    [119, null],
    [120, 'flint'],
  ] as const) {
    const room = 'platform/hq/renderers/brownstone/rooms.js',
      readme = 'README.md',
      record = `qa/previews/review-${pr}.md`;
    await push(pr, sha(), { files: [room, readme, record] }, { engine: 'claude' });
    await finish(pr, 'triage', {
      ...selection([
        { ...reader('rook'), files: [room] },
        { ...reader('nib'), files: [readme, record] },
      ]),
      looker,
    });
    if (looker === 'flint') {
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

test('with no file under a preview check, triage chooses which reader looks, among its readers', async () => {
  for (const [pr, looker] of [
    [181, 'rook'],
    [182, 'tally'],
  ] as const) {
    await push(pr, sha(), {}, { engine: 'claude' });
    await finish(pr, 'triage', { ...selection([reader('rook'), reader('nib')]), looker });
    if (looker === 'tally') {
      assert.deepEqual(readers(pr), [], 'a looker outside the panel decides nothing');
      assert.ok(pending(pr).some(job => job.stage === 'triage'));
    } else {
      assert.deepEqual(readers(pr).sort(), ['nib', 'rook']);
      const rows = (await h.board('/api/jobs')).body.filter((job: any) => job.pr === pr && job.kind === 'review');
      assert.equal(rows[0].triage.selection.looker, 'rook');
    }
    cancelLeftovers();
  }
});

test("a re-review's brief names the finders it keeps unless excepted", async () => {
  const pr = 183;
  await blocked(pr);
  await push(pr);
  const triage = pending(pr).find(job => job.stage === 'triage')!;
  const { prompt } = db.prepare('select prompt from jobs where id = ?').get(triage.id) as { prompt: string };
  assert.ok(prompt.includes('the open blockers listed below (rook).'));
  await finish(pr, 'triage', {
    ...selection([reader('nib')]),
    exceptions: [{ agent: 'rook', reason: 'nib covers the label' }],
  });
  assert.deepEqual(readers(pr), ['nib']);
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
    blocking: [{ ...secret, task: 'Take the credential out' }],
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

test('a triage briefed before a change to who may rule runs again briefed and run on who may rule now', async () => {
  const file = `${h.repo}/company/org.yaml`,
    before = readFileSync(file, 'utf8');
  const prompt = (job: number) =>
    (db.prepare('select prompt from jobs where id = ?').get(job) as { prompt: string }).prompt;
  for (const [pr, legacy] of [
    [184, false],
    [185, true],
  ] as const) {
    await push(pr);
    const first = pending(pr).find(job => job.stage === 'triage')!;
    assert.equal(first.agent, 'quill');
    // one queued before its brief was kept
    if (legacy) db.prepare('delete from triage_briefs where job = ?').run(first.id);
    // it was queued by someone and handles a customer's details, which its replacement keeps
    db.prepare("update jobs set queued_by = 'juno', customers = 1 where id = ?").run(first.id);
    // The consolidator roster changes while an invalid reader makes the running triage retry.
    writeFileSync(file, before.replace('consolidator: [quill, tally, nib]', 'consolidator: [tally, nib]'));
    try {
      await finish(pr, 'triage', selection([reader('unknown')]));
      const retry = pending(pr).find(job => job.stage === 'triage')!;
      assert.ok(retry, 'it runs again');
      assert.equal(retry.agent, 'tally', 'on a runner chosen now');
      const offered = JSON.parse(prompt(retry.id).match(/Eligible consolidators: (\[[^\n]*\])/u)![1]) as string[];
      assert.deepEqual(offered, ['tally', 'nib'], 'offering only whom its read accepts');
      assert.equal(prompt(retry.id).includes(prompt(first.id)), legacy, 'the old brief only as background');
      const row = (job: number) =>
        ({
          ...db.prepare('select instead_of, queued_by, customers, round, sha, judges from jobs where id = ?').get(job),
        }) as { instead_of: number | null; queued_by: string | null; customers: number };
      assert.deepEqual(row(retry.id), { ...row(first.id), instead_of: first.id }, 'in place of the run it repeats');
      assert.deepEqual(
        [row(retry.id).queued_by, row(retry.id).customers],
        ['juno', 1],
        'who queued it, and its customer data',
      );
      retryNow(db, retry.id);
      await finish(pr, 'triage', { ...selection([reader('rook')]), consolidator: 'tally' });
      await until(() => readers(pr).length === 1, 'retried triage dispatch');
      assert.equal(panel.consolidator(pr), 'tally');
    } finally {
      writeFileSync(file, before);
      cancelLeftovers();
    }
  }
});

test('HQ assigns an eligible solo consolidator when triage names the sole author', async () => {
  await push(108);
  await finish(108, 'triage', { ...selection([]), consolidator: 'bolt' });
  const ruling = pending(108).find(job => job.stage === 'ruling');
  assert.ok(ruling && panel.consolidators(108).includes(ruling.agent));
  assert.notEqual(ruling?.agent, 'bolt');
  assert.ok(!pending(108).some(job => job.stage === 'triage'));
  assert.equal(h.github.pr(108).merged, false);
});

test('a co-authored fix round stays readable when triage names an unavailable consolidator', async () => {
  const pr = 1807;
  for (const agent of ['quill', 'tally', 'nib', 'juno']) h.ended({ agent, branch: `review/${pr}` });
  await blocked(pr, false, 'nib', 'quill');
  await push(pr, sha(), {}, { agent: 'quill' });
  assert.deepEqual([...panel.authorsOf(pr)].sort(), ['juno', 'nib', 'quill', 'tally']);
  assert.deepEqual(panel.consolidators(pr), ['quill', 'tally', 'nib']);
  const output = {
    ...selection([reader('quill')]),
    consolidator: 'unknown',
    exceptions: [{ agent: 'nib', reason: 'Quill can recheck the shared fix' }],
  };
  const triage = pending(pr).find(job => job.stage === 'triage')!;
  const run = await h.claim(triage.engine, { seat: `${triage.engine}-1` });
  assert.equal(run?.id, triage.id);
  const refused = [
    {
      output: JSON.stringify({ ...output, consolidator: undefined, exceptions: [] }),
      error: 'omitted finder needs a reason',
    },
    {
      output: JSON.stringify({ ...output, consolidator: undefined, reviewers: [], looker: 'nib' }),
      error: 'the looker must be a reader of files that show',
    },
  ];
  for (const candidate of refused)
    assert.equal(
      (await h.agent('review-output', run!.token, { output: candidate.output })).body.error,
      candidate.error,
    );
  for (const consolidator of ['unknown', 'juno', undefined])
    for (const decision of ['review', 'escalate']) {
      const candidate = JSON.stringify({ ...output, consolidator, decision });
      assert.equal((await h.agent('review-output', run!.token, { output: candidate })).body.error, null);
    }
  await h.finish(run!, { output: JSON.stringify(output) });
  await until(() => readers(pr).includes('quill'), 'the named reviewer receives the fix read');
  for (const candidate of refused) assert.equal(reviewtriage.read(triage.id, candidate.output), candidate.error);
  assert.ok(!pending(pr).some(job => job.stage === 'triage'));
  const rows = (await h.board('/api/jobs')).body.filter((job: any) => job.pr === pr && job.kind === 'review');
  const assigned = rows[0].triage.selection.consolidator;
  assert.ok(panel.consolidators(pr).includes(assigned));
  await finish(pr, 'review', { findings: [] });
  assert.equal(pending(pr).find(job => job.stage === 'ruling')?.agent, assigned);
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

test('refused reviewer and ruling reads report their full reason and brief their replacements', async () => {
  const pr = 117;
  await push(pr);
  await finish(pr, 'triage', selection([reader('rook')]));
  const reviewer = await finish(pr, 'review', {});
  const reviewReason = "rook's review ended without its report";
  const reviewRetry = pending(pr).find(job => job.stage === 'review')!;
  retryNow(db, reviewRetry.id);
  const reviewed = await finish(pr, 'review', { findings: [] });
  assert.ok(reviewed.prompt.includes(reviewReason));
  const ruling = await finish(pr, 'ruling', {});
  const rulingReason = `Quill's verdict (job #${ruling.id}) isn't the JSON file the review asks for`;
  const rulingRetry = pending(pr).find(job => job.stage === 'ruling')!;
  retryNow(db, rulingRetry.id);
  const ruled = await finish(pr, 'ruling', {
    decision: 'changes',
    blocking: [{ file: files[0], line: 5, issue: 'The label is hidden', task: 'Show the label' }],
  });
  assert.ok(ruled.prompt.includes(rulingReason));
  const refused = reviewrefusals
    .report(db)
    .split('\n')
    .slice(1)
    .map(line => JSON.parse(line))
    .filter(read => read.pr === pr);
  assert.deepEqual(refused, [
    { job: reviewer.id, pr, round: 1, stage: 'review', reason: reviewReason },
    { job: ruling.id, pr, round: 1, stage: 'ruling', reason: rulingReason },
  ]);
});

test('a triage of hundreds of files scopes its readers by folder and glob, and is read', async () => {
  const pr = 1865,
    many = (folder: string, n: number, ext: string) => Array.from({ length: n }, (_, i) => `${folder}/${i}.${ext}`),
    all = [
      ...many('kits/brand/covers', 94, 'svg'),
      ...many('kits/design/icons', 69, 'svg'),
      ...many('theme/covers', 25, 'svg'),
      ...many('platform/hq/shell', 18, 'js'),
      ...many('platform/hq/sounds', 3, 'js'),
      ...many('kits/brand', 40, 'js'),
    ];
  assert.equal(all.length, 249);
  await push(pr, sha(), { files: all });
  const triage = pending(pr).find(job => job.stage === 'triage')!,
    { prompt: brief } = db.prepare('select prompt from jobs where id = ?').get(triage.id) as { prompt: string };
  assert.match(brief, /folders ending in \/ or globs/);
  assert.match(brief, /never with a command or script/);
  await finish(
    pr,
    'triage',
    selection([
      { ...reader('rook'), files: ['kits/brand/covers/', 'kits/design/', 'theme/**/*.svg'], domain: 'drawing' },
      {
        ...reader('nib'),
        files: ['platform/hq/shell/', 'platform/hq/sounds/@(0|1|2).js', 'kits/brand/*.js'],
        domain: 'code',
      },
    ]),
  );
  await until(() => readers(pr).length === 2, 'triage dispatch');
  const judged = pending(pr)
    .filter(job => job.kind === 'review')
    .flatMap(job =>
      JSON.parse((db.prepare('select judges from jobs where id = ?').get(job.id) as { judges: string }).judges),
    );
  assert.deepEqual([...judged].sort(), [...all].sort(), 'each reported file is read once, by its path');
});

test('a reader whose folders match none of the files is refused', async () => {
  const pr = 1866;
  await push(pr);
  await finish(pr, 'triage', selection([{ ...reader('rook'), files: ['kits/'] }]));
  assert.deepEqual(readers(pr), []);
  assert.ok(
    pending(pr).some(job => job.stage === 'triage'),
    'it runs again',
  );
});

test('a UI reader can look without a configured preview command, beside other configured visual work too', async () => {
  for (const configured of [false, true]) {
    const pr = configured ? 124 : 121,
      room = 'platform/hq/renderers/brownstone/rooms.js',
      record = `qa/previews/review-${pr}.md`,
      scope = configured ? [...files, room, record] : files;
    await push(pr, sha(), { files: scope }, { engine: 'claude' });
    await finish(pr, 'triage', {
      ...selection([reader('rook'), ...(configured ? [{ ...reader('tally'), files: [room, record] }] : [])]),
      looker: 'rook',
    });
    assert.deepEqual(readers(pr).sort(), configured ? ['rook', 'tally'] : ['rook']);
    assert.ok(!pending(pr).some(job => job.stage === 'triage'));
    const rows = (await h.board('/api/jobs')).body.filter((job: any) => job.pr === pr && job.kind === 'review');
    assert.equal(rows[0].triage.selection.looker, 'rook');
    cancelLeftovers();
  }
});

test('a retained finder can look on a later round without a configured preview command', async () => {
  const pr = 122;
  const { head } = await blocked(pr);
  await push(pr, sha(), { pushedSince: { sha: head, files } });
  await finish(pr, 'triage', { ...selection(), looker: 'rook' });
  assert.deepEqual(readers(pr), ['rook']);
  assert.ok(!pending(pr).some(job => job.stage === 'triage'));
  const rows = (await h.board('/api/jobs')).body.filter((job: any) => job.pr === pr && job.kind === 'review');
  assert.equal(rows.find((job: any) => job.status === 'queued').triage.selection.looker, 'rook');
});

test('a fix round passes the consolidator look to the reader holding the shown files, or keeps it alone', async () => {
  for (const [pr, solo] of [
    [1863, false],
    [128, true],
  ] as const) {
    const room = 'platform/hq/renderers/brownstone/rooms.js',
      record = `qa/previews/review-${pr}.md`,
      scope = [...files, room, record];
    const { head } = await blocked(pr, false, 'quill');
    await push(pr, sha(), { files: scope, pushedSince: { sha: head, files: scope } }, { engine: 'claude' });
    await finish(pr, 'triage', {
      ...selection(solo ? [] : [{ ...reader('nib'), files: scope }]),
      looker: 'quill',
    });
    assert.ok(!pending(pr).some(job => job.stage === 'triage'), 'the look must not refuse the triage');
    assert.deepEqual(readers(pr).sort(), solo ? [] : ['nib', 'rook']);
    const rows = (await h.board('/api/jobs')).body.filter((job: any) => job.pr === pr && job.status === 'queued');
    assert.equal(rows[0].round, 2);
    const looker = solo ? 'quill' : 'rook';
    assert.equal(rows[0].triage.selection.looker, looker);
    const { prompt } = db
      .prepare("select prompt from jobs where pr = ? and agent = ? and status = 'queued'")
      .get(pr, looker) as { prompt: string };
    assert.ok(prompt.includes('node preview.mjs'), 'the reader receives the required previews');
    cancelLeftovers();
  }
});

test('an unseated consolidator cannot pass an unconfigured look to a security reader ahead of the UI reader', async () => {
  const pr = 127,
    security = 'platform/coordinator/src/signin.ts',
    scope = [security, ...files];
  const { head } = await blocked(pr, false, 'quill');
  await push(pr, sha(), { files: scope, pushedSince: { sha: head, files: scope } });
  const queued = pending(pr).find(job => job.stage === 'triage')!;
  const run = await h.claim(queued.engine, { seat: `${queued.engine}-1` });
  assert.equal(run?.id, queued.id);
  const report = selection([
    { ...reader('nib'), files: [security], domain: 'security', security: true },
    reader('rook'),
  ]);
  const checked = await h.agent('review-output', run!.token, {
    output: JSON.stringify({ ...report, looker: 'quill' }),
  });
  assert.equal(checked.body.error, 'the looker must be a reader of files that show');
  assert.deepEqual(readers(pr), []);
  assert.equal(h.jobs.findJob(run!.id)?.status, 'running');
  const output = JSON.stringify({ ...report, looker: 'rook' });
  assert.equal((await h.agent('review-output', run!.token, { output })).body.error, null);
  await h.finish(run!, { output });
  await until(() => readers(pr).length === 2, 'the corrected triage dispatches both readers');
  const rows = (await h.board('/api/jobs')).body.filter((job: any) => job.pr === pr && job.kind === 'review');
  assert.equal(rows[0].triage.selection.looker, 'rook');
});

test('a fix round still refuses unknown and unselected lookers when the consolidator reads alone', async () => {
  const pr = 129;
  const { head } = await blocked(pr, false, 'quill');
  await push(pr, sha(), { pushedSince: { sha: head, files } });
  const queued = pending(pr).find(job => job.stage === 'triage')!;
  const run = await h.claim(queued.engine, { seat: `${queued.engine}-1` });
  assert.equal(run?.id, queued.id);
  for (const looker of ['nobody', 'rook']) {
    const checked = await h.agent('review-output', run!.token, {
      output: JSON.stringify({ ...selection([]), looker }),
    });
    assert.equal(checked.body.error, 'the looker must be a reader of files that show');
    assert.deepEqual(readers(pr), []);
    assert.equal(h.jobs.findJob(run!.id)?.status, 'running');
  }
  await h.finish(run!, { output: JSON.stringify({ ...selection([]), looker: 'quill' }) });
  await until(() => pending(pr).some(job => job.stage === 'ruling'), 'the consolidator takes the valid look');
});

test('a finder serving as consolidator needs no omission reason, with or without other reviewers', async () => {
  for (const panel of [false, true]) {
    const pr = panel ? 125 : 123;
    const { head } = await blocked(pr, false, 'nib');
    await push(pr, sha(), { pushedSince: { sha: head, files } });
    await finish(pr, 'triage', {
      ...selection(panel ? [reader('tally')] : []),
      consolidator: 'nib',
      looker: panel ? 'tally' : 'nib',
    });
    assert.deepEqual(readers(pr), panel ? ['tally'] : []);
    assert.ok(!pending(pr).some(job => job.stage === 'triage'));
    if (panel) await finish(pr, 'review', { findings: [] });
    assert.ok(pending(pr).some(job => job.stage === 'ruling' && job.agent === 'nib'));
    cancelLeftovers();
  }
});

test('an original finder retained by engine constraints needs no omission reason and can receive the look', async () => {
  const pr = 126,
    room = 'platform/hq/renderers/brownstone/rooms.js',
    record = `qa/previews/review-${pr}.md`,
    scope = [...files, room, record];
  const { head } = await blocked(pr);
  await push(pr, sha(), { files: scope, pushedSince: { sha: head, files: scope } }, { engine: 'claude' });
  await finish(pr, 'triage', {
    ...selection([{ ...reader('nib'), files: scope }]),
    looker: 'nib',
  });
  assert.deepEqual(readers(pr).sort(), ['nib', 'rook']);
  assert.ok(!pending(pr).some(job => job.stage === 'triage'));
  const rows = (await h.board('/api/jobs')).body.filter((job: any) => job.pr === pr && job.status === 'queued');
  assert.equal(rows[0].triage.selection.looker, 'rook');
});

// The seats' state for one test: paused ones take nothing, a paced one only work whose latest start precedes its reset
async function seatsFor(states: Record<string, 'ready' | 'paused' | 'paced'>, body: () => Promise<void>) {
  const set = async (seat: string, state: 'ready' | 'paused' | 'paced') => {
    await h.worker('seat', { seat, engine: seat.split('-')[0], state: state === 'paced' ? 'ready' : state });
    db.prepare('update seats set pace = ?, week_resets = ? where id = ?').run(
      ...(state === 'paced' ? [1, Date.now() + 24 * 3_600_000] : [null, null]),
      seat,
    );
  };
  try {
    for (const [seat, state] of Object.entries(states)) await set(seat, state);
    await body();
  } finally {
    for (const seat of Object.keys(states)) await set(seat, 'ready');
  }
}

const triager = (pr: number) => pending(pr).find(job => job.stage === 'triage')!.agent;

// A round on a thread due in `hours`
async function pushDue(pr: number, hours: number) {
  const thread = h.dueThread({ deadline: Date.now() + hours * 3_600_000 });
  await push(pr, sha(), {}, { thread });
}

test('rounds open at once go to more than one consolidator while more than one seat has room', async () => {
  for (const pr of [160, 161, 162, 163]) await push(pr);
  assert.deepEqual([160, 161, 162, 163].map(triager), ['quill', 'nib', 'quill', 'nib']);
  await seatsFor({ 'codex-1': 'paused' }, async () => {
    await push(164);
    assert.equal(triager(164), 'quill', 'only the Claude seat has room');
  });
});

test('a round counts queued runs ahead in the shared plan, and a paced seat takes a round whose latest start precedes reset', async () => {
  await seatsFor({ 'codex-1': 'paused' }, async () => {
    for (const pr of [165, 166, 167]) await pushDue(pr, 1);
  });
  await seatsFor({ 'claude-1': 'paused' }, async () => {
    for (const pr of [168, 169, 170]) await push(pr);
  });
  assert.deepEqual([165, 166, 167, 168, 169, 170].map(triager), ['quill', 'quill', 'quill', 'nib', 'nib', 'nib']);
  await pushDue(171, 2);
  assert.equal(triager(171), 'nib', "Codex's three queued rounds have no window, so they wait behind it");
  await push(172);
  assert.equal(triager(172), 'quill', 'a round without a window waits behind all of them');
  cancelLeftovers();
  await seatsFor({ 'claude-1': 'paced' }, async () => {
    for (const pr of [173, 174]) await push(pr);
    assert.deepEqual([173, 174].map(triager), ['nib', 'nib'], 'the paced seat takes no undated round');
    await pushDue(175, 2);
    assert.equal(triager(175), 'quill', 'a round due before the reset is one the paced seat takes');
  });
});
