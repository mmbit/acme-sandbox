// node --test src/outlooks.test.ts   (throwaway DATA_DIR and the test company): each thread's outlook from the
// forecast (forecast.ts), its planned finish against its window and the slack that leaves, as the projects view, hq
// projects and hq thread read them (outlooks.ts).
//
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('outlooks', {
  before: repo =>
    writeFileSync(
      `${repo}/company/projects.yaml`,
      'projects:\n  - { id: game, name: The game, owner: wren }\n  - { id: shop, name: The shop, owner: moss }\n',
    ),
});
const { db, jobs } = h;
const projects = await import('./projects.ts');
const forecast = await import('./forecast.ts');
const windows = await import('./windows.ts');
const wakes = await import('./wakes.ts');
const { newThread } = await import('./newthread.ts');

const MINUTE = 60_000,
  HOUR = 60 * MINUTE;
// The test company's first guess is a 30-minute own run. Review and ruling runs share the reported room.
const RUN = 30 * MINUTE,
  REVIEW = 30 * MINUTE;
let T = Date.now();

const thread = (slug: string, project = 'game') => {
  const t = projects.createThread({ project, name: `The ${slug}`, goal: 'It works', slug });
  assert.equal(typeof t, 'object', typeof t === 'string' ? t : '');
  return (t as { id: string }).id;
};
const queued = (thread: string, o: Record<string, unknown> = {}) =>
  jobs.createJob({ agent: 'bolt', title: 'A step', prompt: 'x', queuedBy: 'wren', thread, word: 'STEP', ...o }).id;
// A window on the thread, given by its owner
const windowed = (id: string, deadline: number, aim = deadline) =>
  windows.set(projects.findThread(id)!, { deadline, aim }, 'wren');
const reportRoom = () =>
  h.worker('room', {
    capacity: {
      slots: { claude: 1, codex: 1 },
      seatRuns: { codex: 1 },
      room: 1,
    },
  });

beforeEach(async () => {
  db.exec(
    'delete from jobs; delete from threads; delete from runs; delete from predictions; delete from seats; delete from waits; delete from prs; delete from wakes',
  );
  for (const engine of ['claude', 'codex'])
    assert.equal(
      (await h.worker('seat', { seat: `${engine}-1`, engine, state: 'ready', util: 0.1, week: 0.1 })).status,
      200,
    );
  await reportRoom();
  T = Date.now();
});

test("a thread's two numbers: the agent time its open work has left, and its last job merged; the chain sets it", () => {
  const levels = thread('levels'),
    shop = thread('checkout', 'shop');
  const first = queued(levels);
  const second = queued(levels, { after: first });
  const elsewhere = queued(shop);
  const waiting = queued(levels, { after: elsewhere });
  const f = forecast.refresh(T);
  const o = f.threads.get(levels)!;
  assert.deepEqual(o.jobs, [first, second, waiting]);
  assert.equal(o.left_ms, 3 * RUN, "each job's agent time, added up: hours, not a time");
  const merged = (id: number) => f.usual.get(id)!.merged!;
  assert.equal(o.eta, Math.max(merged(second), merged(waiting)), 'its last open job merged');
  assert.ok(o.eta! >= T + 2 * (RUN + REVIEW), 'one after the other, each with its review');
  assert.equal(o.chain[0].job, merged(second) >= merged(waiting) ? second : waiting);
  assert.ok(
    o.chain.some(l => l.job === first || l.job === elsewhere),
    'the chain goes back through the job it waits for',
  );
  const across = o.waits.find(w => w.on === 'job');
  assert.deepEqual(across, { on: 'job', job: elsewhere, thread: shop }, "a wait on another thread's job names it");
  assert.equal(o.next, first, 'the job that goes on first');
  assert.equal(f.threads.get(shop)!.jobs.length, 1);
});

