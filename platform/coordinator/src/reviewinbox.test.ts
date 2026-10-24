// node --test src/reviewinbox.test.ts   (uses a throwaway DATA_DIR)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { harness } from './harness.ts';
import { resetReviewInbox, historicalRedrawDatabase } from './reviewfixture.ts';

const h = await harness('reviewinbox', {
  before: repo =>
    writeFileSync(
      `${repo}/company/projects.yaml`,
      'planning: threads\nprojects:\n  - { id: game, name: The game, owner: wren }\n  - { id: shop, name: The shop, owner: moss }\n',
    ),
});
const { db } = h;
const proposals = await import('./proposals.ts');
const inbox = await import('./reviewinbox.ts');
const projects = await import('./projects.ts');
const order = await import('./threadorder.ts');
const plan = await import('./plan.ts');
const { remember } = await import('./db.ts');
const findings = [
  {
    id: 12,
    domain: 'engine',
    files: ['game.ts'],
    issue: 'The level cannot finish',
    fix: 'Advance its state',
    task: 'Let the level finish',
  },
  { id: 13, domain: 'art', files: ['world.svg', 'ship.svg'], issue: 'The ship is invisible', task: 'Show the ship' },
];
beforeEach(() => {
  resetReviewInbox(db);
  plan.setOwner('game', 'wren', { agent: 'juno', job: 0 }, agent => !!h.jobs.findAgent(agent));
  remember(order.MODE, 'threads');
  projects.createThread({
    project: 'game',
    name: 'The first world plays',
    goal: 'The first world can finish',
    slug: 'world',
  });
});
async function deliver(decision: 'changes' | 'close' = 'changes') {
  const author = await h.start({ agent: 'bolt', title: 'Build the world', thread: 'game/world' });
  const branch = `job/${author.id}`;
  if (decision === 'close') {
    const closure = await import('./reviewclosure.ts');
    closure.hold(branch, 71);
  }
  h.storedPr(71, author.id, decision === 'close' ? 'closed' : 'open', ['game.ts'], { round: 1 });
  return {
    author,
    branch,
    item: proposals.deliverFindings({
      pr: 71,
      round: 1,
      branch,
      agent: 'bolt',
      decision,
      summary: 'The first world needs fixes',
      findings,
    }),
  };
}

const heardBy = () =>
  (db.prepare("select heard_by from proposals where title = 'Review changes on PR #71'").get() as { heard_by: number })
    .heard_by;
const proposalOf71 = () =>
  (db.prepare("select id from proposals where title = 'Review changes on PR #71'").get() as { id: number }).id;
const fixTasks = () =>
  db
    .prepare("select agent, status, thread, branch, round, title from jobs where stage = 'fix' order by id")
    .all()
    .map(j => ({ ...j })) as {
    agent: string;
    status: string;
    thread: string;
    branch: string;
    round: number;
    title: string;
  }[];

test('a thread stays open while any finished task still has a pull request in review', async () => {
  const closure = await import('./reviewclosure.ts');
  const ends = await import('./threadends.ts');
  const pending = h.ended({ agent: 'bolt', thread: 'game/world' });
  const merged = h.ended({ agent: 'bolt', thread: 'game/world' });
  h.storedPr(72, merged, 'merged');
  assert.equal(closure.status(`job/${merged}`), 'merged');
  for (const state of ['open', 'stuck', 'board']) {
    h.storedPr(71, pending, state);
    assert.equal(closure.status(`job/${pending}`), state);
    ends.merged(72);
    assert.equal(projects.findThread('game/world')!.status, 'open');
  }
  h.mergedPr(71);
  ends.merged(71);
  assert.equal(projects.findThread('game/world')!.status, 'done');
});

