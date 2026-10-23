// node --test src/messages.test.ts   (hq say: a message is stored, delivered to the recipient's running job or made a job)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chownSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { harness, type Running, WORKER_TOKEN, VOICE_TOKEN } from './harness.ts';

const h = await harness('messages');
const { db, jobs } = h;
const messages = await import('./messages.ts');
const { status: agentStatus } = await import('./events.ts');

const say = (j: Running, to: string, text: string, as?: string) => h.agent('message', j.token, { to, text, ...(as ? { as } : {}) });
// hq sent: where the sender's message went (its job, offered, delivered, the job it became or joined, lapsed)
const sent = async (j: Running, id: number) => (await h.agent(`sent?id=${id}`, j.token)).body[0];
const inbox = async (j: Running) => (await h.agent('inbox', j.token, {})).body;
// the brief a made job's run gets
const brief = (id: number) => (db.prepare('select prompt from jobs where id = ?').get(id) as { prompt: string }).prompt;
// HQ's feed since a point
const events = (since: number) => db.prepare('select * from events where id > ? order by id').all(since) as any[];
const lastEventId = () => (db.prepare('select max(id) n from events').get() as any).n ?? 0;
// Earlier tests' messages and queued jobs gone: a claim takes this test's own.
const clear = () => db.exec("delete from messages; delete from jobs where status = 'queued'");
test.beforeEach(clear);

// A running job for `agent` on `engine`: the Claude engine is the only one that takes messages mid-run.
const running = (agent: string, engine = 'claude') => h.start({ agent, engine });
const sender = (agent = 'bolt') => h.start({ agent });
const end = (j: Running, status = 'done') => h.finish(j, { status });
// A paused job taken up again by the worker.
async function resumed(j: Running) {
  const again = await h.claim('claude');
  assert.equal(again?.id, j.id);
  return again!;
}

test('a message to a colleague with a running Claude job waits for that job; only its token takes it, once', async () => {
  const bolt = await sender(), moss = await running('moss'), other = await running('wren');
  const since = lastEventId();
  const r = await say(bolt, 'moss', 'The phone logs are in /tmp/x.\nSecond line.');
  assert.equal(r.status, 200);
  assert.deepEqual({ ...r.body, id: 0 }, { id: 0, state: 'queued', job: moss.id });
  let out = await sent(bolt, r.body.id);
  assert.deepEqual([out.to, out.job, out.delivered, out.became], ['moss', moss.id, null, null]);
  assert.ok(events(since).some(e => e.type === 'chat' && e.agent === 'bolt' && e.to === 'moss'));   // HQ's bubble, as before
  // nobody else's token takes it: not the sender's, not another running job's
  assert.deepEqual(await inbox(bolt), []);
  assert.deepEqual(await inbox(other), []);
  assert.deepEqual((await inbox(moss)).map((m: any) => [m.message, m.from, m.from_job, m.reply_to, m.text]),
    [[r.body.id, 'bolt', bolt.id, 'bolt', 'The phone logs are in /tmp/x.\nSecond line.']]);
  assert.deepEqual(await inbox(moss), []);   // offered: no other hook takes it meanwhile
  out = await sent(bolt, r.body.id);
  assert.ok(out.offered); assert.equal(out.delivered, null);          // offered isn't delivered
  // only the recipient job's own ack marks it, and only what it was offered
  const ack = (j: Running, ids: unknown) => h.agent('inbox-ack', j.token, { ids });
  assert.deepEqual((await ack(other, [r.body.id])).body, { delivered: [] });
  assert.deepEqual((await ack(bolt, [r.body.id])).body, { delivered: [] });
  assert.equal((await ack(moss, 'all')).status, 400);
  assert.deepEqual((await ack(moss, [r.body.id, r.body.id, 99999])).body, { delivered: [r.body.id] });
  assert.deepEqual((await ack(moss, [r.body.id])).body, { delivered: [] });   // once
  out = await sent(bolt, r.body.id);
  assert.equal(out.job, moss.id); assert.ok(out.delivered); assert.equal(out.became, null); assert.equal(out.text, 'The phone logs are in /tmp/x.\nSecond line.');
  db.prepare("update messages set offered = '2000-01-01T00:00:00.000Z' where id = ?").run(r.body.id);   // offered long ago: time moving on
  assert.deepEqual(await inbox(moss), []);   // delivered: never offered again
  // hq sent is the sender's own: another agent's token doesn't see it
  assert.equal((await h.agent(`sent?id=${r.body.id}`, moss.token)).status, 404);
  assert.ok(!(await h.agent('sent', moss.token)).body.some((m: any) => m.id === r.body.id));
  for (const j of [bolt, moss, other]) await end(j);
});

