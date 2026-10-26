// node --test src/security.test.ts   (job #68: agent tokens, review pinning, approvals, CSP; throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync, symlinkSync, unlinkSync, rmSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { completeTriage } from './reviewfixture.ts';
import { harness, WORKER_TOKEN, VOICE_TOKEN, type Running } from './harness.ts';
import { commitFile, git, splitPlatform, savedNames as names } from './fixture.ts'; // (savedNames)

// "Caddy" connects over IPv4 loopback here; a job over ::1 (L3)
const h = await harness('sec', { env: { CADDY_HOST: '127.0.0.1' } });
const { db, jobs, worker, agent, board, call } = h;
const { ORIGIN } = await import('./config.ts');
const { publish } = await import('./events.ts');
const { saveSecrets, testSecrets, validNames, secret } = await import('./secrets.ts');
const { loginOptions } = await import('./auth.ts');
// the pending sign-in challenges, as auth.ts keeps them: the table is what a flood would fill
const challenges = () => (db.prepare('select count(*) as n from challenges').get() as { n: number }).n;
const held = (key: string) => !!db.prepare('select 1 from challenges where key = ?').get(key);
const firstChallenge = () => (db.prepare('select key from challenges order by rowid limit 1').get() as { key: string }).key;
await worker('seat', { seat: 'codex-1', engine: 'codex', state: 'ready' });   // a normal change's panel has its Codex reviewer
// 'skittles', refused below, is the test company's mascot (its company/brand.yaml): without it those refusals prove nothing
assert.ok(jobs.boardId('skittles'));

const settle = () => new Promise(r => setTimeout(r, 30));
const SHA = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
const running = (agentId = 'pixel', extra: Record<string, unknown> = {}) => h.start({ agent: agentId, ...extra });
const lastEvent = async () => (await h.feed()).at(-1)!;
const open = async () => (await board('/api/requests')).body as any[];
const shown = async (id: number) => (await open()).find(x => x.id === id);
// The queued job #id, claimed as the worker claims it (a Codex run on its seat): what its engine has queued before it is
// run and done first.
async function take(id: number): Promise<Running> {
  const engine = h.job(id).engine, seat = engine === 'codex' ? 'codex-1' : `take-${id}`;
  for (;;) {
    const r = await worker('claim', { seat, engine });
    assert.ok(r.body, `job #${id} is claimed`);
    if (r.body.id === id) return { ...r.body, seat };
    await h.finish({ ...r.body, seat });
  }
}

test('L2: the worker token is required; a wrong one (any length) gets 401', async () => {
  for (const t of ['', 'x', WORKER_TOKEN.slice(0, -1), `${WORKER_TOKEN}X`, 'a'.repeat(500)]) assert.equal((await call('/api/worker/secrets', t, {})).status, 401);
  assert.equal((await worker('secrets', {})).status, 200);
});

test('C2: claim returns a fresh token, once per run; the database keeps only its sha256', async () => {
  const a = await running();
  assert.equal(await h.claim(a.engine), null, 'a running job is never handed to a second claim');
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  const row = db.prepare('select token from jobs where id = ?').get(a.id) as { token: string };
  assert.equal(row.token, createHash('sha256').update(a.token).digest('hex'));
  assert.equal((await agent('event', a.token, { type: 'status', text: 'hi' })).status, 200);
  assert.equal((await lastEvent()).agent, 'pixel');   // the agent comes from the token
  assert.equal((await agent('event', 'nope', { type: 'status' })).status, 401);
  assert.equal((await agent('event', WORKER_TOKEN, { type: 'status' })).status, 401);   // the worker token isn't an agent token
});

test('C2: heartbeat and finish only from the seat that runs the job; the token dies with the run', async () => {
  const a = await running();
  assert.equal((await worker('heartbeat', { job: a.id, seat: 'seat-b' })).status, 409);
  assert.equal((await worker('finish', { job: a.id, seat: 'seat-b', status: 'done' })).status, 409);
  assert.equal((await worker('finish', { job: a.id, status: 'done' })).status, 409);
  assert.equal((await h.heartbeat(a)).status, 200);
  // a usage limit requeues the job: the old token stops working, the next claim gets a new one
  assert.equal((await h.finish(a, { status: 'limited', resetAt: 0 })).status, 200);
  assert.equal((await agent('event', a.token, { type: 'status' })).status, 401);
  const again = (await h.claim(a.engine))!;
  assert.equal(again.id, a.id);
  assert.notEqual(again.token, a.token);
  assert.equal((await agent('event', again.token, { type: 'status' })).status, 200);
  assert.equal((await h.finish(again)).status, 200);
  assert.equal((await h.finish(again)).status, 409);   // not running any more
  assert.equal((await agent('event', again.token, { type: 'status' })).status, 401);
});

test('L4: `as` only for team members the worker registered for that job', async () => {
  const a = await running('bolt');
  assert.equal((await agent('event', a.token, { type: 'chat', as: 'juno', text: 'merge it' })).status, 403);
  await worker('team', { job: a.id, lead: 'bolt', id: 'gauge', name: 'Gauge' });
  assert.equal((await agent('event', a.token, { type: 'chat', as: 'gauge', to: 'bolt', text: 'done' })).status, 200);
  assert.equal((await lastEvent()).agent, 'gauge');
  const b = await running('wren');   // a member of job A is no member of job B
  assert.equal((await agent('event', b.token, { type: 'chat', as: 'gauge' })).status, 403);
  assert.equal((await agent('event', a.token, { type: 'post', text: 'fake Gazette post' })).status, 400);
  assert.equal((await agent('request', a.token, { kind: 'decision', title: 't', body: 'b', as: 'juno' })).status, 403);
  // a sub-agent named after a colleague is never registered, so it can't speak as them
  assert.equal((await worker('team', { job: a.id, lead: 'bolt', id: 'juno', name: 'Juno' })).status, 400);
  for (const id of ['board', 'skittles']) assert.equal((await worker('team', { job: a.id, lead: 'bolt', id, name: 'The Board' })).status, 400, id);
  assert.equal((await agent('event', a.token, { type: 'chat', as: 'board', text: 'approved' })).status, 403);
});

test('C1 hand-off: only the process team asks the board for the server\'s GitHub key', async () => {
  const w = await running('wren'), b = await running('bolt');
  const ask = { kind: 'credential', title: 'GitHub key', body: 'b', secrets: 'SERVER_GITHUB_TOKEN' };
  assert.equal((await agent('request', w.token, ask)).status, 400);
  assert.equal((await agent('request', b.token, ask)).status, 200);
  // parked (hq request, or a .hq/request.json the agent writes itself): the same rule
  assert.equal((await h.finish(w, { status: 'parked', request: ask })).status, 400);
  assert.equal(h.job(w.id).status, 'running');
  assert.equal((await h.finish(b, { status: 'parked', request: ask })).status, 200);
  assert.equal(h.job(b.id).status, 'blocked');
});

test("only the process team asks for the server's other keys too: its phone line, PIN, backups and where the bookkeeping mail is copied (audit P17)", async () => {
  const w = await running('wren'), b = await running('bolt');
  for (const secrets of ['CALL_PIN', 'TWILIO_PHONE_NUMBER,TWILIO_AUTH_TOKEN', 'BOARD_PHONE_NUMBER', 'BACKUP_AGE_RECIPIENT', 'PRINTAPI_TEST_KEY,BACKUP_R2_ENDPOINT', 'MAIL_FORWARD_TO']) {
    const ask = { kind: 'credential', title: 'Keys', body: 'b', secrets };
    assert.equal((await agent('request', w.token, ask)).status, 400, secrets);
    assert.equal((await agent('request', b.token, ask)).status, 200, secrets);
  }
  assert.equal((await h.finish(w, { status: 'parked', request: { kind: 'credential', title: 'PIN', body: 'b', secrets: 'CALL_PIN' } })).status, 400);
  assert.equal((await agent('request', w.token, { kind: 'credential', title: 'Print API', body: 'b', secrets: 'PRINTAPI_TEST_KEY' })).status, 200);   // a partner key: anyone
});

test('C1 hand-off: the process team asks for the server\'s key whatever its department is called, the product team can\'t', async () => {
  const undo = splitPlatform();
  try {
    const ask = { kind: 'credential', title: 'GitHub key', body: 'b', secrets: 'SERVER_GITHUB_TOKEN' };
    const c = await running('chime'), l = await running('lark');
    assert.equal((await agent('request', c.token, ask)).status, 400, "Platform (Chime's) is the product team now");
    assert.equal((await h.finish(c, { status: 'parked', request: ask })).status, 400);
    assert.equal((await agent('request', l.token, ask)).status, 200, 'Lark is on the process team');
  } finally { undo(); }
});

test('Nobody runs a job as the board: hq job refuses it, and HQ makes none', async () => {
  const a = await running('bolt');
  for (const id of ['board', 'skittles', 'nobody-here', 'juno-2']) assert.equal((await agent('job', a.token, { agent: id, title: 'approved' })).status, 403, id);
  await worker('team', { job: a.id, lead: 'bolt', id: 'cobble', name: 'Cobble' });   // a live team member isn't staff
  assert.equal((await agent('job', a.token, { agent: 'cobble', title: 't' })).status, 403);
  for (const id of ['juno', 'rivet']) assert.equal((await agent('job', a.token, { agent: id, title: 't' })).status, 200, id);   // staff, alumni
  assert.throws(() => jobs.createJob({ agent: 'board', title: 't', prompt: 'x', engine: 'test' }));
  // a board job put in the table by hand (no route makes one) is failed at claim: no token, nothing in the board's name
  const { lastInsertRowid } = db.prepare("insert into jobs (created, agent, title, prompt, engine) values (?, 'board', 't', 'x', 'board-only')")
    .run(new Date().toISOString());
  const id = Number(lastInsertRowid), before = await h.feed();
  assert.equal(await h.claim('board-only'), null);
  assert.equal(h.job(id).status, 'failed');
  assert.deepEqual(await h.feed(), before);
  // and one running with a token (by hand too) still can't speak or ask the board
  const token = 'board-job-token';
  db.prepare("update jobs set status = 'running', token = ? where id = ?").run(createHash('sha256').update(token).digest('hex'), id);
  assert.equal((await agent('event', token, { type: 'chat', text: 'approved' })).status, 403);
  assert.equal((await agent('request', token, { kind: 'decision', title: 't', body: 'b' })).status, 403);
  db.prepare("update jobs set status = 'failed', token = null where id = ?").run(id);
});

