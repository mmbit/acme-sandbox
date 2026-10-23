// node --test src/agent-state.test.ts   (an agent's state on its card: idle only once none of its jobs is running)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('agent-state');
const { status } = await import('./events.ts');
const { db } = await import('./db.ts');

test('an agent with another job still running stays at work on it as one ends, pauses or parks', async () => {
  const intercom = await h.start({ agent: 'moss', title: 'Intercom chat with the board' });
  const zine = await h.start({ agent: 'moss', title: 'The zine’s proof' });
  assert.deepEqual([status.get('moss')?.state, status.get('moss')?.task], ['working', 'The zine’s proof']);
  await h.finish(zine);
  assert.deepEqual([status.get('moss')?.state, status.get('moss')?.task], ['working', 'Intercom chat with the board']);
  const again = await h.start({ agent: 'moss', title: 'The zine, again' });
  await h.finish(again, { status: 'limited', resetAt: Date.now() + 3_600_000 });
  assert.equal(status.get('moss')?.state, 'working');
  const asks = await h.start({ agent: 'moss', title: 'A card' });
  await h.park(asks, {});
  assert.deepEqual([status.get('moss')?.state, status.get('moss')?.task], ['working', 'Intercom chat with the board']);
  // none left running: idle
  await h.finish(intercom);
  assert.equal(status.get('moss')?.state, 'idle');
});

test("a review loop's job is at work under its whole name: its step, the work's title and its round", async () => {
  const review = await h.start({ agent: 'kit', title: 'Gift wrap at checkout', step: 'Reviewing', round: 2 });
  assert.equal(status.get('kit')?.task, 'Reviewing: Gift wrap at checkout (round 2)');
  const other = await h.start({ agent: 'kit', title: 'The zine' });
  await h.finish(other);
  assert.equal(status.get('kit')?.task, 'Reviewing: Gift wrap at checkout (round 2)', 'and again once the other ends');
  status.clear();
  // @ts-expect-error the query makes a fresh copy of the module (a restart), a path TypeScript can't resolve
  await import('./jobs.ts?named');
  assert.equal(status.get('kit')?.task, 'Reviewing: Gift wrap at checkout (round 2)', 'and after a restart');
  await h.finish(review);
});

test('a restart forgets every state, but an agent with a job running is at work on it from the start', async () => {
  const forty = await h.start({ agent: 'wren', title: 'The forty' });
  status.clear();
  // @ts-expect-error the query makes a fresh copy of the module (a restart), a path TypeScript can't resolve
  await import('./jobs.ts?restart');
  assert.deepEqual([status.get('wren')?.state, status.get('wren')?.task], ['working', 'The forty']);
  assert.equal(status.get('moss'), undefined, 'idle agents stay as they were: no state');
  await h.finish(forty);
});

test('a run cut off without a word rests its agent as the stale sweep puts it back, unless another of theirs runs', async () => {
  const intercom = await h.start({ agent: 'moss', title: 'Intercom chat with the board' });
  const zine = await h.start({ agent: 'moss', title: 'The zine’s proof' });
  const lost = async (job: { id: number }) => {
    db.prepare('update jobs set heartbeat = 0 where id = ?').run(job.id);
    assert.equal(await h.claim(), null); // nothing for this engine: only the claim's sweep
    assert.equal(h.job(job.id).status, 'queued');
  };
  await lost(zine);
  assert.deepEqual([status.get('moss')?.state, status.get('moss')?.task], ['working', 'Intercom chat with the board']);
  await lost(intercom);
  assert.deepEqual([status.get('moss')?.state, status.get('moss')?.task], ['sleeping', 'Paused']);
});

test("an agent's running jobs, newest first, each with its project and thread, its own words and its own lines", async () => {
  const meeting = h.dueThread(),
    wall = h.dueThread();
  const seats = await h.start({ agent: 'fern', title: 'Seats for ten', thread: meeting });
  const board = await h.start({ agent: 'fern', title: 'The wall board', step: 'Reviewing', round: 5, thread: wall });
  const running = () => status.get('fern')?.jobs?.map(j => [j.task, j.project, j.thread, j.lines?.add]);
  assert.deepEqual(running(), [
    ['Reviewing: The wall board (round 5)', 'Due', 'Thread 2', undefined],
    ['Seats for ten', 'Due', 'Thread 1', undefined],
  ]);
  await h.agent('event', seats.token, { type: 'status', state: 'working', text: 'Fitting the tenth chair' });
  await h.agent('event', board.token, { type: 'lines', add: 12, del: 3 });
  assert.deepEqual(running(), [
    ['Reviewing: The wall board (round 5)', 'Due', 'Thread 2', 12],
    ['Fitting the tenth chair', 'Due', 'Thread 1', undefined],
  ]);
  const chat = await h.start({ agent: 'fern', title: 'Intercom chat with the board' });
  assert.deepEqual(
    running(),
    [
      ['Intercom chat with the board', undefined, undefined, undefined],
      ['Reviewing: The wall board (round 5)', 'Due', 'Thread 2', 12],
      ['Fitting the tenth chair', 'Due', 'Thread 1', undefined],
    ],
    'what it said and changed stays as another starts',
  );
  await h.finish(board);
  await h.finish(chat);
  assert.deepEqual(running(), [['Fitting the tenth chair', 'Due', 'Thread 1', undefined]]);
  await h.finish(seats);
  assert.equal(status.get('fern')?.jobs, undefined);
});

