// node --test src/memory-shared.test.ts   (#1877, #934 follow-up 1: the board's calls findable by every agent, with their
// summaries, and a failed job's report for the jobs waiting on it; a customer's details only for the job working on them).
// Everything goes through the routes the data really takes: the voice line's call-context and call-end, the worker's
// claim and finish, and /api/agent/*. In the fixture, Penny and Vera are org.yaml's roles.customerData.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Running } from './harness.ts';

const h = await harness('memory-shared');
const { jobs, voice, worker, agent } = h;
const memory = await import('./memory.ts');
const ledger = await import('./ledger.ts');
// A customer's mail in the inbox: a job that lists it holds their details (server.ts readMailAs; an empty inbox marks nothing).
h.db.prepare("insert into mail (received, sender, recipient, subject, body) values (?, 'jan@example.com', 'hello@testco.example', 'My order', 'Hi')")
  .run(new Date().toISOString());
const q = encodeURIComponent;

// A job the queue already has (a call's follow-up, one queued with hq job) runs: the worker claims it on its engine. What
// the board's answers left queued ahead of it ("The board on: ...") runs and is done first.
async function run(id: number): Promise<Running> {
  let j;
  while ((j = await h.claim(h.job(id).engine)) && j.id !== id) await h.finish(j, { result: 'Done.' });
  return j ?? assert.fail(`job #${id} is the one the worker claims`);
}
const done = (j: Running, result = 'ok', status = 'done') => h.finish(j, { status, result });
// An agent at work, to search and read with: a job of its own, running.
const at = (agent: string) => h.start({ agent, title: `Looking things up (${agent})` });
// A call with the board, as the voice line has it: its context (and the call's token), then the transcript at the end;
// during: what happens while it's on (a picture shared). Its number and its follow-up, as HQ's Calls lists them. The
// agent's earlier calls not followed up yet ended a day ago: it doesn't carry on from them (call.ts carriedOn), unless
// `carry`.
async function call(agent: string, lines: string[], request?: number, o: { carry?: boolean; during?: (ctx: any) => Promise<unknown> } = {}) {
  if (!o.carry) h.db.prepare("update calls set ts = ? where agent = ? and status = 'ended' and processed_at is null").run(new Date(Date.now() - 25 * 3600_000).toISOString(), agent);
  const ctx = (await voice(`call-context?agent=${agent}${request ? `&request=${request}` : ''}`)).body;
  await o.during?.(ctx);
  assert.equal((await voice('call-end', { agent, lines, token: ctx.token, ...(request ? { request } : {}) })).status, 200);
  return { id: ctx.call as number, job: (await h.board('/api/calls')).body.find((c: any) => c.id === ctx.call).job as number };
}
const hits = async (token: string, s: string) => ((await agent(`search?q=${q(s)}&limit=30`, token)).body.hits as any[])
  .filter(x => x.pointer.startsWith('hq ')).map(x => `${x.source} ${x.pointer}`);
// whether the worker treats a job as holding a customer's details (its Claude memory then gives nothing back)
const holds = async (j: { id: number }) => (await worker('customers', { job: j.id })).body.customers as boolean;

