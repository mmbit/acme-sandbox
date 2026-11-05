// node --test src/oversight.test.ts   (throwaway DATA_DIR and the test company): the Overseer's read-only route, the
// status report whole or what changed, the CEO's notes, and the key the board gives it from Settings › Overseer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { harness } from './harness.ts';

const h = await harness('oversight');
const { redact } = await import('./secrets.ts');
const { age } = await import('../../worker/hq/report.ts');
const REPORTS = `${h.dataDir}/status`;

const overseer = (path: string, key: string) => h.send(`/api/overseer/${path}`, { authorization: `Bearer ${key}` });
// A status report as infra/report.sh leaves it: gzipped, named by its UTC time
const report = (at: string, text: string) => {
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(`${REPORTS}/${at.replace(/[-:]/g, '')}.md.gz`, gzipSync(text));
};
const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}`).join('\n');
const FIRST = `# Server status\n== memory\n${lines(20, 'free')}\n== work\n${lines(20, 'job')}\n`;
const SECOND = FIRST.replace('job 7\n', 'job 7 done\n');

test('the board makes the key in HQ, and only that key reads', async () => {
  assert.equal((await overseer('status', 'overseer_nothing')).status, 401, 'no key made yet: nothing reads');
  const shown = (await h.board('/api/oversight')).body;
  assert.match(shown.key, /^overseer_[A-Za-z0-9_-]{43}$/);
  assert.equal(shown.address, 'http://localhost:8080/api/overseer/');
  assert.equal(shown.read, null, 'not read yet');
  assert.equal((await h.board('/api/oversight')).body.key, shown.key, 'the same key every time the page opens');
  assert.equal(redact(`the key is ${shown.key}`), 'the key is [OVERSEER_READ_KEY]', 'masked in any text as a key');
  assert.equal((await overseer('status', 'overseer_' + 'x'.repeat(43))).status, 401, 'another key');
  assert.equal((await h.send('/api/overseer/status')).status, 401, 'no key');
  assert.equal(
    (await h.send('/api/overseer/status', { cookie: h.boardCookie })).status,
    401,
    "the board's session isn't a key",
  );

  const renewed = (await h.board('/api/oversight/renew', {})).body;
  assert.notEqual(renewed.key, shown.key);
  assert.equal((await overseer('notes', shown.key)).status, 401, 'a new key ends the old one');
  assert.equal((await overseer('notes', renewed.key)).status, 200);
  assert.ok((await h.board('/api/oversight')).body.read, 'the last read shows on Settings');
});

test('the status report: whole, then only what changed since the last read', async () => {
  const { key } = (await h.board('/api/oversight')).body;
  rmSync(REPORTS, { recursive: true, force: true });
  assert.equal((await overseer('status', key)).status, 404, 'no report yet');

  report('2026-10-17T10:00:00Z', FIRST);
  report('2026-10-17T10:10:00Z', SECOND);
  const whole = await overseer('status', key);
  assert.equal(whole.status, 200);
  assert.equal(whole.text, SECOND, 'the newest, whole');
  assert.equal(whole.headers['x-as-of'], '2026-10-17T10:10:00Z');
  assert.equal(whole.headers['cache-control'], 'private, no-store');

  const changed = await overseer('status?since=2026-10-17T10:05:00Z', key);
  assert.match(changed.text, /from 2026-10-17T10:00:00Z to 2026-10-17T10:10:00Z/, 'from the report it had then');
  assert.match(changed.text, /^@@ -\d+,3 \+\d+,3 @@ == work$/m, "the hunk names the report's section");
  assert.match(changed.text, /^-job 7$/m);
  assert.match(changed.text, /^\+job 7 done$/m);
  assert.doesNotMatch(changed.text, /free 3|^diff --git|before\.md/m, 'nothing unchanged far off, no git file header');
  assert.ok(changed.text.length < 400, 'a few lines, not the report');

  const none = await overseer(`status?since=${whole.headers['x-as-of']}`, key);
  assert.equal(none.text, 'No report since 2026-10-17T10:10:00Z.\n');
  const older = await overseer('status?since=2026-10-16T00:00:00Z', key);
  assert.match(
    older.text,
    /^HQ keeps reports from 2026-10-17T10:00:00Z on/,
    'older than every kept report: the newest whole',
  );
  assert.ok(older.text.endsWith(SECOND));
  assert.equal((await overseer('status?since=yesterday', key)).status, 400);
  assert.equal((await overseer('budget', key)).status, 404, 'status and notes only');
});

