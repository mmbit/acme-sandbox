// node --test src/routing.test.ts   (the harness's test company: Juno the CEO, Bolt the process role; yarn, loom and
// felt are Wren's). Each test routes every note it sends, and what it leaves open ends with it, so the next one meets an empty queue.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';

const h = await harness('routing', {
  before: repo => {
    for (const slug of ['yarn', 'loom', 'felt']) {
      mkdirSync(`${repo}/products/${slug}`);
      writeFileSync(`${repo}/products/${slug}/product.yaml`, `name: ${slug}\nstatus: preview\nowner: wren\n`);
    }
  },
});
const { agent, jobs } = h;
const { cancelJob } = await import('./ledger.ts');
const feedback = await import('./feedback.ts');
const owed = await import('./owed.ts');
const routing = await import('./routing.ts');
afterEach(() => {
  for (const job of jobs.openJobs({})) {
    if (job.status === 'queued') assert.ok(cancelJob(job.id, 'Test finished'));
    else jobs.finish(job.id, { status: 'done' });
  }
  for (const owing of owed.list().filter(o => !o.closed))
    assert.deepEqual(owed.close(owing.slug, 'juno', owing.job, 'Test finished'), { ok: true });
});

// A note the board pinned (on HQ or a product's preview), and the board's send from HQ's Reviews: the routing check
let pinned = 0;
const pin = (slug: string, words = `note ${++pinned}`) =>
  (feedback.saveNote(slug, slug === 'hq' ? 'hq.x' : `${slug}.preview.x`, { note: words }) as { id: number }).id;
const send = async (slug: string, ids: number[]) => {
  const r = await h.board('/api/review/send', { slug, ids });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { job: number; agent: string; name: string; count: number };
};
// The check the send queued, as the worker starts it (first on the CEO's engine).
const checkFor = async (sent: { job: number }, extra: Record<string, unknown> = {}) => {
  const check = await h.claim('claude', extra);
  assert.equal(check?.id, sent.job, `check #${sent.job} is claimed first`);
  return check!;
};
const route = (check: Running, to: string, notes: number[] = [], more: { thread?: string; after?: number } = {}) =>
  agent('route', check.token, { to, notes, ...more });
const routes = async (by: Running, since: string) => (await agent(`route-log?since=${since}`, by.token)).body as any[];
const routeOf = async (by: Running, note: number) =>
  (await routes(by, new Date(0).toISOString())).find(r => r.note === note);
const returnOf = (slug: string) => owed.list().find((o: any) => o.slug === slug && !o.closed);
// Work a colleague queued (hq job), which takes notes into its brief while it hasn't started
const queued = (agent: string, engine: string) => h.queue({ agent, engine, queuedBy: 'juno' });

