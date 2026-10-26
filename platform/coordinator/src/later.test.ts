// node --test src/later.test.ts   (cards for later: hq ask/request --visible-from and the board's snooze keep an open card
// off the desk phone until a day, then it shows as a new card; the real hq)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';
import { parkedRequest } from '../../worker/src/outcome.ts';

const h = await harness('later');
const { db, board } = h;
const later = await import('./later.ts');

const dir = mkdtempSync(`${tmpdir()}/later-files-`);
const running = async (agent: string) => ({ ...(await h.start({ agent })), dir: mkdtempSync(`${dir}/job-`) });
const body = (text: string) => {
  const f = `${dir}/${Math.random().toString(36).slice(2)}.md`;
  writeFileSync(f, text);
  return f;
};
const phone = async () => (await board('/api/requests')).body as any[];
const titles = async () => (await phone()).map(r => r.title);
const laterList = async () => (await board('/api/requests/later')).body as any[];
const idOf = async (title: string) =>
  [...(await phone()), ...(await laterList())].find(r => r.title === title).id as number;
const until = (day: string) => (later.hiddenUntil(day) as { at: string }).at;
// A day on the company's clock (the fixture's Europe/Amsterdam), n days from today
const dayFrom = (n: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(Date.now() + n * 864e5);
// Time passes (no route moves the clock): the card's day has come
const arrive = (id: number) =>
  db.prepare('update requests set hidden_until = ? where id = ?').run(new Date().toISOString(), id);

// (08:00)
test("a day is read on the company's clock, from 08:00, a UTC time as given; one that has come hides nothing; nonsense and next year aren't taken", () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const at = (day: string | undefined) => later.hiddenUntil(day, now);
  assert.deepEqual(at('2026-10-13'), { ok: true, at: '2026-10-13T06:00:00.000Z' }, 'summer time: 08:00 in Amsterdam');
  assert.deepEqual(at('2026-12-01'), { ok: true, at: '2026-12-01T07:00:00.000Z' }, 'winter time');
  assert.deepEqual(
    at('2026-10-25'),
    { ok: true, at: '2026-10-25T07:00:00.000Z' },
    'the day the clocks go back: its 08:00 is in winter time',
  );
  assert.deepEqual(at('2026-10-13T08:00Z'), { ok: true, at: '2026-10-13T08:00:00.000Z' });
  assert.deepEqual(at('2026-10-10'), { ok: true, at: null }, "today's 08:00 has come: it shows now");
  assert.deepEqual(
    later.hiddenUntil('2026-10-10', Date.parse('2026-10-10T05:00:00Z')),
    { ok: true, at: '2026-10-10T06:00:00.000Z' },
    'at 07:00 today it waits until 08:00',
  );
  assert.deepEqual(at(undefined), { ok: true, at: null });
  for (const bad of ['2026-02-31', 'next tuesday', '13-10-2026', '2026-10-13T08:00', '2027-10-13'])
    assert.equal(at(bad).ok, false, bad);
});