test("A board call is every agent's: search finds its words and its summary, and hq call (and the call tool) reads both", async () => {
  // Juno couldn't find the call where the board explained the support chat's human contact
  const c = await call('kit', ['Board: the support chat hands over to a human through the kakapodesk.', 'Kit: got it, the kakapodesk it is.']);
  const follow = await run(c.job);
  assert.equal((await agent('item', follow.token, { kind: 'briefing', owner: 'kit', what: 'How the support chat reaches a human', quote: 'Board: the support chat hands over to a human through the kakapodesk.' })).status, 200);
  assert.equal((await done(follow, 'The board explained the kakapodesk hand-over; I wrote the tuatarahandover note.')).status, 200);
  await memory.refresh();
  const juno = await at('juno');
  assert.deepEqual(await hits(juno.token, 'kakapodesk'), [`call hq call ${c.id}`, `summary hq call ${c.id}`]);
  assert.deepEqual(await hits(juno.token, 'tuatarahandover'), [`summary hq call ${c.id}`], "the follow-up's report is the call's summary");
  const read = (await agent(`call?id=${c.id}`, juno.token)).body;
  assert.deepEqual([read.agent, read.job, read.lines[0], read.summary], ['kit', c.job, 'Board: the support chat hands over to a human through the kakapodesk.',
    'The board explained the kakapodesk hand-over; I wrote the tuatarahandover note.']);
  // the call agent on the voice line: search and the call tool, with the call's own token
  const line = (await voice('call-context?agent=juno')).body.token;
  assert.deepEqual(await hits(line, 'kakapodesk'), [`call hq call ${c.id}`, `summary hq call ${c.id}`]);
  assert.deepEqual((await agent(`call?id=${c.id}`, line)).body, read);
  const printed = (await h.hq(juno, 'call', String(c.id))).out;
  assert.ok(printed.includes('Kit: got it, the kakapodesk it is.') && printed.includes('I wrote the tuatarahandover note.'), printed);
  assert.match((await h.hq(juno, 'search', 'kakapodesk')).out, new RegExp(`\n  hq call ${c.id}  \\[call\\]\n`));
  // still the agent's own history only: Juno's lists no call of Kit's
  assert.deepEqual((await agent('history', juno.token)).body.calls, []);
  // a call still going on is nobody's yet
  assert.equal((await agent(`call?id=${(await voice('call-context?agent=kit')).body.call}`, juno.token)).status, 404);
});

