// node --test src/proposals.test.ts   (throwaway DATA_DIR and the test company): hq propose and the owners' inboxes
// (hq inbox), through the real hq script.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('proposals', {
  before: repo =>
    writeFileSync(
      `${repo}/company/projects.yaml`,
      'projects:\n  - { id: game, name: The game, owner: wren }\n  - { id: shop, name: The shop, owner: moss }\n',
    ),
});
const { db } = h;
const projects = await import('./projects.ts');

const brief = `${h.dataDir}/brief.md`;
writeFileSync(brief, 'Add a level select screen: three worlds, unlocked in order.');
const queuedWork = () =>
  db.prepare("select id, agent, title, thread from jobs where status = 'queued' order by id").all() as {
    id: number;
    agent: string;
    title: string;
    thread: string | null;
  }[];

beforeEach(() =>
  db.exec(
    'delete from jobs; delete from proposals; delete from planning_jobs; delete from threads; delete from messages',
  ),
);

const levels = () =>
  projects.createThread({
    project: 'game',
    name: 'The levels',
    goal: 'Three worlds play',
    slug: 'levels',
  });

test("hq propose puts new work in its project owner's inbox, not the queue; the owner's planning job hears it; accepted, it's an ordinary job", async () => {
  levels();
  const bolt = await h.start({ agent: 'bolt', title: 'The first world', thread: 'game/levels' });
  const proposed = await h.hq(bolt, 'propose', 'A level select screen', brief, '--for', 'kit');
  assert.equal(proposed.code, 0, proposed.out);
  assert.match(
    proposed.out,
    /^Proposal #\d+ is in wren's inbox \(game's owner\)\. Nothing is queued until it's accepted/,
  );
  // wren runs nothing: one planning job for wren, on the Front Desk (no thread), takes it and what follows
  const [planning, ...none] = queuedWork();
  assert.deepEqual(none, [], 'nothing else queued');
  assert.deepEqual(
    [planning.agent, planning.title, planning.thread],
    ['wren', 'Sort new proposals into the plan', null],
  );
  const second = await h.agent('proposals', bolt.token, {
    title: 'A boss rush',
    brief: 'All bosses.',
    project: 'game',
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(queuedWork().length, 1, 'one planning job open at a time');

  const wren = await h.start({ agent: 'wren', title: 'Your plan' });
  const listed = await h.hq(wren, 'inbox');
  assert.match(listed.out, /^#(\d+) A level select screen \(from bolt for kit, for game, wren's to decide, .* UTC\)$/m);
  const id = /^#(\d+) /.exec(listed.out)![1];
  assert.match(
    (await h.hq(wren, 'inbox', id)).out,
    /\n\nAdd a level select screen: three worlds, unlocked in order\.\n$/,
  );
  // the CEO sees every one with --all, and in the summary, each with whose it is
  const juno = await h.start({ agent: 'juno', title: 'The follow-through check' });
  assert.equal((await h.hq(juno, 'inbox')).out, 'No proposals.\n');
  assert.match((await h.hq(juno, 'inbox', '--all')).out, /A level select screen .*wren's to decide/);
  assert.match(
    (await h.agent('summary', juno.token)).body.text,
    /^Proposed, each for its project's owner \(hq inbox --all\):\n- #\d+ "A level select screen", from bolt for kit, wren's to decide, since /m,
  );
  // nobody else decides it, nor puts it in another owner's plan
  const moss = await h.start({ agent: 'moss', title: 'The shop' });
  const refused = await h.agent('proposals/accept', moss.token, { id: Number(id) });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /wren's to decide/);
  projects.createThread({ project: 'shop', name: 'The till', goal: 'It rings', slug: 'till' });
  const elsewhere = await h.agent('proposals/accept', wren.token, { id: Number(id), thread: 'shop/till' });
  assert.equal(elsewhere.status, 400);
  assert.match(elsewhere.body.error, /The shop's plan is moss's/);

  const accepted = await h.hq(wren, 'inbox', 'accept', id);
  assert.equal(accepted.code, 0, accepted.out);
  const job = Number(/^Queued as job #(\d+) T[A-Z]+, in game\/levels\.$/m.exec(accepted.out)![1]);
  const row = db.prepare('select agent, title, prompt, queued_by, thread from jobs where id = ?').get(job) as any;
  assert.deepEqual(
    { ...row, prompt: undefined },
    {
      agent: 'kit',
      title: 'A level select screen',
      prompt: undefined,
      queued_by: 'bolt',
      thread: 'game/levels',
    },
  );
  assert.match(row.prompt, /\n\n\(Proposed by bolt, accepted by wren\.\)$/);
  assert.match((await h.hq(bolt, 'inbox')).out, new RegExp(`: accepted as job #${job}$`, 'm'));
  assert.equal((await h.hq(wren, 'inbox', 'accept', id)).code, 1, 'once');
  const logged = db
    .prepare("select what, by from plan_changes where thread = 'game/levels' order by id desc limit 1")
    .get();
  assert.deepEqual({ ...(logged as object) }, { what: `task #${job} added: A level select screen`, by: 'wren' });
  const drawn = await h.agent('proposals/accept', wren.token, {
    id: second.body.id,
    newThread: { project: 'game', name: 'Boss rush', goal: 'Every boss plays' },
  });
  assert.equal(drawn.status, 200);
  const history = db.prepare('select what, by from plan_changes where thread = ? order by id').all(drawn.body.thread);
  assert.deepEqual(
    history.map(c => [c.what, c.by]),
    [
      ['thread drawn: Boss rush', 'wren'],
      ['task #' + drawn.body.job + ' added: A boss rush', 'wren'],
    ],
  );
});

test("a running owner hears a proposal in its session; its owner or the CEO drops it, and the proposer's running job hears why", async () => {
  levels();
  const wren = await h.start({ agent: 'wren', title: 'The first world', engine: 'claude' });
  const bolt = await h.start({ agent: 'bolt', title: 'Level art', engine: 'claude', thread: 'game/levels' });
  const made = await h.agent('proposals', bolt.token, { title: 'A second world', brief: 'Snow.' });
  assert.equal(made.status, 200);
  assert.deepEqual(queuedWork(), [], 'no planning job: wren is at work');
  const told = db.prepare('select recipient, job, text from messages').get() as any;
  assert.deepEqual(
    { ...told },
    {
      recipient: 'wren',
      job: wren.id,
      text: `Proposal #${made.body.id} from bolt for game: "A second world". Accept it into your plan or drop it (hq inbox ${made.body.id}).`,
    },
  );
  db.exec('delete from messages');
  assert.equal((await h.agent('proposals/drop', bolt.token, { id: made.body.id, why: 'mine' })).status, 400);
  const dropped = await h.hq(wren, 'inbox', 'drop', String(made.body.id), 'The board wants one world first');
  assert.equal(dropped.code, 0, dropped.out);
  assert.match(dropped.out, /Its proposer heard why\./);
  const heard = db.prepare('select recipient, job, text from messages').all() as any[];
  assert.deepEqual(
    heard.map(m => ({ ...m })),
    [
      {
        recipient: 'bolt',
        job: bolt.id,
        text: `Your proposal #${made.body.id} ("A second world") was dropped: The board wants one world first`,
      },
    ],
  );
  assert.match((await h.hq(bolt, 'inbox')).out, /: dropped, The board wants one world first$/m);
  // the CEO decides any
  const other = await h.agent('proposals', bolt.token, { title: 'A third world', brief: 'Sand.' });
  const juno = await h.start({ agent: 'juno', title: 'The follow-through check' });
  assert.equal((await h.agent('proposals/drop', juno.token, { id: other.body.id, why: 'Later' })).status, 200);
});

test('work proposed for no project waits for the CEO, who hears it in the summary: no planning job', async () => {
  const kit = await h.start({ agent: 'kit', title: 'Ads' });
  const made = await h.agent('proposals', kit.token, { title: 'A newsletter', brief: 'Monthly.' });
  assert.equal(made.status, 200);
  assert.deepEqual([made.body.owner, made.body.project], ['juno', null]);
  assert.deepEqual(queuedWork(), []);
  const juno = await h.start({ agent: 'juno', title: 'The follow-through check' });
  assert.match((await h.hq(juno, 'inbox')).out, /A newsletter \(from kit, juno's to decide/);
  assert.match((await h.agent('summary', juno.token)).body.text, /"A newsletter", from kit, yours to decide/);
});

test('a proposal is refused for someone who takes no work, a thread that is not open, a project that is not there, or no brief', async () => {
  const wren = await h.start({ agent: 'wren', title: 'The first world' });
  for (const [body, why] of [
    [{ title: 'X', brief: 'Y', for: 'nobody' }, /isn't a colleague/],
    [{ title: 'X', brief: 'Y', thread: 'game/none' }, /isn't an open thread/],
    [{ title: 'X', brief: 'Y', project: 'nowhere' }, /no project "nowhere"/],
    [{ title: 'X', brief: ' ' }, /its whole brief/],
  ] as const) {
    const refused = await h.agent('proposals', wren.token, body);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, why);
  }
});

test("a proposal whose owner can't be told is refused, and nothing of it is kept", async () => {
  levels();
  const wren = await h.start({ agent: 'wren', title: 'The first world', engine: 'claude' });
  const bolt = await h.start({ agent: 'bolt', title: 'Level art', engine: 'claude', thread: 'game/levels' });
  const messages = await import('./messages.ts');
  for (let i = 0; i < messages.PER_HOUR; i++)
    messages.send({ agent: 'bolt', job: bolt.id }, 'wren', `Note ${i}`, wren.id);
  const refused = await h.agent('proposals', bolt.token, { title: 'A second world', brief: 'Snow.' });
  assert.equal(refused.status, 429);
  assert.equal((db.prepare('select count(*) n from proposals').get() as { n: number }).n, 0);
  assert.equal((db.prepare('select count(*) n from messages').get() as { n: number }).n, messages.PER_HOUR);
  assert.deepEqual(queuedWork(), []);
});

test("the owner's one planning job takes what arrives while it runs, on any engine; what it never saw gets the next one once it ends", async () => {
  const juno = await h.start({ agent: 'juno', title: 'The follow-through check' });
  if (!projects.findProject('reviews'))
    assert.equal(
      (await h.agent('projects/new', juno.token, { id: 'reviews', name: 'Reviews', owner: 'nib' })).status,
      200,
    );
  const kit = await h.start({ agent: 'kit', title: 'Ads' });
  const first = await h.agent('proposals', kit.token, { title: 'A style guide', brief: 'Tone.', project: 'reviews' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const [planning] = queuedWork();
  assert.deepEqual([planning.agent, planning.thread], ['nib', null]);
  const running = await h.claim('codex');
  assert.equal(running?.id, planning.id, 'the planning job runs, on Codex');
  const second = await h.agent('proposals', kit.token, { title: 'A word list', brief: 'Words.', project: 'reviews' });
  assert.equal(second.status, 200);
  assert.deepEqual(queuedWork(), [], 'no second planning job while the first runs');
  assert.equal((db.prepare('select count(*) n from messages').get() as { n: number }).n, 0);
  const proposals = await import('./proposals.ts');
  proposals.sweep();
  assert.deepEqual(queuedWork(), [], 'nothing follows while it runs');
  // it ends with both still open: the one it had at its start was its to leave, the one that came later gets a job
  assert.equal((await h.finish(running!)).status, 200);
  proposals.sweep();
  const [next, ...none] = queuedWork();
  assert.deepEqual([next.agent, next.title, none], ['nib', 'Sort new proposals into the plan', []]);
  proposals.sweep();
  assert.equal(queuedWork().length, 1, 'once');
  const following = await h.claim('codex');
  assert.equal(following?.id, next.id);
  assert.equal((await h.finish(following!)).status, 200);
  proposals.sweep();
  assert.deepEqual(queuedWork(), [], 'proposals it had at its start do not queue another job');
});

test("a project's new owner hears its open proposals the same way, and the old owner's planning job stands down", async () => {
  levels();
  const bolt = await h.start({ agent: 'bolt', title: 'Level art', engine: 'claude', thread: 'game/levels' });
  const made = await h.agent('proposals', bolt.token, { title: 'A second world', brief: 'Snow.' });
  const [old] = queuedWork();
  assert.equal(old.agent, 'wren');
  const juno = await h.start({ agent: 'juno', title: 'The follow-through check' });
  try {
    const moved = await h.hq(juno, 'project', 'owner', 'game', 'moss');
    assert.equal(moved.code, 0, moved.out);
    const [planning, ...none] = queuedWork();
    assert.deepEqual([planning.agent, planning.title, none], ['moss', 'Sort new proposals into the plan', []]);
    assert.equal(h.job(old.id).status, 'cancelled');
    const moss = await h.start({ agent: 'moss', title: 'Your plan' });
    assert.match(
      (await h.hq(moss, 'inbox')).out,
      new RegExp(`^#${made.body.id} A second world .*moss's to decide`, 'm'),
    );
  } finally {
    await h.agent('projects/owner', juno.token, { id: 'game', owner: 'wren' });
  }
});

// A project for a test, made once by the CEO's job
const project = async (juno: { token: string }, id: string, owner: string) => {
  if (!projects.findProject(id))
    assert.equal((await h.agent('projects/new', juno.token, { id, name: id, owner })).status, 200);
};

test("an owner's running planning job stays theirs when the proposals it was made for go to a new owner", async () => {
  const juno = await h.start({ agent: 'juno', title: 'The follow-through check' });
  await project(juno, 'style', 'nib');
  await project(juno, 'audits', 'nib');
  const kit = await h.start({ agent: 'kit', title: 'Ads' });
  await h.agent('proposals', kit.token, { title: 'A style guide', brief: 'Tone.', project: 'style' });
  const running = await h.claim('codex');
  assert.equal(h.job(running!.id).agent, 'nib');
  assert.equal((await h.agent('projects/owner', juno.token, { id: 'style', owner: 'flint' })).status, 200);
  assert.equal(h.job(running!.id).status, 'running');
  const later = await h.agent('proposals', kit.token, { title: 'An audit list', brief: 'Checks.', project: 'audits' });
  assert.equal(later.status, 200);
  assert.deepEqual(
    queuedWork().map(j => j.agent),
    ['flint'],
    "nib's running planning job takes it: no second one for nib",
  );
});

test('a proposal handed on to an owner whose planning job is under way gets their next one once it ends', async () => {
  levels();
  const juno = await h.start({ agent: 'juno', title: 'The follow-through check' });
  await project(juno, 'craft', 'flint');
  const bolt = await h.start({ agent: 'bolt', title: 'Level art', engine: 'claude', thread: 'game/levels' });
  await h.agent('proposals', bolt.token, { title: 'A second world', brief: 'Snow.' });
  const kit = await h.start({ agent: 'kit', title: 'Ads' });
  await h.agent('proposals', kit.token, { title: 'A brush set', brief: 'Brushes.', project: 'craft' });
  const running = await h.claim('codex');
  assert.equal(h.job(running!.id).agent, 'flint');
  try {
    // older than flint's planning job, it reaches flint after that job read its inbox
    assert.equal((await h.agent('projects/owner', juno.token, { id: 'game', owner: 'flint' })).status, 200);
    assert.deepEqual(queuedWork(), [], "flint's running planning job takes it");
    assert.equal((await h.finish(running!)).status, 200);
    const proposals = await import('./proposals.ts');
    proposals.sweep();
    const [next, ...none] = queuedWork();
    assert.deepEqual([next.agent, none], ['flint', []]);
  } finally {
    await h.agent('projects/owner', juno.token, { id: 'game', owner: 'wren' });
  }
});

test('a project handed on is all or nothing: a notice refused part way publishes none of it', async () => {
  levels();
  const juno = await h.start({ agent: 'juno', title: 'The follow-through check', engine: 'claude' });
  const bolt = await h.start({ agent: 'bolt', title: 'Level art', engine: 'claude', thread: 'game/levels' });
  const moss = await h.start({ agent: 'moss', title: 'The shop', engine: 'claude' });
  for (const title of ['A second world', 'A third world'])
    assert.equal((await h.agent('proposals', bolt.token, { title, brief: 'More.' })).status, 200);
  const [planning] = queuedWork();
  const messages = await import('./messages.ts');
  for (let i = 1; i < messages.PER_HOUR; i++)
    messages.send({ agent: 'juno', job: juno.id }, 'bolt', `Note ${i}`, bolt.id);
  const events = await import('./events.ts');
  const heard: { type: string; to?: string }[] = [];
  const stop = events.onPublish(e => heard.push(e));
  try {
    const refused = await h.agent('projects/owner', juno.token, { id: 'game', owner: 'moss' });
    assert.equal(refused.status, 429);
  } finally {
    stop();
  }
  assert.deepEqual(
    heard.filter(e => e.type === 'chat'),
    [],
    'the first notice, rolled back, was never shown',
  );
  assert.equal(projects.findProject('game')?.owner, 'wren');
  assert.equal((db.prepare('select count(*) n from messages where recipient = ?').get('moss') as { n: number }).n, 0);
  assert.equal(h.job(planning.id).status, 'queued', "wren's planning job stays");
  assert.ok(moss);
});

test('a review bundle its owner left open gets their next planning job when it grows', async () => {
  const proposals = await import('./proposals.ts');
  const bundle = {
    agent: 'juno',
    title: 'Review follow-ups: refactoring and hardening',
    brief: '- one',
    project: 'game',
  };
  const id = proposals.bundle(bundle);
  const [planning] = queuedWork();
  assert.equal(planning.agent, 'wren');
  const running = await h.claim();
  assert.equal(running?.id, planning.id);
  assert.equal((await h.finish(running!)).status, 200);
  proposals.sweep();
  assert.deepEqual(queuedWork(), [], 'left open as it stood');
  assert.equal(proposals.bundle({ ...bundle, brief: '- one\n- two' }, id), id);
  proposals.sweep();
  const [next, ...none] = queuedWork();
  assert.deepEqual([next.agent, next.title, none], ['wren', 'Sort new proposals into the plan', []]);
});
