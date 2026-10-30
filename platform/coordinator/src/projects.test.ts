// node --test src/projects.test.ts   (projects, threads and their inheritance; throwaway DATA_DIR and REPO_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';

// The test company's projects, which ask every job for a thread, under their businesses, and a schedule entry in one.
const PROJECTS = `requireThread: true
made:
  errors: { care: shop }
businesses:
  - { id: play, name: Play, cover: covers/play.png, owner: wren, style: pixel }
  - { id: trade, name: Trade }
groups:
  recurring: { cover: covers/recurring.png }
covers:
  game: covers/game.png
projects:
  - { id: game, name: The game, owner: wren, business: play }
  - { id: shop, name: The shop, owner: moss, product: shop, business: trade }
  - { id: broken, name: No owner }
`;
const h = await harness('projects', {
  before: repo => {
    writeFileSync(`${repo}/company/projects.yaml`, PROJECTS);
    writeFileSync(
      `${repo}/company/schedule.yaml`,
      `
- { id: sweep, agent: bolt, at: "00:00", title: Log scan, prompt: Scan the logs. }
- { id: round, agent: juno, at: "00:00", title: Round, prompt: Go round. }
`,
    );
  },
});
const { db, jobs } = h;
const projects = await import('./projects.ts');
const plan = await import('./plan.ts');
const schedule = await import('./schedule.ts');
const ledger = await import('./ledger.ts');
const meetings = await import('./meetings.ts');
const routinesFixture = await import('./schedule.fixture.ts');
const outlooks = await import('./outlooks.ts');
const forecast = await import('./forecast.ts');

// (wakes, sorts and proposals too: a job's id comes back after its delete, and a hold left on the old one would hold it;
const reset = () =>
  db.exec(
    'delete from jobs; delete from prs; delete from threads; delete from project_notes; delete from schedule_runs; delete from messages; delete from wakes; delete from sorts; delete from proposals',
  );
const thread = (id: number) =>
  (db.prepare('select thread from jobs where id = ?').get(id) as { thread: string | null }).thread;
const started = (slug: string, project = 'game') => {
  const t = projects.createThread({ project, name: `Thread ${slug}`, goal: 'It works', slug });
  assert.equal(typeof t, 'object', typeof t === 'string' ? t : '');
  return (t as { id: string }).id;
};
const inThread = (agent: string, id: string) => h.start({ agent, thread: id });
// A job in no deliverable from before the company asked for them, running: sorted then, so HQ doesn't hold it for the
// CEO to place (sorting.ts holdLoose)
const legacy = async (j: Parameters<typeof h.queue>[0]) => {
  const id = h.queue(j);
  db.prepare("insert into wakes (job, kind, arg, since, met) values (?, 'sorted', '', ?, 'sorted before')").run(
    id,
    Date.now(),
  );
  return h.claimJob(id);
};
const handOff = (from: Running, body: Record<string, unknown> = {}) =>
  h.agent('job', from.token, { agent: 'moss', title: 'Next step', prompt: 'Do it.', ...body });

test('a hand-off stays in its thread, --thread sends it to another or starts one, --check marks it', async () => {
  reset();
  const [levels, sound] = [started('levels'), started('sound')];
  const lead = await inThread('wren', levels);
  const same = await handOff(lead);
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(thread(same.body.id), levels);
  assert.equal(same.body.thread, levels, 'the answer names its thread');
  const other = await handOff(lead, { thread: sound, check: true });
  assert.equal(thread(other.body.id), sound);
  assert.equal(h.job(other.body.id).check, 1);
  assert.equal(h.job(same.body.id).check, 0);
  // A thread started for it is drawn in its project's plan, as hq plan thread draws one: by the project's owner (or the
  // CEO), anyone else refused before anything is written.
  const checkout = { name: 'The checkout', goal: 'A buyer pays in one step' };
  const written = () =>
    db
      .prepare(
        'select (select count(*) from threads) + (select count(*) from jobs) + (select count(*) from plan_changes) n',
      )
      .get();
  const before = written();
  const theirs = await handOff(lead, { newThread: { project: 'shop', ...checkout } });
  assert.equal(theirs.status, 409);
  assert.match(theirs.body.error, /The shop's plan is moss's .* hq propose --project shop/);
  assert.deepEqual(written(), before, 'nothing written');
  const fresh = await handOff(lead, { newThread: { project: 'game', ...checkout } });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  const made = projects.findThread(thread(fresh.body.id)!)!;
  assert.deepEqual([made.id, made.project, made.by], ['game/the-checkout', 'game', lead.id]);
  assert.equal((await handOff(lead, { thread: 'game/nowhere' })).status, 409);
  assert.equal((await handOff(lead, { newThread: { project: 'nowhere', name: 'X', goal: 'Y' } })).status, 400);
  assert.equal(
    (await handOff(lead, { thread: sound, newThread: { project: 'game', name: 'X', goal: 'Y' } })).status,
    400,
  );
});

test('a job with no open thread to inherit must name one, and the refusal says to draw its own first', async () => {
  reset();
  const levels = started('levels');
  const loose = await legacy({ agent: 'wren' });
  const refused = await handOff(loose);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /no open deliverable to inherit/);
  // (drawing one comes first, with the projects to draw it in, then joining one; no open deliverable to pick)
  assert.match(refused.body.error, /--deliverable new:<project>.*--deliverable <project>\/<slug>.*game \(wren\)/);
  assert.doesNotMatch(refused.body.error, new RegExp(`${levels}|Thread levels|It works`));
  assert.equal(
    (db.prepare("select count(*) n from jobs where title = 'Next step'").get() as { n: number }).n,
    0,
    'nothing queued',
  );
  assert.equal((await handOff(loose, { thread: levels })).status, 200);
  // a thread that's done hands nothing on (the step queued above cancelled: it'd hold the lead in the thread's order)
  h.cancelQueued();
  const lead = await inThread('wren', levels);
  assert.deepEqual(plan.done(levels, 'wren'), { ok: true });
  assert.match((await handOff(lead)).body.error, /its deliverable game\/levels is done/);
  // a company that doesn't ask for threads queues it without one
  const file = `${h.repo}/company/projects.yaml`;
  writeFileSync(file, 'projects:\n  - { id: game, name: The game, owner: wren }\n');
  const free = await handOff(loose);
  assert.equal(free.status, 200);
  assert.equal(thread(free.body.id), null);
  writeFileSync(file, PROJECTS);
});