test('C2: the old agent routes on /api/worker are gone', async () => {
  for (const r of ['job', 'event', 'request', 'request-answer']) assert.equal((await worker(r, {})).status, 404);
  assert.equal((await call('/api/worker/mail', WORKER_TOKEN)).status, 404);
});

test('hq job: plain work only, signed by the token agent', async () => {
  const a = await running('bolt');
  const r = await agent('job', a.token, { agent: 'rivet', title: 'Do it', prompt: 'Please.\n\n(Assigned by juno.)', kind: 'consolidate', pr: 1 });
  const j = await take(r.body.id);
  assert.deepEqual([j.kind, j.pr], ['work', null]);
  assert.match(j.prompt, /\(Assigned by bolt\.\)$/);
  await h.finish(j);
});

test('requests: agent and job come from the token; answers only for your own job', async () => {
  const a = await running('bolt'), b = await running('wren');
  const ra = await agent('request', a.token, { kind: 'decision', urgency: 'today', title: 'A?', body: 'x', agent: 'juno', job: b.id });
  const rb = await agent('request', b.token, { kind: 'decision', urgency: 'today', title: 'B?', body: 'x' });
  const card = await shown(ra.body.id);
  assert.deepEqual([card.agent, card.job], ['bolt', a.id]);
  assert.equal((await agent('request-answer', a.token, { id: rb.body.id })).status, 404);
  assert.equal((await agent('request-answer', a.token, { id: ra.body.id })).body.status, 'open');
  for (const bad of [{ kind: 'review' }, { kind: 'login' }, { kind: 'credential', secrets: 'NODE_OPTIONS' }, { kind: 'credential' },
    { kind: 'decision', approves: 'live:hello' }, { kind: 'approval', approves: 'live:../x' }, { kind: 'approval', approves: 'prod:hello' }])
    assert.equal((await agent('request', a.token, { title: 't', body: 'b', ...bad })).status, 400, JSON.stringify(bad));
  // a credential card names the keys it asks for, parked too
  assert.equal((await h.finish(a, { status: 'parked', request: { kind: 'credential', title: 'Key?', body: 'b' } })).status, 400);
});

// M6 as main built it (approvals.ts): the board's Approve button (approve === true) on an approval request that names
// a grant is the only thing that writes a record. What the text says never counts.
const approvalFile = (grant: string) => `${process.env.DATA_DIR}/approvals/${grant.replace(':', '-')}.json`;

test('M6: only the Approve button on an approval with a grant writes the record (0600); a typed "yes" never does', async () => {
  const a = await running('juno');
  const ask = async (slug: string) => (await agent('request', a.token, { kind: 'approval', title: 'Launch?', body: 'b', approves: `live:${slug}` })).body.id;
  for (const [i, answer] of ['yes', 'Approved!', ' Yes! ', 'approve'].entries()) {
    const id = await ask(`typed${i}`);
    assert.equal((await h.answer(id, answer)).status, 200);
    assert.equal(existsSync(approvalFile(`live:typed${i}`)), false, answer);
    assert.match((await agent('request-answer', a.token, { id })).body.answer, /^Not approved\./);
  }
  // only a JSON true counts, not "true" or 1
  for (const [i, approve] of (['true', 1, 'yes'] as const).entries()) {
    await h.answer(await ask(`loose${i}`), 'ok', { approve });
    assert.equal(existsSync(approvalFile(`live:loose${i}`)), false, String(approve));
  }
  const id = await ask('hello');
  assert.deepEqual((await h.answer(id, 'Nice work', { approve: true })).body, { ok: true });
  assert.equal(statSync(approvalFile('live:hello')).mode & 0o777, 0o600);
  assert.deepEqual({ ...JSON.parse(readFileSync(approvalFile('live:hello'), 'utf8')), approved: 1 }, { grant: 'live:hello', request: id, approved: 1 });
  // Approve on an approval without a grant, or on anything else, records nothing
  const files = () => readdirSync(`${process.env.DATA_DIR}/approvals`).length;
  const before = files();
  const plain = (await agent('request', a.token, { kind: 'approval', title: 'Blue or green?', body: 'b' })).body.id;
  const decision = (await agent('request', a.token, { kind: 'decision', title: 'Pick one', body: 'b' })).body.id;
  for (const r of [plain, decision]) assert.equal((await h.answer(r, 'yes', { approve: true })).status, 200);
  assert.equal(files(), before);
  assert.equal((await h.answer(id, 'again', { approve: true })).status, 404);   // answered already
});

test('M6: agents ask for a grant only on an approval, only live:/site:, asked live or parked', async () => {
  const a = await running('juno');
  for (const bad of [{ kind: 'approval', approves: 'live-keys:hello' }, { kind: 'approval', approves: 'live:Hello' }])
    assert.equal((await agent('request', a.token, { title: 't', body: 'b', ...bad })).status, 400, JSON.stringify(bad));
  assert.equal((await agent('request', a.token, { kind: 'approval', title: 't', body: 'b', approves: 'site:hello' })).status, 200);
  // a parked request (hq request) carries approves too, under the same rule, and nothing else of the coordinator's own
  const p = await running('juno');
  const card = await h.park(p, { kind: 'approval', title: 'Parked', body: 'b', approves: 'live:parked', pr: 3, seat: 'claude-1' });
  const req = await shown(card);
  assert.deepEqual([req.approves, req.pr, req.seat], ['live:parked', null, null]);
  const q = await running('juno');
  assert.equal((await h.finish(q, { status: 'parked', request: { kind: 'decision', title: 'x', body: 'b', approves: 'live:x' } })).status, 400);
  assert.equal((await h.finish(q, { status: 'parked', request: { kind: 'approval', title: 'x', body: 'b', approves: 'live-keys:x' } })).status, 400);
});

test('M6: the board reads what approving does in the coordinator\'s words, not the agent\'s, on the desk', async () => {
  const a = await running('juno');
  const r = await agent('request', a.token, { kind: 'approval', title: 'Approve the blue preview background?', body: 'Only a colour.', approves: 'live:hello' });
  assert.match((await shown(r.body.id)).grants, /real card payments/);
  assert.equal((await open()).find(x => !x.approves)?.grants, undefined);
});

test('hq close: an agent closes only its own open requests; hq phone is on the agent API only', async () => {
  const mine = await running('bolt'), theirs = await running('wren');
  const ra = await h.ask(mine, { title: 'Mine' }), rb = await h.ask(theirs, { title: 'Theirs' });
  assert.equal((await agent('request-close', mine.token, { id: rb })).status, 404);
  assert.equal((await agent('request-close', mine.token, { id: rb, as: 'wren' })).status, 403);
  assert.ok(await shown(rb), 'still on the desk phone');
  assert.equal((await agent('request-close', mine.token, { id: ra })).status, 200);
  assert.equal((await agent('request-close', mine.token, { id: ra })).status, 404);   // not open any more
  assert.equal((await agent('phone', mine.token)).status, 200);
  assert.equal((await call('/api/agent/phone', WORKER_TOKEN)).status, 401);
  assert.equal((await call('/api/worker/phone', WORKER_TOKEN)).status, 404);
});

// (Bodkin): a team member's name isn't unique (any job may start a sub-agent of that name), and the coordinator's
// own cards are no agent's to rewrite or take off the desk phone, the CEO's included
test('hq close/rewrite: a team member only its own job\'s request; never the coordinator\'s own cards', async () => {
  const a = await running('bolt'), b = await running('wren');
  await worker('team', { job: a.id, lead: 'bolt', id: 'scout', name: 'Scout' });
  await worker('team', { job: b.id, lead: 'wren', id: 'scout', name: 'Scout' });   // the same name in another job
  const asked = await h.ask(a, { title: 'Scout asks', body: 'the question', as: 'scout' });
  assert.equal((await agent('request-rewrite', b.token, { id: asked, body: 'forged', as: 'scout' })).status, 404);
  assert.equal((await agent('request-close', b.token, { id: asked, as: 'scout' })).status, 404);
  assert.equal((await shown(asked)).body, 'the question');
  assert.equal((await agent('request-rewrite', a.token, { id: asked, body: 'sharper', as: 'scout' })).status, 200);   // its own job's
  assert.equal((await agent('request-close', a.token, { id: asked, as: 'scout' })).status, 200);
  // a seat's sign-in card (its first link is the desk phone's "Open the sign-in page") and a pull request's review card
  // (review.ts makes it, as here)
  const login = (jobs.createRequest({ kind: 'login', seat: 'claude-sec', title: 'Sign in', body: '1. Open https://claude.ai/oauth/authorize?x=1' }) as { id: number }).id;
  const review = (jobs.createRequest({ kind: 'review', agent: 'quill', title: 'Your call: PR #77', body: 'Panel: block', pr: 77 }) as { id: number }).id;
  const ceo = await running('juno'), quill = await running('quill');
  for (const id of [login, review]) {
    assert.equal((await agent('request-rewrite', ceo.token, { id, body: '1. Open https://evil.example/' })).status, 404);
    assert.equal((await agent('request-close', ceo.token, { id })).status, 404);
  }
  assert.equal((await agent('request-rewrite', quill.token, { id: review, body: 'Panel: all clear' })).status, 404);
  assert.equal((await agent('request-close', quill.token, { id: review })).status, 404);
  assert.match((await shown(login)).body, /claude\.ai/); assert.ok(await shown(review));
  // the CEO still rewrites an agent's card
  const theirs = await h.ask(b, { title: 'Wren asks', body: 'long' });
  assert.equal((await agent('request-rewrite', ceo.token, { id: theirs, body: 'short' })).status, 200);
});