test("each thread's window and slack: one that gives, one that misses, one without; the view and hq read them", async () => {
  const gives = thread('gives'),
    misses = thread('misses'),
    none = thread('none');
  for (const id of [gives, misses, none]) queued(id);
  windowed(gives, T + 2 * 24 * HOUR, T + MINUTE);
  windowed(misses, T + MINUTE);
  const board = await h.board('/api/projects');
  const shown = (id: string) =>
    board.body.projects.find((p: any) => p.id === 'game').threads.find((t: any) => t.id === id).outlook;
  for (const [id, standing] of [
    [gives, 'gives'],
    [misses, 'misses'],
    [none, null],
  ] as const) {
    const o = shown(id);
    assert.equal(o.standing, standing, id);
    assert.ok(o.finish >= o.eta, `${id}: its last merge, then the deploy`);
    assert.equal(o.slack, o.deadline === null ? null : o.deadline - o.finish, `${id}: the deadline less its finish`);
  }
  assert.equal(shown(gives).aim, T + MINUTE);
  assert.ok(shown(misses).slack < 0);
  assert.equal(shown(none).deadline, null);
  const lead = await h.start({ agent: 'juno' });
  const listed = await h.hq(lead, 'projects');
  assert.equal(listed.code, 0, listed.out);
  const line = (id: string) => listed.out.split('\n').find(l => l.startsWith(`${id}  `)) ?? '';
  assert.match(
    line(gives),
    /; planned finish .* UTC; window aim .* UTC, deadline .* UTC: gives \d.* \d.* of slack; next #/,
  );
  assert.match(line(misses), /; planned finish .* UTC; MISSES its deadline .* UTC by \d.*; next #/);
  assert.match(
    line(none),
    /^game\/none {2}The none \(wren\): ETA .* UTC, 30 min of agent time left;.* no deadline set; next #/,
  );
  const one = await h.hq(lead, 'thread', misses);
  assert.equal(one.code, 0, one.out);
  assert.match(one.out, /MISSES its deadline/);
  // off a call, the facts alone; on one, what to check and do about the miss before the board hears a time
  assert.doesNotMatch(listed.out + one.out, /RED FLAG/);
  const onCall = await h.hq({ ...lead, call: true }, 'thread', misses);
  assert.match(onCall.out, new RegExp(`RED FLAG, not news for the board: ${misses} misses its deadline\\.`));
  assert.match(
    onCall.out,
    /other work ahead of it.*its window puts it first[^]*whether to look further after the call\./,
  );
  // the eta tool's lookup, by words
  const found = await h.hq({ ...lead, call: true }, 'projects', 'the', 'game');
  assert.match(found.out, /RED FLAG, not news for the board: The misses misses its deadline\./);
  // the job tool's answer lists every agreed deadline: on a call, the one it misses comes with the same instruction,
  // after the line that asks the agent to judge the late forecast
  const job = (call: boolean) =>
    h.hq({ ...lead, call }, 'job', 'bolt', 'Another step', '--thread', none, '--new', '--code', call ? 'CALL' : 'DESK');
  const queuedOff = await job(false);
  assert.equal(queuedOff.code, 0, queuedOff.out);
  assert.match(queuedOff.out, /- The game's The misses: deadline .*; done about .* past it/);
  assert.doesNotMatch(queuedOff.out, /RED FLAG/);
  const queuedOn = await job(true);
  assert.equal(queuedOn.code, 0, queuedOn.out);
  assert.match(
    queuedOn.out,
    /\nA planned finish past an agreed deadline is a slip to judge: find why and what would bring the finish back\. [^\n]*\n\nRED FLAG, not news for the board: The game's The misses misses its deadline\. [^]*don't raise it again\./,
  );
  // and hq window's, for the windows it leaves missing
  const window = await h.hq({ ...lead, call: true }, 'window', misses, '1m', '--try');
  assert.match(
    window.out,
    /\nMisses The game's The misses: [^]*RED FLAG, not news for the board: The game's The misses misses its deadline\./,
  );
});

test('the view and hq read its jobs: the chain that sets its ETA, each job sized, and the one next', async () => {
  const levels = thread('levels');
  const first = queued(levels);
  queued(levels, { after: first });
  const board = await h.board('/api/projects');
  const shown = board.body.projects.find((p: any) => p.id === 'game').threads.find((t: any) => t.id === levels);
  assert.equal(shown.outlook.left_ms, 2 * RUN);
  const lead = await h.start({ agent: 'juno' });
  const lines = await h.agent('projects', lead.token);
  assert.equal(lines.status, 200);
  assert.equal(lines.body.find((t: any) => t.id === levels).next.id, first);
  const one = await h.agent(`thread?id=${encodeURIComponent(levels)}`, lead.token);
  assert.equal(one.status, 200);
  assert.deepEqual(
    one.body.jobs.map((j: any) => [j.id, j.size_ms]),
    [
      [first, RUN],
      [first + 1, RUN],
    ],
  );
  assert.equal((await h.agent('thread?id=game%2Fnone', lead.token)).status, 404);
  const shownOne = await h.hq(lead, 'thread', levels);
  assert.equal(shownOne.code, 0, shownOne.out);
  assert.match(
    shownOne.out,
    new RegExp(`^What sets its ETA: #${first + 1} \\(bolt, queued.* after #${first} \\(bolt, queued`, 'm'),
  );
  assert.match(shownOne.out, /^ {2}#\d+ STEP bolt \(queued\): A step\n {4}sized 30 min, 30 min left; /m);
});

test('a thread nothing finishes says why, and misses its window', async () => {
  const levels = thread('levels');
  queued(levels, { forSeat: 'claude-9' }); // a seat that isn't there: nothing runs it
  windowed(levels, T + 2 * 24 * HOUR);
  forecast.refresh(T);
  const lead = await h.start({ agent: 'juno' });
  const one = (await h.agent(`thread?id=${encodeURIComponent(levels)}`, lead.token)).body.outlook;
  assert.equal(one.finish, null);
  assert.equal(one.standing, 'misses');
  assert.match(one.stall, /^No claude seat/);
  const listed = await h.hq(lead, 'projects');
  assert.match(
    listed.out,
    /^game\/levels {2}.*: no ETA \(No claude seat.*\).*; MISSES its deadline .* UTC: no finish in sight/m,
  );
});

test("a thread whose work is booked past the play's horizon says when it's booked for, not only that it has no time", async () => {
  const later = thread('later'),
    soon = thread('soon'),
    held = thread('held');
  // (booked as hq job --when books it: a time wake, to the minute)
  const book = (job: number, at: number) => {
    const given = wakes.readWhen(`${new Date(at).toISOString().slice(0, 16)}Z`, T);
    assert.ok(Array.isArray(given), String(given));
    wakes.hold(job, given, T);
  };
  const at = Math.ceil((T + 20 * 24 * HOUR) / MINUTE) * MINUTE;
  book(queued(later), at);
  book(queued(soon), Math.ceil((T + HOUR) / MINUTE) * MINUTE);
  // (a usage limit's or a retry's wait, past the horizon too: no booking)
  db.prepare('update jobs set not_before = ? where id = ?').run(at, queued(held));
  forecast.refresh(T);
  const board = await h.board('/api/projects');
  const threadOf = (id: string) =>
    board.body.projects.find((p: any) => p.id === 'game').threads.find((t: any) => t.id === id);
  const shown = (id: string) => threadOf(id).outlook;
  assert.equal(shown(later).finish, null);
  assert.equal(shown(later).booked, at, 'its start, which the play never reaches');
  assert.equal(threadOf(later).jobs[0].estimate.booked, at, "and its job's, for its row");
  assert.match(shown(later).stall, /^booked to start .+, past the \d+ days/);
  assert.equal(shown(soon).booked, null, 'a booking inside the horizon gives a time instead');
  assert.ok(shown(soon).finish > T + HOUR);
  assert.equal(shown(held).finish, null);
  assert.equal(shown(held).booked, null, 'a not_before alone is no booking');
  assert.equal(threadOf(held).jobs[0].estimate.booked, null);
  assert.match(shown(held).stall, /^nothing in the queue's play lets it merge/);
});

// The call's eta tool runs hq projects <words>: the threads a name or a few words find, everything by name.
test("found by a project's or thread's name or words, on a call too: each thread's ETA, window and waits by name", async () => {
  const levels = thread('levels'),
    checkout = thread('checkout', 'shop');
  const ahead = queued(checkout, { title: 'Pay by card' });
  queued(levels, { after: ahead, title: 'Level two' });
  windowed(levels, T + 2 * 24 * HOUR);
  forecast.refresh(T);
  const onCall = (await h.voice('call-context?agent=juno')).body.token as string;
  const found = await h.agent(`outlooks?q=${encodeURIComponent("What's the ETA on the game?")}`, onCall);
  assert.equal(found.status, 200, 'the call token opens it');
  assert.deepEqual(
    found.body.projects.map((p: any) => [p.name, p.owner, p.threads.map((t: any) => t.name)]),
    [['The game', 'Wren', ['The levels']]],
    "a project by its name: the game's, not the shop's",
  );
  const levelsFound = found.body.projects[0].threads[0];
  assert.equal(levelsFound.outlook.standing, 'holds');
  assert.deepEqual(
    levelsFound.outlook.waits.filter((w: any) => w.on === 'job').map((w: any) => [w.title, w.agent, w.thread_name]),
    [['Pay by card', 'Bolt', 'The checkout']],
  );
  assert.deepEqual(
    (await h.agent('outlooks?q=checkout', onCall)).body.projects[0].threads.length,
    1,
    'a thread by name',
  );
  assert.equal((await h.agent('outlooks?q=what%20is%20the', onCall)).status, 400, 'no words that name anything');
  // A named project's threads, beside the threads the other words share most with
  projects.createThread({ project: 'shop', name: 'Current payment status', goal: 'It works', slug: 'payments' });
  thread('share-platform');
  const named = async (q: string) =>
    (await h.agent(`outlooks?q=${encodeURIComponent(q)}`, onCall)).body.projects.map((p: any) => [
      p.name,
      p.threads.map((t: any) => t.name),
    ]);
  assert.deepEqual(
    await named("What's the current status and ETA on the game?"),
    [
      ['The game', ['The levels', 'The share-platform']],
      ['The shop', ['Current payment status']],
    ],
    "the game's, beside the shop's thread sharing two words",
  );
  assert.deepEqual(
    await named('Where are we at with the shop?'),
    [['The shop', ['The checkout', 'Current payment status']]],
    'whole words: not the share-platform for "are" and "at"',
  );
  assert.deepEqual(
    await named('the levels and the checkout'),
    [
      ['The game', ['The levels']],
      ['The shop', ['The checkout']],
    ],
    'every name said',
  );
  assert.deepEqual(await named('payments status'), [['The shop', ['Current payment status']]], 'else alike words');
  projects.createThread({
    project: 'game',
    name: 'The trailer, and smooth play on a laptop',
    goal: 'It plays',
    slug: 'trailer',
  });
  projects.createThread({ project: 'shop', name: "Wren's status page", goal: 'It shows', slug: 'status-page' });
  assert.deepEqual(
    await named('What are your shop estimates for the trailer?'),
    [
      ['The game', ['The trailer, and smooth play on a laptop']],
      ['The shop', ['The checkout', 'Current payment status', "Wren's status page"]],
    ],
    "a project's name said in passing keeps the thread another word picks out",
  );
  assert.deepEqual(
    await named("What's the trailer's status?"),
    [['The game', ['The trailer, and smooth play on a laptop']]],
    "a rare word over a common one, and not the possessive's 's'",
  );
  assert.deepEqual(
    await named('When are the trailer and the share platform done?'),
    [['The game', ['The share-platform', 'The trailer, and smooth play on a laptop']]],
    'a name said in full takes its words: the rest still find the thread they pick out',
  );
  assert.deepEqual(
    await named('When are the trailer and the payment status done?'),
    [
      ['The game', ['The trailer, and smooth play on a laptop']],
      ['The shop', ['Current payment status']],
    ],
    'a word only one thread has keeps that thread beside one sharing more',
  );
  assert.deepEqual(
    await named('When are the trailer and the share platforms done?'),
    [['The game', ['The share-platform', 'The trailer, and smooth play on a laptop']]],
    'a plural: the trailer too',
  );
  assert.deepEqual(
    await named("When is the trailer done, and Wren's status page? Wren's status page first."),
    [
      ['The game', ['The trailer, and smooth play on a laptop']],
      ['The shop', ["Wren's status page"]],
    ],
    'a name said twice takes its words both times',
  );
  projects.createThread({ project: 'game', name: 'Milestone 2: the caves', goal: 'It plays', slug: 'm2' });
  projects.createThread({ project: 'game', name: 'Milestone 3: the sea', goal: 'It plays', slug: 'm3' });
  assert.deepEqual(await named('milestone 2'), [['The game', ['Milestone 2: the caves']]], 'a digit tells them apart');
  const lead = await h.start({ agent: 'juno' });
  const said = await h.hq(lead, 'projects', 'the', 'game');
  assert.equal(said.code, 0, said.out);
  for (const name of ['The game', 'Wren', 'The levels', 'Pay by card', 'Bolt', 'The checkout', 'Level two'])
    assert.ok(said.out.includes(name), name);
  for (const fact of [/ETA .* UTC/, /30 min/, /planned finish .* UTC/, /deadline .* UTC/, /slack/])
    assert.match(said.out, fact);
  assert.doesNotMatch(said.out, /#\d/, 'no numbers: the board hears names');
  const unmatched = await h.agent('outlooks?q=zebra', onCall);
  assert.equal(unmatched.status, 200);
  assert.deepEqual(unmatched.body.projects, []);
  assert.deepEqual(unmatched.body.known, ['The game', 'The shop']);
  const none = await h.hq(lead, 'projects', 'zebra');
  assert.equal(none.code, 0, none.out);
  for (const name of unmatched.body.known) assert.ok(none.out.includes(name), name);
});

test("on a call, a thread names each card it waits on as the board's: through the work it waits for, and its pause's decision", async () => {
  db.exec('delete from requests; delete from request_waits; delete from pauses; delete from decisions');
  const levels = thread('levels'),
    art = thread('art'),
    checkout = thread('checkout', 'shop');
  const card = (title: string) =>
    Number(
      db
        .prepare("insert into requests (created, kind, title, body) values (?, 'decision', ?, 'x')")
        .run(new Date().toISOString(), title).lastInsertRowid,
    );
  const ahead = queued(checkout, { title: 'Pay by card' });
  db.prepare('insert into request_waits (job, request) values (?, ?)').run(ahead, card('Build the runtime image'));
  queued(levels, { after: ahead, title: 'Level two' });
  queued(art, { title: 'Draw the caves' });
  const style = card('Pick the art style');
  db.prepare("insert into decisions (name, by, at, request) values ('the art style', 'juno', ?, ?)").run(
    new Date().toISOString(),
    style,
  );
  db.prepare(
    "insert into pauses (project, thread, why, by, at, decision) values ('game', ?, 'Waits for the style', 'juno', ?, last_insert_rowid())",
  ).run(art, new Date().toISOString());
  const decisions = await import('./decisions.ts');
  const plan = decisions.create('Approve the game plan', ['game'], 'juno');
  assert(typeof plan === 'object', String(plan));
  const approval = jobs.createRequest({
    kind: 'decision',
    title: 'Approve the game plan',
    body: 'Approve the plan before the game work starts.',
    agent: 'juno',
    decides: plan.id,
  });
  assert(typeof approval === 'object', String(approval));
  forecast.refresh(T);
  const lead = await h.start({ agent: 'juno' });
  const said = await h.hq(lead, 'projects', 'the', 'game');
  assert.equal(said.code, 0, said.out);
  assert.match(
    said.out,
    /- The levels: .*the board: "Build the runtime image" \(its answer expected about .*\), .*"Pay by card" \(Bolt's in The checkout\)/,
  );
  assert.match(said.out, /- The levels: .*the board: "Approve the game plan"/, "the game's pause holds the levels too");
  assert.match(said.out, /- The art: .*the board: "Pick the art style" \(its answer expected about .*\)/);
  assert.match(said.out, /- The art: .*the board: "Approve the game plan"/);
});

test('missing deadlines show once for a deliverable, excluding served windows and loose tasks', async () => {
  const none = thread('undated');
  const serving = thread('serving');
  const timed = thread('timed');
  for (const id of [none, serving, timed]) queued(id);
  windowed(timed, T + 3 * HOUR);
  const plan = await import('./plan.ts');
  assert.deepEqual(plan.need(timed, serving, 'juno'), { ok: true });
  const made = await import('./made.ts');
  const job = jobs.createJob({ agent: 'bolt', title: 'A loose task', prompt: 'x', queuedBy: 'wren' });
  const loose = made.oneTaskThread('game', { id: job.id, title: 'A loose task' })!;
  const board = await h.board('/api/projects');
  const threads = board.body.projects.find((p: any) => p.id === 'game').threads;
  for (const [id, undated] of [
    [none, true],
    [serving, false],
    [timed, false],
    [loose, false],
  ])
    assert.equal(threads.find((t: any) => t.id === id).outlook.undated, undated, String(id));
  const threats = await import('./threats.ts');
  const missing = threats.lines(forecast.refresh()).filter(line => line.includes('no deadline set'));
  assert.equal(missing.length, 1);
  assert.ok(missing[0].includes(none));
  const lead = await h.start({ agent: 'juno' });
  for (const command of [['projects'], ['plan', 'game'], ['thread', none]]) {
    const shown = await h.hq(lead, ...command);
    assert.equal(shown.code, 0, shown.out);
    assert.equal(shown.out.match(/no deadline set/g)?.length, 1, shown.out);
  }
  for (const id of [serving, loose]) {
    const shown = await h.hq(lead, 'thread', id);
    assert.equal(shown.code, 0, shown.out);
    assert.doesNotMatch(shown.out, /no deadline set/);
  }
});

test('a deliverable drawn naming no needs after a read booked days ahead plays now: the read and its chain passed over', () => {
  db.exec('delete from pauses; delete from thread_needs');
  const read = thread('read');
  const at = Math.ceil((T + 5 * 24 * HOUR) / MINUTE) * MINUTE;
  const booking = wakes.readWhen(`${new Date(at).toISOString().slice(0, 16)}Z`, T);
  assert.ok(Array.isArray(booking), String(booking));
  wakes.hold(queued(read), booking, T);
  const draw = (name: string, needs?: string[]) =>
    newThread({ project: 'game', name, goal: 'It wakes', needs }, { agent: 'wren' }) as any;
  try {
    const quiet = draw('Quiet');
    assert.deepEqual(quiet.needs, [], 'the newest under way is the read, all of it booked ahead');
    assert.match(
      quiet.chain,
      /^game\/read waits for a time booked ahead and was passed over: .* game\/quiet game\/read\.$/,
    );
    queued(quiet.id);
    const eta = forecast.refresh(T).threads.get(quiet.id)!.eta!;
    assert.ok(eta < T + 2 * (RUN + REVIEW), `now, not the read's time: ${new Date(eta).toISOString()}`);
    // ready work drawn before the read, then work drawn after it needing it, with a ready task of its own, and work that
    // needs both: the chain neither starts at what waits for the read nor goes on to it
    db.prepare("update threads set created = '2000-01-01' where id = ?").run(quiet.id);
    const after = draw('After', [read]);
    assert.deepEqual(after.needs, [read]);
    queued(after.id);
    assert.deepEqual(draw('Both', [quiet.id, read]).needs, [quiet.id, read]);
    const next = draw('Next');
    assert.deepEqual(next.needs, [quiet.id], 'after the ready work, never the read or what waits for it');
    assert.match(
      next.chain,
      /game\/after waits for game\/read, booked for a time ahead, and was passed over: .* game\/next game\/after\./,
    );
  } finally {
    db.exec('delete from thread_needs');
  }
});
