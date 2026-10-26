// node --test src/memory.test.ts   (#934: hq search, hq history, hq call over the shared files and each agent's own work)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { harness, type Running } from './harness.ts';

const h = await harness('memory');
const { db, voice, agent } = h;
const memory = await import('./memory.ts');
const q = encodeURIComponent;

const running = (agent: string) => h.start({ agent, title: `test job for ${agent}` });
// A job of the agent's that ran and ended with this report (customers: a tool handed it a customer's details)
async function finished(agent: string, title: string, result: string, { customers = false, pr = 0, before }: { customers?: boolean; pr?: number;
  before?: (j: Running) => Promise<unknown> } = {}) {
  const j = await h.start({ agent, title, customers });
  await before?.(j);
  assert.equal((await h.finish(j, { result, ...(pr ? { pr, branch: `job/${j.id}`, sha: 'abc' } : {}) })).status, 200);
  return j.id;
}
// A job the queue has (a call's follow-up) runs: the worker claims it on its engine, what's queued ahead of it run and done first.
async function run(id: number): Promise<Running> {
  let j;
  while ((j = await h.claim(h.job(id).engine)) && j.id !== id) await h.finish(j, { result: 'Done.' });
  return j ?? assert.fail(`job #${id} is the one the worker claims`);
}
// A call with the board, as the voice line has it, and its follow-up, done with this report (none: still at work).
async function call(agent: string, lines: string[], report: string, request?: number) {
  const ctx = await h.liveCall(agent, request);
  assert.equal((await voice('call-end', { agent, lines, token: ctx.token, ...(request ? { request } : {}) })).status, 200);
  const follow = await run((await h.board('/api/calls')).body.find((c: any) => c.id === ctx.call).job);
  if (report) await h.finish(follow, { result: report });
  return { id: ctx.call as number, follow };
}
const hits = async (token: string, s: string) => (await agent(`search?q=${q(s)}&limit=30`, token)).body.hits.map((x: any) => x.pointer) as string[];
const holds = async (j: { id: number }) => (await h.worker('customers', { job: j.id })).body.customers as boolean;

// Penny's own work (a job with a PR, the requests it asked, one for keys, a call), Wren's, and Poppy's (handed a customer's
// details). Job ids ahead of request ids (an earlier job of someone else's first), so a '#n' names one of them.
await finished('kit', 'An earlier job', 'Done.');
const wrens = await finished('wren', 'Wren ships the wobblecart', 'The wobblecart job is done.');
const poppys = await finished('poppy', 'Answer a customer', 'Replied to the customer about the platypusorder refund.', { customers: true });
const { id: callId, follow: { id: follow } } = await call('penny', ['Board: how did you record the ferretledger?', 'Penny: in DECISIONS.'],
  'Took the ferretledger call: filed the seat change.');
let asked = 0, keys = 0;
const seat = await finished('penny', 'Record the seat decision', 'Recorded the quokkaseat decision: keep the Max plan until revenue. PR open.', { pr: 9101,
  before: async j => {
    asked = await h.ask(j, { urgency: 'today', title: 'Quokkaseat: switch the Claude seat?', body: 'Max forbids business use.' });
    keys = await h.ask(j, { kind: 'credential', urgency: 'today', title: 'Keys for the narwhalbank', body: 'Enter the narwhalbank keys.', secrets: 'STRIPE_TEST_NARWHAL_KEY' });
  } });
await h.answer(asked, 'Keep Max until there is revenue.');
await memory.refresh();

