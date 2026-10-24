// node --test src/routing.test.ts   (the harness's test company: Juno the CEO, Bolt the process role; yarn, loom and
// felt are Wren's). Each test routes every note it sends, and what it leaves open ends with it, so the next one meets an empty queue.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';

// (loom and felt each in a project of their own)
const PROJECT: Record<string, string> = { loom: 'loom-work', felt: 'felt-work' };
const h = await harness('routing', {
  before: repo => {
    for (const slug of ['yarn', 'loom', 'felt']) {
      mkdirSync(`${repo}/products/${slug}`);
      const project = PROJECT[slug] ? `project: ${PROJECT[slug]}\n` : '';
      writeFileSync(`${repo}/products/${slug}/product.yaml`, `name: ${slug}\nstatus: preview\nowner: wren\n${project}`);
    }
  },
});
const { agent, jobs, db } = h;
const { cancelJob } = await import('./ledger.ts');
const feedback = await import('./feedback.ts');
const owed = await import('./owed.ts');
const routing = await import('./routing.ts');
const plan = await import('./plan.ts');
const projects = await import('./projects.ts');
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
const route = (check: Running, to: string, notes: number[] = []) => agent('route', check.token, { to, notes });
// hq job --notes: a task of the notes, as the CEO makes it in a check; it says its time, none here unless a test gives
// one (askwindow.ts).
const task = (by: Running, to: string, notes: number[], more: Record<string, unknown> = {}) =>
  agent('job', by.token, { agent: to, title: `Notes ${notes.join(' ')}`, prompt: '', notes, by: 'none', ...more });
const routes = async (by: Running, since: string) => (await agent(`route-log?since=${since}`, by.token)).body as any[];
const routeOf = async (by: Running, note: number) =>
  (await routes(by, new Date(0).toISOString())).find(r => r.note === note);
const promptOf = (id: number) =>
  (db.prepare('select prompt from jobs where id = ?').get(id) as { prompt: string }).prompt;
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

