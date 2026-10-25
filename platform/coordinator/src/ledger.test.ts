// Queue-time estimate contract fixtures.
// node --test src/ledger.test.ts   (throwaway DATA_DIR): the call ledger. Every call's asks and promises are recorded,
// handed out and followed until they're done; a failed follow-up is sent again, three times at most, then said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile, type ExecFileException } from 'node:child_process';
import { harness, WORKER_TOKEN, VOICE_TOKEN } from './harness.ts';

const h = await harness('ledger');
const { db, jobs } = h;
const call = await import('./call.ts');
const ledger = await import('./ledger.ts');
const { ceo, roles } = await import('./company.ts');
const memory = await import('./memory.ts');
const wakes = await import('./wakes.ts');
const agent = h.agent, voice = (route: string, body?: unknown) => h.voice(route, body);

type Job = { id: number; agent: string; kind: string; status: string; title: string; prompt: string; note: string | null; call: number | null; item: number | null; finished: string | null };
const job = (id: number) => db.prepare('select * from jobs where id = ?').get(id) as Job;
const callRow = (id: number) => db.prepare('select * from calls where id = ?').get(id) as any;
const lastCall = () => db.prepare('select * from calls order by id desc limit 1').get() as any;
const item = (id: number) => db.prepare('select * from call_items where id = ?').get(id) as any;
// The worker claims this job (on an engine of its own, so nothing else is taken) and gets its token.
const tokens = new Map<number, string>();
async function claim(id: number) {
  db.prepare("update jobs set engine = ?, not_before = 0 where id = ?").run(`ledger-${id}`, id);
  const chat = (db.prepare('select kind from jobs where id = ?').get(id) as { kind: string }).kind === 'chat';   // (the intercom's turns: its own slot)
  const r = await h.worker('claim', { seat: `seat-${id}`, engine: `ledger-${id}`, ...(chat ? { kind: 'chat' } : {}) });
  assert.equal(r.body?.id, id, `job #${id} is claimed`);
  tokens.set(id, r.body.token);
  return r.body.token as string;
}
// The worker reports the run claim() started as ended. A call's work follow-up ending done has set the board's reply
// (hq reply) first, unless the test gives reply: null.
async function finish(id: number, { reply = 'Done as we said on the call.', ...body }: Record<string, unknown> & { reply?: string | null }) {
  const follows = db.prepare("select 1 from calls c join jobs j on j.id = c.job where j.id = ? and j.kind = 'work' and c.processed_at is null and c.reply is null").get(id);
  if (follows && body.status === 'done' && reply != null) assert.equal((await agent('reply', tokens.get(id)!, { text: reply })).status, 200, `job #${id} sets its reply`);
  assert.equal((await h.worker('finish', { job: id, seat: `seat-${id}`, ...body })).status, 200, `job #${id} ends`);
}
// A call as the voice line has it: the context at the start (the row and its token), the transcript at the end. The
// agent's earlier calls not followed up yet ended a day ago, so the call doesn't carry on from them (call.ts carriedOn)
// unless the test says so.
async function aCall(who: string, lines: string[], request = 0, o: { carry?: boolean } = {}) {
  if (!o.carry) db.prepare("update calls set ts = ? where agent = ? and status = 'ended' and processed_at is null").run(new Date(Date.now() - 25 * hour).toISOString(), who);
  const ctx = await voice(`call-context?agent=${who}&request=${request}`);
  assert.equal(ctx.status, 200);
  const id = lastCall().id;
  return { id, token: ctx.body.token as string, prompt: ctx.body.prompt as string, end: () => voice('call-end', { agent: who, lines, request, token: ctx.body.token }) };
}
const TALK = ['Board: Kit, build the coming-soon page with the second headline.', 'Kit: Will do, and I will send Juno the mission note.', 'Board: Thanks.'];
const quote = (text: string) => ({ quote: text });
// The board on the intercom, and the intercom as HQ shows it.
const say = async (text: string) => assert.equal((await h.board('/api/chat', { text })).status, 200);
const history = async () => (await h.board('/api/chat')).body;
// Earlier tests' intercom out of the way: its turns stopped and its lines heard.
const quietIntercom = () => db.exec("update jobs set status = 'cancelled' where kind = 'chat'; update chat set sent = 1");
const hour = 3600_000;

test('a call has its row from its start, a promise made on it lands there, and its follow-up carries the call', async () => {
  const c = await aCall('kit', TALK);
  assert.equal(callRow(c.id).status, 'live');
  // the voice line's promise tool: the call's own token, only a promise, only on its own call
  const p = await agent('item', c.token, { kind: 'promise', owner: 'kit', what: 'Send Juno the mission note', quote: TALK[1] });
  assert.equal(p.status, 200);
  assert.equal(item(p.body.id).call, c.id);
  assert.equal((await agent('item', c.token, { kind: 'task', owner: 'kit', what: 'x', quote: 'y' })).status, 403);
  for (const route of [`items?call=${c.id}`, 'items']) assert.equal((await agent(route, c.token)).status, 403, `no items for a call token: ${route}`);
  // (hq call on a call reads earlier calls as its agent does, memory.ts: never a call still live, which has no transcript yet)
  assert.equal((await agent(`call?id=${c.id}`, c.token)).status, 404, 'no transcript for a call token');
  assert.equal((await c.end()).status, 200);
  const row = callRow(c.id);
  assert.deepEqual([row.status, JSON.parse(row.lines), row.attempts], ['ended', TALK, 1]);
  const f = job(row.job);
  assert.deepEqual([f.agent, f.kind, f.call, f.status], ['kit', 'work', c.id, 'queued']);
  assert.match(f.prompt, new RegExp(`This is call #${c.id}`));
  assert.match(f.prompt, /\[1\] Board: Kit, build the coming-soon page[\s\S]*\[3\] Board: Thanks\./, 'the transcript, numbered for the items\' lines');
  assert.match(f.prompt, /hq item add <kind> <owner>/);
});

test("Juno's call gets a work follow-up too; the reply it sets appears in the intercom and rides along with the next turn, its report doesn't", async () => {
  quietIntercom();
  const chats = () => (db.prepare("select count(*) n from jobs where kind = 'chat'").get() as any).n, before = chats();
  const c = await aCall('juno', ['Board: How is the day going?', 'Juno: Busy but good.']);
  await c.end();
  const f = job(callRow(c.id).job);
  assert.deepEqual([f.agent, f.kind, f.call], ['juno', 'work', c.id]);
  assert.match(f.prompt, /hq reply/);
  assert.equal((await history()).thinking, 'notes', 'HQ shows the notes are coming while the follow-up works');
  const t = await claim(f.id);
  const it = await agent('item', t, { kind: 'question', owner: 'juno', what: 'How the day is going', lines: '1', ...quote('Board: How is the day going?') });
  assert.equal((await agent('item-link', t, { id: it.body.id, to: { ref: 'answered on the call' } })).body.status, 'handled');
  const tooLong = await agent('reply', t, { text: 'word '.repeat(121) });
  assert.equal(tooLong.status, 400, 'a reply past 120 words goes back to the agent to rewrite');
  const { id: other } = jobs.createJob({ agent: 'rivet', title: 'Unrelated', prompt: 'x' });
  assert.equal((await agent('reply', await claim(other), { text: 'Hello' })).status, 403, "only a call's follow-up sets a reply");
  assert.equal((await agent('reply', t, { text: 'Busy but good. 🙂' })).status, 200);
  const REPORT = `Items: recorded #${it.body.id}. Commit and checks: gates reported 0 changed files.`;
  await finish(f.id, { status: 'done', result: REPORT });
  assert.ok(callRow(c.id).processed_at);
  assert.equal((await history()).thinking, false);
  const handed = jobs.createJob({ agent: 'juno', title: 'Work the call handed out', prompt: 'x', call: c.id });
  assert.equal((await history()).thinking, false, "work a call handed out isn't its notes");
  assert.ok(ledger.cancelJob(handed.id, 'not needed'));
  const shown = (await history()).messages.slice(-2) as { who: string; text: string }[];
  assert.deepEqual(shown.map(m => [m.who, m.text]), [['call', 'Call with Juno · about 1 min'], ['juno', 'Busy but good. 🙂']]);
  assert.equal((db.prepare('select count(*) n from chat where text like ?').get('%gates reported%') as { n: number }).n, 0, "the job's report never reaches the intercom");
  assert.equal(chats(), before, 'no intercom turn starts just for the notes');
  await say('And tomorrow?');
  const turn = db.prepare("select * from jobs where kind = 'chat' order by id desc limit 1").get() as Job;
  assert.match(turn.note ?? '', new RegExp(`follow-up job #${f.id}[\\s\\S]*Busy but good[\\s\\S]*And tomorrow\\?`), 'the next turn hears the reply, then the board');
});

test("another agent's call shows the reply its follow-up set in HQ's Calls", async () => {
  const c = await aCall('kit', TALK);
  await c.end();
  const f = job(callRow(c.id).job), t = await claim(f.id);
  assert.match(f.prompt, /hq reply/);
  const it = await agent('item', t, { kind: 'task', owner: 'kit', what: 'Build the coming-soon page', lines: '1', ...quote(TALK[0]) });
  assert.equal((await agent('item-link', t, { id: it.body.id, to: { ref: 'DECISIONS.md' } })).status, 200);
  assert.equal((await agent('reply', t, { text: 'The coming-soon page gets the second headline.' })).status, 200);
  await finish(f.id, { status: 'done', result: 'Records: item linked, gates passed.' });
  const shown = (await h.board('/api/calls')).body.find((x: any) => x.id === c.id);
  assert.equal(shown.reply, 'The coming-soon page gets the second headline.');
});

test('item routes: only for a job that works for the call, never for a worker or voice token', async () => {
  const c = await aCall('kit', TALK);
  await c.end();
  const f = callRow(c.id).job, t = await claim(f);
  const { id: other } = jobs.createJob({ agent: 'rivet', title: 'Unrelated', prompt: 'x' });
  const ot = await claim(other);
  const it = (await agent('item', t, { kind: 'task', owner: 'kit', what: 'Build the coming-soon page', lines: '1-2', ...quote(TALK[0]) })).body.id;
  assert.ok(it);
  for (const [route, body] of [[`items?call=${c.id}`], ['item-link', { id: it, to: { ref: 'x' } }], ['item-drop', { id: it, why: 'x' }]] as const)
    assert.equal((await agent(route, ot, body)).status, 404, `another call's job: ${route}`);
  // (it reads the call as any agent does since #1877, the board's calls being shared: not the numbered transcript a job
  // that works for it gets, and not its items)
  const shared = (await agent(`call?id=${c.id}&lines=1-2`, ot)).body;
  assert.deepEqual([shared.text, shared.lines], [undefined, TALK]);
  assert.equal((await agent('item', ot, { call: c.id, kind: 'task', owner: 'kit', what: 'x', quote: 'y' })).status, 403);
  assert.equal((await agent('item', ot, { kind: 'task', owner: 'kit', what: 'x', quote: 'y' })).status, 403, 'a job that follows up no call records nothing');
  for (const token of [WORKER_TOKEN, VOICE_TOKEN]) for (const [route, body] of [[`items?call=${c.id}`], [`call?id=${c.id}`], ['items'],
    ['item', { kind: 'promise', owner: 'kit', what: 'x', quote: 'y' }], ['item-link', { id: it, to: { ref: 'x' } }], ['item-drop', { id: it, why: 'x' }], ['cancel', { id: f }]] as const)
    assert.equal((await agent(route, token, body)).status, 401, `${token}: ${route}`);
  // the call's own job: the items in full, the transcript numbered, a range
  assert.equal((await agent(`items?call=${c.id}`, t)).body[0].quote, TALK[0]);
  assert.equal((await agent(`call?id=${c.id}&lines=2-3`, t)).body.text, `[2] ${TALK[1]}\n[3] ${TALK[2]}`);
  assert.deepEqual((await agent(`call?id=${c.id}&lines=3-9`, t)).body, { error: 'lines must be a-b within 1-3' });
  // refusals say why, and nothing is cut to fit
  for (const [body, error] of [
    [{ kind: 'wish', what: 'x' }, 'kind must be one of task, decision, briefing, promise, question'],
    [{ kind: 'task', what: 'Two\nlines' }, `"what" must be one plain line of at most 200 characters: it's what the board reads`],
    [{ kind: 'task', what: 'w'.repeat(201) }, `"what" must be one plain line of at most 200 characters: it's what the board reads`],
    [{ kind: 'task', what: 'x', quote: ' ' }, 'an item needs the words from the call, verbatim (the quote file)'],
    [{ kind: 'task', what: 'x', lines: '2-9' }, 'lines must be a-b within 1-3'],
  ] as const) assert.deepEqual((await agent('item', t, { owner: 'kit', quote: 'q', ...body })).body, { error }, error);
  assert.equal((await agent('item', t, { kind: 'task', owner: 'board', what: 'x', quote: 'y' })).status, 400, 'nothing is owned by the board');
  // the open list (no words from any call) is anyone's
  const open = (await agent('items', ot)).body as any[];
  assert.ok(open.some(i => i.id === it && i.what === 'Build the coming-soon page'));
  assert.ok(open.every(i => !('quote' in i) && !('lines' in i)));
});

// org.yaml's roles.asks: its job reads any call's items, links and hands them out, and drops or replaces
// none; not a customer or credential call's. Left out, it's refused like any other job.
test("roles.asks links and hands out an item of a call it doesn't follow up, drops none, and opens no customer or credential call", async () => {
  const orgPath = `${h.repo}/company/org.yaml`, orgContent = readFileSync(orgPath, 'utf8');
  const ordinaryCall = await aCall('kit', TALK);
  await ordinaryCall.end();
  const followUpToken = await claim(callRow(ordinaryCall.id).job);
  const add = async (token: string, what: string) => (await agent('item', token, { kind: 'task', owner: 'kit', what, lines: '1', ...quote(TALK[0]) })).body.id as number;
  const [pageItemId, headlineItemId] = [await add(followUpToken, 'Build the coming-soon page'), await add(followUpToken, 'Use the second headline')];
  const customerCard = jobs.createRequest({ kind: 'decision', title: 'Refund case C-32?', body: 'Jan Jansen, cracked mug', agent: 'kit', customers: true }) as { id: number };
  const customerCall = await aCall('kit', ['Board: refund Jan Jansen in full.'], customerCard.id);
  await customerCall.end();
  const customerItemId = await add(await claim(callRow(customerCall.id).job), 'Refund the mug');
  const credentialCard = jobs.createRequest({ kind: 'credential', title: 'Test integration', body: 'Configure the test integration.', agent: 'wren', secrets: 'LEDGER_TEST_KEY' }) as { id: number };
  const credentialCall = await aCall('wren', ['Board: Verify the test integration.'], credentialCard.id);
  await credentialCall.end();
  const credentialItem = await agent('item', await claim(callRow(credentialCall.id).job), { kind: 'task', owner: 'wren', what: 'Verify the integration', quote: 'Board: Verify the test integration.' });
  assert.equal(credentialItem.status, 200);
  const { id: pageJobId } = jobs.createJob({ agent: 'kit', title: 'Coming-soon page', prompt: 'x', queuedBy: 'kit' });
  const { id: keeperJobId } = jobs.createJob({ agent: 'wren', title: 'Open asks', prompt: 'x' });
  const { id: unrelatedJobId } = jobs.createJob({ agent: 'moss', title: 'Unrelated', prompt: 'x' });
  const [keeperToken, unrelatedToken] = [await claim(keeperJobId), await claim(unrelatedJobId)];
  const link = (token: string, id: number) => agent('item-link', token, { id, to: { job: pageJobId } });
  assert.equal((await link(keeperToken, pageItemId)).status, 404, 'left out: nobody else links it');
  writeFileSync(orgPath, orgContent.replace(/^roles:\n/m, 'roles:\n  asks: wren\n'));
  try {
    assert.equal((await agent(`items?call=${ordinaryCall.id}`, keeperToken)).body[0].quote, TALK[0]);
    assert.equal((await link(keeperToken, pageItemId)).status, 200);
    assert.deepEqual([item(pageItemId).job, job(pageJobId).item], [pageJobId, null], "a colleague's job is the evidence; it carries nothing new");
    const handed = await agent('job', keeperToken, { agent: 'kit', title: 'Second headline', prompt: 'Swap it in.', item: headlineItemId });
    assert.equal(handed.status, 200);
    assert.deepEqual([item(headlineItemId).job, job(handed.body.id).item, job(handed.body.id).call], [handed.body.id, headlineItemId, ordinaryCall.id]);
    assert.match(job(handed.body.id).prompt, /Board: Kit, build the coming-soon page/);
    assert.equal((await agent('item-drop', keeperToken, { id: pageItemId, why: 'x' })).status, 403, "dropping is the follow-up's");
    assert.equal((await agent('item', keeperToken, { call: ordinaryCall.id, replaces: pageItemId, what: 'x', quote: 'y' })).status, 403, 'so is replacing');
    assert.equal(item(pageItemId).status, 'open');
    for (const [callId, itemId] of [[customerCall.id, customerItemId], [credentialCall.id, credentialItem.body.id]]) {
      assert.equal((await agent(`items?call=${callId}`, keeperToken)).status, 404, 'a restricted call stays with its jobs');
      assert.equal((await link(keeperToken, itemId)).status, 404);
      assert.equal((await agent('job', keeperToken, { agent: 'kit', title: 'Follow up', prompt: 'x', item: itemId })).status, 409);
    }
    assert.ok(!jobs.holdsKeys(keeperJobId));
    assert.ok(!jobs.holdsCustomerData(keeperJobId));
    assert.equal((await link(unrelatedToken, pageItemId)).status, 404, "another agent's job still isn't");
  } finally {
    writeFileSync(orgPath, orgContent);
  }
});

