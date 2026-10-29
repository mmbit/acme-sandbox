// node --test src/refreshes.test.ts   (a stand-in provider, and one loopback port)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexRefreshes, serveRefreshes, type RefreshState, type TokenAnswer } from './refreshes.ts';

const signIn = (generation: number, account = 'acct') =>
  JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: `id${generation}`,
      access_token: `a${generation}`,
      refresh_token: `r${generation}`,
      account_id: account,
    },
    last_refresh: 'then',
  });
const ask = (token: string) =>
  JSON.stringify({ client_id: 'codex', grant_type: 'refresh_token', refresh_token: token });
const issued = (generation: number): TokenAnswer => ({
  status: 200,
  body: JSON.stringify({
    id_token: `id${generation}`,
    access_token: `a${generation}`,
    refresh_token: `r${generation}`,
  }),
});
const refreshOf = (answer: TokenAnswer) => JSON.parse(answer.body).refresh_token;

// One seat's sign-in, a provider that answers each exchange when the test says so, and the state a reload would read.
function seat(start = signIn(0), state: RefreshState = { lineages: {}, holders: {} }) {
  const seatFile = { text: start as string | undefined };
  const exchanges: { body: string; answer: (answer: TokenAnswer) => void }[] = [];
  const kept = { state: JSON.stringify(state) };
  const refreshes = codexRefreshes({
    read: id => (id === 'codex-1' ? seatFile.text : undefined),
    save: (_id, text) => (seatFile.text = text),
    exchange: body => new Promise(answer => exchanges.push({ body, answer })),
    state,
    keep: next => (kept.state = JSON.stringify(next)),
  });
  const seatToken = () => JSON.parse(seatFile.text!).tokens.refresh_token;
  const run = (name: string) => refreshes.handOut(name, 'codex-1', seatFile.text!);
  return { seatFile, exchanges, refreshes, seatToken, run, kept };
}

test('a run that asks with the same refresh token while the first exchange is out gets its answer, never a refusal', async () => {
  const { exchanges, refreshes, seatToken, run } = seat();
  const a = run('job 1'),
    b = run('job 2');
  const first = refreshes.refresh(a, ask('r0'));
  const second = refreshes.refresh(b, ask('r0'));
  await Promise.resolve();
  assert.equal(exchanges.length, 1, 'the provider sees one exchange');
  exchanges[0].answer(issued(1));
  assert.deepEqual(await second, issued(1), 'the second run is answered before the first has its tokens back home');
  assert.deepEqual(await first, issued(1));
  assert.equal(seatToken(), 'r1');
  assert.equal(refreshes.signedOut('codex-1'), false);
});

test('a run whose copy another run already refreshed, twice, gets its sign-in as the last refresh left it', async () => {
  const { exchanges, refreshes, seatFile, seatToken, run } = seat();
  const a = run('job 1'),
    b = run('job 2');
  const first = refreshes.refresh(a, ask('r0'));
  exchanges[0].answer(issued(1));
  await first;
  const again = refreshes.refresh(a, ask('r1'));
  exchanges[1].answer(issued(2));
  assert.equal(refreshOf(await again), 'r2');
  assert.equal(seatToken(), 'r2', 'the second refresh is saved after the first');
  const late = await refreshes.refresh(b, ask('r0'));
  assert.equal(exchanges.length, 2, 'a spent token never reaches the provider');
  assert.equal(refreshOf(late), 'r2');
  assert.equal(JSON.parse(seatFile.text!).tokens.account_id, 'acct');
  assert.equal(refreshOf(await refreshes.refresh(run('job 3'), ask('r1'))), 'r2', 'a new run joins the same sign-in');
  assert.equal(exchanges.length, 2);
});

test("a spent token asked with while a later exchange is out waits for that exchange's tokens", async () => {
  const { exchanges, refreshes, run } = seat();
  const a = run('job 1'),
    b = run('job 2');
  const first = refreshes.refresh(a, ask('r0'));
  exchanges[0].answer(issued(1));
  await first;
  const again = refreshes.refresh(a, ask('r1'));
  const late = refreshes.refresh(b, ask('r0'));
  exchanges[1].answer(issued(2));
  await again;
  assert.equal(refreshOf(await late), 'r2');
});

test("a run handed the sign-in while an ended run's exchange is still out shares that exchange", async () => {
  const { exchanges, refreshes, seatToken, run, kept } = seat();
  const first = refreshes.refresh(run('job 1'), ask('r0'));
  refreshes.end('job 1');
  const second = refreshes.refresh(run('job 2'), ask('r0'));
  await Promise.resolve();
  assert.equal(exchanges.length, 1, 'the provider sees r0 once');
  refreshes.end('job 2');
  exchanges[0].answer(issued(1));
  assert.deepEqual(await second, issued(1));
  await first;
  assert.equal(seatToken(), 'r1');
  assert.deepEqual(JSON.parse(kept.state).lineages, {}, 'a sign-in no run holds is dropped once its exchange is in');
});

test('only a live run on its own sign-in is answered, and nothing else reaches the provider', async () => {
  const { exchanges, refreshes, run } = seat();
  const a = run('job 1');
  assert.equal((await refreshes.refresh('f'.repeat(64), ask('r0'))).status, 404, 'no such run');
  assert.equal((await refreshes.refresh(a, '{}')).status, 400, 'no refresh token');
  assert.equal((await refreshes.refresh(a, 'not json')).status, 400);
  assert.equal((await refreshes.refresh(a, ask('r9'))).status, 401, "not a token of the run's sign-in");
  const first = refreshes.refresh(a, ask('r0'));
  exchanges[0].answer(issued(1));
  await first;
  refreshes.end('job 1');
  assert.equal(
    (await refreshes.refresh(a, ask('r0'))).status,
    404,
    "an ended run's path reads nothing, a spent token included",
  );
  assert.equal(exchanges.length, 1);
});