test("the worker and voice tokens get 401, a call gets 403 on the inbox and 400 on a say without a job, and an ended job gets 401", async () => {
  const fake = (token: string) => ({ token }) as Running;
  for (const t of [WORKER_TOKEN, VOICE_TOKEN, 'nope']) {
    assert.equal((await say(fake(t), 'moss', 'hi')).status, 401, t);
    assert.equal((await h.agent('inbox', t, {})).status, 401, t);
    assert.equal((await h.agent('inbox-ack', t, { ids: [1] })).status, 401, t);
    assert.equal((await h.agent('sent', t)).status, 401, t);
  }
  const ctx = (await h.voice('call-context?agent=wren')).body;
  assert.equal((await say(fake(ctx.token), 'moss', 'hi')).status, 400, "a call's say without a job and a line for its list is refused");
  assert.equal((await h.agent('inbox', ctx.token, {})).status, 403);
  assert.equal((await h.agent('inbox-ack', ctx.token, { ids: [1] })).status, 403);
  const done = await running('moss');
  await end(done);
  assert.equal((await h.agent('inbox', done.token, {})).status, 401);
});

test('no running job: the message is a job right away, the sender and its first line the title (cut at a word), the whole text its prompt', async () => {
  const bolt = await sender();
  const text = 'Can you check the Caddy rule?\nIt 404s on /api.';
  const r = await say(bolt, 'rivet', text);   // an alumnus: a lead can bring one back
  assert.equal(r.status, 200); assert.equal(r.body.state, 'job'); assert.equal(r.body.why, 'idle');
  const j = h.job(r.body.job);
  assert.deepEqual([j.agent, j.title, j.status, j.kind], ['rivet', 'Message from bolt: Can you check the Caddy rule?', 'queued', 'work']);
  assert.ok(brief(j.id).startsWith(`${text}\n\n(Message from bolt, sent with hq say as message #${r.body.id} from job #${bolt.id}.`));
  assert.equal((await sent(bolt, r.body.id)).became, r.body.job);
  const titled = async (text: string) => h.job((await say(await sender(), 'dex', text)).body.job).title;
  assert.equal(await titled('\n  Seats:   two   ready\nmore'), 'Message from bolt: Seats: two ready');
  assert.equal(await titled('The front site answers 404 on every route under /api since the deploy at noon, which looks like the Caddy rule'),
    'Message from bolt: The front site answers 404 on every route under /api since the deploy…');
  await end(bolt);
});

