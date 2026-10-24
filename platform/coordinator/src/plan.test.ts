// node --test src/plan.test.ts   (throwaway DATA_DIR and the test company): projects as HQ's data, a project's plan (its
// threads, their needs and their tasks in order), who may change it, and the log of every change (plan.ts).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const FILE = `businesses:
  - { id: play, name: Play }
  - { id: tools, name: Tools }
projects:
  - { id: game, name: The game, owner: wren, business: play }
  - { id: shop, name: The shop, owner: moss, product: shop }
  - { id: broken, name: No owner }
`;
const h = await harness('plan', { before: repo => writeFileSync(`${repo}/company/projects.yaml`, FILE) });
const { db } = h;
const company = await import('./company.ts');
const projects = await import('./projects.ts');
const plan = await import('./plan.ts');
const hqMade = await import('./made.ts');
const proposals = await import('./proposals.ts');
const forecast = await import('./forecast.ts');
const file = `${h.repo}/company/projects.yaml`;

beforeEach(() =>
  db.exec(
    'delete from jobs; delete from wakes; delete from threads; delete from thread_needs; delete from plan_changes',
  ),
);

const thread = (slug: string, project = 'game') => {
  const t = projects.createThread({ project, name: `Thread ${slug}`, goal: 'It works', slug });
  assert.equal(typeof t, 'object', typeof t === 'string' ? t : '');
  return `${project}/${slug}`;
};
const task = (thread: string, title: string, agent = 'bolt') =>
  h.jobs.createJob({ agent, title, prompt: 'Do it.', thread, queuedBy: 'wren' }).id;
const changes = () =>
  (db.prepare('select project, thread, what, by from plan_changes order by id').all() as object[]).map(c => ({ ...c }));

test("the file's projects are lifted into HQ once, and stay HQ's: the file can lose them, and only the CEO makes or hands one on", async () => {
  const listed = () => company.projects().list.map(p => [p.id, p.owner]);
  assert.deepEqual(listed(), [
    ['game', 'wren'],
    ['shop', 'moss'],
  ]);
  assert.deepEqual(company.projects().list[1], { id: 'shop', name: 'The shop', owner: 'moss', product: 'shop' });
  try {
    writeFileSync(
      file,
      'businesses:\n  - { id: play, name: Play }\nprojects:\n  - { id: game, name: Renamed, owner: kit }\n',
    );
    assert.deepEqual(
      listed(),
      [
        ['game', 'wren'],
        ['shop', 'moss'],
      ],
      "a lifted project is HQ's: the file changes nothing",
    );
    writeFileSync(file, 'businesses:\n  - { id: play, name: Play }\n');
    assert.deepEqual(listed(), [
      ['game', 'wren'],
      ['shop', 'moss'],
    ]);
    assert.equal(company.projects().planning, 'off', "the platform's default");
    writeFileSync(file, 'planning: threads\n');
    assert.equal(company.projects().planning, 'threads');
  } finally {
    writeFileSync(file, FILE);
  }
  const wren = await h.start({ agent: 'wren' });
  const juno = await h.start({ agent: 'juno' });
  const made = { id: 'game-m2', name: 'Milestone two', owner: 'wren', business: 'play' };
  const refused = await h.agent('projects/new', wren.token, made);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /only the CEO makes projects/);
  for (const body of [
    { ...made, id: 'Bad Id' },
    { ...made, owner: 'nobody' },
    { ...made, business: 'nowhere' },
    { ...made, id: 'game' },
  ])
    assert.equal((await h.agent('projects/new', juno.token, body)).status, 400, JSON.stringify(body));
  assert.equal((await h.agent('projects/new', juno.token, made)).status, 200);
  assert.deepEqual(listed().at(-1), ['game-m2', 'wren']);
  assert.equal((await h.agent('projects/owner', wren.token, { id: 'game-m2', owner: 'kit' })).status, 400);
  const owner = await h.hq(juno, 'project', 'owner', 'game-m2', 'kit');
  assert.match(owner.out, /kit owns game-m2 now\./);
  assert.equal(projects.findProject('game-m2')?.owner, 'kit');
  assert.deepEqual(changes(), [
    { project: 'game-m2', thread: null, what: 'project made: Milestone two, owned by wren', by: 'juno' },
    { project: 'game-m2', thread: null, what: 'owner wren → kit', by: 'juno' },
  ]);
});

test('a thread needs others, in any project; a loop is refused at any depth', async () => {
  const [a, b, c, s] = [thread('a'), thread('b'), thread('c'), thread('till', 'shop')];
  assert.deepEqual(plan.need(b, a, 'wren'), { ok: true });
  assert.deepEqual(plan.need(c, b, 'wren'), { ok: true });
  assert.deepEqual(plan.need(s, c, 'moss'), { ok: true }, "across projects, by the needing thread's owner");
  assert.match(String(plan.need(a, s, 'wren')), /needs game\/a already \(or through others\): that would be a loop/);
  assert.match(String(plan.need(a, c, 'wren')), /loop/);
  assert.match(String(plan.need(a, a, 'wren')), /can't need itself/);
  assert.match(String(plan.need(b, a, 'wren')), /already/);
  assert.match(String(plan.need(a, 'game/none', 'wren')), /no thread game\/none/);
  assert.match(String(plan.need(s, a, 'wren')), /The shop's plan is moss's .*hq propose --project shop/);
  assert.deepEqual(plan.need(s, a, 'juno'), { ok: true }, 'the CEO changes any plan');
  assert.deepEqual(plan.unneed(c, b, 'wren'), { ok: true });
  assert.match(String(plan.unneed(c, b, 'wren')), /doesn't need/);
  assert.deepEqual(plan.need(a, c, 'wren'), { ok: true }, 'no loop once c no longer needs b');
  // a thread drawn with its needs
  const wren = await h.start({ agent: 'wren' });
  const drawn = await h.hq(wren, 'plan', 'thread', 'game', 'Boss', 'You beat the boss', '--needs', a, '--needs', c);
  // (read back in its product and project, beside its siblings.)
  assert.match(
    drawn.out,
    /^Thread drawn, needing game\/a, game\/c:\n {2}Play › The game › Boss \(game\/boss\)\n {2}done when You beat the boss\nThe game's other open threads:\n {2}game\/a {2}Thread a\n/,
  );
  assert.deepEqual(projects.needsOf('game/boss'), [a, c]);
  const board = (await h.board('/api/projects')).body.projects.find((p: { id: string }) => p.id === 'game');
  const boss = board.threads.find((t: { id: string }) => t.id === 'game/boss');
  assert.deepEqual([boss.needs, boss.owner], [[a, c], 'wren']);
});

test("a thread's tasks in order: moved by the owner, a later task still last; a task dropped", async () => {
  const t = thread('levels');
  const [one, two, three] = [task(t, 'One'), task(t, 'Two'), task(t, 'Three')];
  const order = () =>
    (plan.planOf('game', forecast.current()) as any).threads[0].tasks.map((j: { id: number }) => j.id);
  assert.deepEqual(order(), [one, two, three], 'id order to start with');
  assert.match(String(plan.move(three, 1, 'bolt')), /The game's plan is wren's/);
  assert.match(String(plan.move(three, 4, 'wren')), /a place is 1 to 3/);
  assert.deepEqual(plan.move(three, 1, 'wren'), { ok: true, order: [three, one, two] });
  const four = task(t, 'Four');
  assert.deepEqual(order(), [three, one, two, four]);
  const wren = await h.start({ agent: 'wren' });
  assert.match(
    (await h.hq(wren, 'plan', 'move', String(four), '2')).out,
    new RegExp(`In order now: #${three}, #${four}, #${one}, #${two}\\.`),
  );
  assert.match(
    (await h.hq(wren, 'plan', 'drop', String(two), 'Not needed now')).out,
    new RegExp(`Job #${two} left the plan\\.`),
  );
  assert.equal(h.job(two).status, 'cancelled');
  assert.deepEqual(order(), [three, four, one]);
  const shown = await h.hq(wren, 'plan', 'game');
  assert.match(shown.out, /^The game \(game\), wren's plan \(threads in order: off\)$/m);
  assert.match(
    shown.out,
    new RegExp(
      `^game/levels  Thread levels: .*\\n  done when It works\\n  1\\. #${three} bolt \\(.*, queued\\): Three\\n  2\\. #${four} `,
      'm',
    ),
  );
  assert.equal(JSON.parse((await h.hq(wren, 'plan', 'game', '--json')).out).threads[0].tasks.length, 3);
  const board = (await h.board('/api/projects')).body.projects.find((p: { id: string }) => p.id === 'game');
  const seqs = new Map(board.threads[0].jobs.map((j: { id: number; seq: number }) => [j.id, j.seq]));
  assert.ok(
    (seqs.get(three) as number) < (seqs.get(four) as number) && (seqs.get(four) as number) < (seqs.get(one) as number),
    'the view has the order',
  );
  assert.deepEqual(
    changes().map((c: any) => [c.what, c.by]),
    [
      [`task #${one} added: One`, 'wren'],
      [`task #${two} added: Two`, 'wren'],
      [`task #${three} added: Three`, 'wren'],
      [`task #${three} moved to place 1`, 'wren'],
      [`task #${four} added: Four`, 'wren'],
      [`task #${four} moved to place 2`, 'wren'],
      [`task #${two} dropped: Not needed now`, 'wren'],
    ],
  );
});