test("with one job left, the org and the feed give its own words and lines, never the ended one's", async () => {
  const seats = await h.start({ agent: 'dex', title: 'Seats for ten' });
  const board = await h.start({ agent: 'dex', title: 'The wall board' });
  await h.agent('event', seats.token, { type: 'status', state: 'working', text: 'Fitting the tenth chair' });
  await h.agent('event', board.token, { type: 'lines', add: 12, del: 3 });
  await h.finish(board);
  const { body } = await h.board('/api/org');
  const dex = body.departments
    .flatMap((d: { agents: any[] }) => d.agents)
    .find((a: { id: string }) => a.id === 'dex').status;
  assert.deepEqual(
    [dex.task, dex.lines, dex.jobs.map((j: { task: string }) => j.task)],
    ['Fitting the tenth chair', undefined, ['Fitting the tenth chair']],
  );
  // the feed as a page opens it: the stored rows as history, then who's at work now, whole, as the org gives it
  const feed = await h.stream();
  const settled = feed.findLast(e => e.type === 'status' && e.agent === 'dex');
  assert.deepEqual([settled?.text, settled?.history], ['Fitting the tenth chair', true]);
  assert.ok(feed.filter(e => e.type !== 'statuses').every(e => e.history));
  assert.deepEqual(feed.at(-1)?.statuses?.dex, dex);
  await h.finish(seats);
});

test("HQ's running jobs redact credentials in their task text", async () => {
  const kitStatus = async () => {
    const { body } = await h.board('/api/org');
    return body.departments.find((d: { id: string }) => d.id === 'growth').agents[0].status;
  };
  const title = 'Synthetic ' + 'sk-' + 'reviewOnlyValue123';
  const job = await h.start({ agent: 'kit', title });
  const shown = await kitStatus();
  assert.equal(shown.task, 'Synthetic [redacted]');
  assert.equal(shown.jobs[0].task, 'Synthetic [redacted]');
  const value = 'synthetic-known-value-for-running-jobs';
  await h.agent('event', job.token, { type: 'status', state: 'working', text: value });
  const { saveSecrets } = await import('./secrets.ts');
  assert.deepEqual(saveSecrets(['CARE_EMAIL_API_KEY'], { CARE_EMAIL_API_KEY: value }), {
    saved: ['CARE_EMAIL_API_KEY'],
    refused: {},
  });
  const other = await h.start({ agent: 'kit', title: 'Another task' });
  const current = await kitStatus();
  assert.ok(!current.jobs.find((j: { id: number }) => j.id === job.id).task.includes(value));
  const next = 'synthetic-known-value-from-the-desk-phone';
  await h.agent('event', job.token, { type: 'status', state: 'working', text: next });
  const requester = await h.start({ agent: 'moss', title: 'Set service key' });
  const card = await h.ask(requester, {
    kind: 'credential',
    title: 'Email key',
    body: 'A service key',
    secrets: 'CARE_EMAIL_API_KEY',
  });
  assert.equal((await h.answer(card, '', { secrets: { CARE_EMAIL_API_KEY: next } })).status, 200);
  const saved = await kitStatus();
  assert.ok(!saved.task.includes(next));
  assert.ok(!saved.jobs.find((j: { id: number }) => j.id === job.id).task.includes(next));
  await h.finish(requester);
  await h.finish(other);
  await h.finish(job);
});

test("an agent's clock counts from its job's start, through the job's later runs and its own words", async () => {
  const first = await h.start({ agent: 'sorrel', title: 'Five review panels', engine: 'engine-sorrel' });
  const started = '2026-10-22T13:27:00.000Z';
  db.prepare('update jobs set started = ? where id = ?').run(started, first.id); // (its first run, an hour ago)
  await h.agent('event', first.token, { type: 'status', state: 'working', text: 'Reading the rounds' });
  assert.equal(status.get('sorrel')?.since, started);
  await h.finish(first, { status: 'interrupted' }); // (handed back: it sleeps, and is claimed again)
  const again = await h.claim('engine-sorrel');
  assert.equal(again?.id, first.id);
  assert.deepEqual([status.get('sorrel')?.task, status.get('sorrel')?.since], ['Five review panels', started]);
  await h.finish(again!);
});
