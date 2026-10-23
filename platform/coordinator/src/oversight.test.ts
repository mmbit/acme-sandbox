// node --test src/oversight.test.ts   (throwaway DATA_DIR and the test company): the Overseer's read-only route, the
// status report whole or what changed, the CEO's notes, and the key the board gives it from Settings › Overseer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { harness } from './harness.ts';

const h = await harness('oversight');
const { redact } = await import('./secrets.ts');
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
  assert.equal(newest.out, `(the report of 2026-10-17T10:10:00Z)\n${SECOND}`);
  assert.equal(
    (await h.hq(job, 'report', '--at', '2026-10-17T10:05Z')).out,
    `(the report of 2026-10-17T10:00:00Z)\n${FIRST}`,
    'the newest at or before --at',
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