test("A call about a card for keys is its own agent's, transcript and report; one about a customer card is the jobs' working on it; every other call is shared whole", async () => {
  const bolt = await at('bolt');
  // Penny's call about Penny's request for keys: the board could read one out, and speech-to-text writes it down unmasked
  const keyReq = jobs.createRequest({ kind: 'credential', title: 'Keys for the weta bank', body: 'Enter the weta bank keys.', agent: 'penny', secrets: 'STRIPE_TEST_WETA_KEY' }) as { id: number };
  const keyed = await call('penny', ['Board: the wetabank key is sk-weta-1.'], keyReq.id);
  await done(await run(keyed.job), 'The wetabank key is in.');
  // Kit's call about a customer card (a tool wrote one customer's details on it, as the remedies kit does)
  const card = jobs.createRequest({ kind: 'decision', title: 'Refund the moaparcel?', body: 'Jan Jansen, Kerkstraat 1.', agent: 'kit', customers: true }) as { id: number };
  const cust = await call('kit', ['Board: refund the moaparcel.'], card.id);
  const heard = await run(cust.job);
  // its follow-up is the job HQ handed the card: it reads the call and the card, and holds the customer's details
  assert.equal((await agent(`call?id=${cust.id}`, heard.token)).status, 200);
  assert.equal((await agent(`requests?id=${card.id}`, heard.token)).body[0].body, 'Jan Jansen, Kerkstraat 1.');
  // Kit's call about a plain request that job asks: shared whole, though the asking job holds a customer's details
  const asked = await h.ask(heard, { urgency: 'today', title: 'The hihiparcel', body: 'Which box?' });
  await done(heard, 'Refunded the moaparcel.');
  const plain = await call('kit', ['Board: the hihiparcel goes in the small box.'], asked);
  await memory.refresh();
  assert.deepEqual(await hits(bolt.token, 'wetabank'), []);
  assert.equal((await agent(`call?id=${keyed.id}`, bolt.token)).status, 404, 'wetabank: not to anyone else');
  const penny = await at('penny');
  const found = await hits(penny.token, 'wetabank');
  assert.ok(found.includes(`call hq call ${keyed.id}`) && found.includes(`summary hq call ${keyed.id}`), `wetabank: its own agent finds it: ${found}`);
  assert.equal((await agent(`call?id=${keyed.id}`, penny.token)).body.lines.length, 1, 'wetabank: and reads it');
  await done(penny);
  // the customer card's call: no other job finds or reads it, Kit's next one included, and hq call says why
  const kit = await at('kit');
  for (const reader of [bolt, kit]) {
    assert.deepEqual(await hits(reader.token, 'moaparcel'), [], 'moaparcel');
    const refused = await agent(`call?id=${cust.id}`, reader.token);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, new RegExp(`^call #${cust.id} is about a customer, so it goes only to the jobs working on it \\(its follow-up, job #${cust.job},`));
  }
  assert.equal(await holds(bolt), false);
  const vera = await at('vera');
  assert.deepEqual((await hits(vera.token, 'moaparcel')).sort(), [`call hq call ${cust.id}`, `summary hq call ${cust.id}`], 'org.yaml\'s roles.customerData finds it');
  await done(vera);
  assert.deepEqual(await hits(bolt.token, 'hihiparcel'), [`call hq call ${plain.id}`]);
  assert.equal((await agent(`call?id=${plain.id}`, bolt.token)).status, 200);
  await run(plain.job).then(j => done(j));

  // A call that carried on from a call about a card for keys is its own agent's too, however many calls deep: the board
  // may read the key out again on it. Penny's second call carries on from the keys call, her third from the second only
  // (the keys call was followed up in between).
  const keyReq2 = jobs.createRequest({ kind: 'credential', title: 'Keys for the kiwi bank', body: 'Enter the kiwi bank keys.', agent: 'penny', secrets: 'STRIPE_TEST_KIWI_KEY' }) as { id: number };
  const first = await call('penny', ['Board: the kiwibank keys are coming.'], keyReq2.id);
  const second = await call('penny', ['Board: the kiwibank key is sk-kiwi-2.'], undefined, { carry: true });
  // (a follow-up that records an item: the call is followed up, and the next call's follow-up runs)
  const followUp = async (c: { id: number; job: number }, quote: string, result: string) => {
    const f = await run(c.job);
    assert.equal((await agent('item', f.token, { kind: 'briefing', owner: 'penny', what: quote, quote, call: c.id })).status, 200);
    assert.equal((await agent('reply', f.token, { text: result })).status, 200); // (its reply)
    await done(f, result);
  };
  await followUp(first, 'Board: the kiwibank keys are coming.', 'The kiwibank keys are on their way.');
  const third = await call('penny', ['Board: and the kiwibank payout day is Friday.'], undefined, { carry: true });
  const resumes = (id: number) => JSON.parse((h.db.prepare('select resumes from calls where id = ?').get(id) as { resumes: string }).resumes) as number[];
  assert.deepEqual([resumes(second.id), resumes(third.id)], [[first.id], [second.id]]);
  await followUp(second, 'Board: the kiwibank key is sk-kiwi-2.', 'The kiwibank key went into the kererusecret.');
  await followUp(third, 'Board: and the kiwibank payout day is Friday.', 'Kiwibank payouts set for Friday in the kererupayout.');
  // A call that carried on from a plain call stays shared
  const ruru = await call('kit', ['Board: the rurubox is blue.']);
  const ruru2 = await call('kit', ['Board: and the rurulid is green.'], undefined, { carry: true });
  assert.deepEqual(resumes(ruru2.id), [ruru.id]);
  await memory.refresh();
  for (const word of ['kiwibank', 'kererusecret', 'kererupayout']) assert.deepEqual(await hits(bolt.token, word), [], word);
  for (const c of [first, second, third]) assert.equal((await agent(`call?id=${c.id}`, bolt.token)).status, 404, `call #${c.id}: not to anyone else`);
  assert.deepEqual(await hits(bolt.token, 'rurulid'), [`call hq call ${ruru2.id}`]);
  assert.equal((await agent(`call?id=${ruru2.id}`, bolt.token)).status, 200);
  const penny2 = await at('penny');
  for (const c of [first, second, third]) assert.equal((await agent(`call?id=${c.id}`, penny2.token)).status, 200, `call #${c.id}: its own agent reads it`);
  assert.ok((await hits(penny2.token, 'kererusecret')).includes(`summary hq call ${second.id}`), 'and finds their summaries');
  assert.ok((await hits(penny2.token, 'kererupayout')).includes(`summary hq call ${third.id}`));
  await done(penny2);
});

