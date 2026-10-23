// node --test src/inflight.test.ts   (job #1102: what's in flight, so work isn't queued twice; throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { OpenJob } from './jobs.ts';
import { harness } from './harness.ts';

const h = await harness('inflight');
const { db, jobs } = h;
const ledger = await import('./ledger.ts');
const photos = await import('./photos.ts');

const SHA = 'b'.repeat(40);
// Each test starts from an empty queue: a starting job lists every open one.
const reset = () => db.exec('delete from jobs; delete from prs; delete from waits; delete from request_waits; delete from wakes');
const queue = (agent: string, title: string, extra: Record<string, unknown> = {}) => h.queue({ agent, title, prompt: title, ...extra });
// Work made as it's made in life, then ended (`end`) as `state` says: queued, cancelled, waiting for the board
// (blocked), failed, or done with its pull request: none, open, stuck (no head commit), or as its review left it
// (merged, closed, with the board: review.test.ts drives the panel there).
async function work(title: string, state: string, pr: string | null = null, o: { agent?: string; queuedBy?: string; after?: number } = {}) {
  const fields = { agent: o.agent ?? 'pylon', title, queuedBy: o.queuedBy, after: o.after };
  if (state === 'queued' || state === 'cancelled') {
    const id = h.queue(fields);
    return { id, end: async () => { if (state === 'cancelled') assert.ok(ledger.cancelJob(id, 'by lark: not needed')); } };
  }
  const job = await h.start(fields);
  return { id: job.id, end: async () => {
    if (state === 'blocked') await h.park(job, { kind: 'decision', title: `${title}?` });
    else if (state !== 'running') await h.finish(job, { status: state, ...pr && { pr: 9000 + job.id, branch: `job/${job.id}`, sha: pr === 'stuck' ? undefined : SHA } });
    if (pr && !['open', 'stuck'].includes(pr)) db.prepare('update prs set status = ? where number = ?').run(pr, 9000 + job.id);
  } };
}
const ended = async (title: string, state: string, pr: string | null = null, o = {}) => {
  const w = await work(title, state, pr, o);
  await w.end();
  return w.id;
};
// hq jobs as `token`'s job reads it
const listed = async (token: string, agent?: string) => (await h.agent(agent ? `jobs?agent=${agent}` : 'jobs', token)).body as OpenJob[] & { line: string }[];
// a job's number and code, as its line names it
const named = (id: number) => `#${id} ${h.job(id).code}`;
const open = async (token: string, id: number) => (await listed(token)).find(j => j.id === id) as OpenJob & { line: string };

