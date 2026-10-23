// node --test src/redact.test.ts: a key's value never stays in text an agent can read, whatever the text is about, and
// the board sees every card whole (the board, 2026-10-06): secrets.ts redact(), db.ts redacted() and scrub(), jobs.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { harness, type Running } from './harness.ts';

const h = await harness('redact');
const { board, agent, worker } = h;
const { scrubOnStart, remember } = await import('./db.ts');   // (scrubOnStart: what the server's start runs)
const memory = await import('./memory.ts');                     // (refresh: the search index's next pass)

const KEY = 'sk_live_' + 'Q7'.repeat(20), TEST = 'sk_test_' + 'x9'.repeat(20);
const say = async (text: string) => (await board('/api/chat', { text })).body.messages.at(-1).id as number;
const line = async (id: number) => ((await board('/api/chat')).body.messages as any[]).find(m => m.id === id).text;
const wren = await h.start({ agent: 'wren' }), bolt = await h.start({ agent: 'bolt' });
// the board saves a key on the desk phone card that asks for it
const save = async (lead: Running, name: string, value: string) => {
  const id = await h.ask(lead, { kind: 'credential', title: name, body: 'Paste the key.', secrets: name });
  const r = await h.answer(id, '', { secrets: { [name]: value } }); assert.equal(r.status, 200, JSON.stringify(r.body));
};
const holds = async (job: number) => (await worker('customers', { job })).body.customers as boolean;

test('a key said before it was saved leaves the text once the board saves it, and one said after never lands', async () => {
  const before = await say(`it's ${KEY}, I think`);
  const job = h.queue({ agent: 'wren', engine: 'stripe', title: 'Stripe', prompt: `the board said ${KEY} on the call` });
  assert.equal(await line(before), `it's ${KEY}, I think`, "nothing knows it's a key yet");
  await save(bolt, 'STRIPE_LIVE_SECRET_KEY', KEY);
  assert.equal(await line(before), "it's [STRIPE_LIVE_SECRET_KEY], I think");
  const run = (await h.claim('stripe'))!;
  assert.equal(run.prompt, 'the board said [STRIPE_LIVE_SECRET_KEY] on the call');
  assert.equal(await line(await say(`again: ${KEY}`)), 'again: [STRIPE_LIVE_SECRET_KEY]');
  await h.finish(run, { result: `done; ${KEY} works` });
  assert.equal(h.job(job).result, 'done; [STRIPE_LIVE_SECRET_KEY] works');
});

test('hq topic with a saved credential as the topic replies with the stored, redacted topic, never the value', async () => {
  const TOKEN = 'tw' + '5c'.repeat(12);
  await save(bolt, 'TWILIO_AUTH_TOKEN', TOKEN);
  const card = await h.ask(wren, { title: 'Phone line', body: 'Which number?' });
  assert.deepEqual((await agent('request-topic', wren.token, { id: card, topic: `phone ${TOKEN}` })).body, { ok: true, topic: 'phone [TWILIO_AUTH_TOKEN]' });
});

test('only values of 12 characters or more, and each long line of a key on several lines', async () => {
  await save(bolt, 'CALL_PIN', '4711');
  assert.equal(await line(await say('the PIN is 4711')), 'the PIN is 4711', 'masking it would say which 4 digits it is');
  await save(bolt, 'STRIPE_TEST_SECRET_KEY', TEST);
  assert.equal(await line(await say(`a${TEST}b`)), 'a[STRIPE_TEST_SECRET_KEY]b');
});

test('the board reads every card in the Answered list whole, and a customer card stays with the job that filed it in hq requests', async () => {
  const vera = await h.start({ agent: 'vera' });
  const guest = await h.ask(vera, { title: "Sam's answers", body: 'Testco B.V., one VAT number' });
  await h.answer(guest, 'Thanks');
  const shown = (await board('/api/requests/archive')).body.cards.find((c: any) => c.id === guest);
  assert.deepEqual([shown.body, shown.left_out], ['Testco B.V., one VAT number', undefined]);
  const mine = await h.start({ agent: 'wren' });
  // a customer card is a gated tool's (Care's), filed for the job working on the case
  const care = (h.jobs.createRequest({ kind: 'decision', title: 'A refund for case C-12?', body: 'Jan Jansen, jan@example.com', agent: 'wren', job: mine.id, customers: true } as any) as { id: number }).id;
  const read = async (job: Running) => (await agent(`requests?id=${care}`, job.token)).body[0];
  for (const other of [await h.start({ agent: 'dex' }), await h.start({ agent: 'wren' })]) {
    const r = await read(other);
    assert.deepEqual([r.body, r.title], [null, 'A refund for case C-12?'], other.agent);
    assert.match(r.left_out, /roles\.customerData/);
    assert.ok(!await holds(other.id));
  }
  assert.equal((await read(mine)).body, 'Jan Jansen, jan@example.com');
  assert.ok(await holds(mine.id));
  const queued = await agent('job', mine.token, { agent: 'penny', title: 'Refund done', prompt: 'book it' });
  assert.ok(!await holds(queued.body.id), 'what that job queues carries nothing');
});