test("A summary is its job's whole report: shared unless that job was handed a customer's details; then the call is the jobs' working on it", async () => {
  const wren = await at('wren');
  // Penny's call, and its follow-up, which reads the company inbox before it ends
  const c = await call('penny', ['Board: the pukeko budget is 60.']);
  const follow = await run(c.job);
  await memory.refresh();
  assert.deepEqual(await hits(wren.token, 'pukeko'), [`call hq call ${c.id}`], 'no summary before the job is done');
  assert.ok((await agent(`call?id=${c.id}`, wren.token)).body.summary_left_out);
  await agent('mail', follow.token);
  assert.deepEqual(await hits(wren.token, 'pukeko'), [], 'out at once, before the index catches up');
  await done(follow, 'Pukeko budget set to 60, and the takahebank refund for Jan Jansen is done.');
  await memory.refresh();
  assert.deepEqual(await hits(wren.token, 'takahebank'), [], 'its summary is left out');
  assert.deepEqual(await hits(wren.token, 'pukeko'), [], 'and the transcript');
  assert.equal((await agent(`call?id=${c.id}`, wren.token)).status, 403);
  assert.match((await h.hq(wren, 'call', String(c.id))).out, /ask Penny for what you need from it \(hq say penny\)\n$/);
  const penny = await at('penny');   // (org.yaml's roles.customerData)
  assert.equal((await agent(`call?id=${c.id}`, penny.token)).body.summary, 'Pukeko budget set to 60, and the takahebank refund for Jan Jansen is done.');

  // A follow-up that asks for keys itself is shared as any other: a key's value never reaches its report (db.ts redacted())
  const third = await call('penny', ['Board: the weka payroll runs on the 25th.']);
  const weka = await run(third.job);
  await h.ask(weka, { kind: 'credential', urgency: 'today', title: 'The weka bank key', body: 'Enter it.', secrets: 'STRIPE_TEST_WEKA_KEY' });
  await done(weka, 'Weka payroll set for the 25th in the moreporkledger.');
  await memory.refresh();
  assert.deepEqual(await hits(wren.token, 'moreporkledger'), [`summary hq call ${third.id}`]);
});

// a picture the board shares on a live call (HQ uploads it with the call's key)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAF0lEQVQI12P8z4AALKsZQrFzGBkYEAoBe+gECZtuXNMAAAAASUVORK5CYII=', 'base64');
const { ORIGIN } = await import('./config.ts');

test("A call stays about a customer when its follow-up that read their details fails and the sweep hands it a new one", async () => {
  const wren = await at('wren');
  let picture = 0;
  const c = await call('penny', ['Board: the tieketin needs a bigger box.'], undefined, { during: async ctx => {
    const r = await fetch(`${h.base}/api/pictures?call=${ctx.call}&key=${q(ctx.key)}`, { method: 'POST', body: PNG,
      headers: { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'image/png' } });
    picture = (await r.json()).id;
  } });
  const first = await run(c.job);
  await agent('mail', first.token);   // (Penny is roles.customerData: the follow-up now holds a customer's details)
  await done(first, 'Lost the line.', 'failed');
  ledger.sweep(Date.now() + 11 * 60_000);   // (ten minutes on: no route moves the clock)
  const again = (await h.board('/api/calls')).body.find((x: any) => x.id === c.id).job;
  assert.notEqual(again, c.job, 'the sweep handed the call a new follow-up');
  assert.equal(await holds({ id: again }), true);
  await memory.refresh();
  assert.equal((await agent(`call?id=${c.id}`, wren.token)).status, 403);
  assert.deepEqual(await hits(wren.token, 'tieketin'), []);
  assert.equal((await agent(`picture?id=${picture}`, wren.token)).status, 403);
  assert.equal(await holds(wren), false);
  await done(wren);
  await run(again).then(j => done(j));
});