test('Search finds the Handbook by its words, for anyone; exact numbers hit; an empty query is refused; every word counts', async () => {
  const wren = await running('wren');
  const mission = await agent('search?q=mission', wren.token);
  assert.equal(mission.status, 200);
  const charter = mission.body.hits.find((x: any) => x.source === 'handbook');
  assert.match(charter.pointer, /^company\/CHARTER\.md:\d+$/);
  assert.equal(charter.title, 'Charter › Mission');
  const exact = await agent(`search?q=${q(`#${wrens}`)}&limit=3`, wren.token);
  assert.equal(exact.body.hits[0].pointer, `hq history '#${wrens}'`);
  assert.equal((await agent('search?q=', wren.token)).status, 400);
  // A long query is taken whole, and the word after twenty others still counts.
  const long = await agent(`search?q=${q(`${'and '.repeat(150)}mission`)}`, wren.token);
  assert.ok(long.body.hits.some((x: any) => x.title === 'Charter › Mission'));
  const many = await agent(`search?q=${q(`${Array.from({ length: 20 }, (_, i) => `zork${i}`).join(' ')} mission`)}`, wren.token);
  assert.ok(many.body.hits.some((x: any) => x.title === 'Charter › Mission'));
});

test("An agent's jobs and requests are its own, a key request's too, and a customer-data job's report is that job's alone (the board's calls are everyone's)", async () => {
  const penny = await running('penny'), wren = await running('wren'), poppy = await running('poppy');
  assert.ok((await hits(penny.token, 'quokkaseat')).includes(`hq history '#${seat}'`));
  assert.ok((await hits(penny.token, 'quokkaseat')).includes(`hq history '#${asked}'`));
  assert.ok((await hits(penny.token, 'ferretledger')).includes(`hq call ${callId}`));
  assert.deepEqual((await hits(wren.token, 'quokkaseat')).filter(p => p.startsWith('hq ')), []);
  assert.ok((await hits(wren.token, 'ferretledger')).includes(`hq call ${callId}`), "Penny's call with the board is shared (#1877)");
  assert.ok((await hits(wren.token, 'wobblecart')).includes(`hq history '#${wrens}'`));
  // Poppy's job was handed a customer's details: nobody finds it, not even Poppy's next job (charter rule 7)
  assert.deepEqual(await hits(poppy.token, 'platypusorder'), []);
  assert.deepEqual(await hits(penny.token, 'platypusorder'), []);
  assert.equal(await holds(poppy), false, 'left out, so nothing to hold');
  // a key request is its agent's like any other: a key's value never reaches its text (db.ts redacted())
  assert.ok((await hits(penny.token, 'narwhalbank')).includes(`hq history '#${keys}'`));
  assert.deepEqual(await hits(wren.token, 'narwhalbank'), []);
  // a live call's token searches as its agent
  const ctx = await voice('call-context?agent=penny');
  assert.ok((await hits(ctx.body.token, 'quokkaseat')).includes(`hq history '#${seat}'`));
  const other = await voice('call-context?agent=wren');
  assert.deepEqual((await hits(other.body.token, 'quokkaseat')).filter(p => p.startsWith('hq ')), []);
});

test('History: the agent\'s own jobs (PR, report), requests and calls, newest first; a query or #id narrows it', async () => {
  const penny = await running('penny'), wren = await running('wren');
  const mine = (await agent('history', penny.token)).body;
  assert.equal(mine.agent, 'penny');
  const job = mine.jobs.find((j: any) => j.id === seat);
  assert.deepEqual([job.status, job.pr.number, job.report], ['done', 9101, 'Recorded the quokkaseat decision: keep the Max plan until revenue. PR open.']);
  assert.ok(mine.jobs.every((j: any, i: number) => !i || mine.jobs[i - 1].id > j.id));
  assert.ok(mine.requests.some((r: any) => r.id === asked && r.answer === 'Keep Max until there is revenue.' && r.body === 'Max forbids business use.'));
  assert.deepEqual(mine.calls.map((c: any) => [c.id, c.job, c.pointer]), [[callId, follow, `hq call ${callId}`]]);
  const theirs = (await agent('history', wren.token)).body;
  assert.ok(!theirs.jobs.some((j: any) => j.id === seat) && !theirs.requests.some((r: any) => r.id === asked) && !theirs.calls.length);
  const found = (await agent(`history?q=${q('the quokkaseat decision')}`, penny.token)).body;
  assert.equal(found.jobs[0].id, seat);
  assert.equal(found.requests[0].id, asked);
  assert.deepEqual((await agent(`history?q=${q(`#${seat}`)}`, penny.token)).body.jobs.map((j: any) => j.id), [seat]);
  assert.deepEqual((await agent(`history?q=${q(`#${seat}`)}`, wren.token)).body.jobs, []);
  // a task's code finds its jobs: the task and its steps, here the board's answer to its card
  const coded = (await agent(`history?q=${q(job.code)}`, penny.token)).body;
  assert.deepEqual([coded.jobs.map((j: any) => [j.id === seat, j.code, j.title]), coded.requests, coded.calls],
    [[[true, job.code, 'Record the seat decision'], [false, job.code, 'The board on: Quokkaseat: switch the Claude seat?']], [], []]);
});

test("History shows its own agent what it did: a key request's text; a customer-data job by its title only, its report left out; never another agent's", async () => {
  const penny = await running('penny'), poppy = await running('poppy'), wren = await running('wren');
  const key = (await agent('history', penny.token)).body.requests.find((r: any) => r.id === keys);
  assert.deepEqual([key.title, key.status, key.body, key.answer], ['Keys for the narwhalbank', 'open', 'Enter the narwhalbank keys.', null]);
  for (const query of ['', `#${poppys}`]) {
    const one = (await agent(`history?q=${q(query)}`, poppy.token)).body.jobs.find((j: any) => j.id === poppys);
    assert.deepEqual([one.title, one.report, !!one.report_left_out], ['Answer a customer', null, true], query);
    assert.deepEqual((await agent(`history?q=${q(query)}`, wren.token)).body.jobs.filter((j: any) => j.id === poppys), [], query);
  }
  assert.deepEqual((await agent(`history?q=${q('platypusorder refund')}`, poppy.token)).body.jobs, [], 'its words find nothing');
  assert.equal(await holds(poppy), false);
});

test("A customer's details reach only the job working on them: hq call refuses its agent's next job with why, and the role's reader holds them once it reads, so it can't write to a guest", async () => {
  // a card a tool wrote a customer's details on (as the remedies kit does), and the board's call about it (with Dex: no
  // job runs as Poppy, on api, to follow it up)
  const card = h.jobs.createRequest({ kind: 'decision', title: 'Refund the walrusmug?', body: 'Mrs Jansen, Kerkstraat 1, wants a refund.', agent: 'dex', customers: true });
  const about = await call('dex', ['Board: yes, refund Mrs Jansen.'], 'Refunded the walrusmug.', card.id);
  const dex = await running('dex');
  const refused = await agent(`call?id=${about.id}`, dex.token);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, new RegExp(`call #${about.id} is about a customer, .*job #${about.follow.id}.*roles\\.customerData`));
  assert.equal(await holds(dex), false, 'a refused read holds nothing');
  // org.yaml's roles.customerData (Vera, in the fixture) reads it, and holds it from then on
  const vera = await running('vera');
  assert.deepEqual((await agent(`call?id=${about.id}`, vera.token)).body.lines, ['Board: yes, refund Mrs Jansen.']);
  assert.equal(await holds(vera), true);
  assert.equal((await agent('guest', vera.token, { guest: 'Sam', title: 'Hi', spec: '{}' })).status, 403);
  // the rest of its own history is no customer's
  await agent(`history?q=${q(`#${wrens}`)}`, dex.token);
  await agent(`call?id=${callId}`, dex.token);
  assert.equal(await holds(dex), false);
});

test('The worker and voice tokens get 401 on search, history and call, and the board\'s HQ has none of them', async () => {
  for (const route of ['search?q=mission', 'history', `call?id=${callId}`])
    for (const t of ['worker-secret', 'voice-secret', '', 'nope']) assert.equal((await agent(route, t)).status, 401, `${route} ${t}`);
  assert.equal((await h.call('/api/search?q=mission', 'x')).status, 404);
});

test('hq search, history and call print what the routes give (bin/hq against this coordinator)', async () => {
  const penny = await running('penny');
  const hq = async (...args: string[]) => (await h.hq(penny, ...args)).out;
  const searched = await hq('search', 'the quokkaseat decision', '3');
  assert.match(searched, /^\(Ranked by words only/);
  assert.match(searched, new RegExp(`Job #${seat}: Record the seat decision \\(done\\)\n  hq history '#${seat}'  \\[job\\]\n  Recorded the quokkaseat`));
  const said = await hq('history');
  for (const shown of [`#${seat} ${h.job(seat).code} Record the seat decision (done, PR #9101 `, 'Recorded the quokkaseat decision: keep the Max plan until revenue. PR open.',
    `#${asked} Quokkaseat: switch the Claude seat? (decision, answered,`, 'The board answered: Keep Max until there is revenue.',
    'Keys for the narwhalbank (credential, open,', 'Enter the narwhalbank keys.', `heard by job #${follow}: hq call ${callId}`]) assert.ok(said.includes(shown), shown);
  assert.match(await hq('history', `#${seat}`), /Your desk phone requests:\n {2}none\n/);
  const heard = await hq('call', String(callId));
  assert.ok(heard.includes('Board: how did you record the ferretledger?\nPenny: in DECISIONS.') && heard.includes('Took the ferretledger call: filed the seat change.'), heard);
  for (const bad of [['search'], ['search', 'x', 'lots'], ['call', '1; id'], ['call', '999999']]) assert.notEqual((await h.hq(penny, ...bad)).code, 0, bad.join(' '));
});

test("A review loop's work job is named by its step and round in history, as in search", async () => {
  const fix = await finished('gale', 'Gift wrap at checkout', 'Fixed the giftwrapnote finding.', {
    before: async j => h.db.prepare("update jobs set step = 'Fixing review notes', round = 2 where id = ?").run(j.id),
  });
  await memory.refresh();
  const gale = await running('gale');
  const named = 'Fixing review notes: Gift wrap at checkout (round 2)';
  assert.equal((await agent(`history?q=${q(`#${fix}`)}`, gale.token)).body.jobs[0].title, named);
  assert.ok((await h.hq(gale, 'history', `#${fix}`)).out.includes(`#${fix} ${h.job(fix).code} ${named} (done, `));
  assert.ok((await h.hq(gale, 'search', 'giftwrapnote')).out.includes(`Job #${fix}: ${named} (done)`));
});

test("A call about an answered request doesn't resume a job parked on another one: it becomes a job of its own", async () => {
  const j = await h.start({ agent: 'kit', title: 'Pick a printer' });
  const first = await h.ask(j, { urgency: 'today', title: 'Printer A or B?' });
  await h.answer(first, 'A.');
  const second = await h.park(j, { kind: 'decision', title: 'Paper C or D?' });
  const c = await call('kit', ['Board: about printer A, go ahead.'], '', first);
  assert.deepEqual([h.job(j.id).status, h.job(j.id).request], ['blocked', second], 'still waiting for its own answer');
  assert.notEqual(c.follow.id, j.id);
  assert.match(c.follow.prompt, /about printer A, go ahead/);
  await h.finish(c.follow);
});

test("A name a team member used in its lead's job is nobody else's: an alumnus's own job doesn't see what it sent", async () => {
  const lead = await running('penny');
  await h.worker('team', { job: lead.id, lead: 'penny', id: 'rivet', name: 'Rivet' });   // Penny brings the alumnus back
  const helper = await agent('message', lead.token, { to: 'lark', text: 'The seat numbers.', as: 'rivet' });
  assert.equal(helper.status, 200);
  const rivet = await running('rivet');
  assert.deepEqual((await agent('sent', rivet.token)).body, []);
  assert.equal((await agent(`sent?id=${helper.body.id}&as=rivet`, lead.token)).body[0].text, 'The seat numbers.');
});

test("A one-off fix that fails halfway isn't recorded as done: it runs again at the next start", async () => {
  const { once } = await import('./db.ts');
  assert.throws(() => once('test-halfway', () => { db.exec("update jobs set title = title where id = 0"); throw new Error('org.yaml unreadable'); }));
  assert.equal(db.prepare("select count(*) n from migrations where id = 'test-halfway'").get()!.n, 0);
  let ran = 0;
  once('test-halfway', () => { ran++; });
  once('test-halfway', () => { ran++; });
  assert.equal(ran, 1);
});

test("A query's '#n' numbers: the first five are looked up exactly, so a pasted list can't stall HQ; the rest count as words", async () => {
  const penny = await running('penny');
  const many = Array.from({ length: 40 }, (_, i) => `#${90000 + i}`).join(' ');
  const found = async (s: string) => (await hits(penny.token, s)).includes(`hq history '#${seat}'`);
  assert.equal(await found(`${many} #${seat}`), true, 'the sixth number on, by its word');
  assert.equal(await found(`#${seat} ${many}`), true);
});

test("A '#n' is that number, never a colour that starts with it", async () => {
  const penny = await running('penny');
  const ink = await finished('penny', 'Pick the ink', `The ink is \`#${seat}f7a3b\`, a deep green.`);
  memory.refresh();
  const found = await hits(penny.token, `#${seat}`);
  assert.ok(found.includes(`hq history '#${seat}'`));
  assert.ok(!found.includes(`hq history '#${ink}'`));
});

// A coordinator process of its own, on a fresh database and a copy of the test company with these files (prepare: anything
// more): what its script prints.
async function indexed(files: Record<string, string>, script: string, prepare?: (repo: string) => void) {
  const repo = mkdtempSync(`${tmpdir()}/memory-org-`), dir = mkdtempSync(`${tmpdir()}/memory-db-`);
  cpSync(`${process.env.REPO_DIR}/company`, `${repo}/company`, { recursive: true });
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(`${repo}/${f}`), { recursive: true }); writeFileSync(`${repo}/${f}`, text); }
  prepare?.(repo);
  return JSON.parse(await new Promise<string>((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, DATA_DIR: dir, SECRETS_DIR: `${dir}/secrets`, REPO_DIR: repo }, cwd: new URL('.', import.meta.url).pathname },
    (err, out, e) => err ? reject(new Error(e)) : resolve(out))));
}

test('A source folder that is itself a symlink (to order files, say) is never indexed', async () => {
  const out = await indexed({ 'products/orders/o1.md': '# Order 1\n\nThe emuorder for Jan Jansen, Kerkstraat 1.\n' }, `const memory = await import('./memory.ts'); await memory.refresh();
    console.log(JSON.stringify((await memory.search('emuorder', { id: 0, agent: 'penny' })).hits));`, repo => {
    mkdirSync(`${repo}/knowledge`, { recursive: true });
    rmSync(`${repo}/knowledge/notes`, { recursive: true, force: true });
    symlinkSync(`${repo}/products/orders`, `${repo}/knowledge/notes`);
  });
  assert.deepEqual(out, []);
});

test("History finds the agent's own work by a word that's in hundreds of the files' chunks (Penny #35)", async () => {
  // 350 notes with the word in their title (they outrank a job's report), under a fifth of all chunks (so it's a 'rare' word)
  const notes = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`knowledge/notes/n${i}.md`, i < 350 ? `# The wombatglue, part ${i}\n\nMore wombatglue.\n` : `# Note ${i}\n\nNothing here.\n`]));
  const out = await indexed(notes, `const jobs = await import('./jobs.ts'), memory = await import('./memory.ts');
    const { id } = jobs.createJob({ agent: 'penny', title: 'Price the glue', prompt: 'x', engine: 'glue' });
    jobs.claim('seat-1', 'glue');   // (as the worker's claim and finish routes run it)
    jobs.finish(id, { status: 'done', result: 'Priced the wombatglue at 4 euros.' });
    await memory.refresh();
    console.log(JSON.stringify({ id, found: (await memory.history({ id: 0, agent: 'penny' }, 'wombatglue')).jobs.map(j => j.id) }));`);
  assert.deepEqual(out.found, [out.id]);
});

test('An index pass takes turns with the server: three thousand new notes never hold it in one go', async () => {
  // the notes arrive at a running server, whose first pass has paid what a process pays once (the company's clock, say).
  // Then the longest the server waited for its next turn, against the whole pass (a busy machine slows both)
  const notes = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`arriving/n${i}.md`, `# Note ${i}\n\nThe quokkaturn, part ${i}.\n`]));
  const out = await indexed(notes, `const memory = await import('./memory.ts'), { mkdirSync, renameSync } = await import('node:fs');
    await memory.refresh();
    mkdirSync(process.env.REPO_DIR + '/knowledge');
    renameSync(process.env.REPO_DIR + '/arriving', process.env.REPO_DIR + '/knowledge/notes');
    let last = performance.now(), held = 0, on = true;
    const turn = () => { const now = performance.now(); held = Math.max(held, now - last); last = now; if (on) setImmediate(turn); };
    setImmediate(turn);
    const start = performance.now(), changed = await memory.refresh(), pass = performance.now() - start;
    on = false;
    console.log(JSON.stringify({ changed, held, pass, found: (await memory.search('quokkaturn', { id: 0, agent: 'penny' }, 30)).hits.length }));`);
  assert.ok(out.changed >= 3000, String(out.changed));
  assert.ok(out.held < out.pass / 3, `the pass held the server ${Math.round(out.held)} of its ${Math.round(out.pass)} ms in one go`);
  assert.equal(out.found, 30);
});

test('A file or job report is read again once it changed: an edit as long as before, and a key scrubbed out of a report', async () => {
  // [STRIPE_TEST_SHOP] is as long as the key, so the scrubbed report is too (secrets.ts redact())
  const out = await indexed({ 'knowledge/notes/a.md': '# Note A\n\nThe wallabyone is here.\n' }, `const jobs = await import('./jobs.ts'), memory = await import('./memory.ts');
    const { scrub } = await import('./db.ts'), secrets = await import('./secrets.ts'), { writeFileSync } = await import('node:fs');
    const KEY = 'wallabykey12345678';
    const { id } = jobs.createJob({ agent: 'penny', title: 'Count the wallabies', prompt: 'x', engine: 'glue' });
    jobs.claim('seat-1', 'glue');
    jobs.finish(id, { status: 'done', result: 'Counted the wallabytwo with ' + KEY + '.' });
    const found = async q => (await memory.search(q, { id: 0, agent: 'penny' })).hits.map(h => h.pointer);
    const first = await memory.refresh(), unchanged = await memory.refresh(), key = await found(KEY);
    writeFileSync(process.env.REPO_DIR + '/knowledge/notes/a.md', '# Note A\\n\\nThe wallabyxxx is here.\\n');
    secrets.saveSecrets(['STRIPE_TEST_SHOP'], { STRIPE_TEST_SHOP: KEY });
    scrub();
    const edited = await memory.refresh();
    console.log(JSON.stringify({ first: first > 0, unchanged, edited, key, scrubbed: await found(KEY), job: await found('wallabytwo'),
      now: await found('wallabyxxx'), was: await found('wallabyone') }));`);
  const job = out.job[0];
  assert.match(job, /^hq history '#\d+'$/);
  assert.deepEqual(out, { first: true, unchanged: 0, edited: 2, key: [job], scrubbed: [], job: [job], now: ['knowledge/notes/a.md:2'], was: [] });
});

// The archive (knowledge/archive/): its own source, below every live hit, each with its piece's note.
test('An archived piece and a live one on the same query: the live one first, the archived one marked with what replaced it', async () => {
  const out = await indexed({
    'knowledge/notes/platform/jobs.md': '# Chained jobs\n\nA job queued --after another waits for its merge. See the numbatqueue section.\n',
    // the archived note matches far better (the word in its title and all through it): it still comes second
    'knowledge/archive/notes/platform/jobs.md': '# The numbatqueue: lessons that stopped being true\n\nLessons from the note, word for word.\n\n' +
      '> Archived 2026-09-29 by the janitor: replaced by the note\'s lesson "Chained jobs".\n\nThe numbatqueue numbatqueue: queue on a branch, numbatqueue.\n',
    // a profile's archive: an intro, then two pieces, each with its own note, the first one two lines long
    'knowledge/archive/people/wren.md': '# Wren: archived profile lines\n\nOlder lines, word for word.\n\n## Track record\n\n' +
      '> Archived 2026-09-30 by the janitor: the track record keeps its 15 most recent entries;\n> the profile goes on from job #283.\n\n' +
      '- Job #265: fixed the numbatqueue gate.\n\n> Archived 2026-09-29 by Wren (job #1746): the profile goes on from job #200.\n\n- Job #100: built the gate.\n',
    'knowledge/archive/README.md': '# Archive\n\nThe numbatqueue README: not a piece, never indexed.\n',
  }, `const memory = await import('./memory.ts'), { library } = await import('./library.ts');
    await memory.refresh();
    console.log(JSON.stringify({ hits: (await memory.search('numbatqueue', { id: 0, agent: 'penny' }, 30)).hits, top: (await memory.search('numbatqueue', { id: 0, agent: 'penny' }, 1)).hits,
      library: library().map(d => d.path) }));`);
  const [live, ...old] = out.hits;
  assert.equal(live.pointer, 'knowledge/notes/platform/jobs.md:2');
  assert.equal(live.archived, undefined);
  assert.ok(old.length === 2 && old.every((x: any) => x.source === 'archive' && x.archived === true), JSON.stringify(old));
  assert.ok(old[0].score >= live.score, 'ranked below the live hit although it scores as well (each is the best of its own source)');
  assert.deepEqual(old.map((x: any) => [x.pointer, x.note]), [
    ['knowledge/archive/notes/platform/jobs.md:5', 'Archived 2026-09-29 by the janitor: replaced by the note\'s lesson "Chained jobs".'],
    ['knowledge/archive/people/wren.md:7', 'Archived 2026-09-30 by the janitor: the track record keeps its 15 most recent entries; the profile goes on from job #283.'],
  ], 'the README is not a piece');
  assert.deepEqual(out.top.map((x: any) => x.pointer), [live.pointer], 'a short list is all live hits');
  assert.ok(out.library.includes('knowledge/notes/platform/jobs.md') && !out.library.some((p: string) => p.startsWith('knowledge/archive')), 'the Library shows no archive');
  // hq search prints the live hits, then the archive under its own line, each with its note
  const bare = { ...old[1], pointer: 'knowledge/archive/people/wren.md:2', note: null };   // a hit on a file's intro
  const fake = createServer((req, res) => res.end(JSON.stringify({ hits: [...out.hits, bare] }))).listen(0);
  try {
    const printed = await new Promise<string>((resolve, reject) => execFile('bash', [new URL('../../worker/bin/hq', import.meta.url).pathname, 'search', 'numbatqueue'],
      { env: { PATH: process.env.PATH, HQ_URL: `http://localhost:${(fake.address() as AddressInfo).port}`, HQ_TOKEN: 't', HQ_AGENT: 'penny' } }, (err, o, e) => err ? reject(new Error(e)) : resolve(o)));
    const [first, rest] = printed.split('From the archive (history, not current: each says what replaced it):\n');
    assert.match(first, /^Chained jobs\n {2}knowledge\/notes\/platform\/jobs\.md:2 {2}\[note\]\n/);
    assert.equal(rest.match(/\[archived\]/g)?.length, 3);
    assert.match(rest, /wren\.md:2 {2}\[archived\]\n {2}Archived, with no note on why\.\n/);
    assert.match(rest, /\n {2}Archived 2026-09-29 by the janitor: replaced by the note's lesson "Chained jobs"\.\n/);
  } finally { fake.close(); }
});

test("The shared craft library is searched and shelved next to the company's own notes, labelled as craft; its README is neither", async () => {
  const out = await indexed({
    'knowledge/notes/brand/posters.md': '# Our posters\n\nOur posters keep the tapirmargin wide.\n',
    'shared/craft/print.md': '---\ntitle: Print files\nkind: note\n---\n\n# Print files\n\n## Bleed\n\nFill the bleed, and keep text inside the tapirmargin.\n',
    'shared/craft/README.md': '# The craft library\n\nThe tapirmargin README: the index, not a note.\n',
  }, `const memory = await import('./memory.ts'), { library } = await import('./library.ts');
    await memory.refresh();
    console.log(JSON.stringify({ hits: (await memory.search('tapirmargin', { id: 0, agent: 'penny' }, 30)).hits,
      library: library().map(d => [d.path, d.shelf, d.title]) }));`);
  assert.deepEqual(out.hits.map((x: any) => [x.source, x.pointer]).sort(),
    [['craft', 'shared/craft/print.md:9'], ['note', 'knowledge/notes/brand/posters.md:2']]);
  assert.equal(out.hits.find((x: any) => x.source === 'craft').title, 'Print files › Bleed');
  const shelves = out.library.map((d: string[]) => d[1]);
  assert.deepEqual(out.library.filter((d: string[]) => d[0].startsWith('shared/')), [['shared/craft/print.md', 'Shared craft', 'Print files']]);
  assert.ok(shelves.indexOf('Shared craft') > shelves.indexOf('Notes · brand'), "the company's own notes come first");
});

// The live-first order holds only if the archive can't crowd live chunks out of the candidates first.
test('Sixty archived pieces that match far better still come after the one live hit, by a word, a number and meaning', async () => {
  const files: Record<string, string> = {
    'knowledge/notes/platform/zorble.md': '# Zorble\n\nThe zorbleword queue, see job #4242.\n',
    // the fixture repo is small: enough other chunks that 61 with the word stay under a fifth (a rare word, ranked by words)
    'knowledge/notes/platform/filler.md': '# Filler\n\n' + Array.from({ length: 320 }, (_, i) => `## Section ${i}\n\nNothing to see, part ${i}.\n`).join('\n'),
  };
  for (let i = 0; i < 60; i++) files[`knowledge/archive/notes/platform/zorble-${i}.md`] = `# Zorbleword #4242, piece ${i}\n\n` +
    `> Archived 2026-09-29 by the janitor: replaced by the note "Zorble".\n\nZorbleword zorbleword zorbleword, job #4242.\n`;
  // by meaning, a word no file has: every archived piece nearer than the live note, which is still near enough to count
  const out = await indexed(files, `const memory = await import('./memory.ts');
    const near = (t, kind) => t.includes('#4242, piece') || t === 'zzmeaning' ? [1, 0, 0] : kind === 'query' ? [0, 1, 0]
      : t.includes('zorbleword queue') ? [0.9, Math.sqrt(0.19), 0] : [0, 0, 1];
    memory.setEmbedder(async (texts, kind) => texts.map(t => Float32Array.from(near(t, kind))), 'fake');
    await memory.refresh();
    await memory.embedAll();
    const s = async (q, n) => (await memory.search(q, { id: 0, agent: 'penny' }, n)).hits.map(h => [h.pointer, !!h.archived]);
    console.log(JSON.stringify({ word: await s('zorbleword', 30), number: await s('#4242', 30), meaning: await s('zzmeaning', 30),
      one: [await s('zorbleword', 1), await s('#4242', 1), await s('zzmeaning', 1)] }));`);
  for (const found of [out.word, out.number, out.meaning]) {
    assert.deepEqual(found[0], ['knowledge/notes/platform/zorble.md:2', false]);
    assert.equal(found.length, 30);
    assert.ok(found.slice(1).every(([, archived]: [string, boolean]) => archived), JSON.stringify(found));
  }
  assert.deepEqual(out.one, [0, 1, 2].map(() => [['knowledge/notes/platform/zorble.md:2', false]]));
});

// Rarity is judged per side: archived copies of a word must not make it common for the live chunks, or the live words'
// pass is skipped and a live chunk only its words find (too far by meaning) drops out under archived hits.
test("Sixty archived copies that make a word common still don't hide the one live chunk only words find", async () => {
  const files: Record<string, string> = { 'knowledge/notes/platform/wibble.md': '# Wibble\n\nThe wibbleword queue.\n' };
  for (let i = 0; i < 60; i++) files[`knowledge/archive/notes/platform/wibble-${i}.md`] = `# Wibbleword, piece ${i}\n\n` +
    `> Archived 2026-09-29 by the janitor: replaced by the note "Wibble".\n\nWibbleword, as it was.\n`;
  // every chunk embedded; the archived pieces near the question, the live note too far to count by meaning
  const out = await indexed(files, `const memory = await import('./memory.ts');
    memory.setEmbedder(async (texts, kind) => texts.map(t => Float32Array.from(kind === 'query' || t.includes(', piece ') ? [1, 0, 0] : [0, 0, 1])), 'fake');
    await memory.refresh();
    await memory.embedAll();
    const r = await memory.search('wibbleword', { id: 0, agent: 'penny' }, 30);
    console.log(JSON.stringify({ words: r.words ?? null, hits: r.hits.map(h => [h.pointer, !!h.archived]) }));`);
  assert.equal(out.words, null, 'every chunk is embedded');
  assert.deepEqual(out.hits[0], ['knowledge/notes/platform/wibble.md:2', false]);
  assert.equal(out.hits.length, 30);
  assert.ok(out.hits.slice(1).every(([, archived]: [string, boolean]) => archived), JSON.stringify(out.hits));
});

test("An archived piece's line stops at the next heading as high as its own: a profile's next section, not a whole note's", async () => {
  const out = await indexed({
    'knowledge/archive/people/kit.md': '# Kit: archived profile lines\n\n## Track record\n\n> Archived 2026-09-29 by the janitor: the 15 most recent stay.\n\n' +
      '- Job #12: the shop.\n\n## Working memory\n\nWorking memory items, word for word.\n\n> Archived 2026-09-30 by the janitor: finished work.\n\n- The shop is live.\n',
    'knowledge/archive/notes/platform/old.md': '# An old note\n\n> Archived 2026-09-29 by the janitor: replaced by "A new note".\n\nIts intro.\n\n' +
      '## Its second section\n\nStill the archived note.\n\n### A subsection\n\nStill it.\n',
    // A whole note laid out like the repo's own (title, intro, then its line): a title-only query hits
    // the title's short chunk, above the line, and still shows what replaced it
    'knowledge/archive/notes/platform/quokka.md': '# Quokkaword lessons that stopped being true\n\nLessons from the note, word for word.\n\n' +
      '> Archived 2026-09-29 by the janitor: replaced by the note\'s lesson "Queues".\n\n- A long lesson about queues and branches, word for word.\n',
  }, `const { db } = await import('./db.ts'), memory = await import('./memory.ts');
    await memory.refresh();
    console.log(JSON.stringify({ rows: db.prepare("select pointer, note from memory where source = 'archive' order by id").all().map(r => [r.pointer, r.note]),
      title: (await memory.search('quokkaword', { id: 0, agent: 'penny' }, 5)).hits.map(h => [h.pointer, h.note]) }));`);
  const moved = 'Archived 2026-09-29 by the janitor: replaced by "A new note".', quokka = 'Archived 2026-09-29 by the janitor: replaced by the note\'s lesson "Queues".';
  assert.deepEqual(out.rows, [
    ['knowledge/archive/notes/platform/old.md:3', moved],
    ['knowledge/archive/notes/platform/old.md:8', moved],
    ['knowledge/archive/notes/platform/old.md:12', moved],
    ['knowledge/archive/notes/platform/quokka.md:2', quokka],
    ['knowledge/archive/notes/platform/quokka.md:5', quokka],
    ['knowledge/archive/people/kit.md:5', 'Archived 2026-09-29 by the janitor: the 15 most recent stay.'],
    // a section's own intro, before its first piece under the same heading, takes that piece's line
    ['knowledge/archive/people/kit.md:10', 'Archived 2026-09-30 by the janitor: finished work.'],
    ['knowledge/archive/people/kit.md:13', 'Archived 2026-09-30 by the janitor: finished work.'],
  ]);
  assert.deepEqual(out.title, [['knowledge/archive/notes/platform/quokka.md:2', quokka]]);
});

// Search by meaning (#1878), with a fake model: each made-up concept is one dimension, and a text points along the concepts
// its words name. "zorblet" is our made-up synonym for the mission's words: no file has it, so only meaning can find the charter.
const CONCEPTS = [['slightly warmer', 'zorblet'], ['flumph', 'blorptastic']];
function fake(opts: { passages?: Promise<void>; during?: () => Promise<unknown> } = {}): import('./memory.ts').Embedder {
  const vec = (t: string, kind: 'query' | 'passage') => {
    const low = t.toLowerCase(), v = new Float32Array(CONCEPTS.length + 2);
    CONCEPTS.forEach((words, i) => { v[i] = words.filter(w => low.includes(w)).length; });
    v[CONCEPTS.length + +(kind === 'query')] = 0.1;   // never a zero vector, and texts about nothing aren't near each other
    const len = Math.hypot(...v);
    return v.map(x => x / len);
  };
  return async (texts, kind) => {
    if (kind === 'passage') { await opts.passages; await new Promise(r => setImmediate(r)); }   // a model doesn't block the server
    else { await new Promise(r => setTimeout(r, 5)); await opts.during?.(); }
    return texts.map(t => vec(t, kind));
  };
}
const search = async (token: string, s: string) => (await agent(`search?q=${q(s)}&limit=30`, token)).body as { words?: string; hits: { pointer: string; title: string }[] };

test('By meaning: a word no file has finds the charter through a synonym; with no model, search says it ranked by words only', async () => {
  const wren = await running('wren');
  memory.setEmbedder(null);
  const words = await search(wren.token, 'zorblet');
  assert.deepEqual(words.hits, []);
  assert.equal(words.words, "ranked by words only: the search model isn't on this server, or didn't load");
  const e = fake();
  memory.setEmbedder(e, 'fake-1');
  await memory.refresh();
  await memory.embedAll();
  const meant = await search(wren.token, 'zorblet');
  assert.equal(meant.words, undefined, 'ranked by meaning and by words');
  assert.ok(meant.hits.some(x => /^company\/CHARTER\.md:\d+$/.test(x.pointer) && x.title === 'Charter › Mission'), JSON.stringify(meant.hits.slice(0, 8)));
  // a word nothing is near finds nothing (not the nearest of everything), and a model that hangs never holds search up
  assert.deepEqual((await search(wren.token, 'wombatzz')).hits, []);
  memory.setEmbedder(async (texts, kind) => kind === 'query' ? new Promise<Float32Array[]>(() => {}) : e(texts, kind), 'fake-1');
  const late = await search(wren.token, 'mission');
  assert.equal(late.words, 'ranked by words only: the search model took too long on this question');
  assert.ok(late.hits.some(x => x.title === 'Charter › Mission'));
  memory.setEmbedder(e, 'fake-1');
  // words still hit exactly next to it
  assert.ok((await hits((await running('penny')).token, `#${seat}`)).includes(`hq history '#${seat}'`));
  memory.setEmbedder(null);
});

test("By meaning: another agent's work is never found, and a call that comes to be about a customer while the question embeds is out (checked after the await)", async () => {
  const flumph = await finished('wren', 'Paint the flumph', 'Painted the flumph teal.');
  // Penny's calls about it, their follow-ups still at work
  const one = await call('penny', ['Board: what colour is the flumph?'], ''), two = await call('penny', ['Board: and how big is the flumph?'], '');
  memory.setEmbedder(fake(), 'fake-1');
  await memory.refresh();
  await memory.embedAll();
  const wren = await running('wren'), dex = await running('dex');
  const job = `hq history '#${flumph}'`;
  assert.ok((await search(wren.token, 'blorptastic')).hits.some(x => x.pointer === job), "Wren's own job, by meaning only");
  assert.ok(!(await search(dex.token, 'blorptastic')).hits.some(x => x.pointer === job), 'never to Dex');
  assert.ok(!(await agent('history?q=blorptastic', dex.token)).body.jobs.some((j: any) => j.id === flumph));
  assert.deepEqual((await agent('history?q=blorptastic', wren.token)).body.jobs.map((j: any) => j.id), [flumph], 'only what is near');
  const callHit = (c: { id: number }) => async () => (await search(dex.token, 'blorptastic')).hits.some(x => x.pointer === `hq call ${c.id}`);
  assert.ok(await callHit(one)() && await callHit(two)(), 'Dex finds the calls by meaning');
  // a follow-up is handed a customer's details (what hq mail's route does as it reads) while the question is being
  // embedded: still in the index, but out of the hits
  memory.setEmbedder(fake({ during: async () => h.jobs.handedCustomerData(one.follow.id) }), 'fake-1');
  assert.ok(!await callHit(one)());
  // and an index pass that runs meanwhile (and drops it) changes nothing either
  memory.setEmbedder(fake({ during: async () => { h.jobs.handedCustomerData(two.follow.id); await memory.refresh(); } }), 'fake-1');
  assert.ok(!await callHit(two)());
  memory.setEmbedder(null);
  for (const c of [one, two]) await h.finish(c.follow);
});

test('By meaning: a new model ranks only once it has read the index, and a half-built index says so', async () => {
  const wren = await running('wren');
  memory.setEmbedder(fake(), 'fake-1');
  await memory.refresh();
  await memory.embedAll();
  const job = await finished('wren', 'Weigh the flumph', 'Weighed the flumph.');
  // another model: nothing embedded yet, then the first batches, then all of it
  let release!: () => void;
  const two = fake({ passages: new Promise<void>(r => { release = r; }) });
  memory.setEmbedder(two, 'fake-2');
  // before its first pass, the old model's vectors aren't compared with the new one's question
  assert.equal((await search(wren.token, 'blorptastic')).words, 'ranked by words only: the search model is still reading the index');
  await memory.refresh();
  assert.equal((await search(wren.token, 'blorptastic')).words, 'ranked by words only: the search model is still reading the index');
  release();
  await memory.embedAll();
  assert.equal((await search(wren.token, 'blorptastic')).words, undefined);
  assert.ok((await search(wren.token, 'blorptastic')).hits.some(x => x.pointer === `hq history '#${job}'`));
  // a new report indexed, not embedded yet (the model still at it)
  let hold!: () => void;
  memory.setEmbedder(fake({ passages: new Promise<void>(r => { hold = r; }) }), 'fake-2');
  await finished('wren', 'Weigh the flumph again', 'Weighed the flumph again.');
  await memory.refresh();
  assert.match((await search(wren.token, 'blorptastic')).words ?? '', /^ranked by words, and by meaning for (\d+) of \d+ parts so far \(the index is still being built\)$/);
  hold();
  memory.setEmbedder(null);
});

test("By meaning: another model taken on while a search reads the vectors (a page at a time) leaves it none of the old one's", async () => {
  const wren = await running('wren');
  memory.setEmbedder(fake(), 'fake-1');
  memory.refresh();
  await memory.embedAll();
  // the vectors dropped (setEmbedder), so this search reads them again; the model changes on the server's turn after its first page
  memory.setEmbedder(fake({ during: async () => { setImmediate(() => memory.setEmbedder(fake(), 'fake-2')); } }), 'fake-1');
  const mid = await memory.search('blorptastic', wren) as { words?: string };
  assert.equal(mid.words, 'ranked by words only: the search model is still reading the index');
  await memory.embedAll();
  assert.equal((await memory.search('blorptastic', wren) as { words?: string }).words, undefined);
  memory.setEmbedder(null);
});

test('By meaning, with the vectors kept from one search to the next: a chunk embedded since is found, one rewritten or dropped since is not', async () => {
  const kit = await running('kit'), notes = `${h.repo}/knowledge/notes`;
  mkdirSync(notes, { recursive: true });
  const near = async () => (await search(kit.token, 'blorptastic')).hits.map(x => x.pointer.split(':')[0]).filter(p => p.startsWith('knowledge/notes/pets-')).sort();
  const model: { passages?: Promise<void> } = {};   // (the same model throughout: a new one reads every vector again)
  memory.setEmbedder(fake(model), 'fake-1');
  await memory.refresh();
  await memory.embedAll();
  assert.deepEqual(await near(), []);
  writeFileSync(`${notes}/pets-brushing.md`, '# Brushing\n\nBrush the flumph weekly.\n');
  writeFileSync(`${notes}/pets-feeding.md`, '# Feeding\n\nFeed the flumph at noon.\n');
  await memory.refresh();
  await memory.embedAll();
  assert.deepEqual(await near(), ['knowledge/notes/pets-brushing.md', 'knowledge/notes/pets-feeding.md']);
  // the newest chunk dropped, and the next one takes its id (sqlite's rowid): not near until it's embedded as itself
  rmSync(`${notes}/pets-feeding.md`);
  await memory.refresh();
  assert.deepEqual(await near(), ['knowledge/notes/pets-brushing.md']);
  let release!: () => void;
  model.passages = new Promise<void>(r => { release = r; });
  writeFileSync(`${notes}/pets-sleeping.md`, '# Sleeping\n\nThe cat sleeps all day.\n');
  await memory.refresh();
  assert.deepEqual(await near(), ['knowledge/notes/pets-brushing.md']);
  release();
  writeFileSync(`${notes}/pets-brushing.md`, '# Brushing\n\nBrush the cat weekly.\n');
  await memory.refresh();
  await memory.embedAll();
  assert.deepEqual(await near(), []);
  for (const note of ['brushing', 'sleeping']) rmSync(`${notes}/pets-${note}.md`);
  await memory.refresh();
  memory.setEmbedder(null);
});

test('A request said on the intercom 20+ lines back is found on a call by the intercom tool (by words and by its day) and by search', async () => {
  assert.equal((await h.board('/api/chat', { text: 'Please give the gerbilboard a dark mode by Friday.' })).status, 200);
  const line = db.prepare('insert into chat (ts, who, text, sent, about_customer) values (?, ?, ?, 1, ?)');
  line.run(new Date().toISOString(), 'juno', 'Jan Jansen wants the koalamug refunded.', 1);   // (a reply that holds a customer's details)
  for (let i = 1; i <= 24; i++) line.run(new Date().toISOString(), i % 2 ? 'juno' : 'board', `Small talk, line ${i}.`, 0);
  await memory.refresh();
  const onCall = (await voice('call-context?agent=penny')).body.token as string;
  const found = await agent(`intercom?q=${q('the gerbilboard in dark')}`, onCall);
  assert.equal(found.status, 200);
  assert.match(found.body.hits[0].lines, /\d\d:\d\d Board: Please give the gerbilboard a dark mode by Friday\.\n\d\d:\d\d Juno: \(a reply that holds a customer's details/);
  const { day, pointer } = found.body.hits[0];
  assert.equal(pointer, `hq intercom ${day}`);
  const read = await agent(`intercom?day=${day}`, onCall);
  assert.equal(read.body.timeZone, 'Europe/Amsterdam');
  assert.deepEqual((await agent(`intercom?q=${day}`, onCall)).body, read.body);
  const lines = read.body.days.find((d: any) => d.day === day).lines as string[];
  assert.ok(lines.some(l => /^\d\d:\d\d Board: Please give the gerbilboard/.test(l)) && lines.some(l => / Board: Small talk, line 24\.$/.test(l)));
  assert.ok(!lines.some(l => l.includes('Jan Jansen')), 'a line about a customer stays a placeholder');
  assert.ok((await hits(onCall, 'gerbilboard dark mode')).includes(`hq intercom ${day}`), 'search finds it too');
  assert.ok(!(await hits(onCall, 'koalamug')).some(p => p.startsWith('hq intercom')));
  for (const bad of ['2026-13-01', '2026-10-16..2026-10-01', '2026-10-01..2026-10-30', 'yesterday']) assert.equal((await agent(`intercom?day=${q(bad)}`, onCall)).status, 400, bad);
  for (const bad of [`${day} 25:00-26:00`, `${day} 9:75-10:00`]) {
    for (const parameter of ['day', 'q']) assert.equal((await agent(`intercom?${parameter}=${q(bad)}`, onCall)).status, 400, bad);
  }
  // and a job's hq, the same
  const kit = await running('kit');
  const searched = (await h.hq(kit, 'intercom', 'gerbilboard')).out;
  assert.ok(searched.includes(`${day}  (hq intercom ${day})\n`) && /\d\d:\d\d Board: Please give the gerbilboard/.test(searched), searched);
  const wholeDay = (await h.hq(kit, 'intercom', day, '00:00-23:59')).out;
  assert.ok(wholeDay.startsWith(`(Times in Europe/Amsterdam.)\n\n${day}\n`) && wholeDay.includes('Board: Small talk, line 24.'), wholeDay);
  const datedQuery = (await h.hq(kit, 'intercom', day, 'gerbilboard')).out;
  assert.match(datedQuery, /Board: Please give the gerbilboard/);
  assert.equal((await voice('call-end', { agent: 'penny', lines: [], token: onCall })).status, 200);
});

test("The intercom lines that came of a call about a card for keys (the CEO's follow-up notes, a reply after the intercom heard such a call) are no other agent's to read or find", async () => {
  const chatJob = () => (h.jobs.listJobs() as any[]).filter(j => j.kind === 'chat').sort((a, b) => a.id - b.id).at(-1)!;
  const turn = async (result: Record<string, unknown>) => h.finish((await h.claim(chatJob().engine, { kind: 'chat' }))!, result);   // (the intercom's turns on their own slot)
  // The CEO's own call about a card for keys: its follow-up's notes are the CEO's reply, and the next turn hears them
  const card = h.jobs.createRequest({ kind: 'credential', title: 'Keys for the yakbank', body: 'Type the yakbank keys.', agent: 'juno', secrets: 'STRIPE_TEST_YAK_KEY' }) as { id: number };
  const ctx = (await voice(`call-context?agent=juno&request=${card.id}`)).body;
  const spoken = 'Board: the yakbank key is yakzebra42.';
  assert.equal((await voice('call-end', { agent: 'juno', lines: [spoken], token: ctx.token, request: card.id })).status, 200);
  const follow = await run((await h.board('/api/calls')).body.find((c: any) => c.id === ctx.call).job);
  assert.equal((await agent('item', follow.token, { call: ctx.call, kind: 'task', goal: 'The board wants it on time.', owner: 'juno', what: 'Check the yakbank keys', quote: spoken })).status, 200);
  await agent('reply', follow.token, { text: 'Checked the yakbank: the key read out was yakzebra42.' }); // (its reply)
  await h.finish(follow, { result: 'Checked the yakbank: the key read out was yakzebra42.' });
  assert.equal((await h.board('/api/chat', { text: 'Is the yakbank on now?' })).status, 200);
  await turn({ status: 'done', result: 'Yes, yakzebra42 works.' });
  // A card for keys the intercom asked, and the call about it that the intercom heard: that turn's reply
  assert.equal((await h.board('/api/chat', { text: 'And the emubank?' })).status, 200);
  const asker = chatJob();
  await turn({ status: 'parked', request: { kind: 'credential', title: 'Keys for the emubank', body: 'Type them in.', secrets: 'STRIPE_TEST_EMU_KEY' } });
  const req = (await h.board('/api/requests')).body.find((c: any) => c.job === asker.id).id as number;
  const emu = (await voice(`call-context?agent=juno&request=${req}`)).body;
  assert.equal((await voice('call-end', { agent: 'juno', lines: ['Board: the emubank key is emuotter9.'], token: emu.token, request: req })).status, 200);
  await turn({ status: 'done', result: 'Emuotter9 is in the card now.' });
  await h.board('/api/chat', { text: 'Which emubank key was that again?' });
  await turn({ status: 'done', result: 'It was emuotter9.' });
  const said = ((await h.board('/api/chat')).body.messages as { text: string }[]).map(m => m.text);
  for (const reply of ['Checked the yakbank: the key read out was yakzebra42.', 'Yes, yakzebra42 works.', 'Emuotter9 is in the card now.', 'It was emuotter9.'])
    assert.ok(said.includes(reply), `the board reads it whole: ${reply}`);
  await memory.refresh();
  const kit = await running('kit');
  const { day } = (await agent(`intercom?q=${q('Is the yakbank on now')}`, kit.token)).body.hits[0];
  const lines = (await agent(`intercom?day=${day}`, kit.token)).body.days.find((d: any) => d.day === day).lines as string[];
  assert.ok(lines.some(l => / Board: Is the yakbank on now\?$/.test(l)) && lines.some(l => / Board: And the emubank\?$/.test(l)), 'the board\'s own lines stay');
  assert.equal(lines.filter(l => / Juno: \(a reply about a call on a card for keys/.test(l)).length, 4, lines.join('\n'));
  assert.ok(!lines.some(l => /yakzebra|emuotter/i.test(l)), lines.join('\n'));
  for (const word of ['yakzebra42', 'emuotter9']) {
    assert.deepEqual(await hits(kit.token, word), [], `search finds no ${word}`);
    assert.deepEqual((await agent(`intercom?q=${word}`, kit.token)).body.hits.filter((x: any) => /yakzebra|emuotter/i.test(x.lines)), [], word);
  }
  assert.doesNotMatch((await voice('call-context?agent=penny')).body.prompt, /yakzebra|emuotter/i, "nor another call's briefing");
  db.prepare("update jobs set status = 'cancelled' where id = ?").run(chatJob().id);
  await h.board('/api/chat', { text: 'A new topic.' });
  await turn({ status: 'done', result: 'A fresh conversation.' });
  assert.ok(JSON.stringify((await agent(`intercom?day=${day}`, kit.token)).body).includes('A fresh conversation.'));
});

test('An upgrade restricts later credential replies and pending legacy notes, including the session already running', async () => {
  const out = await indexed({}, `
    const { db } = await import('./db.ts');
    db.exec("insert into jobs (id, created, agent, title, prompt, engine, kind, status) values (1, '2026-10-17T08:00:00Z', 'juno', 'Chat', 'x', 'test', 'chat', 'running')");
    db.exec("insert into requests (id, created, agent, kind, title, body) values (1, '2026-10-17', 'juno', 'credential', 'Keys', 'x')");
    db.exec("insert into calls (id, ts, agent, request, lines, job) values (1, '2026-10-17T09:00:00Z', 'juno', 1, '[]', 1)");
    const put = db.prepare('insert into chat (ts, who, text, sent, call) values (?, ?, ?, ?, ?)');
    put.run('2026-10-17T09:00:00Z', 'call', 'Call transcript', 1, 1);
    put.run('2026-10-17T09:01:00Z', 'juno', 'Reply from the turn already running', 1, null);
    put.run('2026-10-17T09:02:00Z', 'juno', 'upgradeotter742', 1, null);
    put.run('2026-10-17T09:03:00Z', 'juno', 'upgradeotter742 again', 1, null);
    put.run('2026-10-17T09:04:00Z', 'call', 'upgradeyak815', 3, null);
    const memory = await import('./memory.ts'), chat = await import('./chat.ts'), intercom = await import('./intercom.ts');
    chat.answered({ id: 1 }, 'done', 'upgradeotter742 from the session already running');
    db.prepare("update jobs set status = 'cancelled' where id = 1").run();
    chat.say('Thanks');
    const next = db.prepare("select max(id) id from jobs where kind = 'chat'").get();
    chat.answered({ id: next.id }, 'done', 'upgradeyak815 from the pending notes');
    await memory.refresh();
    console.log(JSON.stringify({ day: intercom.read('2026-10-17'),
      found: await Promise.all(['upgradeotter742', 'upgradeyak815'].map(async word => ({
        search: await memory.search(word, { id: 0, agent: 'kit' }),
        intercom: await memory.searchIntercom(word, { id: 0, agent: 'kit' }) }))) }));
  `);
  assert.doesNotMatch(JSON.stringify(out.day), /upgradeotter742|upgradeyak815/);
  for (const found of out.found) {
    assert.deepEqual(found.search.hits, []);
    assert.deepEqual(found.intercom.hits, []);
  }
});

test("A fresh intercom session that reads a call about a card for keys (hq call, search, history) keeps its replies from every other agent", async () => {
  const chatJob = () => (h.jobs.listJobs() as any[]).filter(j => j.kind === 'chat').sort((a, b) => a.id - b.id).at(-1)!;
  const claimTurn = async () => (await h.claim(chatJob().engine, { kind: 'chat' }))!;
  const card = h.jobs.createRequest({ kind: 'credential', title: 'Keys for the koibank', body: 'Type the koibank keys.', agent: 'juno', secrets: 'STRIPE_TEST_KOI_KEY' }) as { id: number };
  const keys = await call('juno', ['Board: the koibank key is koiwalrus77.'], 'Checked the koibank: the key read out was koiwalrus77.', card.id);
  // The session that heard the call's notes ends; each fresh one hears only the masked recap, then reads the call itself
  assert.equal((await h.board('/api/chat', { text: 'Is the koibank on?' })).status, 200);
  await h.finish(await claimTurn(), { status: 'done', result: 'It is.' });
  await memory.refresh();
  const reads: [string, (token: string) => Promise<unknown>][] = [
    ['hq call', async token => assert.match(JSON.stringify((await agent(`call?id=${keys.id}`, token)).body), /koiwalrus77/)],
    ['search', async token => assert.ok((await hits(token, 'koiwalrus77')).includes(`hq call ${keys.id}`))],
    ['history', async token => assert.ok(JSON.stringify((await agent(`history?q=${q(`#${keys.follow.id}`)}`, token)).body).includes('koiwalrus77'))],
  ];
  for (const [how, read] of reads) {
    db.prepare("update jobs set status = 'cancelled' where id = ?").run(chatJob().id);
    assert.equal((await h.board('/api/chat', { text: `Which koibank key did I read out (${how})?` })).status, 200);
    const fresh = await claimTurn();
    assert.equal(h.jobs.holdsKeys(fresh.id), false, `${how}: the fresh session heard no keys yet`);
    await read(fresh.token);
    await h.finish(fresh, { status: 'done', result: `By ${how}: it was koiwalrus77.` });
    assert.ok(((await h.board('/api/chat')).body.messages as { text: string }[]).some(m => m.text === `By ${how}: it was koiwalrus77.`), 'the board reads it whole');
  }
  await memory.refresh();
  const kit = await running('kit');
  const { day } = (await agent(`intercom?q=${q('Is the koibank on')}`, kit.token)).body.hits[0];
  const lines = (await agent(`intercom?day=${day}`, kit.token)).body.days.find((d: any) => d.day === day).lines as string[];
  assert.ok(!lines.some(l => /koiwalrus/i.test(l)), lines.join('\n'));
  assert.deepEqual(await hits(kit.token, 'koiwalrus77'), []);
  assert.deepEqual((await agent(`intercom?q=koiwalrus77`, kit.token)).body.hits.filter((x: any) => /koiwalrus/i.test(x.lines)), []);
});

// HQ's go-to-anything search: by meaning, only the things it points at, nearest first, the archive and what's too far left
// out.
test("HQ's search near in meaning: Library documents by their path, nearest first, never an archived piece or one too far", async () => {
  const out = await indexed({
    'knowledge/notes/platform/kites.md': '# Kites\n\nHow the kites fly.\n',
    'knowledge/notes/platform/strings.md': '# Strings\n\nWhat holds a kite.\n',
    'knowledge/notes/platform/soup.md': '# Soup\n\nNothing about kites.\n',
    'knowledge/archive/notes/platform/kites-old.md': '# Kites, as they were\n\n> Archived 2026-09-29 by the janitor: replaced by the note "Kites".\n\nOld kites.\n',
  }, `const memory = await import('./memory.ts');
    const near = (t, kind) => kind === 'query' ? [1, 0, 0] : /How the kites|Old kites/.test(t) ? [1, 0, 0] : /holds a kite/.test(t) ? [0.6, 0.8, 0] : [0, 0, 1];
    memory.setEmbedder(async (texts, kind) => texts.map(t => Float32Array.from(near(t, kind))), 'fake');
    await memory.refresh();
    await memory.embedAll();
    console.log(JSON.stringify(await memory.nearest('something that flies')));`);
  assert.deepEqual(out.hits, [
    { kind: 'library', id: 'knowledge/notes/platform/kites.md' },
    { kind: 'library', id: 'knowledge/notes/platform/strings.md' },
  ]);
});
test("HQ's search near in meaning: a model that fails says why, and no words ask nothing", async () => {
  const out = await indexed({}, `const memory = await import('./memory.ts');
    memory.setEmbedder(async () => { throw new Error('out of memory'); }, 'fake');
    console.log(JSON.stringify([await memory.nearest('something that flies'), await memory.nearest('  ')]));`);
  assert.deepEqual(out, [{ hits: [], why: 'the search model failed on this question' }, { hits: [] }]);
});
