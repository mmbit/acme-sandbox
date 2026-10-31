// node --test src/carries.test.ts   (the test company, which names no foundation keeper: its CEO, Juno, keeps it)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('carries');
// (after the harness: jobcodes.ts opens the database, which must be the test's)
const predictions = await import('./predictions.ts');
const { STANDING } = await import('./jobcodes.ts');

const sha = (n: number) => n.toString(16).padStart(40, '0');
// A commit on main's first-parent line, as the worker tells it
const commit = (n: number, ...parents: number[]) => ({ sha: sha(n), parents: parents.map(sha) });
const moved = async (...line: ReturnType<typeof commit>[]) => {
  const r = await h.worker('main-moved', { commits: line });
  assert.equal(r.status, 200);
  return r.body.checks as number[];
};
const checkJobs = () =>
  h.db.prepare('select id, agent, carry from jobs where carry is not null order by id').all() as {
    id: number;
    agent: string;
    carry: string;
  }[];
const fixes = () => (h.jobs.listJobs() as any[]).filter(j => j.code === STANDING.carryFix);

// main: 1 <- 2 <- 3 (HQ's merge of PR #101's head 11) <- 4 (a carry: a merge of the foundation's 40) <- 5 (another
// merge of 11, made outside HQ: its conflict resolutions unreviewed)
const author = h.queue({ agent: 'bolt' });
h.storedPr(101, author, 'merged', [], { sha: sha(11) });
h.db.prepare('update prs set merged_as = ? where number = 101').run(sha(3));
const line = [commit(5, 4, 11), commit(4, 3, 40), commit(3, 2, 11), commit(2, 1), commit(1, 0)];

test("each commit main took outside HQ's merges gets one check job, the keeper's; HQ's merges get none", async () => {
  assert.deepEqual(await moved(...line.slice(3)), [], 'the first line only marks where main is');
  const queued = await moved(...line);
  assert.deepEqual(
    checkJobs().map(j => [j.agent, j.carry]),
    [
      ['juno', sha(4)],
      ['juno', sha(5)],
    ],
  );
  assert.deepEqual(
    queued,
    checkJobs().map(j => j.id),
  );
  assert.deepEqual(await moved(...line), [], 'main as it was: nothing new');
  // A worker's line from before (a mirror behind HQ) and the newer one again: nothing is checked twice
  await moved(...line.slice(2));
  assert.deepEqual(await moved(...line), []);
  assert.equal(checkJobs().length, 2);
});

test('a line that is no first-parent line of commits is refused', async () => {
  assert.equal((await h.worker('main-moved', { commits: [{ sha: 'main', parents: [] }] })).status, 400);
  assert.equal((await h.worker('main-moved', {})).status, 400);
});

test("a red check queues the keeper's fix with both commits and the report; a green one queues nothing", async () => {
  const [carry, direct] = checkJobs();
  const claimed = await h.claimJob(carry.id);
  assert.equal(claimed.carry, sha(4), 'the worker hears which commit the job checks');
  const report = 'platform/coordinator/src/basketmail.ts: 412 lines, past the limit of 400';
  await h.finish(claimed, {
    carry: { sha: sha(4), base: sha(3) },
    gates: { passed: false, report },
    tests: { passed: true, report: 'Tests passed' },
    result: 'gates failed, tests passed',
  });
  const [fix] = fixes();
  assert.equal(fix?.agent, 'juno');
  const planned = predictions.prepared(Date.now()).snapshot.jobs.find(job => job.id === fix.id)!;
  assert.equal(planned.origin, 'hq');
  assert.equal(planned.opensReview, true, 'the keeper repairs the failed gates as engineering work');
  const brief = h.db.prepare('select prompt from jobs where id = ?').get(fix.id) as { prompt: string };
  for (const words of [sha(4), sha(3), report]) assert.ok(brief.prompt.includes(words), `the brief has ${words}`);
  assert.ok(!brief.prompt.includes('Tests passed'), 'only the red check reports');

  await h.finish(claimed, {
    carry: { sha: sha(4), base: sha(3) },
    gates: { passed: false, report },
    tests: { passed: true, report: 'Tests passed' },
  });
  assert.equal(fixes().length, 1, 'a finish whose reply was lost queues its fix only once');

  const green = await h.claimJob(direct.id);
  await h.finish(green, {
    carry: { sha: sha(5), base: sha(4) },
    gates: { passed: true, report: 'The gates pass' },
    tests: { passed: true, report: 'Tests passed' },
  });
  assert.equal(fixes().length, 1);
});

