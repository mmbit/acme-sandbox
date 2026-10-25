// node --test src/calls.test.ts   (uses a throwaway DATA_DIR): what the board says, on a call or the intercom, reaches a job
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('calls');
const { db, jobs } = h;
const chat = await import('./chat.ts');

const TRANSCRIPT = 'Board: the support chat has no live person; a person is reached by email only.';
// Each test starts with nothing queued, nothing unsent on the intercom and no calls.
const fresh = () => db.exec('delete from jobs; delete from wakes; delete from chat; delete from calls; delete from call_items; delete from call_tokens; delete from requests');
// The board on the intercom, and what HQ's intercom shows.
const say = async (text: string) => assert.equal((await h.board('/api/chat', { text })).status, 200);
const messages = async () => (await h.board('/api/chat')).body.messages as { who: string; text: string }[];
const chatJobs = () => (jobs.listJobs() as any[]).filter(j => j.kind === 'chat').sort((a, b) => a.id - b.id);
// The note a job's next run is handed (the claim gives it to the worker).
const noteOf = (id: number) => (db.prepare('select note from jobs where id = ?').get(id) as { note: string | null }).note ?? '';
// The worker takes the job (the intercom's turns on their own slot). A failed intercom turn is tried again in two
// minutes: time moving on, set here.
async function run(id: number) {
  db.prepare('update jobs set not_before = 0 where id = ?').run(id);
  const j = h.job(id);
  return (await h.claim(j.engine, j.kind === 'chat' ? { kind: 'chat' } : {}))!;
}
const turn = async (id: number, body: Record<string, unknown> = { status: 'failed' }) => { const job = await run(id); await h.finish(job, body); return job; };
const fails = async (id: number, n = 3) => { for (let i = 0; i < n; i++) await turn(id); };
// The calls in HQ's call log, the latest first, and the voice line's ends of a call.
const calls = async () => (await h.board('/api/calls')).body as { id: number; job: number; state: string; items: { what: string }[] }[];
const context = async (agent: string, o: Record<string, unknown> = {}) => (await h.voice('call-context', { agent, lang: 'en', ...o })).body;
const hangUp = (agent: string, lines: string[], o: Record<string, unknown> = {}) => h.voice('call-end', { agent, lines, ...o });
// Juno's intercom turn parked on a card about the board's question.
async function parkedChat(question = 'Should the support chat have a person on it?', card: Record<string, unknown> = { title: 'A person on the support chat?' }) {
  await say(question);
  const asker = chatJobs().at(-1)!;
  await h.finish(await run(asker.id), { status: 'parked', request: { kind: 'decision', body: 'Yes or no?', ...card } });
  assert.equal(h.job(asker.id).status, 'blocked');
  const req = (await h.board('/api/requests')).body.find((c: any) => c.job === asker.id).id as number;
  return { asker, req };
}