test("A failed job's report reaches the jobs waiting on it (hq job --after) unless the job holds a customer's details, its own agent's included", async () => {
  for (const m of ['none', 'customers', 'keys'] as const) {
    const word = `kokako${m}`;
    // customers: a tool put a customer's details in its prompt
    const f = await h.start({ agent: 'lark', title: `Build the ${word}`, customers: m === 'customers' });
    const own = (await agent('job', f.token, { agent: 'lark', title: `After the ${word}`, prompt: 'Build on it.', after: f.id })).body.id;
    const theirs = (await agent('job', f.token, { agent: 'wren', title: `Use the ${word}`, prompt: 'Use it.', after: f.id })).body.id;
    if (m === 'keys') await h.ask(f, { kind: 'credential', urgency: 'today', title: `The ${word} key`, body: 'Enter it.', secrets: 'STRIPE_TEST_KOKAKO_KEY' });
    const report = `The ${word} broke halfway: the migration ran, the route didn't.`;
    assert.equal((await done(f, report, 'failed')).status, 200);
    const a = await run(own), b = await run(theirs);
    assert.equal(a.note!.includes(report), m !== 'customers', `${m}: its own agent's job`);
    assert.equal(b.note!.includes(report), m !== 'customers', `${m}: another agent's job`);
    assert.ok(b.note!.includes(`Build the ${word}`), `${m}: the title shows whole`);
    await done(a); await done(b);
  }
});

test("The worker reads whether a job holds a customer's details as it's claimed and again as its run ends (its Claude memory then gives nothing back)", async () => {
  const care = await h.start({ agent: 'dex', title: 'Answer the crate question', customers: true });
  assert.equal(care.customers, 1, 'made with a customer\'s details in its prompt');
  const penny = await h.start({ agent: 'penny', title: 'Check the invoices' });
  assert.equal(penny.customers, 0);
  assert.equal(await holds(penny), false);
  await agent('mail', penny.token);
  assert.equal(await holds(penny), true);
  assert.equal((await worker('customers', { job: 999_999 })).status, 404);
  await done(care); await done(penny);
});

test("A job handed out for a customer call's item holds their details once it reads the transcript, as any reader of hq call does", async () => {
  const card = jobs.createRequest({ kind: 'decision', title: 'Refund the kakaparcel?', body: 'Jan Jansen, Kerkstraat 1.', agent: 'kit', customers: true }) as { id: number };
  for (const [lines, request, customers] of [[['Board: the kiwiparcel goes in the small box.'], undefined, false],
    [['Board: refund the kakaparcel.'], card.id, true]] as const) {
    const heard = await call('kit', [...lines], request);
    await done(await run(heard.job), 'Handed out the parcel work.');
    // a job for one of the call's items: it reads the ledger's transcript, not memory.ts's
    const item = await h.start({ agent: 'dex', title: 'Pack the parcel', call: heard.id });
    assert.equal(await holds(item), false);
    assert.equal((await agent(`call?id=${heard.id}`, item.token)).status, 200);
    assert.equal(await holds(item), customers, `call #${heard.id}`);
    await done(item);
  }
});

test("A job handed a customer call's item holds their details from the start: the words from the call are in its prompt", async () => {
  const card = jobs.createRequest({ kind: 'decision', title: 'Refund the moaparcel?', body: 'Jan Jansen, Kerkstraat 1.', agent: 'kit', customers: true }) as { id: number };
  for (const [line, request, customers] of [['Board: the wekaparcel goes in the small box.', undefined, false],
    ['Board: refund the moaparcel.', card.id, true]] as const) {
    const heard = await call('kit', [line], request);
    const follow = await run(heard.job);
    const it = (await agent('item', follow.token, { kind: 'task', owner: 'dex', what: 'Pack the parcel', quote: line })).body.id;
    const handed = await agent('job', follow.token, { agent: 'dex', title: 'Pack the parcel', prompt: 'Pack it.', item: it });
    assert.equal(handed.status, 200);
    assert.equal(await holds(handed.body), customers, `call #${heard.id}`);
    await done(follow, 'Handed out the parcel work.');
    await run(handed.body.id).then(j => done(j));
  }
});