test('one review inbox item reaches the project owner with domains and files, and shares its planning job', async () => {
  const { author, branch } = await deliver();
  proposals.deliverFindings({
    pr: 71,
    round: 1,
    branch,
    agent: 'bolt',
    decision: 'changes',
    summary: 'same ruling',
    findings,
  });
  assert.equal(proposals.list('wren').filter(p => p.id === 'findings:71').length, 1);
  assert.equal(h.jobs.listJobs().filter(j => j.agent === 'wren' && j.status === 'queued').length, 1);
  const owner = await h.start({ agent: 'wren', title: 'Draw fixes' });
  const threads = projects.listThreads().map(thread => thread.id);
  const refusedThread = await h.agent('proposals/accept', owner.token, {
    id: 'findings:71',
    for: 'kit',
    findings: '12',
    newThread: { project: 'game', name: 'A misplaced fix', goal: 'The world can finish' },
  });
  assert.equal(refusedThread.status, 400);
  assert.deepEqual(
    projects.listThreads().map(thread => thread.id),
    threads,
  );
  assert.deepEqual(inbox.unassigned(71, 1), [12, 13]);
  const read = await h.hq(owner, 'inbox', 'findings:71');
  assert.equal(read.code, 0, read.out);
  assert.match(read.out, /#12 \[engine\] game.ts/);
  assert.match(read.out, /#13 \[art\] world.svg, ship.svg/);
  assert.match(read.out, /Task: Let the level finish[\s\S]*Task: Show the ship/);
  // two unrelated findings are two tasks: drawn together, they need the owner's own title
  const together = await h.hq(owner, 'inbox', 'accept', 'findings:71', '--for', 'kit', '--findings', '12,13');
  assert.equal(together.code, 1, together.out);
  assert.match(together.out, /--title/);
  // a --title that isn't a task's title is refused for that, not replaced
  const overlong = await h.agent('proposals/accept', owner.token, {
    id: 'findings:71',
    for: 'kit',
    findings: '12',
    title: 'x'.repeat(141),
  });
  assert.deepEqual([overlong.status, overlong.body.error], [400, inbox.BAD_TITLE]);
  assert.equal((await h.hq(author, 'inbox', 'accept', 'findings:71', '--for', 'kit', '--findings', '12')).code, 1);
  assert.deepEqual(inbox.unassigned(71, 1), [12, 13]);
  const first = await h.hq(owner, 'inbox', 'accept', 'findings:71', '--for', 'kit', '--findings', '12');
  assert.equal(first.code, 0, first.out);
  assert.deepEqual(inbox.unassigned(71, 1), [13]);
  const second = await h.hq(owner, 'inbox', 'accept', 'findings:71', '--for', 'moss', '--findings', '13');
  assert.equal(second.code, 0, second.out);
  assert.deepEqual(inbox.unassigned(71, 1), []);
  const tasks = inbox.tasks(71, 1);
  assert.deepEqual(
    tasks.map(t => t.findings),
    [[12], [13]],
  );
  // each named by the reviewer for what it fixes, no template left
  assert.deepEqual(
    tasks.map(t => h.job(t.id).title),
    ['Let the level finish', 'Show the ship'],
  );
  assert.equal(proposals.list('bolt').find(p => p.id === 'findings:71')!.status, 'accepted');
});

test('hq job names findings structurally and keeps fixes in the existing thread order', async () => {
  await deliver();
  const owner = await h.start({ agent: 'wren', title: 'Draw the engine fix' });
  const brief = `${h.dataDir}/fix.md`;
  writeFileSync(brief, 'Make the world finish.');
  const made = await h.hq(
    owner,
    'job',
    '--thread',
    'game/world',
    '--findings',
    '12',
    'kit',
    'Repair the world ending',
    brief,
  );
  assert.equal(made.code, 0, made.out);
  assert.deepEqual(
    inbox.tasks(71, 1).map(t => t.findings),
    [[12]],
  );
  const duplicate = await h.hq(owner, 'inbox', 'accept', 'findings:71', '--for', 'kit', '--findings', '12');
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.out, /already names/);
  const missing = await h.hq(owner, 'job', '--thread', 'game/world', 'moss', 'Repair the ship', brief, '--new');
  assert.equal(missing.code, 1);
  assert.match(missing.out, /--findings/);
});

test('a close reaches the same owner as one item and can be dropped without creating an author fix', async () => {
  await deliver('close');
  const owner = await h.start({ agent: 'wren', title: 'Drop the closed slice' });
  const refused = await h.hq(owner, 'inbox', 'accept', 'findings:71', '--for', 'kit', '--findings', '12');
  assert.equal(refused.code, 1);
  const dropped = await h.hq(owner, 'inbox', 'drop', 'findings:71', 'Draw a smaller slice');
  assert.equal(dropped.code, 0, dropped.out);
  assert.equal(inbox.tasks(71, 1).length, 0);
  assert.equal(proposals.list('bolt').find(p => p.id === 'findings:71')!.status, 'dropped');
});

test('touch-ups without blockers reach the assigned worker with their full instructions', async () => {
  const { author, branch } = await deliver();
  h.storedPr(71, author.id, 'open', ['game.ts'], { round: 2 });
  proposals.deliverFindings({
    pr: 71,
    round: 2,
    branch,
    agent: 'bolt',
    decision: 'changes',
    summary: 'Check the safe touch-ups',
    findings: [],
    touchups: 'Keep the renamed level helpers',
    brief: 'Read the touched commit before accepting it.',
  });
  await h.finish(author);
  const owner = await h.claim('claude');
  assert.ok(owner);
  assert.equal(owner.agent, 'wren');
  const made = await h.hq(owner, 'inbox', 'accept', 'findings:71', '--for', 'kit');
  assert.equal(made.code, 0, made.out);
  const check = await h.claim('claude');
  assert.ok(check);
  assert.equal(check.agent, 'kit');
  assert.equal(check.title, 'Keep the renamed level helpers', "the reviewer's title for its touch-ups");
  assert.match(check.prompt, /Read the touched commit before accepting it/);
});

for (const [windowed, stops] of [
  [false, 'ends'],
  [true, 'ends'],
  [true, 'yields'],
  [true, 'parks'],
] as const)
  test(`findings on a thread ${windowed ? `with a window wait in no queued planning job (the session ${stops})` : 'without a window go as before'}, without review.drawWindowedChanges`, async () => {
    const { orderingSnapshot } = await import('./backlog.ts');
    const windows = await import('./windows.ts');
    const deadline = Date.now() + 3_600_000;
    // The owner at work, with an undated ruling waiting in a queued planning job behind older work.
    const session = await h.start({ agent: 'wren', title: 'Plan the shop', engine: 'claude' });
    const unhurried = h.queue({ agent: 'kit', title: 'Tidy the docs', engine: 'claude' });
    const { author, branch } = await deliver();
    const planning = heardBy();
    if (windowed) windows.set(projects.findThread('game/world')!, { deadline, aim: deadline }, 'juno');
    assert.equal(orderingSnapshot(Date.now()).jobs.find(job => job.id === planning)!.due, windowed ? deadline : null);
    // the next round's touch-ups: with a window, the owner's session hears them at once and holds them
    h.storedPr(71, author.id, 'open', ['game.ts'], { round: 2 });
    proposals.deliverFindings(
      { pr: 71, round: 2, branch, agent: 'bolt', decision: 'changes', summary: 'Check the touch-ups', findings: [] },
      { agent: 'bolt', job: author.id },
    );
    assert.equal(heardBy(), windowed ? session.id : planning);
    const told = db.prepare("select job from messages where recipient = 'wren' and text like '%findings:71%'").all();
    assert.deepEqual(
      told.map(m => m.job),
      windowed ? [session.id] : [],
    );
    // the session stops running without deciding them: the planning job holds them again, drawn first by the window,
    // and the unread notice lapses rather than becoming a job too
    if (stops === 'parks') await h.park(session, {});
    else
      await h.finish(session, stops === 'yields' ? { status: 'yielded', session: 'its-session' } : { status: 'done' });
    proposals.sweep();
    assert.equal(heardBy(), planning);
    assert.deepEqual(
      (h.jobs.listJobs() as { id: number; agent: string; status: string }[])
        .filter(job => job.agent === 'wren' && job.id !== session.id && ['queued', 'running'].includes(job.status))
        .map(job => job.id),
      [planning],
    );
    if (windowed)
      assert.deepEqual(
        db
          .prepare("select became, lapsed is not null lapsed from messages where text like '%findings:71%'")
          .all()
          .map(m => ({ ...m })),
        [{ became: null, lapsed: 1 }],
      );
    assert.equal(fixTasks().length, 0);
    assert.equal((await h.claim('claude'))?.id, windowed ? planning : unhurried);
  });

test('deadline review findings give the idle CEO a planning job instead of waiting for the summary', async () => {
  const windows = await import('./windows.ts');
  const { orderingSnapshot } = await import('./backlog.ts');
  plan.setOwner('game', 'juno', { agent: 'juno', job: 0 }, agent => !!h.jobs.findAgent(agent));
  const deadline = Date.now() + 3_600_000;
  windows.set(projects.findThread('game/world')!, { deadline, aim: deadline }, 'juno');
  await deliver();
  const planning = h.job(heardBy());
  assert.equal(planning.agent, 'juno');
  assert.equal(planning.status, 'queued');
  assert.equal(planning.title, 'Sort new proposals into the plan');
  assert.equal(orderingSnapshot(Date.now()).jobs.find(job => job.id === planning.id)!.due, deadline);
});

test('an automatically drawn fix rejects missing task titles before accepting its ruling', async t => {
  const org = `${h.repo}/company/org.yaml`,
    before = readFileSync(org, 'utf8');
  writeFileSync(org, before + '\nreview:\n  drawWindowedChanges: true\n');
  t.after(() => writeFileSync(org, before));
  const windows = await import('./windows.ts');
  const deadline = Date.now() + 3_600_000;
  windows.set(projects.findThread('game/world')!, { deadline, aim: deadline }, 'juno');
  const author = await h.start({ agent: 'bolt', title: 'Build the world', thread: 'game/world' });
  h.storedPr(71, author.id, 'open', ['game.ts'], { round: 1 });
  const ruler = await h.start({ agent: 'quill', kind: 'consolidate', stage: 'ruling', pr: 71, round: 1 });
  const check = (task?: string) =>
    h.agent('review-output', ruler.token, {
      output: JSON.stringify({
        decision: 'changes',
        blocking: [{ file: 'game.ts', line: 1, issue: 'The level cannot finish', task }],
      }),
    });
  assert.match((await check()).body.error, /blocking finding 1's "task"/);
  assert.match((await check('x'.repeat(141))).body.error, /blocking finding 1's "task"/);
  assert.equal((await check('Let the level finish')).body.error, null);
  assert.equal(inbox.get(71), undefined, 'no ruling or fix task was accepted');
  assert.deepEqual(fixTasks(), []);
});

test('a transferred project sends the open findings to its new owner through the same inbox', async () => {
  await deliver();
  const ceo = await h.start({ agent: 'juno', title: 'Hand the project on' });
  const changed = await h.agent('projects/owner', ceo.token, { id: 'game', owner: 'moss' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(proposals.list('moss').find(p => p.id === 'findings:71')!.owner, 'moss');
  assert.equal(
    proposals.list('wren').find(p => p.id === 'findings:71'),
    undefined,
  );
});

// Lyra's findings:2064 on 23 Oct: a windowed thread's ruling sat 27 minutes in the inbox while her running sessions
// worked on other things
test('with review.drawWindowedChanges, a windowed thread\'s "changes" ruling gives its author a fix task at once, whatever the owner\'s session does', async t => {
  const org = `${h.repo}/company/org.yaml`,
    before = readFileSync(org, 'utf8');
  writeFileSync(org, before + '\nreview:\n  drawWindowedChanges: true\n');
  t.after(() => writeFileSync(org, before));
  const windows = await import('./windows.ts');
  const deadline = Date.now() + 3_600_000;
  windows.set(projects.findThread('game/world')!, { deadline, aim: deadline }, 'juno');
  const session = await h.start({ agent: 'wren', title: 'Plan the shop', engine: 'claude' });
  const { author, branch } = await deliver();
  const world = projects.findThread('game/world')!.id;
  assert.deepEqual(fixTasks(), [
    { agent: 'bolt', status: 'queued', thread: world, branch, round: 1, title: 'Let the level finish' },
    { agent: 'bolt', status: 'queued', thread: world, branch, round: 1, title: 'Show the ship' },
  ]);
  assert.deepEqual(
    inbox.tasks(71, 1).map(t => t.findings),
    [[12], [13]],
  );
  assert.equal(proposals.list('bolt').find(p => p.id === 'findings:71')!.status, 'accepted');
  // no planning job, and the busy session holds nothing
  assert.deepEqual(
    (h.jobs.listJobs() as { id: number; agent: string; status: string }[]).filter(
      job => job.agent === 'wren' && job.status === 'queued',
    ),
    [],
  );
  // the next round's touch-ups: the author checks them, and the owner's session hears of the task
  h.storedPr(71, author.id, 'open', ['game.ts'], { round: 2 });
  proposals.deliverFindings(
    {
      pr: 71,
      round: 2,
      branch,
      agent: 'bolt',
      decision: 'changes',
      summary: 'Check the touch-ups',
      findings: [],
      touchups: 'Check the review touch-ups',
    },
    { agent: 'bolt', job: author.id },
  );
  const check = fixTasks().find(t => t.round === 2);
  assert.deepEqual(check && { agent: check.agent, thread: check.thread, title: check.title }, {
    agent: 'bolt',
    thread: world,
    title: 'Check the review touch-ups',
  });
  const told = db.prepare("select job, held, text from messages where recipient = 'wren'").all() as {
    job: number;
    held: number | null;
    text: string;
  }[];
  assert.deepEqual(
    told.map(m => ({ job: m.job, held: m.held })),
    [{ job: session.id, held: proposalOf71() }],
  );
  assert.match(told[0].text, /findings:71/);
  // the session ends without reading it: the notice lapses, and no planning or message job follows
  await h.finish(session, { status: 'done' });
  proposals.sweep();
  assert.deepEqual(
    (h.jobs.listJobs() as { agent: string; status: string }[]).filter(j => j.agent === 'wren' && j.status === 'queued'),
    [],
  );
  assert.deepEqual(
    {
      ...(db
        .prepare("select became, lapsed is not null lapsed from messages where recipient = 'wren'")
        .get() as object),
    },
    { became: null, lapsed: 1 },
  );
});

// findings:2004 on 23 Oct: round 1's touch-ups still open after round 2 had started
test('a "changes" item a later round has left closes by itself', async () => {
  const { author } = await deliver();
  proposals.sweep();
  assert.equal(proposals.list('wren').find(p => p.id === 'findings:71')!.status, 'open');
  h.storedPr(71, author.id, 'open', ['game.ts'], { round: 2 });
  proposals.sweep();
  const closed = proposals.list('bolt').find(p => p.id === 'findings:71')!;
  assert.equal(closed.status, 'dropped');
  assert.equal(closed.why, "Round 1's findings closed by themselves: round 2 has started");
  assert.equal(
    proposals.list('wren').find(p => p.id === 'findings:71' && p.status === 'open'),
    undefined,
  );
});

test('a round ruled "changes" with no fix task drawn has no merge in sight', async () => {
  const { author } = await deliver();
  await h.finish(author);
  const owner = await h.start({ agent: 'wren', title: 'Read the plan' });
  const read = await h.hq(owner, 'thread', 'game/world');
  assert.equal(read.code, 0, read.out);
  assert.match(read.out, /no fix task is drawn \(findings:71, wren's to decide\)/);
  assert.doesNotMatch(read.out, /merged about/);
  assert.equal(
    (
      await h.hq(
        owner,
        'inbox',
        'accept',
        'findings:71',
        '--for',
        'bolt',
        '--findings',
        '12,13',
        '--title',
        'Finish the level, show the ship',
      )
    ).code,
    0,
  );
  const drawn = await h.hq(owner, 'thread', 'game/world');
  assert.doesNotMatch(drawn.out, /no fix task is drawn/);
});

test('a transferred project sends the open findings to its new owner through the same inbox', async () => {
  await deliver();
  const ceo = await h.start({ agent: 'juno', title: 'Hand the project on' });
  const changed = await h.agent('projects/owner', ceo.token, { id: 'game', owner: 'moss' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(proposals.list('moss').find(p => p.id === 'findings:71')!.owner, 'moss');
  assert.equal(
    proposals.list('wren').find(p => p.id === 'findings:71'),
    undefined,
  );
});

test('ordinary tasks stay ordinary after all findings are assigned and during a touch-up-only review', async () => {
  const { author, branch } = await deliver();
  const owner = await h.start({ agent: 'wren', title: 'Draw tasks' });
  assert.equal(
    (
      await h.hq(
        owner,
        'inbox',
        'accept',
        'findings:71',
        '--for',
        'kit',
        '--findings',
        '12,13',
        '--title',
        'Finish the level and show the ship',
      )
    ).code,
    0,
  );
  const made = await h.agent('job', owner.token, {
    agent: 'moss',
    title: 'Improve the next move',
    prompt: 'Do it',
    thread: 'game/world',
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(inbox.context(made.body.id), undefined);
  h.storedPr(71, author.id, 'open', ['game.ts'], { round: 2 });
  proposals.deliverFindings({
    pr: 71,
    round: 2,
    branch,
    agent: 'bolt',
    decision: 'changes',
    summary: 'Check touch-ups',
    findings: [],
    touchups: 'Keep the renamed level helpers',
  });
  const next = await h.agent('job', owner.token, {
    agent: 'moss',
    title: 'Another planned step',
    prompt: 'Do it',
    thread: 'game/world',
  });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(inbox.context(next.body.id), undefined);
});

test('stale findings from a closed PR or an older round do not intercept new thread work', async () => {
  const { author } = await deliver();
  const owner = await h.start({ agent: 'wren', title: 'Continue the plan' });
  h.storedPr(71, author.id, 'closed', ['game.ts'], { round: 1 });
  const next = await h.agent('job', owner.token, {
    agent: 'moss',
    title: 'Continue the world',
    prompt: 'Do it',
    thread: 'game/world',
  });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(inbox.context(next.body.id), undefined);
  h.storedPr(71, author.id, 'open', ['game.ts'], { round: 2 });
  const stale = await h.agent('proposals/accept', owner.token, { id: 'findings:71', for: 'kit', findings: '12' });
  assert.equal(stale.status, 400);
});

test('threadless findings bind the reviewed work to a permitted canonical thread through inbox acceptance', async () => {
  const author = await h.start({ agent: 'juno', title: 'A front desk task' });
  const branch = `job/${author.id}`;
  h.storedPr(72, author.id, 'open', ['game.ts'], { round: 1 });
  proposals.deliverFindings({
    pr: 72,
    round: 1,
    branch,
    agent: 'bolt',
    decision: 'changes',
    summary: 'Fix the world',
    findings,
  });
  await h.finish(author);
  const other = await h.start({ agent: 'wren', title: 'Attempt projectless binding' });
  assert.equal(
    (
      await h.agent('proposals/accept', other.token, {
        id: 'findings:72',
        for: 'kit',
        findings: '12',
        thread: 'game/world',
      })
    ).status,
    400,
  );
  assert.equal(h.job(author.id).thread, null);
  await h.finish(other);
  const ceo = await h.start({ agent: 'juno', title: 'Bind the findings' });
  const reply = await h.agent('proposals/accept', ceo.token, {
    id: 'findings:72',
    for: 'kit',
    findings: '12,13',
    title: 'Finish the level and show the ship',
    thread: 'game/world',
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(h.job(author.id).thread, 'game/world');
  assert.equal(h.job(reply.body.job).thread, 'game/world');
  const check = await h.claim('claude');
  assert.equal(check?.id, reply.body.job);
  assert.equal(check?.branch, branch);
});

test('slug renames and project moves keep findings on the canonical thread with the new owner', async () => {
  await deliver();
  const owner = await h.start({ agent: 'wren', title: 'Rename its slice' });
  const plan = await import('./plan.ts'),
    regroup = await import('./regroup.ts');
  assert.equal(typeof plan.rename('game/world', { name: 'The new world plays', slug: 'new-world' }, 'wren'), 'object');
  const first = await h.agent('proposals/accept', owner.token, {
    id: 'findings:71',
    for: 'kit',
    findings: '12',
    thread: 'game/world',
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(h.job(first.body.job).thread, 'game/new-world');
  assert.equal(typeof regroup.moveThread('game/new-world', 'shop', 'juno'), 'object');
  assert.equal(proposals.list('moss').find(p => p.id === 'findings:71')?.owner, 'moss');
  assert.equal(
    (await h.agent('proposals/accept', owner.token, { id: 'findings:71', for: 'kit', findings: '13' })).status,
    400,
  );
  const newOwner = await h.start({ agent: 'moss', title: 'Draw the moved fix' });
  const last = await h.agent('proposals/accept', newOwner.token, {
    id: 'findings:71',
    for: 'kit',
    findings: '13',
    thread: 'game/world',
  });
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.equal(h.job(last.body.job).thread, 'shop/new-world');
});

for (const entry of ['inbox', 'job'])
  test(`${entry} reassigns several failed findings without leaving failures in thread order`, async () => {
    const { author } = await deliver();
    h.cancelQueued();
    const owner = await h.start({ agent: 'wren', title: 'Redraw failed fixes' });
    for (const finding of findings)
      assert.equal(
        (
          await h.agent('proposals/accept', owner.token, {
            id: 'findings:71',
            for: 'kit',
            findings: String(finding.id),
          })
        ).status,
        200,
      );
    const failed = inbox.tasks(71, 1).map(task => task.id);
    h.failedJobs(...failed);
    await h.finish(author);
    const replacement =
      entry === 'inbox'
        ? await h.agent('proposals/accept', owner.token, {
            id: 'findings:71',
            for: 'kit',
            findings: '12,13',
            title: 'Finish the level and show the ship',
          })
        : await h.agent('job', owner.token, {
            agent: 'kit',
            title: 'Repair both failed fixes',
            prompt: 'Fix them',
            thread: 'game/world',
            findings: '12,13',
          });
    assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
    const job = replacement.body.job ?? replacement.body.id;
    assert.equal(order.reader().waits(job, 'game/world').failed, null);
    const next = await h.claim('claude');
    assert.equal(next?.id, job);
    assert.ok(next?.prompt.includes('finding #12') && next?.prompt.includes('finding #13'));
  });

test('a newer pull request in the same thread wins over an older unrelated round number', async () => {
  const { author, branch } = await deliver();
  h.storedPr(71, author.id, 'open', ['game.ts'], { round: 9 });
  proposals.deliverFindings({
    pr: 71,
    round: 9,
    branch,
    agent: 'bolt',
    decision: 'changes',
    summary: 'Old branch',
    findings,
  });
  await h.finish(author);
  const later = await h.start({ agent: 'lark', title: 'Another branch in this thread', thread: 'game/world' });
  h.storedPr(72, later.id, 'open', ['draw.ts'], { round: 1 });
  proposals.deliverFindings({
    pr: 72,
    round: 1,
    branch: `job/${later.id}`,
    agent: 'bolt',
    decision: 'changes',
    summary: 'Current branch',
    findings: [{ ...findings[1], id: 99 }],
  });
  const owner = await h.start({ agent: 'wren', title: 'Fix the current branch' });
  const reply = await h.agent('job', owner.token, {
    agent: 'kit',
    title: 'Fix the current drawing',
    thread: 'game/world',
    prompt: 'Fix it',
    findings: '99',
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.deepEqual(
    inbox.tasks(72, 1).map(task => task.findings),
    [[99]],
  );
});

for (const entry of ['inbox', 'job'])
  test(`${entry} assigns moved branch findings under the destination project's owner`, async () => {
    const { author, branch } = await deliver();
    projects.createThread({
      project: 'shop',
      name: 'Checkout works',
      goal: 'Checkout completes',
      slug: 'checkout',
    });
    const ceo = await h.start({ agent: 'juno', title: 'Move the reviewed work' });
    const moved = await h.hq(ceo, 'job', 'move', String(author.id), 'shop/checkout');
    assert.equal(moved.code, 0, moved.out);
    assert.equal(proposals.list('moss').find(p => p.id === 'findings:71')?.owner, 'moss');
    assert.equal(
      proposals.list('wren').find(p => p.id === 'findings:71'),
      undefined,
    );
    const assign = (token: string) =>
      entry === 'inbox'
        ? h.agent('proposals/accept', token, { id: 'findings:71', for: 'kit', findings: '12' })
        : h.agent('job', token, {
            agent: 'kit',
            title: 'Repair the moved world',
            prompt: 'Fix it',
            thread: 'shop/checkout',
            findings: '12',
          });
    const oldOwner = await h.start({ agent: 'wren', title: 'Read the former findings' });
    assert.equal((await assign(oldOwner.token)).status, entry === 'inbox' ? 400 : 409);
    const owner = await h.start({ agent: 'moss', title: 'Draw the moved fixes' });
    const reply = await assign(owner.token);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const task = h.job(reply.body.job ?? reply.body.id);
    assert.equal(task.thread, 'shop/checkout');
    assert.equal(task.branch, branch);
    assert.deepEqual(inbox.unassigned(71, 1), [13]);
  });

function redrawThread(slug: string, project = 'game') {
  return projects.createThread({
    project,
    name: slug,
    goal: 'The work lands',
    slug,
  });
}
async function closedWorld() {
  const source = await deliver('close');
  await h.finish(source.author);
  h.cancelQueued();
  const owner = await h.start({ agent: 'wren', title: 'Decide the closed review' });
  return { ...source, owner };
}

for (const decision of ['drop', 'redraw'])
  test(`a closed review holds ordinary continuations before its owner chooses to ${decision}`, async () => {
    const { author, owner } = await closedWorld();
    const first = h.queue({ agent: 'kit', thread: 'game/world', queuedBy: 'wren' });
    const second = h.queue({ agent: 'moss', thread: 'game/world', queuedBy: 'wren' });
    assert.deepEqual(
      h.job(first).waits.map((wait: { id: number }) => wait.id),
      [author.id],
    );
    assert.equal(h.job(first).ready, 0);
    assert.equal(typeof plan.move(second, 1, 'wren'), 'object');
    assert.equal(h.job(second).ready, 0, 'reordering cannot release the closed-review hold');
    assert.equal(typeof plan.drop(second, 'The other continuation is enough', 'wren'), 'object');
    const added = h.queue({ agent: 'lark', thread: 'game/world', queuedBy: 'wren' });
    assert.equal(h.job(first).ready, 0, 'cancelling the next task keeps the remaining task held');
    assert.equal(h.job(added).ready, 0, 'new work inherits the pending decision');
    redrawThread('elsewhere');
    const moved = await h.agent('jobs/move', owner.token, { id: first, thread: 'game/elsewhere' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(h.job(first).ready, 0, 'moving out retains the pending hold');
    const incoming = h.queue({ agent: 'kit', thread: 'game/elsewhere', queuedBy: 'wren' });
    assert.equal((await h.agent('jobs/move', owner.token, { id: incoming, thread: 'game/world' })).status, 200);
    assert.equal(h.job(incoming).ready, 0, 'moving in inherits the pending hold');
    if (decision === 'drop') {
      const reply = await h.agent('proposals/drop', owner.token, {
        id: 'findings:71',
        why: 'The work is no longer needed',
      });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      const wait = await h.agent('waits', owner.token, { id: first, to: author.id });
      assert.equal(wait.status, 409, 'dropped work has not merged');
    } else {
      redrawThread('replacement');
      const reply = await h.agent('proposals/accept', owner.token, {
        id: 'findings:71',
        for: 'bolt',
        thread: 'game/replacement',
      });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.deepEqual(
        h.job(first).waits.map((wait: { id: number }) => wait.id),
        [reply.body.job],
      );
      const wait = await h.agent('waits', owner.token, { id: reply.body.job, to: first });
      assert.equal(wait.status, 409, 'a redraw cannot wait for its continuation');
      const pause = await h.agent('pauses', owner.token, {
        thread: 'game/replacement',
        why: 'Wait for the continuation',
        until: [first],
      });
      assert.equal(pause.status, 400, 'a pause cannot hold the redraw that its continuation needs');
      const replacement = await h.claim();
      assert.equal(replacement?.id, reply.body.job);
      assert.equal(h.job(first).ready, 0);
      await h.finish(replacement!);
      h.storedPr(72, replacement!.id, 'merged');
      const ends = await import('./threadends.ts');
      ends.merged(72);
    }
    assert.equal(h.job(first).ready, 1);
  });

test('hq job move refuses a cross-thread replacement cycle without moving its work or inbox', async () => {
  const { owner } = await closedWorld();
  redrawThread('independent');
  redrawThread('dependent', 'shop');
  assert.equal(typeof plan.need('shop/dependent', 'game/world', 'juno'), 'object');
  const made = await h.agent('proposals/accept', owner.token, {
    id: 'findings:71',
    for: 'bolt',
    thread: 'game/independent',
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const ceo = await h.start({ agent: 'juno' });
  const before = inbox.get(71);
  const refused = await h.agent('jobs/move', ceo.token, { id: made.body.job, thread: 'shop/dependent' });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), /cycle/);
  assert.equal(h.job(made.body.job).thread, 'game/independent');
  assert.deepEqual(inbox.get(71), before);
  redrawThread('safe', 'shop');
  const moved = await h.agent('jobs/move', ceo.token, { id: made.body.job, thread: 'shop/safe' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(h.job(made.body.job).thread, 'shop/safe');
});

test('a redraw failed before its PR follows non-cancelled lands takeovers through merge and settlement', async () => {
  const { owner, branch, author } = await closedWorld();
  redrawThread('replacement');
  redrawThread('paused');
  const pauses = await import('./pauses.ts');
  const explicit = h.queue({ agent: 'kit', queuedBy: 'wren' });
  h.jobs.holdForMerge(explicit, author.id, 'wren');
  const made = await h.agent('proposals/accept', owner.token, {
    id: 'findings:71',
    for: 'bolt',
    thread: 'game/replacement',
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(
    typeof pauses.pause({ thread: 'game/paused', why: 'It needs the redraw', until: [made.body.job] }, 'wren'),
    'object',
  );
  const source = h.queue({ agent: 'kit', thread: 'game/world' });
  const first = await h.claim();
  assert.equal(first?.id, made.body.job);
  await h.finish(first!, { status: 'failed', result: 'Failed before opening a PR' });
  const notice = await h.claim();
  assert.equal(notice?.agent, 'wren');
  await h.finish(notice!);
  const takeover = () =>
    h.agent('job', owner.token, { agent: 'bolt', title: 'Land the saved redraw', lands: first!.id });
  const cancelled = await takeover();
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal((await h.agent('cancel', owner.token, { id: cancelled.body.id, why: 'Assign it again' })).status, 200);
  assert.deepEqual(
    h.job(source).waits.map((wait: { id: number }) => wait.id),
    [first!.id],
  );
  const next = await takeover();
  assert.equal(next.status, 200, JSON.stringify(next.body));
  const destination = h.queue({ agent: 'moss', thread: 'game/replacement' });
  assert.deepEqual(
    h.job(source).waits.map((wait: { id: number }) => wait.id),
    [next.body.id],
  );
  const second = await h.claim();
  assert.equal(second?.id, next.body.id);
  await h.finish(second!, { status: 'failed', result: 'The saved-work attempt also failed before a PR' });
  const secondNotice = await h.claim();
  if (secondNotice) {
    assert.equal(secondNotice.agent, 'wren');
    await h.finish(secondNotice);
  }
  const last = await h.agent('job', owner.token, {
    agent: 'bolt',
    title: 'Finish the saved redraw',
    lands: second!.id,
  });
  assert.equal(last.status, 200, JSON.stringify(last.body));
  const historical = await historicalRedrawDatabase(db);
  const script = `const jobs = await import(${JSON.stringify(new URL('./jobs.ts', import.meta.url).href)});
    console.log(JSON.stringify(jobs.outstandingWaits(${source}).map(job => job.id)));`;
  try {
    for (let start = 0; start < 2; start++)
      assert.deepEqual(
        JSON.parse(
          execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            env: { ...process.env, DATA_DIR: historical, REPO_DIR: h.repo },
            encoding: 'utf8',
          }),
        ),
        [last.body.id],
        'a pre-edge database preserves its saved-work takeover after each restart',
      );
  } finally {
    rmSync(historical, { recursive: true });
  }

  assert.deepEqual(
    h.job(source).waits.map((wait: { id: number }) => wait.id),
    [last.body.id],
  );
  redrawThread('cyclic');
  assert.equal(typeof plan.need('game/cyclic', 'game/world', 'wren'), 'object');
  const refused = await h.agent('jobs/move', owner.token, { id: last.body.id, thread: 'game/cyclic' });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(h.job(last.body.id).thread, 'game/replacement');
  const replacement = await h.claim();
  assert.equal(replacement?.id, last.body.id);
  assert.equal(h.job(source).ready, 0);
  assert.equal(h.job(destination).ready, 0);
  await h.finish(replacement!);
  h.storedPr(72, replacement!.id, 'merged');
  const closure = await import('./reviewclosure.ts');
  const ends = await import('./threadends.ts');
  ends.merged(72);
  assert.equal(closure.status(branch), 'merged');
  assert.equal(h.job(source).ready, 1);
  assert.equal(h.job(explicit).ready, 1, 'redirected explicit waits settle through the saved-work lineage');
  pauses.sweep();
  assert.equal(
    pauses.open().some(pause => pause.target === 'game/paused'),
    false,
  );
  assert.equal(h.job(destination).ready, 1);
  assert.equal(projects.findThread('game/world')?.branch, null);
});

for (const state of ['reviewing', 'unassigned', 'assigned', 'touchups']) {
  test(`a cyclic move of a replacement review rolls back ${state} work and inbox ownership together`, async () => {
    const { owner } = await closedWorld();
    redrawThread('independent');
    redrawThread('dependent', 'shop');
    assert.equal(typeof plan.need('shop/dependent', 'game/world', 'juno'), 'object');
    const made = await h.agent('proposals/accept', owner.token, {
      id: 'findings:71',
      for: 'bolt',
      thread: 'game/independent',
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const replacement = await h.claim();
    assert.equal(replacement?.id, made.body.job);
    await h.finish(replacement!);
    h.storedPr(72, replacement!.id, 'open', ['game.ts'], { round: 1 });
    const deliverReview = () =>
      proposals.deliverFindings({
        pr: 72,
        round: 1,
        branch: `job/${replacement!.id}`,
        agent: 'bolt',
        decision: 'changes',
        summary: 'The redraw needs fixes',
        findings: state === 'touchups' ? [] : findings,
      });
    if (state !== 'reviewing') deliverReview();
    const fixed =
      state === 'assigned'
        ? await h.agent('proposals/accept', owner.token, {
            id: 'findings:72',
            for: 'kit',
            findings: '12,13',
            title: 'Finish the level and show the ship',
          })
        : undefined;
    if (fixed) assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    else if (state === 'unassigned') assert.deepEqual(inbox.unassigned(72, 1), [12, 13]);
    const before = inbox.get(72);
    const ceo = await h.start({ agent: 'juno' });
    const refused = await h.agent('jobs/move', ceo.token, { id: replacement!.id, thread: 'shop/dependent' });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.match(JSON.stringify(refused.body), /cycle/);
    assert.equal(h.job(replacement!.id).thread, 'game/independent');
    if (fixed) assert.equal(h.job(fixed.body.job).thread, 'game/independent');
    assert.deepEqual(inbox.get(72), before);
    if (before) assert.equal(proposals.list('bolt').find(item => item.id === 'findings:72')?.owner, 'wren');
    redrawThread('safe', 'shop');
    const moved = await h.agent('jobs/move', ceo.token, { id: replacement!.id, thread: 'shop/safe' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(h.job(replacement!.id).thread, 'shop/safe');
    if (state === 'reviewing') deliverReview();
    assert.equal(inbox.get(72)?.thread, 'shop/safe');
    assert.equal(proposals.list('bolt').find(item => item.id === 'findings:72')?.owner, 'moss');
    const nextOwner = await h.start({ agent: 'moss' });
    const fix =
      fixed ??
      (await h.agent('proposals/accept', nextOwner.token, {
        id: 'findings:72',
        for: 'kit',
        ...(state === 'touchups' ? {} : { findings: '12,13' }),
        title: 'Finish the level and show the ship',
      }));
    assert.equal(fix.status, 200, JSON.stringify(fix.body));
    assert.equal(h.job(fix.body.job).thread, 'shop/safe');
    assert.equal(h.job(fix.body.job).ready, 1, 'the replacement fixes can run in a destination without the cycle');
  });
}