test('hq ask --visible-from: off the desk phone, silent, listed for later, and seen by agents with its day; then it shows as a new card', async () => {
  const kit = await running('kit');
  const asked = await h.hq(
    kit,
    'ask',
    'action',
    'now',
    'API credits: look again',
    body('Look again on Tuesday.'),
    '--topic',
    'AI seats',
    '--visible-from',
    dayFrom(3),
  );
  assert.equal(asked.code, 0, asked.out);
  const id = await idOf('API credits: look again');
  assert.equal((await titles()).includes('API credits: look again'), false, 'not on the desk phone');
  const [held] = await laterList();
  assert.deepEqual([held.id, held.agent, held.topic, held.hidden_until], [id, 'kit', 'AI seats', until(dayFrom(3))]);
  assert.match(
    (await h.hq(kit, 'requests', String(id))).out,
    /API credits: look again .*for later: off the desk phone until 20\d\d-/,
  );
  assert.match(
    (await h.voice('call-context?agent=juno&lang=en')).body.prompt,
    /API credits: look again \(for later/,
    'a call knows the board put it aside',
  );

  // a card filed since, then the day comes: the card for later leads, as changed then (unread again)
  await h.hq(kit, 'ask', 'decision', 'today', 'Blue or green?', body('Which?'), '--topic', 'signs');
  arrive(id);
  assert.deepEqual(later.sweep(), [id], "the minute's look rings it as it shows (it's urgent), once");
  assert.deepEqual(later.sweep(), []);
  const [first, second] = await phone();
  assert.deepEqual([first.title, second.title], ['API credits: look again', 'Blue or green?']);
  assert.ok(first.changed > second.created, 'it counts as new from the moment it shows');
  assert.deepEqual(await laterList(), []);
});

test("a --visible-from hq can't read files nothing: hq ask and hq request say why", async () => {
  const kit = await running('kit');
  const ask = (...more: string[]) =>
    h.hq(kit, ...['ask', 'decision', 'today', 'Some time?', body('Which?'), '--topic', 'signs', ...more]);
  const asked = await ask('--visible-from', 'next tuesday');
  assert.equal(asked.code, 1);
  assert.match(asked.out, /next tuesday/);
  assert.equal(
    (
      await h.hq(
        kit,
        'request',
        'decision',
        'today',
        'Some time?',
        body('Which?'),
        '--topic',
        'signs',
        '--visible-from',
        '2026-02-31',
        '--park',
      )
    ).code,
    1,
  );
  assert.equal(existsSync(`${kit.dir}/request.json`), false, 'nothing parked');
  // (the route refuses it too)
  const direct = await h.agent('request', kit.token, {
    kind: 'decision',
    title: 'Some time?',
    body: 'Which?',
    visibleFrom: '2099-01-01',
  });
  assert.equal(direct.status, 400);
  assert.equal(
    [...(await phone()), ...(await laterList())].some(r => r.title === 'Some time?'),
    false,
  );
});

test('hq request --visible-from parks the job on a card for later: it stays blocked until the board answers, whenever that is', async () => {
  const wren = await running('wren');
  const parked = await h.hq(
    wren,
    'request',
    'decision',
    'today',
    'Stalls on Monday?',
    body('Which?'),
    '--topic',
    'stalls',
    '--visible-from',
    dayFrom(2),
    '--park',
  );
  assert.equal(parked.code, 0, parked.out);
  // what the worker sends when the job stops parked (worker.ts): parkedRequest's fields from request.json
  const request = parkedRequest(readFileSync(`${wren.dir}/request.json`, 'utf8'));
  await h.finish(wren, { status: 'parked', request });
  const id = await idOf('Stalls on Monday?');
  assert.equal(h.job(wren.id).status, 'blocked');
  assert.ok((await laterList()).some(r => r.id === id));
  arrive(id);
  assert.equal((await titles())[0], 'Stalls on Monday?');
  assert.equal(h.job(wren.id).status, 'blocked', 'still waiting for the board');
});

test('the board snoozes any open card until a day, and brings one back now, first and unread', async () => {
  const dex = await running('dex');
  const ask = (title: string, ...more: string[]) =>
    h.hq(dex, 'ask', 'decision', 'today', title, body('Which?'), '--topic', 'posters', ...more);
  await ask('Which poster first?');
  await ask('Which frame?');
  const id = await idOf('Which poster first?');
  assert.deepEqual((await board('/api/requests/later', { id, day: dayFrom(5) })).body, {
    ok: true,
    until: until(dayFrom(5)),
    day: dayFrom(5),
  });
  assert.equal((await titles()).includes('Which poster first?'), false);
  assert.equal((await laterList()).find(r => r.id === id)?.day, dayFrom(5), "its day on the company's clock");

  // a day whose 08:00 has come (today's may not have yet), a time instead of a day, or a closed card: not taken
  for (const day of [dayFrom(-1), dayFrom(-3), `${dayFrom(2)}T08:00Z`, 'soon', 5])
    assert.equal((await board('/api/requests/later', { id, day })).status, 400, String(day));
  const closed = await idOf('Which frame?');
  await h.hq(dex, 'close', String(closed));
  assert.equal((await board('/api/requests/later', { id: closed, day: dayFrom(2) })).status, 404);

  // rewritten while it's away: it stays away
  assert.equal((await h.hq(dex, 'rewrite', String(id), body('Which, now?'))).code, 0);
  assert.equal((await titles()).includes('Which poster first?'), false);

  // Bring back: it leads the list as changed now
  await ask('Which paper?');
  assert.deepEqual((await board('/api/requests/later', { id, day: null })).body, { ok: true, until: null });
  const [first] = await phone();
  assert.deepEqual([first.title, first.body], ['Which poster first?', 'Which, now?']);
  assert.ok(Date.now() - Date.parse(first.changed) < 5000);
  assert.equal(later.sweep().includes(id), false, "brought back by the board: the minute's look doesn't ring it");
  assert.equal(
    (await laterList()).some(r => r.id === id),
    false,
  );

  // the board's snooze on a card an agent filed for later moves its day
  await ask('Which ink?', '--visible-from', dayFrom(2));
  await board('/api/requests/later', { id: await idOf('Which ink?'), day: dayFrom(9) });
  assert.equal((await laterList()).find(r => r.title === 'Which ink?').hidden_until, until(dayFrom(9)));
});

test("only the board snoozes: an agent's token is refused", async () => {
  const dex = await running('dex');
  await h.hq(dex, 'ask', 'decision', 'today', 'Which stand?', body('Which?'), '--topic', 'posters');
  assert.equal(
    (await h.call('/api/requests/later', dex.token, { id: await idOf('Which stand?'), day: dayFrom(2) })).status,
    403,
  );
  assert.equal((await titles()).includes('Which stand?'), true);
});

test("a card from a call's work is held until that work is merged and deployed, or its job ends without a pull request; its job can't wait on it", async () => {
  const cardId = (title: string) =>
    (db.prepare('select id from requests where title = ?').get(title) as { id: number }).id;
  // a call's follow-up, and a job carrying one of a call's items
  const lark = await running('lark'),
    moss = await running('moss');
  h.storedCall(30, 'lark', lark.id);
  db.prepare('update jobs set item = 1 where id = ?').run(moss.id);
  const asked = await h.hq(lark, 'ask', 'decision', 'today', 'Plan: go?', body('Go?'), '--topic', 'plan');
  assert.equal(asked.code, 0, asked.out);
  assert.match(
    asked.out,
    new RegExp(`held off the board's desk phone until the work of #${lark.id} is merged and deployed`),
  );
  const plan = cardId('Plan: go?');
  assert.equal((await titles()).includes('Plan: go?'), false, 'not on the desk phone');
  assert.equal(
    (await laterList()).some(r => r.id === plan),
    false,
    'nor in its list for later',
  );
  assert.match(
    (await h.hq(lark, 'requests', String(plan))).out,
    /Plan: go\? .*held: off the desk phone until the work of #\d+ is live/,
  );
  assert.match(
    (await h.voice('call-context?agent=juno&lang=en')).body.prompt,
    /Plan: go\? \(held/,
    "a call knows it isn't on the desk phone",
  );
  const waited = await h.hq(lark, 'wait', String(plan));
  assert.equal(waited.code, 1);
  assert.match(waited.out, new RegExp(`own merge.*--after request:${plan}`), 'hq wait says why, and what to do');
  const parked = await h.hq(moss, 'request', 'decision', 'today', 'Park?', body('Which?'), '--topic', 'plan', '--park');
  assert.equal(parked.code, 1, 'hq request would park the job on its own merge');
  assert.equal(existsSync(`${moss.dir}/request.json`), false, 'nothing parked');
  await h.hq(moss, 'ask', 'decision', 'today', 'Moss: which?', body('Which?'), '--topic', 'plan');
  const which = cardId('Moss: which?');

  // lark's work merges, then deploys: its card shows, first and new. Moss's job ends with no pull request: its card shows.
  assert.deepEqual(later.sweep(), []);
  const afterLark = merge(771, lark.id, 'lark');
  assert.deepEqual(later.sweep(), [], 'merged, not deployed yet');
  deploy('lark', afterLark);
  assert.deepEqual(later.sweep(), [plan]);
  assert.equal((await titles())[0], 'Plan: go?');
  assert.equal((await titles()).includes('Moss: which?'), false);
  await h.finish(moss);
  assert.deepEqual(later.sweep(), [which]);
  assert.equal((await titles())[0], 'Moss: which?');
});

test("a follow-up's card about work it handed out (--when deployed:<job>) is held until that work is live, though the follow-up ends without a pull request", async () => {
  const wren = await running('wren');
  h.storedCall(40, 'wren', wren.id);
  const queued = await h.hq(wren, 'job', 'kit', 'Restructure the projects', body('Rename them.'), '--new');
  const restructure = Number(/Queued job #(\d+)/.exec(queued.out)?.[1]);
  assert.ok(restructure, queued.out);
  const ask = (...when: string[]) =>
    h.hq(wren, 'ask', 'decision', 'today', 'The plan: go?', body('Go?'), '--topic', 'plan', ...when);
  assert.equal((await ask('--when', '2h')).code, 1, 'a card waits only for work going live');
  const asked = await ask('--when', `deployed:${restructure}`);
  assert.equal(asked.code, 0, asked.out);
  assert.match(asked.out, new RegExp(`until the work of #${wren.id} and #${restructure} is merged and deployed`));
  const plan = (db.prepare("select id from requests where title = 'The plan: go?'").get() as { id: number }).id;
  // a job waiting on it reads the work it's held for, each by its job and code, for the board's projects view
  const step = await h.hq(wren, 'job', '--after', `request:${plan}`, 'kit', 'Act on the plan', body('Act.'), '--new');
  const acting = Number(/Queued job #(\d+)/.exec(step.out)?.[1]);
  assert.ok(acting, step.out);
  const { findJob } = await import('./jobs.ts');
  const code = (id: number) =>
    (db.prepare('select code from jobs where id = ?').get(id) as { code: string | null }).code;
  assert.deepEqual(
    findJob(acting)!.cards.map((c: { id: number; shown: boolean; holds: unknown }) => [c.id, c.shown, c.holds]),
    [[plan, false, [wren.id, restructure].map(id => ({ id, code: code(id), agent: id === wren.id ? 'wren' : 'kit' }))]],
  );

  await h.finish(wren);
  assert.deepEqual(later.sweep(), [], 'the follow-up ended without a pull request: the restructuring is still queued');
  assert.match(
    (await h.hq(await running('juno'), 'requests', String(plan))).out,
    new RegExp(`held: off the desk phone until the work of #${restructure} is live`),
  );
  const afterRestructure = merge(772, restructure, 'kit');
  assert.deepEqual(later.sweep(), [], 'merged, not deployed yet');
  deploy('restructure', afterRestructure);
  assert.deepEqual(later.sweep(), [plan]);
  assert.equal((await titles())[0], 'The plan: go?');
});

test("a card held on a thread's first task stays held when that task ends, and goes once the thread's pull request is merged and deployed", async () => {
  const threadends = await import('./threadends.ts');
  const thread = h.dueThread();
  const first = await h.start({ agent: 'lark', thread }),
    last = h.queue({ agent: 'moss', thread, engine: 'held-thread' });
  h.storedCall(45, 'lark', first.id);
  const asked = await h.hq(first, 'ask', 'decision', 'today', 'The post: go?', body('Go?'), '--topic', 'blog');
  assert.equal(asked.code, 0, asked.out);
  const post = (db.prepare("select id from requests where title = 'The post: go?'").get() as { id: number }).id;

  // the first task pushes to its own branch, which becomes the thread's (threadorder.ts pushed, planning by threads),
  // and its pull request is recorded at the merge
  const branch = `job/${first.id}`;
  await h.finish(first, { status: 'done', branch, sha: 'a'.repeat(40) });
  assert.deepEqual(later.sweep(), [], "the first task is done, the thread's pull request still to come");
  const lastRun = await h.claim('held-thread');
  assert.equal(lastRun?.id, last);
  assert.equal((await h.finish(lastRun!, { branch, sha: 'b'.repeat(40) })).status, 200);
  assert.deepEqual(later.sweep(), [], 'every task done, its pull request not opened yet');
  const deploys = db.prepare('select fetched from deploys').all() as { fetched: string }[];
  const merged = Math.max(Date.now(), ...deploys.map(d => Date.parse(d.fetched) + 1));
  h.storedPr(773, first.id, 'merged');
  h.mergedPr(773, merged);
  threadends.merged(773);
  const afterThread = new Date(merged + 1000).toISOString();
  assert.deepEqual(later.sweep(), [], 'merged, not deployed yet');
  deploy('thread', afterThread);
  assert.deepEqual(later.sweep(), [post]);
  assert.equal((await titles())[0], 'The post: go?');
});

test("a job's cards, and the one it's blocked on, say whether they're on the desk phone now: held and later ones aren't", async () => {
  const titled = (title: string) =>
    (db.prepare('select id from requests where title = ?').get(title) as { id: number }).id;
  const ask = async (who: Awaited<ReturnType<typeof running>>, title: string, ...extra: string[]) => {
    const asked = await h.hq(who, 'ask', 'decision', 'today', title, body('Go?'), '--topic', 'shown', ...extra);
    assert.equal(asked.code, 0, asked.out);
    return titled(title);
  };
  const after = async (who: { token: string }, request: number, title: string) =>
    (await h.agent('job', who.token, { agent: 'kit', title, prompt: 'x', afterRequest: request })).body.id as number;
  type Listed = { id: number; cards: { id: number; title: string; shown: boolean }[]; request_shown: boolean | null };
  const listed = async (id: number) => ((await board('/api/jobs')).body as Listed[]).find(j => j.id === id)!;
  // lark is on a call's work, so its card is held until that work is live
  const [lark, wren] = [await running('lark'), await running('wren')];
  h.storedCall(50, 'lark', lark.id);
  const held = await ask(lark, 'Shown: held?'),
    hidden = await ask(wren, 'Shown: later?', '--visible-from', dayFrom(2)),
    shown = await ask(wren, 'Shown: now?');
  const waiting = [
    await after(lark, held, 'After held'),
    await after(wren, hidden, 'After later'),
    await after(wren, shown, 'After now'),
  ];
  // (a held one with the work it waits for)
  const code = (db.prepare('select code from jobs where id = ?').get(lark.id) as { code: string | null }).code;
  assert.deepEqual(await Promise.all(waiting.map(async id => (await listed(id)).cards)), [
    [{ id: held, title: 'Shown: held?', shown: false, holds: [{ id: lark.id, code, agent: 'lark' }] }],
    [{ id: hidden, title: 'Shown: later?', shown: false, holds: [] }],
    [{ id: shown, title: 'Shown: now?', shown: true, holds: [] }],
  ]);
  // one held for a pull request waits on the task that opened it, which carries no jobs.pr
  const opened = await running('kit');
  h.storedPr(781, opened.id, 'open');
  const forPr = await ask(wren, 'Shown: for the pull request?', '--when', 'deployed:pr:781');
  const openedCode = (db.prepare('select code from jobs where id = ?').get(opened.id) as { code: string | null }).code;
  assert.deepEqual((await listed(await after(wren, forPr, 'After the pull request'))).cards, [
    {
      id: forPr,
      title: 'Shown: for the pull request?',
      shown: false,
      holds: [{ id: opened.id, code: openedCode, agent: 'kit' }],
    },
  ]);
  // a job parked on a card for later is blocked on it, off the desk phone until its day
  const moss = await running('moss');
  const parked = await h.hq(
    moss,
    'request',
    'decision',
    'today',
    'Shown: parked?',
    body('Which?'),
    '--topic',
    'shown',
    '--visible-from',
    dayFrom(2),
    '--park',
  );
  assert.equal(parked.code, 0, parked.out);
  await h.finish(moss, { status: 'parked', request: parkedRequest(readFileSync(`${moss.dir}/request.json`, 'utf8')) });
  assert.equal((await listed(moss.id)).request_shown, false);
  arrive(titled('Shown: parked?'));
  assert.equal((await listed(moss.id)).request_shown, true);
  assert.equal((await listed(lark.id)).request_shown, null, 'a job with no card of its own');
});

// After every deploy so far, as main only moves on: an earlier test's deploy, fetched a second ahead, never counts as
// this merge going live
function merge(pr: number, job: number, author: string) {
  const last = (db.prepare('select max(fetched) at from deploys').get() as { at: string | null }).at;
  const merged = new Date(Math.max(Date.now(), last ? Date.parse(last) + 1 : 0)).toISOString();
  db.prepare("insert into prs (number, branch, author, status, merged_at) values (?, ?, ?, 'merged', ?)").run(
    pr,
    `job/${job}`,
    author,
    merged,
  );
  return new Date(Date.parse(merged) + 1000).toISOString();
}

function deploy(name: string, fetched: string) {
  const deploys = `${h.dataDir}/deploys`;
  mkdirSync(deploys, { recursive: true });
  writeFileSync(
    `${deploys}/${name}.json`,
    JSON.stringify({ sha: 'cccc777', fetched, finished: new Date().toISOString(), ok: true, services: [] }),
  );
}