// (board, call #93): a card that brings a product back asks the board's own judgment, so it recommends nothing, on
// hq ask/request, its pre-check and hq rewrite
test('a card that brings a product back marks no choice recommended and has no Recommend: line', async () => {
  const a = await running('bolt');
  const rec = 'Hello is back.\n\nNo pictures: a sound.\n\nChoose:\n- Good now (recommended): it ships as it is\n- More changes: say what';
  const plain = 'Hello is back.\n\nNo pictures: a sound.';   // (HQ gives it its answers)
  for (const body of [rec, 'Hello is back.\n\nNo pictures: a sound.\n\nRecommend: good now\nOptions: Good now | More changes']) {
    assert.equal((await agent('request', a.token, { kind: 'decision', title: 'Good now?', body, back: ['hello'] })).status, 400);
    assert.equal((await agent('card-check', a.token, { body, back: ['hello'] })).status, 400);
  }
  assert.equal((await agent('card-check', a.token, { body: rec, back: [] })).status, 200);   // any other card may
  assert.equal((await agent('request', a.token, { kind: 'decision', title: 'Which?', body: rec, products: ['hello'] })).status, 200);
  const back = (await agent('request', a.token, { kind: 'decision', title: 'Good now?', body: plain, back: ['hello'] })).body.id;
  assert.equal((await agent('card-check', a.token, { body: rec, back: [], id: back })).status, 400);   // hq rewrite's pre-check
  assert.equal((await agent('request-rewrite', a.token, { id: back, body: rec })).status, 400);
  assert.equal((await agent('request-rewrite', a.token, { id: back, body: plain + '\n\nSharper.' })).status, 200);
});

// A card that brings work back leads with its before-and-after pictures, shown
// from main: one not there yet is refused unless the card waits for its work to go live
test('a card that brings work back leads with its pictures, on main or held until its work is live', async () => {
  const a = await running('bolt');
  const pair = (name: string) => `Hello is back.\n\nBefore and after:\n- The page: products/_cycles/t/${name}-before.png products/_cycles/t/${name}-after.png https://hello.example/`;
  mkdirSync(`${process.env.REPO_DIR}/products/_cycles/t`, { recursive: true });
  for (const end of ['before', 'after']) writeFileSync(`${process.env.REPO_DIR}/products/_cycles/t/main-${end}.png`, 'png');
  const ask = (body: string, more: Record<string, unknown> = {}) => agent('request', a.token, { kind: 'decision', title: 'Good now?', body, back: ['hello'], ...more });
  const words = await ask('Hello is back: the page is shorter.');
  assert.equal(words.status, 400);
  assert.match(JSON.stringify(words.body), /leads with a picture of each change/);
  assert.equal((await agent('card-check', a.token, { body: 'Hello is back.', back: ['hello'] })).status, 400);
  const unmerged = await ask(pair('new'));
  assert.equal(unmerged.status, 400);
  assert.match(JSON.stringify(unmerged.body), /new-before\.png, products\/_cycles\/t\/new-after\.png aren't on main yet/);
  assert.equal((await agent('card-check', a.token, { body: pair('new'), back: ['hello'] })).status, 400);
  assert.equal((await agent('card-check', a.token, { body: pair('new'), back: ['hello'], when: [`deployed:${a.id}`] })).status, 200);
  assert.equal((await ask(pair('new'), { when: [`deployed:${a.id}`] })).status, 200);   // held until this job's work is live
  const shown = await ask(pair('main'));
  assert.equal(shown.status, 200);
  assert.equal((await agent('request-rewrite', a.token, { id: shown.body.id, body: pair('new') })).status, 400);
  assert.equal((await agent('request-rewrite', a.token, { id: shown.body.id, body: pair('main') + '\n\nSharper.' })).status, 200);
});

// A document a card names by its file opens in the board's Library: one no shelf shows (a brief, here) is refused, with
// the shelves.
test("a card naming a document the Library doesn't show is refused by hq ask, hq request, its pre-check and hq rewrite", async () => {
  const a = await running('bolt');
  const brief = 'The licence to sign is in company/briefs/6728-foundation-licence.md.', shelved = 'How we decide: `CHARTER.md`, and company/DECISIONS.md.';
  for (const route of ['request', 'card-check']) {
    const r = await agent(route, a.token, { kind: 'action', title: 'Sign it', body: brief });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /names company\/briefs\/6728-foundation-licence\.md, which the board's Library doesn't show/);
    assert.match(r.body.error, /company\/ \(Handbook\), company\/playbooks\/ \(Playbooks\), .*knowledge\/notes\/<topic>\/ \(Notes\)/);
  }
  const id = (await agent('request', a.token, { kind: 'action', title: 'Read it', body: shelved })).body.id;
  assert.ok(id);
  assert.equal((await agent('request-rewrite', a.token, { id, body: brief })).status, 400);
  // a brief with a shelved document's file name is still a brief
  assert.equal((await agent('request-rewrite', a.token, { id, body: 'The copy is in company/briefs/CHARTER.md.' })).status, 400);
  assert.equal((await agent('request-rewrite', a.token, { id, body: shelved + ' Sharper.' })).status, 200);
});

test('a card that recommends without options to choose is refused by hq ask, hq request, its pre-check and hq rewrite', async () => {
  const a = await running('bolt');
  const bare = 'Check the account.\n\nRecommend: leave it off\n\nSteps:\n1. Open the account.\n2. Leave the consent off.';
  const fine = 'Check the account.\n\nSteps:\n1. Open the account.\n2. Leave the consent off.';
  for (const route of ['request', 'card-check']) {
    const r = await agent(route, a.token, { kind: 'action', title: 'Check it', body: bare });
    assert.equal(r.status, 400); assert.match(r.body.error, /offers nothing to choose/);
  }
  const id = (await agent('request', a.token, { kind: 'action', title: 'Check it', body: fine })).body.id;
  assert.equal((await agent('request-rewrite', a.token, { id, body: bare })).status, 400);
  assert.equal((await agent('card-check', a.token, { body: bare.replace('Steps:', 'Options: Done | Not yet\n\nSteps:') })).status, 200);
});