test('hq plan lists threads with those they need first', async () => {
  const [late, early] = [thread('late'), thread('early')];
  plan.need(late, early, 'wren');
  const ids = (plan.planOf('game', forecast.current()) as any).threads.map((t: { id: string }) => t.id);
  assert.deepEqual(ids, [early, late]);
  assert.equal(plan.planOf('nowhere', forecast.current()), undefined);
});

test("hq plan carries its product's other open projects, none for a project in no product", async () => {
  const product = (id: string) => (plan.planOf(id, forecast.current()) as any).product;
  const juno = await h.start({ agent: 'juno' });
  for (const [id, name] of [
    ['tools-current', 'Current release'],
    ['tools-next', 'Next release'],
  ]) {
    const made = await h.agent('projects/new', juno.token, { id, name, owner: 'wren', business: 'tools' });
    assert.equal(made.status, 200);
  }
  assert.deepEqual(product('tools-current'), {
    name: 'Tools',
    others: [{ id: 'tools-next', name: 'Next release' }],
  });
  assert.equal(product('shop'), null);
  assert.deepEqual(plan.projectDone('tools-next', 'wren'), { ok: true });
  assert.deepEqual(product('tools-current'), { name: 'Tools', others: [] });
});
test("the company's levels: its own lines in a refusal and the planning job, its look ahead and sizes in the plan, a wrong one named", async () => {
  const levels = await import('./levels.ts');
  const own = `${h.repo}/company/levels.json`;
  const sizes = (...ms: number[]) => ms.map((size_ms, i) => ({ id: i, status: 'queued', started: null, size_ms }));
  const HOUR = 60 * 60_000;
  const none = levels.levelsOf();
  assert.deepEqual(none.split, { task_ms: null, thread_ms: null }, 'none set: no marks');
  assert.equal(levels.splitMarks(sizes(9 * HOUR), none.split).split, false);
  try {
    writeFileSync(
      own,
      JSON.stringify({
        thread: 'A thread here ends within hours.',
        examples: [{ level: 'thread', from: 'Levels, done', to: 'Ten playable levels' }],
        terms: { arcade: "the game's level select" },
        ahead: 'Plan the next milestone.',
        split_minutes: { task: 120, thread: 480 },
      }),
    );
    const t = thread('levels');
    assert.match(
      String(plan.newThread({ project: 'game', name: 'The game', goal: 'g' }, { agent: 'wren' })),
      /A thread here ends within hours\.$/,
    );
    assert.match(
      String(
        plan.newProject(
          { id: 'arcade-4', name: 'Thread levels', owner: 'wren', business: 'play', code: 'AF' },
          'juno',
          () => true,
        ),
      ),
      /A project is a part of its product/,
      "the platform's line for a level the company has none for",
    );
    // (the foundation's guide with the company's own after it.)
    const guide = levels.levelsOf();
    assert.match(
      guide.lines.thread,
      /^A thread takes its project to its "done when".* A thread here ends within hours\.$/,
    );
    assert.deepEqual(guide.examples.at(-1), { level: 'thread', from: 'Levels, done', to: 'Ten playable levels' });
    assert.ok(guide.examples.length > 1, "the foundation's examples first");
    assert.deepEqual([guide.terms.arcade, typeof guide.terms.seat], ["the game's level select", 'string']);
    const read = plan.planOf('game', forecast.current()) as any;
    assert.deepEqual(
      [read.ahead, read.split],
      ['Plan the next milestone.', { task_ms: 2 * HOUR, thread_ms: 8 * HOUR }],
    );
    assert.equal(read.threads.find((r: { id: string }) => r.id === t).split, false);
    const marked = levels.splitMarks(
      [...sizes(2.5 * HOUR, 2 * HOUR, 3 * HOUR), { id: 9, status: 'running', started: 'now', size_ms: 3 * HOUR }],
      read.split,
    );
    assert.deepEqual(
      marked.tasks.map(j => j.split),
      [true, false, true, false],
      'past the size and still to start',
    );
    assert.deepEqual([marked.to_do_ms, marked.split], [10.5 * HOUR, true]);
    for (const [wrong, named] of [
      [{ split_minutes: { task: '2h' } }, /split_minutes\.task/],
      [{ ahead: ['a'] }, /levels\.json ahead/],
      [{ examples: [{ level: 'chapter', from: 'a', to: 'b' }] }, /levels\.json examples/],
      [{ terms: { arcade: 3 } }, /levels\.json terms\.arcade/],
    ] as const) {
      writeFileSync(own, JSON.stringify(wrong));
      assert.throws(() => levels.levelsOf(), named);
    }
  } finally {
    rmSync(own, { force: true });
  }
});
test("a moved thread keeps what it needs and what needs it, the plan's tools take its old id, a moved task its id's place", async () => {
  const regroup = await import('./regroup.ts');
  const [a, b, c] = [thread('a'), thread('b'), thread('c')];
  assert.deepEqual(plan.need(b, a, 'wren'), { ok: true });
  assert.deepEqual(plan.need(a, c, 'wren'), { ok: true });
  assert.equal(typeof regroup.moveThread(a, 'shop', 'juno'), 'object');
  assert.deepEqual([projects.needsOf(b), projects.needsOf('shop/a')], [['shop/a'], [c]]);
  assert.match(String(plan.need(c, a, 'wren')), /needs game\/c already .* loop/, 'by its old id');
  assert.deepEqual(plan.unneed(b, a, 'wren'), { ok: true });
  assert.deepEqual(projects.needsOf(b), []);
  const [one, two] = [task(c, 'One'), task(c, 'Two')];
  assert.deepEqual(plan.move(two, 1, 'wren'), { ok: true, order: [two, one] });
  assert.equal(typeof regroup.moveJob(two, b, 'juno'), 'object');
  assert.equal((db.prepare('select seq from jobs where id = ?').get(two) as { seq: number | null }).seq, null);
  assert.deepEqual(plan.unneed('shop/a', c, 'moss'), { ok: true });
  assert.deepEqual(plan.done(a, 'moss'), { ok: true });
  assert.equal(projects.findThread('shop/a')?.status, 'done');
});