test('empty project configuration permits unthreaded work but malformed YAML refuses it', async () => {
  reset();
  const loose = await legacy({ agent: 'wren' });
  const file = `${h.repo}/company/projects.yaml`;
  try {
    writeFileSync(file, 'requireThread: [');
    const refused = await handOff(loose);
    assert.equal(refused.status, 500);
    assert.equal((db.prepare("select count(*) n from jobs where title = 'Next step'").get() as { n: number }).n, 0);
    for (const source of ['', '# none yet\n']) {
      writeFileSync(file, source);
      const queued = await handOff(loose);
      assert.equal(queued.status, 200, JSON.stringify(queued.body));
      assert.equal(thread(queued.body.id), null);
      assert.equal(h.job(queued.body.id).status, 'queued');
      const board = await h.board('/api/projects');
      assert.equal(board.status, 200);
      // (the projects are HQ's once lifted from the file: plan.ts)
      assert.deepEqual(
        board.body.projects.map((p: { id: string }) => p.id),
        ['game', 'shop'],
      );
    }
  } finally {
    writeFileSync(file, PROJECTS);
  }
});

test('the review loop, an answer and a message take the thread of the job they come from', async () => {
  reset();
  const levels = started('levels');
  // the panel's reviews of its pull request, and the author's fixes for them
  const author = await inThread('bolt', levels);
  const done = await h.finish(author, {
    pr: 41,
    branch: `job/${author.id}`,
    sha: 'a'.repeat(40),
    files: ['platform/coordinator/src/jobs.ts'],
  });
  assert.equal(done.status, 200);
  const loop = db.prepare('select id, kind, thread from jobs where pr = 41').all() as {
    kind: string;
    thread: string;
  }[];
  assert.ok(loop.length > 0, 'the round is queued');
  assert.deepEqual([...new Set(loop.map(j => j.thread))], [levels]);
  const fix = jobs.createJob({
    agent: 'bolt',
    title: 'Fixes',
    prompt: 'x',
    kind: 'work',
    branch: `job/${author.id}`,
    pr: 41,
    stage: 'fix',
  });
  assert.equal(thread(fix.id), levels);
  const reLand = jobs.createJob({ agent: 'bolt', title: 'Re-land', prompt: 'x', pr: 41 });
  assert.equal(thread(reLand.id), levels, 'by its pull request alone');
  // the board's answer to a card whose job has ended (the pull request's open jobs cancelled: they'd hold the asker)
  h.cancelQueued();
  const asker = await inThread('wren', levels);
  const card = await h.ask(asker);
  await h.finish(asker);
  assert.equal((await h.answer(card, 'Yes')).status, 200);
  const answer = db.prepare("select id from jobs where title like 'The board on:%'").get() as { id: number };
  assert.equal(thread(answer.id), levels);
  // hq say to an agent with nothing running: the job it becomes (the answer's task cancelled, which the sender would follow)
  h.cancelQueued();
  const sender = await inThread('wren', levels);
  const said = await h.agent('message', sender.token, { to: 'moss', text: 'The level is ready.' });
  assert.equal(said.status, 200, JSON.stringify(said.body));
  assert.equal(said.body.state, 'job');
  assert.equal(thread(said.body.job), levels);
  // HQ's own jobs with nothing to inherit have none, and aren't refused
  assert.equal(thread(jobs.createJob({ agent: 'moss', title: 'Backup missed', prompt: 'x' }).id), null);
});

test("a records pull request's steps follow its job into its thread, open or done, off the CEO's desk", async () => {
  reset();
  // job n's records pull request (the worker's profile/<n>, its profile lines): the author's fix and the ruling on it
  const records = (number: number, job: number) => {
    h.storedPr(number, job, 'open');
    db.prepare('update prs set branch = ? where number = ?').run(`profile/${job}`, number);
    const fix = jobs.createJob({
      agent: 'bolt',
      title: 'Bringing up to date',
      prompt: 'x',
      kind: 'work',
      branch: `profile/${job}`,
      pr: number,
      stage: 'fix',
    }).id;
    const ruling = jobs.createJob({
      agent: 'quill',
      title: `PR #${number}`,
      prompt: 'x',
      kind: 'consolidate',
      pr: number,
    });
    return [fix, ruling.id];
  };
  const [open, closed] = [started('records-open'), started('records-done')];
  const [one, two] = [open, closed].map(thread => h.pastJob({ agent: 'bolt', title: 'Done', thread }));
  assert.deepEqual(plan.done(closed, 'wren'), { ok: true });
  const steps = [...records(911, one), ...records(912, two)];
  assert.deepEqual(steps.map(thread), [open, open, closed, closed]);
  // a job from before deliverables: its records pull request's steps stay in none, as its own work is
  const old = records(913, h.pastJob({ agent: 'bolt', title: 'Old' }));
  assert.deepEqual(old.map(thread), [null, null]);
  const desk = projects.listProjectBoard().unsorted.map(j => j.id);
  assert.deepEqual(
    steps.filter(id => desk.includes(id)),
    [],
    "the CEO's desk holds none of them",
  );
});

