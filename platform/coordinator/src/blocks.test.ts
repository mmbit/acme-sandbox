// node --test src/blocks.test.ts   (the test company): a run the worker blocked for its job's share, the words its output
// gets (where to run it instead) and the job's last block; a jam the shares can't free, to the Overseer, then the board
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { commandOf } from '../../worker/src/stoprun.ts';
import { procStat } from '../../worker/src/detached.ts';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('blocks');
const { reportRoom } = await import('./room.ts');
const machines = await import('./machines.ts');
const { ESCALATE_MS, CARD_MS } = await import('./jam.ts');
const M = 60_000;
const stopping = (id: number) =>
  (h.db.prepare('select stopping from jobs where id = ?').get(id) as { stopping: string | null }).stopping;

const blocked = (job: number, body: Record<string, unknown> = {}) =>
  h.worker('blocked', {
    job,
    event: randomUUID(),
    measure: 'memory',
    used: 3100,
    share: 2560,
    command: 'node platform/hq/room-preview.mjs --rooms lab',
    ...body,
  });

test("a blocked run hears where to run it instead, from HQ's machines as they are, and the third block stops its job", async () => {
  const job = await h.start({ agent: 'bolt' });
  const none = await blocked(job.id);
  assert.equal(none.status, 200);
  assert.match(
    none.body.text,
    /^HQ's worker stopped this command \(node platform\/hq\/room-preview\.mjs --rooms lab\): this job used 3,100 MB on the HQ server's worker, past a job's share of 2,560 MB\./,
  );
  assert.match(none.body.text, /This deployment has no offload machine\..*if it can't be split, don't run it/s);
  assert.match(none.body.text, /This is this job's block 1 of 3/);

  const { id } = machines.addMachine('Cloudberry') as { id: number };
  machines.heard(id, 'default', { cpus: 24, memoryGb: 40 }, true);
  const lent = await blocked(job.id, { measure: 'cores', used: 7.4, share: 4 });
  assert.match(
    lent.body.text,
    /this job kept 7\.4 cores busy for long on the HQ server's worker, past a job's share of 4 cores/,
  );
  assert.match(lent.body.text, /Offload it, even if it takes longer there: hq run --kind <kind> -- <command>/);
  assert.match(
    lent.body.text,
    /Cloudberry \(24 cores, 40 GB\) takes default/,
    'the machine by its name and size, from HQ',
  );
  assert.match(lent.body.text, /block 2 of 3/);
  assert.equal(stopping(job.id), null);

  const away = await blocked(job.id, { measure: 'processes', used: 512, share: 400 });
  assert.match(away.body.text, /used 512 processes/);
  assert.doesNotMatch(away.body.text, /Offload it/, 'the last block says what happens, not where to go');
  assert.match(away.body.text, /That was this job's block 3: HQ is stopping the job/);
  assert.match(stopping(job.id) ?? '', /blocked 3 times for running past its share of the worker/);
  assert.equal((h.db.prepare('select count(*) n from blocks where job = ?').get(job.id) as { n: number }).n, 3);
  machines.removeMachine(id);

  assert.equal((await blocked(999_999)).status, 400, 'no such job');
  assert.equal((await blocked(job.id, { measure: 'unknown' })).status, 400);
});

test("a review blocked a third time goes back to the queue, to go on in its session, and a job that ended isn't said stopped", async () => {
  const review = await h.start({ agent: 'rook', kind: 'review', pr: 9 });
  for (const n of [1, 2]) assert.match((await blocked(review.id)).body.text, new RegExp(`block ${n} of 3`));
  const last = (await blocked(review.id)).body.text;
  assert.match(last, /That was this job's block 3: HQ puts it back in the queue at its next step/);
  assert.doesNotMatch(last, /HQ is stopping the job/);
  assert.equal((await h.heartbeat(review)).body.yield, 'waiting', 'the worker yields it at its next step');
  await h.finish(review, { status: 'yielded', session: 'its-session' });
  assert.equal(h.job(review.id).status, 'queued', 'what it wrote so far is no verdict');
  const again = await h.claim(h.job(review.id).engine);
  assert.equal(again?.session, 'its-session');
  assert.equal((await h.heartbeat(again!)).body.yield, undefined, 'its next run goes on');

  const ended = await h.start({ agent: 'bolt' });
  await blocked(ended.id);
  await blocked(ended.id);
  await h.finish(ended);
  assert.match(
    (await blocked(ended.id)).body.text,
    new RegExp(`That was this job's block 3, but HQ can't stop the job: #${ended.id} isn't running \\(done\\)\\.$`),
  );
});

test('a lent machine that is away: hq run waits for it, and the agent goes on without the result', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const job = await h.start({ agent: 'bolt' });
  const { id } = machines.addMachine('Cloudberry') as { id: number };
  machines.heard(id, 'default', { cpus: 24, memoryGb: 40 }, true);
  context.mock.timers.tick(2 * M);
  const { text } = (await blocked(job.id)).body;
  assert.match(
    text,
    /Offload it with hq run --kind <kind> -- <command>, even if it takes longer: Cloudberry isn't taking work now, and hq run waits for it\./,
  );
  assert.match(text, /if nothing can, say so in your report/);
  machines.removeMachine(id);
});

test("a jam the shares can't free goes to the CEO at once, then, while their job hasn't started, to the board as a card whose Approve stops the jobs", async context => {
  const T0 = Date.now();
  context.mock.method(Date, 'now', () => T0);
  const hog = await h.start({ agent: 'bolt' });
  const small = await h.start({ agent: 'bolt' });
  const waiting = h.queue({ agent: 'bolt' });
  const short = (at: number, since = T0) =>
    reportRoom(
      {
        short: true,
        since,
        free: 400,
        jobs: [
          { job: small.id, mb: 300, cores: 0.2 },
          { job: hog.id, mb: 3100, cores: 3 },
        ],
        claims: [{ seat: 'seat', engine: h.job(waiting).engine }],
      },
      at,
    );
  const incidents = () =>
    h.db.prepare("select agent, prompt, expedite from jobs where incident = 1 and status = 'queued'").all() as {
      agent: string;
      prompt: string;
      expedite: number;
    }[];
  const cards = () => h.db.prepare("select * from requests where kind = 'jam'").all() as any[];

  short(T0 + ESCALATE_MS - M);
  assert.equal(incidents().length, 0, 'starved, but the worker blocks the heaviest run first');
  short(T0 + ESCALATE_MS);
  const [incident] = incidents();
  assert.deepEqual([incident.agent, incident.expedite], ['juno', 1], "the CEO's, first in line");
  assert.match(incident.prompt, /^HQ's own alarm: the worker has been short of memory for 10 min \(400 MB free\)/);
  assert.match(incident.prompt, new RegExp(`- job #${hog.id} \\(bolt, work\\): 3\\.0 GB`));
  short(T0 + ESCALATE_MS + 5 * M);
  assert.equal(incidents().length, 1, 'one incident a spell');
  assert.equal(cards().length, 0, 'the CEO has their time first');

  short(T0 + ESCALATE_MS + CARD_MS);
  const [card] = cards();
  assert.equal(card.urgency, 'now');
  assert.equal(card.title, 'Stop the jobs jamming the worker?');
  assert.match(card.body, /^No new work has started for 25 min/);
  assert.match(card.body, /Recommended: Approve\.$/);
  const shown = ((await h.board('/api/requests')).body as any[]).find(r => r.id === card.id);
  assert.match(
    shown.grants,
    /^Approving stops Bolt's ".*" and Bolt's ".*" now\. Their work so far stays on their branches\.$/,
  );
  short(T0 + ESCALATE_MS + CARD_MS + 5 * M);
  assert.equal(cards().length, 1, 'one card a spell');

  assert.equal((await h.answer(card.id, '', { approve: true })).status, 200);
  assert.match(stopping(hog.id) ?? '', /the board's card #\d+: the worker was out of memory/);
  assert.match(stopping(small.id) ?? '', /the board's card/);
  assert.equal(stopping(waiting), null);
  const { answer } = h.db.prepare('select answer from requests where id = ?').get(card.id) as { answer: string };
  assert.match(answer, /^Approved\. Bolt's ".*" is stopping\. Bolt's ".*" is stopping\./);
});

test('a jam whose incident the CEO took up brings the board no card', async context => {
  const T0 = Date.now() + 100 * M;
  context.mock.method(Date, 'now', () => T0);
  const hog = await h.start({ agent: 'bolt' });
  const waiting = h.queue({ agent: 'bolt' });
  const short = (at: number) =>
    reportRoom(
      {
        short: true,
        since: T0,
        free: 400,
        jobs: [{ job: hog.id, mb: 3100, cores: 3 }],
        claims: [{ seat: 'seat', engine: h.job(waiting).engine }],
      },
      at,
    );
  const cards = () => (h.db.prepare("select count(*) n from requests where kind = 'jam'").get() as { n: number }).n;
  const before = cards();
  short(T0 + ESCALATE_MS);
  const { id } = h.db
    .prepare("select id from jobs where incident = 1 and status = 'queued' order by id desc limit 1")
    .get() as { id: number };
  await h.claimJob(id);
  short(T0 + ESCALATE_MS + CARD_MS);
  assert.equal(cards(), before, 'the CEO is on it');
});

test("the jam card's Approve puts a review back in the queue, and says of a job that ended it wasn't stopped", async context => {
  const T0 = Date.now() + 200 * M;
  context.mock.method(Date, 'now', () => T0);
  const review = await h.start({ agent: 'rook', kind: 'review', pr: 9 });
  const ended = await h.start({ agent: 'bolt' });
  const waiting = h.queue({ agent: 'bolt' });
  const short = (at: number) =>
    reportRoom(
      {
        short: true,
        since: T0,
        free: 400,
        jobs: [
          { job: review.id, mb: 3100, cores: 1 },
          { job: ended.id, mb: 2000, cores: 1 },
        ],
        claims: [{ seat: 'seat', engine: h.job(waiting).engine }],
      },
      at,
    );
  short(T0 + ESCALATE_MS);
  short(T0 + ESCALATE_MS + CARD_MS);
  const card = h.db.prepare("select id from requests where kind = 'jam' order by id desc limit 1").get() as {
    id: number;
  };
  await h.finish(ended);
  assert.equal((await h.answer(card.id, '', { approve: true })).status, 200);
  const { answer } = h.db.prepare('select answer from requests where id = ?').get(card.id) as { answer: string };
  assert.match(answer, /Rook's ".*" goes back to the queue at its next step \(a review can't end early\)/);
  assert.match(answer, new RegExp(`Bolt's ".*" wasn't stopped: #${ended.id} isn't running \\(done\\)`));
  assert.equal((await h.heartbeat(review)).body.yield, 'waiting', 'the review yields at its next step');
  assert.equal(stopping(review.id), null, 'never ended early');
});

test('when the worker has room again, an open card leaves the desk phone; a new spell starts over', async context => {
  const T0 = Date.now() + 100 * M;
  context.mock.method(Date, 'now', () => T0);
  const hog = await h.start({ agent: 'bolt' });
  const waiting = h.queue({ agent: 'bolt' });
  const short = (at: number, since: number) =>
    reportRoom(
      {
        short: true,
        since,
        free: 400,
        jobs: [{ job: hog.id, mb: 3000, cores: 1 }],
        claims: [{ seat: 'seat', engine: h.job(waiting).engine }],
      },
      at,
    );
  const before = (h.db.prepare("select count(*) n from requests where kind = 'jam'").get() as { n: number }).n;
  short(T0 + ESCALATE_MS, T0);
  short(T0 + ESCALATE_MS + CARD_MS, T0);
  const card = h.db.prepare("select * from requests where kind = 'jam' order by id desc limit 1").get() as any;
  assert.equal(card.status, 'open');
  reportRoom({ short: false, free: 3000, jobs: [], claims: [] }, T0 + ESCALATE_MS + CARD_MS + M);
  const ended = h.db.prepare('select status, closing from requests where id = ?').get(card.id) as any;
  assert.deepEqual({ ...ended }, { status: 'done', closing: 'The worker has room again: nothing to stop.' });
  assert.equal(stopping(hog.id), null, 'nothing stopped');
  short(T0 + 2 * ESCALATE_MS + CARD_MS, T0 + ESCALATE_MS + CARD_MS);
  assert.equal(
    (h.db.prepare("select count(*) n from requests where kind = 'jam'").get() as { n: number }).n,
    before + 1,
    'a new spell is told the Overseer first',
  );
});

test('repeated delivery keeps the first report and counts each event once, including the third strike', async () => {
  const job = await h.start({ agent: 'bolt' });
  const event = randomUUID();
  const first = await blocked(job.id, { event });
  const { id } = machines.addMachine('Thimble') as { id: number };
  machines.heard(id, 'default', { cpus: 12, memoryGb: 20 }, true);
  assert.deepEqual(
    await blocked(job.id, { event }),
    first,
    'a lost reply is safe to resend even after availability changes',
  );
  assert.equal((await blocked(job.id)).body.count, 2, 'a distinct event adds a strike');
  assert.equal((await blocked(job.id, { event, used: 3200 })).status, 409, 'an identity cannot describe another event');
  const thirdEvent = randomUUID();
  const third = await blocked(job.id, { event: thirdEvent });
  assert.equal(third.body.count, 3);
  assert.match(stopping(job.id) ?? '', /blocked 3 times/);
  await h.finish(job);
  assert.deepEqual(
    await blocked(job.id, { event: thirdEvent }),
    third,
    'replaying a committed stop never stops it again',
  );
  assert.equal((h.db.prepare('select count(*) n from blocks where job = ?').get(job.id) as { n: number }).n, 3);
  assert.equal((await blocked(job.id, { event: undefined })).status, 400, 'delivery needs an event identity');
  machines.removeMachine(id);
});

test('command values are redacted before shortening and reach only the stopped command output', async () => {
  const secrets = await import('./secrets.ts');
  secrets.registerKeys({ BLOCK_TEST_VALUE: /^.+$/ });
  const value = 'private-fixture-' + 'v'.repeat(400);
  secrets.saveSecrets(['BLOCK_TEST_VALUE'], { BLOCK_TEST_VALUE: value });
  const job = await h.start({ agent: 'bolt' });
  const command = 'fixture-command ' + value;
  const { body, status } = await blocked(job.id, { command });
  assert.equal(status, 200);
  assert.match(body.text, /fixture-command \[BLOCK_TEST_VALUE\]/);
  assert.ok(!body.text.includes('private-fixture-'));
  const rows = h.db.prepare('select * from blocks where job = ?').all(job.id);
  assert.ok(!JSON.stringify(rows).includes('fixture-command'), 'no command retained in any block column');
  assert.ok(!JSON.stringify(await h.feed()).includes('fixture-command'), 'no command on the public feed');
});

test('a valid long command records one strike across repeated endpoint delivery', async context => {
  const args = Array(16).fill('\u0001'.repeat(100_000));
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()', '--', ...args], {
    env: {},
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  context.after(async () => {
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  });
  await once(child, 'spawn');
  const pid = child.pid!;
  const command = commandOf([{ ...procStat(pid)!, pid, uid: process.getuid!(), memoryMb: 0, memoryMeasure: 'rss' }]);
  assert.ok(command.includes(args.join(' ')), 'the running command reaches reporting in full');
  assert.ok(
    Buffer.byteLength(JSON.stringify({ command })) > 3_000_000,
    'JSON escaping exceeds the ordinary body budget',
  );
  const job = await h.start({ agent: 'bolt' });
  const event = randomUUID();
  const first = await blocked(job.id, { event, command });
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 1);
  assert.deepEqual(await blocked(job.id, { event, command }), first);
  assert.equal((h.db.prepare('select count(*) n from blocks where job = ?').get(job.id) as { n: number }).n, 1);
  assert.equal(stopping(job.id), null);
  assert.equal((await h.worker('room', { command })).status, 400, 'other worker endpoints keep their body budget');
});

test('disk warnings keep the grace free of strikes and zero-room stops keep command-free idempotent receipts', async () => {
  const job = await h.start({ agent: 'bolt' });
  const warning = await blocked(job.id, { measure: 'disk', used: 2 ** 30, share: 0, warning: true });
  assert.equal(warning.status, 200);
  assert.match(warning.body.text, /Continued writing/);
  assert.match(warning.body.text, /Cleanup commands may run/);
  await blocked(job.id, { measure: 'disk', used: 2 ** 30, share: 0, warning: true });
  assert.equal((h.db.prepare('select count(*) n from blocks where job = ?').get(job.id) as { n: number }).n, 0);
  const event = randomUUID();
  const body = { event, measure: 'disk', used: 2 ** 30, share: 0, command: 'fixture-disk-writer' };
  const first = await blocked(job.id, body);
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 1);
  assert.match(first.body.text, /1.00 GiB of disk/);
  assert.match(first.body.text, /Clear disposable caches/);
  assert.deepEqual(await blocked(job.id, body), first);
  const rows = h.db.prepare('select * from blocks where job = ?').all(job.id);
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes('fixture-disk-writer'));
});

test('an unavailable disk counter stop reports the accounting error and preserves its receipt', async () => {
  const job = await h.start({ agent: 'bolt' });
  const event = randomUUID();
  const secrets = await import('./secrets.ts');
  secrets.registerKeys({ ACCOUNTING_TEST_VALUE: /^.+$/ });
  assert.deepEqual(
    secrets.saveSecrets(['ACCOUNTING_TEST_VALUE'], { ACCOUNTING_TEST_VALUE: 'private-accounting-fixture' }),
    { saved: ['ACCOUNTING_TEST_VALUE'], refused: {} },
  );
  const cause = 'Cannot read write counters: private-accounting-fixture';
  const body = {
    event,
    measure: 'disk',
    used: 65536,
    share: 0,
    accountingError: { reason: 'process-counters', message: cause },
  };
  const first = await blocked(job.id, body);
  assert.equal(first.status, 200);
  assert.match(first.body.text, /Disk accounting is unavailable/);
  assert.match(first.body.text, /Restore readable process counters/);
  assert.match(
    first.body.text,
    /Accounting cause \(process-counters\): Cannot read write counters: \[ACCOUNTING_TEST_VALUE\]/,
  );
  assert.ok(!first.body.text.includes('private-accounting-fixture'));
  const stored = JSON.stringify(h.db.prepare('select * from blocks where job = ?').all(job.id));
  assert.ok(!stored.includes('Cannot read write counters'));
  assert.ok(!JSON.stringify(await h.feed()).includes('Cannot read write counters'));
  assert.deepEqual((await blocked(job.id, body)).body, first.body);
  assert.equal(first.body.count, 1);
  assert.equal((await blocked(job.id, { ...body, accountingError: undefined })).status, 409);
  assert.equal((await blocked(job.id, { ...body, accountingError: { reason: 'worker-ancestor' } })).status, 409);
});

test('unknown disk usage remains explicit and an accounting-error receipt is idempotent', async () => {
  const job = await h.start({ agent: 'bolt' });
  const body = {
    event: randomUUID(),
    measure: 'disk',
    used: null,
    share: 4096,
    accountingError: { reason: 'process-counters' },
  };
  const first = await blocked(job.id, body);
  assert.equal(first.status, 200);
  assert.match(first.body.text, /Disk accounting is unavailable/);
  assert.doesNotMatch(first.body.text, /this job used/);
  const again = await blocked(job.id, body);
  assert.deepEqual(again.body, first.body);
  const receipts = h.db.prepare('select used from blocks where job = ?').all(job.id) as { used: number | null }[];
  assert.deepEqual(
    receipts.map(receipt => receipt.used),
    [null],
  );
  for (const invalid of [{ measure: 'memory' }, { accountingError: false }, { warning: true }])
    assert.equal((await blocked(job.id, { ...body, ...invalid, event: randomUUID() })).status, 400);
});

test('worker infrastructure failures add no strikes while three measured overuses still stop the job', async () => {
  const job = await h.start({ agent: 'bolt' });
  const other = await h.start({ agent: 'rook' });
  for (const used of [null, 65536, null, 65536]) {
    const body = {
      event: randomUUID(),
      measure: 'disk',
      used,
      share: 0,
      accountingError: { reason: 'worker-ancestor' },
    };
    const first = await blocked(job.id, body);
    assert.equal(first.status, 200);
    assert.equal(first.body.count, 0);
    assert.doesNotMatch(first.body.text, /block \d+ of|past a job's share|HQ is stopping/);
    assert.deepEqual((await blocked(job.id, body)).body, first.body);
    assert.equal(stopping(job.id), null);
  }
  for (const [index, measure] of ['disk', 'memory', 'processes'].entries()) {
    const reply = await blocked(job.id, { measure, used: 65536, share: 1 });
    assert.equal(reply.body.count, index + 1);
    if (index < 2) {
      const failure = await blocked(job.id, {
        measure: 'disk',
        used: null,
        share: 1,
        accountingError: { reason: 'worker-ancestor' },
      });
      assert.equal(failure.body.count, index + 1);
      assert.equal(stopping(job.id), null);
    }
  }
  assert.match(stopping(job.id)!, /blocked 3 times/);
  assert.equal(stopping(other.id), null);
  assert.equal((await blocked(other.id, { measure: 'disk', used: 65536, share: 1 })).body.count, 1);
  assert.equal((await blocked(other.id, { accountingError: { reason: 'worker-ancestor' } })).status, 400);
});

for (const reason of ['process-counters', 'job-tree', 'write-sampling'])
  test(`three ${reason} failures stop the job while worker infrastructure failures remain strike-free`, async () => {
    const job = await h.start({ agent: 'bolt' });
    const other = await h.start({ agent: 'rook' });
    for (const count of [1, 2, 3]) {
      for (const infrastructure of ['worker-ancestor', 'worker-scanner']) {
        const reply = await blocked(job.id, {
          measure: 'disk',
          used: null,
          share: 1,
          accountingError: { reason: infrastructure },
        });
        assert.equal(reply.status, 200);
        assert.equal(reply.body.count, count - 1);
        assert.equal(stopping(job.id), null);
      }
      const body = {
        event: randomUUID(),
        measure: 'disk',
        used: reason === 'process-counters' ? 65536 : null,
        share: 1,
        accountingError: { reason },
      };
      const reply = await blocked(job.id, body);
      assert.equal(reply.status, 200);
      assert.equal(reply.body.count, count);
      assert.deepEqual((await blocked(job.id, body)).body, reply.body, 'a retry adds no strike');
      if (count < 3) assert.equal(stopping(job.id), null);
      else {
        assert.match(stopping(job.id)!, /blocked 3 times/);
        assert.match(reply.body.text, /HQ is stopping the job/);
      }
      assert.equal(stopping(other.id), null);
    }
    assert.equal((await blocked(other.id, { accountingError: { reason: 'unknown' } })).status, 400);
    assert.equal((await blocked(other.id, { measure: 'disk', accountingError: true })).status, 400);
  });