test('Share: the desk phone sends only a card\'s Share part, never on a card about keys', async () => {
  const ask = async (job: Running, b: Record<string, unknown>) => h.ask(job, { kind: 'action', title: 'Forward me', ...b });
  const SHARE = 'Share:\nHello, could you send us the company\'s KvK extract?\n\nThanks!';
  const plain = await running('wren'), care = await running('dex'), keyed = await running('wren');
  const a = await shown(await ask(plain, { body: `What we need from the accountant: send it on.\n---\n${SHARE}\n---\nWhy: job #12 asked.` }));
  assert.equal(a.share, "Hello, could you send us the company's KvK extract?\n\nThanks!");
  assert.doesNotMatch(a.body, /Share:|KvK/);                    // it isn't part of the card
  assert.match(a.body, /^What we need[\s\S]*\n---\n[\s\S]*job #12 asked\.$/);   // the parts around it stay
  assert.match((await agent(`requests?id=${a.id}`, plain.token)).body[0].body, /KvK/);   // its author (hq requests) reads all of it
  assert.notEqual((await shown(await ask(care, { body: `Please forward.\n---\n${SHARE}` }))).share, undefined);
  // a request for keys, never
  const cred = await shown(await ask(keyed, { kind: 'credential', body: `Keys please.\n---\n${SHARE}`, secrets: 'PRINTAPI_TEST_CLIENT_ID' }));
  assert.equal(cred.share, undefined); assert.doesNotMatch(cred.body, /KvK/);
  // the coordinator's own cards, and a card with no Share part (or an empty one), have nothing to share
  const login = (jobs.createRequest({ kind: 'login', seat: 'seat-sh4', title: 'Sign in', body: `Open the link.\n---\n${SHARE}` }) as { id: number }).id;
  assert.equal((await shown(login)).share, undefined);
  assert.equal((await shown(await ask(care, { body: 'No Share part.\n---\nShare it? No.' }))).share, undefined);
  assert.equal((await shown(await ask(care, { body: 'Nothing to send.\n---\nShare:' }))).share, undefined);
  // a second Share part leaves the card too; the first is the one sent (platform/hq/share-check.mjs drives the desk in Chromium)
  const two = await shown(await ask(care, { body: `Please forward.\n---\nShare: one\n---\nShare: two\n---\nWhy: x.` }));
  assert.equal(two.share, 'one'); assert.equal(two.body, 'Please forward.\n\n---\n\nWhy: x.');
  // what the board forwards is no part of the card: the card check leaves its lists and links alone
  const listed = 'Please forward.\n---\nShare: Hello, could you send us:\n- the KvK extract\n- the form at https://kvk.example/form';
  assert.equal((await agent('card-check', care.token, { body: listed })).status, 200);
  assert.equal((await agent('card-check', care.token, { body: listed.replace('Share: ', '') })).status, 400);
});

const callToken = async (who = 'wren') => (await h.voice(`call-context?agent=${who}`)).body.token as string;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

test('Voice line: VOICE_TOKEN only on /api/voice/*, and a call token assigns and manages work as its agent, until the call ends', async () => {
  const voice = (route: string, token: string, body?: unknown) => call(`/api/voice/${route}`, token, body);
  assert.equal((await voice('call-context?agent=wren', WORKER_TOKEN)).status, 401);
  assert.equal((await call('/api/worker/claim', VOICE_TOKEN, { seat: 'v', engine: 'test' })).status, 401);
  assert.equal((await agent('event', VOICE_TOKEN, { type: 'chat', text: 'x' })).status, 401);
  for (const r of ['call-context', 'call-end', 'call-ticket']) assert.equal((await worker(r, {})).status, 404, r);
  // (the tokens a call gets: only their sha256 is kept)
  const minted = () => (db.prepare('select count(*) n from call_tokens').get() as any).n;
  const b = await running('bolt');
  await worker('team', { job: b.id, lead: 'bolt', id: 'cobble', name: 'Cobble' });   // a live team member isn't on the phone list
  const none = minted();
  for (const id of ['board', 'skittles', 'nobody-here', 'cobble']) assert.equal((await voice(`call-context?agent=${id}`, VOICE_TOKEN)).status, 404, id);
  assert.equal(minted(), none);
  const ctx = await voice('call-context?agent=wren', VOICE_TOKEN);
  assert.equal(ctx.status, 200); assert.ok(ctx.body.prompt); assert.match(ctx.body.token, /^[A-Za-z0-9_-]{43}$/);
  const t = ctx.body.token;
  assert.ok(db.prepare('select 1 from call_tokens where hash = ?').get(hash(t)));
  assert.equal(db.prepare('select 1 from call_tokens where hash = ?').get(t), undefined);
  // no chat bubbles from a call (hq say): nobody reads them, and the agent took them for delivered; a job is the hand-off
  const quiet = await h.feed();
  for (const type of ['chat', 'status']) assert.equal((await agent('event', t, { type, to: 'bolt', text: 'on it' })).status, 403, type);
  assert.deepEqual(await h.feed(), quiet);
  for (const id of ['board', 'skittles', 'nobody-here']) assert.equal((await agent('job', t, { agent: id, title: 'x', prompt: 'y' })).status, 403, id);
  for (const [route, body] of [['request', { kind: 'decision', title: 't', body: 'b' }], ['request-answer', { id: 1 }],
    ['mail', undefined], ['note?id=1', undefined], ['phone', undefined]] as const)
    assert.equal((await agent(route, t, body)).status, 403, route);
  assert.match((await agent('mail', t)).body.error, /^a call can't do this, as none of the call's tools reaches it/, 'it says why');
  // the reads a job has, its call's too: the status report, the Overseer's notes
  assert.notEqual((await agent('report', t)).status, 403);
  assert.equal((await agent('overseer', t)).status, 200);
  // (closing a card that is not the call agent's is HQ's own refusal)
  assert.equal((await agent('request-close', t, { id: 1 })).status, 404);
  // a promise on its own call's list, nothing else: not another call's item or job
  const kit = await callToken('kit');
  const kitsItem = (await agent('item', kit, { kind: 'promise', owner: 'kit', goal: 'g', what: 'Coming-soon page', quote: 'Build it' })).body.id;
  const kitsJob = (await agent('job', kit, { agent: 'kit', title: 'Coming-soon page', prompt: 'x', item: kitsItem })).body.id;
  assert.equal((await agent('item', t, { kind: 'task', owner: 'wren', goal: 'g', what: 'Something else', quote: 'y' })).status, 403);
  assert.equal((await agent('item-drop', t, { id: kitsItem, why: 'x' })).status, 403);
  // (cancel: open to a call as hq cancel is to its agent's jobs, and wren may cancel neither kit's job nor one kit queued)
  assert.equal((await agent('cancel', t, { id: kitsJob })).status, 404);
  assert.equal(h.job(kitsJob).status, 'queued');
  // a call where nobody spoke (the voice line sends that at hang-up): the token dies, nothing follows up, and the call's
  // row (made at its start, for what's recorded during it) goes
  const queued = () => h.jobs.listJobs().filter((j: any) => j.status === 'queued').length;
  const live = () => (db.prepare("select count(*) n from calls where status = 'live'").get() as any).n;
  const before = [queued(), live()];
  assert.equal((await voice('call-end', VOICE_TOKEN, { agent: 'wren', lines: [], request: 0, token: t })).status, 200);
  assert.deepEqual([queued(), live()], [before[0], before[1] - 1]);
  assert.equal((await agent('job', t, { agent: 'rivet', title: 'Still here?', prompt: 'x' })).status, 401);
  // and a token that outlived the call's 3 hours (no route moves a clock)
  const late = await callToken();
  db.prepare('update call_tokens set expires = ? where hash = ?').run(Date.now() - 1, hash(late));
  assert.equal((await agent('job', late, { agent: 'rivet', title: 'Late', prompt: 'x' })).status, 401);
});

test("Call ledger: a job handed out for one item can't drop or close a colleague's item on the same call, nor cancel a job the coordinator made", async () => {
  const kit = await callToken('kit');
  const it = async (what: string) => (await agent('item', kit, { kind: 'promise', owner: 'kit', goal: 'g', what, quote: 'Build it' })).body.id as number;
  const a = await it('Coming-soon page'), b = await it('Mission note');
  // (now: started on the call, which hasn't ended. A call's job waits for its end otherwise)
  const own = (await agent('job', kit, { agent: 'kit', title: 'Coming-soon page', prompt: 'x', item: a, now: true })).body.id;
  const theirs = (await agent('job', kit, { agent: 'kit', title: 'Mission note', prompt: 'x', item: b })).body.id;
  const mine = await take(own);
  for (const [route, body] of [['item-drop', { id: b, why: 'x' }], ['item-link', { id: b, to: { ref: 'done' } }], ['item-link', { id: b, to: { job: mine.id } }], ['item-drop', { id: a, why: 'x' }]] as const)
    assert.equal((await agent(route, mine.token, body)).status, 403, `${route} ${body.id}`);
  const openItems = ((await agent('items', mine.token)).body as any[]).map(i => i.id);
  assert.ok(openItems.includes(a) && openItems.includes(b), 'both still open');
  assert.equal(h.job(theirs).status, 'queued');
  assert.equal((await agent('item-link', mine.token, { id: a, to: { ref: 'commit abc' } })).status, 200, 'its own item it links');
  // hq cancel: the coordinator's jobs for Kit (a PR's fix job, the board's answer) aren't Kit's to cancel
  const fix = h.queue({ agent: 'kit', title: 'Update PR #9' });
  assert.equal((await agent('cancel', mine.token, { id: fix })).status, 404);
  assert.equal(h.job(fix).status, 'queued');
  await h.finish(mine);
});

test("Voice line: a call's job carries its whole brief (hq_tools.py hands it to hq on stdin, never as a file), and the answer is its id", async () => {
  const t = await callToken();
  const brief = 'Check the phone logs from Monday for dropped calls. '.repeat(12).slice(0, 600);
  const j = await agent('job', t, { agent: 'rivet', title: 'Check the phone logs', prompt: brief, now: true });
  assert.equal(j.status, 200); assert.ok(Number.isInteger(j.body.id));
  const run = await take(j.body.id);
  assert.deepEqual([run.agent, run.title, run.prompt], ['rivet', 'Check the phone logs', `${brief}\n\n(Assigned by wren, on a call with the board.)`]);
  await h.finish(run);
});

test('Voice line: too long from a call is refused with the reason, never cut, and nothing is queued (whatever the client let through)', async () => {
  const t = await callToken();
  const queued = () => h.jobs.listJobs().filter((j: any) => j.status === 'queued').length, jobsBefore = queued();
  for (const [body, error] of [
    [{ title: 'Logs', prompt: 'b'.repeat(8001) }, 'brief too long (8,001 > 8,000): split it into two jobs'],
    [{ title: 'Logs', prompt: 'é'.repeat(9120) }, 'brief too long (9,120 > 8,000): split it into two jobs'],
    [{ title: 't'.repeat(141), prompt: 'b' }, 'title too long (141 > 140): keep it to one short line and put the rest in the brief'],
    [{ title: 'Logs', prompt: ' ' }, "a job from a call needs a brief: the whole hand-off, in the colleague's terms"],
  ] as const) {
    const r = await agent('job', t, { agent: 'rivet', ...body });
    assert.deepEqual([r.status, r.body], [400, { error }], error);
  }
  assert.equal(queued(), jobsBefore);
  // exactly at the limits is fine (8,000 characters, even where UTF-16 needs two units for one)
  const full = await agent('job', t, { agent: 'rivet', title: 't'.repeat(140), prompt: '📞'.repeat(8000), now: true });
  const run = await take(full.body.id);
  assert.ok(run.prompt.startsWith('📞'.repeat(8000) + '\n\n(Assigned'));
  await h.finish(run);
});

test("A call shows the agent its own recent work; a desk phone answer tells the job the board isn't in the session", async () => {
  const finished = async (who: string, title: string, result: string, more: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) => {
    const j = await h.start({ agent: who, title, ...fields });
    await h.finish(j, { result, ...more });
    return j.id;
  };
  const own = await finished('penny', 'Record the seat decision', 'Recorded the board\'s call on the Claude seat in DECISIONS.');
  await finished('penny', 'Update PR #9001', 'Merged main into the branch.', { branch: `job/${own}`, pr: 9001, sha: SHA, files: ['a.ts'] });
  await finished('penny', 'A long one', 'word '.repeat(400));
  await finished('wren', 'Someone else\'s work', 'Not Penny\'s.');
  // parked on a card the board answers on its desk phone: the job hears the answer, and that the board isn't in its session
  const parked = await h.start({ agent: 'penny', title: 'Ask about the seat' });
  const card = await h.park(parked, { kind: 'decision', title: 'Claude seat: switch?', body: 'b' });
  await h.answer(card, 'Keep Max until there is revenue.');
  const resumed = await take(parked.id);
  assert.ok(resumed.note.includes('Keep Max until there is revenue.') && resumed.note.endsWith(jobs.AUDIENCE));
  // an intercom turn's reply does go to the board: a parked chat job isn't told otherwise
  const turn = await h.start({ agent: 'juno', title: 'Intercom', kind: 'chat' });
  await h.answer(await h.park(turn, { kind: 'decision', title: 'Which name?', body: 'b' }), 'The first.');
  assert.ok(!(await take(turn.id)).note.includes(jobs.AUDIENCE));
  // the resumed job finishes last, so it comes first, ahead of a newer job that finished before it
  await finished('penny', 'A newer one', 'Finished while the request waited.');
  await h.finish(resumed, { result: 'Recorded the answer.' });
  const prompt = (await h.voice('call-context?agent=penny')).body.prompt as string;
  const mine = prompt.slice(prompt.indexOf('## Your own recent work'), prompt.indexOf('## The company right now'));
  const first = mine.split('\n').find((l: string) => l.startsWith('- Job #'))!;
  assert.ok(first.includes(`#${parked.id}`) && first.includes('Recorded the answer.'));
  assert.ok(mine.includes('Recorded the board\'s call on the Claude seat') && mine.includes('PR #9001'));
  assert.ok(!mine.includes('word '.repeat(150)), 'a long report is cut');
  assert.ok(mine.includes('Keep Max until there is revenue.'), "the board's answer");
  assert.doesNotMatch(mine, /Someone else/);
  // Eight newer ones push it out of the reports, not out of the last day: its title stays; a job from two days ago doesn't (#1046)
  const old = await finished('penny', 'Two days ago', 'Old news.');
  db.prepare('update jobs set finished = ? where id = ?').run(new Date(Date.now() - 48 * 3600_000).toISOString(), old);   // (no route moves a clock)
  for (let i = 0; i < 8; i++) await finished('penny', `Update PR #${9010 + i}`, 'Merged main.');
  const later = (await h.voice('call-context?agent=penny')).body.prompt as string;
  const day = later.slice(later.indexOf('Also finished in the last day'), later.indexOf('Your latest desk phone requests'));
  assert.ok(day.includes('Record the seat decision'));
  assert.doesNotMatch(day, /Two days ago|Old news|Recorded the board's call/);   // titles only, and only the last day
  // a job that read a customer's details: its report stays with that job, so the call has its title only; a plain
  // card's answer shows like any
  await finished('poppy', 'Answer a customer', 'Refunded Jan at Kerkstraat 1.', {}, { customers: true });
  const poppy = await running('poppy');
  await h.answer(await h.ask(poppy, { title: 'Approve a refund?', body: 'Order 12.' }), 'Yes, refund the order.');
  const care = (await h.voice('call-context?agent=poppy')).body.prompt as string;
  assert.ok(care.includes('Answer a customer') && care.includes('Yes, refund the order'));
  assert.doesNotMatch(care, /Kerkstraat/);
});

test('A call runs on the calls model and hears the shared core, the newest profile and decisions, and platform work goes to Bolt (#934)', async () => {
  const people = `${h.repo}/company/people/bolt.md`, decisionsFile = `${h.repo}/company/DECISIONS.md`;
  const ctx = (await h.voice('call-context?agent=bolt')).body;
  assert.deepEqual([ctx.model, ctx.effort], ['claude-opus-5-5', 'low']);   // the board: calls on the model that runs the company
  const core = readFileSync(`${h.repo}/AGENTS.md`, 'utf8').trim();
  assert.ok(ctx.prompt.includes(core) && core.includes('slightly more whimsical'));   // the mission, how to talk to the board
  assert.ok(Buffer.byteLength(ctx.prompt) < 100_000, 'one argument to the CLI: well under 128 KiB');
  // a long profile: its newest track record entries, and how many older ones it leaves out; DECISIONS.md the same
  const profile = readFileSync(people, 'utf8'), decided = readFileSync(decisionsFile, 'utf8');
  try {
    writeFileSync(people, `---\nid: bolt\n---\n\n## Personality\nP.\n\n## Track record\n${Array.from({ length: 12 }, (_, i) => `- entry ${i}`).join('\n')}\n\n## Working memory\n- m`);
    writeFileSync(decisionsFile, `# D\n\n## newest\n${'x'.repeat(10)}\n${Array.from({ length: 40 }, (_, i) => `## older ${i}\n${'y'.repeat(1000)}\n`).join('')}`);
    const cut = (await h.voice('call-context?agent=bolt')).body.prompt as string;
    assert.match(cut, /- entry 11/); assert.doesNotMatch(cut, /- entry 3\b/); assert.match(cut, /4 older entries/);
    assert.match(cut, /## newest/); assert.doesNotMatch(cut, /## older 39/);
  } finally { writeFileSync(people, profile); writeFileSync(decisionsFile, decided); }
});

test('A call about a request whose job is still running reaches a new job with the transcript', async () => {
  const asker = await running('kit');   // a lead waiting with hq wait: it only ever hears the request's answer
  const req = await h.ask(asker, { title: 'The coming-soon page', body: 'Which one?' });
  const token = (await h.voice(`call-context?agent=kit&request=${req}`)).body.token;
  await h.voice('call-end', { agent: 'kit', lines: ['Board: go with the second one, and tell Juno about the mission.'], request: req, token });
  const heard = (h.jobs.listJobs() as any[]).filter(j => j.agent === 'kit' && j.status === 'queued').sort((x, y) => y.id - x.id)[0];
  const run = await take(heard.id);
  assert.match(run.prompt, /tell Juno about the mission/);
  assert.ok(run.prompt.includes(`job #${asker.id}`));
  assert.equal(h.job(asker.id).status, 'running', 'the running job carries on');
  await h.finish(run);
});

test('Voice line: a coordinator without VOICE_TOKEN (first deploy) accepts no voice call at all', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `const { app } = await import('./src/server.ts'); const s = (await import('node:http')).createServer(app).listen(0);
    const u = 'http://localhost:' + s.address().port + '/api/voice/call-context?agent=wren', out = [];
    for (const h of [undefined, 'Bearer ', 'Bearer', 'Bearer undefined']) out.push((await fetch(u, { headers: h === undefined ? {} : { authorization: h } })).status);
    console.log(out.join()); s.close(); process.exit(0);`;
  const dir = mkdtempSync(`${tmpdir()}/sec-voice-`);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8',
    env: { ...process.env, VOICE_TOKEN: '', DATA_DIR: dir, SECRETS_DIR: `${dir}/secrets` } });
  assert.equal(out.trim().split('\n').at(-1), '401,401,401,401');
});

// A pull request through review as in life: its job pushes `sha`, its reviewer finds nothing, Quill rules `decision`. The
// commits each run was handed to check out.
async function reviewed(n: number, sha: string, decision: string) {
  const w = await running('pixel');
  h.github.pr(n).head = sha;
  await h.finish(w, { pr: n, branch: `job/${w.id}`, files: ['products/x/index.html'], sha });
  await completeTriage(h, n);
  const runs = (kind: string) => (h.jobs.listJobs() as any[]).filter(j => j.kind === kind && j.pr === n && j.status === 'queued');
  const shas: string[] = [], panel = runs('review');
  assert.equal(panel.length, 1);
  for (const r of panel) { const c = await take(r.id); shas.push(c.sha); await h.finish(c, { output: '{"findings": []}' }); }
  await settle();
  const c = await take(runs('consolidate')[0].id); shas.push(c.sha);
  await h.finish(c, { output: JSON.stringify({ decision, summary: 'clean' }) });
  await settle();
  return shas;
}

test("M4: reviews are pinned to the pushed head; Quill's merge sends that sha", async () => {
  assert.deepEqual(await reviewed(105, SHA2, 'merge'), [SHA2, SHA2]);
  assert.deepEqual([h.github.pr(105).merged, h.github.pr(105).mergedSha], [true, SHA2]);
});

test("M2/M4: the board's merge sends the reviewed sha; a moved branch is refused, and the PR isn't merged", async () => {
  await reviewed(103, SHA, 'board');
  const card = (await open()).find(c => c.kind === 'review' && c.pr === 103);
  await h.answer(card.id, 'merge'); await settle();
  assert.deepEqual([h.github.pr(103).merged, h.github.pr(103).mergedSha], [true, SHA]);
  await reviewed(104, SHA, 'board');
  h.github.refuse.push({ status: 409, message: 'Head branch was modified. Review and try the merge again.' });
  await h.answer((await open()).find(c => c.kind === 'review' && c.pr === 104).id, 'merge it'); await settle();
  assert.equal(h.github.pr(104).merged, false);
});

test('M5: CSP and nosniff headers', async () => {
  const get = (p: string) => fetch(h.base + p, { redirect: 'manual' });
  for (const p of ['/health', '/login', '/icon.svg', '/api/org']) assert.equal((await get(p)).headers.get('x-content-type-options'), 'nosniff', p);
  const login = await get('/login'), html = await login.text(), policy = login.headers.get('content-security-policy')!;
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  assert.ok(policy.includes(`'sha256-${createHash('sha256').update(inline).digest('base64')}'`));
  assert.doesNotMatch(policy.match(/script-src[^;]*/)![0], /unsafe/);
  assert.match(policy, /object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'/);
  assert.equal((await get('/knowledge/posts/2026-09-25-were-open/cover.png')).headers.get('content-security-policy'), 'sandbox');
  assert.equal((await get('/cycles/x.mp4')).headers.get('content-security-policy'), 'sandbox');
  // the Library's scripts go out as plain text, which no page on HQ's origin can run (P18); a cycle's deck keeps its own
  const signedIn = (p: string) => fetch(h.base + p, { headers: { cookie: h.boardCookie } });
  const js = `${process.env.REPO_DIR}/knowledge/p18-test.js`;
  writeFileSync(js, 'alert(1)\n');
  try {
    const script = await signedIn('/knowledge/p18-test.js');
    assert.equal(script.status, 200);
    assert.equal(script.headers.get('content-type'), 'text/plain; charset=utf-8');
  } finally { rmSync(js, { force: true }); }
  const hq = (await get('/icon.svg')).headers.get('content-security-policy')!;
  assert.match(hq, /^default-src 'self'; script-src 'self';/);
  // what main's HQ added: the call's WebSocket on HQ's own host, and the preview viewer's frame; nothing wider
  assert.match(hq, /connect-src 'self' ws:\/\/localhost:\d+;/);
  assert.match(hq, /frame-src 'self';/);   // PUBLIC_HOST=localhost has no preview zone
  // and main's desk-phone photos: blob: previews, as images only (never script, frames or connections)
  assert.match(hq, /img-src 'self' data: blob:;/);
  assert.doesNotMatch(hq.replace(/img-src[^;]*/, ''), /\*(?!\.preview\.)|unsafe-eval|blob:|https:(?!\/\/)/);
  // the test checkout: no script, and its Pay button may return to the shop (a redirect Chrome checks against form-action)
  const { imitation } = await import('./payments.ts');
  const s = imitation('POST', '/v1/checkout/sessions', new URLSearchParams({ mode: 'payment', success_url: 'https://hello.preview.example.com/ok',
    cancel_url: 'https://hello.preview.example.com/', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'eur',
    'line_items[0][price_data][unit_amount]': '500', 'line_items[0][price_data][product_data][name]': 'Card' }));
  const page = await get(`/pay/imitation/${s.id}`), policy2 = page.headers.get('content-security-policy')!;
  assert.equal(page.status, 200);
  assert.match(policy2, /^default-src 'none';/); assert.doesNotMatch(policy2, /script-src/);
  assert.match(policy2, /form-action 'self' https:/); assert.match(policy2, /frame-ancestors 'self'/);
});

test('M5: with a real zone, HQ frames only its preview hosts and streams only to its own wss host', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['-e', "import('./src/pages.ts').then(p => console.log(p.csp()))"],
    { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, PUBLIC_HOST: 'hq.example.com' }, encoding: 'utf8' });
  assert.match(out, /connect-src 'self' wss:\/\/hq\.example\.com;/);
  assert.match(out, /frame-src 'self' https:\/\/\*\.preview\.example\.com;/);
});