// (a routine is a project like any other, each run a thread of its own)
test("a schedule entry's runs are threads of its routine's project, which the schedule keeps", async t => {
  reset();
  t.after(routinesFixture.clearRoutines);
  const file = `${h.repo}/company/schedule.yaml`,
    was = readFileSync(file, 'utf8');
  // runs recorded before their routine had a project: one queued, one running, one done with nothing to merge, and one
  // in review with its review loop
  const queued = jobs.createJob({ agent: 'bolt', title: 'Log scan (2026-10-15)', prompt: 'x' }).id;
  const running = await legacy({ agent: 'bolt', title: 'Log scan (2026-10-14)' });
  const ended = await legacy({ agent: 'bolt', title: 'Log scan (2026-10-13)' });
  assert.equal((await h.finish(ended)).status, 200);
  const reviewed = await legacy({ agent: 'bolt', title: 'Log scan (2026-10-12)' });
  const pr = { pr: 52, branch: `job/${reviewed.id}`, sha: 'b'.repeat(40), files: ['platform/coordinator/src/jobs.ts'] };
  assert.equal((await h.finish(reviewed, pr)).status, 200);
  const loop = (db.prepare('select id from jobs where pr = 52').all() as { id: number }[]).map(j => j.id);
  assert.ok(loop.length > 0, 'its review round is queued');
  for (const [slot, job] of [
    ['2026-10-15', queued],
    ['2026-10-14', running.id],
    ['2026-10-13', ended.id],
    ['2026-10-12', reviewed.id],
  ] as const)
    routinesFixture.legacyRun('sweep', slot, job);
  // and an entry whose id another project holds: it runs nowhere, and its slot stays open
  t.after(() => writeFileSync(file, was));
  writeFileSync(file, `${was}- { id: shop, agent: moss, at: "00:00", title: Stock count, prompt: Count. }\n`);
  schedule.tick(new Date('2026-10-16T10:00:00Z'));
  const runs = db
    .prepare("select id, title, thread from jobs where title like '%(2026-10-16)' order by title")
    .all() as {
    id: number;
    title: string;
    thread: string | null;
  }[];
  assert.deepEqual(
    runs.map(j => [j.title, j.thread]),
    [
      ['Log scan (2026-10-16)', `sweep/job-${runs[0].id}`],
      ['Round (2026-10-16)', `round/job-${runs[1].id}`],
    ],
  );
  const placed = (ids: readonly number[]) => [...new Set(ids.map(id => thread(id)))];
  const moved = [queued, running.id, ended.id, reviewed.id].map(id => `sweep/job-${id}`);
  assert.deepEqual(
    [[queued], [running.id], [ended.id], [reviewed.id, ...loop]].map(placed),
    moved.map(id => [id]),
    'each recorded run moved into its project, its review loop with it',
  );
  assert.deepEqual(
    moved.map(id => projects.findThread(id)?.status),
    ['open', 'open', 'done', 'open'],
    'the run that ended with nothing to merge has settled',
  );
  assert.deepEqual(
    [projects.findThread(moved[0])?.name, projects.findThread(`sweep/job-${runs[0].id}`)?.name],
    ['Log scan, 15 Oct', 'Log scan, 16 Oct'],
  );
  assert.deepEqual(projects.findProject('sweep'), { id: 'sweep', name: 'Log scan', owner: 'bolt' });
  assert.equal(projects.findProject('shop')?.name, 'The shop', "another project's id is left as it was");
  assert.deepEqual(
    [
      db.prepare("select 1 from jobs where title like 'Stock count%'").get(),
      schedule.recurring().find(r => r.id === 'shop')?.last,
    ],
    [undefined, null],
  );
  // the board sees each routine as a project, with its schedule, and no recurring or upkeep group of jobs
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-16T10:00:30Z') });
  const board = projects.listProjectBoard();
  t.mock.timers.reset();
  const sweep = board.projects.find(p => p.id === 'sweep')!;
  assert.deepEqual(sweep.schedule, {
    when: 'daily 00:00',
    next: 'tomorrow 00:00',
    soon: 1440,
    last: '2026-10-16',
    downtime: false,
  });
  assert.deepEqual(
    [sweep.threads.map(t => t.id).sort(), sweep.done.map(t => t.id)],
    [[...moved.filter(id => id !== moved[2]), `sweep/job-${runs[0].id}`].sort(), [moved[2]]],
  );
  assert.equal(board.projects.find(p => p.id === 'shop')?.schedule, undefined, 'the other project is no routine');
  assert.deepEqual([board.unsorted.map(j => j.id), 'recurring' in board, 'upkeep' in board], [[], false, false]);
  // a meeting recorded before its routine had a project moves with all its seats
  const talk = meetings.create({ topic: 'Log talk', agents: ['bolt'], at: Date.now(), calledBy: 'bolt', code: 'TALK' });
  assert.ok(typeof talk === 'object', String(talk));
  routinesFixture.legacyRun('sweep', '2026-10-11', talk.seats[0].job);
  schedule.tick(new Date('2026-10-16T10:01:00Z'));
  assert.deepEqual(placed(talk.seats.map(s => s.job)), [`sweep/job-${talk.seats[0].job}`]);
});

