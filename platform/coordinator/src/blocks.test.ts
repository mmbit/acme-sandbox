// node --test src/blocks.test.ts   (the test company): a run the worker blocked for its job's share, the words its output
// gets (where to run it instead) and the job's last block; a jam the shares can't free, to the Overseer, then the board
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('blocks');
const { reportRoom } = await import('./room.ts');
const machines = await import('./machines.ts');
const overseer = await import('./overseer.ts');
const { ESCALATE_MS, CARD_MS } = await import('./jam.ts');
const M = 60_000;
const stopping = (id: number) =>
  (h.db.prepare('select stopping from jobs where id = ?').get(id) as { stopping: string | null }).stopping;

const blocked = (job: number, body: Record<string, unknown> = {}) =>
  h.worker('blocked', {
    job,
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

  const { id } = machines.addMachine('Skynet') as { id: number };
  machines.heard(id, 'default', { cpus: 24, memoryGb: 40 }, true);
  const lent = await blocked(job.id, { measure: 'cores', used: 7.4, share: 4 });
  assert.match(
    lent.body.text,
    /this job kept 7\.4 cores busy for long on the HQ server's worker, past a job's share of 4 cores/,
  );
  assert.match(lent.body.text, /Offload it, even if it takes longer there: hq run --kind <kind> -- <command>/);
  assert.match(lent.body.text, /Skynet \(24 cores, 40 GB\) takes default/, 'the machine by its name and size, from HQ');
  assert.match(lent.body.text, /block 2 of 3/);
  assert.equal(stopping(job.id), null);

  h.db.prepare("update machine_kinds set seen = '2026-01-01T00:00:00Z', asked = null where machine = ?").run(id);
  const away = await blocked(job.id, { measure: 'processes', used: 512, share: 400 });
  assert.match(away.body.text, /used 512 processes/);
  assert.doesNotMatch(away.body.text, /Offload it/, 'the last block says what happens, not where to go');
  assert.match(away.body.text, /That was this job's block 3: HQ is stopping the job/);
  assert.match(stopping(job.id) ?? '', /blocked 3 times for running past its share of the worker/);
  assert.equal((h.db.prepare('select count(*) n from blocks where job = ?').get(job.id) as { n: number }).n, 3);
  machines.removeMachine(id);

  assert.equal((await blocked(999_999)).status, 400, 'no such job');
  assert.equal((await blocked(job.id, { measure: 'disk' })).status, 400);
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

test('a lent machine that is away: hq run waits for it, and the agent goes on without the result', async () => {
  const job = await h.start({ agent: 'bolt' });
  const { id } = machines.addMachine('Skynet') as { id: number };
  machines.heard(id, 'default', { cpus: 24, memoryGb: 40 }, true);
  h.db.prepare("update machine_kinds set seen = '2026-01-01T00:00:00Z', asked = null where machine = ?").run(id);
  const { text } = (await blocked(job.id)).body;
  assert.match(
    text,
    /Offload it with hq run --kind <kind> -- <command>, even if it takes longer: Skynet isn't taking work now, and hq run waits for it\./,
  );
  assert.match(text, /if nothing can, say so in your report/);
  machines.removeMachine(id);
});

test("a jam the shares can't free goes to the Overseer at once, then to the board as a card whose Approve stops the jobs", async context => {
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
  const notes = () =>
    h.db.prepare('select job, text, released from overseer_notes where job = 0').all() as {
      job: number;
      text: string;
      released: number | null;
    }[];
  const cards = () => h.db.prepare("select * from requests where kind = 'jam'").all() as any[];

  short(T0 + ESCALATE_MS - M);
  assert.equal(notes().length, 0, 'starved, but the worker blocks the heaviest run first');
  short(T0 + ESCALATE_MS);
  const [note] = notes();
  assert.ok(note.released, 'let out at once, behind no run');
  assert.match(note.text, /^HQ's own alarm: the worker has been short of memory for 10 min \(400 MB free\)/);
  assert.match(note.text, new RegExp(`- job #${hog.id} \\(bolt, work\\): 3\\.0 GB`));
  assert.match(overseer.releasedSince(), /\(from HQ\)\n\nHQ's own alarm/, "the Overseer's read shows it as HQ's");
  short(T0 + ESCALATE_MS + 5 * M);
  assert.equal(notes().length, 1, 'one note a spell');
  assert.equal(cards().length, 0, 'the Overseer has its time first');

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