test('C1 hand-off: SERVER_GITHUB_TOKEN is stored, fine-grained only, and never handed to jobs', () => {
  // (names() around saveSecrets)
  assert.ok(validNames('SERVER_GITHUB_TOKEN'));
  assert.ok(!validNames('SERVER_GITHUB_TOKENX') && !validNames('GITHUB_TOKEN'));
  assert.equal(names(saveSecrets(['SERVER_GITHUB_TOKEN'], { SERVER_GITHUB_TOKEN: 'ghp_classicClassicClassic123' })), null);
  assert.equal(names(saveSecrets(['SERVER_GITHUB_TOKEN'], { SERVER_GITHUB_TOKEN: 'github_pat_abc DEF' })), null);
  assert.deepEqual(names(saveSecrets(['SERVER_GITHUB_TOKEN', 'PRINTAPI_TEST_CLIENT_ID'],
    { SERVER_GITHUB_TOKEN: ' github_pat_11ABC_def123 ', PRINTAPI_TEST_CLIENT_ID: 'id-1' })), ['SERVER_GITHUB_TOKEN', 'PRINTAPI_TEST_CLIENT_ID']);
  assert.equal(readFileSync(`${process.env.SECRETS_DIR}/SERVER_GITHUB_TOKEN`, 'utf8'), 'github_pat_11ABC_def123');
  writeFileSync(`${process.env.SECRETS_DIR}/PRINTAPI_LIVE_CLIENT_ID`, 'live');
  assert.deepEqual(testSecrets(), { PRINTAPI_CLIENT_ID: 'id-1' });
});