test("the worker's whole line, 100 merges, fits HQ's cap on a request", async () => {
  const merges = Array.from({ length: 100 }, (_, i) => commit(1000 + i, 999 + i, 5000 + i));
  assert.deepEqual(await moved(...merges), []);
});

test("a line that doesn't reach HQ's last commit moves nothing: what main took since comes in pages, each checked", async () => {
  const far = await h.worker('main-moved', { commits: [commit(1099, 1098), commit(1098, 1097)] });
  assert.deepEqual(far.body, { checks: [], seen: sha(5) }, 'HQ keeps its commit and names it');
  const page = async (after: number, ...commits: ReturnType<typeof commit>[]) =>
    (await h.worker('main-moved', { commits, after: sha(after) })).body;
  const first = await page(5, commit(7, 6), commit(6, 5));
  assert.deepEqual(
    checkJobs()
      .filter(j => first.checks.includes(j.id))
      .map(j => j.carry),
    [sha(6), sha(7)],
  );
  assert.deepEqual(await page(5, commit(6, 5)), { checks: [], seen: sha(7) }, 'a page from before');
  assert.equal((await page(7, commit(8, 7))).checks.length, 1);
  assert.deepEqual(await moved(commit(9, 8), commit(8, 7)), [checkJobs().at(-1)!.id]);
  assert.equal(checkJobs().at(-1)!.carry, sha(9));
});

test("main's history without HQ's last commit becomes the keeper's job, and the line goes on from there", async () => {
  const before = fixes().length;
  const lost = await h.worker('main-moved', { commits: [commit(31, 30), commit(30, 29)], lost: sha(9) });
  const [job] = lost.body.checks as number[];
  const brief = h.db.prepare('select agent, prompt from jobs where id = ?').get(job) as {
    agent: string;
    prompt: string;
  };
  assert.equal(brief.agent, 'juno');
  for (const words of [sha(9), sha(31)]) assert.ok(brief.prompt.includes(words), `the brief has ${words}`);
  assert.equal(fixes().length, before + 1);
  assert.deepEqual(await moved(commit(32, 31), commit(31, 30)), [checkJobs().at(-1)!.id]);
  assert.equal(checkJobs().at(-1)!.carry, sha(32));
});

test("a check without a verdict leaves its commit the keeper's to run; so does a check job that failed before any ran", async () => {
  const before = Math.max(...fixes().map(j => j.id));
  const [halfRun, unrun] = await moved(commit(34, 33), commit(33, 32), commit(32, 31));
  const report = "The tests' claim in HQ couldn't be made: fetch failed";
  await h.finish(await h.claimJob(halfRun), {
    status: 'failed',
    carry: { sha: sha(33), base: sha(32) },
    gates: { passed: true, report: 'The gates pass' },
    tests: { passed: null, report },
  });
  await h.finish(await h.claimJob(unrun), { status: 'failed', result: 'The worker could not clone the commit' });
  const [first, second] = fixes()
    .filter(j => j.id > before)
    .sort((a, b) => a.id - b.id);
  assert.match(first.title, /tests not run$/);
  assert.match(second.title, /gates not run, tests not run$/);
  const brief = (id: number) =>
    (h.db.prepare('select prompt from jobs where id = ?').get(id) as { prompt: string }).prompt;
  for (const words of [sha(33), sha(32), report]) assert.ok(brief(first.id).includes(words), `the brief has ${words}`);
  assert.ok(!brief(first.id).includes('The gates pass'), 'only what needs the keeper reports');
  assert.ok(brief(second.id).includes(`--base ${sha(34)}^1`), 'with no finish, against its first parent');
});

// Where projects.yaml's made.carries names a project, each check job and the keeper's fix of one is a one-task
// deliverable there, so the board follows it like any other work
test("with made.carries, each check job and the keeper's fix are one-task deliverables in its project", async () => {
  const file = `${h.repo}/company/projects.yaml`,
    was = readFileSync(file, 'utf8');
  writeFileSync(file, `${was.trimEnd()}\n  carries: { hq: office }\n`);
  try {
    const [check] = await moved(commit(35, 34), commit(34, 33));
    assert.equal(h.jobs.threadOf(check), `office/job-${check}`);
    await h.finish(await h.claimJob(check), {
      status: 'done',
      carry: { sha: sha(35), base: sha(34) },
      gates: { passed: false, report: 'Prettier fails' },
      tests: { passed: true, report: 'All pass' },
    });
    const fix = Math.max(...fixes().map(j => j.id));
    assert.equal(h.jobs.threadOf(fix), `office/job-${fix}`);
  } finally {
    writeFileSync(file, was);
  }
});