test('a job handed an item carries the words and closes it when done; failed leaves it open; one open job per item', async () => {
  const c = await aCall('kit', TALK);
  await c.end();
  const f = callRow(c.id).job, t = await claim(f);
  const a = (await agent('item', t, { kind: 'briefing', owner: 'kit', what: 'Build the coming-soon page', lines: '1', ...quote(TALK[0]) })).body.id;
  const b = (await agent('item', t, { kind: 'promise', owner: 'juno', what: 'Send Juno the mission note', lines: '2', ...quote(TALK[1]) })).body.id;
  const ja = await agent('job', t, { agent: 'kit', title: 'Coming-soon page', prompt: 'Build it with the second headline.', item: a });
  assert.equal(ja.status, 200);
  const built = job(ja.body.id);
  assert.deepEqual([built.call, built.item, item(a).job], [c.id, a, ja.body.id]);
  assert.match(built.prompt, /Build it with the second headline\.\n\nThe words on the call this job comes from \(item #\d+, call #\d+, lines 1[^]*\n\nBoard: Kit, build the coming-soon page with the second headline\.\n\n\(Assigned by kit\.\)/);
  const twice = await agent('job', t, { agent: 'kit', title: 'Again', prompt: 'x', item: a });
  assert.deepEqual([twice.status, twice.body.error], [409, `item #${a} already has job #${ja.body.id} (queued): it isn't handed out twice (to go through it, hq item link ${a} job:${ja.body.id})`]);
  const jb = (await agent('job', t, { agent: 'juno', title: 'Mission note', prompt: 'Send it', item: b })).body.id;
  await claim(ja.body.id); await finish(ja.body.id, { status: 'done', result: 'Built' });
  await claim(jb); await finish(jb, { status: 'failed', result: 'usage limit' });
  assert.deepEqual([item(a).status, item(b).status], ['handled', 'open']);
  const again = await agent('job', t, { agent: 'juno', title: 'Mission note, again', prompt: 'Send it', item: b });
  assert.equal(again.status, 200, 'a failed job leaves its item open, to hand out again');
  await finish(f, { status: 'done', result: 'Notes' });
  assert.ok(callRow(c.id).processed_at, 'done with items: the call is followed up');
});

test("a call about a request reaches the job that asked, parked: it's the call's follow-up", async () => {
  const { id: asker } = jobs.createJob({ agent: 'kit', title: 'Coming-soon page', prompt: 'Build it; ask the board.' });
  await claim(asker);
  await finish(asker, { status: 'parked', request: { kind: 'decision', title: 'Which headline?', body: 'First or second?' } });
  const r = (db.prepare('select id from requests order by id desc limit 1').get() as { id: number }).id;
  const c = await aCall('kit', TALK, r);
  await c.end();
  assert.equal(callRow(c.id).job, asker);
  assert.deepEqual([job(asker).status, job(asker).call], ['queued', c.id]);
  assert.match(job(asker).note ?? '', new RegExp(`your desk phone request #${r}[^]*This is call #${c.id}[^]*\\[1\\] Board: Kit, build`));
});

test("linking someone else's job records the evidence, but only the caller's own jobs carry the item (and stop with it)", async () => {
  const c = await aCall('kit', TALK);
  await c.end();
  const t = await claim(callRow(c.id).job);
  const it = (await agent('item', t, { kind: 'task', owner: 'bolt', what: 'Fix the phone line', ...quote(TALK[0]) })).body.id;
  const { id: bolts } = jobs.createJob({ agent: 'bolt', title: 'Bolt: phone line', prompt: 'x', queuedBy: 'bolt' });
  const { id: kits } = jobs.createJob({ agent: 'rivet', title: 'Kit queued it', prompt: 'x', queuedBy: 'kit' });
  assert.equal((await agent('item-link', t, { id: it, to: { job: bolts } })).body.status, 'open');
  assert.deepEqual([item(it).job, job(bolts).item], [bolts, null], "Bolt's job is the evidence, and nothing more");
  const mine = (await agent('item', t, { kind: 'task', owner: 'rivet', what: 'Check the logs', ...quote(TALK[0]) })).body.id;
  await agent('item-link', t, { id: mine, to: { job: kits } });
  assert.deepEqual([job(kits).item, job(kits).call], [mine, c.id]);
  await agent('item-drop', t, { id: it, why: 'Not needed' });
  await agent('item-drop', t, { id: mine, why: 'Not needed' });
  assert.deepEqual([job(bolts).status, job(kits).status], ['queued', 'cancelled']);
});

// A job linked to an item of a call about a customer card reads that call (hq items, hq call), so it holds their details:
// marked when it's linked, and when it reads the items.
test("a job linked to a customer call's item, and one reading its items, holds the customer's details: no guest checklists", async () => {
  const guests = await import('./guests.ts');
  const card = jobs.createRequest({ kind: 'decision', title: 'Refund case C-31?', body: 'Jan Jansen, cracked mug', agent: 'kit', customers: true }) as { id: number };
  const c = await aCall('kit', ['Board: refund Jan Jansen in full.'], card.id);
  await c.end();
  const t = await claim(callRow(c.id).job);
  const it = (await agent('item', t, { kind: 'task', owner: 'rivet', what: 'Refund the mug', quote: 'Board: refund Jan Jansen in full.' })).body.id;
  const { id: linked } = jobs.createJob({ agent: 'rivet', title: 'Refunds', prompt: 'x', queuedBy: 'kit' });
  assert.ok(!jobs.holdsCustomerData(linked));
  assert.equal((await agent('item-link', t, { id: it, to: { job: linked } })).status, 200);
  assert.ok(jobs.holdsCustomerData(linked), 'linked: it reads the call from now on');
  db.prepare('update jobs set customers = 0 where id = ?').run(linked);   // (as if linked before this rule)
  const lt = await claim(linked);
  assert.match((await agent(`items?call=${c.id}`, lt)).body[0].quote, /Jan Jansen/);
  assert.ok(jobs.holdsCustomerData(linked), 'read: it holds them');
  assert.equal((guests.write({ id: linked, agent: 'rivet' } as any, 'Sam', 'Your refund', {}) as unknown[])[0], 403);   // (its result's type includes the files)
});

// A job refused its deliverable (it holds a customer's details) doesn't handle its item by ending done: the item stays open
// and the board hears it, unless the job handed it on, as the refusal asks: then that job's ending done is the evidence.
test('a job refused the draft its item promised ends done: the item stays open and the board hears it, unless a job carries it on', async () => {
  const c = await aCall('kit', TALK);
  await c.end();
  const t = await claim(callRow(c.id).job);
  const add = async (what: string) => (await agent('item', t, { kind: 'promise', owner: 'juno', what, ...quote(TALK[1]) })).body.id as number;
  const kept = await add('Draft the reply to the printer'), passed = await add('Draft the note to the courier'), fine = await add('Draft the thanks');
  const handOut = async (it: number) => (await agent('job', t, { agent: 'juno', title: `Item ${it}`, prompt: 'Draft it', item: it })).body.id as number;
  const [a, b, d] = [await handOut(kept), await handOut(passed), await handOut(fine)];
  const mail = { to: ['ops@printer.example'], subject: 'Your test order', why: 'Our reply', text: 'Dear Anna,' };
  const events = () => (db.prepare("select text from events where type = 'log' and text like 'Call with Kit on %'").all() as { text: string }[]).map(e => e.text);
  const before = events().length;

  // refused its draft for good, nothing carries it on: open, and the board hears it in a line without the item's words
  const ta = await claim(a);
  jobs.handedCustomerData(a);
  const refused = await agent('outbox', ta, mail);
  assert.equal(refused.status, 403);
  await finish(a, { status: 'done', result: 'Could not file it' });
  assert.equal(item(kept).status, 'open');
  assert.equal(events().length, before + 1);
  assert.match(events().at(-1)!, /^Call with Kit on .*Juno .*HQ refused an email draft/);
  assert.doesNotMatch(events().at(-1)!, /printer/);
  assert.equal((await agent('job', t, { agent: 'kit', title: 'Again', prompt: 'Draft it', item: kept })).status, 200, 'handed out again');

  // refused, then handed on to a job that carries the item: that job's ending done handles it
  const tb = await claim(b);
  jobs.handedCustomerData(b);
  assert.equal((await agent('outbox', tb, mail)).status, 403);
  const next = (await agent('job', tb, { agent: 'kit', title: 'File the draft', prompt: 'Only what the email may say' })).body.id as number;
  assert.equal(job(next).item, passed);
  await finish(b, { status: 'done', result: 'Handed on' });
  assert.deepEqual([item(passed).status, item(passed).job, events().length], ['open', next, before + 1]);
  const tn = await claim(next);
  assert.equal((await agent('outbox', tn, mail)).status, 200);
  await finish(next, { status: 'done', result: 'Filed' });
  assert.equal(item(passed).status, 'handled');

  // a job never refused: handled as before; a 400 (a typo to fix) isn't a refusal
  const td = await claim(d);
  assert.equal((await agent('outbox', td, { ...mail, to: ['not an address'] })).status, 400);
  await finish(d, { status: 'done', result: 'Filed' });
  assert.equal(item(fine).status, 'handled');
});

test("a job the coordinator made (a PR's fix job) is only evidence, even the caller's own: dropping the item leaves it queued", async () => {
  const c = await aCall('kit', TALK);
  await c.end();
  const t = await claim(callRow(c.id).job);
  const it = (await agent('item', t, { kind: 'task', owner: 'kit', what: 'Fix the page', ...quote(TALK[0]) })).body.id;
  const fix = jobs.createJob({ agent: 'kit', title: 'Update PR #9', prompt: 'x' }).id;   // queued_by null
  assert.equal((await agent('item-link', t, { id: it, to: { job: fix } })).body.status, 'open');
  assert.deepEqual([item(it).job, job(fix).item, job(fix).call], [fix, null, null], "Kit's fix job is the evidence, and nothing more");
  assert.equal((await agent('item-drop', t, { id: it, why: 'Not needed' })).status, 200);
  assert.equal(job(fix).status, 'queued', 'dropping the item never cancels it (hq cancel would refuse it too)');
});

test('the sweep: a follow-up done with nothing recorded is sent again; after three, an alert and nothing more', async () => {
  const c = await aCall('kit', TALK);
  await c.end();
  const first = callRow(c.id).job;
  await claim(first); await finish(first, { status: 'done', result: 'All good' });
  assert.equal(callRow(c.id).processed_at, null, 'done without items is not followed up');
  const now = Date.now();
  ledger.sweep(now);
  assert.equal(callRow(c.id).job, first, 'not within 10 minutes of the call');
  ledger.sweep(now + 11 * 60_000);
  const second = job(callRow(c.id).job);
  assert.notEqual(second.id, first);
  assert.deepEqual([second.call, second.title, callRow(c.id).attempts], [c.id, 'Follow up on your call with the board (attempt 2)', 2]);
  assert.match(second.prompt, new RegExp(`previous attempt[^]*read \`hq items ${c.id}\` first`));
  ledger.sweep(now + 12 * 60_000);
  assert.equal(callRow(c.id).job, second.id, 'one follow-up at a time');
  await claim(second.id); await finish(second.id, { status: 'failed' });
  ledger.sweep(now + 13 * 60_000);
  const third = callRow(c.id).job;
  await claim(third); await finish(third, { status: 'failed' });
  const events = () => db.prepare("select text from events where type = 'log' and text like 'Call with Kit at %'").all() as { text: string }[];
  ledger.sweep(now + 14 * 60_000);
  assert.equal(callRow(c.id).job, third, 'no fourth attempt');
  assert.equal(callRow(c.id).status, 'failed');
  assert.equal(events().length, 1);
  assert.match(events()[0].text, /^Call with Kit at \d\d:\d\d: its follow-up failed 3 times, so it stopped trying\./);
  ledger.sweep(now + 20 * 60_000);
  assert.equal(events().length, 1, 'said once');
});

test('the sweep: a call that lost its line keeps what was recorded on it, and a silent one goes', async () => {
  const kept = await aCall('kit', []), gone = await aCall('dex', []);
  await agent('item', kept.token, { kind: 'promise', owner: 'kit', what: 'Send Juno the mission note', quote: 'I will send it' });
  ledger.sweep(Date.now() + 3 * hour + 60_000);
  assert.equal(callRow(gone.id), undefined);
  const row = callRow(kept.id);
  assert.equal(row.status, 'ended');
  assert.match(job(row.job).prompt, /the line dropped before the call was handed over/);
});

test('/api/calls shows each item as one plain line and where it stands, never a quote or a transcript line', async () => {
  const text = await (await fetch(`${h.base}/api/calls`, { headers: { cookie: h.boardCookie } })).text(), calls = JSON.parse(text) as any[];
  const withItems = calls.find(c => c.items.some((i: any) => i.what === 'Build the coming-soon page' && i.status === 'handled'))!;
  assert.ok(withItems.items.some((i: any) => i.what === 'Build the coming-soon page' && i.status === 'handled' && i.owner === 'kit'));
  assert.equal(withItems.handled, withItems.items.filter((i: any) => i.status === 'handled').length);
  for (const line of [...TALK, 'Board: How is the day going?']) assert.ok(!text.includes(line), `not on the board's API: ${line}`);
  assert.ok(calls.every(c => !('lines' in c) && c.items.every((i: any) => !('quote' in i) && !('lines' in i))));
});

test('a correction on a later call replaces the earlier item: its queued jobs are cancelled, a running one hears it, and it queues nothing more', async () => {
  const first = await aCall('moss', ['Board: Make versions A2 and D of the brand film.']);
  await first.end();
  const f1 = callRow(first.id).job, t1 = await claim(f1);
  const x = (await agent('item', t1, { kind: 'task', owner: 'moss', what: 'Brand films A2 and D', lines: '1', quote: 'Board: Make versions A2 and D of the brand film.' })).body.id;
  const other = (await agent('item', t1, { kind: 'task', owner: 'moss', what: 'Stills', quote: 'Board: and stills.' })).body.id;
  const building = (await agent('job', t1, { agent: 'moss', title: 'Build A2 and D', prompt: 'Both films', item: x })).body.id;
  await finish(f1, { status: 'done', result: 'Queued the films' });
  const bt = await claim(building);
  db.prepare("update jobs set engine = 'claude' where id = ?").run(building);   // (claim()'s engine of its own: a Claude job has the hook)
  // the running job queues its own follow-on: it carries the item on
  const film = (await agent('job', bt, { agent: 'moss', title: 'Send the A2/D film to the board', prompt: 'x' })).body.id;
  assert.equal(job(film).item, x);
  const { id: mine } = jobs.createJob({ agent: 'moss', title: 'Moss: something of my own', prompt: 'x', queuedBy: 'moss' });
  // moss runs another Claude job, a later one: hq say would pick that one, the correction is for the job on the item
  const { id: elsewhere } = jobs.createJob({ agent: 'moss', title: 'Moss: the shop banner', prompt: 'x', queuedBy: 'moss' });
  await claim(elsewhere);
  db.prepare("update jobs set engine = 'claude' where id = ?").run(elsewhere);

  const second = await aCall('moss', ['Board: Forget A2, just D.']);
  await second.end();
  const f2 = callRow(second.id).job, t2 = await claim(f2);
  assert.match(job(f2).prompt, new RegExp(`Still open from earlier calls[^]*#${x} \\(call #${first.id}, moss\\): Brand films A2 and D`), 'the follow-up sees what it may replace');
  const y = await agent('item', t2, { kind: 'decision', owner: 'moss', what: 'Only film D, no A2', lines: '1', quote: 'Board: Forget A2, just D.', replaces: x });
  const told = db.prepare('select * from messages where job = ?').all(building) as any[];
  assert.equal(told.length, 1, 'the running job gets the correction as a message');
  assert.equal(db.prepare('select count(*) n from messages where job = ?').get(elsewhere)!.n, 0, 'not another job of its agent');
  assert.deepEqual(y.body, { id: y.body.id, call: second.id, kind: 'decision', owner: 'moss', replaced: x, replacedWhat: 'Brand films A2 and D', was: 'open', cancelled: [film], told: [{ job: building, message: told[0].id }], running: [] });
  assert.deepEqual([item(x).status, item(x).why], ['replaced', `changed on a later call (#${second.id}, item #${y.body.id})`]);
  assert.deepEqual([job(film).status, job(building).status], ['cancelled', 'running'], 'what never ran stops; what runs, runs its course');
  // ...and hears it at its next step (#934's hook): which item changed, on which call, the new line, what to do
  const inbox = await agent('inbox', bt, {});
  assert.deepEqual(inbox.body.map((m: any) => [m.message, m.from, m.from_job]), [[told[0].id, 'moss', f2]]);
  assert.match(inbox.body[0].text, new RegExp(`item #${x} \\(call #${first.id}\\) was replaced on call #${second.id} by item #${y.body.id}: "Only film D, no A2"`));
  assert.deepEqual((await agent('inbox-ack', bt, { ids: [told[0].id] })).body, { delivered: [told[0].id] });
  assert.equal((await agent(`items?call=${first.id}`, bt)).body.find((i: any) => i.id === x).status, 'replaced', 'hq items shows it to that job');
  const refused = await agent('job', bt, { agent: 'moss', title: 'Send the A2 film after all', prompt: 'x' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, new RegExp(`item #${x} \\(call #${first.id}\\) was replaced: changed on a later call`));
  // nor does it hand out another item still open on the same call
  assert.equal((await agent('job', bt, { agent: 'moss', title: 'Stills', prompt: 'x', item: other })).status, 409);
  assert.equal(item(other).job, null);
  assert.deepEqual((await agent('item', t2, { kind: 'task', owner: 'moss', what: 'x', quote: 'y', replaces: x })).body, { error: `item #${x} isn't there to replace, or it's replaced already` });
  assert.equal((await agent('job', t2, { agent: 'moss', title: 'Film D only', prompt: 'D', item: y.body.id })).status, 200);
  // hq cancel: a queued job of your own (or one you queued) that never ran; nobody else's
  assert.equal((await agent('cancel', t2, { id: mine })).status, 200);
  assert.equal(job(mine).status, 'cancelled');
  const { id: theirs } = jobs.createJob({ agent: 'kit', title: 'Kit: not Moss\'s', prompt: 'x', queuedBy: 'kit' });
  assert.equal((await agent('cancel', t2, { id: theirs })).status, 404);
  assert.equal(job(theirs).status, 'queued');
  // a later drop of the new item reaches its jobs the same way
  assert.equal((await agent('item-drop', t2, { id: y.body.id, why: 'The board wants no film now' })).status, 200);
  assert.equal(item(y.body.id).status, 'dropped');
});

test("a lead's item stays handled only if the colleague's PR it queued the work in merges: closed unmerged, it's open again", async () => {
  const c = await aCall('bolt', ['Board: Bolt, make the pin wiggle.']);
  await c.end();
  const t = await claim(callRow(c.id).job);
  const x = (await agent('item', t, { kind: 'task', owner: 'bolt', what: 'The pin wiggles', quote: 'Board: Bolt, make the pin wiggle.' })).body.id;
  const lead = (await agent('job', t, { agent: 'bolt', title: 'Pin', prompt: 'x', item: x })).body.id;
  const child = (await agent('job', await claim(lead), { agent: 'lark', title: 'Make the pin wiggle', prompt: 'x' })).body.id;
  await finish(lead, { status: 'done', result: 'Queued it for Lark' });
  assert.deepEqual([item(x).status, item(x).job, job(child).item], ['handled', lead, x], 'the lead handled it; the colleague carries it');
  await claim(child); await finish(child, { status: 'done', result: 'Made it', branch: `job/${child}` });
  assert.deepEqual(ledger.asked(`job/${child}`).map(i => i.id), [x], "the colleague's PR is reviewed against the item");
  assert.equal(ledger.reopen(`job/${child}`), 1);   // review.ts close(): the PR closed unmerged
  assert.deepEqual([item(x).status, item(x).closed_at], ['open', null]);
  assert.equal(ledger.reopen(`job/${lead}`), 0, 'an open item stays as it is');
});

test("an item whose work merged stays handled when a helper's PR, or a stale sibling's, closes unmerged", async () => {
  const c = await aCall('bolt', ['Board: Bolt, make the pin boing.']);
  await c.end();
  const t = await claim(callRow(c.id).job);
  const x = (await agent('item', t, { kind: 'task', owner: 'bolt', what: 'The pin boings', quote: 'Board: Bolt, make the pin boing.' })).body.id;
  const lead = (await agent('job', t, { agent: 'bolt', title: 'Pin', prompt: 'x', item: x })).body.id;
  const helper = (await agent('job', await claim(lead), { agent: 'lark', title: 'A sound for the boing', prompt: 'x' })).body.id;
  await finish(lead, { status: 'done', result: 'Made it', branch: `job/${lead}` });
  await claim(helper); await finish(helper, { status: 'done', result: 'A sound', branch: `job/${helper}` });
  const pr = (n: number, branch: string, status: string) => db.prepare('insert into prs (number, branch, author, status) values (?, ?, ?, ?)').run(n, branch, 'bolt', status);
  pr(9101, `job/${lead}`, 'merged');
  pr(9102, `job/${helper}`, 'closed');
  assert.equal(ledger.reopen(`job/${helper}`), 0, "the lead's own PR merged: the helper's closing leaves the item handled");
  assert.equal(item(x).status, 'handled');
  // Handed out again after an earlier PR closed: the new job's PR merges, then a stale sibling's closes.
  const y = (await agent('item', t, { kind: 'task', owner: 'bolt', what: 'The pin glows', quote: 'Board: Bolt, make the pin boing.' })).body.id;
  const first = (await agent('job', t, { agent: 'bolt', title: 'Glow', prompt: 'x', item: y })).body.id;
  const sibling = (await agent('job', await claim(first), { agent: 'lark', title: 'Glow colours', prompt: 'x' })).body.id;
  await finish(first, { status: 'done', result: 'Glows', branch: `job/${first}` });
  pr(9103, `job/${first}`, 'closed');
  assert.equal(ledger.reopen(`job/${first}`), 1);
  const again = (await agent('job', t, { agent: 'bolt', title: 'Glow, again', prompt: 'x', item: y })).body.id;
  await claim(again); await finish(again, { status: 'done', result: 'Glows', branch: `job/${again}` });
  assert.equal(item(y).status, 'handled', "the first hand-out's closed PR reopened it already: it doesn't hold off the new job's finish");
  pr(9104, `job/${again}`, 'merged');
  await claim(sibling); await finish(sibling, { status: 'done', result: 'Colours', branch: `job/${sibling}` });
  pr(9105, `job/${sibling}`, 'closed');
  assert.deepEqual([ledger.reopen(`job/${sibling}`), item(y).status], [0, 'handled'], "the re-handed job's PR merged: the stale sibling's closing leaves it handled");
});

test("a ref or request doesn't handle the board's ask: it's the linking job's work, judged in its review; a question is answered now", async () => {
  const c = await aCall('bolt', ['Board: Bolt, rename the projects.', 'Board: Is the pin done?', 'Bolt: Yes.', 'Board: Make it spin.']);
  await c.end();
  const f = callRow(c.id).job, t = await claim(f);
  const add = async (kind: string, what: string) => (await agent('item', t, { kind, owner: 'bolt', what, quote: what })).body.id as number;
  const [rename, card, q, spin] = [await add('task', 'Rename the projects'), await add('promise', 'A card once renamed'), await add('question', 'Is the pin done'), await add('task', 'The pin spins')];
  const request = Number(db.prepare("insert into requests (agent, kind, urgency, title, body, status, created) values ('bolt', 'decision', 'normal', 'x', 'x', 'open', ?)").run(new Date().toISOString()).lastInsertRowid);
  assert.deepEqual((await agent('item-link', t, { id: rename, to: { ref: 'the rename can wait: a note' } })).body.status, 'open');
  assert.deepEqual((await agent('item-link', t, { id: card, to: { request } })).body.status, 'open');
  assert.equal((await agent('item-link', t, { id: q, to: { ref: 'answered on the call' } })).body.status, 'handled');
  assert.deepEqual([item(rename).job, item(rename).ref, item(card).job, item(card).request, item(q).job], [f, 'the rename can wait: a note', f, request, null]);
  const spinner = (await agent('job', t, { agent: 'lark', title: 'Spin', prompt: 'x', item: spin })).body.id;
  const early = await agent('item-link', t, { id: spin, to: { ref: 'spinning' } });
  assert.deepEqual([early.status, item(spin).status, item(spin).job], [400, 'open', spinner]);
  db.prepare("insert into prs (number, branch, author, status) values (9131, ?, 'bolt', 'open')").run(`job/${f}`);   // (jobs.ts startReview(), before finished())
  await finish(f, { status: 'done', result: 'Followed up', branch: `job/${f}` });
  assert.deepEqual([item(rename).status, item(card).status, item(spin).status], ['handled', 'handled', 'open'], 'handled once the linking job ends done with its PR');
  assert.deepEqual(ledger.asked(`job/${f}`).map(i => i.id), [rename, card], "the follow-up's PR is reviewed against them");
  const message = ledger.reached(c.id, { owner: 'bolt', what: 'Keep the pin blue', words: 'Keep the pin blue', job: f, ref: 'passed on during the call' });
  db.prepare("update prs set status = 'closed' where number = 9131").run();
  assert.deepEqual([ledger.reopen(`job/${f}`), item(rename).status, item(card).status, item(q).status, item(message).status], [2, 'open', 'open', 'handled', 'handled'], 'its work never landed; answered questions and delivered messages stay handled');
  assert.equal(ledger.openItems().some(i => i.id === message), false);
});

test('a ref-linked ask stays open when its linking job ends done without a pull request: nothing reviewed it', async () => {
  const c = await aCall('bolt', ['Board: Bolt, rename the threads.']);
  await c.end();
  const f = callRow(c.id).job, t = await claim(f);
  const rename = (await agent('item', t, { kind: 'task', owner: 'bolt', what: 'Rename the threads', quote: 'Board: Bolt, rename the threads.' })).body.id;
  assert.equal((await agent('item-link', t, { id: rename, to: { ref: 'renamed by hand' } })).body.status, 'open');
  await finish(f, { status: 'done', result: 'Renamed' });
  assert.deepEqual([item(rename).status, item(rename).job], ['open', f], 'open, and the board sees it so');
  // handed out again, the new job is its work: the earlier ref no longer holds it to a PR
  const again = jobs.createJob({ agent: 'bolt', title: 'Rename', prompt: 'x', call: c.id, queuedBy: 'bolt' }).id;
  ledger.handedOut(rename, again, null);
  assert.deepEqual([item(rename).job, item(rename).ref], [again, null]);
});

test("a helper's PR closing while the lead's is still open leaves the item handled; the last PR to close reopens it", async () => {
  const c = await aCall('bolt', ['Board: Bolt, make the pin hum.']);
  await c.end();
  const t = await claim(callRow(c.id).job);
  const x = (await agent('item', t, { kind: 'task', owner: 'bolt', what: 'The pin hums', quote: 'Board: Bolt, make the pin hum.' })).body.id;
  const lead = (await agent('job', t, { agent: 'bolt', title: 'Pin', prompt: 'x', item: x })).body.id;
  const helper = (await agent('job', await claim(lead), { agent: 'lark', title: 'A hum', prompt: 'x' })).body.id;
  await finish(lead, { status: 'done', result: 'Made it', branch: `job/${lead}` });
  await claim(helper); await finish(helper, { status: 'done', result: 'A hum', branch: `job/${helper}` });
  const pr = (n: number, branch: string, status: string) => db.prepare('insert into prs (number, branch, author, status) values (?, ?, ?, ?)').run(n, branch, 'bolt', status);
  pr(9111, `job/${lead}`, 'open');
  pr(9112, `job/${helper}`, 'closed');
  assert.deepEqual([ledger.reopen(`job/${helper}`), item(x).status], [0, 'handled'], "the lead's PR is still in review: it may merge yet");
  db.prepare("update prs set status = 'closed' where number = 9111").run();
  assert.deepEqual([ledger.reopen(`job/${lead}`), item(x).status], [1, 'open'], 'nothing tied to the item merged or is pending');
});

test("a child's PR closing while the lead is still running leaves the item open when the lead ends done", async () => {
  const c = await aCall('bolt', ['Board: Bolt, make the pin blink.']);
  await c.end();
  const t = await claim(callRow(c.id).job);
  const x = (await agent('item', t, { kind: 'task', owner: 'bolt', what: 'The pin blinks', quote: 'Board: Bolt, make the pin blink.' })).body.id;
  const lead = (await agent('job', t, { agent: 'bolt', title: 'Pin', prompt: 'x', item: x })).body.id;
  const child = (await agent('job', await claim(lead), { agent: 'lark', title: 'Make the pin blink', prompt: 'x' })).body.id;
  await claim(child); await finish(child, { status: 'done', result: 'Blinks', branch: `job/${child}` });
  const pr = (n: number, branch: string, status: string) => db.prepare('insert into prs (number, branch, author, status) values (?, ?, ?, ?)').run(n, branch, 'lark', status);
  pr(9121, `job/${child}`, 'closed');
  assert.equal(ledger.reopen(`job/${child}`), 0, 'nothing handled yet');
  await finish(lead, { status: 'done', result: 'Queued it for Lark' });
  assert.deepEqual([item(x).status, item(x).closed_at], ['open', null], "the child's work never landed");
  // Another PR tied to the item is open (a second child's) or merged: the lead's finish handles it.
  for (const status of ['open', 'merged']) {
    const y = (await agent('item', t, { kind: 'task', owner: 'bolt', what: `The pin blinks (${status})`, quote: 'Board: Bolt, make the pin blink.' })).body.id;
    const lead2 = (await agent('job', t, { agent: 'bolt', title: 'Pin', prompt: 'x', item: y })).body.id;
    const t2 = await claim(lead2);
    const [a, b] = [(await agent('job', t2, { agent: 'lark', title: 'Blink', prompt: 'x' })).body.id, (await agent('job', t2, { agent: 'lark', title: 'Blink again', prompt: 'x' })).body.id];
    await claim(a); await finish(a, { status: 'done', result: 'Blinks', branch: `job/${a}` });
    await claim(b); await finish(b, { status: 'done', result: 'Blinks', branch: `job/${b}` });
    pr(status === 'open' ? 9122 : 9124, `job/${a}`, 'closed');
    pr(status === 'open' ? 9123 : 9125, `job/${b}`, status);
    await finish(lead2, { status: 'done', result: 'Queued it for Lark' });
    assert.equal(item(y).status, 'handled', `the other PR is ${status}`);
  }
});

test('replacing an item that was handled: the jobs its done job queued are cancelled, a running one queues nothing more', async () => {
  const first = await aCall('moss', ['Board: Make the brand film, then send it round.']);
  await first.end();
  const t1 = await claim(callRow(first.id).job);
  const x = (await agent('item', t1, { kind: 'task', owner: 'moss', what: 'The brand film', quote: 'Board: Make the brand film.' })).body.id;
  const built = (await agent('job', t1, { agent: 'moss', title: 'Brand film', prompt: 'x', item: x })).body.id;
  const tb = await claim(built);
  const send = (await agent('job', tb, { agent: 'moss', title: 'Send the film round', prompt: 'x' })).body.id;
  const post = (await agent('job', tb, { agent: 'moss', title: 'Post about the film', prompt: 'x' })).body.id;
  await finish(built, { status: 'done', result: 'Made it' });
  assert.deepEqual([item(x).status, job(send).item, job(post).item], ['handled', x, x], 'handled, and its queued jobs carry it on');
  const tp = await claim(post);
  // a job handed out for an item isn't a call's follow-up: it replaces nothing
  const notMine = await agent('item', tp, { kind: 'task', owner: 'moss', what: 'x', quote: 'y', replaces: x });
  assert.deepEqual([notMine.status, notMine.body.error], [403, "only a call's follow-up replaces an earlier item"]);

  const second = await aCall('moss', ['Board: Change of plan: no film, a poster.']);
  await second.end();
  const t2 = await claim(callRow(second.id).job);
  const y = await agent('item', t2, { kind: 'decision', owner: 'moss', what: 'A poster, not the film', quote: 'Board: Change of plan: no film, a poster.', replaces: x });
  // the running one is on an engine without the hook (claim()'s own, as Codex): the correction is a job for moss now
  const m = db.prepare('select * from messages where job is null and became is not null order by id desc limit 1').get() as any;
  assert.deepEqual(y.body, { id: y.body.id, call: second.id, kind: 'decision', owner: 'moss', replaced: x, replacedWhat: 'The brand film', was: 'handled', cancelled: [send], told: [{ job: post, message: m.id, became: m.became }], running: [] });
  assert.deepEqual([job(m.became).agent, job(m.became).status], ['moss', 'queued']);
  assert.match(job(m.became).prompt, new RegExp(`^A correction to your job #${post}: item #${x} \\(call #${first.id}\\) was replaced on call #${second.id}`));
  assert.deepEqual([item(x).status, job(send).status, job(built).status], ['replaced', 'cancelled', 'done'], 'done work stays done');
  const more = await agent('job', tp, { agent: 'moss', title: 'Post it again', prompt: 'x' });
  assert.equal(more.status, 409);
  assert.match(more.body.error, /was replaced: changed on a later call/);
});

test('a job queued --after a cancelled job starts, and the feed says so; a job cut off mid-run is never "never ran"', async () => {
  const { id: a } = jobs.createJob({ agent: 'rivet', title: 'First this', prompt: 'x', queuedBy: 'rivet' });
  const { id: b } = jobs.createJob({ agent: 'rivet', title: 'Then this', prompt: 'x', after: a });
  assert.ok(ledger.cancelJob(a, 'not needed'));
  const said = db.prepare("select text from events where type = 'log' order by id desc limit 1").get() as { text: string };
  assert.match(said.text, new RegExp(`^Cancelled #${a}: not needed \\(#${b}, queued after it, starts now`));
  await claim(b);
  // requeued after a restart cut it off: it may have pushed a branch already
  const { id: c } = jobs.createJob({ agent: 'rivet', title: 'Half done', prompt: 'x', queuedBy: 'rivet' });
  await claim(c);
  await finish(c, { status: 'interrupted' });
  assert.equal(ledger.cancelJob(c, 'x'), false);
  assert.equal(job(c).status, 'queued');
});

test('a cancellation records its time', () => {
  const { id } = jobs.createJob({ agent: 'rivet', title: 'Dropped now', prompt: 'x', queuedBy: 'rivet' });
  const before = new Date().toISOString();
  assert.ok(ledger.cancelJob(id, 'not needed'));
  assert.ok(job(id).finished! >= before, 'cancelled now');
});

test('the CEO and Process cancel any job an agent queued that never ran; anyone else only their own or one they queued', async () => {
  const [moss, juno, bolt] = await Promise.all(['moss', 'juno', 'bolt'].map(a => h.start({ agent: a, title: `${a} cancelling` })));
  assert.deepEqual([ceo(), roles().process], ['juno', 'bolt'], "the fixture's CEO and Process");
  const ids = ['Cut one', 'Cut two'].map(title => jobs.createJob({ agent: 'rook', title, prompt: 'x', queuedBy: 'sable' }).id);
  const cancel = (token: string, id: number) => agent('cancel', token, { id, why: 'folded' });
  assert.equal((await cancel(moss.token, ids[0])).status, 404, 'not a colleague of theirs');
  assert.equal((await cancel(juno.token, ids[0])).status, 200, 'the CEO');
  assert.equal((await cancel(bolt.token, ids[1])).status, 200, 'Process');
  assert.deepEqual(ids.map(id => job(id).status), ['cancelled', 'cancelled']);
  assert.match((job(ids[0]) as any).result, /^Cancelled: by juno: folded/);
  // never one HQ made (no queued_by), nor one that ran
  const madeByHq = h.queue({ agent: 'rook', title: 'The board on: the shelf' });
  assert.equal((await cancel(juno.token, madeByHq)).status, 404);
  const started = await h.start({ agent: 'rook', title: 'Running already', queuedBy: 'sable' });
  assert.equal((await cancel(juno.token, started.id)).status, 404);
  assert.deepEqual([job(madeByHq).status, job(started.id).status], ['queued', 'running']);
  for (const j of [moss, juno, bolt, started]) await h.finish(j);
});

test('a job parked on a request that is closed ends cancelled and releases its --after chain; the intercom stays parked', async () => {
  const ask = { kind: 'decision', title: 'Which address?', body: 'x' };
  const { id: a } = jobs.createJob({ agent: 'rivet', title: 'Ask the board', prompt: 'x', queuedBy: 'rivet' });
  await claim(a);
  await finish(a, { status: 'parked', request: ask });
  const r = (job(a) as any).request as number;
  assert.equal(job(a).status, 'blocked');
  const { id: b } = jobs.createJob({ agent: 'rivet', title: 'Then this', prompt: 'x', after: a });
  // the CEO's intercom parked on a request of its own: the board's next line resumes it, so closing it doesn't end it
  const { id: c } = jobs.createJob({ agent: ceo(), kind: 'chat', title: 'Chat', prompt: 'x' });
  await claim(c);
  await finish(c, { status: 'parked', request: ask });
  const rc = (job(c) as any).request as number;
  // rivet closes it from another job (hq close): the parked job is cancelled, the feed says why and what it releases
  const { id: d } = jobs.createJob({ agent: 'rivet', title: 'Tidy up', prompt: 'x', queuedBy: 'rivet' });
  const closed = await agent('request-close', await claim(d), { id: r });
  assert.deepEqual(closed.body, { ok: true });
  assert.equal(job(a).status, 'cancelled');
  assert.equal((job(a) as any).result, `Cancelled: its request #${r} was closed by rivet`);
  const said = db.prepare("select agent, text from events where type = 'log' order by id desc limit 1").get() as { agent: string; text: string };
  assert.deepEqual({ ...said }, { agent: 'rivet', text: `Cancelled #${a}: its request #${r} was closed by rivet (#${b}, queued after it, starts now and checks main)` });
  await claim(b);
  assert.deepEqual((await agent('request-close', (await h.start({ agent: ceo() })).token, { id: rc })).body, { ok: true });
  assert.equal(job(c).status, 'blocked');
});

test('a job parked on a key request resumes once its last key is saved, with which keys were saved (never their values)', async () => {
  const { id } = jobs.createJob({ agent: 'rivet', title: 'Ask for the keys', prompt: 'x', queuedBy: 'rivet' });
  await claim(id);
  await finish(id, { status: 'parked', request: { kind: 'credential', title: 'Two keys', body: 'x', secrets: 'PRINTAPI_TEST_PARK_ONE,PRINTAPI_TEST_PARK_TWO' } });
  const r = (job(id) as any).request as number;
  assert.deepEqual((await h.answer(r, '', { secrets: { PRINTAPI_TEST_PARK_ONE: 'value-1' } })).body, { ok: true, missing: ['PRINTAPI_TEST_PARK_TWO'] });
  assert.equal(job(id).status, 'blocked', 'still waiting for the second key');
  assert.deepEqual((await h.answer(r, '', { secrets: { PRINTAPI_TEST_PARK_TWO: 'value-2' } })).body, { ok: true });
  assert.equal(job(id).status, 'queued');
  assert.match(job(id).note!, /^The board answered your request #\d+ \("Two keys"\) on its desk phone: Saved on the server: PRINTAPI_TEST_PARK_ONE, PRINTAPI_TEST_PARK_TWO\./);
  assert.doesNotMatch(job(id).note!, /value-/);
});

test("two calls on one intercom chat job: each item goes on its own call, and only the call with items is followed up", async () => {
  quietIntercom();
  await say('Morning!');
  const turn = (db.prepare("select id from jobs where kind = 'chat' order by id desc limit 1").get() as { id: number }).id;
  const ask = (title: string) => (jobs.createRequest({ kind: 'decision', title, body: 'x', agent: 'juno', job: turn }) as { id: number }).id;   // (an earlier run's hq ask)
  const r1 = ask('Which headline?'), r2 = ask('Which colour?');
  const a = await aCall('juno', ['Board: The second headline.'], r1);
  await a.end();
  const t = await claim(turn);   // this turn hears call A
  const b = await aCall('juno', ['Board: Green.'], r2);
  await b.end();                 // call B comes in during it: the next turn hears it
  assert.deepEqual([callRow(a.id).job, callRow(b.id).job], [turn, turn]);
  const unsaid = await agent('item', t, { kind: 'decision', owner: 'kit', what: 'The second headline', quote: 'Board: The second headline.' });
  assert.deepEqual([unsaid.status, unsaid.body.error], [409, `this job follows up calls #${a.id} and #${b.id}: say which this item is on (--call <id>)`]);
  const onA = await agent('item', t, { call: a.id, kind: 'decision', owner: 'kit', what: 'The second headline', quote: 'Board: The second headline.' });
  assert.equal(item(onA.body.id).call, a.id);
  // it may put something on B (the refusal named it), but B isn't followed up until a turn has heard it
  const early = (await agent('item', t, { call: b.id, kind: 'task', owner: 'kit', what: 'Check B', quote: 'Board: The second headline.' })).body.id;
  assert.match(job(turn).note ?? '', new RegExp(`This is call #${a.id}[^]*hq item add <kind> <owner> "what" <quote-file> <a-b> --call ${a.id}`));
  await finish(turn, { status: 'done', result: 'The second headline it is.' });
  assert.ok(callRow(a.id).processed_at);
  assert.equal(callRow(b.id).processed_at, null, 'no turn has heard B yet');
  assert.equal(job(turn).status, 'queued');
  assert.match(job(turn).note ?? '', new RegExp(`This is call #${b.id}`), 'the next turn hears B');
  const t2 = await claim(turn);
  assert.equal((await agent('item', t2, { kind: 'decision', owner: 'kit', what: 'Green', quote: 'Board: Green.' })).status, 200, 'one call left: no --call needed');
  await finish(turn, { status: 'done', result: 'Green.' });
  assert.deepEqual([ledger.items(a.id).length, ledger.items(b.id).map(i => i.id).includes(early), !!callRow(b.id).processed_at], [1, true, true]);
});

test('a late hand-over reaches the call the sweep ended; a silent call the sweep deletes takes its token with it', async () => {
  const lost = await aCall('kit', []), silent = await aCall('dex', []);
  await agent('item', lost.token, { kind: 'promise', owner: 'kit', what: 'Send Juno the mission note', quote: 'I will send it' });
  const calls = () => (db.prepare('select count(*) n from calls').get() as any).n;
  ledger.sweep(Date.now() + 3 * hour + 60_000);
  const first = callRow(lost.id).job, before = calls();
  assert.equal(db.prepare('select 1 from call_tokens where call = ?').get(silent.id), undefined);
  assert.equal((await voice('call-end', { agent: 'kit', lines: TALK, token: lost.token })).status, 200);
  assert.equal(calls(), before, 'no second call');
  const row = callRow(lost.id);
  assert.deepEqual([JSON.parse(row.lines), job(first).status], [TALK, 'cancelled']);
  assert.match(job(row.job).prompt, /ran before the transcript came in[^]*\[1\] Board: Kit, build the coming-soon page/);
  assert.equal(ledger.items(lost.id).length, 1, 'the promise stays on its call');
});

test('a late hand-over gets no fresh attempts: a call that used its three stays with the one it has, and the sweep says so', async () => {
  const lost = await aCall('kit', []);
  await agent('item', lost.token, { kind: 'promise', owner: 'kit', what: 'Send Juno the mission note', quote: 'I will send it' });
  ledger.sweep(Date.now() + 3 * hour + 60_000);
  for (let attempt = 1; attempt < 3; attempt++) {   // its first two follow-ups fail, and the sweep sends it again
    const failed = callRow(lost.id).job;
    await claim(failed); await finish(failed, { status: 'failed', result: 'x' });
    ledger.sweep(Date.now() + 3 * hour + 60_000);
  }
  const last = callRow(lost.id).job;
  assert.equal(callRow(lost.id).attempts, 3);
  await claim(last); await finish(last, { status: 'failed', result: 'x' });
  assert.equal((await voice('call-end', { agent: 'kit', lines: TALK, token: lost.token })).status, 200);
  assert.deepEqual([callRow(lost.id).job, callRow(lost.id).attempts, JSON.parse(callRow(lost.id).lines)], [last, 3, TALK], 'no attempt 4');
  ledger.sweep(Date.now() + 4 * hour);
  assert.equal(callRow(lost.id).status, 'failed');
});

test("a promise recorded on the call, or by a follow-up before a late transcript, isn't the call followed up", async () => {
  const c = await aCall('kit', TALK);
  await agent('item', c.token, { kind: 'promise', owner: 'kit', what: 'Send Juno the mission note', quote: TALK[1] });
  await c.end();
  const first = callRow(c.id).job;
  await claim(first); await finish(first, { status: 'done', result: 'Nothing to do.' });
  assert.equal(callRow(c.id).processed_at, null, "the board's asks were never recorded");
  ledger.sweep(Date.now() + 11 * 60_000);
  assert.notEqual(callRow(c.id).job, first, 'sent again');
  // lost, then followed up without the transcript: when it comes in late, that follow-up's items aren't enough
  const lost = await aCall('kit', []);
  await agent('item', lost.token, { kind: 'promise', owner: 'kit', what: 'Send Juno the mission note', quote: 'I will send it' });
  ledger.sweep(Date.now() + 3 * hour + 60_000);   // ended with no hand-over: only the promise is on it
  const empty = callRow(lost.id).job;
  await claim(empty); await finish(empty, { status: 'done', result: 'Nothing to do.' });
  assert.equal(callRow(lost.id).processed_at, null, 'the promise was recorded on the call, not by its follow-up');
  ledger.sweep(Date.now() + 3 * hour + 11 * 60_000);
  const blind = callRow(lost.id).job, tb = await claim(blind);
  assert.notEqual(blind, empty);
  const q = (await agent('item', tb, { kind: 'question', owner: 'kit', what: 'Nothing but the promise', quote: 'I will send it' })).body.id;
  await agent('item-link', tb, { id: q, to: { ref: 'answered on the call' } });
  await finish(blind, { status: 'done', result: 'Only the promise' });
  assert.ok(callRow(lost.id).processed_at);
  await voice('call-end', { agent: 'kit', lines: TALK, token: lost.token });
  const heard = callRow(lost.id).job;
  await claim(heard); await finish(heard, { status: 'done', result: 'Nothing new.' });
  assert.equal(callRow(lost.id).processed_at, null, 'the transcript was never gone through: the sweep sends it again');
});

test("the intercom: a turn that ended before the call's line reached it hasn't heard the call; a fresh session that takes it over records on it", async () => {
  quietIntercom();
  await say('Morning!');
  const turn = (db.prepare("select id from jobs where kind = 'chat' order by id desc limit 1").get() as { id: number }).id;
  const r = (jobs.createRequest({ kind: 'decision', title: 'Which headline?', body: 'x', agent: 'juno', job: turn }) as { id: number }).id;   // (an earlier run's hq ask)
  const t = await claim(turn);   // an unrelated turn is running
  const c = await aCall('juno', ['Board: The second headline.'], r);
  await agent('item', c.token, { kind: 'promise', owner: 'juno', what: 'Tell Kit', quote: 'Board: The second headline.' });
  await c.end();
  assert.equal(callRow(c.id).job, turn);
  await finish(turn, { status: 'done', result: 'Morning!' });
  assert.equal(callRow(c.id).processed_at, null, 'that turn never heard the call');
  // the turn that hears it fails three times: a fresh session takes the call over, and records on it
  for (let i = 0; i < 3; i++) { await claim(turn); await finish(turn, { status: 'failed' }); }
  const fresh = (db.prepare("select id from jobs where kind = 'chat' order by id desc limit 1").get() as { id: number }).id;
  assert.notEqual(fresh, turn);
  assert.equal(callRow(c.id).job, fresh, 'the call goes with its line');
  assert.match(job(fresh).note ?? '', new RegExp(`This is call #${c.id}`));
  const tf = await claim(fresh);
  assert.equal((await agent('item', tf, { kind: 'decision', owner: 'kit', what: 'The second headline', quote: 'Board: The second headline.' })).status, 200);
  await finish(fresh, { status: 'done', result: 'The second headline it is.' });
  assert.ok(callRow(c.id).processed_at);
  assert.equal((await agent('item', t, { kind: 'task', owner: 'kit', what: 'x', quote: 'y', call: c.id })).status, 401, "the old session's token is spent");
});

test("a job carries one item: linking a second to the caller's own job is refused, so dropping it can't miss that job", async () => {
  const c = await aCall('moss', ['Board: Make A2.', 'Board: And D.']);
  await c.end();
  const t = await claim(callRow(c.id).job);
  const a = (await agent('item', t, { kind: 'task', owner: 'moss', what: 'Film A2', lines: '1', quote: 'Board: Make A2.' })).body.id;
  const d = (await agent('item', t, { kind: 'task', owner: 'moss', what: 'Film D', lines: '2', quote: 'Board: And D.' })).body.id;
  const j = (await agent('job', t, { agent: 'moss', title: 'Film A2', prompt: 'x', item: a })).body.id;
  const second = await agent('item-link', t, { id: d, to: { job: j } });
  assert.deepEqual([second.status, second.body.error], [400, `job #${j} carries item #${a} already, and a job carries one: hand item #${d} out as its own job (hq job --item ${d} ...)`]);
  assert.deepEqual([item(d).job, job(j).item], [null, a]);
  assert.equal((await agent('item-link', t, { id: a, to: { job: j } })).status, 200, 'its own item again is fine');
  const own = (await agent('job', t, { agent: 'moss', title: 'Film D', prompt: 'x', item: d })).body.id;
  assert.deepEqual((await agent('item-drop', t, { id: d, why: 'Only A2' })).body, { ok: true, cancelled: [own], told: [], running: [] });
  assert.equal(job(j).status, 'queued');
});

test("the call agent hears what's still open from earlier calls, one line each", async () => {
  const ctx = await voice('call-context?agent=wren');
  const open = ledger.openItems().at(-1)!;
  assert.match(ctx.body.prompt, /## Still open from earlier calls\n[^]*- /);
  assert.ok(ctx.body.prompt.includes(`- #${open.id}: ${open.what} (${open.owner})`), 'with its number, for replace');
  assert.ok(!ctx.body.prompt.includes('Brand films A2 and D'), 'not a dropped item');
  await voice('call-end', { agent: 'wren', lines: [], token: ctx.body.token });
});

// The brief's end-to-end check: a scripted follow-up (no model) runs the real hq against this coordinator. It records
// the call's items unless they're there, and hands each out. Killed mid-run, it runs again: no item or job twice.
test('end to end: a scripted follow-up is killed mid-run and redone without duplicate jobs', async () => {
  const c = await aCall('kit', TALK);
  await c.end();
  const f = callRow(c.id).job, dir = mkdtempSync(`${tmpdir()}/ledger-e2e-`);
  writeFileSync(`${dir}/follow-up.sh`, `set -euo pipefail
cd "$TMPDIR"
if [ "$(hq items ${c.id})" = "No items on call #${c.id} yet." ]; then
  printf '%s' '${TALK[0]}' > q1; hq item add task kit "Build the coming-soon page" q1 1-1
  printf '%s' '${TALK[1]}' > q2; hq item add promise juno "Send Juno the mission note" q2 2-2
fi
printf 'Build the page with the second headline.' > brief
items=$(hq items ${c.id})
ids=$(printf '%s\\n' "$items" | grep -o '^#[0-9]*' | tr -d '#')
for id in $ids; do
  hq job --item "$id" --new kit "Item $id" brief --size 30m --why "One call item with its recorded scope" --code "I$(echo "$id" | tr 0-9 A-J)" || echo "refused: $id"
  if [ -n "\${DIE:-}" ]; then kill -9 $$; fi
done
exit 0
`);
  const hq = new URL('../../worker/bin/hq', import.meta.url).pathname.replace(/\/hq$/, '');
  type ScriptRun = { error: ExecFileException | null; out: string };
  const run = (token: string, die: boolean) => new Promise<ScriptRun>(resolve => execFile('bash', [`${dir}/follow-up.sh`], {
    env: { PATH: `${hq}:${process.env.PATH}`, HQ_URL: h.base, HQ_TOKEN: token, TMPDIR: dir, ...(die ? { DIE: '1' } : {}) } },
    (error, out, err) => resolve({ error, out: out + err })));
  const killed = await run(await claim(f), true);
  assert.equal(killed.error?.signal, 'SIGKILL', killed.out);
  assert.equal(ledger.items(c.id).filter(i => i.job).length, 1, 'one item handed out before interruption');
  await finish(f, { status: 'interrupted' });   // the worker's restart: the job is queued again with its note
  const resumed = await run(await claim(f), false);
  assert.equal(resumed.error, null, resumed.out);
  assert.match(resumed.out, /refused: \d+[^]*No job was queued: item #\d+ already has job #\d+ \(queued\)/, 'the second run is told the first item is out already');
  await finish(f, { status: 'done', result: 'Two items, two jobs' });
  const items = ledger.items(c.id);
  assert.equal(items.length, 2, 'no item twice');
  const handedOut = db.prepare('select item, count(*) n from jobs where call = ? and item is not null group by item').all(c.id) as { item: number; n: number }[];
  assert.deepEqual(handedOut.map(r => r.n), [1, 1], 'one job per item');
  assert.ok(items.every(i => i.job && job(i.job).item === i.id));
  assert.ok(callRow(c.id).processed_at);
});

// Pylon #1618 (PR #205's review, round 3): a promise recorded on the call is followed up by acting on it.
test('a call whose only item is its own promise is followed up once the follow-up hands it out, links it or drops it', async () => {
  for (const how of ['hand out', 'link', 'drop', 'nothing'] as const) {
    const c = await aCall('kit', TALK);
    const p = (await agent('item', c.token, { kind: 'promise', owner: 'kit', what: 'Send Juno the mission note', quote: TALK[1] })).body.id;
    // the call's own hand-out during the call (the job tool's item) isn't anyone going through the call
    if (how === 'nothing') assert.equal((await agent('job', c.token, { agent: 'kit', title: 'Mission note', prompt: 'Send it', item: p })).status, 200);
    await c.end();
    const f = callRow(c.id).job, t = await claim(f);
    if (how === 'hand out') assert.equal((await agent('job', t, { agent: 'kit', title: 'Mission note', prompt: 'Send it', item: p })).status, 200);
    if (how === 'link') assert.equal((await agent('item-link', t, { id: p, to: { ref: 'docs/mission.md' } })).body.status, 'open', "the follow-up's own work now");
    if (how === 'drop') assert.equal((await agent('item-drop', t, { id: p, why: 'Juno has it already' })).status, 200);
    await finish(f, { status: 'done', result: 'The promise is handled' });
    assert.equal(!!callRow(c.id).processed_at, how !== 'nothing', how);
  }
  assert.match(job(callRow(lastCall().id).job).prompt, /or handed out, linked or dropped one recorded during the call/, 'the brief says so');
});

test('the voice line restarting its call agent mid-call goes on with the same call and token', async () => {
  const c = await aCall('kit', TALK), calls = () => (db.prepare('select count(*) n from calls').get() as any).n, n = calls();
  const p = (await agent('item', c.token, { kind: 'promise', owner: 'kit', what: 'Send Juno the mission note', quote: TALK[1] })).body.id;
  const again = await voice('call-context', { agent: 'kit', lang: 'en', request: 0, token: c.token });
  assert.equal(again.status, 200);
  assert.equal(again.body.token, c.token);
  assert.match(again.body.prompt, /promise before you say\s+it's done/);
  assert.equal(calls(), n, 'no second row');
  const q = (await agent('item', again.body.token, { kind: 'promise', owner: 'kit', what: 'Build the page', quote: TALK[0] })).body.id;
  await c.end();
  assert.deepEqual([item(p).call, item(q).call, callRow(c.id).status], [c.id, c.id, 'ended']);
  // a token the call no longer has (it ended), or someone else's, is refused: a restart never starts a call of its own
  const other = await aCall('kit', []), before = calls();
  for (const [who, token] of [['kit', c.token], ['wren', other.token]]) {
    assert.equal((await voice('call-context', { agent: who, token })).status, 409, who);
    assert.equal(calls(), before, 'no new call');
  }
  await other.end();
});

test("the board's correction on a call: an open item is replaced while it's on the line, and the job tool carries what the call noted", async () => {
  const first = await aCall('moss', ['Board: Make versions A2 and D of the brand film.']);
  await first.end();
  const t1 = await claim(callRow(first.id).job);
  const x = (await agent('item', t1, { kind: 'task', owner: 'moss', what: 'Brand films A2 and D', quote: 'Board: Make versions A2 and D.' })).body.id;
  const queued = (await agent('job', t1, { agent: 'moss', title: 'Build A2 and D', prompt: 'Both films', item: x })).body.id;
  const second = await aCall('moss', ['Board: Forget A2, just D.']);
  assert.match((await voice('call-context?agent=wren')).body.prompt, new RegExp(`- #${x}: Brand films A2 and D \\(moss\\)`));
  const y = await agent('item', second.token, { what: 'Only film D, no A2', quote: 'Only film D, no A2', replaces: x });
  assert.deepEqual(y.body, { id: y.body.id, call: second.id, kind: 'task', owner: 'moss', replaced: x, replacedWhat: 'Brand films A2 and D', was: 'open', cancelled: [queued], told: [], running: [] });
  assert.equal(job(queued).status, 'cancelled', 'cancelled while the board is still on the line');
  assert.equal(item(y.body.id).by, null);
  // the job tool with the item: the job carries it, and it's handled when that job ends done
  const d = (await agent('job', second.token, { agent: 'moss', title: 'Film D only', prompt: 'D', item: y.body.id })).body.id;
  assert.deepEqual([job(d).item, job(d).call, item(y.body.id).job], [y.body.id, second.id, d]);
  assert.equal((await agent('job', second.token, { agent: 'moss', title: 'Another', prompt: 'x', item: x })).status, 409, 'only its own call\'s items');
  await second.end();
  await claim(d); await finish(d, { status: 'done', result: 'D is done' });
  assert.equal(item(y.body.id).status, 'handled');
});

// Pylon #2548 (PR #246's review, Quill): a correction noted on the live call has no job to send it from, so the running
// work on the replaced item hears it from the call's follow-up, once, when it goes through the correction (handing it
// out, linking or dropping it).
test("a correction the live call noted: the replaced item's running job hears it once the call's follow-up goes through it", async () => {
  for (const how of ['hand out', 'drop']) {
    const first = await aCall('moss', ['Board: Make versions A2 and D of the brand film.']);
    await first.end();
    const f1 = callRow(first.id).job, t1 = await claim(f1);
    const x = (await agent('item', t1, { kind: 'task', owner: 'moss', what: 'Brand films A2 and D', quote: 'Board: Make versions A2 and D.' })).body.id;
  const building = (await agent('job', t1, { agent: 'moss', title: 'Build A2 and D', prompt: 'Both films', item: x })).body.id;
    await finish(f1, { status: 'done', result: 'Queued the films' });
    await claim(building);
    db.prepare("update jobs set engine = 'claude' where id = ?").run(building);
    const told = () => db.prepare('select * from messages where job = ?').all(building) as any[];
    const second = await aCall('moss', ['Board: Forget A2, just D.']);
    const y = await agent('item', second.token, { what: 'Only film D, no A2', quote: 'Only film D, no A2', replaces: x });
    assert.deepEqual([y.body.running, y.body.told, told().length], [[building], [], 0], 'nobody to send it from on the call');
    await second.end();
    const f2 = callRow(second.id).job, t2 = await claim(f2);
    assert.equal(told().length, 0, 'not before the follow-up has gone through it');
    const handed = how === 'hand out' ? await agent('job', t2, { agent: 'moss', title: 'Film D only', prompt: 'D', item: y.body.id }) : undefined;
    if (handed) assert.equal(handed.status, 200);
    else assert.equal((await agent('item-drop', t2, { id: y.body.id, why: 'The board meant the other film' })).status, 200);
    const m = told();
    assert.equal(m.length, 1, `the running job hears it (${how})`);
    assert.deepEqual([m[0].sender, m[0].sender_job], ['moss', f2], "from the call's follow-up");
    const correction = `A correction to your job #${building}: item #${x} (call #${first.id}) was replaced on call #${second.id} by item #${y.body.id}: `
      + `"Only film D, no A2" (hq items ${first.id} shows it). Stop or change course at your next step; don't redo work item #${y.body.id}'s job covers.`;
    assert.equal(m[0].text, how === 'hand out' ? correction : `${correction} The call's follow-up (job #${f2}) then dropped that correction: The board meant the other film. `
      + `Your item stays replaced, and the follow-up records its work again as a new item if it's still wanted: don't go on with it unless moss tells you to (hq say moss to ask).`);
    // going through it again tells nobody twice
    assert.equal((await agent('item-link', t2, { id: y.body.id, to: handed ? { job: handed.body.id } : { ref: 'answered on the call' } })).status, 200);
    assert.equal(told().length, 1);
    await finish(f2, { status: 'done', result: 'ok' });
    await finish(building, { status: 'done', result: 'ok' });
  }
});

// Pylon #2592 (PR #246's review, Quill): an item with a running job, replaced on a live call by a correction that is
// itself replaced (the call corrects its own correction, or the follow-up does): the running job still hears it, from
// the follow-up going through the last correction, and hears where the chain ends.
async function running(who: string, words: string) {
  const first = await aCall(who, [`Board: ${words}`]);
  await first.end();
  const f1 = callRow(first.id).job, t1 = await claim(f1);
  const x = (await agent('item', t1, { kind: 'task', owner: who, what: words, quote: `Board: ${words}` })).body.id as number;
  const b = (await agent('job', t1, { agent: who, title: words, prompt: words, item: x })).body.id as number;
  await finish(f1, { status: 'done', result: 'Queued it' });
  await claim(b);
  db.prepare("update jobs set engine = 'claude' where id = ?").run(b);
  return { first, x, b, told: () => db.prepare('select * from messages where job = ?').all(b) as any[] };
}
test('a correction the live call replaced again still reaches the running job, from the follow-up going through the last one', async () => {
  for (const how of ['hand out z', 'replaces y']) {
    const { first, x, b, told } = await running('moss', 'Make versions A2 and D of the brand film.');
    const second = await aCall('moss', ['Board: Forget A2, just D.', 'Board: No, just A2.']);
    const y = (await agent('item', second.token, { what: 'Only film D', quote: 'Only film D', replaces: x })).body;
    assert.deepEqual(y.running, [b]);
    // the call corrects its own correction (z), or leaves that to the follow-up, which replaces y (w)
    const z = how === 'hand out z' ? (await agent('item', second.token, { what: 'Only film A2', quote: 'Only film A2', replaces: y.id })).body : undefined;
    if (z) assert.deepEqual([z.running, told().length], [[b], 0], "still owed, and the call's answer says it's still running");
    await second.end();
    const f2 = callRow(second.id).job, t2 = await claim(f2);
    let last: number;
    if (z) {
      const r = await agent('job', t2, { agent: 'moss', title: 'Film A2 only', prompt: 'A2', item: z.id });
      assert.deepEqual(r.body.told.map((t: any) => t.job), [b], 'handing out the last correction tells it');
      last = z.id;
    } else {
      const w = (await agent('item', t2, { what: 'Only film A2', quote: 'Board: No, just A2.', lines: '2', replaces: y.id })).body;
      assert.deepEqual(w.told.map((t: any) => t.job), [b], "the follow-up replacing the call's correction tells it");
      last = w.id;
    }
    const m = told();
    assert.equal(m.length, 1, `the running job on the first item hears it (${how})`);
    assert.equal(m[0].sender_job, f2);
    assert.match(m[0].text, new RegExp(`^A correction to your job #${b}: item #${x} \\(call #${first.id}\\) was replaced on call #${second.id} by item #${last}: `));
    await finish(f2, { status: 'done', result: 'ok' });
    assert.equal(told().length, 1, 'once');
    await finish(b, { status: 'done', result: 'ok' });
  }
});

// Pylon #2592: a correction whose message is refused (the follow-up's 30 messages an hour) isn't lost: the answer says
// which job wasn't told, and it goes out once it can (the sweep, a later go-through, the follow-up ending done).
test("a refused correction stays owed: the answer says who wasn't told, and it's sent once the limit allows", async () => {
  const { x, b, told } = await running('moss', 'Print the autumn mug.');
  const second = await aCall('moss', ['Board: Not the mug, the tote.']);
  const y = (await agent('item', second.token, { what: 'The autumn tote, not the mug', quote: 'The tote', replaces: x })).body;
  await second.end();
  const f2 = callRow(second.id).job, t2 = await claim(f2);
  for (let n = 0; n < 30; n++) assert.equal((await agent('message', t2, { to: 'kit', text: `x${n}` })).status, 200);   // its hour's 30 messages
  const r = await agent('item-link', t2, { id: y.id, to: { ref: 'answered on the call' } });
  assert.deepEqual([r.body.status, r.body.told, r.body.running, told().length], ['open', [], [b], 0], 'refused: not told, and the answer says so');
  ledger.sweep();
  assert.equal(told().length, 0, 'still over the limit');
  db.prepare('update messages set created = ? where sender_job = ?').run(new Date(Date.now() - 2 * hour).toISOString(), f2);   // the hour passing
  ledger.sweep();
  assert.equal(told().length, 1, 'sent once the limit allows');
  ledger.sweep();
  assert.equal(told().length, 1, 'and only once');
  await finish(f2, { status: 'done', result: 'ok' });
  await finish(b, { status: 'done', result: 'ok' });
});

// Pylon #2592: a follow-up that records something else and ends done without going through the call's correction:
// the replaced item's running job hears it as the call is marked followed up.
test("a follow-up that never went through the call's correction tells its running job when it ends done", async () => {
  const { x, b, told } = await running('kit', 'Launch the pet portrait page on Friday.');
  const second = await aCall('kit', ['Board: Launch it Monday instead.', 'Board: And add a gift card.']);
  await agent('item', second.token, { what: 'Launch the pet portrait page on Monday', quote: 'Monday', replaces: x });
  await second.end();
  const f2 = callRow(second.id).job, t2 = await claim(f2);
  assert.equal((await agent('item', t2, { kind: 'task', owner: 'kit', what: 'A gift card', quote: 'Board: And add a gift card.', lines: '2' })).status, 200);
  assert.equal(told().length, 0);
  await finish(f2, { status: 'done', result: 'ok' });
  assert.ok(callRow(second.id).processed_at);
  assert.equal(told().length, 1, 'told as the follow-up ends done');
  assert.equal(told()[0].sender_job, f2);
  await finish(b, { status: 'done', result: 'ok' });
});

test("another job acting on the call's items isn't its follow-up going through the call", async () => {
  const c = await aCall('kit', TALK);
  const p = (await agent('item', c.token, { kind: 'promise', owner: 'kit', what: 'Send Juno the mission note', quote: TALK[1] })).body.id;
  const j = (await agent('job', c.token, { agent: 'kit', title: 'Mission note', prompt: 'Send it', item: p })).body.id;
  assert.match(job(j).prompt, /What the call agent noted on the call[^]*in its own words, not the board's/, "a call-noted line isn't passed off as the board's words");
  await c.end();
  const f = callRow(c.id).job, tj = await claim(j);
  // the job carrying the promise links it, and a job handed out for the call records an item on it
  assert.equal((await agent('item-link', tj, { id: p, to: { ref: 'docs/mission.md' } })).body.status, 'open', 'its own work: handled when it ends done');
  const other = jobs.createJob({ agent: 'kit', title: 'x', prompt: 'x', call: c.id, queuedBy: 'kit' }).id, to = await claim(other);
  assert.equal((await agent('item', to, { kind: 'task', owner: 'kit', what: 'Something else', quote: 'x', call: c.id })).status, 200);
  await claim(f); await finish(f, { status: 'done', result: 'Nothing to do.' });
  assert.equal(callRow(c.id).processed_at, null, "the follow-up went through nothing: the board's ask for the page is still unrecorded");
  ledger.sweep(Date.now() + 11 * 60_000);
  assert.notEqual(callRow(c.id).job, f, 'sent again');
});

test('a promise whose job ended done before the follow-up got to it: the follow-up links it to say it went through it', async () => {
  for (const ack of [true, false]) {
    const c = await aCall('kit', TALK);
    const p = (await agent('item', c.token, { kind: 'promise', owner: 'kit', what: 'Send Juno the mission note', quote: TALK[1] })).body.id;
    // (started on the call: one queued on it waits for its end otherwise)
    const j = (await agent('job', c.token, { agent: 'kit', title: 'Mission note', prompt: 'Send it', item: p, now: true })).body.id;
    await claim(j);
    await c.end();
    await finish(j, { status: 'done', result: 'Sent' });
    assert.equal(item(p).status, 'handled');
    const f = callRow(c.id).job, t = await claim(f);
    assert.match(job(f).prompt, /notes that you did, and changes nothing/, 'the brief says how');
    if (ack) {
      // what it's linked to is checked first: a typo isn't the follow-up going through it
      for (const to of [{ job: 999999 }, { request: 999999 }, { ref: '' }]) assert.equal((await agent('item-link', t, { id: p, to })).status, 400);
      assert.equal(item(p).acted_at, null);
      const r = await agent('item-link', t, { id: p, to: { ref: 'checked: Juno has the note' } });
      assert.deepEqual(r.body, { ok: true, status: 'handled', acknowledged: true, told: [], running: [] });
      assert.deepEqual([item(p).status, item(p).ref, item(p).job], ['handled', null, j], 'nothing about it changed');
    }
    await finish(f, { status: 'done', result: 'The promise is handled' });
    assert.equal(!!callRow(c.id).processed_at, ack, ack ? 'gone through' : "the job ending done isn't the follow-up going through the call");
  }
});

// Pylon #2307 (PR #233's review, round 2): a promise the call handed out whose job hasn't run yet.
test("a promise the call handed out whose job hasn't run: the follow-up links that job, and the item stays open until it's done", async () => {
  const c = await aCall('kit', TALK);
  const p = (await agent('item', c.token, { kind: 'promise', owner: 'kit', what: 'Send Juno the mission note', quote: TALK[1] })).body.id;
  const j = (await agent('job', c.token, { agent: 'kit', title: 'Mission note', prompt: 'Send it', item: p })).body.id;
  await c.end();
  const f = callRow(c.id).job, t = await claim(f);
  assert.match(job(f).prompt, /hq item link <item> job:<that job>`: it stays open until that job ends done/, 'the brief says how');
  const again = await agent('job', t, { agent: 'kit', title: 'Mission note', prompt: 'Send it', item: p });
  assert.deepEqual([again.status, again.body.error], [409, `item #${p} already has job #${j} (queued): it isn't handed out twice (to go through it, hq item link ${p} job:${j})`]);
  assert.deepEqual((await agent('item', t, { what: 'x', quote: 'y', replaces: 999999 })).body, { error: "item #999999 isn't there to replace" });
  assert.deepEqual((await agent('item-link', t, { id: p, to: { job: j } })).body, { ok: true, status: 'open', told: [], running: [] });
  await finish(f, { status: 'done', result: 'The promise is queued as #' + j });
  assert.ok(callRow(c.id).processed_at, 'the follow-up went through it');
  assert.deepEqual([item(p).status, item(p).job], ['open', j], "queued isn't done");
  await claim(j); await finish(j, { status: 'failed', result: 'x' });
  assert.equal(item(p).status, 'open', 'a failed job leaves it open');
});

// Pylon #2451 (PR #233's review, Quill): a live call replaces only an item its briefing numbered (the last 8 open) or
// one it recorded itself. A misheard number past those is refused, and its jobs go on; a restart adds the rebuilt
// briefing's items and keeps the ones the agent heard before.
test("a call replaces only the items its briefing listed, or its own; a restart adds the new briefing's", async () => {
  const earlier = await aCall('kit', []), promise = async (token: string, what: string) =>
    (await agent('item', token, { kind: 'promise', owner: 'kit', what, quote: 'I will' })).body.id as number;
  const old = await promise(earlier.token, 'Print the old sticker sheet');
  const queued = (await agent('job', earlier.token, { agent: 'kit', title: 'Stickers', prompt: 'x', item: old })).body.id;
  const recent: number[] = [];
  for (let i = 1; i <= 8; i++) recent.push(await promise(earlier.token, `Order sample ${i}`));
  await earlier.end();
  const c = await aCall('kit', ['Board: change that.']);
  const shown = () => JSON.parse((db.prepare('select listed from call_tokens where call = ?').get(c.id) as any).listed) as number[];
  assert.deepEqual(shown().slice(-8), recent, 'the token keeps the 8 its briefing numbered');
  assert.ok(!shown().includes(old));
  const r = await agent('item', c.token, { what: 'No stickers', quote: 'x', replaces: old });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, `item #${old} isn't one from your briefing: the call's follow-up corrects it from the transcript`);
  assert.deepEqual([item(old).status, job(queued).status], ['open', 'queued'], 'nothing changed');
  // one it listed is replaced, and so is the call's own promise (recorded after its briefing)
  const listed = await agent('item', c.token, { what: 'Order sample 8 in blue', quote: 'x', replaces: recent[7] });
  assert.deepEqual([listed.status, listed.body.replaced, item(recent[7]).status], [200, recent[7], 'replaced']);
  const own = await promise(c.token, 'Send the board the proof');
  const fixed = await agent('item', c.token, { what: 'Send the board two proofs', quote: 'x', replaces: own });
  assert.deepEqual([fixed.status, fixed.body.replaced], [200, own]);
  // opened after the call's briefing, on another call: not listed until a restart rebuilds it
  const other = await aCall('kit', []), later = await promise(other.token, 'Order sample 9');
  for (let i = 10; i <= 16; i++) await promise(other.token, `Order sample ${i}`);
  assert.equal((await agent('item', c.token, { what: 'No sample 9', quote: 'x', replaces: later })).status, 409);
  const again = await voice('call-context', { agent: 'kit', lang: 'en', request: 0, token: c.token });
  assert.equal(again.body.token, c.token);
  assert.ok(!again.body.prompt.includes(`- #${recent[0]}: `), 'the rebuilt briefing no longer shows sample 1');
  for (const x of [later, recent[0]]) assert.equal((await agent('item', c.token, { what: 'Not that one', quote: 'x', replaces: x })).status, 200, `#${x}`);
  assert.equal((await agent('item', c.token, { what: 'No stickers', quote: 'x', replaces: old })).status, 409, 'still not the old one');
  await other.end(); await c.end();
});

// Pylon #2568 (PR #250's review, Flint): the token keeps only the items the agent hears. The open items come before
// what can grow (open request titles have no cap), and a line fit() cut off anyway (a call about a request with an
// over-long title) isn't listed, on a new call or a restart; a restart keeps the ones heard before.
test("an open item whose line an over-long briefing cut isn't the call's to replace, on a restart too", async () => {
  const promise = async (token: string, what: string) => (await agent('item', token, { kind: 'promise', owner: 'kit', what, quote: 'I will' })).body.id as number;
  const shown = (id: number) => JSON.parse((db.prepare('select listed from call_tokens where call = ?').get(id) as any).listed) as number[];
  const earlier = await aCall('kit', []), x = await promise(earlier.token, 'Order the cut sample');
  const queued = (await agent('job', earlier.token, { agent: 'kit', title: 'Cut sample', prompt: 'x', item: x })).body.id;
  await earlier.end();
  const long = 'Which printer for the long run '.repeat(4_000);   // about 124,000 characters
  const r = (jobs.createRequest({ kind: 'decision', title: long, body: 'b', agent: 'kit' }) as { id: number }).id;
  // not about it: the open list comes first, and is heard
  const bolt = await aCall('bolt', []);
  assert.ok(bolt.prompt.includes(`- #${x}: Order the cut sample`) && shown(bolt.id).includes(x));
  assert.ok(Buffer.byteLength(bolt.prompt) <= 120_000 && bolt.prompt.endsWith('Search for the rest.)'));
  // about it: the title comes before the list, which is cut
  const c = await aCall('kit', ['Board: hello.'], r);
  assert.ok(c.prompt.endsWith('Search for the rest.)') && !c.prompt.includes(`- #${x}: `));
  assert.ok(!shown(c.id).includes(x), 'a cut line isn\'t listed');
  const cut = await agent('item', c.token, { what: 'No cut sample', quote: 'x', replaces: x });
  assert.equal(cut.status, 409);
  assert.deepEqual([item(x).status, job(queued).status], ['open', 'queued'], 'nothing changed');
  // a restart: what was heard before stays listed, what the rebuilt briefing cuts isn't added
  db.prepare("update requests set title = 'Printer A or B?' where id = ?").run(r);   // (a briefing that changes under a restart: no route retitles a card)
  const d = await aCall('kit', ['Board: hello again.'], r);
  assert.ok(shown(d.id).includes(x));
  const later = await promise(bolt.token, 'Order another sample');
  db.prepare('update requests set title = ? where id = ?').run(long, r);
  const again = await voice('call-context', { agent: 'kit', lang: 'en', request: 0, token: d.token });
  assert.equal(again.body.token, d.token);
  assert.ok(!again.body.prompt.includes(`- #${later}: `) && !again.body.prompt.includes(`- #${x}: `));
  assert.ok(shown(d.id).includes(x) && !shown(d.id).includes(later));
  assert.equal((await agent('item', d.token, { what: 'No other sample', quote: 'x', replaces: later })).status, 409);
  assert.equal((await agent('item', d.token, { what: 'No cut sample', quote: 'x', replaces: x })).status, 200, 'heard before the restart');
  await h.answer(r, 'Printer A.');   // off the desk phone, out of later briefings
  await bolt.end(); await c.end(); await d.end();
});

// HQ-OS → Calls, "We missed something": the board adds one item to a call after it, and the call is followed up again.
const board = async (body: unknown, { origin = true, session = true } = {}) => {
  const { ORIGIN } = await import('./config.ts');
  const res = await fetch(`${h.base}/api/calls/item`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json',
    ...(session ? { cookie: h.boardCookie } : {}), ...(origin ? { origin: ORIGIN } : {}) } });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};

test('"we missed something" needs HQ\'s Origin and the session, takes one line, and wakes a done call\'s follow-up again', async () => {
  const c = await aCall('kit', TALK);
  await c.end();
  const f = callRow(c.id).job, t = await claim(f);
  const x = (await agent('item', t, { kind: 'task', owner: 'kit', what: 'Build the coming-soon page', lines: '1', ...quote(TALK[0]) })).body.id;
  await agent('item/link', t, { id: x, ref: 'answered on the call' });
  await finish(f, { status: 'done', result: 'Built it' });
  assert.ok(callRow(c.id).processed_at);
  const count = () => ledger.items(c.id).length, jobsNow = () => (db.prepare('select count(*) n from jobs').get() as any).n;
  const n = count(), j = jobsNow(), what = 'The page needs the newsletter box too';
  assert.equal((await board({ call: c.id, what }, { origin: false })).status, 403, 'not from a product page on the same site');
  assert.equal((await board({ call: c.id, what }, { session: false })).status, 401);
  for (const bad of ['', 'two\nlines', 'x'.repeat(201)]) assert.equal((await board({ call: c.id, what: bad })).status, 400, 'refused, never cut');
  assert.equal((await board({ call: 99999, what })).status, 404);
  assert.deepEqual([count(), jobsNow()], [n, j], 'nothing added by a refusal');

  const r = await board({ call: c.id, what });
  assert.equal(r.status, 200);
  const added = item(r.body.id);
  assert.deepEqual([added.kind, added.owner, added.what, added.status, added.board], ['task', 'kit', what, 'open', 1]);
  const again = callRow(c.id);
  assert.equal(again.processed_at, null);
  assert.ok(again.job !== f && again.job === r.body.job, 'a new follow-up, since the last one is done');
  assert.match(job(again.job).title, /the board added something/);
  assert.ok(job(again.job).prompt.includes(`- #${added.id}: ${what}`), 'its brief names the board\'s item');

  // done without acting on it: not followed up
  await claim(again.job);
  await finish(again.job, { status: 'done', result: 'Nothing new' });
  assert.equal(callRow(c.id).processed_at, null, 'the board\'s item wasn\'t handed out or linked');
  ledger.sweep(Date.now() + hour);
  const third = callRow(c.id).job;
  assert.ok(third !== again.job && job(third).prompt.includes(`- #${added.id}: ${what}`), 'the sweep sends it again');
  const t3 = await claim(third);
  const nb = await agent('job', t3, { agent: 'kit', title: 'Newsletter box', prompt: 'x', item: added.id });
  assert.equal(nb.status, 200);
  const spec = job(nb.body.id).prompt;
  assert.ok(spec.includes(`What the board added in its own words after the call this job comes from (item #${added.id}, call #${c.id}`)
    && spec.includes(`they override it:\n\n${what}`), 'the board\'s words, and they win over the earlier call');
  assert.ok(!spec.includes('not the board\'s') && !spec.includes('the call agent noted'), 'never passed off as the call agent\'s own note');
  await finish(third, { status: 'done', result: 'Queued the newsletter box' });
  assert.ok(callRow(c.id).processed_at, 'handed out: followed up');

  // the board sees it as its own, and never its words beyond the line
  const text = await (await fetch(`${h.base}/api/calls`, { headers: { cookie: h.boardCookie } })).text();
  const row = (JSON.parse(text) as any[]).find(k => k.id === c.id);
  assert.ok(row.items.some((i: any) => i.what === what && i.board === 1 && i.status === 'open' && i.agent === 'kit'));
  assert.ok(!text.includes(TALK[0]) && !('quote' in row.items[0]));
});

test('"we missed something" while the follow-up still runs: no second job; if it ends without the item, the sweep sends it', async () => {
  const c = await aCall('wren', ['Board: Wren, pick the softer tick.']);
  await c.end();
  for (let attempt = 1; attempt < 3; attempt++) {   // its first two follow-ups fail, and the sweep sends it again
    const failed = callRow(c.id).job;
    await claim(failed); await finish(failed, { status: 'failed', result: 'x' });
    ledger.sweep(Date.now() + hour);
  }
  const f = callRow(c.id).job, t = await claim(f);   // its last try: the board's item gives it fresh ones
  const r = await board({ call: c.id, what: 'Send me both ticks to compare' });
  assert.equal(r.status, 200);
  assert.equal(r.body.job, f, 'the running follow-up is still on it');
  assert.equal((db.prepare("select count(*) n from jobs where call = ? and status in ('queued', 'running')").get(c.id) as any).n, 1, 'one follow-up on it');
  await agent('item', t, { kind: 'decision', owner: 'wren', what: 'The softer tick', lines: '1', quote: 'Board: Wren, pick the softer tick.' });
  await finish(f, { status: 'done', result: 'Picked the softer tick' });
  assert.equal(callRow(c.id).processed_at, null);
  ledger.sweep(Date.now() + hour);
  const next = callRow(c.id);
  assert.ok(next.job !== f && job(next.job).prompt.includes('Send me both ticks to compare'), 'a new follow-up, not "failed 3 times"');
  assert.equal(next.status, 'ended');
});

test('a call whose follow-ups recorded nothing fails; the board adds what was missed: handing it out alone isn\'t the call followed up, recording what was heard is', async () => {
  const c = await aCall('pylon', ['Board: mmhm (noise) ...']);
  await c.end();
  for (let n = 1; n <= 3; n++) {
    const f = callRow(c.id).job;
    await claim(f);
    await finish(f, { status: 'done', result: 'Nothing I could make out' });
    assert.equal(callRow(c.id).processed_at, null, `attempt ${n} recorded nothing`);
    ledger.sweep(Date.now() + hour);
  }
  assert.equal(callRow(c.id).status, 'failed');
  const r = await board({ call: c.id, what: 'Put the call volume slider back' });
  assert.equal(r.status, 200);
  const f = callRow(c.id).job, t = await claim(f);
  assert.equal(r.body.job, f);
  assert.equal((await agent('job', t, { agent: 'pylon', title: 'Volume slider', prompt: 'x', item: r.body.id })).status, 200);
  await finish(f, { status: 'done', result: 'Queued the volume slider' });
  assert.equal(callRow(c.id).processed_at, null, "the board's item handed out, but nothing heard on the call recorded: not followed up");
  ledger.sweep(Date.now() + hour);
  const next = callRow(c.id).job;
  assert.ok(next !== f && callRow(c.id).status === 'ended', 'the sweep sends it again');
  const tn = await claim(next);
  assert.equal((await agent('job', tn, { agent: 'pylon', title: 'Volume slider', prompt: 'x', item: r.body.id })).status, 409, 'the board\'s item is handed out once');
  const q = (await agent('item', tn, { kind: 'question', owner: 'pylon', what: 'Nothing on the call I could make out', lines: '1', quote: 'Board: mmhm (noise) ...' })).body.id;
  await agent('item-link', tn, { id: q, to: { ref: 'answered on the call' } });
  await finish(next, { status: 'done', result: 'The call was noise; the slider is queued' });
  assert.ok(callRow(c.id).processed_at, 'what was heard recorded (one question item for a garbled call) and the board\'s item handed out: followed up');
  const jobsNow = () => (db.prepare('select count(*) n from jobs where call = ?').get(c.id) as any).n, n = jobsNow();
  ledger.sweep(Date.now() + hour);
  assert.deepEqual([callRow(c.id).status, callRow(c.id).job, jobsNow()], ['ended', next, n], 'no further attempt, no "failed 3 times"');
});

test("the board's items acted on, before a late transcript or after it, aren't the transcript followed up", async () => {
  const lost = await aCall('kit', []);
  await agent('item', lost.token, { kind: 'promise', owner: 'kit', what: 'Send Juno the mission note', quote: 'I will send it' });
  ledger.sweep(Date.now() + 3 * hour + 60_000);   // ended with no hand-over: only the promise is on it
  const r = await board({ call: lost.id, what: 'Put the call volume slider back' });
  assert.equal(r.status, 200);
  const f = callRow(lost.id).job, t = await claim(f);
  assert.equal((await agent('job', t, { agent: 'kit', title: 'Volume slider', prompt: 'x', item: r.body.id })).status, 200);
  const q = (await agent('item', t, { kind: 'question', owner: 'kit', what: 'Nothing but the promise', quote: 'I will send it' })).body.id;
  await agent('item-link', t, { id: q, to: { ref: 'answered on the call' } });
  await finish(f, { status: 'done', result: 'Queued the volume slider' });
  assert.ok(callRow(lost.id).processed_at, "what was left recorded and the board's item handed out: followed up");
  assert.equal((await voice('call-end', { agent: 'kit', lines: TALK, token: lost.token })).status, 200);
  const heard = callRow(lost.id).job;
  assert.notEqual(heard, f);
  const th = await claim(heard);
  const r2 = await board({ call: lost.id, what: 'And the mute button' });
  assert.equal(r2.body.job, heard, 'the running follow-up hears it');
  assert.equal((await agent('job', th, { agent: 'kit', title: 'Mute button', prompt: 'x', item: r2.body.id })).status, 200);
  await finish(heard, { status: 'done', result: 'Queued the mute button' });
  assert.equal(callRow(lost.id).processed_at, null, 'the transcript was never gone through: the board\'s items don\'t stand in for it, the sweep sends it again');
  ledger.sweep(Date.now() + hour);
  assert.notEqual(callRow(lost.id).job, heard);
});

// a time told on a call reaches the work's deadline
test("a promise's time, noted on the call, becomes the deadline of the thread of the job that carries it or of the work it's linked to", async () => {
  const deadlineOf = (thread: string) => ({ ...(db.prepare('select deadline, deadline_by from threads where id = ?').get(thread) as any) });
  const aimOf = (thread: string) => (db.prepare('select aim from threads where id = ?').get(thread) as { aim: number | null }).aim;
  const c = await aCall('juno', ['Board: When is the share link live?', 'Juno: In two or three hours.', 'Board: And the deck?', 'Juno: Wren has it to you by six.']);
  const link = await agent('item', c.token, { kind: 'promise', owner: 'bolt', what: 'The share link is live', deadline: '3h' });
  assert.equal(link.status, 200);
  assert.ok(Math.abs(item(link.body.id).due - (Date.now() + 3 * hour)) < 60_000, 'three hours from when it was said');
  assert.equal((await agent('item', c.token, { kind: 'promise', owner: 'bolt', what: 'x', deadline: 'soon' })).status, 400);
  // the call's own job for a promise with a time: refused while it names no thread (its token has no job to inherit one
  // from), with the open threads to pick from and nothing queued; with one, the time is that thread's window, from juno.
  const onCall = h.dueThread();
  const count = (title: string) => (db.prepare('select count(*) n from jobs where title = ?').get(title) as any).n;
  const banner = (await agent('item', c.token, { kind: 'promise', owner: 'bolt', what: 'The banner', deadline: '2h' })).body.id;
  const unnamed = await agent('job', c.token, { agent: 'bolt', title: 'The banner', prompt: 'Make it.', item: banner });
  assert.equal(unnamed.status, 409);
  assert.match(unnamed.body.error, new RegExp(`this job would be in none: name the thread it serves.*\\n  ${onCall} `, 's'));
  assert.equal(count('The banner'), 0, 'nothing queued');
  const named = await agent('job', c.token, { agent: 'bolt', title: 'The banner', prompt: 'Make it.', item: banner, thread: onCall });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(deadlineOf(onCall).deadline, Date.parse(named.body.deadline));
  assert.equal(deadlineOf(onCall).deadline_by, 'juno');
  await c.end();
  const f = callRow(c.id).job, t = await claim(f);
  // the follow-up records the other with its time (as UTC), and hands it out: the job takes it
  const six = new Date(Date.now() + 5 * hour).toISOString().slice(0, 16) + 'Z';
  const deck = await agent('item', t, { kind: 'promise', owner: 'wren', what: 'The deck by six', lines: '3-4', quote: 'Juno: Wren has it to you by six.', deadline: six });
  const decks = h.dueThread();
  const handed = await agent('job', t, { agent: 'wren', title: 'The deck', prompt: 'Make it.', item: deck.body.id, thread: decks });
  assert.equal(handed.body.deadline, new Date(Date.parse(six)).toISOString());
  assert.deepEqual(deadlineOf(decks), { deadline: Date.parse(six), deadline_by: 'juno' });
  assert.equal(aimOf(decks), Date.parse(six), 'its aim is the time given too');
  // the share link is already in review: linked to the job that made it, that work has the call's time, from juno
  const links = h.dueThread();
  const work = await h.start({ agent: 'bolt', title: 'Outside notes', queuedBy: 'juno', thread: links }), made = work.id;
  await h.finish(work, { pr: 9201, branch: `job/${made}`, sha: 'c'.repeat(40) });
  const linked = await agent('item-link', t, { id: link.body.id, to: { job: made } });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.deadline, new Date(item(link.body.id).due).toISOString());
  assert.deepEqual(deadlineOf(links), { deadline: item(link.body.id).due, deadline_by: 'juno' });

  // a follow-up that runs after the time passed still records it, and linking the item again (a retry) keeps the newer time
  const past = new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 16) + 'Z';
  const late = await agent('item', t, { kind: 'promise', owner: 'bolt', what: 'Ready at the time', lines: '3-4', quote: 'Juno: Wren has it to you by six.', deadline: past });
  assert.equal(late.status, 200);
  const running = h.dueThread();
  const open = jobs.createJob({ agent: 'bolt', title: 'Still running', prompt: 'x', queuedBy: 'juno', thread: running }).id;
  await agent('item-link', t, { id: late.body.id, to: { job: open } });
  assert.equal((await agent('window', t, { job: open, deadline: '2h' })).status, 200);   // hq window: a newer time
  const newer = deadlineOf(running).deadline;
  await agent('item-link', t, { id: late.body.id, to: { job: open } });
  assert.equal(deadlineOf(running).deadline, newer);
  // open work in no thread has nowhere to take the time: the link is refused, and nothing about the item changes
  const loose = jobs.createJob({ agent: 'bolt', title: 'Loose work', prompt: 'x', queuedBy: 'juno', thread: null }).id;
  const byLoose = (await agent('item', t, { kind: 'promise', owner: 'bolt', what: 'Loose by six', lines: '3-4', quote: 'Juno: Wren has it to you by six.', deadline: six })).body.id;
  const before = item(byLoose);
  const untimed = await agent('item-link', t, { id: byLoose, to: { job: loose } });
  assert.equal(untimed.status, 400);
  assert.match(untimed.body.error, new RegExp(`job #${loose} is in no thread`));
  assert.deepEqual(item(byLoose), before);
  assert.equal(job(loose).item, null);
  // finished work (its pull request merged) linked as the record of an item: its thread, where other work goes on with a
  // newer time, keeps that time and who gave it
  const shared = h.dueThread({ deadline: Date.now() + 8 * hour, by: 'kit' });
  const merged = await h.start({ agent: 'bolt', title: 'The first half', queuedBy: 'juno', thread: shared });
  await h.finish(merged, { pr: 9202, branch: `job/${merged.id}`, sha: 'd'.repeat(40) });
  h.mergedPr(9202);
  jobs.createJob({ agent: 'bolt', title: 'The second half', prompt: 'x', queuedBy: 'juno', thread: shared });
  const kept = deadlineOf(shared);
  const record = (await agent('item', t, { kind: 'promise', owner: 'bolt', what: 'The first half by six', lines: '3-4', quote: 'Juno: Wren has it to you by six.', deadline: past })).body.id;
  const recorded = await agent('item-link', t, { id: record, to: { job: merged.id } });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.deadline, undefined);
  assert.equal(item(record).status, 'handled');
  assert.deepEqual(deadlineOf(shared), kept);
});

test("a follow-up that isn't the CEO's links a timed promise to the call's work in no open thread by naming an open one", async () => {
  const projects = await import('./projects.ts');
  const plan = await import('./plan.ts');
  const threadOf = (job: number) => job && (db.prepare('select thread from jobs where id = ?').get(job) as any).thread;
  const timeOf = (thread: string) => ({ ...(db.prepare('select deadline, deadline_by from threads where id = ?').get(thread) as any) });
  const c = await aCall('kit', ['Board: Can you get the menu card made?', 'Kit: Bolt has it done by tonight.']);
  // on the call, untimed work queued with no thread (the call's token has none to inherit), then reviewed in a loop
  const queued = await agent('job', c.token, { agent: 'bolt', title: 'The menu card', prompt: 'Make it.' });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.equal(threadOf(queued.body.id), null);
  await c.end();
  const t = await claim(callRow(c.id).job);
  const tonight = new Date(Date.now() + 6 * hour).toISOString().slice(0, 16) + 'Z';
  const promise = async (what: string) => (await agent('item', t, { kind: 'promise', owner: 'bolt', what, lines: '2-2', quote: 'Kit: Bolt has it done by tonight.', deadline: tonight })).body.id;
  const menu = await promise('The menu card by tonight');
  const fix = jobs.createJob({ agent: 'bolt', title: 'Fix the menu card', prompt: 'x', stage: 'fix', branch: `job/${queued.body.id}`, thread: null }).id;
  // without a thread: refused, saying how, with nothing linked
  const before = item(menu);
  const bare = await agent('item-link', t, { id: menu, to: { job: queued.body.id } });
  assert.equal(bare.status, 400);
  assert.match(bare.body.error, /is in no thread: link it with --thread <project>\/<slug>/);
  assert.deepEqual(item(menu), before);
  // named (by hq, as the follow-up runs it): the work and its fix go on that thread, and the time with them, from kit
  const menus = h.dueThread();
  const linked = await h.hq({ token: t, agent: 'kit' }, 'item', 'link', String(menu), `job:${queued.body.id}`, '--thread', menus);
  assert.equal(linked.code, 0, linked.out);
  assert.match(linked.out, new RegExp(`Its time is the deadline of ${menus} now`));
  assert.deepEqual([threadOf(queued.body.id), threadOf(fix)], [menus, menus]);
  assert.deepEqual(timeOf(menus), { deadline: Date.parse(tonight), deadline_by: 'kit' });
  assert.equal(item(menu).job, queued.body.id);
  // work on a thread that's done: moved to the open one named, the same job (nothing queued again), and the time goes there
  const old = h.dueThread();
  const left = jobs.createJob({ agent: 'bolt', title: 'The wine list', prompt: 'x', queuedBy: 'kit', thread: old }).id;
  assert.deepEqual(plan.done(old, 'juno'), { ok: true });
  const wine = await promise('The wine list by tonight');
  assert.match((await agent('item-link', t, { id: wine, to: { job: left } })).body.error, new RegExp(`${old} is done`));
  const lists = h.dueThread();
  const count = () => (db.prepare("select count(*) n from jobs where title = 'The wine list'").get() as any).n;
  const moved = await agent('item-link', t, { id: wine, to: { job: left }, thread: lists });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([threadOf(left), count(), timeOf(lists).deadline], [lists, 1, Date.parse(tonight)]);
  // work already on an open thread isn't moved
  const placed = jobs.createJob({ agent: 'bolt', title: 'The specials', prompt: 'x', queuedBy: 'juno', thread: lists }).id;
  const stays = await agent('item-link', t, { id: await promise('The specials by tonight'), to: { job: placed }, thread: menus });
  assert.equal(stays.status, 400);
  assert.match(stays.body.error, new RegExp(`job #${placed} is on ${lists} already`));
  assert.equal(threadOf(placed), lists);
  // the item handed out to its job on a thread, which then closes: linked to that same job with --thread, the work moves,
  // and the time goes with it to the open thread, from whoever was on the call
  const first = h.dueThread();
  const salads = await promise('The salads by tonight');
  const handed = await agent('job', t, { agent: 'bolt', title: 'The salads', prompt: 'Make it.', item: salads, thread: first });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.deepEqual(plan.done(first, 'juno'), { ok: true });
  const untimed = h.dueThread();
  const relinked = await agent('item-link', t, { id: salads, to: { job: handed.body.id }, thread: untimed });
  assert.equal(relinked.status, 200, JSON.stringify(relinked.body));
  assert.equal(threadOf(handed.body.id), untimed);
  assert.deepEqual(timeOf(untimed), { deadline: Date.parse(tonight), deadline_by: 'kit' });
  // --thread with no thread after it: hq stops before it asks HQ anything, and the work stays where it is
  const soups = await promise('The soups by tonight');
  const loose = jobs.createJob({ agent: 'bolt', title: 'The soups', prompt: 'x', queuedBy: 'juno', thread: null }).id;
  const valueless = await h.hq({ token: t, agent: 'kit' }, 'item', 'link', String(soups), `job:${loose}`, '--thread');
  assert.notEqual(valueless.code, 0);
  assert.match(valueless.out, /Not linked: --thread needs a value/);
  assert.equal(item(soups).job, null);
  assert.equal(threadOf(loose), null);
});

// The board rings again before its last call is followed up. The new call carries on from it (its transcript and items
// in the briefing, marked off from where the new call starts), the earlier follow-up goes on, and the new call's waits
// for it, then acts on the new part only: it reads and corrects the earlier call's items, and records nothing on that
// call.
test('a call placed before the last one is followed up carries on from it; its follow-up waits, then acts on the new part', async () => {
  const first = await aCall('moss', ['Board: Make the brand film in blue.', 'Moss: Blue it is.', 'Board: And send me the storyboard.']);
  const promised = (await agent('item', first.token, { kind: 'promise', owner: 'moss', what: 'Brand film in blue', quote: 'Moss: Blue it is.' })).body.id;
  await first.end();
  const f1 = callRow(first.id).job;
  const second = await aCall('moss', ['Board: Actually, make that film green.', 'Board: Forget the storyboard.', 'Board: And book the studio.'], 0, { carry: true });
  assert.deepEqual(JSON.parse(callRow(second.id).resumes), [first.id]);
  const p = second.prompt, starts = p.indexOf(`**This call (#${second.id}) starts here.**`);
  assert.ok(p.includes(`## Carrying on from your call #${first.id}\n`));
  assert.ok(p.indexOf('[1] Board: Make the brand film in blue.') > 0 && p.indexOf('[3] Board: And send me the storyboard.') < starts && starts > 0,
    'the earlier transcript, then where this call starts');
  assert.ok(p.includes(`- #${promised}: Brand film in blue (promise for moss, open)`));
  assert.ok(!p.includes(`- #${promised}: Brand film in blue (moss)`), 'once: the still-open list leaves it out');
  // the call corrects the earlier call's open promise (its briefing numbered it), and a restart still carries on
  const fixed = await agent('item', second.token, { what: 'Brand film in green', quote: 'Board: Actually, make that film green.', replaces: promised });
  assert.deepEqual([fixed.status, item(promised).status], [200, 'replaced']);
  const again = await voice('call-context', { agent: 'moss', lang: 'en', request: 0, token: second.token });
  assert.ok(again.body.prompt.includes(`**This call (#${second.id}) starts here.**`));
  await second.end();
  // the earlier follow-up goes on as it was; the new one has only the new call's lines, and waits for it
  const f2 = callRow(second.id).job;
  assert.equal(job(f1).status, 'queued', 'the earlier follow-up is not cancelled');
  assert.match(job(f2).prompt, new RegExp(`This call carried on from call #${first.id}: `));
  assert.ok(!job(f2).prompt.includes('Make the brand film in blue'), "the new follow-up's transcript is the new call's alone");
  db.prepare('update jobs set engine = ?, not_before = 0 where id = ?').run(`ledger-${f2}`, f2);
  const early = await h.worker('claim', { seat: `seat-${f2}`, engine: `ledger-${f2}` });
  assert.notEqual(early.body?.id, f2, "it doesn't start before the earlier call is followed up");
  assert.deepEqual(wakes.pending(f2), [`once call #${first.id}'s follow-up has finished`], 'HQ says what it waits for');
  // the earlier follow-up records what was said on its call, and ends done
  const t1 = await claim(f1);
  const film = (await agent('item', t1, { kind: 'task', owner: 'moss', what: 'Make the brand film in blue', lines: '1', ...quote('Board: Make the brand film in blue.') })).body.id;
  const board = (await agent('item', t1, { kind: 'task', owner: 'moss', what: 'Send the board the storyboard', lines: '3', ...quote('Board: And send me the storyboard.') })).body.id;
  await finish(f1, { status: 'done', result: 'Noted the film and the storyboard.' });
  assert.ok(callRow(first.id).processed_at);
  // now the new follow-up starts, reads the earlier call, corrects its items and records only its own
  const t2 = await claim(f2);
  assert.match(job(f2).note ?? '', new RegExp(`call #${first.id} is followed up \\(job #${f1}\\)`));
  assert.deepEqual(((await agent(`items?call=${first.id}`, t2)).body as any[]).map(i => i.id), [promised, film, board]);
  assert.match((await agent(`call?id=${first.id}`, t2)).body.text, /^\[1\] Board: Make the brand film in blue\./);
  const green = await agent('item', t2, { what: 'Make the brand film in green', lines: '1', quote: 'Board: Actually, make that film green.', replaces: film });
  assert.deepEqual([green.status, green.body.call, item(film).status], [200, second.id, 'replaced']);
  const dropped = await agent('item-drop', t2, { id: board, why: 'The board took it back on the next call' });
  assert.deepEqual([dropped.status, item(board).status], [200, 'dropped']);
  const onFirst = await agent('item', t2, { kind: 'task', owner: 'moss', what: 'Something from the first call', quote: 'x', call: first.id });
  assert.equal(onFirst.status, 403, 'nothing recorded on the earlier call: its own follow-up did that');
  const studio = await agent('item', t2, { kind: 'task', owner: 'moss', what: 'Book the studio', lines: '3', quote: 'Board: And book the studio.' });
  assert.deepEqual([studio.status, item(studio.body.id).call], [200, second.id]);
  await finish(f2, { status: 'done', result: 'Green, no storyboard, studio booked.' });
  assert.ok(callRow(second.id).processed_at);
  // a job that works for neither call reads neither's items
  const other = await claim(jobs.createJob({ agent: 'moss', title: 'Something else', prompt: 'x' }).id);
  assert.equal((await agent(`items?call=${first.id}`, other)).status, 404);
});

test("a call doesn't carry on from one that's followed up", async () => {
  const done = await aCall('wren', ['Board: Hello.']);
  await done.end();
  const t = await claim(callRow(done.id).job);
  const q = (await agent('item', t, { kind: 'question', owner: 'wren', what: 'Hello', lines: '1', quote: 'Board: Hello.' })).body.id;
  await agent('item-link', t, { id: q, to: { ref: 'answered on the call' } });
  await finish(callRow(done.id).job, { status: 'done', result: 'Hello.' });
  const next = await aCall('wren', ['Board: Hello again.'], 0, { carry: true });
  assert.equal(callRow(next.id).resumes, null);
  assert.ok(!next.prompt.includes('## Carrying on from'));
  await next.end();
});

test('an earlier call comes whole while the phone line has room, and past it keeps its last lines and says so', async () => {
  const said = (n: number) => Array.from({ length: n }, (_, i) => `Board: Line ${i + 1} of the long call, ${'and on '.repeat(12)}`);
  const carried = async (lines: number) => {
    await (await aCall('wren', said(lines))).end();
    const next = await aCall('wren', ['Board: Hello again.'], 0, { carry: true });
    await next.end();
    return next.prompt;
  };
  const whole = await carried(600);   // about 70,000 characters
  assert.ok(whole.includes('\n[1] Board: Line 1 of the long call') && !whole.includes('are left out here'));
  const past = await carried(2_000);
  assert.match(past, /\(Lines 1-\d+ are left out here: the call tool reads call #\d+ whole\.\)/);
  assert.ok(past.includes('[2000] Board: Line 2000 of the long call') && past.includes('starts here.**'));
  assert.ok(Buffer.byteLength(past) <= 120_000 && !past.endsWith('Search for the rest.)'), 'the rest of the briefing whole');
});

test("a call that carried on from one about a customer is about that customer too: its follow-up holds their details", async () => {
  const card = jobs.createRequest({ kind: 'decision', title: 'Refund the tuiparcel?', body: 'Jan Jansen, Kerkstraat 1.', agent: 'penny', customers: true }) as { id: number };
  const first = await aCall('penny', ['Board: refund the tuiparcel.'], card.id);
  await first.end();
  const second = await aCall('penny', ['Board: and add a note to it.'], 0, { carry: true });
  // while it's live: a job handed out for one of its items holds their details too
  assert.equal(memory.customerCall(second.id), true);
  const noted = (await agent('item', second.token, { kind: 'promise', owner: 'penny', what: 'Add a note to the refund', quote: 'Penny: I will.' })).body.id;
  const out = await agent('job', second.token, { agent: 'penny', title: 'Add a note to the refund', prompt: 'Add the note.', item: noted });
  assert.equal(out.status, 200);
  assert.equal(jobs.holdsCustomerData(out.body.id), true);
  await second.end();
  assert.deepEqual(JSON.parse(callRow(second.id).resumes), [first.id]);
  assert.equal(jobs.holdsCustomerData(callRow(second.id).job), true);
  assert.equal(memory.customerCall(second.id), true);
});

const replyOf = async (id: number) => ((await h.board('/api/calls')).body as { id: number; reply: string | null }[]).find(x => x.id === id)!.reply;

test("a follow-up that ends without the board's reply hasn't followed the call up: it's said, sent again, and Calls never shows its report", async () => {
  const c = await aCall('kit', TALK);
  await c.end();
  const f = callRow(c.id).job, t = await claim(f);
  await agent('item', t, { kind: 'task', owner: 'kit', what: 'Build the coming-soon page', lines: '1', ...quote(TALK[0]) });
  assert.equal((await agent('reply', t, { text: 'word '.repeat(121) })).status, 400, 'too long: refused, and nothing set');
  await finish(f, { status: 'done', result: 'Records: item recorded. Checks: gates passed.', reply: null });
  assert.deepEqual([callRow(c.id).processed_at, callRow(c.id).reply], [null, null], 'no reply: not followed up');
  assert.ok(db.prepare("select 1 from events where type = 'log' and text like ?").get(`Call #${c.id}:%`), 'it is said');
  assert.equal(await replyOf(c.id), null, "the job's report is never the call's notes");
  ledger.sweep(Date.now() + hour);
  const next = callRow(c.id).job;
  assert.notEqual(next, f);
  assert.match(job(next).prompt, /hq reply/);
  await claim(next);
  await finish(next, { status: 'done', result: 'Set the reply; the item was recorded already.', reply: 'The coming-soon page gets the second headline.' });
  assert.ok(callRow(c.id).processed_at);
  assert.equal(await replyOf(c.id), 'The coming-soon page gets the second headline.');
});

test('a reply belongs to the follow-up that set it: the board adding to the call clears it, done or still running', async () => {
  const c = await aCall('kit', TALK);
  await c.end();
  const f = callRow(c.id).job, t = await claim(f);
  await agent('item', t, { kind: 'task', owner: 'kit', what: 'Build the coming-soon page', lines: '1', ...quote(TALK[0]) });
  await finish(f, { status: 'done', result: 'r', reply: 'The page gets the second headline.' });
  assert.ok(callRow(c.id).processed_at);
  const r = await board({ call: c.id, what: 'The page needs the newsletter box too' });
  assert.notEqual(r.body.job, f);
  assert.equal(callRow(c.id).reply, null, 'the new follow-up gives its own');
  const t2 = await claim(r.body.job);
  assert.equal((await agent('job', t2, { agent: 'kit', title: 'Newsletter box', prompt: 'x', item: r.body.id })).status, 200);
  await finish(r.body.job, { status: 'done', result: 'Queued the newsletter box', reply: null });
  assert.equal(callRow(c.id).processed_at, null, "the earlier reply isn't this follow-up's answer");
  assert.equal(await replyOf(c.id), null);

  const b = await aCall('wren', ['Board: Wren, pick the softer tick.']);
  await b.end();
  const g = callRow(b.id).job, tg = await claim(g);
  assert.equal((await agent('reply', tg, { text: 'The softer tick.' })).status, 200);
  const added = await board({ call: b.id, what: 'Send me both ticks to compare' });
  assert.equal(added.body.job, g, 'the running follow-up is still on it');
  assert.equal(callRow(b.id).reply, null, 'it answers again for what the board added');
});

test("a call about a card the intercom filed: the turn's final message is the reply, there and as the call's notes; a fresh session gives its own", async () => {
  quietIntercom();
  await say('Morning!');
  const turn = (db.prepare("select id from jobs where kind = 'chat' order by id desc limit 1").get() as { id: number }).id;
  const r = (jobs.createRequest({ kind: 'decision', title: 'Which headline?', body: 'x', agent: ceo(), job: turn }) as { id: number }).id;   // (an earlier run's hq ask)
  const c = await aCall(ceo(), ['Board: The second headline.'], r);
  await c.end();
  assert.equal(callRow(c.id).job, turn, 'the intercom follows it up');
  const note = job(turn).note ?? '';
  assert.ok(note.includes(`#${c.id}`), 'the turn hears the call');
  assert.doesNotMatch(note, /hq reply|report for the log/, 'its final message is what the board reads');
  // a turn that set a reply and broke off three times: the fresh session that takes the call over answers itself
  const t = await claim(turn);
  assert.equal((await agent('reply', t, { text: 'A reply from a session that broke off' })).status, 200);
  await finish(turn, { status: 'failed' });
  for (let i = 0; i < 2; i++) { await claim(turn); await finish(turn, { status: 'failed' }); }
  const fresh = (db.prepare("select id from jobs where kind = 'chat' order by id desc limit 1").get() as { id: number }).id;
  assert.notEqual(fresh, turn);
  assert.deepEqual([callRow(c.id).job, callRow(c.id).reply], [fresh, null]);
  const tf = await claim(fresh);
  assert.equal((await agent('item', tf, { kind: 'decision', owner: 'kit', what: 'The second headline', quote: 'Board: The second headline.' })).status, 200);
  await finish(fresh, { status: 'done', result: 'The second headline it is. 🙂' });
  assert.ok(callRow(c.id).processed_at);
  assert.equal(await replyOf(c.id), 'The second headline it is. 🙂', "the call's notes are the reply the board read in the intercom");
  assert.equal((await history()).messages.at(-1).text, 'The second headline it is. 🙂');
});

// A call's token manages the company's work as its agent's jobs do (server.ts MANAGE_ROUTES), but on a call about a
// customer's details it makes no change that carries words, which reach HQ's feed and colleagues who don't hold them
// (CUSTOMER_CALL_SHUT); one that only names the job, a cancel without a why, goes ahead.
test("a call manages work as off it; a customer's call reads, and changes nothing with its words", async () => {
  const card = jobs.createRequest({ kind: 'decision', title: 'Refund case C-33?', body: 'Jan Jansen, cracked mug', agent: ceo(), customers: true }) as { id: number };
  const plain = await aCall(ceo(), []), about = await aCall(ceo(), [], card.id);
  const queued = (await agent('job', plain.token, { agent: 'kit', title: 'Mug photos', prompt: 'x' })).body.id;
  const other = (await agent('job', plain.token, { agent: 'kit', title: 'Mug box', prompt: 'x' })).body.id;
  const before = JSON.stringify(await h.feed());
  for (const [route, body] of [['cancel', { id: queued, why: 'Jan Jansen refunded' }], ['plan/drop', { id: queued, why: 'Jan Jansen' }],
    ['pauses', { project: 'office', why: 'Jan Jansen' }], ['decisions', { name: 'Refund Jan Jansen?', blocks: ['office'] }],
    ['proposals/drop', { id: 1, why: 'Jan Jansen' }], ['meetings/set', { asks: [1], topic: 'Jan Jansen' }],
    ['owed-close', { slug: 'x', why: 'Jan Jansen' }]] as const) {
    assert.equal((await agent(route, about.token, body)).status, 409, route);
  }
  assert.equal(h.job(queued).status, 'queued');
  assert.equal(JSON.stringify(await h.feed()), before, "nothing of the customer's in HQ's feed");
  for (const route of ['meetings/asks', 'jobs', 'owed', 'proposals']) assert.equal((await agent(route, about.token)).status, 200, `reads stay open: ${route}`);
  // a change that only names the job carries no words of the customer's, and goes ahead
  assert.equal((await agent('cancel', about.token, { id: queued, why: ' ' })).status, 200, 'a cancel without a why');
  assert.equal(h.job(queued).status, 'cancelled');
  assert.equal((await agent('cancel', plain.token, { id: other, why: 'the board dropped it' })).status, 200, 'another call cancels with a why');
  assert.equal(h.job(other).status, 'cancelled');
  for (const route of ['event', 'reply', 'followthrough-verdict', 'item-drop']) {
    assert.equal((await agent(route, plain.token, { text: 'x', verdict: 'ok' })).status, 403, `a call has no job to speak as: ${route}`);
  }
  await about.end();
  await plain.end();
});

// A call that isn't about a customer, by an agent who reads their details (roles.customerData), is about one once a
// look-up hands it them: its changes with words are refused from then on, a call carrying on from it is about the
// customer too, and its follow-up holds their details.
test("a call that reads a customer's card is about the customer from then on", async () => {
  const reader = roles().customerData![0];
  const card = jobs.createRequest({ kind: 'decision', title: 'Refund case C-34?', body: 'Piet Pieters, bent fork', agent: ceo(), customers: true }) as { id: number };
  const first = await aCall(reader, ['Board: What did Piet ask for?', 'Board: A new fork, I think.']);
  const queued = (await agent('job', first.token, { agent: 'kit', title: 'Fork photos', prompt: 'x' })).body.id;
  assert.ok(!memory.customerCall(first.id), 'not about a customer at its start');
  const read = await agent(`requests?id=${card.id}`, first.token);
  assert.equal(read.body[0]?.body, 'Piet Pieters, bent fork', 'the card in full: its reader reads customer data');
  assert.ok(memory.customerCall(first.id), 'about the customer from then on');
  const before = JSON.stringify(await h.feed());
  assert.equal((await agent('cancel', first.token, { id: queued, why: 'Piet Pieters refunded' })).status, 409, 'a cancel with a why');
  assert.equal(h.job(queued).status, 'queued');
  assert.equal(JSON.stringify(await h.feed()), before, "nothing of the customer's in HQ's feed");
  await first.end();
  assert.ok(jobs.holdsCustomerData(callRow(first.id).job), 'its follow-up holds their details');
  const next = await aCall(reader, ['Board: Hello again.'], 0, { carry: true });
  assert.deepEqual(JSON.parse(callRow(next.id).resumes), [first.id]);
  assert.ok(memory.customerCall(next.id), 'a call carrying on from it is about the customer too');
  await next.end();
});

// The same for what a call's briefing shows its agent (call.ts recentWork): a customer's report among its finished jobs,
// at its start, or a customer card's answer among its requests, at a restart once one has come in.
test("a call whose briefing shows a customer's report or card answer is about the customer", async () => {
  const [reader, other] = roles().customerData!;
  const { id: done } = jobs.createJob({ agent: reader, title: 'Refund case C-35', prompt: 'x' });
  db.prepare("update jobs set status = 'done', result = 'Refunded Klaas Klaassen in full', customers = 1, finished = ? where id = ?").run(new Date().toISOString(), done);
  const first = await aCall(reader, ['Board: How did the refund go?']);
  assert.match(first.prompt, /Refunded Klaas Klaassen in full/, 'the report in its briefing: its agent reads customer data');
  assert.ok(memory.customerCall(first.id), 'about the customer from its start');
  const queued = (await agent('job', first.token, { agent: 'kit', title: 'Spoon photos', prompt: 'x' })).body.id;
  const before = JSON.stringify(await h.feed());
  assert.equal((await agent('cancel', first.token, { id: queued, why: 'Klaas Klaassen refunded' })).status, 409, 'a cancel with a why');
  assert.equal(h.job(queued).status, 'queued');
  assert.equal(JSON.stringify(await h.feed()), before, "nothing of the customer's in HQ's feed");
  await first.end();
  assert.ok(jobs.holdsCustomerData(callRow(first.id).job), 'its follow-up holds their details');
  const next = await aCall(reader, ['Board: Hello again.'], 0, { carry: true });
  assert.ok(memory.customerCall(next.id), 'a call carrying on from it is about the customer too');
  await next.end();

  const second = await aCall(other, ['Board: Anything from the desk phone?']);
  assert.ok(!memory.customerCall(second.id), 'not about a customer at its start');
  const card = jobs.createRequest({ kind: 'decision', title: 'Refund case C-36?', body: 'Joke Jansen, chipped bowl', agent: other, customers: true }) as { id: number };
  db.prepare("update requests set status = 'answered', answer = 'Refund Joke Jansen in full' where id = ?").run(card.id);
  const again = await voice('call-context', { agent: other, lang: 'en', request: 0, token: second.token });
  assert.match(again.body.prompt, /Refund Joke Jansen in full/, "the card's answer in the restarted briefing");
  assert.ok(memory.customerCall(second.id), 'about the customer from the restart');
  const kept = (await agent('job', second.token, { agent: 'kit', title: 'Bowl photos', prompt: 'x' })).body.id;
  assert.equal((await agent('cancel', second.token, { id: kept, why: 'Joke Jansen refunded' })).status, 409, 'a cancel with a why');
  assert.equal(h.job(kept).status, 'queued');
  await second.end();
  assert.ok(jobs.holdsCustomerData(callRow(second.id).job), 'its follow-up holds their details');
});
