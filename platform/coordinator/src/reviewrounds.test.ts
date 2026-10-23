// node --test src/reviewrounds.test.ts   (uses a throwaway DATA_DIR; GitHub is played by the harness)
// The formal review process through the review's own routes: each round's briefing by its stage, and what the reviews
// leave going to the project's follow-ups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { harness, until, type Running } from './harness.ts';
import { completeTriage } from './reviewfixture.ts';

const h = await harness('reviewrounds', {
  before: repo => {
    writeFileSync(
      `${repo}/company/projects.yaml`,
      'projects:\n  - { id: office, name: The office, owner: juno }\n  - { id: game, name: The game, owner: wren }\n',
    );
  },
});
const { db, worker, repo } = h;
const projects = await import('./projects.ts');
const plan = await import('./plan.ts');
const windows = await import('./windows.ts');
const proposals = await import('./proposals.ts');
await worker('seat', { seat: 'codex-1', engine: 'codex', state: 'ready' });
plan.setOwner('game', 'wren', { agent: 'juno', job: 0 }, agent => !!h.jobs.findAgent(agent));
projects.createThread({
  project: 'game',
  name: 'The first world plays',
  goal: 'The first world can finish',
  slug: 'world',
});
projects.createThread({ project: 'game', name: 'Levels end', goal: 'Every level can end', slug: 'levels' });

const FILE = 'products/game/play.ts';
type Run = Running & { id: number; kind: string; stage: string | null; round: number; prompt: string; seat: string };
const queued = (n: number) =>
  db.prepare("select id, kind, engine from jobs where pr = ? and status = 'queued' order by id").all(n) as {
    id: number;
    kind: string;
    engine: string;
  }[];
// The seats take PR n's queued jobs of a kind, oldest first
async function claim(n: number, kind?: string) {
  const runs: Run[] = [];
  for (const j of queued(n).filter(j => !kind || j.kind === kind)) {
    const seat = j.engine === 'codex' ? 'codex-1' : 'claude-1';
    let r;
    // another's job a seat takes first (the owner's planning job) goes back until long after this file has run
    while ((r = (await worker('claim', { seat, engine: j.engine })).body as Run) && r.id !== j.id && r.pr !== n)
      await worker('finish', { job: r.id, seat, status: 'limited', resetAt: Date.now() + 86_400_000 });
    assert.equal(r?.id, j.id);
    runs.push({ ...r, seat });
  }
  return runs;
}
const end = async (run: Run, report: Record<string, unknown> = { output: '{"summary": "fine", "findings": []}' }) => {
  assert.equal((await worker('finish', { job: run.id, seat: run.seat, status: 'done', ...report })).status, 200);
  if (typeof report.pr === 'number') await completeTriage(h, report.pr);
};
const heads = new Map<number, string>();
// The author's job on the thread pushes PR n (the first time), or its fix job does
async function push(n: number, thread = 'game/world') {
  const fix = db.prepare("select id from jobs where pr = ? and kind = 'work' and status = 'queued'").get(n) as
    { id: number } | undefined;
  const job = fix
    ? ({ ...(await worker('claim', { seat: 'claude-1', engine: 'claude' })).body, seat: 'claude-1' } as Run)
    : ((await h.start({ agent: 'bolt', branch: `review/${n}`, thread })) as Run);
  const sha = randomBytes(20).toString('hex');
  const since = heads.get(n);
  heads.set(n, sha);
  await end(job, {
    pr: n,
    branch: `review/${n}`,
    files: [FILE],
    sha,
    lines: { [FILE]: [[1, 60]] },
    ...(since ? { pushedSince: { sha: since, files: [FILE] } } : {}),
    result: 'Fixed what blocked.',
  });
}
const json = (o: object) => ({ output: JSON.stringify(o) });
const at = (line: number, issue: string, file = FILE) => ({ file, line, case: 'x', issue, fix: 'y', by: ['quill'] });
const findingsOf = (n: number) =>
  db.prepare('select id, kind, issue, outcome from findings where pr = ? order by id').all(n) as {
    id: number;
    kind: string;
    issue: string;
    outcome: string | null;
  }[];
const fixPrompt = (n: number) =>
  (
    db.prepare("select prompt from jobs where pr = ? and kind = 'work' and status = 'queued'").get(n) as {
      prompt: string;
    }
  ).prompt;
const bundles = () =>
  db
    .prepare("select id, project, brief, status from proposals where title like 'Review follow-ups%' order by id")
    .all() as { id: number; project: string | null; brief: string; status: string }[];