test("the support chat's keys: stored in their shapes only, and never handed to jobs", () => {
  // (names() around saveSecrets, and the sign-in token and Admin key refused)
  const model = `sk-ant-api03-${'a1B_-'.repeat(19)}`, mail = 'lm_proj_0123456789abcdefXYZ';
  assert.ok(validNames('CARE_ANTHROPIC_API_KEY,CARE_EMAIL_API_KEY'));
  for (const v of ['sk-proj-abc123abc123abc123abc', 'sk-ant-short', `sk-ant-api03-${'a'.repeat(30)} x`, `sk-ant-oat01-${'a'.repeat(30)}`, `sk-ant-admin01-${'a'.repeat(30)}`])
    assert.equal(names(saveSecrets(['CARE_ANTHROPIC_API_KEY'], { CARE_ANTHROPIC_API_KEY: v })), null, v);
  for (const v of ['too-short-123', 'has a space in the token 0123456789', 'two\nlines-0123456789abcdef', 'x'.repeat(201), 'tab\there-0123456789abcdef', "quo'te-0123456789abcdef"])
    assert.equal(names(saveSecrets(['CARE_EMAIL_API_KEY'], { CARE_EMAIL_API_KEY: v })), null, v);
  assert.deepEqual(names(saveSecrets(['CARE_ANTHROPIC_API_KEY', 'CARE_EMAIL_API_KEY'], { CARE_ANTHROPIC_API_KEY: ` ${model}\n`, CARE_EMAIL_API_KEY: mail })),
    ['CARE_ANTHROPIC_API_KEY', 'CARE_EMAIL_API_KEY']);
  assert.equal(readFileSync(`${process.env.SECRETS_DIR}/CARE_ANTHROPIC_API_KEY`, 'utf8'), model);
  const job = JSON.stringify(testSecrets());
  assert.ok(!job.includes(model) && !job.includes(mail) && !job.includes('CARE_'));
});

test("the eval's Anthropic key: a test partner key in its shape, reaching jobs without _TEST_, never the server's model key", () => {
  // (names() and both() around saveSecrets, the sk-ant-usr keys and the reasons)
  const dir = process.env.SECRETS_DIR!, one = `sk-ant-api03-${'e1V_-'.repeat(19)}`, two = `sk-ant-api03-${'c2R_-'.repeat(19)}`;
  const reset = () => { for (const n of ['ANTHROPICEVAL_TEST_API_KEY', 'CARE_ANTHROPIC_API_KEY']) rmSync(`${dir}/${n}`, { force: true }); };
  const both = (care?: string, ev?: string) => saveSecrets(['CARE_ANTHROPIC_API_KEY', 'ANTHROPICEVAL_TEST_API_KEY'],
    { CARE_ANTHROPIC_API_KEY: care, ANTHROPICEVAL_TEST_API_KEY: ev }) as { saved: string[]; refused: Record<string, string> };
  reset();
  assert.ok(validNames('CARE_ANTHROPIC_API_KEY,ANTHROPICEVAL_TEST_API_KEY'));
  for (const n of ['ANTHROPICEVAL_LIVE_API_KEY', 'ANTHROPICEVAL_TEST_OTHER', 'ANTHROPIC_TEST_API_KEY', 'ANTHROPIC_API_KEY']) assert.ok(!validNames(n), n);
  for (const v of ['sk-proj-abc123abc123abc123abc', 'sk-ant-short', `sk-ant-api03-${'a'.repeat(30)} x`, 'rk_test_abc123abc123abc123',
    `sk-ant-oat01-${'a'.repeat(30)}`, `sk-ant-ort01-${'a'.repeat(30)}`, `sk-ant-sid01-${'a'.repeat(30)}`, `sk-ant-admin01-${'a'.repeat(30)}`])
    assert.equal(names(saveSecrets(['ANTHROPICEVAL_TEST_API_KEY'], { ANTHROPICEVAL_TEST_API_KEY: v })), null, v);
  // the console's own keys (sk-ant-usr…) are API keys too, in either field
  const usr = `sk-ant-usr01-${'u3W_-'.repeat(19)}`, usr2 = `sk-ant-usr-${'k4Z_-'.repeat(19)}`;
  assert.deepEqual(both(usr, usr2), { saved: ['CARE_ANTHROPIC_API_KEY', 'ANTHROPICEVAL_TEST_API_KEY'], refused: {} });
  reset();
  // the same key in both fields of one answer: neither is saved
  assert.deepEqual(both(two, ` ${two}\n`).saved, []);
  assert.ok(!existsSync(`${dir}/CARE_ANTHROPIC_API_KEY`) && !existsSync(`${dir}/ANTHROPICEVAL_TEST_API_KEY`));
  // ... or one already stored, either way round
  assert.deepEqual(names(saveSecrets(['CARE_ANTHROPIC_API_KEY'], { CARE_ANTHROPIC_API_KEY: two })), ['CARE_ANTHROPIC_API_KEY']);
  assert.deepEqual(both(undefined, two).saved, []);
  reset();
  assert.deepEqual(names(saveSecrets(['ANTHROPICEVAL_TEST_API_KEY'], { ANTHROPICEVAL_TEST_API_KEY: one })), ['ANTHROPICEVAL_TEST_API_KEY']);
  assert.equal(names(saveSecrets(['CARE_ANTHROPIC_API_KEY'], { CARE_ANTHROPIC_API_KEY: one })), null);
  // both in one answer, the server's key replaced and moved into the eval field: the care service still holds it until
  // it restarts, so nothing is saved, and a retry of the moved key alone is refused again; the same either way round
  // (names() and the retry)
  reset();
  assert.deepEqual(names(saveSecrets(['CARE_ANTHROPIC_API_KEY'], { CARE_ANTHROPIC_API_KEY: two })), ['CARE_ANTHROPIC_API_KEY']);
  assert.deepEqual(Object.keys(both(one, two).refused).sort(), ['ANTHROPICEVAL_TEST_API_KEY', 'CARE_ANTHROPIC_API_KEY']);
  assert.ok(!existsSync(`${dir}/ANTHROPICEVAL_TEST_API_KEY`) && secret('CARE_ANTHROPIC_API_KEY') === two);
  assert.deepEqual(Object.keys(both(undefined, two).refused), ['ANTHROPICEVAL_TEST_API_KEY']);
  assert.ok(!existsSync(`${dir}/ANTHROPICEVAL_TEST_API_KEY`));
  reset();
  assert.deepEqual(names(saveSecrets(['ANTHROPICEVAL_TEST_API_KEY'], { ANTHROPICEVAL_TEST_API_KEY: one })), ['ANTHROPICEVAL_TEST_API_KEY']);
  assert.deepEqual(Object.keys(both(one, two).refused).sort(), ['ANTHROPICEVAL_TEST_API_KEY', 'CARE_ANTHROPIC_API_KEY']);
  assert.ok(!existsSync(`${dir}/CARE_ANTHROPIC_API_KEY`) && secret('ANTHROPICEVAL_TEST_API_KEY') === one);
  assert.deepEqual(Object.keys(both(one).refused), ['CARE_ANTHROPIC_API_KEY']);
  assert.ok(!existsSync(`${dir}/CARE_ANTHROPIC_API_KEY`));
  // the server's key replaced while the eval field is refused for its shape (the old key plus a stray character): the
  // replacement isn't saved either, so a retry with the old key alone is still refused
  reset();
  assert.deepEqual(names(saveSecrets(['CARE_ANTHROPIC_API_KEY'], { CARE_ANTHROPIC_API_KEY: one })), ['CARE_ANTHROPIC_API_KEY']);
  assert.deepEqual(Object.keys(both(two, `${one}.`).refused).sort(), ['ANTHROPICEVAL_TEST_API_KEY', 'CARE_ANTHROPIC_API_KEY']);
  assert.equal(secret('CARE_ANTHROPIC_API_KEY'), one);
  assert.deepEqual(Object.keys(both(undefined, one).refused), ['ANTHROPICEVAL_TEST_API_KEY']);
  assert.ok(!existsSync(`${dir}/ANTHROPICEVAL_TEST_API_KEY`) && testSecrets().ANTHROPICEVAL_API_KEY === undefined);
  // ... and too long, the same
  assert.deepEqual(both(two, one + 'x'.repeat(4096)).saved, []);
  assert.equal(secret('CARE_ANTHROPIC_API_KEY'), one);
  // two different keys in one answer are saved, and the job gets the eval key alone
  reset();
  assert.deepEqual(names(both(one, two)), ['CARE_ANTHROPIC_API_KEY', 'ANTHROPICEVAL_TEST_API_KEY']);
  const job = testSecrets();
  assert.equal(job.ANTHROPICEVAL_API_KEY, two);
  assert.ok(!('ANTHROPIC_API_KEY' in job) && !('ANTHROPICEVAL_TEST_API_KEY' in job) && !JSON.stringify(job).includes(one));
  // on the desk phone: refused with a 400 that says why, the request still open
  const k = jobs.createRequest({ kind: 'credential', title: 'model keys', body: 'b', agent: 'bolt', secrets: 'CARE_ANTHROPIC_API_KEY,ANTHROPICEVAL_TEST_API_KEY' }) as { id: number };
  const no = jobs.answerRequest(k.id, '', { ANTHROPICEVAL_TEST_API_KEY: one }) as any;
  assert.equal(no[0], 400); assert.deepEqual(Object.keys(no[2].refused), ['ANTHROPICEVAL_TEST_API_KEY']);
  assert.equal((jobs.answerRequest(k.id, '', { CARE_ANTHROPIC_API_KEY: two }) as any)[0], 400);
  assert.equal(secret('ANTHROPICEVAL_TEST_API_KEY'), two);
  assert.equal((jobs.listRequests().find((x: any) => x.id === k.id) as any)?.status, 'open');
  // a file that got there some other way is checked at hand-out too: not in its shape, or the server's key, it stays
  writeFileSync(`${dir}/ANTHROPICEVAL_TEST_API_KEY`, one);
  assert.equal(testSecrets().ANTHROPICEVAL_API_KEY, undefined);
  writeFileSync(`${dir}/ANTHROPICEVAL_TEST_API_KEY`, 'not-a-key');
  assert.equal(testSecrets().ANTHROPICEVAL_API_KEY, undefined);
  writeFileSync(`${dir}/ANTHROPICEVAL_TEST_API_KEY`, `${two}\n`);
  assert.equal(testSecrets().ANTHROPICEVAL_API_KEY, two);
  reset();
});