test('a team member speaks as itself; the answer goes to its lead', async () => {
  const bolt = await sender();
  await h.worker('team', { job: bolt.id, lead: 'bolt', id: 'cobble', name: 'Cobble' });
  const r = await say(bolt, 'rivet', 'Ping', 'cobble');
  assert.match(brief(r.body.job), /\(Message from cobble, on bolt's team, .*hq say bolt "\.\.\."\)$/);
  assert.equal((await say(bolt, 'rivet', 'Ping', 'juno')).status, 403);   // not a member of this job
  assert.equal((await h.agent('sent?as=cobble', bolt.token)).body[0].id, r.body.id);
  await end(bolt);
});

test("hq sent: a team member sees its own job's messages, not a same-named member's in another job", async () => {
  const bolt = await sender(), rivet = await sender('rivet');
  for (const j of [bolt, rivet]) await h.worker('team', { job: j.id, lead: j.agent, id: 'helper', name: 'Helper' });
  const mine = await say(bolt, 'nib', "From bolt's helper", 'helper'), theirs = await say(rivet, 'nib', "From rivet's helper", 'helper');
  assert.deepEqual((await h.agent('sent?as=helper', bolt.token)).body.map((m: any) => m.id), [mine.body.id]);
  assert.deepEqual((await h.agent('sent?as=helper', rivet.token)).body.map((m: any) => m.id), [theirs.body.id]);
  assert.equal((await h.agent(`sent?as=helper&id=${theirs.body.id}`, bolt.token)).status, 404);
  assert.equal((await h.agent(`sent?as=helper&id=${mine.body.id}`, bolt.token)).body[0].text, "From bolt's helper");
  for (const j of [bolt, rivet]) await end(j);
});

test('a Codex recipient gets a job, even while its Codex job runs (no hooks there)', async () => {
  const bolt = await sender(), nib = await running('nib', 'codex');
  const r = await say(bolt, 'nib', 'Look at PR 12');
  assert.deepEqual([r.body.state, r.body.why, h.job(r.body.job).agent], ['job', 'codex', 'nib']);
  assert.deepEqual(await inbox(nib), []);
  for (const j of [bolt, nib]) await end(j);
});

test('a job that ends before taking its messages in: they become a job (one per sender job); a paused one keeps them for its next run', async () => {
  const bolt = await sender();
  let moss = await running('moss');
  const kept = await say(bolt, 'moss', 'Kept over a pause');
  await end(moss, 'interrupted');   // requeued: resumes in the same session, and its hook reads it then
  assert.equal((await sent(bolt, kept.body.id)).became, null);
  moss = await resumed(moss);
  const lost = await say(bolt, 'moss', 'Unread when it ends');
  assert.equal(lost.body.job, moss.id);
  const since = lastEventId();
  await end(moss);
  const [first, second] = [await sent(bolt, kept.body.id), await sent(bolt, lost.body.id)];
  for (const m of [first, second]) { assert.equal(m.delivered, null); assert.ok(m.became, `message ${m.id} became a job`); }
  assert.equal(h.job(first.became).agent, 'moss'); assert.equal(h.job(first.became).status, 'queued');
  assert.ok(events(since).some(e => e.text?.startsWith(`Message #${first.id} to moss wasn't read before job #${moss.id} ended`)));
  // the second, from the same job of Bolt's, goes with the first into the job it became, which hasn't started yet
  assert.deepEqual([second.became, second.joined], [first.became, first.id]);
  assert.match(brief(first.became), /Kept over a pause[\s\S]*Unread when it ends/);
  assert.equal(second.job_status, 'queued');
  await end(bolt);
});

test("a second message to an idle colleague goes into the job the first became while it hasn't started: one job, both texts", async () => {
  const lark = await sender('lark'), other = await sender('pylon');
  const first = await say(lark, 'rivet', 'Please check the rivetlamp wiring.');
  const second = await say(lark, 'rivet', 'Correction: the rivetlamp in the lobby, not the library.');
  assert.deepEqual([first.body.state, second.body.state, second.body.job, second.body.added], ['job', 'job', first.body.job, first.body.id]);
  assert.equal(first.body.added, undefined);
  const made = first.body.job;
  assert.match(brief(made), /rivetlamp wiring[\s\S]*Correction: the rivetlamp in the lobby[\s\S]*message #\d+ from job #\d+, sent after the one above/);
  // hq sent says where each went
  assert.deepEqual(((await h.agent('sent', lark.token)).body as any[]).filter(m => m.to === 'rivet').map(m => [m.id, m.became, m.joined ?? null]),
    [[second.body.id, made, first.body.id], [first.body.id, made, null]]);
  // a sender that read a customer's details: HQ shows its words like any message's, and the job it joins isn't flagged
  jobs.handedCustomerData(lark.id);   // (as hq mail or hq orders mark it)
  const since = lastEventId();
  const third = await say(lark, 'rivet', 'And the customer asked for it by Friday.');
  assert.equal(third.body.job, made);
  assert.deepEqual((await h.worker('customers', { job: made })).body, { customers: false });
  assert.ok(events(since).some(e => e.type === 'chat' && e.agent === 'lark' && e.text === 'And the customer asked for it by Friday.'));
  // another sender job's message is a job of its own; so is one after the job started
  const theirs = await say(other, 'rivet', 'Separate thing.');
  assert.notEqual(theirs.body.job, made);
  const started = await h.claim(h.job(made).engine);
  assert.equal(started?.id, made);
  await h.finish(started!, { status: 'interrupted', session: 'its-session' });   // started, and paused
  const late = await say(lark, 'rivet', 'One more.');
  assert.ok(late.body.job !== made && late.body.job !== theirs.body.job && late.body.added === undefined);
  for (const j of [lark, other]) await end(j);
});

// The job's messages, in the order its prompt has them (each one's signature names it).
const order = (prompt: string) => [...prompt.matchAll(/as message #(\d+)/g)].map(x => Number(x[1]));

test('an earlier message left unread after a later one became a job goes in before it: the job reads them in the order they were sent', async () => {
  const bolt = await sender();
  let moss = await running('moss');
  const first = await say(bolt, 'moss', 'Use the blue quollframe.');
  await end(moss, 'interrupted');   // requeued: the first waits for its next run
  const second = await say(bolt, 'moss', 'Correction: the green quollframe, not the blue one.');
  assert.deepEqual([second.body.state, second.body.why], ['job', 'idle']);
  moss = await resumed(moss);
  await end(moss);   // without reading the first: it joins the job the second made, before it
  const out = await sent(bolt, first.body.id);
  assert.deepEqual([out.became, out.joined], [second.body.job, second.body.id]);
  const prompt = brief(second.body.job);
  assert.match(prompt, /^Use the blue quollframe\.\n\n\(Message from bolt[\s\S]*Correction: the green quollframe[^\n]*\n\n\(Another message from bolt, [^)]*sent after the one above/);
  assert.equal(prompt.match(/Message from bolt/g)!.length, 1, 'one note says whose words they are and how to answer');
  await end(bolt);
});

test('two earlier messages left unread after a later one became a job go in before it, in the order they were sent', async () => {
  const bolt = await sender();
  let moss = await running('moss');
  const one = await say(bolt, 'moss', 'First: the quollframe.');
  const two = await say(bolt, 'moss', 'Second: the blue one.');
  await end(moss, 'interrupted');   // requeued: both wait for its next run
  const three = await say(bolt, 'moss', 'Third: no, the green one.');
  assert.equal(three.body.state, 'job');
  moss = await resumed(moss);
  await end(moss);   // neither read: both join the third's job, before it and in their own order
  assert.deepEqual(order(brief(three.body.job)), [one.body.id, two.body.id, three.body.id]);
  await end(bolt);
});

test('a message left unread that was sent between the one that made a job and a later one that joined it goes between them', async () => {
  const bolt = await sender();
  const other = h.queue({ agent: 'moss', engine: 'claude' });
  const one = await say(bolt, 'moss', 'First: paint the quollframe.');   // moss is idle: a job of its own (A)
  assert.equal(one.body.state, 'job');
  let moss = (await h.claim('claude'))!;   // the older job (B) takes the second
  assert.equal(moss.id, other);
  const two = await say(bolt, 'moss', 'Second: blue.');
  assert.deepEqual([two.body.state, two.body.job], ['queued', moss.id]);
  await end(moss, 'interrupted');   // B requeued: the second waits for its next run
  const three = await say(bolt, 'moss', 'Third: no, green.');
  assert.deepEqual([three.body.job, three.body.added], [one.body.job, one.body.id]);
  moss = await resumed(moss);
  await end(moss);   // the second, never read, joins A between the first and the third: the third stays the last word
  assert.equal((await sent(bolt, two.body.id)).became, one.body.job);
  const prompt = brief(one.body.job);
  assert.deepEqual(order(prompt), [one.body.id, two.body.id, three.body.id]);
  assert.match(prompt, /Third: no, green\.\n\n\(Another message[^)]*sent after the one above[^)]*\)$/);
  await end(bolt);
});

test('a message stored for an idle recipient that became no job (publish threw, a restart) is made one by the sweep', async () => {
  const bolt = await sender();
  // stored, then the coordinator stopped before making its job: no route leaves it so
  const { lastInsertRowid } = db.prepare("insert into messages (created, sender, sender_job, recipient, text, depth) values (?, 'bolt', ?, 'moss', 'Stored, then the coordinator stopped', 0)")
    .run(new Date().toISOString(), bolt.id);
  messages.sweep();
  messages.sweep();
  const made = (jobs.listJobs() as any[]).filter(j => j.title === 'Message from bolt: Stored, then the coordinator stopped');
  assert.deepEqual(made.map(j => j.agent), ['moss'], 'once');
  assert.equal((await sent(bolt, Number(lastInsertRowid))).became, made[0].id);
  await end(bolt);
});

test('a finish that stopped before jobEnded (a hand-off threw, a restart): the sweep makes its unread messages jobs', async () => {
  const bolt = await sender(), moss = await running('moss');
  const lost = await say(bolt, 'moss', 'Unread when the finish broke off');
  db.prepare("update jobs set status = 'done', seat = null where id = ?").run(moss.id);   // its status was written, then it stopped
  assert.equal((await end(moss)).status, 409, "a retry: the job isn't on that seat any more");
  assert.equal((await sent(bolt, lost.body.id)).became, null);
  messages.sweep();
  messages.sweep();
  const made = (jobs.listJobs() as any[]).filter(j => j.title === 'Message from bolt: Unread when the finish broke off');
  assert.deepEqual(made.map(j => j.agent), ['moss'], 'once');
  assert.equal((await sent(bolt, lost.body.id)).became, made[0].id);
  await end(bolt);
});

test('an ack that never comes: offered again at a later step, after a minute (not to two hooks at once); at the end, a job', async () => {
  const bolt = await sender(), moss = await running('moss');
  const r = await say(bolt, 'moss', 'Did this arrive?');
  assert.deepEqual((await inbox(moss)).map((m: any) => m.message), [r.body.id]);   // the hook printed it; its ack got lost
  assert.deepEqual(await inbox(moss), []);                                        // a parallel hook, seconds later: not again
  db.prepare('update messages set offered = ? where id = ?').run(new Date(Date.now() - 61e3).toISOString(), r.body.id);   // a minute on: a later step's hook
  assert.deepEqual((await inbox(moss)).map((m: any) => m.message), [r.body.id]);
  const since = lastEventId();
  await end(moss);   // offered twice, never acknowledged: it may have arrived, but nobody said so
  const out = await sent(bolt, r.body.id);
  assert.equal(out.delivered, null); assert.ok(out.became);
  assert.ok(events(since).some(e => e.text?.startsWith(`Message #${r.body.id} to moss was offered to job #${moss.id} but not confirmed read`)));
  await end(bolt);
});

test('a chain of messages starts at most 3 jobs; past that, a message reaches only a running job, and is refused otherwise', async () => {
  const count = () => (db.prepare('select count(*) n from messages').get() as any).n;
  // bolt asks rivet (idle): job 1; rivet answers bolt (idle by then): job 2; bolt says thanks: job 3, the last
  let from = await sender(), to = 'rivet';
  const made: number[] = [];
  for (const text of ['Can you check X?', 'Checked: fine.', 'Thanks!']) {
    const r = await say(from, to, text);
    assert.deepEqual([r.status, r.body.state], [200, 'job']);
    made.push(r.body.job);
    await end(from);
    const next = await h.claim(h.job(r.body.job).engine);
    assert.equal(next?.id, r.body.job);
    from = next!; to = to === 'rivet' ? 'bolt' : 'rivet';
  }
  assert.ok(!brief(made[1]).includes('the last of the 3'));
  assert.match(brief(made[2]), /This job is the last of the 3 one chain of messages may start: from here, hq say reaches only a colleague whose job is running now/);
  // rivet's job 3 answers the thanks: bolt is idle, so it would be job 4: refused, nothing stored or shown
  const before = count(), since = lastEventId();
  const no = await say(from, 'bolt', "You're welcome!");
  assert.equal(no.status, 409);
  assert.equal(count(), before); assert.ok(!events(since).some(e => e.type === 'chat'));
  const nib = await running('nib', 'codex');
  assert.equal((await say(from, 'nib', 'x')).status, 409);   // a Codex job can't take it in: it would be a job too
  // a colleague whose Claude job is running still gets it; if that job ends unread, it lapses instead of starting a job
  const moss = await running('moss');
  const q = await say(from, 'moss', 'FYI: X is fine.');
  assert.deepEqual([q.status, q.body.state, q.body.job, q.body.chain_full], [200, 'queued', moss.id, true]);
  await end(moss, 'failed');
  const out = await sent(from, q.body.id);
  assert.ok(out.lapsed); assert.equal(out.became, null); assert.equal(out.delivered, null);
  for (const j of [from, nib]) await end(j);
});

test('refusals: empty, too long (never cut), not a colleague who runs jobs, too many', async () => {
  const bolt = await sender();
  const count = () => (db.prepare('select count(*) n from messages').get() as any).n;
  const before = count();
  assert.equal((await say(bolt, 'moss', '  ')).status, 400);
  assert.equal((await say(bolt, 'moss', 'x'.repeat(8001))).status, 413);
  for (const to of ['board', 'nobody-here', '']) assert.equal((await say(bolt, to, 'hi')).status, 404, to);
  assert.equal(count(), before, 'nothing stored');
  const limit = await say(bolt, 'moss', 'x'.repeat(8000));   // exactly the limit goes, whole
  assert.equal((await sent(bolt, limit.body.id)).text.length, 8000);
  for (let i = 1; i < 30; i++) assert.equal((await say(bolt, 'rivet', `n${i}`)).status, 200);
  assert.equal((await say(bolt, 'rivet', 'one too many')).status, 429);
  await end(bolt);
});

// The whole way, for real: hq say from one job, the worker's hook settings (inbox.ts) in the recipient's Claude CLI
// against a scripted model, and hq sent afterwards. Skipped where the CLI isn't installed (the worker image has it).
const cli = (() => { try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('end to end: sent mid-run, in the model\'s next request, and hq sent says delivered', { skip: !cli && 'no claude CLI here' }, async () => {
  const HQ = new URL('../../worker/bin/hq', import.meta.url).pathname, { inboxSettings } = await import('../../worker/src/inbox.ts');
  const moss = await sender('moss'), bolt = await running('bolt');
  const hq = async (...args: string[]) => (await h.hq(moss, ...args)).out;
  const seen: string[] = [];
  let said = '';
  const model = createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', async () => {
    if (!req.url!.startsWith('/v1/messages') || req.url!.includes('count_tokens')) { res.writeHead(404); return res.end(); }
    const body = JSON.parse(b); seen.push(JSON.stringify(body.messages));
    if (seen.length === 1) said = await hq('say', 'bolt', 'Moss here: the deck is ready.');   // while bolt's job works
    const tool = seen.length === 1, ev = (d: any) => res.write(`event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    ev({ type: 'message_start', message: { id: `m${seen.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    ev({ type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } : { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{"command":"echo hi","description":"x"}' } : { type: 'text_delta', text: 'Done.' } });
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }); ev({ type: 'message_stop' }); res.end();
  }); }).listen(0, '127.0.0.1');
  await new Promise(r => model.once('listening', r));
  const home = mkdtempSync(`${tmpdir()}/msg-e2e-`);
  // as the worker runs it, never as root (the CLI won't skip its permission prompts as root): a test run as root runs it
  // as nobody, in a home of nobody's
  const as = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
  if (as.uid) chownSync(home, as.uid, as.gid!);
  const c = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--model', 'sonnet', '--settings', inboxSettings(HQ)],
    { cwd: home, env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: `${home}/.claude`, ANTHROPIC_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}`,
      ANTHROPIC_API_KEY: 'sk-ant-test', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HQ_URL: h.base, HQ_TOKEN: bolt.token, HQ_AGENT: 'bolt', HQ_JOB: String(bolt.id) }, ...as });
  c.stdin.end('Do the job.');
  assert.equal(await new Promise(r => c.on('close', r)), 0);
  model.close(); rmSync(home, { recursive: true, force: true });
  const id = (db.prepare('select max(id) n from messages').get() as any).n;
  assert.equal(said, `Queued for bolt's running job #${bolt.id}: it reads it at its next step; if the job ends first it becomes a new job. Check: hq sent ${id}\n`);
  assert.ok(!seen[0].includes('the deck is ready') && seen[1].includes('Moss here: the deck is ready.'));
  assert.match(await hq('sent', String(id)), new RegExp(`^#${id} to bolt, .* UTC: delivered to job #${bolt.id} at .* UTC\\n\\nMoss here: the deck is ready.\\n$`));
  for (const j of [moss, bolt]) await end(j);
});

test("a job's lines reach HQ: on the feed as they come, and on its agent's status in the org chart", async () => {
  const kit = await running('kit');
  const feed: any[] = [];
  const res = await fetch(`${h.base}/api/events`, { headers: { cookie: h.boardCookie } });
  const reader = res.body!.getReader();
  (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; for (const l of new TextDecoder().decode(value).split('\n')) if (l.startsWith('data: ')) feed.push(JSON.parse(l.slice(6))); } })().catch(() => {});
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await h.agent('event', kit.token, { type: 'lines', add: 40, del: 6 })).status, 200);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(feed.some(e => e.type === 'lines' && e.agent === 'kit' && e.add === 40 && e.del === 6), JSON.stringify(feed.slice(-3)));
  const org = (await h.board('/api/org')).body;
  const a = org.departments.flatMap((d: any) => d.agents).find((x: any) => x.id === 'kit');
  assert.deepEqual([a.status.state, a.status.lines], ['working', { add: 40, del: 6 }]);
  await reader.cancel();
  await end(kit);
});