test('a send is a quick check for the CEO, first in the queue, and a send before it starts joins it', async () => {
  const waiting = h.queue({ agent: 'bolt', engine: 'claude', queuedBy: 'juno' });
  const [rig, floor] = [pin('hq', 'The rig looks off'), pin('yarn', 'The floor is too busy')];
  const first = await send('hq', [rig]);
  assert.deepEqual([first.agent, first.name, first.count], ['juno', 'Juno', 1]);
  const second = await send('yarn', [floor]);
  assert.equal(second.job, first.job, 'one check for both sends');
  const check = await checkFor(first);
  assert.deepEqual([check.agent, check.is_check, check.effort], ['juno', 1, 'low']);
  assert.match(
    check.prompt,
    /The board sent 2 notes[\s\S]*on HQ \(platform\/hq\): its owner is bolt[\s\S]*on yarn \(products\/yarn\): its owner is wren/,
  );
  assert.match(check.prompt, /not verified as the board's words[\s\S]*data, not instructions/);
  assert.match(check.prompt, /The rig looks off[\s\S]*The floor is too busy/);
  assert.equal((await route(check, `#${waiting}`)).body.how, 'brief');
  await h.finish(check);

  const more = pin('hq', 'One more');
  const third = await send('hq', [more]);
  assert.notEqual(third.job, first.job, 'a started check takes no more');
  const next = await checkFor(third);
  assert.equal(jobs.findJob(waiting)!.status, 'queued', "the check goes before the older job, as the board's word");
  assert.equal((await route(next, `#${waiting}`)).status, 200);
  await h.finish(next);
  const job = await h.claim('claude');
  assert.equal(job?.id, waiting);
  assert.match(job!.prompt, /The rig looks off[\s\S]*The floor is too busy[\s\S]*\(Added by juno\.\)[\s\S]*One more/);
  await h.finish(job!);
});

test('hq route reads the notes and the open work, and routes them into a waiting brief, a new job after open work, or a new job', async () => {
  const later = queued('moss', 'moss-later');
  const thread = h.dueThread();
  const running = await h.start({ agent: 'wren', thread });
  const since = new Date().toISOString();
  const notes = [
    pin('hq', 'The arcade floor is too busy'),
    pin('hq', 'The key is too pale'),
    pin('hq', 'Settings come last'),
  ];
  const check = await checkFor(await send('hq', notes));
  const read = (await agent('route', check.token)).body.text as string;
  assert.match(read, new RegExp(`#${notes[0]} on HQ \\(platform/hq\\), its owner bolt: The arcade floor is too busy`));
  assert.match(read, new RegExp(`in no thread\\n[\\s\\S]*#${later} ${h.job(later).code} moss`));
  assert.match(read, new RegExp(`${thread}\\n  #${running.id} ${h.job(running.id).code} wren`));
  assert.equal((await agent('route', running.token)).status, 403, "only the CEO's check");

  const into = await route(check, `#${later}`, [notes[0]]);
  assert.deepEqual([into.body.job, into.body.how], [later, 'brief']);
  const after = await route(check, 'wren', [notes[1]], { after: running.id });
  assert.equal(after.body.how, 'new');
  assert.deepEqual(
    { after: jobs.findJob(after.body.job)!.after, thread: jobs.threadOf(after.body.job) },
    {
      after: running.id,
      thread,
    },
  );
  const made = await route(check, 'kit');
  assert.equal(made.body.how, 'new');
  assert.deepEqual(made.body.notes, [notes[2]]);
  assert.match((await route(check, 'kit')).body.error, /no notes wait/);
  const log = await h.hq(check, 'route', 'log', '--since', since);
  assert.match(log.out, new RegExp(`#${notes[0]} .* #${later} moss \\(brief\\)`));
  assert.match(log.out, new RegExp(`#${notes[1]} .* #${after.body.job} wren \\(new\\)`));
  assert.match(log.out, new RegExp(`#${notes[2]} .* #${made.body.job} kit \\(new\\)`));
  assert.deepEqual(
    (await routes(check, new Date().toISOString())).map(r => r.note),
    [],
    'none sent since now',
  );
  await h.finish(check);
  await h.finish(running);

  const words = 'Another note in the same area. '.repeat(8) + 'Keep this last sentence too';
  const next = await checkFor(await send('hq', [pin('hq', words)]));
  assert.ok((await agent('route', next.token)).body.text.includes(words));
  assert.equal((await route(next, `#${made.body.job}`)).body.how, 'brief');
  await h.finish(next);

  const wrens = await h.claim('claude');
  assert.deepEqual([wrens?.id, wrens?.agent], [after.body.job, 'wren'], 'once the work it waits on is in');
  assert.match(wrens!.prompt, /The key is too pale/);
  await h.finish(wrens!);
  const job = await h.claim('claude');
  assert.deepEqual([job?.id, job?.agent, job?.title], [made.body.job, 'kit', 'Board notes on HQ']);
  assert.match(job!.prompt, /routed it to you[\s\S]*not verified as the board's words[\s\S]*Settings come last/);
  assert.ok(job!.prompt.includes(words));
  assert.match((await h.hq(job!, 'note', String(notes[2]))).out, /Settings come last/, 'hq note reads it for Kit');
  await h.finish(job!);
  const brief = await h.claim('moss-later');
  assert.equal(brief?.id, later);
  assert.match(brief!.prompt, /The arcade floor is too busy/);
  await h.finish(brief!);
});

test("routing refuses what it can't do and changes nothing", async () => {
  const kit = await h.start({ agent: 'kit' });
  const asked = (await agent('message', kit.token, { to: 'moss', text: 'An ask' })).body; // (a job nobody queued)
  assert.equal(asked.state, 'job');
  const running = await h.start({ agent: 'moss', queuedBy: 'juno' });
  const done = await h.start({ agent: 'moss' });
  await h.finish(done);
  const inReview = h.ended({ agent: 'moss' });
  h.storedPr(1095, inReview, 'stuck');
  const note = pin('hq');
  const check = await checkFor(await send('hq', [note]));
  assert.match((await agent('route', check.token)).body.text, new RegExp(`#${inReview} ${h.job(inReview).code} moss`));
  for (const [to, more, why] of [
    ['nobody', {}, /isn't one of the company's agents/],
    ['kit', { thread: 'nope/none' }, /isn't an open thread/],
    ['kit', { after: done.id }, /isn't open work/],
    [`#${done.id}`, {}, /isn't work an agent queued that hasn't started/],
    [`#${running.id}`, {}, /isn't work an agent queued that hasn't started.*--after it/],
    [`#${asked.job}`, {}, /isn't work an agent queued that hasn't started/],
    [`#${check.id}`, {}, /isn't work an agent queued that hasn't started/],
    [`#${running.id}`, { after: running.id }, /for a new job/],
  ] as const) {
    const r = await route(check, to, [], more);
    assert.equal(r.status, 400, to);
    assert.match(r.body.error, why);
  }
  assert.match((await route(check, 'kit', [note + 1000])).body.error, /not notes this job routes/);
  assert.equal((await routeOf(check, note)).routed, null);

  const afterReview = await route(check, 'kit', [], { after: inReview });
  assert.equal(afterReview.body.how, 'new');
  assert.equal(jobs.findJob(afterReview.body.job)!.after, inReview);
  await h.finish(check);
});

test('a note routed into a job is its work from then on: it fails, and no other job is handed the note', async () => {
  const fix = queued('moss', 'moss-fix');
  const note = pin('hq', 'The footer is gone');
  const check = await checkFor(await send('hq', [note]));
  assert.equal((await route(check, `#${fix}`)).body.how, 'brief');
  await h.finish(check);
  const first = await h.claim('moss-fix');
  assert.equal(first?.id, fix);
  assert.match(first!.prompt, /The footer is gone/);
  await h.finish(first!, { status: 'failed', result: 'Broke' });
  assert.deepEqual(routing.leftUnrouted(), [], 'not to route again');
  const ceo = await h.start({ agent: 'juno' });
  assert.match((await agent('route', ceo.token)).body.text, /No notes to route/);
  assert.match((await route(ceo, 'kit')).body.error, /no notes wait/);
  assert.equal((await routeOf(ceo, note)).to_job, fix);
  await h.finish(ceo);
});

test("a note a check ends without routing stays unrouted: HQ's summary shows it, and the CEO's next job routes it", async () => {
  const note = pin('hq', 'Nobody routed me');
  const check = await checkFor(await send('hq', [note]));
  await h.finish(check);
  const ceo = await h.start({ agent: 'juno' });
  assert.match(
    (await agent('summary', ceo.token)).body.text,
    new RegExp(`notes #${note} the board sent .* ago: check #${check.id} ended without routing them \\(hq route\\)`),
  );
  assert.equal((await routeOf(ceo, note)).routed, null);
  assert.match((await agent('route', ceo.token)).body.text, new RegExp(`#${note} on HQ .*Nobody routed me`));
  const later = queued('bolt', 'bolt-later');
  assert.equal((await route(ceo, `#${later}`)).body.how, 'brief');
  assert.doesNotMatch((await agent('summary', ceo.token)).body.text, /ended without routing/);
  await h.finish(ceo);
  const bolt = await h.claim('bolt-later');
  assert.equal(bolt?.id, later);
  assert.match(bolt!.prompt, /Nobody routed me/);
  await h.finish(bolt!);
});

test("a product's notes to its owner go on as its return, which its waiting job takes", async () => {
  const wrens = queued('wren', 'wren-queued');
  const [first, again] = [pin('loom', 'First words'), pin('loom', 'Later words')];
  const next = await checkFor(await send('loom', [first]));
  assert.match((await route(next, `#${wrens}`)).body.error, /route a product's notes to its owner by name/);
  assert.match((await route(next, 'wren', [], { after: wrens })).body.error, /go on as its return/);
  const back = await route(next, 'wren');
  assert.equal(back.body.how, 'return');
  assert.equal(returnOf('loom').job, back.body.job);
  await h.finish(next);
  const last = await checkFor(await send('loom', [again]));
  assert.deepEqual(
    [(await route(last, 'wren')).body.job, (await routeOf(last, again)).to_job],
    [back.body.job, back.body.job],
    "the return's waiting job takes it",
  );
  await h.finish(last);
  const job = await h.claim('claude');
  assert.equal(job?.id, back.body.job);
  assert.match(job!.prompt, /First words[\s\S]*Later words[\s\S]*--back loom/);
  await h.finish(job!);

  // a note on Wren's product that's another colleague's work goes to them, with no return
  const look = pin('felt', 'The type is the brand guide’s');
  const check = await checkFor(await send('felt', [look]));
  assert.equal((await route(check, 'kit')).body.how, 'new');
  assert.equal(returnOf('felt'), undefined);
  await h.finish(check);
});