test('a refused key says why, field by field, never its value; the other fields are saved all the same', () => {
  const dir = process.env.SECRETS_DIR!, CARE = 'CARE_ANTHROPIC_API_KEY', EVAL = 'ANTHROPICEVAL_TEST_API_KEY';
  const reset = () => { for (const n of [CARE, EVAL, 'STRIPE_TEST_WHY_KEY', 'STRIPE_LIVE_WHY_KEY']) rmSync(`${dir}/${n}`, { force: true }); };
  const key = (c: string) => `sk-ant-api03-${c.repeat(40)}`, why = (r: unknown) => (r as { refused: Record<string, string> }).refused;
  reset();
  // the whole card: nothing filled in, or a name the server can't keep
  assert.equal(typeof saveSecrets([CARE, EVAL], { CARE: ' ' }), 'string');
  const kept = saveSecrets(['ANTHROPIC_API_KEY'], { ANTHROPIC_API_KEY: key('a') });
  assert.equal(typeof kept, 'string'); assert.ok(!String(kept).includes(key('a')), 'never the value');
  // one field: too long, not its shape (a sign-in token, an Admin key, anything else), the same as the other field, or
  // the one the server holds for the other field; each kind with a reason of its own
  const cases: [Record<string, string>, string][] = [
    [{ [CARE]: key('a') + 'b'.repeat(4096) }, CARE],
    [{ [EVAL]: `sk-ant-oat01-${'a'.repeat(40)}` }, EVAL],
    [{ [EVAL]: `sk-ant-admin01-${'a'.repeat(40)}` }, EVAL],
    [{ [EVAL]: 'sk-proj-abc123abc123abc123abc' }, EVAL],
  ];
  const reasons = new Set<string>();
  for (const [values, n] of cases) {
    const r = saveSecrets([CARE, EVAL], values);
    assert.deepEqual(Object.keys(why(r)), [n]); assert.deepEqual((r as any).saved, []); reasons.add(why(r)[n]);
    assert.ok(!JSON.stringify(r).includes(values[n]), 'never the value');
  }
  const same = saveSecrets([CARE, EVAL], { [CARE]: key('c'), [EVAL]: key('c') });
  assert.deepEqual(Object.keys(why(same)).sort(), [EVAL, CARE]); assert.ok(!JSON.stringify(same).includes(key('c')));
  for (const n of [CARE, EVAL]) reasons.add(why(same)[n]);
  assert.equal(reasons.size, cases.length + 1);
  // the two fields kept apart are saved together or not at all: one refused, the other's new key waits for it
  const pair = saveSecrets([CARE, EVAL], { [CARE]: key('d'), [EVAL]: `sk-ant-oat01-${'a'.repeat(40)}` });
  assert.deepEqual(Object.keys(why(pair)).sort(), [EVAL, CARE]); assert.ok(!reasons.has(why(pair)[CARE]) && !existsSync(`${dir}/${CARE}`));
  assert.deepEqual(names(saveSecrets([CARE], { [CARE]: key('d') })), [CARE]);
  // one refused, the other saved: on the desk phone the card stays open, saying which and why
  const STRIPE = 'STRIPE_TEST_WHY_KEY', rk = `rk_test_${'w5'.repeat(20)}`;
  const k = jobs.createRequest({ kind: 'credential', title: 'why keys', body: 'b', agent: 'bolt', secrets: `${STRIPE},${EVAL}` }) as { id: number };
  const r = jobs.answerRequest(k.id, '', { [STRIPE]: rk, [EVAL]: `sk-ant-oat01-${'a'.repeat(40)}` }) as any;
  assert.equal(r[0], 400); assert.deepEqual(Object.keys(r[2].refused), [EVAL]); assert.deepEqual(r[2].missing, [EVAL]);
  assert.equal(secret(STRIPE), rk); assert.ok(!existsSync(`${dir}/${EVAL}`));
  const open = jobs.listRequests().find((x: any) => x.id === k.id) as any;
  assert.equal(open.status, 'open'); assert.deepEqual(open.saved, [STRIPE]);
  const held = jobs.answerRequest(k.id, '', { [EVAL]: ` ${key('d')} ` }) as any;
  assert.equal(held[0], 400); assert.deepEqual(Object.keys(held[2].refused), [EVAL]); assert.ok(!JSON.stringify(held).includes(key('d')));
  assert.ok(!reasons.has(held[2].refused[EVAL]));
  assert.deepEqual(jobs.answerRequest(k.id, '', { [EVAL]: key('e') }), { ok: true });
  assert.equal(secret(EVAL), key('e'));
  // a card refused as a whole says so in words, with no field to point at
  const k2 = jobs.createRequest({ kind: 'credential', title: 'why keys 2', body: 'b', agent: 'bolt', secrets: 'STRIPE_TEST_WHY_KEY,STRIPE_LIVE_WHY_KEY' }) as { id: number };
  const whole = jobs.answerRequest(k2.id, '', {}) as any;
  assert.equal(whole[0], 400); assert.equal(typeof whole[1], 'string'); assert.deepEqual(whole[2], { refused: {} });
  reset();
});

test('L1: keys in event text are redacted before they are stored or sent', async () => {
  publish({ type: 'log', agent: 'x', text: 'clone failed: https://x-access-token:ghs_abcdefgh12345678@github.com/a/b token ghp_ABCDEFGHijklmnop1234 and github_pat_11AA_bbbbbbbb, Bearer abc.def-ghi_jkl sk-ant-api03-zzzzzzzzzz' });
  const t = (await lastEvent()).text;
  assert.doesNotMatch(t, /ghs_|ghp_|github_pat_|abc\.def|sk-ant/);
  assert.match(t, /^clone failed: https:\/\/\[redacted\]@github\.com/);
});

test('L1: main\'s new key shapes (Stripe, Twilio, payments, named keys) are redacted; ordinary words are not', async () => {
  const hex = (n: number) => 'c0ffee42'.repeat(n / 8);
  const keys = [`sk_live_51Hx${'A'.repeat(20)}`, `sk_test_51Hx${'B'.repeat(20)}`, `rk_live_51Hx${'C'.repeat(20)}`, `rk_test_51Hx${'D'.repeat(20)}`,
    `whsec_${'E'.repeat(32)}`, `AC${hex(32)}:${hex(32)}`, hex(64), `QUM${'x'.repeat(40)}=`, 'PinOfTheBoard9', 'hq-job-token-123456'];
  const text = `stripe ${keys[0]} ${keys[1]} ${keys[2]} ${keys[3]} ${keys[4]}; curl -u ${keys[5]} https://AC${hex(32)}:${hex(32)}@api.twilio.com; ` +
    `authorization: Bearer ${keys[6]}; Authorization: Basic ${keys[7]}; env: CALL_PIN=${keys[8]} HQ_TOKEN='${keys[9]}' TWILIO_AUTH_TOKEN: ${hex(32)} {"PAYMENTS_TOKEN":"${hex(64)}"}`;
  publish({ type: 'log', agent: 'x', text });
  const t = (await lastEvent()).text;
  for (const k of [...keys, hex(32)]) assert.ok(!t.includes(k), k);
  assert.match(t, /CALL_PIN=\[redacted\] HQ_TOKEN='\[redacted\]' TWILIO_AUTH_TOKEN: \[redacted\] \{"PAYMENTS_TOKEN":"\[redacted\]"\}/);
  // the replay to a fresh HQ tab is redacted too, even for a row stored before redaction existed
  db.prepare("insert into events (ts, type, agent, text) values (?, 'log', 'x', ?)").run(new Date().toISOString(), `old ${keys[0]}`);
  const replay = (await h.feed()).map(e => e.text).join('\n');
  assert.ok(replay.includes('old [redacted]') && !replay.includes(keys[0]));
  // words that merely contain a prefix, and names without a value, stay as they are
  const plain = 'desk-phone-requests, task_queue_items, risk_test_plan, MERGE_KEY: set, AC/DC, commit ' + hex(40);
  publish({ type: 'log', agent: 'x', text: plain });
  assert.equal((await lastEvent()).text, plain);
});