test("the CEO's notes: all of them, or the ones let out since the last read", async () => {
  const { key } = (await h.board('/api/oversight')).body;
  const job = h.queue({ agent: 'juno', title: 'notes', prompt: 'notes' });
  const note = h.db.prepare('insert into overseer_notes (at, job, text, released, released_at) values (?, ?, ?, ?, ?)');
  note.run('2026-10-01T09:00:00.000Z', job, 'The first note.', 1, '2026-10-01T09:30:00.000Z');
  // written before the reader's last read, let out after it
  note.run('2026-10-01T10:00:00.000Z', job, 'The second note.', 2, '2026-10-01T11:00:00.000Z');
  note.run('2026-10-01T10:30:00.000Z', job, 'Still held.', null, null);

  const all = await overseer('notes', key);
  assert.match(all.text, /^# To the Overseer, from the CEO/);
  assert.match(all.text, /The second note\.[\s\S]*The first note\./, 'newest first');
  assert.doesNotMatch(all.text, /Still held/, 'a held note waits for its run to end');
  assert.ok(Date.parse(all.headers['x-as-of']) > Date.parse('2026-10-01T11:00:00Z'));

  const since = await overseer('notes?since=2026-10-01T10:15:00Z', key);
  assert.match(since.text, /The second note\./);
  assert.doesNotMatch(since.text, /The first note\./);
});

// hq report: the same reports for every agent, on its job's token
test('an agent reads the reports with hq report: the newest, one of a time, what changed since, and the list', async () => {
  rmSync(REPORTS, { recursive: true, force: true });
  const job = await h.start({ agent: 'bolt' });
  const none = await h.hq(job, 'report');
  assert.equal(none.code, 1);
  assert.match(none.out, /No status report has reached HQ yet\./);
  assert.match((await h.hq(job, 'report', '--list')).out, /No status report has reached HQ yet\./);

  report('2026-10-17T10:00:00Z', FIRST);
  report('2026-10-17T10:10:00Z', SECOND);
  const newest = await h.hq(job, 'report');
  assert.equal(newest.code, 0, newest.out);
  // (its first line says how long ago it was written, so an old report never reads as live.)
  assert.equal(newest.out, `(the report of 2026-10-17T10:10:00Z, ${age('2026-10-17T10:10:00Z')})\n${SECOND}`);
  assert.equal(
    (await h.hq(job, 'report', '--at', '2026-10-17T10:05Z')).out,
    `(the report of 2026-10-17T10:00:00Z, ${age('2026-10-17T10:00:00Z')})\n${FIRST}`,
    'the newest at or before --at',
  );
  const written = Date.parse('2026-11-04T22:47:20Z');
  assert.deepEqual(
    [0, 59_999, 34 * 60_000 + 5_000, 119 * 60_000, 125 * 60_000, 50 * 3_600_000].map(ms =>
      age('2026-11-04T22:47:20Z', written + ms),
    ),
    [
      'written under a minute ago',
      'written under a minute ago',
      'written 34 min ago',
      'written 119 min ago',
      'written 2 h 5 min ago',
      'written 2 days ago',
    ],
    "the report's age, in minutes, hours or days",
  );
  const changed = (await h.hq(job, 'report', '--since', '2026-10-17T10:05:00Z')).out;
  assert.match(changed, /^@@ -\d+,3 \+\d+,3 @@ == work$/m);
  assert.match(changed, /^\+job 7 done$/m);
  assert.doesNotMatch(changed, /free 3/);
  assert.match(
    (await h.hq(job, 'report', '--at', '2026-10-17T10:05Z', '--since', '2026-10-17T10:00Z')).out,
    /No report since 2026-10-17T10:00:00Z\./,
  );
  assert.match(
    (await h.hq(job, 'report', '--at', '2026-10-16T00:00Z')).out,
    /HQ keeps reports from 2026-10-17T10:00:00Z on\./,
  );
  assert.match((await h.hq(job, 'report', '--since', 'yesterday')).out, /a time is an ISO time/);
  assert.equal((await h.hq(job, 'report', '--list')).out, '2026-10-17T10:00:00Z\n2026-10-17T10:10:00Z\n');
  assert.equal((await h.send('/api/agent/report')).status, 401, 'a job token only');
});

test('a call with the board, whole: every line, its items and its follow-ups, but never a live one or one about a customer', async () => {
  const key = (await h.board('/api/oversight')).body.key;
  const long = Array.from({ length: 900 }, (_, i) => `board: point ${i} of the plan, said at length`);
  h.db
    .prepare("insert into calls (id, ts, agent, lines, status) values (90, '2026-10-18T21:00:00Z', 'kit', ?, 'ended')")
    .run(JSON.stringify(long));
  const job = h.queue({ agent: 'kit', title: 'Follow up on your call with the board', call: 90 });
  h.db.prepare("update jobs set status = 'done', result = 'Set the plan up.' where id = ?").run(job);
  h.db
    .prepare(
      "insert into call_items (call, kind, owner, what, quote, status, job, ts) values (90, 'task', 'kit', 'Build the plan', 'point 1', 'open', ?, 'x')",
    )
    .run(job);
  const read = await overseer('call/90', key);
  assert.equal(read.status, 200, read.text);
  assert.match(read.text, /\[900\] board: point 899 of the plan, said at length\n/, 'to its last line');
  assert.match(read.text, new RegExp(`- #\\d+ task, kit, open, job #${job}: Build the plan`));
  assert.match(read.text, new RegExp(`### Job #${job} \\(done\\)\\n\\nSet the plan up\\.`));
  h.db.prepare("update calls set status = 'live' where id = 90").run();
  assert.equal((await overseer('call/90', key)).status, 404, 'still going on');
  assert.equal((await overseer('call/91', key)).status, 404);
});

// A key the board saves after a report was written leaves that report as it's read, whole and in what changed
test('a key saved after a report was kept is masked in it, for the Overseer and for hq report', async () => {
  const { key } = (await h.board('/api/oversight')).body;
  const KEY = 'sk_live_' + 'R4'.repeat(20);
  rmSync(REPORTS, { recursive: true, force: true });
  report('2026-10-17T10:00:00Z', FIRST);
  report('2026-10-17T10:10:00Z', FIRST.replace('job 7\n', `job 7: the board said ${KEY}\n`));
  const bolt = await h.start({ agent: 'bolt' });
  assert.match((await h.hq(bolt, 'report')).out, new RegExp(KEY), 'not a key yet');

  const card = await h.ask(bolt, {
    kind: 'credential',
    title: 'Stripe',
    body: 'Paste the key.',
    secrets: 'STRIPE_LIVE_SECRET_KEY',
  });
  assert.equal((await h.answer(card, '', { secrets: { STRIPE_LIVE_SECRET_KEY: KEY } })).status, 200);
  const masked = 'job 7: the board said [STRIPE_LIVE_SECRET_KEY]';
  for (const read of [
    (await overseer('status', key)).text,
    (await overseer('status?since=2026-10-17T10:05:00Z', key)).text,
    (await h.hq(bolt, 'report')).out,
    (await h.hq(bolt, 'report', '--since', '2026-10-17T10:05:00Z')).out,
  ]) {
    assert.ok(read.includes(masked), read);
    assert.ok(!read.includes(KEY));
  }
});

// The save masks the report's file itself, so a key replaced later (redact() then knows only its new value) stays masked
test('a key saved after a report was kept stays masked in it once the key is replaced', async () => {
  const { key } = (await h.board('/api/oversight')).body;
  const FIRST_KEY = 'sk_live_' + 'S5'.repeat(20),
    NEW_KEY = 'sk_live_' + 'T6'.repeat(20);
  rmSync(REPORTS, { recursive: true, force: true });
  report('2026-10-17T10:00:00Z', FIRST);
  report('2026-10-17T10:10:00Z', FIRST.replace('job 7\n', `job 7: the board said ${FIRST_KEY}\n`));
  const file = `${REPORTS}/20261017T101000Z.md.gz`,
    written = Math.round(statSync(file).mtimeMs / 1000);
  const bolt = await h.start({ agent: 'bolt' });
  const cards = [
    await h.ask(bolt, {
      kind: 'credential',
      title: 'Stripe',
      body: 'Paste the key.',
      secrets: 'STRIPE_LIVE_SECRET_KEY',
    }),
    await h.ask(bolt, {
      kind: 'credential',
      title: 'Stripe',
      body: 'Paste the new key.',
      secrets: 'STRIPE_LIVE_SECRET_KEY',
    }),
  ];
  assert.equal((await h.answer(cards[0], '', { secrets: { STRIPE_LIVE_SECRET_KEY: FIRST_KEY } })).status, 200);
  assert.equal((await h.answer(cards[1], '', { secrets: { STRIPE_LIVE_SECRET_KEY: NEW_KEY } })).status, 200);
  assert.equal(redact(FIRST_KEY), FIRST_KEY, 'the store holds the new value alone');
  const masked = 'job 7: the board said [STRIPE_LIVE_SECRET_KEY]';
  for (const read of [
    (await overseer('status', key)).text,
    (await overseer('status?since=2026-10-17T10:05:00Z', key)).text,
    (await h.hq(bolt, 'report')).out,
    (await h.hq(bolt, 'report', '--since', '2026-10-17T10:05:00Z')).out,
  ]) {
    assert.ok(read.includes(masked), read);
    assert.ok(!read.includes(FIRST_KEY));
  }
  assert.equal(
    Math.round(statSync(file).mtimeMs / 1000),
    written,
    'the file keeps its time, which its two days count from',
  );
});

// A report published after a save's pass (its build read hq.db before the save) still holds the key: replacing the key
// masks the old value in it before redact() forgets it
test('a report published after the save keeps the old value masked once the key is replaced', async () => {
  const { key } = (await h.board('/api/oversight')).body;
  const FIRST_KEY = 'sk_live_' + 'U7'.repeat(20),
    NEW_KEY = 'sk_live_' + 'V8'.repeat(20);
  rmSync(REPORTS, { recursive: true, force: true });
  const bolt = await h.start({ agent: 'bolt' });
  const card = () =>
    h.ask(bolt, { kind: 'credential', title: 'Stripe', body: 'Paste the key.', secrets: 'STRIPE_LIVE_SECRET_KEY' });
  assert.equal((await h.answer(await card(), '', { secrets: { STRIPE_LIVE_SECRET_KEY: FIRST_KEY } })).status, 200);
  await h.hq(bolt, 'report'); // (the save's pass is over)
  report('2026-10-17T10:00:00Z', FIRST);
  report('2026-10-17T10:10:00Z', FIRST.replace('job 7\n', `job 7: the board said ${FIRST_KEY}\n`));
  assert.equal((await h.answer(await card(), '', { secrets: { STRIPE_LIVE_SECRET_KEY: NEW_KEY } })).status, 200);
  assert.equal(redact(FIRST_KEY), FIRST_KEY, 'the store holds the new value alone');
  const masked = 'job 7: the board said [STRIPE_LIVE_SECRET_KEY]';
  for (const read of [(await overseer('status', key)).text, (await h.hq(bolt, 'report')).out]) {
    assert.ok(read.includes(masked), read);
    assert.ok(!read.includes(FIRST_KEY));
  }
});
