// node --test src/slipnotice.test.ts   (throwaway DATA_DIR and the test company): a new time on our own deadline never
// reaches the desk phone, and a slip of a time the board set itself reaches it once (slipnotice.ts; the card reader,
// cardread.ts).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';

const h = await harness('slipnotice');
const { db } = h;
const MINUTE = 60_000;

const deskPhone = async () =>
  (await h.board('/api/requests')).body as { job: number; agent: string; kind: string; title: string; body: string }[];
// The CEO's follow-through check, running (a check job of HQ's)
const check = () => h.start({ agent: 'juno', title: 'Follow-through check', check: true });
const orgPath = `${h.repo}/company/org.yaml`;
// juno, the CEO, reads every card, its own check's among them
const ceoReadsCards = () => {
  const org = readFileSync(orgPath, 'utf8');
  writeFileSync(orgPath, org.replace(/^roles:\n/m, 'roles:\n  cards: juno\n'));
  return () => writeFileSync(orgPath, org);
};
const dir = mkdtempSync(`${tmpdir()}/slipnotice-`);

beforeEach(() => h.cancelQueued());

test("a new time on our own deadline reaches nobody: the reader settles the check's notice of it, --tell files none, and the check's ready news still files", async t => {
  t.after(ceoReadsCards());
  const ours = h.dueThread({ deadline: Date.now() + 10 * MINUTE, by: 'juno' });
  const job = await check();
  const notice = await h.agent('request', job.token, {
    kind: 'notice',
    urgency: 'today',
    title: 'The glass bars live about 06:35',
    body: 'They moved behind four review fixes.',
    topic: 'ink',
  });
  assert.equal(notice.status, 200, JSON.stringify(notice.body));
  const filed = notice.body.id as number;
  assert.equal(
    (await deskPhone()).some(c => c.job === job.id),
    false,
    'held for the reader',
  );
  const read = db
    .prepare("select id from jobs where agent = 'juno' and title like 'Read %' and prompt like ?")
    .get(`%card #${filed} %`) as { id: number };
  const answer = `${dir}/settle.md`;
  writeFileSync(answer, 'Our own time: the board reads it on the projects overview.');
  const settled = await h.hq(await h.claimJob(read.id), 'card', 'settle', String(filed), answer);
  assert.equal(settled.code, 0, settled.out);

  const told = await h.agent('window', job.token, {
    thread: ours,
    deadline: '2h',
    tell: 'Four review fixes go first.',
  });
  assert.equal(told.status, 200, JSON.stringify(told.body));
  assert.equal(told.body.tell.told, false);
  assert.ok(Date.parse(told.body.deadline) > Date.now() + 100 * MINUTE, 'the window moved all the same');
  assert.deepEqual(
    (await deskPhone()).filter(c => c.job === job.id),
    [],
    'nothing on the desk phone',
  );

  // what the board asked to hear the moment it's ready still files, and reaches it once the reader passes it
  const ready = await h.agent('request', job.token, {
    kind: 'notice',
    urgency: 'now',
    title: 'The glass bars are live',
    body: 'Open Ink to see them.',
    topic: 'ink',
  });
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  const readsReady = db
    .prepare("select id from jobs where agent = 'juno' and title like 'Read %' and prompt like ?")
    .get(`%card #${ready.body.id} %`) as { id: number };
  const passed = await h.hq(await h.claimJob(readsReady.id), 'card', 'pass', String(ready.body.id));
  assert.equal(passed.code, 0, passed.out);
  assert.deepEqual(
    (await deskPhone()).filter(c => c.job === job.id).map(c => c.title),
    ['The glass bars are live'],
  );
});

test("a slip of the board's own time reaches the desk phone once, past the card reader, and the new time is ours", async t => {
  t.after(ceoReadsCards());
  const boards = h.dueThread({ deadline: Date.now() + 10 * MINUTE, by: 'board' });
  const job = await check();
  for (const [body, why] of [
    [{ tell: ' ' }, 'says why'],
    [{ tell: 'x', board_set: true }, 'the new time is ours'],
    [{ tell: 'x', deadline: 'none' }, 'names a time'],
  ] as const)
    assert.equal((await h.agent('window', job.token, { thread: boards, deadline: '2h', ...body })).status, 400, why);
  const tried = await h.agent('window', job.token, { thread: boards, deadline: '2h', tell: 'x', try: true });
  assert.equal(tried.body.tell, undefined, 'a trial tells nobody');

  const why = 'Four review fixes go first. The bars start once they merge.';
  const told = await h.agent('window', job.token, { thread: boards, deadline: '2h', tell: why });
  assert.equal(told.status, 200, JSON.stringify(told.body));
  assert.equal(told.body.tell.told, true);
  const [card, ...more] = (await deskPhone()).filter(c => c.job === job.id);
  assert.deepEqual(more, [], 'one card');
  assert.deepEqual([card.kind, card.agent, card.body], ['notice', 'juno', why], "the check's notice, in its words");

  // it slips again: the board hears nothing more
  const again = await h.agent('window', job.token, { thread: boards, deadline: '3h', tell: 'The tests ran long.' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.tell.told, false);
  assert.equal((await deskPhone()).filter(c => c.job === job.id).length, 1, 'still the one card');
});

test("a --tell with nothing slipping, or words the desk phone wouldn't show, is refused and keeps the board's time", async () => {
  const boards = h.dueThread({ deadline: Date.now() + 3 * 60 * MINUTE, by: 'board' });
  const job = await h.start({ agent: 'kit', title: 'The shop page' });
  const tell = (deadline: string, words: string) =>
    h.agent('window', job.token, { thread: boards, deadline, tell: words });
  const sooner = await tell('1h', 'It went fast.');
  assert.equal(sooner.status, 400, JSON.stringify(sooner.body));
  const unshowable = await tell('5h', 'Recommend: wait for the fixes.');
  assert.equal(unshowable.status, 400, JSON.stringify(unshowable.body));
  assert.deepEqual(
    (await deskPhone()).filter(c => c.job === job.id),
    [],
    'nothing filed',
  );

  const told = await tell('5h', 'The fixes go first.');
  assert.equal(told.body.tell.told, true, "the board's time held, so this slip is still told");
  assert.deepEqual(
    (await deskPhone()).filter(c => c.job === job.id).map(c => c.agent),
    ['kit'],
  );
});