test("a job's tokens reach HQ: on the feed, its recent readings on its agent's status till the job ends, and what they grew by on the day's count", async () => {
  const kit = await running('kit');
  const agentOf = async () => (await h.board('/api/org')).body.departments.flatMap((d: any) => d.agents).find((x: any) => x.id === 'kit');
  const today = () => (db.prepare('select tokens from work_days order by day desc limit 1').get() as { tokens: number | null } | undefined)?.tokens ?? 0;
  const before = today();
  assert.equal((await h.agent('event', kit.token, { type: 'tokens', total: 1200, grew: 1200 })).status, 200);
  assert.equal((await h.agent('event', kit.token, { type: 'tokens', total: 3400, grew: 2200 })).status, 200);
  assert.deepEqual((await agentOf()).status.tokens.map(([, total]: number[]) => total), [1200, 3400]);
  // a reading after a restart (the status has none before it) counts what it grew by, not the job's whole total
  agentStatus.get('kit')!.tokens = undefined;
  assert.equal((await h.agent('event', kit.token, { type: 'tokens', total: 3500, grew: 100 })).status, 200);
  assert.equal(today() - before, 3500);
  await end(kit, 'done');
  assert.equal((await agentOf()).status.tokens, undefined);
});

test('a job fetches a render the server put back in its checkout: only a file with its .render.json beside it', async () => {
  const kit = await running('kit');
  const dir = `${h.repo}/products/x/ads`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/ad.mp4`, 'a film');
  writeFileSync(`${dir}/ad.mp4.render.json`, '{}');
  writeFileSync(`${dir}/loose.mp4`, 'no recipe');
  const got = await h.agent('render?path=products/x/ads/ad.mp4', kit.token);
  assert.equal(Buffer.from(got.body.data, 'base64').toString(), 'a film');
  for (const path of ['products/x/ads/loose.mp4', 'products/x/ads/../ads/ad.mp4.render.json', '../etc/passwd'])
    assert.equal((await h.agent(`render?path=${encodeURIComponent(path)}`, kit.token)).status, 404, path);
  await end(kit);
});