test('no two levels share a name: a thread, a project and a task, compared case-blind, punctuation and "the" aside', async () => {
  const levels = thread('levels');
  const juno = await h.start({ agent: 'juno' });
  const made = { id: 'arcade', name: 'The arcade', owner: 'kit', business: 'play' };
  assert.equal((await h.agent('projects/new', juno.token, made)).status, 200);
  const draw = (project: string, name: string) =>
    plan.newThread({ project, name, goal: 'It ships' }, { agent: 'juno' });
  assert.match(
    String(draw('game', 'the GAME!')),
    /^"the GAME!" is the name of the project game: No two levels share a name\. A thread /,
  );
  assert.match(
    String(draw('arcade', 'Thread  levels.')),
    /is the name of the open thread game\/levels: No two levels share a name/,
    'in the product',
  );
  assert.match(String(draw('game', 'Arcade')), /the project arcade/, "a sibling project's name too");
  assert.equal(typeof draw('shop', 'Thread levels'), 'object', 'another product');
  assert.equal(typeof draw('game', 'Thread levels again'), 'object', 'only exact clashes');
  plan.done(levels, 'wren');
  assert.equal(typeof draw('game', 'Thread levels'), 'object', "a done thread's name is free");
  // projects: made or renamed to a name its product has
  assert.match(
    String(plan.newProject({ ...made, id: 'arcade-2', code: 'AB' }, 'juno', () => true)),
    /the project arcade/,
  );
  assert.match(String(plan.renameProject('arcade', 'thread levels', 'juno')), /the open thread game\/thread-levels/);
  assert.equal(
    typeof plan.newProject({ ...made, id: 'arcade-3', business: undefined, code: 'AC' }, 'juno', () => true),
    'object',
  );
  // a task: hq job into a thread, into a new one, or inheriting its job's thread
  const wren = await h.start({ agent: 'wren', thread: 'game/thread-levels' });
  const queue = (title: string, more: object = {}) =>
    h.agent('job', wren.token, { agent: 'bolt', title, prompt: 'Do it.', ...more });
  const inherited = await queue('Thread levels');
  assert.equal(inherited.status, 400);
  assert.match(
    inherited.body.error,
    /^"Thread levels" is the name of its thread game\/thread-levels: No two levels share a name\. A task is/,
  );
  assert.match((await queue('the game', { thread: 'game/thread-levels' })).body.error, /its project game/);
  assert.match(
    (await queue('Boss', { newThread: { project: 'game', name: 'Boss', goal: 'Beaten' } })).body.error,
    /its thread "Boss"/,
  );
  assert.equal(projects.findThread('game/boss'), undefined, 'nothing drawn');
  assert.equal(
    (await queue('Draw the boss', { newThread: { project: 'game', name: 'Boss', goal: 'Beaten' } })).status,
    200,
  );
  // HQ's own one-task thread is named after its job, whatever the plan has
  assert.equal(typeof hqMade.oneTaskThread('game', { id: 900, title: 'Boss' }), 'string');
});