test('a starting job lists every other open job (queued, running, waiting), with its state; not reviews, not finished ones', async () => {
  reset();
  const a = queue('pylon', 'Calls: no silent truncation');
  const b = queue('lark', 'Call ledger', { after: a });
  const c = await ended('Brand film', 'blocked', null, { agent: 'moss' });
  const d = await ended('Landing page', 'running', null, { agent: 'kit' });
  await ended('Old work', 'done', null, { agent: 'kit' });
  jobs.createJob({ agent: 'rook', title: 'Review PR #1 (round 1)', prompt: 'x', engine: 'idle', kind: 'review', pr: 1 });
  const text = (await h.start({ agent: 'bolt' })).inFlight!;
  assert.match(text, new RegExp(`- #${a} ${h.job(a).code} pylon, queued: Calls: no silent truncation`));
  assert.match(text, new RegExp(`- #${b} ${h.job(b).code} lark, queued after #${a}: Call ledger`));
  assert.match(text, new RegExp(`- #${c} ${h.job(c).code} moss, waiting for the board: Brand film`));
  assert.match(text, new RegExp(`- #${d} ${h.job(d).code} kit, running: Landing page`));
  assert.doesNotMatch(text, /Old work|Review PR|bolt's job/);   // finished work, reviews, and the job itself
  assert.doesNotMatch(text, /more of others/);
  // nothing else open: it says so
  reset();
  assert.match((await h.start({ agent: 'bolt' })).inFlight!, /starts \(queued, running or waiting for the board\):\n- none\n/);
});

test("past 30, a job sees its own agent's, its department's, the agents it hands work to, its queuer's, and says how many more", async () => {
  reset();
  for (let i = 0; i < 31; i++) queue('dex', `Dex's parcel ${i}`);
  const mine = queue('bolt', 'My other job');
  const dept = queue('pylon', 'Platform colleague');
  const handed = queue('kit', 'Handed to Kit', { queuedBy: 'bolt' });   // bolt queued this one
  await ended('Handed to Moss earlier', 'done', null, { agent: 'moss', queuedBy: 'bolt' });   // bolt hands work to moss...
  const moss = queue('moss', 'Moss, from someone else');                                      // ...so moss's open jobs show
  const queuer = queue('penny', 'Penny at work');
  const text = (await h.start({ agent: 'bolt', title: 'from penny', queuedBy: 'penny' })).inFlight!;
  for (const id of [mine, dept, handed, moss, queuer]) assert.match(text, new RegExp(`- #${id} `), String(id));
  assert.doesNotMatch(text, /Dex's parcel/);
  assert.match(text, /\(31 more of others: `hq jobs` lists them all\)/);
});

test("hq jobs: open work, everyone's or one agent's, without the asking job; hq job records who queued", async () => {
  reset();
  const me = await h.start({ agent: 'bolt' });
  const q = await h.agent('job', me.token, { agent: 'pylon', title: 'Do it' });
  assert.equal(q.status, 200);
  queue('kit', 'Kit work');
  const all = await listed(me.token);
  assert.deepEqual(all.map(j => j.agent), ['pylon', 'kit']);
  assert.match(q.body.code, /^(?:[A-Z]{2,3}-)?[A-Z]{2,8}$/, 'the answer names its code');
  assert.deepEqual(all[0], { id: q.body.id, code: q.body.code, agent: 'pylon', title: 'Do it', step: null, round: null, status: 'queued', after: null, queued_by: 'bolt', downtime: 0, pr: null, waits: [],
    cards: [], wakes: [], line: `#${q.body.id} ${q.body.code} pylon, queued: Do it` });
  assert.deepEqual((await listed(me.token, 'kit')).map(j => j.title), ['Kit work']);
  assert.deepEqual(await listed(me.token, 'nobody'), []);
  assert.equal((await h.agent('jobs', 'not-a-token')).status, 401);
});

test("an open job's line says where it is, what it waits for, downtime and the pull request it updates", () => {
  const open = { code: 'HQ-COVERS', agent: 'pylon', after: null, queued_by: 'lark', waits: [], cards: [], wakes: [] };
  for (const [j, line] of [
    [{ id: 1090, title: 'Brand film', step: 'Fixing review notes', round: 1, status: 'queued', pr: 77 }, '#1090 HQ-COVERS pylon, queued: Fixing review notes: Brand film (round 1) (PR #77)'],
    [{ id: 1091, title: 'Tidy', status: 'queued', downtime: 1 }, '#1091 HQ-COVERS pylon, queued (downtime): Tidy'],
    [{ id: 1426, title: 'Go live', status: 'queued', after: 1424, cards: [29] }, '#1426 HQ-COVERS pylon, queued after #1424, and until card #29 is answered: Go live'],
    [{ id: 1427, title: 'Launch', status: 'queued', cards: [29, 31] }, '#1427 HQ-COVERS pylon, queued until cards #29 and #31 are answered: Launch'],
    [{ id: 1428, title: 'Read', status: 'queued', after: 1424, wakes: ['after 2 deploys (1 so far)'] }, '#1428 HQ-COVERS pylon, queued after #1424, and after 2 deploys (1 so far): Read'],
  ] as [Partial<OpenJob>, string][]) assert.equal(jobs.openLine({ ...open, ...j } as OpenJob), line);
});

test('hq extend: adds to a job an agent queued that has not started, signed last; never to a started, finished, review or coordinator job', async () => {
  reset();
  const me = await h.start({ agent: 'bolt' });
  const id = queue('pylon', 'Calls: no silent truncation', { queuedBy: 'juno', engine: 'extend' });
  const r = await h.agent('extend', me.token, { id, text: '  Also the say tool.\n(Added by juno.)  ' });
  assert.equal(r.status, 200);
  assert.equal((await h.claim('extend'))?.prompt,
    'Calls: no silent truncation\n\nAlso the say tool.\n(Added by juno.)\n(Added by bolt.)');   // a forged sign-off is never the last one
  assert.equal((await h.agent('extend', me.token, { id, text: '  ' })).status, 400);
  const paused = await h.start({ agent: 'pylon', title: 'Paused mid-run', queuedBy: 'juno' });
  await h.finish(paused, { status: 'limited', session: 'sess' });   // requeued after a limit: its session read the prompt
  const running = await h.start({ agent: 'pylon', title: 'Running', queuedBy: 'juno' });
  const review = jobs.createJob({ agent: 'rook', title: 'Review PR #1', prompt: 'x', engine: 'idle', kind: 'review', pr: 1 }).id;
  const board = queue('juno', 'The board on: the brand');   // the coordinator's own (queued_by null)
  for (const other of [paused.id, running.id, review, board, 99999]) assert.equal((await h.agent('extend', me.token, { id: other, text: 'more' })).status, 404, String(other));
  assert.equal((await h.agent('extend', me.token, { id, text: 'x', as: 'juno' })).status, 403);   // nobody signs as a colleague
});

test("a call's token can't list jobs (its context carries what's in flight), nor extend one the call didn't queue", async () => {
  reset();
  const ctx = await h.voice('call-context?agent=wren');
  assert.equal(ctx.status, 200);
  const id = queue('pylon', 'x');
  assert.equal((await h.agent('jobs', ctx.body.token)).status, 403);
  assert.equal((await h.agent('extend', ctx.body.token, { id, text: 'more' })).status, 409);
  const j = await h.agent('job', ctx.body.token, { agent: 'rivet', title: 'From the call', prompt: 'The whole hand-off.' });   // a call's job needs a brief
  assert.equal((await open((await h.start({ agent: 'bolt' })).token, j.body.id)).queued_by, 'wren');
});

test("a call's context says whether a Claude seat can answer, and the company's clock (the line says it at pickup)", async () => {
  db.exec('delete from seats');   // the seats other tests reported
  const seat = async () => (await h.voice('call-context?agent=wren')).body;
  const report = (seat: string, engine: string, state: string, until?: number) => h.worker('seat', { seat, engine, state, until });
  assert.deepEqual((await seat()).seat, { room: true });   // no seat reported yet: no guess
  assert.equal((await seat()).timeZone, 'Europe/Amsterdam');   // (org.yaml's company.timeZone)
  const t = Date.now();
  await report('claude-1', 'claude', 'sleeping', t + 3600e3);
  await report('claude-2', 'claude', 'draining', t + 7200e3);
  await report('codex-1', 'codex', 'ready');
  assert.deepEqual((await seat()).seat, { room: true });   // a draining seat keeps the board's reserve: the line takes it
  await report('claude-2', 'claude', 'sleeping', t + 7200e3);
  assert.deepEqual((await seat()).seat, { room: false, why: 'limit', until: t + 3600e3 });   // the first to wake (Codex never answers a call)
  await report('claude-1', 'claude', 'login');
  assert.deepEqual((await seat()).seat, { room: false, why: 'limit', until: t + 7200e3 });
  await report('claude-2', 'claude', 'login');
  assert.deepEqual((await seat()).seat, { room: false, why: 'signin' });
  await report('claude-2', 'claude', 'sleeping', t - 1000);   // past its wake-up: the worker takes it back at its next pick
  assert.deepEqual((await seat()).seat, { room: true });
  db.exec('delete from seats');
});

test('--after waits while the pull request is open, stuck or with the board; merged or closed releases it (#1046)', async () => {
  for (const [status, runs] of [['open', false], ['stuck', false], ['board', false], ['merged', true], ['closed', true]] as const) {
    reset();
    const dep = await ended('The work', 'done', status);
    const next = queue('lark', 'After it', { after: dep, engine: 'after-test' });
    assert.equal((await h.claim('after-test'))?.id === next, runs, `PR ${status}`);
  }
});

test('further waits (hq waits) hold a job until each is done and its latest pull request merged; hq jobs and HQ say so', async () => {
  reset();
  const lark = (await h.start({ agent: 'lark', title: 'Lining up' })).token;
  // a job lark queued that waits for work in these states
  const run = async (states: [string, string | null][], engine: string) => {
    const deps = await Promise.all(states.map(([state, pr], i) => work(`Wait ${i}`, state, pr)));
    const next = queue('lark', 'After both', { queuedBy: 'lark', engine });
    for (const d of deps) assert.equal((await h.agent('waits', lark, { id: next, to: d.id })).status, 200);
    for (const d of deps) await d.end();
    return { runs: (await h.claim(engine))?.id === next, next, deps: deps.map(d => d.id) };
  };
  for (const [i, [states, runs]] of ([
    [[['done', 'merged'], ['done', 'merged']], true],
    [[['done', 'merged'], ['done', null]], false],   // done with no pull request: nothing shows its work landed
    [[['done', 'merged'], ['queued', null]], false],
    [[['done', 'merged'], ['done', 'open']], false],
    [[['done', 'merged'], ['done', 'closed']], false],
    [[['failed', null], ['done', 'merged']], false],
    [[['cancelled', null], ['done', 'merged']], false],
  ] as [[string, string | null][], boolean][]).entries()) assert.equal((await run(states, `waits-${i}`)).runs, runs, JSON.stringify(states));
  const { next, deps } = await run([['blocked', null], ['done', null]], 'waits-listed');
  const shown = h.job(next);
  assert.equal(shown.ready, 0);
  assert.deepEqual(shown.waits, [{ id: deps[0], code: h.job(deps[0]).code, agent: 'pylon', title: 'Wait 0', state: 'board' },
    { id: deps[1], code: h.job(deps[1]).code, agent: 'pylon', title: 'Wait 1', state: 'unmerged' }]);
  assert.equal((await open(lark, next)).line, `${named(next)} lark, queued until #${deps[0]} and #${deps[1]} are done and merged: After both`);
  const after = queue('lark', 'After one', { queuedBy: 'lark', after: deps[0] });
  await h.agent('waits', lark, { id: after, to: (await work('Wait 2', 'running')).id });
  assert.match((await open(lark, after)).line, new RegExp(`^${named(after)} lark, queued after #${deps[0]}, and until #\\d+ is done and merged: After one$`));
});

test('a wait on work that ends without merging holds until whoever queued the waiting job moves or drops it, and they get a job to', async () => {
  reset();
  const lark = (await h.start({ agent: 'lark', title: 'Lining up' })).token, quill = (await h.start({ agent: 'quill' })).token;
  const prior = queue('pylon', 'The site', { queuedBy: 'lark' });
  queue('kit', 'After the site', { queuedBy: 'lark', after: prior });
  // (a review loop's job, named by its step and round in the brief.)
  const next = queue('kit', 'The build', { engine: 'waits-test', queuedBy: 'lark', after: prior, step: 'Fixing review notes', round: 2 });
  assert.equal((await h.agent('waits', lark, { id: next, to: prior })).status, 200);
  assert.equal((await h.agent('cancel', lark, { id: prior, why: 'done another way' })).status, 200);
  const told = (jobs.listJobs() as any[]).filter(j => j.title.startsWith(`Job #${prior} ended without merged work`));
  assert.deepEqual(told.map(j => j.agent), ['lark'], 'whoever queued the waiting job, once');
  const brief = (db.prepare('select prompt from jobs where id = ?').get(told[0].id) as { prompt: string }).prompt;   // the brief lark's run gets
  assert.ok(brief.includes(`Job #${prior} (pylon: The site) was cancelled, so it will never merge work.`));
  assert.ok(brief.includes(`- #${next} (kit: Fixing review notes: The build (round 2)): \`hq waits ${next} move ${prior} <job>\` or \`hq waits ${next} drop ${prior}\``));

  const replacement = await ended('The site, again', 'done', 'merged');
  const claims = async () => (await h.claim('waits-test'))?.id === next;
  assert.equal(await claims(), false, 'the replacement merging alone releases nothing');
  const loop = queue('pylon', 'After the build', { after: next });
  for (const [token, body, why] of [
    [quill, { id: next, from: prior, to: replacement }, /isn't a queued job of yours, or one you queued, that waits for #/],
    [lark, { id: next, from: replacement, to: prior }, /isn't a queued job of yours, or one you queued, that waits for #/],
    [lark, { id: next, from: prior, to: prior }, /isn't work that can replace/],
    [lark, { id: next, from: prior, to: await ended('Failed', 'failed') }, /ended without work that merged or still can/],
    [lark, { id: next, from: prior, to: await ended('No pull request', 'done') }, /ended without work that merged or still can/],
    [lark, { id: next, from: prior, to: await ended('Closed', 'done', 'closed') }, /ended without work that merged or still can/],
  ] as [string, unknown, RegExp][]) {
    const r = await h.agent('waits', token, body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.match(r.body.error, why);
  }
  const waitsOf = async () => (await open(lark, next)).waits;
  assert.deepEqual(await waitsOf(), [prior], 'a refused move keeps the wait');
  for (const to of [loop, next]) {
    assert.equal((await h.agent('waits', lark, { id: next, from: prior, to })).status, 409);
    assert.deepEqual(await waitsOf(), [prior], 'a refused cycle keeps the original wait');
  }
  for (const body of [{ id: next, from: 'x', to: replacement }, { id: next, from: 'x' }, { id: next, from: prior, to: 1.5 }, { id: 'x', from: prior }]) {
    assert.equal((await h.agent('waits', lark, body)).status, 400, `not a job number: ${JSON.stringify(body)}`);
  }
  assert.deepEqual(await waitsOf(), [prior]);
  assert.equal(await claims(), false);
  const inReview = await ended('In review', 'done', 'open');
  assert.equal((await h.agent('waits', lark, { id: next, from: prior, to: inReview })).status, 200, 'its pull request may still merge');
  assert.equal(await claims(), false);
  assert.equal((await h.agent('waits', lark, { id: next, from: inReview, to: replacement })).status, 200);
  assert.deepEqual(await waitsOf(), [], 'moved to merged work: met');
  assert.equal(await claims(), true, 'it starts');
});

test('a wait on work that failed or ended with no pull request: its job hears so, and a dropped wait releases it', async () => {
  reset();
  const ended = async (status: 'done' | 'failed', queuedBy?: string) => {
    const prior = await h.start({ agent: 'pylon', title: `The site (${status})`, queuedBy: 'lark' });
    const next = queue('kit', 'The build', { engine: `drop-${status}-${queuedBy}`, queuedBy });
    // (hq waits adds none to a job HQ made or to one queued by someone since gone: here, one HQ carried over)
    db.prepare('insert into waits (job, on_job) values (?, ?)').run(next, prior.id);
    await h.finish(prior, { status, result: 'x' });
    return { prior: prior.id, next, told: (jobs.listJobs() as any[]).filter(j => j.title.startsWith(`Job #${prior.id} ended without merged work`)).map(j => j.agent) };
  };
  const failed = await ended('failed', 'lark');
  assert.deepEqual(failed.told, ['lark']);
  assert.deepEqual((await ended('done')).told, ['kit'], 'one HQ made: its own agent');
  assert.deepEqual((await ended('done', 'gone-agent')).told, ['kit'], 'queued by someone no longer here: its own agent');
  const kit = (await h.start({ agent: 'kit' })).token;
  assert.equal((await h.agent('waits', kit, { id: failed.next, from: failed.prior, to: null })).status, 200, "the waiting job's own agent");
  assert.equal((await h.claim('drop-failed-lark'))?.id, failed.next);
});

test('hq waits add: a queued job of yours waits for several jobs, each of which must still be able to merge, without a loop', async () => {
  reset();
  const first = await work('The draft', 'done', 'merged', { agent: 'moss' }), second = await work('The edit', 'done', 'merged', { agent: 'kit' });
  const verdict = queue('wren', 'The release', { engine: 'add-test', queuedBy: 'lark', after: first.id });
  const after = queue('pylon', 'After the release', { after: verdict });
  const made = queue('wren', 'A fix HQ made');
  const [lark, quill, wren] = await Promise.all(['lark', 'quill', 'wren'].map(async agent => (await h.start({ agent })).token));
  for (const [token, body, why] of [
    [quill, { id: verdict, to: second.id }, /isn't a queued job of yours, or one you queued$/],
    [wren, { id: made, to: second.id }, /was made by HQ/],
    [lark, { id: verdict, to: await ended('Failed', 'failed') }, /ended without work that merged or still can/],
    [lark, { id: verdict, to: await ended('Closed', 'done', 'closed') }, /ended without work that merged or still can/],
  ] as [string, unknown, RegExp][]) {
    const r = await h.agent('waits', token, body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.match(r.body.error, why);
  }
  for (const to of [after, verdict]) {
    assert.equal((await h.agent('waits', lark, { id: verdict, to })).status, 409);
    assert.deepEqual((await open(lark, verdict)).waits, [], 'a refused cycle adds no wait');
  }
  const neither = await h.agent('waits', lark, { id: verdict });
  assert.equal(neither.status, 400);
  assert.match(neither.body.error, /to wait for \(add\).*\(move\).*\(drop\)/);
  assert.deepEqual((await open(lark, verdict)).waits, []);
  assert.deepEqual((await open(lark, made)).waits, [], 'a job HQ made takes no added wait');
  const third = await work('In review', 'done', 'merged');
  for (const [token, to] of [[lark, second.id], [wren, third.id], [lark, second.id]] as [string, number][]) {
    assert.equal((await h.agent('waits', token, { id: verdict, to })).status, 200, 'its queuer or its own agent');
  }
  assert.deepEqual((await open(lark, verdict)).waits, [second.id, third.id], 'twice is once');
  assert.equal((await open(lark, verdict)).line,
    `${named(verdict)} wren, queued after #${first.id}, and until #${second.id} and #${third.id} are done and merged: The release`);

  const claims = async () => (await h.claim('add-test'))?.id === verdict;
  await first.end();
  await second.end();
  assert.equal(await claims(), false, 'one wait still in review');
  await third.end();
  assert.equal(await claims(), true, 'every wait merged: it starts');
});

test("the CEO and Process change any queued job's waits and card waits. Its agent and queuer see who did", async () => {
  reset();
  const first = queue('moss', 'The draft'), second = queue('pylon', 'The edit'), third = queue('pylon', 'The copy');
  const next = queue('kit', 'The build', { queuedBy: 'lark', after: first });
  // (a wait set before anyone changes it: hq waits would log its own line)
  db.prepare('insert into waits (job, on_job) values (?, ?)').run(next, second);
  const made = queue('kit', 'A fix HQ made');
  // (reset() reuses job ids: only this test's log lines)
  const since = (db.prepare('select max(id) n from events').get() as { n: number | null }).n ?? 0;
  const juno = (await h.start({ agent: 'juno' })).token;
  const [bolt, quill] = await Promise.all(['bolt', 'quill'].map(async agent => (await h.start({ agent })).token));
  const card = (await h.agent('request', juno, { kind: 'decision', title: 'Which name?', body: 'x' })).body.id as number;
  for (const [token, body, why] of [
    [quill, { id: next, from: second, to: null }, /isn't a queued job of yours, or one you queued, that waits for #/],
    [quill, { id: next, to: third }, /isn't a queued job of yours, or one you queued$/],
    [quill, { id: next, request: card }, /isn't a queued job of yours, or one you queued$/],
    // --after isn't a wait hq waits changes
    [bolt, { id: next, from: first, to: null }, /that waits for #/],
    [juno, { id: made, to: third }, /was made by HQ/],
    [bolt, { id: next, request: card }, /isn't an open card you filed/],
  ] as [string, unknown, RegExp][]) {
    const r = await h.agent('waits', token, body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.match(r.body.error, why);
  }
  assert.deepEqual((await open(bolt, next)).waits, [second], 'a stranger changes nothing');
  assert.equal((await h.agent('waits', juno, { id: next, from: second, to: third })).status, 200, 'the CEO moves it');
  assert.equal((await h.agent('waits', bolt, { id: next, from: third, to: null })).status, 200, 'Process drops it');
  assert.equal((await h.agent('waits', bolt, { id: next, to: second })).status, 200, 'and adds one');
  assert.deepEqual((await open(bolt, next)).waits, [second]);
  assert.equal((await h.agent('waits', juno, { id: next, request: card })).status, 200, "the CEO's own card");
  assert.equal((await h.agent('waits', bolt, { id: next, request: card, drop: true })).status, 200);
  const build = await open(bolt, next);
  assert.deepEqual(build.cards, []);
  assert.equal(build.after, first, '--after stays');
  const logOf = (who: string) => (db.prepare("select text from events where type = 'log' and agent = ? and text like ? and id > ? order by id")
    .all(who, `#${next} %`, since) as { text: string }[]).map(e => e.text);
  const lines = [`#${next} waits for #${third} now, in place of #${second} (changed by juno)`, `#${next} no longer waits for #${third} (changed by bolt)`,
    `#${next} waits for #${second} too now (changed by bolt)`, `#${next} waits for card #${card} too now (changed by juno)`,
    `#${next} no longer waits for card #${card} (changed by bolt)`];
  assert.deepEqual(logOf('kit'), lines, "the job's agent");
  assert.deepEqual(logOf('lark'), lines, 'its queuer');
  assert.deepEqual(logOf('juno'), [lines[0], lines[3]], 'and whoever changed it');
  const lark = (await h.start({ agent: 'lark' })).token;
  assert.equal((await h.agent('waits', lark, { id: next, from: second, to: null })).status, 200);
  assert.deepEqual(logOf('lark').slice(5), [`#${next} no longer waits for #${second}`], "its queuer's own change: a plain line without who made it");
  assert.deepEqual(logOf('kit').slice(5), []);
});

// lark's running job, and decision cards it files (hq ask)
async function asker() {
  const job = await h.start({ agent: 'lark', title: 'Asking' });
  const card = async (title: string, extra = {}) => (await h.agent('request', job.token, { kind: 'decision', title, body: 'x', ...extra })).body.id as number;
  return { job, card };
}
const newJobsFor = (title: string) => (jobs.listJobs() as any[]).filter(j => j.title.startsWith('The board on:') && j.title.endsWith(title));
// a job kit is queued (hq job --after request:<id>), and its run as the worker claims it
const afterCard = async (token: string, request: number, title: string) => {
  const r = await h.agent('job', token, { agent: 'kit', title, prompt: `${title}.`, afterRequest: request });
  assert.equal(r.status, 200);
  return { id: r.body.id as number, claim: () => h.claim(h.job(r.body.id).engine) };
};

test('a job --after request:<id> starts once the board answers the card, the answer at the end of its brief. It hears it for an asker that ended', async () => {
  reset();
  const { job: lark, card } = await asker();
  const domain = await card('Buy example.test'), approval = await card('Approve the site');
  const live = await afterCard(lark.token, domain, 'Go live'), announce = await afterCard(lark.token, approval, 'Announce it');
  assert.equal(await live.claim(), null, 'both cards are on the desk phone');
  assert.equal((await open(lark.token, live.id)).line, `${named(live.id)} kit, queued until card #${domain} is answered: Go live`);
  // (holds)
  assert.deepEqual(h.job(live.id).cards, [{ id: domain, title: 'Buy example.test', shown: true, holds: [] }]);

  await h.answer(approval, 'Approved.');   // the asker still runs: it reads the answer itself, and so does the waiting job
  assert.ok((await announce.claim())!.prompt.endsWith(`Announce it.\n\n(Assigned by lark.)\n\nThe board answered card #${approval} ("Approve the site"), which this job waited for, on its desk phone: Approved.`));

  await h.finish(lark, { status: 'done', result: 'Built the site.' });   // its work went on to review without the answer
  await h.answer(domain, 'Bought it.');
  assert.deepEqual(newJobsFor('Buy example.test'), [], 'the waiting job hears it: no new job for the asker');
  const [stranger, queuer] = [await h.start({ agent: 'moss' }), await h.start({ agent: 'lark' })];   // (the asker has ended)
  const cancel = (token: string, id: number) => h.agent('cancel', token, { id, why: 'not needed' });
  assert.equal((await cancel(stranger.token, live.id)).status, 404, "another agent's job isn't theirs to cancel, card or not");
  const refused = await cancel(queuer.token, live.id);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, new RegExp(`carries the board's answer to card #${domain}`));
  assert.ok((await live.claim())!.prompt.endsWith(', which this job waited for, on its desk phone: Bought it.'), 'the only job with the answer stays');
  const unheard = (jobs.createRequest({ kind: 'decision', title: 'Nobody waits', body: 'x', agent: 'lark', job: lark.id }) as { id: number }).id;
  await h.answer(unheard, 'Fine.');
  const [made] = newJobsFor('Nobody waits');
  assert.ok(made, 'with nobody waiting, an ended asker still gets a job that hears it');
  assert.equal((await cancel(queuer.token, made.id)).status, 404, "HQ's own job for the answer isn't cancelled with hq cancel, nor refused as a card's");
});

test('a card wait: a queued job of yours that never started, on an open card the caller filed. A card closed unanswered lets it start, saying so', async () => {
  reset();
  const { job, card } = await asker(), lark = job.token;
  const open = await card('Which name?'), answered = await card('Old question'), dropped = await card('Not needed');
  await h.answer(answered, 'Done.');
  const review = (jobs.createRequest({ kind: 'review', title: 'PR #3', body: 'x', pr: 3 }) as { id: number }).id;
  const customer = (jobs.createRequest({ kind: 'decision', title: 'A refund', body: 'x', agent: 'lark', customers: true }) as { id: number }).id;
  const foreign = (jobs.createRequest({ kind: 'decision', title: 'Private', body: 'x', agent: 'bolt' }) as { id: number }).id;
  const next = queue('kit', 'Publish', { queuedBy: 'lark', engine: 'card-wait' });
  const paused = await h.start({ agent: 'kit', title: 'Paused mid-run', queuedBy: 'lark' });
  await h.finish(paused, { status: 'limited', session: 'sess' });
  const made = queue('lark', 'The board on: something');   // HQ's own (queued_by null)
  for (const [body, why] of [
    [{ id: next, request: answered }, /card #\d+ isn't an open card you filed/],
    [{ id: next, request: review }, /isn't an open card you filed/],
    [{ id: next, request: customer }, /isn't an open card you filed/],
    [{ id: next, request: foreign }, /isn't an open card you filed/],
    [{ id: next, request: 99999 }, /isn't an open card you filed/],
    [{ id: paused.id, request: open }, /has started already/],
    [{ id: made, request: open }, /was made by HQ/],
    [{ id: next, request: open, drop: true }, /doesn't wait for card/],
  ] as [unknown, RegExp][]) {
    const r = await h.agent('waits', lark, body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.match(r.body.error, why);
  }
  assert.equal((await h.agent('waits', lark, { id: next, request: 'x' })).status, 400);
  for (const request of [answered, foreign]) assert.equal((await h.agent('job', lark, { agent: 'kit', title: 'Refused card wait', afterRequest: request })).status, 409);
  assert.ok(!(jobs.listJobs() as any[]).some(j => j.title === 'Refused card wait'), 'nothing queued');

  for (const request of [open, open, dropped]) assert.equal((await h.agent('waits', lark, { id: next, request })).status, 200);
  assert.deepEqual((await listed(lark, 'kit')).find(j => j.id === next)!.cards, [open, dropped], 'twice is once');
  assert.equal((await h.agent('waits', lark, { id: next, request: dropped, drop: true })).status, 200);
  assert.equal(await h.claim('card-wait'), null);
  assert.equal((await h.agent('request-close', lark, { id: open })).status, 200);
  assert.ok((await h.claim('card-wait'))!.prompt.endsWith(`Card #${open} ("Which name?"), which this job waited for, left the board's desk phone without an answer: lark closed it. `
    + "Check whether what it asked for came about another way. If this job still needs the board's answer, ask for it with hq request, which parks the job until it comes."));
});

test("a job queued after a photo card fetches its photos once it's answered, and the asker has ended. A job that doesn't wait for it can't", async () => {
  reset();
  const { job, card: ask } = await asker();
  const card = await ask('The shelf', { photos: ['Front'] });
  const queued = await afterCard(job.token, card, 'Hang it');
  await h.finish(job);
  // the board's photo, as its answer uploads it
  mkdirSync(`${photos.DIR}/${card}`, { recursive: true }); writeFileSync(`${photos.DIR}/${card}/0.jpg`, 'jpeg');
  assert.equal((await h.answer(card, 'Here.')).status, 200);
  const kit = await queued.claim();
  assert.equal(kit?.id, queued.id);
  const other = await h.start({ agent: 'moss' });
  const fetchAs = (token: string) => Promise.all([h.agent(`photos?id=${card}`, token), h.agent(`photo?id=${card}&field=0`, token)]);
  assert.deepEqual((await fetchAs(kit!.token)).map(r => r.status), [200, 200]);
  assert.deepEqual((await fetchAs(other.token)).map(r => r.status), [404, 404]);
});

test("a seat's windows are kept as the worker reports them, for HQ's bars: shares held to 0-1, none when not measured, a reading without a reset keeps the last one", async () => {
  const t = Date.now();
  assert.equal((await h.worker('seat', { seat: 'claude-9', engine: 'claude', state: 'ready', note: '', util: 0.43, resets: t + 3600e3, week: 1.2, weekResets: t + 86400e3 })).status, 200);
  assert.equal((await h.worker('seat', { seat: 'codex-9', engine: 'codex', state: 'ready', note: '5-hour window not measured yet' })).status, 200);
  const seats = jobs.listSeats() as Record<string, unknown>[], one = (id: string) => seats.find(s => s.id === id)!;
  assert.deepEqual([one('claude-9').util, one('claude-9').resets, one('claude-9').week, one('claude-9').week_resets], [0.43, t + 3600e3, 1, t + 86400e3]);
  assert.deepEqual([one('codex-9').util, one('codex-9').week, one('codex-9').note], [null, null, '5-hour window not measured yet']);
  // a later reading without the resets keeps the last ones known; one with them replaces them
  await h.worker('seat', { seat: 'claude-9', engine: 'claude', state: 'ready', note: '', util: 0.5, week: 0.9 });
  const kept = (jobs.listSeats() as Record<string, unknown>[]).find(s => s.id === 'claude-9')!;
  assert.deepEqual([kept.util, kept.resets, kept.week, kept.week_resets], [0.5, t + 3600e3, 0.9, t + 86400e3]);
  await h.worker('seat', { seat: 'claude-9', engine: 'claude', state: 'ready', note: '', util: 0.1, resets: t + 7200e3, week: 0.9, weekResets: t + 2 * 86400e3 });
  const next = (jobs.listSeats() as Record<string, unknown>[]).find(s => s.id === 'claude-9')!;
  assert.deepEqual([next.resets, next.week_resets], [t + 7200e3, t + 2 * 86400e3]);
});