test('an intercom turn that fails three times starts over with the call, and a second failure keeps it for next time', async () => {
  fresh();
  chat.say(`We just had a call. The transcript:\n\n${TRANSCRIPT}`, 'Call with Juno · about 1 min');   // (a CEO call's hand-over)
  const [first] = chatJobs().slice(-1);
  for (let attempt = 1; attempt <= 3; attempt++)
    assert.match((await turn(first.id)).note ?? '', /support chat has no live person/, `attempt ${attempt} is given the transcript`);
  assert.equal(h.job(first.id).status, 'failed');
  const again = chatJobs().at(-1)!;
  assert.notEqual(again.id, first.id);
  assert.equal(again.status, 'queued');
  assert.match(noteOf(again.id), /support chat has no live person/, 'the fresh session hears the call');
  assert.match((await messages()).filter(m => m.who === 'juno').at(-1)!.text, /starting over/);

  // the fresh session fails too: no endless loop, and the next message brings the call along
  await fails(again.id);
  assert.equal(chatJobs().at(-1)!.id, again.id, 'no third job on its own');
  await say('Did you get that?');
  const next = chatJobs().at(-1)!;
  assert.notEqual(next.id, again.id);
  assert.match(noteOf(next.id), /support chat has no live person[\s\S]*Did you get that\?/);
  assert.match(noteOf(next.id), /don't do it twice/, 'the third session is warned too');
});

test('after a fresh session recovers, a later failed turn is tried again twice, then starts over again', async () => {
  fresh();
  await say('call A');
  await fails(chatJobs().at(-1)!.id);
  const again = chatJobs().at(-1)!;
  assert.match(again.title, /starting over/);
  await turn(again.id, { status: 'done', result: 'Got call A' });
  assert.doesNotMatch(h.job(again.id).title, /starting over/, 'the recovered job is the ordinary chat job again');
  await say('Another question');
  await turn(again.id, { status: 'done', result: 'Answered' });

  await say('call B');
  for (let attempt = 1; attempt <= 2; attempt++) {
    await turn(again.id);
    assert.equal(h.job(again.id).status, 'queued', `failure ${attempt} is tried again in the same session`);
    assert.match(noteOf(again.id), /call B/);
  }
  await turn(again.id);
  const next = chatJobs().at(-1)!;
  assert.notEqual(next.id, again.id, 'the third failure starts over in a fresh session');
  assert.equal(next.status, 'queued');
  assert.match(noteOf(next.id), /call B/);
  assert.doesNotMatch(noteOf(next.id), /call A|Another question/);
});

test('an intercom line reaches Juno once: a message sent mid-turn waits for the next turn, an answered one is not sent again', async () => {
  fresh();
  await say('First question');
  const j = chatJobs().at(-1)!, running = await run(j.id);
  await say('Second, while Juno is still answering');   // waits for the next turn
  await h.finish(running, { status: 'done', result: 'Answer to the first' });
  assert.equal(h.job(j.id).status, 'queued');
  const second = await run(j.id);
  assert.match(second.note ?? '', /Second, while Juno/);
  assert.doesNotMatch(second.note ?? '', /First question/);
  await h.finish(second, { status: 'done', result: 'Answer to the second' });
  assert.equal(h.job(j.id).status, 'done');
});

test("an intercom reply past about 80 words is the board's in full, and Juno's next turn hears its length once", async () => {
  fresh();
  const long = Array(130).fill('word').join(' ');
  await say('How is the store link coming along?');
  const j = chatJobs().at(-1)!;
  await h.finish(await run(j.id), { status: 'done', result: long });
  assert.equal((await messages()).at(-1)!.text, long, 'never cut or refused');
  await say('Thanks, and the glow?');
  const next = await run(j.id);
  assert.match(next.note ?? '', /\b130 words\b[\s\S]*Thanks, and the glow\?$/);
  await h.finish(next, { status: 'parked', request: { kind: 'decision', title: 'The glow?', body: 'Keep it?' } });
  await say('Great');
  const after = await run(j.id);
  assert.doesNotMatch(after.note ?? '', /\bwords\b/, 'once, also when the turn that heard it parked');
  await h.finish(after, { status: 'done', result: '🙂' });
});

// kit's job, parked on a card the board answered with the transcript's words: they're its note.
async function heardJob() {
  const job = await h.start({ agent: 'kit', title: 'The board on: the coming-soon page' });
  await h.answer(await h.park(job, { kind: 'decision', title: 'Which page?' }), TRANSCRIPT);
  return job.id;
}

test('a work job cut off before its session started gets its note again, once, with a line saying so', async () => {
  fresh();
  const id = await heardJob();
  assert.match((await turn(id, { status: 'interrupted' })).note ?? '', /support chat has no live person/);
  const once = noteOf(id);
  assert.match(once, /^You were paused/);
  assert.match(once, /support chat has no live person/);
  await turn(id, { status: 'limited', resetAt: 0 });
  assert.equal(noteOf(id), once, 'a second pause adds nothing');
  await turn(id, { status: 'done', result: 'ok' });
  assert.equal(noteOf(id), '');
});

test('a job whose worker vanished is queued again with its note and the line saying so', async () => {
  fresh();
  const id = await heardJob();
  await run(id);
  db.prepare('update jobs set heartbeat = 0 where id = ?').run(id);   // no word from its worker since: time moving on
  const again = await run(id);
  assert.match(again.note ?? '', /^You were paused[\s\S]*don't do it twice[\s\S]*support chat has no live person/);
});

test('a call about a request whose job is still running reaches a new job with the transcript', async () => {
  fresh();
  const asker = await h.start({ agent: 'kit', title: 'Coming-soon page' });   // a lead waiting with hq wait: it only ever hears the request's answer
  const req = (await h.agent('request', asker.token, { kind: 'decision', title: 'The coming-soon page', body: 'Which one?' })).body.id;
  await hangUp('kit', ['Board: go with the second one, and tell Juno about the mission.'], { request: req });
  const [{ job }] = await calls();
  assert.notEqual(job, asker.id);
  assert.equal(h.job(job).agent, 'kit');
  assert.equal(h.job(job).status, 'queued');
  const brief = (db.prepare('select prompt from jobs where id = ?').get(job) as { prompt: string }).prompt;   // the brief its run gets
  assert.match(brief, /tell Juno about the mission/);
  assert.match(brief, new RegExp(`job #${asker.id}, which asked, is still running`));
  assert.equal(h.job(asker.id).status, 'running', 'the running job carries on');
});

for (const via of ['a call', 'a desk phone answer']) test(`a parked intercom job resumed by ${via} that fails three times starts over with it`, async () => {
  fresh();
  const { asker, req } = await parkedChat();
  if (via === 'a call') await hangUp('juno', [TRANSCRIPT], { request: req });
  else assert.equal((await h.answer(req, 'Email only, never a live person.')).status, 200);
  const heard = via === 'a call' ? /support chat has no live person/ : /Email only, never a live person/;
  assert.match(noteOf(asker.id), heard, 'the parked job hears it');
  assert.doesNotMatch(noteOf(asker.id), /Should the support chat/, 'not the line its session already had');

  await fails(asker.id);
  assert.equal(h.job(asker.id).status, 'failed');
  const next = chatJobs().at(-1)!;
  assert.notEqual(next.id, asker.id);
  assert.equal(next.status, 'queued');
  assert.match(noteOf(next.id), heard, 'the fresh session hears it too');
  assert.match(noteOf(next.id), /Should the support chat have a person on it\?/);
  assert.match((await messages()).filter(m => m.who === 'juno').at(-1)!.text, /starting over/);
  if (via === 'a call') {
    assert.equal((await calls())[0].job, next.id, 'the call is logged against the job that hears it');
    assert.equal((await h.board('/api/requests')).body.find((c: any) => c.id === req).job, next.id, 'and so is its open request');
  }
});

test("a desk phone answer to Juno's request reaches the fresh session while it's running, after the next turn or a park", async () => {
  for (const ends of ['done', 'parked'] as const) {
    fresh();
    const { asker, req } = await parkedChat();
    await hangUp('juno', [TRANSCRIPT], { request: req });
    await fails(asker.id);
    const next = chatJobs().at(-1)!;
    const running = await run(next.id);
    assert.match(running.note ?? '', /already acted on something here, don't do it twice/, 'the fresh session is told it may be hearing it again');
    const before = chatJobs().length;
    assert.equal((await h.answer(req, 'Email only, never a live person.')).status, 200);
    assert.equal(chatJobs().length, before, 'no other chat job');
    assert.equal(h.job(next.id).status, 'running', 'the running turn carries on');
    await h.finish(running, ends === 'done' ? { status: 'done', result: 'Summary of the call' }
      : { status: 'parked', request: { kind: 'decision', title: 'Which email address?', body: 'support@ or hello@?' } });
    assert.equal(h.job(next.id).status, 'queued', `the turn that ended ${ends} is resumed with the answer`);
    assert.match(noteOf(next.id), /Email only, never a live person/);
    assert.doesNotMatch(noteOf(next.id), /support chat has no live person/, 'not the call it already heard');
    assert.ok((await messages()).some(m => m.text === `Answered request #${req} on the desk phone`), 'the chat shows it as one line');
  }
});

test('a call Juno hears again in a fresh session is logged against it, even once its request is closed', async () => {
  fresh();
  const { asker, req } = await parkedChat();
  await hangUp('juno', [TRANSCRIPT], { request: req });
  const running = await run(asker.id);
  assert.equal((await h.agent('request-close', running.token, { id: req })).status, 200);
  await h.finish(running, { status: 'failed' });
  await fails(asker.id, 2);
  const next = chatJobs().at(-1)!;
  assert.notEqual(next.id, asker.id);
  assert.match(noteOf(next.id), /support chat has no live person/);
  assert.equal((await calls())[0].job, next.id);
});

test('the board typing while Juno waits on the desk phone gets an answer meanwhile', async () => {
  fresh();
  const { asker } = await parkedChat();
  await say('Also: how are the brand films going?');
  assert.equal(h.job(asker.id).status, 'queued');
  assert.match(noteOf(asker.id), /brand films/);
});

test("the call agent's briefing: fixes to how the company works are the Process team's; hang_up once the board wrapped up; pictures only on HQ's screen", async () => {
  const screen = await context('juno'), phone = await context('juno', { phone: true });
  assert.match(screen.prompt, /Process team's to build/);
  assert.match(screen.prompt, /Never offer to\s+write a brief for the board's own Claude Code; that's for quick fixes the board chooses/);
  for (const ctx of [screen, phone]) {
    assert.match(ctx.prompt, /When the board has clearly wrapped up the call \(it said goodbye, asked you to end the call, or\s+thanked you to close it/);
    assert.match(ctx.prompt, /say a short goodbye of your own that fits the call \("Thank you, talk\s+soon\." is one example, not a set line\) and end it with hang_up in the same reply: no recap of what was queued or noted\s+unless the board asks for one/);
    assert.doesNotMatch(ctx.prompt, /say only "Thank you, talk soon/);
    assert.match(ctx.prompt, /Never tell the board that HQ will tell it if a time slips: it knows that rule/);
    assert.match(ctx.prompt, /A thank-you while the business is still going .* is\s+no wrap-up: carry on\. Never on a pause, and when you're unsure, stay on the line/s);
  }
  assert.match(screen.prompt, /show you pictures on screen/);
  assert.doesNotMatch(phone.prompt, /pictures/);
});

test("the call agent's briefing: no number for work is said aloud, on screen, by phone and in either language", async () => {
  for (const ctx of [await context('juno'), await context('juno', { phone: true }), await context('juno', { lang: 'nl' })])
    assert.match(ctx.prompt, /Never say a number for work aloud \(a job, card, pull request, call, item or pin\), not even once: .* Say what the work is and whose it is\. The numbers in this\s+briefing and in your tools' answers are for your tools/s);
});

test("the call agent's briefing: shifts reach the board only when an agreed deadline moves or it asks", async () => {
  const { prompt } = await context('juno');
  assert.match(prompt, /say nothing about shifts unless an agreed deadline moves or the\s+board asks/);
  assert.match(prompt, /When its finish lands past the deadline, the deadline moves: say so\s+plainly/);
  // a tight or shrinking margin is for planning: the board hears of it only when it asks
  assert.match(prompt, /slack that keeps shrinking as work piles on, is yours to plan with: don't\s+mention it unless the board asks/);
  assert.doesNotMatch(prompt, /at stake|say so before the deadline moves|Tight, still made|a little tight|your judgment says the board wants/);
  assert.match(prompt, /queue it after that deadline's work \(after\) to\s+protect it, or now anyway: a real judgment each time/);
  assert.match(prompt, /Say a warning once: the earlier calls and the\s+intercom show what the board has already heard/);
});

test('a desk phone answer to a request the chat job asked reaches it after a later turn ended done', async () => {
  fresh();
  const { asker, req } = await parkedChat();
  await say('Also: how are the brand films going?');
  await turn(asker.id, { status: 'done', result: 'Going well.' });
  assert.equal(h.job(asker.id).status, 'done');
  const before = chatJobs().length;
  assert.equal((await h.answer(req, 'Email only, never a live person.')).status, 200);
  assert.equal(chatJobs().length, before, 'no separate job for it');
  assert.equal(h.job(asker.id).status, 'queued', 'the chat job hears it, with the conversation');
  assert.match(noteOf(asker.id), /Email only, never a live person/);
});

test("brand.yaml's respellings go with a call's context, for the voice line to say", async () => {
  const file = `${h.repo}/company/brand.yaml`, was = readFileSync(file, 'utf8');
  try {
    assert.deepEqual((await context('kit')).respell, {});
    writeFileSync(file, `${was}\nspeech:\n  respell:\n    en: { Acme: Ak-mee }\n`);
    assert.deepEqual((await context('kit')).respell, { en: { Acme: 'Ak-mee' } });
  } finally {
    writeFileSync(file, was);
  }
});

test("a call's transcript and a desk phone answer stay out of other calls' briefings", async () => {
  chat.say('We just had a call. The transcript:\n\nBoard: the secret launch date is the ninth.', 'Call with Juno · about 1 min');
  const ctx = await context('kit');
  assert.doesNotMatch(ctx.prompt, /secret launch date/);
  assert.match(ctx.prompt, /\(Call with Juno · about 1 min\)/);
});

// The panel's review of PR #204 (job #1918): a call about Juno's key request after the chat job that asked has failed is
// heard by a new chat job.
test("a call about Juno's key request is heard by a fresh chat job, and a later fresh session hears that turn's lines again", async () => {
  fresh();
  const { asker, req } = await parkedChat('Set up the wombatpay.', { kind: 'credential', title: 'Keys for the wombatpay', body: 'Type them in.', secrets: 'STRIPE_TEST_WOMBAT_KEY' });
  const juno = await h.start({ agent: 'juno', title: 'Tidy the desk phone' });
  assert.equal((await h.agent('request-close', juno.token, { id: req })).status, 200);
  await say('Any news on the wombatpay?');   // the parked turn goes on, and fails
  await fails(asker.id);
  const next = chatJobs().at(-1)!;
  await fails(next.id);   // its fresh session fails too, and waits for the next line
  await hangUp('juno', ['Board: the wombatpay key is in the card now.'], { request: req });
  const heard = chatJobs().at(-1)!;
  assert.notEqual(heard.id, next.id);
  assert.equal((await calls())[0].job, heard.id);
  // a fresh session after a failed turn hears that turn's lines again
  await fails(heard.id);
  await say('Did the wombatpay go live?');
  assert.match(noteOf(chatJobs().at(-1)!.id), /wombatpay key is in the card[\s\S]*Did the wombatpay go live/);
});

// The board's rule (job #5934): nothing is hidden for its topic. A call about a customer card and the intercom lines
// around it reach the board and the next call's briefing whole.
test("a call about a customer card and the intercom's lines reach the board and a call's briefing whole", async () => {
  fresh();
  const asker = await h.start({ agent: 'kit', title: 'Refund for a customer', customers: true });
  const req = jobs.createRequest({ kind: 'decision', title: 'Refund the koala mug?', body: 'It arrived cracked.', agent: 'kit', job: asker.id, customers: true }) as { id: number };
  const ctx = await context('kit', { request: req.id });
  await hangUp('kit', ['Board: yes, refund the koala mug in full.'], { request: req.id, token: ctx.token });
  const follow = await run((await calls())[0].job);
  const item = { call: ctx.call, kind: 'decision', owner: 'kit', what: 'Refund the koala mug in full', quote: 'Board: yes, refund the koala mug in full.' };
  assert.equal((await h.agent('item', follow.token, item)).status, 200);
  assert.deepEqual((await calls()).find(c => c.id === ctx.call)?.items.map(i => i.what), ['Refund the koala mug in full'], 'the board sees the item');
  await say('Did Kit refund the koala mug?');
  assert.equal((await messages()).at(-1)!.text, 'Did Kit refund the koala mug?');
  const next = await context('bolt');
  assert.match(next.prompt, /Board: Did Kit refund the koala mug\?/);
  assert.match(next.prompt, /#\d+: Refund the koala mug in full \(kit\)/, 'and so does every call briefing');
});

// A customer's details stay with the jobs that hold them (charter rule 7): the notes of the CEO's call about a customer card,
// and the replies of a chat job that heard them, reach the board's intercom whole and other calls' briefings as a
// placeholder.
test("the notes of a call about a customer card, and the CEO's replies after hearing them, stay out of other calls' briefings", async () => {
  fresh();
  const card = jobs.createRequest({ kind: 'decision', title: 'Refund case C-21?', body: 'Jan Jansen, cracked mug', agent: 'juno', customers: true }) as { id: number };
  const ctx = await context('juno', { request: card.id });
  await hangUp('juno', ['Board: refund Jan Jansen.'], { request: card.id, token: ctx.token });
  const follow = await run((await calls())[0].job);
  await h.agent('item', follow.token, { call: ctx.call, kind: 'decision', owner: 'juno', what: 'Refund Jan in full', quote: 'Board: refund Jan Jansen.' });
  await h.agent('reply', follow.token, { text: 'Refunded Jan Jansen in full.' }); // (its reply)
  await h.finish(follow, { status: 'done', result: 'Refunded Jan Jansen in full.' });
  await say('Thanks. Anything else?');
  const asker = chatJobs().at(-1)!;
  assert.deepEqual((await h.worker('customers', { job: asker.id })).body, { customers: true }, 'the chat job heard the notes');
  await turn(asker.id, { status: 'done', result: 'Jan Jansen also asked for a new mug.' });
  assert.deepEqual((await messages()).slice(-3).map(m => m.text),
    ['Refunded Jan Jansen in full.', 'Thanks. Anything else?', 'Jan Jansen also asked for a new mug.'], 'the board reads them whole');
  const other = await context('penny');
  assert.doesNotMatch(other.prompt, /Jan Jansen/);
  assert.match(other.prompt, /Board: Thanks\. Anything else\?/);
  assert.match(other.prompt, /Juno: \(a reply that holds a customer's details/);
});

test("a call's briefing lists the board's earlier lines today by their first words, and says the whole intercom is there to look up", async () => {
  fresh();
  await say('Should make sure you have the intercom available when we call, and the rest of this long line is cut off.');
  for (let i = 1; i <= 24; i++) db.prepare('insert into chat (ts, who, text, sent) values (?, ?, ?, 1)').run(new Date().toISOString(), i % 2 ? 'juno' : 'board', `Small talk, line ${i}.`);
  const { prompt } = await context('bolt');
  assert.match(prompt, /Earlier today, the board's lines by their first words:\n- \d\d:\d\d Board: Should make sure you have the intercom available when we call, and the rest…\n/);
  assert.match(prompt, /before you tell the board something wasn't asked or written down, look there/);
  assert.match(prompt, /Latest in the intercom chat:\nJuno: Small talk, line 17\./, 'the latest eight lines are shown whole');
  assert.doesNotMatch(prompt, /- \d\d:\d\d Board: Small talk, line 2[0-4]\./, 'none of the latest twice');
});

test("a long intercom line and a long request reach the call's briefing whole or cut, and the call still starts (under 128 KiB)", async () => {
  fresh();
  await say(`Board: ${'the header should breathe more on phones, '.repeat(30)}and the last thing I said.`);   // about 1,300
  assert.ok((await context('bolt')).prompt.includes('and the last thing I said.'), 'a line under 2,000 characters is whole');
  await say('é'.repeat(150_000));   // two bytes each
  const asker = await h.start({ agent: 'bolt', title: 'Ask about the header' });
  const ask = async (title: string, body: string) => (await h.agent('request', asker.token, { kind: 'decision', title, body })).body.id;
  // A near-limit request reaches the briefing whole, including its paste block
  let ctx = await context('bolt', { request: await ask('Header', `Which header?\n\n\`\`\`\n${'Which header? '.repeat(1000)}\n\`\`\`\nThe end of the request.`) });
  assert.match(ctx.prompt, /Board: é{2000}… \(cut here\)/);
  assert.ok(ctx.prompt.includes('The end of the request.'), 'a request body under 20,000 characters is whole');
  assert.ok(Buffer.byteLength(ctx.prompt) < 128 * 1024);
  assert.equal(spawnSync('true', ['--system-prompt', ctx.prompt]).error, undefined, 'the process starts');
  // (longer than hq request takes: a card a tool filed)
  const huge = jobs.createRequest({ kind: 'decision', title: 'Huge', body: 'x'.repeat(30_000), agent: 'bolt', job: asker.id }) as { id: number };
  ctx = await context('bolt', { request: huge.id });
  assert.match(ctx.prompt, /x{20000}… \(cut here: the request has 30,000 characters\)/);
});

// Bolt's #2373: the voice line restarts a call agent that died or hung mid-call, with the call's token. It's the same
// call: one row and one token, and what was noted on it before the restart.
test('a call agent restarted mid-call stays on the same call: one row, one token, its items', async () => {
  fresh();
  const asker = await h.start({ agent: 'kit', title: 'Refund for Jan' });
  const req = (await h.agent('request', asker.token, { kind: 'decision', title: 'Refund Jan?', body: 'Yes or no?' })).body.id;
  const rows = () => (db.prepare('select count(*) n from calls').get() as { n: number }).n;
  const first = await context('kit', { request: req }), n = rows();
  const noted = { kind: 'promise', owner: 'kit', what: 'Send Jan the refund today', quote: 'Kit: I will send it today.' };
  assert.equal((await h.agent('item', first.token, noted)).status, 200);
  const again = await context('kit', { request: req, token: first.token });
  assert.equal(rows(), n, 'no second call row');
  assert.equal(again.token, first.token, 'one token');
  assert.equal(again.call, first.call);
  assert.match(again.prompt, /Already noted on this call[\s\S]*#\d+: Send Jan the refund today \(promise for kit, open\)/, "the new session doesn't note it twice");
  assert.equal(again.model, first.model);
  await hangUp('kit', ['Board: yes, refund Jan.', 'Kit: I will send it today.'], { request: req, token: again.token });
  const ended = (await calls()).find(c => c.id === first.call)!;
  assert.equal(ended.state, 'ended');
  assert.deepEqual(ended.items.map(i => i.what), [noted.what], 'the item is on the call with the transcript');
  assert.equal((await h.agent('item', first.token, noted)).status, 401, 'the token ends with the call');
});

// The voice line restarts an agent whose reply the hang-up cut off, after the hand-over revoked its token: the call has
// ended, and no new one starts.
test('a restart with the token of a call that has ended is refused: no new call, no new token', async () => {
  const first = await context('kit');
  await hangUp('kit', ['Board: can you build the page?'], { token: first.token });
  const count = (table: string) => (db.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;
  const before = { calls: count('calls'), tokens: count('call_tokens') };
  assert.equal((await h.voice('call-context', { agent: 'kit', lang: 'en', token: first.token })).status, 409);
  assert.deepEqual({ calls: count('calls'), tokens: count('call_tokens') }, before);
});

// A job queued on a call waits for the call to end (server.ts, wakes.ts ended), so what the board adds on the call goes
// into its brief and it starts whole. One the call's agent starts now runs at once.
test('a job queued on a call waits for the call to end, with what the call added in its brief, unless it starts now', async () => {
  fresh();
  const ctx = await context('kit');
  const queue = async (o: Record<string, unknown> = {}) =>
    (await h.agent('job', ctx.token, { agent: 'moss', title: 'Deck', prompt: 'Make the deck.', ...o })).body;
  const held = await queue(), now = await queue({ now: true });
  assert.equal(held.untilCall, ctx.call);
  assert.equal(now.untilCall, undefined);
  assert.equal((await h.claim())?.id, now.id, 'started now');
  assert.equal(await h.claim(), null, 'the other waits for the call');
  assert.equal((await h.agent('extend', ctx.token, { id: held.id, text: 'In Dutch.' })).body.added, 'brief');
  await hangUp('kit', ['Board: a deck, in Dutch.'], { token: ctx.token });
  const started = [(await h.claim())?.id, (await h.claim())?.id];   // (and the call's follow-up)
  assert.ok(started.includes(held.id), 'it starts once the call has ended');
  assert.match(noteOf(held.id), new RegExp(`call #${ctx.call} ended`));
  assert.match((db.prepare('select prompt from jobs where id = ?').get(held.id) as { prompt: string }).prompt, /Make the deck\.[\s\S]*In Dutch\./);
});

// What the board adds on a call to a job the call queued goes into that job (call.ts addToJob): a paused one
// reads it when it resumes, one parked on the board gets it as a job for its agent, and on a call about a customer card
// wherever it lands holds their details. A restarted call agent still adds to what the call queued.
test('what the board adds on a call reaches the job the call queued, wherever that job is', async () => {
  fresh();
  const asker = await h.start({ agent: 'kit', title: 'Refund for a customer', customers: true });
  const req = jobs.createRequest({ kind: 'decision', title: 'Refund the koala mug?', body: 'It arrived cracked.', agent: 'kit', job: asker.id, customers: true }) as { id: number };
  db.prepare("update jobs set status = 'done' where id = ?").run(asker.id);
  const ctx = await context('kit', { request: req.id });
  const queue = async (title: string) => (await h.agent('job', ctx.token, { agent: 'moss', title, prompt: 'Make the refund note.' })).body.id as number;
  const paused = await queue('Paused'), parked = await queue('Parked'), waiting = await queue('Waiting');
  db.prepare("update jobs set session = 's' where id = ?").run(paused);
  db.prepare("update jobs set status = 'blocked', session = 's' where id = ?").run(parked);
  const again = await context('kit', { request: req.id, token: ctx.token });   // (the voice line restarted the agent)
  const add = (id: number, text: string) => h.agent('extend', again.token, { id, text });
  const toPaused = (await add(paused, 'Say sorry first.')).body;
  assert.equal(toPaused.added, 'message');
  assert.equal((db.prepare('select job from messages where id = ?').get(toPaused.message) as { job: number }).job, paused, 'it waits for that job to resume');
  const toParked = (await add(parked, 'And a voucher.')).body;
  assert.equal(toParked.added, 'job');
  assert.equal(h.job(toParked.became).agent, 'moss');
  assert.match((db.prepare('select prompt from jobs where id = ?').get(toParked.became) as { prompt: string }).prompt, /An addition to your job #\d+ \(Parked\), from kit's call with the board[\s\S]*And a voucher\./);
  assert.equal((await add(waiting, 'In Dutch.')).body.added, 'brief');
  for (const id of [toParked.became, waiting]) assert.equal(jobs.holdsCustomerData(id), true, `#${id} holds the customer's details`);
  assert.equal((await add(asker.id, 'Not this call’s')).status, 409, 'only what this call queued');
  assert.equal((await add(waiting, ' ')).status, 400);
  const outside = await h.start({ agent: 'bolt', title: 'Elsewhere' });
  assert.equal((await h.agent('extend', outside.token, { id: paused, text: 'x' })).status, 404, "a job's hq extend still takes only work that never ran");
});

test("what the board adds on an ordinary call isn't kept in the events log", async () => {
  fresh();
  const before = (db.prepare('select coalesce(max(id), 0) id from events').get() as { id: number }).id;
  const ctx = await context('kit');
  const id = (await h.agent('job', ctx.token, { agent: 'moss', title: 'Parked', prompt: 'Make the note.' })).body.id as number;
  db.prepare("update jobs set status = 'blocked', session = 's' where id = ?").run(id);
  assert.equal((await h.agent('extend', ctx.token, { id, text: 'Add a lighthouse.' })).body.added, 'job');
  assert.equal((db.prepare("select count(*) n from events where id > ? and text like '%lighthouse%'").get(before) as { n: number }).n, 0);
});

// A call's additions have the call as their sender, as an hq say has its job: a second one for a job that can't take it
// mid-job joins the job the first became, a looping call agent stops at the hourly cap, and on a customer's call one
// that waited for a running job that ended unread becomes a job holding their details, with no words in the events log.
test("a call's additions join one job, stop at the hourly cap, and hold a customer's details wherever they end up", async () => {
  fresh();
  db.exec('delete from messages');   // (a call's number comes again once fresh() has emptied calls)
  const { jobEnded, PER_HOUR } = await import('./messages.ts');
  const before = (db.prepare('select coalesce(max(id), 0) id from events').get() as { id: number }).id;
  const asker = await h.start({ agent: 'kit', title: 'Refund for a customer', customers: true });
  const req = jobs.createRequest({ kind: 'decision', title: 'Refund the koala mug?', body: 'It arrived cracked.', agent: 'kit', job: asker.id, customers: true }) as { id: number };
  db.prepare("update jobs set status = 'done' where id = ?").run(asker.id);
  const ctx = await context('kit', { request: req.id });
  const queue = async (agent: string, title: string) => (await h.agent('job', ctx.token, { agent, title, prompt: 'Make the refund note.' })).body.id as number;
  const parked = await queue('moss', 'Parked'), running = await queue('bolt', 'Running');
  db.prepare("update jobs set status = 'blocked', session = 's' where id = ?").run(parked);
  db.prepare("update jobs set status = 'running', engine = 'claude' where id = ?").run(running);
  const add = (id: number, text: string) => h.agent('extend', ctx.token, { id, text });

  const first = (await add(parked, 'And a voucher.')).body, second = (await add(parked, 'Make it ten euros.')).body;
  assert.equal(second.became, first.became, "the second joins the job the first became");
  const prompt = (db.prepare('select prompt from jobs where id = ?').get(first.became) as { prompt: string }).prompt;
  assert.match(prompt, /And a voucher\.[\s\S]*Added by kit on a call with the board[\s\S]*Make it ten euros\.[\s\S]*Another addition by kit/);
  assert.doesNotMatch(prompt, /hq say/, 'nothing to answer: the call has ended');

  const unread = (await add(running, 'Say sorry first.')).body;
  assert.equal(unread.added, 'message');
  db.prepare("update jobs set status = 'done' where id = ?").run(running);
  jobEnded(running);
  const became = (db.prepare('select became from messages where id = ?').get(unread.message) as { became: number }).became;
  assert.equal(h.job(became).agent, 'bolt');
  for (const id of [first.became, became]) assert.equal(jobs.holdsCustomerData(id), true, `#${id} holds the customer's details`);
  assert.equal((db.prepare("select count(*) n from events where id > ? and (text like '%voucher%' or text like '%ten euros%' or text like '%sorry%')").get(before) as { n: number }).n, 0,
    'the events log has their numbers only');

  for (let sent = 3; sent < PER_HOUR; sent++) assert.equal((await add(parked, `More, ${sent}.`)).status, 200);
  const capped = await add(parked, 'One too many.');
  assert.equal(capped.status, 429);

  const unrelated = await h.start({ agent: 'kit', title: 'Unrelated work' });
  assert.equal((await h.agent(`sent?id=${first.message}`, unrelated.token)).status, 404);
  assert.deepEqual((await h.agent('sent', unrelated.token)).body, []);
  assert.equal(jobs.holdsCustomerData(unrelated.id), false);
  await hangUp('kit', ['Board: add a voucher.'], { token: ctx.token });
  const followUp = (db.prepare('select job from calls where id = ?').get(ctx.call) as { job: number }).job;
  const authorized = await h.start({ agent: 'kit', call: ctx.call, title: 'Work on the call' });
  assert.equal(jobs.holdsCustomerData(authorized.id), false);
  const received = await h.agent(`sent?id=${first.message}`, authorized.token);
  assert.equal(received.status, 200);
  assert.match(received.body[0].text, /And a voucher/);
  assert.equal(jobs.holdsCustomerData(authorized.id), true, 'reading the call message marks its reader');
  const { sent } = await import('./messages.ts');
  assert.notEqual(sent('kit', { id: followUp, agent: 'kit' }, first.message), 404, 'the follow-up also sees delivery');
});

// The board's settled word to work under way (call.ts reach, hq say on a call), as often as it needs: a running Claude job's
// session reads it at its next step, and it's on the call's list, handled, so the follow-up sees it went (and hq sent
// what became of it). A job the call queued takes add; one that isn't running, runs on Codex or isn't the named
// colleague's is refused, and so is anything on a customer's call.
test('the call reaches a running job, as often as it needs, by its number and its agent; each goes on the call\'s list, handled', async () => {
  fresh();
  db.exec('delete from messages');
  const running = await h.start({ agent: 'moss', title: 'The site' }), codex = await h.start({ agent: 'bolt', title: 'Elsewhere' });
  db.prepare("update jobs set engine = 'claude' where id = ?").run(running.id);
  db.prepare("update jobs set engine = 'codex' where id = ?").run(codex.id);
  const waiting = jobs.createJob({ agent: 'moss', title: 'Not yet', prompt: 'x' }).id;
  const ctx = await context('juno');
  assert.match(ctx.prompt, new RegExp(`- #${running.id}, moss: The site \\(job on seat-\\d+, since [^)]*\\), in no thread\\.`), 'the briefing lists work under way by number');
  assert.match(ctx.prompt, /Reviews queued:\n- none/);
  assert.match(ctx.prompt, /When the board's settled word matters to work already under way before the call ends[\s\S]*pass it on with reach, as often as the board's word needs; anything still\s+being worked out goes to the follow-up\./);
  const own = (await h.agent('job', ctx.token, { agent: 'moss', title: 'Queued here', prompt: 'x' })).body.id as number;
  const reach = (job: number, to: string, text = 'Only something insecure blocks it now.') =>
    h.agent('message', ctx.token, { to, job, what: 'Only an insecure change blocks the site', text });
  const refused = async (job: number, to: string, why: RegExp) => {
    const r = await reach(job, to);
    assert.equal(r.status, 409, `#${job} for ${to}`);
    assert.match(r.body.error, why);
  };
  await refused(own, 'moss', /was queued on this call: put the board's word into it with add/);
  await refused(waiting, 'moss', /isn't running \(queued\): the follow-up passes it on/);
  await refused(codex.id, 'bolt', /runs on Codex, which can't take a message mid-job/);
  await refused(running.id, 'bolt', /is moss's \(The site\), not bolt's: check the number/);
  assert.equal(db.prepare('select count(*) n from messages').get()!.n, 0, 'nothing sent');

  const sent = (await reach(running.id, 'moss')).body;
  const m = db.prepare('select job, call, text from messages where id = ?').get(sent.message) as { job: number; call: number; text: string };
  assert.deepEqual({ job: m.job, call: m.call }, { job: running.id, call: ctx.call });
  assert.match(m.text, new RegExp(`^From juno's call with the board \\(call #${ctx.call}\\), for your job #${running.id} \\(The site\\) while it runs[\\s\\S]*\\n\\nOnly something insecure blocks it now\\.$`));
  const item = db.prepare('select kind, owner, what, status, job, ref from call_items where id = ?').get(sent.item) as Record<string, unknown>;
  assert.deepEqual({ ...item }, { kind: 'message', owner: 'moss', what: 'Only an insecure change blocks the site', status: 'handled', job: running.id,
    ref: `sent on call #${ctx.call} as message #${sent.message}` });
  const more = (await reach(running.id, 'moss', 'And keep the footer as it is.')).body;
  assert.ok(more.message > sent.message && more.item > sent.item, 'a second word on the same call goes through');
  assert.deepEqual({ ...db.prepare('select job from messages where id = ?').get(more.message) }, { job: running.id });

  const inbox = await h.agent('inbox', running.token, {});
  assert.equal(inbox.body[0].call, ctx.call, 'its session reads it as from the call');
  const said = 'Board: only block on something insecure.' + ' Check the page.'.repeat(450);
  await hangUp('juno', [said], { token: ctx.token });
  const followUp = (db.prepare('select job from calls where id = ?').get(ctx.call) as { job: number }).job;
  assert.match((db.prepare('select prompt from jobs where id = ?').get(followUp) as { prompt: string }).prompt, /So has a message item \(the board's word it passed on to work under way, recorded handled\)/);
  const { sent: sentOf } = await import('./messages.ts');
  const mine = sentOf('juno', { id: followUp, agent: 'juno' }) as { id: number; call?: number; offered: string | null }[];
  assert.deepEqual(mine.map(x => [x.id, x.call, !!x.offered]), [[more.message, ctx.call, true], [sent.message, ctx.call, true]], "the follow-up's hq sent shows it");

  // The follow-up checks the call agent's words against the transcript: the job hears the board's own, then that it's withdrawn
  const follow = await run(followUp);
  const before = (db.prepare('select coalesce(max(id), 0) id from events').get() as { id: number }).id;
  for (const quote of ['x'.repeat(9600), '\\'.repeat(4000)]) {
    const refused = await h.agent('item', follow.token, { replaces: sent.item, what: 'Correct the guidance', quote });
    assert.equal(refused.status, 400, 'a correction that cannot be delivered is refused before recording it');
    assert.equal(h.job(running.id).status, 'running');
    assert.equal((db.prepare('select status from call_items where id = ?').get(sent.item) as { status: string }).status, 'handled');
    assert.equal((db.prepare('select count(*) n from call_items where replaces = ?').get(sent.item) as { n: number }).n, 0);
  }
  const fixed = (await h.agent('item', follow.token, { replaces: sent.item, what: 'Only an insecure change blocks the site', quote: said })).body;
  assert.deepEqual([fixed.kind, fixed.status, fixed.cancelled, h.job(running.id).status], ['message', 'handled', [], 'running'], 'guidance cancels no work');
  const told = (r: { told: { job: number; message: number }[] }) => {
    assert.deepEqual(r.told.map(t => t.job), [running.id]);
    return (db.prepare('select text from messages where id = ?').get(r.told[0].message) as { text: string }).text;
  };
  assert.match(told(fixed), /was misheard: the board's words, from the call's transcript/);
  assert.ok(told(fixed).includes(JSON.stringify(said)), 'an accepted long correction reaches the recipient whole');
  assert.equal((db.prepare('select count(*) n from events where id > ? and instr(text, ?) > 0').get(before, said) as { n: number }).n, 0, 'the transcript stays out of HQ events');
  const dropped = (await h.agent('item-drop', follow.token, { id: fixed.id, why: 'The board took it back' })).body;
  assert.match(told(dropped), /is withdrawn: The board took it back\. Don't go by it any more\./);
  assert.match((await h.agent('item-drop', follow.token, { id: fixed.id, why: 'Again' })).body.error, /isn't open/, 'once');
});

test("a customer's call reaches no running job: their details stay with its follow-up", async () => {
  fresh();
  const running = await h.start({ agent: 'moss', title: 'The site' });
  db.prepare("update jobs set engine = 'claude' where id = ?").run(running.id);
  const asker = await h.start({ agent: 'kit', title: 'Refund for a customer', customers: true });
  const req = jobs.createRequest({ kind: 'decision', title: 'Refund the koala mug?', body: 'It arrived cracked.', agent: 'kit', job: asker.id, customers: true }) as { id: number };
  db.prepare("update jobs set status = 'done' where id = ?").run(asker.id);
  const ctx = await context('kit', { request: req.id });
  const r = await h.agent('message', ctx.token, { to: 'moss', job: running.id, what: 'x', text: 'The customer is Ann.' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /passes nothing on mid-call/);
});

test("the board's language: one setting, offered only as the languages that work end to end, for calls and jobs", async () => {
  try {
    fresh();
    assert.deepEqual((await h.board('/api/language')).body.lang, 'en', 'English until the board picks one');
    assert.deepEqual((await h.board('/api/language')).body.languages.map((l: any) => l.code), ['en', 'nl', 'de']);
    const refused = await h.board('/api/language', { lang: 'fr' });
    assert.equal(refused.status, 400);
    assert.match(JSON.stringify(refused.body), /en, nl, de/);
    assert.equal((await h.board('/api/language')).body.lang, 'en', 'a refusal changes nothing');
    assert.equal((await h.board('/api/language', { lang: 'de' })).body.lang, 'de');
    assert.equal((await h.board('/api/language')).body.lang, 'de');
    assert.match((await context('juno', { lang: 'de' })).prompt, /Speak German\./);
    assert.match((await context('juno', { lang: 'xx' })).prompt, /Speak English\./, "a language the line doesn't know is English");
    // the job's briefing names it (the worker's prompt reads company.language)
    const id = h.queue({ agent: 'juno' });
    const job = await h.claim(h.job(id).engine);
    assert.equal(job?.company?.language, 'German');
    await h.finish(job!);
  } finally {
    db.prepare("delete from settings where key = 'board.language'").run();
  }
});