test('a routine no entry names stays open while its runs are, then ends; named again, it opens again', async t => {
  reset();
  t.after(routinesFixture.clearRoutines);
  const file = `${h.repo}/company/schedule.yaml`,
    was = readFileSync(file, 'utf8');
  t.after(() => writeFileSync(file, was));
  writeFileSync(
    file,
    `${was}- { id: books, agent: bolt, at: "00:00", title: Books check, prompt: Check the books. }\n`,
  );
  schedule.tick(new Date('2026-10-16T10:00:00Z'));
  // three routines' runs: one ends done with nothing to merge, one fails, one is cancelled before it starts
  const run = (title: string) =>
    db.prepare('select id, thread from jobs where title = ?').get(`${title} (2026-10-16)`) as {
      id: number;
      thread: string;
    };
  const [round, failing, cancelled] = [run('Round'), run('Books check'), run('Log scan')];
  writeFileSync(file, '[]\n');
  schedule.tick(new Date('2026-10-16T10:01:00Z'));
  const leaving = projects.listProjectBoard().projects.find(p => p.id === 'round');
  assert.deepEqual([leaving?.schedule?.when, leaving?.threads.map(t => t.id)], ['off the schedule', [round.thread]]);
  for (const j of jobs.listJobs() as { id: number; status: string }[])
    if (j.status === 'queued' && ![round.id, failing.id].includes(j.id))
      assert.equal(ledger.cancelJob(j.id, 'Only the round and the books check run in this scenario'), true);
  assert.equal(
    projects.findThread(cancelled.thread)?.status,
    'done',
    'a run cancelled before it starts ends its thread',
  );
  for (const id of [round.id, failing.id]) {
    const claimed = await h.claim(h.job(id).engine);
    assert.ok(claimed && [round.id, failing.id].includes(claimed.id));
    const failed = claimed.id === failing.id;
    assert.equal((await h.finish(claimed, failed ? { status: 'failed', result: 'It crashed' } : {})).status, 200);
  }
  assert.deepEqual(
    [round, failing].map(r => projects.findThread(r.thread)?.status),
    ['done', 'done'],
    'a run that ends with nothing to merge ends its thread, and so does one that fails with nothing in its place',
  );
  // (a closed thread whose task failed says so on the board's tallies, so no list draws it done)
  const closed = projects.listProjectBoard().projects.flatMap(p => p.done);
  assert.deepEqual(
    [round, failing].map(r => closed.find(d => d.id === r.thread)?.failed),
    [0, 1],
    'a closed thread counts the tasks that failed in it',
  );
  schedule.tick(new Date('2026-10-16T10:02:00Z'));
  assert.deepEqual(
    ['round', 'books', 'sweep'].map(id => projects.findProject(id)),
    [undefined, undefined, undefined],
  );
  const completed = projects.listProjectBoard().completed.map(p => p.id);
  assert.ok(
    ['round', 'books', 'sweep'].every(id => completed.includes(id)),
    String(completed),
  );
  writeFileSync(file, was);
  schedule.tick(new Date('2026-10-16T10:03:00Z'));
  assert.equal(projects.findProject('round')?.owner, 'juno');
});

test("an owner's thread and HQ's other one-task threads keep a failed task's thread open for its takeover", async () => {
  reset();
  const owners = started('owners');
  const task = await inThread('wren', owners);
  assert.equal((await h.finish(task, { status: 'failed', result: 'It crashed' })).status, 200);
  const note = jobs.createJob({ agent: 'wren', title: "The chat's errors", prompt: 'x', thread: null }).id;
  const made = await import('./made.ts');
  made.made('errors', 'care', { id: note });
  const noteRun = await h.claim(h.job(note).engine);
  assert.equal(noteRun?.id, note);
  assert.equal((await h.finish(noteRun!, { status: 'failed', result: 'It crashed' })).status, 200);
  assert.deepEqual([projects.findThread(owners)?.status, projects.findThread(thread(note)!)?.status], ['open', 'open']);
});