test("a run on a sign-in the board replaced stays in that sign-in's own line, and its runs share one exchange", async () => {
  const { exchanges, refreshes, seatFile, seatToken, run } = seat();
  const a = run('job 1'),
    b = run('job 2'),
    c = run('job 3');
  seatFile.text = signIn(5, 'other');
  const first = refreshes.refresh(a, ask('r0'));
  const second = refreshes.refresh(b, ask('r0'));
  await Promise.resolve();
  assert.equal(exchanges.length, 1, "the replaced sign-in's runs share one exchange");
  exchanges[0].answer(issued(1));
  assert.equal(refreshOf(await second), 'r1');
  await first;
  assert.equal(seatToken(), 'r5', "the seat keeps the board's new sign-in");
  const late = await refreshes.refresh(c, ask('r0'));
  assert.equal(refreshOf(late), 'r1', "a spent token reads its own line's tokens, never the replacement's");
});

test("the provider refusing the seat's own sign-in signs the seat out, and a replaced sign-in's refusal doesn't", async () => {
  const refusal = { status: 401, body: '{"error":{"code":"refresh_token_reused"}}' };
  const replaced = seat();
  const old = replaced.refreshes.refresh(replaced.run('job 1'), ask('r0'));
  replaced.seatFile.text = signIn(5);
  replaced.exchanges[0].answer(refusal);
  assert.deepEqual(await old, refusal);
  assert.equal(replaced.refreshes.signedOut('codex-1'), false);

  const own = seat();
  const mine = own.refreshes.refresh(own.run('job 1'), ask('r0'));
  own.exchanges[0].answer(refusal);
  await mine;
  own.refreshes.end('job 1');
  assert.equal(own.refreshes.signedOut('codex-1'), true, 'still known once its run has ended');
  own.seatFile.text = signIn(9);
  assert.equal(own.refreshes.signedOut('codex-1'), false, 'a new sign-in by the board stands');
});

test('a refresh that comes back after the board signed the seat in again leaves the new sign-in', async () => {
  const { exchanges, refreshes, seatFile, seatToken, run } = seat();
  const first = refreshes.refresh(run('job 1'), ask('r0'));
  seatFile.text = signIn(7, 'other');
  exchanges[0].answer(issued(1));
  await first;
  assert.equal(seatToken(), 'r7');
});

test("a provider's 200 without usable tokens fails the runs' refresh loudly", async () => {
  const { exchanges, refreshes, seatToken, run } = seat();
  const first = refreshes.refresh(run('job 1'), ask('r0'));
  exchanges[0].answer({ status: 200, body: JSON.stringify({ access_token: '', refresh_token: 'r1' }) });
  await assert.rejects(first, /codex-1: the provider's refresh came back without usable tokens/);
  assert.equal(seatToken(), 'r0');
});

test('a seat with a key, or none, is signed out by a failed run', () => {
  assert.equal(seat(JSON.stringify({ OPENAI_API_KEY: 'k', tokens: null })).refreshes.signedOut('codex-1'), true);
  const none = seat();
  none.seatFile.text = undefined;
  assert.equal(none.refreshes.signedOut('codex-1'), true);
});

test('a new worker carries on: the runs it took over keep their paths and spent tokens, the others lose theirs', async () => {
  const before = seat();
  const a = before.run('job 1'),
    b = before.run('job 2'),
    gone = before.run('job 3');
  const first = before.refreshes.refresh(a, ask('r0'));
  before.exchanges[0].answer(issued(1));
  await first;
  const after = seat(before.seatFile.text, JSON.parse(before.kept.state));
  after.refreshes.endAllBut(['job 1', 'job 2']);
  assert.equal(refreshOf(await after.refreshes.refresh(b, ask('r0'))), 'r1', 'the spent token is still known');
  assert.equal(after.exchanges.length, 0);
  assert.equal((await after.refreshes.refresh(gone, ask('r0'))).status, 404);
  assert.equal(after.refreshes.capabilityOf('job 1'), a);
});

test('runs reach the refreshes over the loopback, each on its own path', async t => {
  const { exchanges, refreshes, run } = seat();
  const logged: unknown[][] = [];
  const { port, close } = await serveRefreshes(refreshes.refresh, { port: 0 }, (...args) => logged.push(args));
  t.after(close);
  const post = (path: string, body = ask('r0')) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
  const a = run('job 1'),
    b = run('job 2');
  const both = Promise.all([post(`/codex/${a}`), post(`/codex/${b}`)]);
  while (!exchanges.length) await new Promise(r => setTimeout(r, 5));
  exchanges[0].answer(issued(1));
  for (const response of await both) assert.equal((await response.json()).refresh_token, 'r1');
  assert.equal(exchanges.length, 1);
  assert.equal((await post('/codex/codex-1')).status, 404, "a seat's name is no way in");
  assert.equal((await fetch(`http://127.0.0.1:${port}/codex/${a}`)).status, 404);
  assert.equal((await post(`/codex/${a}`, 'x'.repeat(20_000))).status, 413);
  assert.match(String(logged.at(-1)?.[0]), /over 16000 characters/);
});