test('each round gets the briefing of its stage, and what the reviews leave goes to the project owner as one follow-up bundle', async () => {
  const n = 601;
  await push(n);
  const panel = await claim(n, 'review');
  for (const run of panel) {
    assert.match(run.prompt, /## Round 1: the first look/);
    assert.match(run.prompt, /In the first look, code the next person can't live with blocks too/);
    await end(run);
  }
  const [ruling] = await claim(n, 'consolidate');
  assert.match(ruling.prompt, /In the first look, so does code the next person can't live with/);
  assert.match(ruling.prompt, /Then make the safe\s+nonblocking fixes too/);
  assert.doesNotMatch(ruling.prompt, /"upstream"/);
  await end(
    ruling,
    json({
      blocking: [at(3, 'the score adds the bonus twice'), at(7, 'a name that says nothing')],
      nonblocking: [at(30, 'a long function')],
      pre_existing: [
        { ...at(9, 'the ship is drawn twice', 'kits/art/ship.ts'), cross_project: true },
        at(2, 'an old loop', 'products/game/old.ts'),
      ],
      decision: 'changes',
      summary: 'one',
    }),
  );
  const [bonus, name, long] = findingsOf(n).filter(f => f.kind !== 'pre-existing');
  assert.deepEqual([bonus.kind, name.kind, long.kind], ['blocking', 'blocking', 'nonblocking']);
  assert.match(fixPrompt(n), /The nonblocking ones are yours to fix too/);

  // round 2, a later round: only security, real bugs and what a customer meets block; the rest is the project's
  await push(n);
  const [check] = await claim(n);
  assert.equal(check.stage, 'ruling');
  assert.match(check.prompt, /Only those block now/);
  assert.match(check.prompt, /a change that doesn't do what the board asked/);
  assert.match(check.prompt, /"nonblocking": \[the same shape\]/);
  await end(
    check,
    json({
      outcomes: [
        { finding: bonus.id, outcome: 'not fixed' },
        { finding: name.id, outcome: 'not fixed' },
        { finding: long.id, outcome: 'not fixed' },
      ],
      blocking: [{ ...at(4, 'the bonus still counts twice'), earlier: bonus.id }],
      nonblocking: [
        at(12, 'the helper could be shorter'),
        { ...at(30, 'the function is still long'), earlier: long.id },
      ],
      decision: 'changes',
      summary: 'one left',
    }),
  );
  assert.equal(findingsOf(n).find(f => f.issue === 'the helper could be shorter')?.kind, 'follow-up');
  assert.match(fixPrompt(n), /Fix only the blocking findings/);
  assert.match(fixPrompt(n), /The nonblocking findings aren't yours/);

  // round 3 merges: its own nonblocking finding and the one the author left open go with the rest
  await push(n);
  const [last] = await claim(n);
  await end(
    last,
    json({
      outcomes: [
        { finding: bonus.id, outcome: 'fixed' },
        { finding: name.id, outcome: 'not fixed' },
        { finding: long.id, outcome: 'not fixed' },
      ],
      blocking: [],
      nonblocking: [at(20, 'a comment says what, not why'), { ...at(30, 'still one long function'), earlier: long.id }],
      decision: 'merge',
      summary: 'fixed',
    }),
  );
  await until(() => bundles().length === 2, 'the follow-ups bundled');
  const [own, across] = bundles();
  assert.equal(own.project, 'game', "the pull request's project");
  for (const issue of [
    'a name that says nothing',
    'the helper could be shorter',
    'a comment says what, not why',
    'an old loop',
  ])
    assert.ok(own.brief.includes(issue), issue);
  assert.ok(!own.brief.includes('the bonus'), 'what blocked is fixed on the pull request');
  assert.deepEqual(
    findingsOf(n)
      .filter(f => f.issue.includes('long'))
      .map(f => f.id),
    [long.id],
    'an earlier finding moved into the follow-ups keeps its number',
  );
  assert.equal(own.brief.match(/long function/g)?.length, 1);
  assert.ok(!own.brief.includes('the ship'));
  assert.equal(across.project, null, "a finding in another domain's code is the CEO's to pass on");
  assert.ok(across.brief.includes('the ship is drawn twice'));
  assert.equal(
    proposals.list('wren').some(p => p.id === own.id),
    true,
    "in the owner's inbox",
  );

  // a later pull request's follow-ups join the open bundle, and the owner assigns it
  const m = 602;
  await push(m);
  for (const run of await claim(m, 'review')) await end(run);
  const [quill] = await claim(m, 'consolidate');
  await end(quill, json({ blocking: [], nonblocking: [at(5, 'a magic number')], decision: 'merge', summary: 'ok' }));
  await until(() => bundles()[0].brief.includes('a magic number'), 'the next follow-up joined');
  assert.equal(bundles().length, 2);
  const tidy = { project: 'game', name: 'Tidy the game code', goal: 'The follow-ups worth fixing are fixed' };
  const accepted = proposals.accept(own.id, 'wren', { newThread: tidy, for: 'moss', code: 'TIDY' }) as { job: number };
  assert.equal(h.job(accepted.job).agent, 'moss', 'the owner assigns it');
});

test("a first round near its thread's deadline is a later one, and the upstream round shows what went wrong before review", async t => {
  const thread = projects.findThread('game/levels')!;
  const deadline = Date.now() + 2 * 3_600_000;
  windows.set(thread, { deadline, aim: deadline }, 'juno');
  const n = 603;
  await push(n, 'game/levels');
  const panel = await claim(n, 'review');
  for (const run of panel) {
    assert.match(run.prompt, /## Round 1: the thread's deadline is near/);
    await end(run);
  }
  windows.set(thread, null, 'juno');
  const [ruling] = await claim(n, 'consolidate');
  await end(
    ruling,
    json({ blocking: [at(3, 'the level never ends')], nonblocking: [], decision: 'changes', summary: 'one' }),
  );
  const [level] = findingsOf(n);
  for (let round = 2; round < 6; round++) {
    await push(n);
    const [check] = await claim(n);
    assert.equal(check.round, round);
    await end(
      check,
      json({
        outcomes: [{ finding: level.id, outcome: 'not fixed' }],
        blocking: [{ ...at(3, 'the level still never ends'), earlier: level.id }],
        decision: 'changes',
        summary: 'not yet',
      }),
    );
  }
  await push(n);
  const [check] = await claim(n);
  assert.equal(check.round, 6);
  assert.match(check.prompt, /past 5 rounds, something before review is wrong/);
  assert.match(check.prompt, /"upstream": "what went wrong before review, in one line"/);
  const notYet = {
    outcomes: [{ finding: level.id, outcome: 'not fixed' }],
    blocking: [{ ...at(3, 'the level still never ends'), earlier: level.id }],
    decision: 'changes',
    summary: 'not yet',
  };
  await end(check, json(notYet));
  // the ruling runs again a few minutes later (review.ts RETRY_MS)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 6 * 60_000 });
  const [again] = await claim(n);
  assert.equal(again.round, 6, 'a ruling that says nothing in "upstream" decides nothing, and runs again');
  await end(again, json({ ...notYet, upstream: 'the brief never said when a level ends' }));
  assert.match(fixPrompt(n), /past 5 rounds/);
  const shown = (round: number) =>
    db.prepare("select text from events where type = 'log' and text like ?").get(`Round ${round} on PR #${n}%`) as
      { text: string } | undefined;
  assert.match(shown(6)?.text ?? '', /the brief never said when a level ends/);

  // a merge from the upstream round on says what went wrong too, in the feed and in the owner's proposal
  await push(n, 'game/levels');
  const [last] = await claim(n);
  assert.equal(last.round, 7);
  await end(
    last,
    json({
      outcomes: [{ finding: level.id, outcome: 'fixed' }],
      blocking: [],
      nonblocking: [],
      decision: 'merge',
      summary: 'fixed',
      upstream: 'the levels were split from their ending',
    }),
  );
  assert.match(shown(7)?.text ?? '', /the levels were split from their ending/);
  const told = () => proposals.list('wren').find(p => p.title === `Before review: what went wrong on PR #${n}`);
  await until(() => told()?.brief.includes('the levels were split from their ending'), "the owner's proposal");
  assert.match(told()!.brief, /the brief never said when a level ends/);
});

test('a ruling from the upstream round on whose job was never asked what went wrong before review still rules its round', async () => {
  const n = 604;
  await push(n);
  for (const run of await claim(n, 'review')) await end(run);
  const [ruling] = await claim(n, 'consolidate');
  await end(
    ruling,
    json({ blocking: [at(3, 'the ship never lands')], nonblocking: [], decision: 'changes', summary: 'one' }),
  );
  const [ship] = findingsOf(n);
  const org = `${repo}/company/org.yaml`,
    before = readFileSync(org, 'utf8');
  for (let round = 2; round <= 6; round++) {
    // round 6's check is made while org.yaml's upstream round is still 7, and ruled once it's 6
    if (round === 6) writeFileSync(org, before + '\nreview:\n  rounds: { upstream: 7 }\n');
    await push(n);
    const [check] = await claim(n);
    assert.equal(check.round, round);
    if (round === 6) writeFileSync(org, before);
    await end(
      check,
      json({
        outcomes: [{ finding: ship.id, outcome: 'not fixed' }],
        blocking: [{ ...at(3, 'the ship still never lands'), earlier: ship.id }],
        decision: 'changes',
        summary: 'not yet',
      }),
    );
  }
  assert.match(fixPrompt(n), /past 5 rounds/, 'acted on, with no run again');
  await push(n);
  const [next] = await claim(n);
  assert.deepEqual([next.round, next.stage], [7, 'ruling'], 'round 6 stays ruled once pushed past');
});