test('a saved key never reaches the live feed or the status map, whoever publishes the text', async () => {
  await agent('event', wren.token, { type: 'chat', to: 'penny', text: `use ${KEY}` });
  await agent('event', wren.token, { type: 'status', state: 'working', text: `trying ${KEY}` });
  assert.ok(!JSON.stringify(await h.feed()).includes(KEY));
  const studio = (await board('/api/org')).body.departments.find((d: any) => d.agents.some((a: any) => a.id === 'wren'));
  assert.equal(studio.agents.find((a: any) => a.id === 'wren').status.task, 'trying [STRIPE_LIVE_SECRET_KEY]');
});

test('a key with a quote and a backslash leaves a call\'s lines and what search shows of them as soon as it\'s saved', async () => {
  const TOKEN = 'tw"ab\\cd' + 'Z'.repeat(16), penny = await h.start({ agent: 'penny' });
  const ctx = (await h.voice('call-context?agent=bolt&request=0')).body;
  await h.voice('call-end', { agent: 'bolt', lines: [`Board: the wallabyline token is ${TOKEN}`], request: 0, token: ctx.token });
  await h.finish((await h.claim('claude'))!, { result: 'Done.' });   // the call's follow-up
  await memory.refresh();
  const snippet = async () => ((await agent('search?q=wallabyline', penny.token)).body.hits as any[]).map(x => x.snippet).join('\n');
  assert.ok((await snippet()).includes(TOKEN), "nothing knows it's a key yet");
  await save(bolt, 'TWILIO_AUTH_TOKEN', TOKEN);
  assert.deepEqual((await agent(`call?id=${ctx.call}`, penny.token)).body.lines, ['Board: the wallabyline token is [TWILIO_AUTH_TOKEN]']);
  const shown = await snippet();
  assert.ok(!shown.includes(TOKEN) && shown.includes('[TWILIO_AUTH_TOKEN]'), shown);
});

test('a job handed a customer job\'s whole report (org.yaml\'s roles.customerData), or a call about a customer card, holds those details too', async () => {
  const care = await h.start({ agent: 'wren', title: 'A refund', customers: true });
  const role = h.queue({ agent: 'vera', title: 'Then', after: care.id }), mine = h.queue({ agent: 'wren', title: 'Then too', after: care.id });
  await h.finish(care, { status: 'failed', result: 'Refunded Jan Jansen' });
  assert.ok(await holds(role));
  assert.ok(!await holds(mine), "its own agent's next job hears only that it failed");
  const card = (h.jobs.createRequest({ kind: 'decision', title: 'A refund for case C-13?', body: 'Jan Jansen', agent: 'wren', customers: true } as any) as { id: number }).id;
  const ctx = (await h.voice(`call-context?agent=wren&request=${card}`)).body;
  await h.voice('call-end', { agent: 'wren', lines: ['Board: refund Jan.'], request: card, token: ctx.token });
  const followUp = Math.max(...(h.jobs.listJobs() as any[]).filter(j => j.agent === 'wren').map(j => j.id));
  assert.ok(await holds(followUp));
});

test('a start goes over old text again only when the key store or redact()\'s rules changed since the last pass, so a write past the triggers waits for that', async () => {
  const other = new DatabaseSync(`${h.dataDir}/hq.db`);   // without the triggers: no such writer exists, this stands in for one
  const write = () => Number(other.prepare("insert into chat (ts, who, text) values ('t', 'board', ?)").run(`it was ${KEY}`).lastInsertRowid);
  scrubOnStart();
  const id = write();
  scrubOnStart();
  assert.equal(await line(id), `it was ${KEY}`, 'the same keys as the last pass: nothing read');
  const later = new Date(Date.now() + 60_000);
  utimesSync(`${h.dataDir}/secrets/STRIPE_LIVE_SECRET_KEY`, later, later);   // the key put in again by hand
  scrubOnStart();
  assert.equal(await line(id), 'it was [STRIPE_LIVE_SECRET_KEY]');
  const again = write();
  remember('scrubbed', 'the last pass, under an older redact()');
  scrubOnStart();
  assert.equal(await line(again), 'it was [STRIPE_LIVE_SECRET_KEY]');
  other.close();
});