test('a thread renamed keeps its old id; a task retitled; a project renamed by the CEO; read back as the board reads them', async () => {
  const [levels, boss] = [thread('levels'), thread('boss')];
  plan.need(boss, levels, 'wren');
  const one = h.queue({ agent: 'bolt', title: 'One', thread: levels, queuedBy: 'wren' });
  assert.match(String(plan.rename(levels, { name: 'Ten levels' }, 'bolt')), /The game's plan is wren's/);
  assert.match(String(plan.rename(levels, { name: 'Thread boss' }, 'wren')), /the open thread game\/boss/);
  assert.match(String(plan.rename(levels, { name: 'Ten', slug: 'Bad Slug' }, 'wren')), /a slug is/);
  assert.match(String(plan.rename(levels, { name: 'Ten', slug: 'boss' }, 'wren')), /game\/boss is already a thread/);
  assert.match(String(plan.rename(levels, { name: 'Thread levels' }, 'wren')), /named that already/);
  const wren = await h.start({ agent: 'wren' });
  const renamed = await h.hq(
    wren,
    'plan',
    'rename',
    levels,
    'Ten levels to play',
    'all ten are playable',
    '--slug',
    'ten-levels',
  );
  assert.equal(
    renamed.out,
    'Thread renamed (game/levels still finds it):\n  Play › The game › Ten levels to play (game/ten-levels)\n' +
      "  done when all ten are playable\nThe game's other open threads:\n  game/boss  Thread boss\n",
  );
  assert.equal(projects.findThread(levels)?.id, 'game/ten-levels', 'the old id resolves');
  assert.deepEqual([h.job(one).thread, projects.needsOf(boss)], ['game/ten-levels', ['game/ten-levels']]);
  assert.deepEqual(
    (plan.rename(levels, { name: 'Ten levels' }, 'juno') as { was: string }).was,
    'game/ten-levels',
    'the CEO, by the old id',
  );
  plan.done(boss, 'wren');
  assert.match(String(plan.rename(boss, { name: 'Boss' }, 'wren')), /game\/boss is done/);
  // a task's title
  assert.match(String(plan.title(one, 'Ten levels', 'wren')), /is the name of its thread game\/ten-levels/);
  assert.match(String(plan.title(one, 'Level one', 'bolt')), /wren's/);
  assert.match(
    (await h.hq(wren, 'plan', 'title', String(one), 'Draw level one')).out,
    /Job #\d+ is titled Draw level one now\./,
  );
  assert.equal(h.job(one).title, 'Draw level one');
  assert.equal((await h.claim(h.job(one).engine))?.id, one);
  assert.match(String(plan.title(one, 'Level one', 'wren')), /only a task still to start/);
  // a project's name: the CEO's
  assert.match(String(plan.renameProject('game', 'The games', 'wren')), /only the CEO renames a project/);
  assert.match(String(plan.renameProject('game', 'Ten levels', 'juno')), /the open thread game\/ten-levels/);
  const juno = await h.start({ agent: 'juno' });
  assert.match((await h.hq(juno, 'project', 'rename', 'game', 'The level game')).out, /game is The level game now\./);
  assert.equal(projects.findProject('game')?.name, 'The level game');
  plan.renameProject('game', 'The game', 'juno');
  assert.deepEqual(
    changes().map((c: any) => [c.thread, c.what]),
    [
      ['game/boss', 'needs game/levels'],
      ['game/levels', `task #${one} added: One`],
      [
        'game/ten-levels',
        'thread renamed: name Thread levels → Ten levels to play; done when all ten are playable; id game/levels → game/ten-levels',
      ],
      ['game/ten-levels', 'thread renamed: name Ten levels to play → Ten levels'],
      ['game/boss', 'thread done'],
      ['game/ten-levels', `task #${one} titled: Draw level one`],
      [null, 'project renamed: The game → The level game'],
      [null, 'project renamed: The level game → The game'],
    ],
  );
  // its own old slug may come back; another thread's never
  assert.match(
    String(plan.rename(levels, { name: 'Ten levels', slug: 'boss' }, 'wren')),
    /game\/boss is already a thread/,
  );
  assert.equal(
    (plan.rename(levels, { name: 'Ten levels', slug: 'levels' }, 'wren') as { id: string }).id,
    'game/levels',
  );
  assert.equal(projects.findThread('game/ten-levels')?.id, 'game/levels');
});

test('a project done leaves the lists once nothing is left in it, and stays among the completed', async () => {
  const juno = await h.start({ agent: 'juno' });
  const made = { id: 'privacy', name: 'Our details off the listings', owner: 'wren' };
  assert.equal((await h.agent('projects/new', juno.token, made)).status, 200);
  const site = thread('site-one', 'privacy');
  const asking = await h.start({ agent: 'bolt', title: 'Ask site one', thread: site });
  const one = asking.id;
  // (a proposal to the owner: its planning job, on the Front Desk, in no thread of the project)
  const proposed = await h.agent('proposals', asking.token, { title: 'Site two', brief: 'x', project: 'privacy' });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  const proposal = proposed.body as { id: number };
  const planning = await h.claim();
  assert.deepEqual([planning?.agent, planning?.title], ['wren', 'Sort new proposals into the plan']);
  assert.match(String(plan.projectDone('privacy', 'bolt')), /wren's/);
  assert.equal(
    plan.projectDone('privacy', 'wren'),
    `privacy isn't done yet: it has open threads privacy/site-one (hq plan done, or hq thread move); work still to run or in review: #${one}; proposals in its inbox: #${proposal.id} (hq inbox)`,
  );
  assert.equal((await h.finish(asking)).status, 200);
  const dropped = await h.agent('proposals/drop', planning!.token, { id: proposal.id, why: 'One site at a time' });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
  assert.equal((await h.finish(planning!)).status, 200);
  assert.deepEqual(plan.done(site, 'wren'), { ok: true });
  const wren = await h.start({ agent: 'wren' });
  assert.match((await h.hq(wren, 'project', 'done', 'privacy')).out, /privacy is done: it has left the lists/);
  assert.equal(plan.projectDone('privacy', 'wren'), 'privacy is done already');
  assert.equal(projects.findProject('privacy'), undefined);
  assert.equal(proposals.list('bolt').find(p => p.id === proposal.id)?.status, 'dropped');
  assert.deepEqual(
    projects.listThreads({ all: true }).filter(t => t.project === 'privacy'),
    [],
  );
  const board = (await h.board('/api/projects')).body;
  assert.equal(
    board.projects.some((p: { id: string }) => p.id === 'privacy'),
    false,
  );
  const done = board.completed.find((p: { id: string }) => p.id === 'privacy');
  // (its name the board's, the agent's words until it's made: plainnames.test.ts.)
  assert.deepEqual(
    [done.name, done.naming, done.threads.map((t: any) => [t.id, t.jobs, t.done])],
    ['Our details off the listings', undefined, [[site, 1, 1]]],
  );
  assert.ok(done.done, 'with when');
  assert.equal(
    board.unsorted.some((j: { id: number }) => j.id === one),
    false,
    "its jobs aren't loose",
  );
  assert.match(
    String(plan.newThread({ project: 'privacy', name: 'Site three', goal: 'Gone' }, { agent: 'wren' })),
    /privacy is done: a finished area that comes back is a new project/,
  );
  assert.equal(hqMade.oneTaskThread('privacy', { id: 901, title: 'Notes' }), null, 'HQ puts its own job in none');
  const now = Date.now(); // (but not one with a window.)
  assert.throws(
    () => hqMade.oneTaskThread('privacy', { id: 901, title: 'Notes' }, { deadline: now, aim: now }),
    /its project privacy is done/,
  );
  assert.throws(() => hqMade.oneTaskThread('missing-project', { id: 902, title: 'Notes' }));
  assert.match(String(plan.done(site, 'wren')), /privacy, which is done/);
  assert.match(
    String(plan.newProject({ ...made, code: 'PV' }, 'juno', () => true)),
    /privacy is a project already \(or was one\)/,
  );
  assert.deepEqual(changes().at(-1), { project: 'privacy', thread: null, what: 'project done', by: 'wren' });
});

test("a job HQ makes goes to its kind's project for its app, a one-task thread there with the window it's given; none configured, no thread, which a window can't do without", () => {
  writeFileSync(file, `${FILE}made:\n  checks: { hq: game }\n`);
  try {
    const placed = (id: number) =>
      db
        .prepare(
          'select j.thread, t.deadline, t.aim, t.deadline_by by from jobs j left join threads t on t.id = j.thread where j.id = ?',
        )
        .get(id) as { thread: string | null; deadline: number | null; aim: number | null; by: string | null };
    const job = () => h.jobs.createJob({ agent: 'bolt', title: 'Made by HQ', prompt: 'Do it.' }).id;
    const due = Date.now() + 3_600_000;
    const check = hqMade.made('checks', 'hq', { id: job() }, { deadline: due, aim: due });
    assert.deepEqual({ ...placed(check) }, { thread: `game/job-${check}`, deadline: due, aim: due, by: 'hq' });
    const loose = hqMade.made('errors', 'hq', { id: job() });
    assert.deepEqual({ ...placed(loose) }, { thread: null, deadline: null, aim: null, by: null });
    assert.throws(() => hqMade.made('alarms', 'hq', { id: job() }, { deadline: due, aim: due }), /has no project/);
  } finally {
    writeFileSync(file, FILE);
  }
});

test("a project moved into a business by the CEO, or out of any: its name and its threads' checked against its new product, logged", async () => {
  const wren = await h.start({ agent: 'wren' });
  const juno = await h.start({ agent: 'juno' });
  const refused = await h.agent('projects/business', wren.token, { id: 'shop', business: 'play' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /only the CEO moves a project into a business/);
  assert.equal(
    plan.setBusiness('shop', 'games', 'juno'),
    `there's no business "games": the businesses are play, tools, or none`,
  );
  assert.match(String(plan.setBusiness('game', 'play', 'juno')), /game is in play already/);
  assert.match(String(plan.setBusiness('shop', 'none', 'juno')), /shop is in no business already/);
  // a name its new product has: refused, as a rename is
  const sibling = thread('shop-thread');
  assert.equal(typeof plan.rename(sibling, { name: 'Shop' }, 'wren'), 'object');
  assert.match(
    String(plan.setBusiness('shop', 'play', 'juno')),
    /"The shop" is the name of the open thread game\/shop-thread/,
  );
  plan.done(sibling, 'wren');
  // and so is one of its open threads', but for HQ's one-task threads, named after their jobs
  for (const project of ['shop', 'game'])
    assert.equal(typeof projects.createThread({ project, name: 'Rumble', goal: 'It works', slug: 'rumble' }), 'object');
  const made = h.jobs.createJob({ agent: 'bolt', title: 'The game', prompt: 'Do it.' }).id;
  assert.equal(hqMade.oneTaskThread('shop', { id: made, title: 'The game' }), `shop/job-${made}`);
  assert.match(
    String(plan.setBusiness('shop', 'play', 'juno')),
    /^"Rumble" is the name of the open thread game\/rumble: No two levels share a name\. A thread /,
  );
  plan.done('game/rumble', 'wren');
  const moved = await h.hq(juno, 'project', 'business', 'shop', 'play');
  assert.match(moved.out, /shop is in play now\./);
  assert.deepEqual(projects.findProject('shop'), {
    id: 'shop',
    name: 'The shop',
    owner: 'moss',
    product: 'shop',
    business: 'play',
  });
  assert.match((await h.hq(juno, 'project', 'business', 'shop', 'none')).out, /shop is in no business now\./);
  assert.equal(projects.findProject('shop')?.business, undefined);
  // a done project stays where it ended
  assert.equal(
    typeof plan.newProject({ id: 'moved-done', name: 'Over', owner: 'wren', code: 'MV' }, 'juno', () => true),
    'object',
  );
  assert.deepEqual(plan.projectDone('moved-done', 'juno'), { ok: true });
  assert.match(String(plan.setBusiness('moved-done', 'tools', 'juno')), /moved-done is done: a finished area/);
  assert.deepEqual(
    changes()
      .filter((c: any) => c.project === 'shop' && c.thread === null)
      .map((c: any) => [c.what, c.by]),
    [
      ['business none → play', 'juno'],
      ['business play → none', 'juno'],
    ],
  );
});