// Search by meaning (#1878) compares the shared calls too, under the same rules as their words. A fake model: "grumblebox"
// and "quibbleport" are one made-up concept, so only meaning finds the call by the word it doesn't have.
test("By meaning, too: another agent's call is found through a synonym, and not once its follow-up holds a customer's details", async () => {
  const c = await call('penny', ['Board: complaints go to the grumblebox from now on.', 'Penny: the grumblebox, noted.']);
  const follow = await run(c.job);
  const vec = (t: string, kind: 'query' | 'passage') => {
    const v = new Float32Array([/grumblebox|quibbleport/i.test(t) ? 1 : 0, kind === 'query' ? 0.1 : 0, kind === 'passage' ? 0.1 : 0]);
    const len = Math.hypot(...v);
    return v.map(x => x / len);
  };
  memory.setEmbedder(async (texts, kind) => { await new Promise(r => setImmediate(r)); return texts.map(t => vec(t, kind)); }, 'fake-shared');   // (a model doesn't block the server)
  await memory.refresh();
  await memory.embedAll();
  const juno = await at('juno');
  assert.deepEqual(await hits(juno.token, 'quibbleport'), [`call hq call ${c.id}`]);
  await agent('mail', follow.token);   // (Penny is roles.customerData)
  assert.deepEqual(await hits(juno.token, 'quibbleport'), [], 'out at once, before the index catches up');
  memory.setEmbedder(null);
  await done(juno); await done(follow, 'Set up the grumblebox.');
});

test("A customer card is the job's that filed it: its text, photos and history entry; its agent's next job and the CEO's get its title and why, and hold nothing", async () => {
  const filer = await at('lark');
  const card = jobs.createRequest({ kind: 'decision', title: 'Refund the tuiparcel?', body: 'Jan Jansen sent the tuiparcel back.', agent: 'lark',
    job: filer.id, customers: true, photos: ['The parcel'] }) as { id: number };
  const later = await at('lark'), ceo = await at('juno');
  assert.equal((await agent(`requests?id=${card.id}`, filer.token)).body[0].body, 'Jan Jansen sent the tuiparcel back.');
  assert.equal((await agent(`photos?id=${card.id}`, filer.token)).status, 200);
  assert.equal((await agent(`history?q=${q(`#${card.id}`)}`, filer.token)).body.requests[0].body, 'Jan Jansen sent the tuiparcel back.');
  for (const reader of [later, ceo]) {
    const shown = (await agent(`requests?id=${card.id}`, reader.token)).body[0];
    assert.deepEqual([shown.title, shown.body], ['Refund the tuiparcel?', null]);
    assert.match((await h.hq(reader, 'requests', String(card.id))).out, /Refund the tuiparcel\?.*\n\(a customer card goes only to the job working on it .*roles\.customerData.*\)\n/);
  }
  assert.equal((await agent(`photos?id=${card.id}`, later.token)).status, 403);
  // a colleague's job handed out for an item of a call about the card, and org.yaml's roles.customerData, get its photos
  const c = await call('lark', ['Board: ask Dex to weigh the tuiparcel.'], card.id);
  const follow = await run(c.job);
  const item = (await agent('item', follow.token, { kind: 'task', owner: 'dex', what: 'Weigh the tuiparcel', quote: 'Board: ask Dex to weigh the tuiparcel.' })).body.id;
  const handed = await run((await agent('job', follow.token, { agent: 'dex', title: 'Weigh the tuiparcel', prompt: 'x', item })).body.id);
  await done(follow);
  const vera = await at('vera');
  for (const reader of [handed, vera]) {
    assert.equal((await agent(`photos?id=${card.id}`, reader.token)).status, 200);
    assert.equal(await holds(reader), true);
    await done(reader);
  }
  const history = (await agent(`history?q=${q(`#${card.id}`)}`, later.token)).body.requests[0];
  assert.deepEqual([history.title, history.body, history.answer, !!history.left_out], ['Refund the tuiparcel?', null, null, true]);
  await memory.refresh();
  assert.deepEqual(await hits(later.token, 'tuiparcel'), []);
  assert.deepEqual([await holds(later), await holds(ceo), await holds(filer)], [false, false, true]);
  for (const j of [filer, later, ceo]) await done(j);
});

test("A call's briefing lists its agent's own recent work, but a report that holds a customer's details only by its title", async () => {
  await done(await h.start({ agent: 'moss', title: 'Answer the moreporkmug question', customers: true }), 'Told Jan Jansen the moreporkmug ships Friday.');
  await done(await at('moss'), 'Painted the kererushelf.');
  const prompt = (await voice('call-context?agent=moss')).body.prompt as string;
  assert.match(prompt, /Painted the kererushelf\./);
  assert.match(prompt, /Answer the moreporkmug question/);
  assert.doesNotMatch(prompt, /Jan Jansen/);
});