test("threads: drawn, listed and closed through hq plan, by the project's owner or the CEO", async () => {
  reset();
  const lead = await legacy({ agent: 'wren' });
  const made = await h.agent('plan/thread', lead.token, {
    project: 'game',
    name: 'Boss fight! Final',
    goal: 'You beat the boss',
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.deepEqual(
    [made.body.id, projects.ownerOf(made.body), made.body.status],
    ['game/boss-fight-final', 'wren', 'open'],
  );
  // (no two open threads in a product share a name.)
  const same = await h.agent('plan/thread', lead.token, {
    project: 'game',
    name: 'the boss fight final',
    goal: 'Again',
  });
  assert.equal(same.status, 400);
  assert.match(
    same.body.error,
    /is the name of the open deliverable game\/boss-fight-final: No two levels share a name/,
  );
  const again = await h.agent('plan/thread', lead.token, {
    project: 'game',
    name: 'Boss fight final, again',
    goal: 'Again',
  });
  assert.equal(again.body.id, 'game/boss-fight-final-2', 'a taken slug gets a number');
  for (const body of [
    { project: 'nope', name: 'X', goal: 'Y' },
    { project: 'game', name: '', goal: 'Y' },
    { project: 'game', name: 'X', goal: '' },
    { project: 'game', name: 'X', goal: 'Y', slug: 'Bad Slug' },
    { project: 'game', name: 'X', goal: 'Y', needs: ['game/nowhere'] },
    { project: 'game', name: 'X', goal: 'Y', needs: 'game/levels' },
    { project: 'game', name: 'X', goal: 'Y', needs: [null] },
    { project: 'broken', name: 'X', goal: 'Y' },
  ])
    assert.equal((await h.agent('plan/thread', lead.token, body)).status, 400, JSON.stringify(body));
  const listed = await h.agent('threads?project=game', lead.token);
  assert.deepEqual(
    listed.body.map((t: { id: string; open: number }) => [t.id, t.open]),
    [
      ['game/boss-fight-final', 0],
      ['game/boss-fight-final-2', 0],
    ],
  );
  const other = await legacy({ agent: 'bolt' });
  const refused = await h.agent('plan/done', other.token, { thread: 'game/boss-fight-final' });
  assert.equal(refused.status, 400, "not bolt's");
  assert.match(refused.body.error, /propose it to wren with hq propose --project game/);
  assert.equal((await h.agent('plan/done', lead.token, { thread: 'game/boss-fight-final' })).status, 200);
  assert.equal(
    (await h.agent('plan/done', lead.token, { thread: 'game/boss-fight-final' })).status,
    400,
    'already done',
  );
  assert.equal((await h.agent('threads?project=game', lead.token)).body.length, 1);
  assert.equal((await h.agent('threads?project=game&all=1', lead.token)).body.length, 2);
  // the CEO closes any thread too
  const ceo = await h.start({ agent: 'juno' });
  assert.equal((await h.agent('plan/done', ceo.token, { thread: 'game/boss-fight-final-2' })).status, 200);
});

test("a team member speaks as itself: never with its lead's rights over plans and sentences", async () => {
  reset();
  const lead = await inThread('wren', started('levels'));
  await h.worker('team', { job: lead.id, lead: 'wren', id: 'pip', name: 'Pip' });
  const as = (route: string, body: Record<string, unknown>, who = 'pip') =>
    h.agent(route, lead.token, { ...body, as: who });
  const thread = { project: 'game', name: 'Boss fight', goal: 'You beat the boss' };
  const unowned = await as('plan/thread', thread);
  assert.equal(unowned.status, 400, "pip doesn't own the game");
  assert.match(unowned.body.error, /hq propose/);
  assert.equal((await as('plan/done', { thread: 'game/levels' })).status, 400, "the lead's plan isn't pip's to change");
  assert.equal(
    (await as('project-notes', { project: 'game', text: 'Mine now.' })).status,
    400,
    "nor the lead's sentence",
  );
  for (const who of ['juno', 'nobody'])
    for (const [route, body] of [
      ['plan/thread', thread],
      ['plan/done', { thread: 'game/levels' }],
      ['project-notes', { project: 'game', text: 'Forged.' }],
    ] as const)
      assert.equal((await as(route, body, who)).status, 403, `${who} on ${route}`);
  assert.equal(projects.sentenceOf('game'), undefined);
  // the lead, named or not, keeps its own rights
  assert.equal((await as('project-notes', { project: 'game', text: 'Levels play.' }, 'wren')).status, 200);
  assert.equal(projects.sentenceOf('game')?.by, 'wren');
  assert.equal((await as('plan/done', { thread: 'game/levels' }, 'wren')).status, 200);
  const own = await h.agent('plan/thread', lead.token, thread);
  assert.equal(projects.ownerOf(own.body), 'wren');
});

test('a projects.yaml that stops parsing costs a claimed job only its project step', async () => {
  reset();
  const levels = started('levels');
  const file = `${h.repo}/company/projects.yaml`;
  try {
    writeFileSync(file, 'requireThread: [');
    const claimed = await inThread('wren', levels);
    assert.equal(h.job(claimed.id).status, 'running');
    assert.equal(claimed.ownsProject, undefined);
  } finally {
    writeFileSync(file, PROJECTS);
  }
});

test("a project's sentence is its owner's (or the CEO's), and the owner's briefing asks to keep it true", async () => {
  reset();
  const levels = started('levels');
  const owner = await inThread('wren', levels);
  assert.deepEqual(owner.ownsProject, { id: 'game', name: 'The game', sentence: null });
  const said = await h.agent('project-notes', owner.token, { project: 'game', text: 'Levels 1 to 3 play; 4 is next.' });
  assert.equal(said.status, 200, JSON.stringify(said.body));
  // (each in a thread of its own: one thread's tasks run one at a time)
  const other = await inThread('bolt', started('art'));
  assert.equal(other.ownsProject, undefined, "bolt doesn't own the game");
  assert.equal((await h.agent('project-notes', other.token, { project: 'game', text: 'Mine now.' })).status, 400);
  assert.equal((await h.agent('project-notes', owner.token, { project: 'game', text: ' ' })).status, 400);
  const ceo = await h.start({ agent: 'juno' });
  assert.equal(
    (await h.agent('project-notes', ceo.token, { project: 'shop', text: 'The shop opens after the game.' })).status,
    200,
  );
  const again = await inThread('wren', started('sound'));
  assert.equal(again.ownsProject.sentence, 'Levels 1 to 3 play; 4 is next.');
  const { closing } = await import('../../worker/src/closing.ts');
  assert.match(
    closing({ ownsProject: again.ownsProject }),
    /The game is yours, and its sentence for the board reads: "Levels 1 to 3 play; 4 is next\." .*hq project say game/s,
  );
  assert.match(closing({ ownsProject: owner.ownsProject }), /The game is yours and has no sentence for the board yet/);
  assert.doesNotMatch(
    closing({ stage: 'fix', ownsProject: owner.ownsProject }),
    /project say/,
    'a fix round leaves it',
  );
});

test("GET /api/projects: the board's projects, their threads and jobs, and the open work in none", async t => {
  reset();
  const [levels, sound] = [started('levels'), started('sound')];
  // an open thread whose jobs are all finished is done, one with none yet is ongoing
  // (ended with no runs, so the play doesn't size the levels' jobs on them)
  const doneIn = (thread: string, finished = Date.parse('2026-10-19T08:00:00Z')) =>
    h.pastJob({ agent: 'bolt', title: 'Done', thread, finished });
  const [art, fresh] = [started('art'), started('fresh')];
  doneIn(art, Date.parse('2026-10-19T09:00:00Z'));
  // A thread whose only job is done and whose latest pull request is still in review, stuck or with the board is ongoing.
  // A thread whose latest pull request merged is done.
  const reviewed = (status: string, number: number, finished?: number) => {
    const id = started(`pr-${status}`);
    h.storedPr(number, doneIn(id, finished), status);
    return id;
  };
  const inReview = [reviewed('open', 901), reviewed('stuck', 902), reviewed('board', 903)];
  const landed = reviewed('merged', 904, Date.parse('2026-10-15T09:00:00Z'));
  const working = await inThread('wren', levels);
  const next = jobs.createJob({ agent: 'moss', title: 'Level 4', prompt: 'x', thread: levels, check: true }).id;
  const finished = doneIn(sound, Date.parse('2026-10-06T09:00:00Z'));
  // Made sound, art, landed. Finished sound, landed, art: sound closed after its job ended, landed before, art never.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-12T09:00:00Z') });
  try {
    assert.deepEqual(plan.done(sound, 'wren'), { ok: true });
    t.mock.timers.setTime(Date.parse('2026-10-01T09:00:00Z'));
    assert.deepEqual(plan.done(landed, 'wren'), { ok: true });
  } finally {
    t.mock.timers.reset();
  }
  // the shop's two threads, each with only a task dropped before it started: done, each at its drop
  const [wrap, ribbon] = [started('wrap', 'shop'), started('ribbon', 'shop')];
  const [wrapping, ribbons] = [wrap, ribbon].map(thread => h.queue({ agent: 'moss', thread, queuedBy: 'moss' }));
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-17T09:00:00Z') });
  try {
    assert.deepEqual(plan.drop(wrapping, 'Not needed', 'moss'), { ok: true });
    t.mock.timers.setTime(Date.parse('2026-10-18T09:00:00Z'));
    assert.deepEqual(plan.drop(ribbons, 'Not needed', 'moss'), { ok: true });
  } finally {
    t.mock.timers.reset();
  }
  h.cancelJudges(); // (the deliverables' ends woke their owner's judge)
  // (downtime work is a flag on the work, never a group of its own)
  const spare = jobs.createJob({ agent: 'bolt', title: 'Log scan', prompt: 'x', downtime: true }).id;
  const unsorted = jobs.createJob({ agent: 'bolt', title: 'Loose', prompt: 'x' }).id;
  // the CEO's own, on the schedule's spare seats or not, is the desk's
  const rounds = jobs.createJob({ agent: 'juno', title: 'Rounds', prompt: 'x', downtime: true }).id;
  const stray = jobs.createJob({ agent: 'bolt', title: 'Typo', prompt: 'x', thread: 'game/typo' }).id;
  // the latest finished outside the threads, ten at most
  const ended = (status: string, extra = {}) => h.ended({ agent: 'bolt', title: `Ended ${status}`, ...extra }, status);
  ended('failed', { downtime: true });
  const done = Array.from({ length: 11 }, () => ended('done'));
  projects.say('game', 'Levels play.', 'wren');
  await h.capacity({ claude: 1, codex: 1 });
  const r = await h.board('/api/projects');
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.projects.map((p: { id: string }) => p.id),
    ['game', 'shop'],
    'one without an owner is left out',
  );
  assert.deepEqual(r.body.businesses, [
    { id: 'play', name: 'Play', cover: 'covers/play.png', owner: 'wren', style: 'pixel' },
    { id: 'trade', name: 'Trade' },
  ]);
  assert.deepEqual(
    r.body.groups,
    { recurring: { cover: 'covers/recurring.png' }, unsorted: { name: "Juno's desk" } },
    "the side groups as declared, the work in none the CEO's desk by the CEO's name",
  );
  const game = r.body.projects[0];
  // (its names the board's, the agent's words until they're made: plainnames.test.ts.)
  assert.deepEqual(
    [game.name, game.naming, game.owner, game.business, game.sentence.text, game.sentence.naming, game.sentence.by],
    ['The game', undefined, 'wren', 'play', 'Levels play.', undefined, 'wren'],
  );
  assert.equal(game.sentence.since, 0);
  assert.deepEqual([r.body.projects[1].product, r.body.projects[1].business], ['shop', 'trade']);
  // a project's cover where projects.yaml names one, in its business's style
  assert.deepEqual(
    r.body.projects.map((p: { cover?: string; style?: string }) => [p.cover, p.style]),
    [
      ['covers/game.png', 'pixel'],
      [undefined, undefined],
    ],
  );
  assert.deepEqual(
    [
      r.body.projects[1].threads,
      r.body.projects[1].done.map((t: { id: string; jobs: number; done: number; finished: string }) => [
        t.id,
        t.jobs,
        t.done,
        t.finished,
      ]),
    ],
    [
      [],
      [
        [wrap, 1, 0, '2026-10-17T09:00:00.000Z'],
        [ribbon, 1, 0, '2026-10-18T09:00:00.000Z'],
      ],
    ],
    'threads whose only task was dropped are done, each when its task was dropped',
  );
  assert.deepEqual(
    game.threads.map((t: { id: string }) => t.id),
    [levels, fresh, ...inReview],
  );
  const shown = game.threads[0];
  assert.deepEqual(
    [shown.name, shown.goal, shown.naming, shown.owner, shown.status],
    ['Thread levels', 'It works', undefined, 'wren', 'open'],
  );
  assert.deepEqual(
    shown.jobs.map((j: { id: number }) => j.id),
    [next, working.id],
  );
  const job = shown.jobs[0];
  // (not ready: it follows the task running in its thread)
  assert.deepEqual([job.status, job.check, job.thread, job.ready], ['queued', 1, levels, 0]);
  const sized = outlooks.detail(levels, forecast.current())!.jobs;
  type Estimate = {
    size_ms: number;
    left_ms: number | null;
    start: number | null;
    done: number | null;
    merged: number | null;
    finish: number | null;
  };
  for (const j of shown.jobs as { id: number; estimate: Estimate }[]) {
    assert.equal(j.estimate.size_ms, sized.find(s => s.id === j.id)!.size_ms, 'its size, as hq thread has it');
    assert.ok(j.estimate.size_ms > 0 && j.estimate.merged! > Date.now(), 'and when it merges in the play');
  }
  // when the play starts the queued one and has each done, before it merges
  const [queued, running] = shown.jobs as { estimate: Estimate }[];
  assert.ok(queued.estimate.start! <= queued.estimate.done! && queued.estimate.done! <= queued.estimate.merged!);
  assert.ok(Date.now() < running.estimate.done! && running.estimate.done! <= running.estimate.merged!);
  // and its finish, its work live, as its thread's: the thread is done when its last job is
  for (const { estimate } of shown.jobs as { estimate: Estimate }[]) {
    assert.ok(estimate.finish! >= estimate.merged!, 'live after it merges');
    assert.ok(estimate.left_ms! > 0 && estimate.left_ms! <= estimate.size_ms, 'the part of its size it has left');
  }
  assert.equal(
    shown.outlook.finish,
    Math.max(...(shown.jobs as { estimate: Estimate }[]).map(j => j.estimate.finish!)),
    "the thread's finish is its last job's",
  );
  assert.deepEqual(
    game.done.map((t: { id: string; jobs: number; done: number }) => [t.id, t.jobs, t.done]),
    [
      [sound, 1, 1],
      [art, 1, 1],
      [landed, 1, 1],
    ],
  );
  assert.deepEqual(
    game.done.map((t: { finished: string }) => t.finished),
    ['2026-10-12T09:00:00.000Z', '2026-10-19T09:00:00.000Z', '2026-10-15T09:00:00.000Z'],
    'each finished at its close or its last job, whichever came later, kept apart from the done count',
  );
  assert.deepEqual(
    r.body.unsorted.map((j: { id: number }) => j.id),
    [stray, rounds, unsorted, spare, ...done.slice(1).reverse()],
    'the open ones, then the ten latest finished',
  );
  assert.equal((await h.call('/api/projects', 'nobody')).status, 401);
  // a done thread opens with its jobs
  const closed = await h.board(`/api/projects/thread?id=${encodeURIComponent(sound)}`);
  assert.deepEqual([closed.body.status, closed.body.jobs.map((j: { id: number }) => j.id)], ['done', [finished]]);
  assert.equal(closed.body.jobs[0].status, 'done');
  assert.equal((await h.board('/api/projects/thread?id=game/nowhere')).status, 404);
});

// (HQ's other files go out the same way: server.ts sendFile.)
test("a cover the board's browser holds is checked, never sent again, until it's redrawn", async () => {
  mkdirSync(`${h.repo}/theme/hq/covers`, { recursive: true });
  writeFileSync(`${h.repo}/theme/hq/covers/game.png`, 'the cover');
  const get = (held?: string) =>
    fetch(`${h.base}/covers/game.png`, { headers: { cookie: h.boardCookie, ...(held && { 'if-none-match': held }) } });
  const first = await get();
  assert.deepEqual(
    [first.status, first.headers.get('cache-control'), await first.text()],
    [200, 'no-cache', 'the cover'],
  );
  const tag = first.headers.get('etag')!;
  const again = await get(tag);
  assert.deepEqual([again.status, await again.text()], [304, '']);
  writeFileSync(`${h.repo}/theme/hq/covers/game.png`, 'the cover, redrawn');
  const redrawn = await get(tag);
  assert.deepEqual([redrawn.status, await redrawn.text()], [200, 'the cover, redrawn']);
});

test('hq plan thread, hq job --thread, hq project say and hq plan done, end to end', async () => {
  reset();
  const lead = await legacy({ agent: 'wren' });
  const hq = async (...args: string[]) => h.hq(lead, ...args);
  assert.match(
    (await hq('plan', 'thread', 'game', 'Boss fight', 'You beat the boss')).out,
    /Deliverable drawn:\n {2}Play › The game › Boss fight \(game\/boss-fight\)\n {2}done when You beat the boss\n/,
  );
  const queued = await hq('job', 'moss', 'The boss', '--thread', 'game/boss-fight', '--check', '--new');
  assert.equal(queued.code, 0, queued.out);
  // (the deliverable it joined, read back with its done when, and the way out: draw one, or move it to an open one)
  assert.match(queued.out, /game\/boss-fight.*You beat the boss/);
  assert.match(queued.out, /hq plan deliverable <project>.*hq job move \d+ <project>\/<slug>/);
  const id = Number(/Queued job #(\d+)/.exec(queued.out)![1]);
  assert.deepEqual([thread(id), h.job(id).check], ['game/boss-fight', 1]);
  const refused = await hq('job', 'moss', 'Loose work', '--new');
  assert.notEqual(refused.code, 0);
  // (drawing one comes first in the refusal, with the projects to draw it in, then joining one, and no open
  // deliverable to pick from)
  assert.match(refused.out, /No job was queued/);
  assert.match(refused.out, /--deliverable new:<project>.*--deliverable <project>\/<slug>.*game \(wren\)/s);
  assert.doesNotMatch(refused.out, /game\/boss-fight|You beat the boss/, 'no open deliverable offered to pick');
  // the CEO's own work needs none: it's the desk's
  const ceo = await h.start({ agent: 'juno' });
  const own = await h.hq(ceo, 'job', 'juno', 'Sort the loose work', '--new');
  assert.equal(own.code, 0, own.out);
  assert.equal(thread(Number(/Queued job #(\d+)/.exec(own.out)![1])), null);
  assert.notEqual((await h.hq(ceo, 'job', 'moss', 'Loose work too', '--new')).code, 0, "others' still need one");
  // on a call too: the CEO's own follow-up is the desk's, anyone else's work names the thread of the project it's for,
  // told where work goes (the Front Desk is the CEO's call and meeting work alone).
  const call = (await h.voice('call-context?agent=juno')).body.token as string;
  const onCall = (agent: string, title: string) => h.agent('job', call, { agent, title, prompt: 'From the call.' });
  const followUp = await onCall('juno', 'Write up the call');
  assert.equal(followUp.status, 200, JSON.stringify(followUp.body));
  assert.equal(thread(followUp.body.id), null);
  const loose = await onCall('moss', 'A recurring check on the shop');
  assert.equal(loose.status, 409);
  assert.match(
    loose.body.error,
    /belongs to the project its work is for.*holds only the CEO's own running of the company.*--deliverable new:<project>/s,
  );
  assert.equal(
    (db.prepare('select count(*) n from jobs where title = ?').get('A recurring check on the shop') as { n: number }).n,
    0,
  );
  await h.voice('call-end', { agent: 'juno', lines: [], token: call });
  // (a thread started for a job is drawn in its project's plan: shop's is moss's or the CEO's.)
  const payment = ['job', 'moss', 'The payment form', '--thread', 'new:shop', 'The checkout', 'A buyer pays', '--new'];
  assert.match((await hq(...payment)).out, /No job was queued: The shop's plan is moss's .* hq propose --project shop/);
  assert.match((await h.hq(ceo, ...payment)).out, /In deliverable shop\/the-checkout\./);
  assert.match((await hq('thread', 'sort')).out, /hq plan deliverable .* hq job move/);
  assert.match(
    (await hq('thread', 'list', 'game')).out,
    /game\/boss-fight {2}Boss fight \(wren, 1 open\) {2}done when You beat the boss/,
  );
  assert.match((await hq('project', 'say', 'game', 'The boss is next.')).out, /Recorded game's sentence\./);
  assert.match((await hq('thread', 'new', 'game', 'X', 'Y')).out, /hq plan deliverable/);
  assert.match((await hq('plan', 'done', 'game/boss-fight')).out, /Deliverable game\/boss-fight is done\./);
});

// The jobs HQ makes from the same template every time go to the project projects.yaml's made sets for their kind and
// app, each a one-task thread there; an app with no entry leaves them in no project
test("the error scan's triage goes to the project set for the app that threw them, else to none", async () => {
  reset();
  const { scanErrors } = await import('./triage.ts');
  const kind = {
    'TypeError in src/server.ts (handle)': { first: '2026-10-06T06:00:00Z', last: '2026-10-06T06:00:00Z', n: 2 },
  };
  writeFileSync(
    `${h.dataDir}/app-errors.json`,
    JSON.stringify({ at: '2026-10-06T06:00:00Z', apps: { hello: kind, care: kind } }),
  );
  scanErrors(
    [{ slug: 'hello', name: 'Hello', addresses: [], ordering: false }],
    Date.parse('2026-10-06T07:00:00Z'),
    '2026-10-06',
  );
  const triage = (name: string) => (h.jobs.listJobs() as any[]).find(j => j.title.startsWith(`${name}: 1 kind`));
  assert.equal(thread(triage('Care').id), `shop/job-${triage('Care').id}`);
  assert.equal(thread(triage('Hello').id), null, 'hello has no project configured');
});

test("a thread's lines are its pull requests' added and removed, each counted once, and null before any has counts", async () => {
  reset();
  const [counted, uncounted] = [started('counted'), started('uncounted')];
  const first = h.ended({ agent: 'bolt', title: 'First', thread: counted });
  h.ended({ agent: 'bolt', title: 'Its fix', thread: counted, branch: `job/${first}` });
  const second = h.ended({ agent: 'moss', title: 'Second', thread: counted });
  h.storedPr(921, first, 'merged', [], { added: 30, removed: 4 });
  h.storedPr(922, second, 'open', [], { added: 5, removed: 1 });
  h.storedPr(923, h.ended({ agent: 'bolt', title: 'Uncounted', thread: uncounted }), 'open');
  const linesIn = (threads: { id: string; lines: unknown }[], id: string) => threads.find(t => t.id === id)?.lines;
  const ongoing = (await h.board('/api/projects')).body.projects[0].threads;
  assert.deepEqual(linesIn(ongoing, counted), { added: 35, removed: 5 }, 'two jobs on one branch: one pull request');
  assert.equal(linesIn(ongoing, uncounted), null);
  h.mergedPr(922);
  const done = (await h.board('/api/projects')).body.projects[0].done;
  assert.deepEqual(linesIn(done, counted), { added: 35, removed: 5 }, "a done thread's tally has them too");
  const opened = await h.board(`/api/projects/thread?id=${encodeURIComponent(counted)}`);
  assert.deepEqual(opened.body.lines, { added: 35, removed: 5 });
});

test("the board's order of the projects: the tiles it drags take the places they held, and its view follows it", async () => {
  const listed = async () =>
    (await h.board('/api/projects')).body.projects.map((p: { id: string }) => p.id) as string[];
  const order = (ids: unknown) => h.board('/api/projects/order', { order: ids });
  assert.equal(
    typeof plan.newProject({ id: 'tools', name: 'The tools', owner: 'moss', code: 'TL' }, 'juno', () => true),
    'object',
  );
  assert.deepEqual(await listed(), ['game', 'shop', 'tools'], 'in the order made, until the board sorts them');
  const sorted = await order(['tools', 'game']);
  assert.deepEqual([sorted.status, sorted.body.order], [200, ['tools', 'shop', 'game']], 'shop keeps its place');
  assert.deepEqual(await listed(), ['tools', 'shop', 'game']);
  assert.equal(
    typeof plan.newProject({ id: 'sound', name: 'The sound', owner: 'moss', code: 'SD' }, 'juno', () => true),
    'object',
  );
  assert.deepEqual(await listed(), ['tools', 'shop', 'game', 'sound'], 'a project made since comes after');
  for (const refused of [['tools', 'nowhere'], ['game', 'game'], 'tools']) {
    const r = await order(refused);
    assert.equal(r.status, 400, JSON.stringify(refused));
  }
  assert.match((await order(['nowhere'])).body.error, /nowhere/, 'the refusal names the id');
  assert.deepEqual(await listed(), ['tools', 'shop', 'game', 'sound'], 'a refused order changes nothing');
  assert.equal(
    (await h.call('/api/projects/order', 'nobody', { order: ['sound', 'tools'] })).status,
    403,
    "the board's alone",
  );
  assert.deepEqual(await listed(), ['tools', 'shop', 'game', 'sound']);
});