test('L3: one client can\'t fill the pending challenges; many are capped without evicting a live one', async t => {
  // the clock stands still: on a busy disk these 20k+ writes outlast a challenge's 5 minutes, and expiry isn't what's tested
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const res = { appendHeader() {} } as any;
  const from = (ip: string) => ({ headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '::ffff:127.0.0.1' } }) as any;   // via Caddy
  db.exec('delete from challenges');
  await loginOptions(from('198.51.100.7'), res);
  const board = firstChallenge();   // the board, signing in
  // one client, many calls: it keeps only its own 5 newest, and nobody is refused
  let refused = 0;
  for (let i = 0; i < 200; i++) if (await loginOptions(from('203.0.113.9'), res) === 429) refused++;
  assert.equal(refused, 0);
  assert.equal(challenges(), 6);
  assert.ok(held(board));
  // an IPv6 /64 is one client, however its addresses are written ('2001:db8::1' has only two groups before the '::')
  const x = (i: number) => (i & 0xffff).toString(16);
  const spellings = (i: number) => [`2001:db8:1:2::${x(i)}`, `2001:db8::${x(i)}`.replace('db8::', 'db8:1:2::'), `2001:DB8:0001:0002:${x(i)}::`,
    `2001:db8:1:2:${x(i)}:${x(i >> 3)}::${x(i + 1)}`, `2001:0db8:0001:0002:0:${x(i)}:0:${x(i)}`, `2001:db8:1:2::${x(i)}:1.2.3.4`];
  for (let i = 0; i < 40; i++) for (const ip of spellings(i)) await loginOptions(from(ip), res);
  assert.equal(challenges(), 11);
  // and so is a /64 whose prefix itself compresses (2001:db8:0:0::/64): its many hosts can't fill the map
  for (let i = 0; i < 200; i++) await loginOptions(from(i % 2 ? `2001:db8::${x(i)}:${x(i * 7)}` : `2001:db8:0:0:${x(i)}::1`), res);
  assert.equal(challenges(), 16);
  // an IPv4-mapped address is its IPv4 client
  await loginOptions(from('::ffff:203.0.113.9'), res);
  assert.equal(challenges(), 16);
  // many different clients: the map stops at 2000 and refuses the rest, the board's stays
  for (let i = 0; i < 2100; i++) if (await loginOptions(from(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`), res) === 429) refused++;
  assert.equal(challenges(), 2000);
  assert.equal(refused, 2100 - (2000 - 16));
  assert.ok(held(board));
  // expired challenges are swept on the next call (no route moves a clock)
  db.exec('update challenges set expires = 0');
  assert.notEqual(await loginOptions(from('203.0.113.9'), res), 429);
  assert.equal(challenges(), 1);
});

test('passkeys are asked to verify the board, as the verify steps require', async () => {
  const options = (path: string, body = {}) => fetch(`${h.base}${path}`,
    { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const code = 'enroll-uv-test';
  commitFile(`infra/enroll/${Math.floor(Date.now() / 1000) + 600}.sha256`, createHash('sha256').update(code).digest('hex'), ENROLL);
  assert.equal((await options('/api/enroll/options', { code })).authenticatorSelection.userVerification, 'required');
  assert.equal((await options('/api/login/options')).userVerification, 'required');
});

const ENROLL = 'Enroll a board device (one-time code, expires in 30 minutes)';   // (enroll.yml's commit)
test('I4: an enrollment code counts only from the Enroll device workflow\'s own commit, and for 35 minutes after it', async () => {
  const enroll = (code: string) => fetch(`${h.base}/api/enroll/options`,
    { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).then(r => r.status);
  const repo = process.env.REPO_DIR!, now = Math.floor(Date.now() / 1000);
  let epoch = 9999999000;   // (expiries far ahead: the file's name doesn't decide)
  const add = (code: string, options = {}) =>
    commitFile(`infra/enroll/${epoch++}.sha256`, createHash('sha256').update(code).digest('hex'), ENROLL, options);
  add('the-workflows-own-code');
  assert.equal(await enroll('the-workflows-own-code'), 200);
  add('thirty-six-minutes-old', { at: now - 36 * 60 });
  assert.equal(await enroll('thirty-six-minutes-old'), 403);
  // a pull request's file, though its commit has the bot's name and words: main has it from the merge
  git(repo, 'checkout', '-q', '-b', 'job/2');
  add('from-a-pull-request');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge PR #2 after review (round 1)', 'job/2');
  assert.equal(await enroll('from-a-pull-request'), 403);
  add('someone-elses-commit', { by: { name: 'Bolt', email: 'bolt@agents.testco.example' } });
  assert.equal(await enroll('someone-elses-commit'), 403);
  commitFile(`infra/enroll/9999999999.sha256`, createHash('sha256').update('another-workflows').digest('hex'), "Email: rotate the inbox Worker's token");
  assert.equal(await enroll('another-workflows'), 403);
  // a merged file named as a glob: git would read `*.sha256` as every enrollment file, the workflow's next one among them
  git(repo, 'checkout', '-q', '-b', 'job/3');
  commitFile('infra/enroll/*.sha256', createHash('sha256').update('a-glob').digest('hex'), ENROLL);
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge PR #3 after review (round 1)', 'job/3');
  add('the-next-real-one');
  assert.equal(await enroll('a-glob'), 403);
  // git can't be read: no code counts
  add('while-git-is-gone');
  renameSync(`${repo}/.git`, `${repo}/.git-away`);
  try {
    assert.equal(await enroll('while-git-is-gone'), 403);
  } finally {
    renameSync(`${repo}/.git-away`, `${repo}/.git`);
  }
  assert.equal(await enroll('while-git-is-gone'), 200);
});

test('L3: X-Forwarded-For counts only from Caddy: a job on coordinator:8080 is one client, whatever it writes there', async () => {
  db.exec('delete from challenges');
  const options = (host: string, forwardedFor: string) => fetch(`http://${host}:${new URL(h.base).port}/api/login/options`,
    { method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': forwardedFor } }).then(r => r.status);
  assert.equal(await options('127.0.0.1', '198.51.100.7'), 200);   // the board, through Caddy
  const board = firstChallenge();
  // a job straight to the coordinator (not Caddy's address): 2,000 made-up clients, and the board's among them
  let refused = 0;
  for (let i = 0; i < 200; i++) if (await options('[::1]', i % 100 ? `10.9.${i >> 8}.${i & 255}` : '198.51.100.7') === 429) refused++;
  assert.equal(refused, 0);
  assert.equal(challenges(), 6);   // the job (::1, its /64) keeps its own 5 newest
  assert.deepEqual(new Set((db.prepare('select client from challenges').all() as { client: string }[]).map(p => p.client)), new Set(['198.51.100.7', '0:0:0:0::/64']));
  assert.ok(held(board));
  // the board's next sign-in through Caddy still gets a challenge, and so do other clients
  assert.equal(await options('127.0.0.1', '198.51.100.7'), 200);
  assert.equal(await options('127.0.0.1', '203.0.113.9'), 200);
  assert.equal(challenges(), 8);
});

test('N3: a symlink in a served folder does not lead out of it', async () => {
  const link = `${process.env.REPO_DIR}/knowledge/n3-test-leak.json`;
  symlinkSync(`${process.env.DATA_DIR}/hq.db`, link);
  try {
    const get = (p: string) => fetch(h.base + p, { headers: { cookie: h.boardCookie } });
    assert.equal((await get('/knowledge/n3-test-leak.json')).status, 404);
    assert.equal((await get('/knowledge/posts/2026-09-25-were-open/cover.png')).status, 200);   // real files still work
  } finally { unlinkSync(link); }
});

test('hq note: a sent review note is readable on the agent API only by the agent it was sent to', async () => {
  const mine = await running('bolt'), theirs = await running('wren');
  const note = (status: string) => (db.prepare(`insert into review_notes (created, slug, page, element, note, status, job)
    values (?, 'hello', '/', '{"v":1,"url":"https://hello.preview.company.test/","el":null,"view":{"w":0,"h":0,"x":0,"y":0,"dpr":1},"ink":[],"kind":"general","area":null,"html":""}', 'Too pale', ?, ?)`).run(new Date().toISOString(), status, mine.id)).lastInsertRowid;
  const sent = note('sent'), pending = note('pending'); // (a v1 general mark)
  const r = await agent(`note?id=${sent}`, mine.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.note, 'Too pale');
  assert.equal((await agent(`note?id=${sent}`, theirs.token)).status, 404);    // another agent's job
  assert.equal((await agent(`note?id=${pending}`, mine.token)).status, 404);   // not sent by the board yet
  assert.equal((await call(`/api/worker/note?id=${sent}`, WORKER_TOKEN)).status, 404);   // not on the worker API
});

test('hq photos: a request\'s photos are readable on the agent API only by the agent who asked', async () => {
  const mine = await running('dex'), theirs = await running('wren');
  const id = await h.ask(mine, { kind: 'action', title: 'Photos', body: '.', photos: [{ label: 'Top edge' }] });
  const r = await agent(`photos?id=${id}`, mine.token);
  assert.equal(r.status, 200);
  assert.equal(r.body[0].label, 'Top edge');
  assert.equal((await agent(`photos?id=${id}`, theirs.token)).status, 404);          // another agent's request
  assert.equal((await agent(`photo?id=${id}&field=0`, theirs.token)).status, 404);
  assert.equal((await call(`/api/worker/photos?id=${id}`, WORKER_TOKEN)).status, 404);   // not on the worker API
});
