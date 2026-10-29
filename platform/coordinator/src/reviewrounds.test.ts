// Queue-time estimate contract fixtures.
// node --test src/reviewrounds.test.ts   (uses a throwaway DATA_DIR; GitHub is played by the harness)
// The formal review process through the review's own routes: each round's briefing by its stage, and what the reviews
// leave going into the author's follow-up job.
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
const inbox = await import('./reviewinbox.ts');
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
  const fix = draw(n);
  const job = fix
    ? ((await h.claimJob(fix.id)) as Run)
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
const json = (o: object) => ({ output: JSON.stringify({ major_visual: false, ...o }) });
const at = (line: number, issue: string, file = FILE) => ({
  file,
  line,
  case: 'x',
  issue,
  fix: 'y',
  task: `Fix ${issue}`,
  by: ['quill'],
});
const findingsOf = (n: number) =>
  db.prepare('select id, kind, issue, outcome from findings where pr = ? order by id').all(n) as {
    id: number;
    kind: string;
    issue: string;
    outcome: string | null;
  }[];
// PR n's queued fix task. (A thread's findings go to its project's owner: wren draws the round's blocking ones as one
// task for its author first, if they're still in the inbox.)
function draw(n: number) {
  const item = inbox.get(n);
  const left = item ? inbox.unassigned(n, item.round) : [];
  if (left.length) {
    const made = proposals.accept(`findings:${n}`, 'wren', { for: 'bolt', findings: left, title: `Fix PR #${n}` });
    assert.equal(typeof made, 'object', String(made));
  }
  return db
    .prepare("select id, prompt from jobs where branch = ? and kind = 'work' and stage = 'fix' and status = 'queued'")
    .get(`review/${n}`) as { id: number; prompt: string } | undefined;
}
const fixPrompt = (n: number) => draw(n)!.prompt;
const bundles = () =>
  db.prepare("select id from proposals where title like 'Review follow-ups%'").all() as { id: number }[];
const followUps = () =>
  db
    .prepare(
      "select id, agent, thread, title, prompt, status from jobs where kind = 'work' and stage is null and title like 'Review follow-ups:%' order by id",
    )
    .all() as { id: number; agent: string; thread: string | null; title: string; prompt: string; status: string }[];

test('each round gets the briefing of its stage, and what the reviews leave goes to the author as one follow-up job', async () => {
  const n = 601;
  await push(n);
  const panel = await claim(n, 'review');
  for (const run of panel) {
    assert.match(run.prompt, /## Round 1: the first look/);
    assert.match(run.prompt, /The first look is free for all/);
    assert.match(run.prompt, /On\s+what's shipped to users, code the next person can't live with blocks too/);
    assert.match(
      run.prompt,
      /On everything else, the\s+company's internal work[\s\S]*it breaks HQ or the\s+work it carries, it loops without end, or it loses data/,
    );
    await end(run);
  }
  const [ruling] = await claim(n, 'consolidate');
  assert.match(ruling.prompt, /in the first look, so does code the next person can't live with/);
  assert.match(ruling.prompt, /Then make the safe\s+nonblocking fixes too/);
  assert.doesNotMatch(ruling.prompt, /"upstream"/);
  await end(
    ruling,
    json({
      blocking: [at(3, 'the score adds the bonus twice'), at(7, 'a name that says nothing')],
      nonblocking: [at(30, 'a long function')],
      pre_existing: [
        at(9, 'the ship is drawn twice', 'kits/art/ship.ts'),
        at(2, 'an old loop', 'products/game/old.ts'),
      ],
      decision: 'changes',
      summary: 'one',
    }),
  );
  const [bonus, name, long] = findingsOf(n).filter(f => f.kind !== 'pre-existing');
  assert.deepEqual([bonus.kind, name.kind, long.kind], ['blocking', 'blocking', 'nonblocking']);
  assert.match(fixPrompt(n), /Fix or answer each nonblocking one too/);

  // round 2, a later round: only blocking findings hold the merge; the rest is the follow-up job's
  await push(n);
  const [check] = await claim(n);
  assert.equal(check.stage, 'ruling');
  assert.match(check.prompt, /Only those block now/);
  assert.match(check.prompt, /a change that doesn't do what the board asked/);
  assert.match(check.prompt, /"nonblocking": \[the same shape\]/);
  assert.match(check.prompt, /With no\s+blocking finding, decide "merge"/);
  const refused = await h.agent('review-output', check.token, {
    output: JSON.stringify({
      major_visual: false,
      outcomes: [bonus, name, long].map(f => ({ finding: f.id, outcome: 'fixed' })),
      decision: 'changes',
      blocking: [],
      nonblocking: [at(12, 'tidy')],
    }),
  });
  assert.match(String(refused.body.error), /from a later round on only blocking findings hold the merge/);
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
  assert.match(fixPrompt(n), /Leave the nonblocking findings/);

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
  // one job for the author, in the same deliverable, with every finding that didn't hold the merge
  await until(() => followUps().length === 1, 'the follow-up job queued');
  const [job] = followUps();
  assert.deepEqual([job.agent, job.thread, job.status], ['bolt', 'game/world', 'queued']);
  for (const issue of [
    'a name that says nothing',
    'the helper could be shorter',
    'a comment says what, not why',
    'an old loop',
    'the ship is drawn twice',
  ])
    assert.ok(job.prompt.includes(issue), issue);
  assert.ok(!job.prompt.includes('the bonus'), 'what blocked is fixed on the pull request');
  assert.deepEqual(
    findingsOf(n)
      .filter(f => f.issue.includes('long'))
      .map(f => f.id),
    [long.id],
    'an earlier finding moved into the follow-ups keeps its number',
  );
  assert.equal(job.prompt.match(/long function/g)?.length, 1);
  assert.equal(bundles().length, 0, "no proposal in the owner's inbox");

  // the follow-up's own pull request merges with findings of its own, and they end there: no follow-up of a follow-up
  const m = 602;
  const run = (await h.claimJob(job.id)) as Run;
  await end(run, {
    pr: m,
    branch: `job/${job.id}`,
    files: [FILE],
    sha: randomBytes(20).toString('hex'),
    lines: { [FILE]: [[1, 10]] },
    result: 'Fixed the follow-ups worth fixing.',
  });
  for (const r of await claim(m, 'review')) await end(r);
  const [quill] = await claim(m, 'consolidate');
  await end(quill, json({ blocking: [], nonblocking: [at(5, 'a magic number')], decision: 'merge', summary: 'ok' }));
  await until(() => findingsOf(m).length === 1, "the follow-up's own finding recorded");
  await until(
    () => db.prepare("select 1 from prs where number = ? and status = 'merged'").get(m) !== undefined,
    'merged',
  );
  assert.equal(followUps().length, 1);
});

test("a first round near its thread's deadline is a later one, and the upstream round shows what went wrong before review", async t => {
  const thread = projects.findThread('game/levels')!;
  const deadline = Date.now() + 2 * 3_600_000;
  windows.set(thread, { deadline, aim: deadline }, 'juno');
  const n = 603;
  await push(n, 'game/levels');
  const panel = await claim(n, 'review');
  for (const run of panel) {
    assert.match(run.prompt, /## Round 1: the deliverable's deadline is near/);
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
  // (a thread of its own: the first world's ended with its merges, and its owner draws fixes only into an open one)
  projects.createThread({ project: 'game', name: 'Ships land', goal: 'Every ship can land', slug: 'ships' });
  await push(n, 'game/ships');
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