test('hq route reads the notes and the open work; the notes go into a waiting brief, or become tasks in their threads', async () => {
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
  assert.match(check.prompt, /One task per improvement[\s\S]*hq job <agent> "title" --code WORD --thread/);
  const read = (await agent('route', check.token)).body.text as string;
  assert.match(read, new RegExp(`#${notes[0]} on HQ \\(platform/hq\\), its owner bolt: The arcade floor is too busy`));
  assert.match(read, new RegExp(`in no thread\\n[\\s\\S]*#${later} ${h.job(later).code} moss`));
  assert.match(read, new RegExp(`${thread}\\n  #${running.id} ${h.job(running.id).code} wren`));
  assert.equal((await agent('route', running.token)).status, 403, "only the CEO's check");

  const into = await route(check, `#${later}`, [notes[0]]);
  assert.deepEqual([into.body.job, into.body.how], [later, 'brief']);
  const key = await task(check, 'wren', [notes[1]], { title: 'A darker key', code: 'KEY', thread });
  assert.equal(key.status, 200, JSON.stringify(key.body));
  assert.deepEqual(
    [h.job(key.body.id).title, h.job(key.body.id).code, jobs.threadOf(key.body.id)],
    ['A darker key', 'KEY', thread],
  );
  const made = await task(check, 'kit', [notes[2]], { title: 'Settings last', code: 'SETTINGS', thread });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.match((await route(check, 'kit')).body.error, /no notes wait/);
  const log = await h.hq(check, 'route', 'log', '--since', since);
  assert.match(log.out, new RegExp(`#${notes[0]} .* #${later} moss \\(brief\\)`));
  assert.match(log.out, new RegExp(`#${notes[1]} .* #${key.body.id} wren \\(task\\)`));
  assert.match(log.out, new RegExp(`#${notes[2]} .* #${made.body.id} kit \\(task\\)`));
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
  assert.equal((await route(next, `#${made.body.id}`)).body.how, 'brief');
  await h.finish(next);

  assert.match(
    promptOf(key.body.id),
    /routed it to this work[\s\S]*not verified as the board's words[\s\S]*The key is too pale/,
  );
  const settings = promptOf(made.body.id) as string;
  assert.match(settings, /Settings come last/);
  assert.ok(settings.includes(words));
  assert.match(promptOf(later), /The arcade floor is too busy/);
  assert.ok(!jobs.listJobs().some((j: any) => /^Board notes on/.test(j.title)), 'no job of notes on HQ');
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
  for (const [to, why] of [
    ['nobody', /a new task of the notes is hq job nobody/],
    [`#${done.id}`, /isn't work an agent queued that hasn't started/],
    [`#${running.id}`, /isn't work an agent queued that hasn't started.*--after it/],
    [`#${asked.job}`, /isn't work an agent queued that hasn't started/],
    [`#${check.id}`, /isn't work an agent queued that hasn't started/],
  ] as const) {
    const r = await route(check, to);
    assert.equal(r.status, 400, to);
    assert.match(r.body.error, why);
  }
  assert.match((await route(check, `#${done.id}`, [note + 1000])).body.error, /not notes this job routes/);
  // hq job --notes: the CEO's, notes it routes, and a job refused for anything else routes none
  assert.equal(
    typeof plan.newProject(
      { id: 'note-refusals', name: 'Note refusals', owner: 'juno', code: 'NF' },
      'juno',
      () => true,
    ),
    'object',
  );
  const newThread = { project: 'note-refusals', name: 'Refused task', goal: 'Nothing is queued' };
  for (const [by, notes, more, why] of [
    [kit, [note], {}, /only the CEO routes/],
    [kit, [note], { code: 'REFUSE', newThread }, /only the CEO routes/],
    [check, [note + 1000], { code: 'REFUSE', newThread }, /not notes this job routes/],
    [check, [], {}, /name the notes/],
    [check, [note + 1000], {}, /not notes this job routes/],
    [check, [note], { thread: 'nope/none' }, /isn't an open thread/],
  ] as const) {
    const r = await task(by, 'kit', [...notes], more);
    assert.equal(r.status >= 400 && r.status < 500, true, JSON.stringify(r.body));
    assert.match(r.body.error, why);
  }
  assert.deepEqual(projects.listThreads({ project: 'note-refusals' }), [], 'a refused task draws no thread');
  assert.equal((await routeOf(check, note)).routed, null);
  assert.equal((await task(check, 'kit', [note], { code: 'AFTER', after: inReview })).status, 200);
  assert.equal((await routeOf(check, note)).how, 'task');
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

test("a product's notes in its owner's task hold its return; in a colleague's, HQ brings it back after", async () => {
  const wrens = queued('wren', 'wren-queued');
  const check = await checkFor(await send('yarn', [pin('yarn', 'First words')]));
  assert.equal((await route(check, `#${wrens}`)).body.how, 'brief');
  assert.equal(returnOf('yarn').job, wrens);
  assert.match(promptOf(wrens), /First words[\s\S]*You own bringing yarn[\s\S]*--back yarn/);
  await h.finish(check);

  const look = pin('yarn', 'The type is the brand guide’s');
  const next = await checkFor(await send('yarn', [look]));
  const kits = await task(next, 'kit', [look], { code: 'TYPE' });
  assert.equal(kits.status, 200, JSON.stringify(kits.body));
  assert.match(promptOf(kits.body.id), /HQ brings yarn back to the board once this work is done: a job of Wren's/);
  assert.equal(returnOf('yarn').job, wrens, "the owner's task still holds it");
  await h.finish(next);
  assert.deepEqual(
    jobs.outstandingWaits(wrens).map(w => w.id),
    [kits.body.id],
    "and waits for Kit's task",
  );
  jobs.finish(kits.body.id, { status: 'done' });
  h.storedPr(8601, kits.body.id, 'open');
  assert.deepEqual(
    jobs.outstandingWaits(wrens).map(w => w.id),
    [kits.body.id],
    'and for its merge',
  );
});

test("an owner's started task's --back card leaves the return open while a colleague's notes aren't on main; HQ brings them back after", async () => {
  const wrens = queued('wren', 'wren-started');
  const check = await checkFor(await send('yarn', [pin('yarn')]));
  assert.equal((await route(check, `#${wrens}`)).body.how, 'brief');
  await h.finish(check);
  const wren = await h.claim('wren-started');
  assert.equal(wren?.id, wrens);

  const look = pin('yarn');
  const next = await checkFor(await send('yarn', [look]));
  const kits = await task(next, 'kit', [look], { code: 'EDGE' });
  assert.equal(kits.status, 200, JSON.stringify(kits.body));
  await h.finish(next);
  jobs.finish(kits.body.id, { status: 'done' });
  h.storedPr(8602, kits.body.id, 'open');
  const card = await agent('request', wren!.token, {
    kind: 'decision',
    title: 'Yarn',
    urgency: 'today',
    back: ['yarn'],
    body: 'Back.\n\nNo pictures: the change is in what it says.',
  });
  assert.equal(card.status, 200, JSON.stringify(card.body));
  assert.ok(returnOf('yarn'), "Kit's change isn't on main, so the card can't have shown it");
  await h.finish(wren!);
  owed.sweep();
  const back = returnOf('yarn').job;
  assert.deepEqual(
    [jobs.jobAgent(back), jobs.outstandingWaits(back).map(w => w.id)],
    ['wren', [kits.body.id]],
    "Wren's return, after Kit's merge",
  );
});

// A send of notes on two products is tasks in each product's project, and their review
// rounds and the return sit there too; no job of HQ's bundles the notes.
test("notes on two products become tasks in each product's threads, and their reviews and return follow them", async () => {
  for (const [id, name, code] of [
    ['loom-work', 'Loom', 'LW'],
    ['felt-work', 'Felt', 'FW'],
  ])
    assert.equal(typeof plan.newProject({ id, name, owner: 'juno', code }, 'juno', () => true), 'object');
  assert.equal(
    typeof plan.newThread(
      { project: 'felt-work', name: 'Type', goal: 'The type reads', slug: 'type' },
      { agent: 'juno' },
    ),
    'object',
  );
  const floor = pin('loom', 'The floor is too busy');
  const type = [pin('felt', 'The type is pale'), pin('felt', 'The type is small')];
  const sent = await send('loom', [floor]);
  assert.equal((await send('felt', type)).job, sent.job);
  const check = await checkFor(sent);
  assert.match(check.prompt, /on loom \(products\/loom\): its owner is wren, its project loom-work/);
  const calm = await task(check, 'wren', [floor], {
    title: 'A calmer floor',
    code: 'FLOOR',
    newThread: { project: 'loom-work', name: 'Floor', goal: 'The floor is calm' },
  });
  assert.equal(calm.status, 200, JSON.stringify(calm.body));
  const darker = await task(check, 'kit', type, {
    title: 'Darker, larger type',
    code: 'TYPE',
    thread: 'felt-work/type',
  });
  assert.equal(darker.status, 200, JSON.stringify(darker.body));
  await h.finish(check);
  assert.match(jobs.threadOf(calm.body.id)!, /^loom-work\//);
  assert.deepEqual([jobs.threadOf(darker.body.id), h.job(darker.body.id).code], ['felt-work/type', 'FW-TYPE']);
  assert.equal(h.job(calm.body.id).code, 'LW-FLOOR');
  const log = routing.log(new Date(0).toISOString()) as { note: number; to_job: number | null }[];
  for (const note of [floor, ...type]) assert.ok(log.find(r => r.note === note)?.to_job, `#${note} is a task's`);
  assert.deepEqual(
    jobs.listJobs().filter((j: any) => /^Board (notes|feedback) on/.test(j.title)),
    [],
    'no job bundles the notes',
  );
  assert.equal(returnOf('loom').job, calm.body.id, "loom's owner's task holds its return");

  // Kit's task ends with a pull request: its review round is in its thread, and Wren's return follows in felt's project
  assert.deepEqual(jobs.finish(darker.body.id, { status: 'done' }), { ok: true });
  h.storedPr(8059, darker.body.id, 'open');
  const review = jobs.createJob({ agent: 'bolt', kind: 'review', pr: 8059, title: 'Review', prompt: '' });
  assert.equal(jobs.threadOf(review.id), 'felt-work/type');
  assert.deepEqual(jobs.finish(review.id, { status: 'done' }), { ok: true });
  owed.sweep();
  const back = returnOf('felt').job;
  assert.deepEqual(
    [h.job(back).agent, h.job(back).after, h.job(back).title],
    ['wren', darker.body.id, 'felt back to the board'],
  );
  assert.equal(jobs.threadOf(back), `felt-work/job-${back}`, "in felt's project, not the Front Desk");
  // Juno, felt's project's owner, sorts it: the task and its one-task thread both take Juno's name, so the plan shows
  // no template name on its tile (sorting.ts)
  const { proposal } = db
    .prepare(
      "select s.proposal from sorts s join proposals p on p.id = s.proposal where s.job = ? and p.status = 'open'",
    )
    .get(back) as { proposal: number };
  const sorted = (await import('./proposals.ts')).accept(proposal, 'juno', {
    title: "Show the board felt's darker type",
    code: 'FELTBACK',
  });
  assert.equal((sorted as { job: number }).job, back, JSON.stringify(sorted));
  assert.deepEqual(
    [h.job(back).title, projects.findThread(`felt-work/job-${back}`)?.name],
    ["Show the board felt's darker type", "Show the board felt's darker type"],
  );
});

test("a task of the board's notes is its ask: the CEO gives its time as it's queued, on the task's thread", async () => {
  const HOUR = 3_600_000;
  const note = pin('loom', 'The colours clash');
  const check = await checkFor(await send('loom', [note]));
  const untimed = await agent('job', check.token, {
    agent: 'wren',
    title: 'Calmer colours',
    prompt: '',
    notes: [note],
  });
  assert.equal(untimed.status, 409);
  assert.match(untimed.body.error, /the board's ask \(in its notes\).*--by none/s);
  assert.equal((await routeOf(check, note)).routed, null, 'the note stays to route');
  const before = Date.now();
  const timed = await task(check, 'wren', [note], {
    title: 'Calmer colours',
    code: 'COLOURS',
    newThread: { project: 'loom-work', name: 'Colours', goal: 'The colours agree' },
    by: '3h',
  });
  assert.equal(timed.status, 200, JSON.stringify(timed.body));
  const window = db
    .prepare('select deadline, deadline_by from threads where id = ?')
    .get(jobs.threadOf(timed.body.id)) as {
    deadline: number;
    deadline_by: string;
  };
  assert.ok(window.deadline >= before + 3 * HOUR && window.deadline <= Date.now() + 3 * HOUR, 'three hours on');
  assert.equal(window.deadline_by, 'juno');
  assert.equal((await routeOf(check, note)).to_job, timed.body.id);
  await h.finish(check);
});
