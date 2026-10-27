// node --test src/downtime.test.ts   (job #1355: downtime work runs on spare capacity only; throwaway DATA_DIR and REPO_DIR)
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { completeTriage } from './reviewfixture.ts';
import { harness, type Running } from './harness.ts';

// The test company, with a schedule.yaml that has a downtime entry.
const h = await harness('downtime', { before: repo => writeFileSync(`${repo}/company/schedule.yaml`, `
- id: sweep
  agent: bolt
  at: "00:00"
  title: Log scan
  prompt: Scan the logs.
  downtime: true
- id: round
  agent: juno
  at: "00:00"
  title: Round
  prompt: Go round.
`) });
const { db, jobs } = h;
const schedule = await import('./schedule.ts');
const { retryAt, checkDue, sleepUntil } = await import('../../worker/src/downtime.ts');
const ledger = await import('./ledger.ts');

const H = 3600e3;
const reset = () => db.exec("delete from review_triage; delete from calls; delete from call_items; delete from jobs; delete from prs; delete from seats where id in ('ready-claude', 'codex-1')");
const queue = (
  title: string,
  o: { downtime?: boolean; after?: number; engine?: string; thread?: string; item?: number; queuedBy?: string } = {},
) =>
  h.queue({ agent: 'bolt', title, engine: 'claude', ...o });
// A seat ready on each engine (Codex's the one codex() claims on, which its jobs are for), so work waiting there waits
// for room, not for a seat (jobs.ts makesRoom).
const seatsReady = async () => {
  for (const [seat, engine] of [['ready-claude', 'claude'], ['codex-1', 'codex']])
    assert.equal((await h.worker('seat', { seat, engine, state: 'ready', util: 0 })).status, 200);
};
// a Claude seat's claim, with the share of its 5-hour window used (none sent: unmeasured)
const claim = (util?: number, extra: Record<string, unknown> = {}) => h.claim('claude', { ...util === undefined ? {} : { util }, ...extra });
// a claim on a named seat (a Codex job stays with the first seat that claimed it)
const on = async (seat: string, engine: string, body: Record<string, unknown> = {}) => {
  const r = (await h.worker('claim', { seat, engine, ...body })).body;
  return r && { ...r, seat } as Running;
};
const codex = (util?: number, extra: Record<string, unknown> = {}) => on('codex-1', 'codex', { ...util === undefined ? {} : { util }, ...extra });
const beat = async (job: Running, o: Record<string, unknown>) => (await h.heartbeat(job, o)).body;
// a job's hold (until when it waits), as the projects view shows it: none when it may start now
const until = (id: number) => h.job(id).until ?? 0;
// An item of a board call, as its follow-up records it (a decision is handled when its work ends; a task waits for the
// board's yes)
const item = (call: number, kind = 'task') => {
  const i = ledger.add(call, { kind, owner: 'bolt', what: 'Paint the gate', goal: 'A gate that looks cared for', quote: 'Board: paint the gate.' }, null);
  assert.ok(typeof i === 'object');
  return i.id;
};
// downtime work of bolt's that ended with its pull request: the review round it gets, as HQ lists it
async function reviewed(pr: number, o: { downtime?: boolean } = { downtime: true }) {
  const job = await h.start({ agent: 'bolt', title: 'Refactoring pass', ...o }, { util: 0.1 });
  assert.equal((await h.finish(job, { pr, branch: `job/${job.id}`, sha: String(pr % 10).repeat(40), files: ['platform/coordinator/src/jobs.ts'] })).status, 200);
  await completeTriage(h, pr);
  const round = (jobs.listJobs() as any[]).filter(j => ['review', 'consolidate'].includes(j.kind) && j.pr === pr);
  assert.ok(round.some(j => j.kind === 'review'));
  return round;
}

test('normal work goes first, even queued later; downtime only when nothing else on the engine can start', async () => {
  reset();
  const maint = queue('Refactoring pass', { downtime: true });
  const normal = queue('Sprint work');
  assert.equal((await claim(0.1))?.id, normal);
  assert.equal((await claim(0.1))?.id, maint);
  assert.equal(await claim(0.1), null);
});

test('downtime needs headroom: under 60% of the 5-hour window, and never on an unknown window', async () => {
  reset();
  const maint = queue('Log scan', { downtime: true });
  assert.equal(await claim(0.6), null);
  assert.equal(await claim(), null, 'a worker that sends no window starts no downtime work');
  assert.equal((await claim(0.59))?.id, maint);
  // normal work doesn't care
  const normal = queue('Sprint work');
  assert.equal((await claim(0.85))?.id, normal);
});

test("a seat ahead of its week's pace takes, until its weekly reset, the board's word and work that must start before it", async () => {
  reset();
  const reset2 = Date.now() + 2 * 24 * H;
  const undated = queue('Tidy the docs'), spare = queue('Log scan', { downtime: true });
  const later = queue('For next week', { thread: h.dueThread({ deadline: reset2 + 3 * 24 * H }) });
  const due = queue('For the board by tonight', { thread: h.dueThread({ deadline: Date.now() + H }) });
  const board = queue('What the board asked on a call');
  h.storedCall(1, 'bolt', board);
  // (work handed an open item from the call is the board's word too; dropping the item cancels its work)
  const gate = item(1), fence = item(1);
  const carries = queue('The gate, as the board asked', { item: gate, queuedBy: 'bolt' });
  const dropped = queue('The fence, dropped since', { item: fence, queuedBy: 'bolt' });
  assert.deepEqual((ledger.drop(fence, 'The board took it back', board) as { cancelled: number[] }).cancelled, [dropped]);
  const paced = async () => (await claim(0.2, { pacedUntil: reset2 }))?.id;
  assert.deepEqual([await paced(), await paced(), await paced(), await paced()], [board, carries, due, undefined], 'the rest waits for the reset');
  assert.equal(h.job(later).status, 'queued');
  const unpaced = async () => (await claim(0.2))?.id;
  assert.deepEqual([await unpaced(), await unpaced(), await unpaced()], [later, undated, spare], 'not paced: all');
});

test("a board item's pull request keeps the board's word on a paced seat until it merges: its fixes and its reviews", async () => {
  reset();
  const reset2 = Date.now() + 2 * 24 * H;
  const followUp = h.ended({ agent: 'bolt', title: 'The call followed up' });
  const call = Number(h.storedCall(null, 'bolt', followUp).lastInsertRowid);
  // work handed an item, ended done with its pull request in a state (ledger.ts finished(): the item is ready, or handled),
  // and a fix queued on its branch
  const pr = (number: number, status: string, work: number) => {
    h.storedPr(number, work, status);
    ledger.finished({ id: work, kind: 'work' }, 'done');
    return h.queue({ agent: 'bolt', title: 'Fixing the tests', engine: 'claude', branch: `job/${work}`, pr: number });
  };
  const handed = (id: number) => {
    const work = h.ended({ agent: 'bolt', title: 'The gate' });
    ledger.handedOut(id, work, null);
    return work;
  };
  // (the work the item was handed to queued the job that made the pull request, carrying it on: hq job passes it on)
  const passedOn = item(call);
  ledger.finished({ id: handed(passedOn), kind: 'work' }, 'done');
  const carries = pr(9001, 'open', h.ended({ agent: 'bolt', title: 'The gate, painted', item: passedOn }));
  const decided = pr(9002, 'stuck', handed(item(call, 'decision')));
  const withBoard = pr(9006, 'board', handed(item(call)));
  // (handed to a job that failed: the work in its place made the pull request)
  const failed = h.ended({ agent: 'bolt', title: 'The gate' }, 'failed');
  ledger.handedOut(item(call), failed, null);
  const replaced = pr(9007, 'open', h.ended({ agent: 'bolt', title: 'The gate, again', insteadOf: failed }));
  const merged = pr(9003, 'merged', handed(item(call)));
  const gone = item(call), dropped = pr(9004, 'open', handed(gone));
  assert.equal(typeof ledger.drop(gone, 'The board took it back', followUp), 'object');
  const plain = pr(9005, 'open', h.ended({ agent: 'bolt', title: 'The fence' }));
  const review = h.queue({ agent: 'bolt', title: 'Reviewing', engine: 'claude', kind: 'review', branch: h.job(carries).branch, pr: 9001 });
  assert.deepEqual([passedOn, gone].map(i => ledger.item(i)!.status), ['ready', 'dropped']);
  const board = (id: number) => (db.prepare(`select ${jobs.BOARD_CALL('j')} board from jobs j where id = ?`).get(id) as { board: number }).board;
  assert.deepEqual([carries, decided, withBoard, replaced, review, merged, dropped, plain].map(board), [1, 1, 1, 1, 1, 0, 0, 0]);
  const paced = async () => (await claim(0.2, { pacedUntil: reset2 }))?.id;
  const taken = [await paced(), await paced(), await paced(), await paced(), await paced(), await paced()];
  assert.deepEqual(taken, [carries, decided, withBoard, replaced, review, undefined], 'the rest waits for the reset');
});

test("a deadline's pull request whose round is ruled: the check queued since carries the deadline onto a paced seat", async () => {
  reset();
  const reset2 = Date.now() + 2 * 24 * H;
  const author = h.ended({ agent: 'bolt' });
  h.storedPr(9010, author, 'open', ['platform/hq/shell/call.js'], { sha: 'c'.repeat(40), round: 2, since: author });
  const round = { agent: 'quill', engine: 'claude', kind: 'consolidate', pr: 9010, branch: `job/${author}`, round: 2 };
  h.ended({ ...round, sha: 'b'.repeat(40), stage: 'ruling' }, 'done', 'merge');
  const check = h.queue({ ...round, sha: 'c'.repeat(40), stage: 'merge' });
  const walk = queue('The walk the board waits on', { after: author, thread: h.dueThread({ deadline: Date.now() + 6 * H }) });
  const paced = async () => (await claim(0.2, { pacedUntil: reset2 }))?.id;
  assert.deepEqual([await paced(), await paced()], [check, undefined], 'the check, then nothing till the merge');
  assert.equal(h.job(walk).status, 'queued');
});

test("a deadline's pull request whose ruled round a push's triage opened again: its queued review carries the deadline", async () => {
  reset();
  const reset2 = Date.now() + 2 * 24 * H;
  const author = h.ended({ agent: 'bolt' });
  h.storedPr(9011, author, 'open', ['platform/hq/shell/call.js'], { sha: 'c'.repeat(40), round: 2, since: author });
  const round = { agent: 'quill', engine: 'claude', kind: 'consolidate', pr: 9011, branch: `job/${author}`, round: 2 };
  h.ended({ ...round, sha: 'b'.repeat(40), stage: 'ruling' }, 'done', 'merge');
  h.ended({ ...round, sha: 'c'.repeat(40), stage: 'triage' }, 'done');
  const review = h.queue({ ...round, agent: 'rook', kind: 'review', sha: 'c'.repeat(40), stage: 'review' });
  const walk = queue('The walk the board waits on', { after: author, thread: h.dueThread({ deadline: Date.now() + 6 * H }) });
  const paced = async () => (await claim(0.2, { pacedUntil: reset2 }))?.id;
  assert.deepEqual([await paced(), await paced()], [review, undefined], 'the review, then nothing till its ruling');
  assert.equal(h.job(walk).status, 'queued');
});

test('downtime work that windowed work waits for runs like any other: on a seat past its spare room, and in the order', async () => {
  reset();
  const normal = queue('Sprint work');
  const due = queue('The janitor the board waits on', { downtime: true, thread: h.dueThread({ deadline: Date.now() + H }) });
  assert.equal((await claim(0.85))?.id, due);
  assert.equal((await claim(0.85))?.id, normal);
});

test("normal work that can't start yet (after an open job, or not due) doesn't hold downtime back", async () => {
  reset();
  const blocker = await h.start({ agent: 'bolt', title: 'Still running' });
  queue('Waits for it', { after: blocker.id });
  const paused = await h.start({ agent: 'bolt', title: 'Paused until the reset', engine: 'claude' });
  await h.finish(paused, { status: 'limited', resetAt: Date.now() + H });
  const maint = queue('Janitor sweep', { downtime: true });
  assert.equal((await claim(0.2))?.id, maint);
});

test('a running downtime job yields when other work waits for its slot, or its seat passes 80%; a normal job never does', async () => {
  reset();
  await seatsReady();
  queue('Refactoring pass', { downtime: true });
  const maint = (await claim(0.2))!;
  assert.deepEqual(await beat(maint, { util: 0.3, short: true }), { ok: true }, 'nothing waiting');
  const sprint = [queue('Sprint work')];
  assert.deepEqual(await beat(maint, { util: 0.3 }), { ok: true }, 'a slot is free: the new work starts beside it');
  assert.deepEqual(await beat(maint, { util: 0.3, short: true }), { ok: true, yield: 'waiting' });
  sprint.push(queue('More sprint work'));
  assert.deepEqual(await beat(maint, { util: 0.3, short: true }), { ok: true, yield: 'waiting' }, 'each run hears for itself');
  for (const id of sprint) assert.ok((await import('./ledger.ts')).cancelJob(id, 'by bolt: not needed'));
  assert.deepEqual(await beat(maint, { util: 0.79, short: true }), { ok: true });
  assert.deepEqual(await beat(maint, { util: 0.8 }), { ok: true, yield: 'window' });
  assert.deepEqual(await beat(maint, {}), { ok: true }, 'an unmeasured window: it was only started on a measured one');
  // a chat waiting for the intercom's own slot isn't work this job is in the way of
  jobs.createJob({ agent: 'juno', kind: 'chat', title: 'Intercom', prompt: 'x', engine: 'claude' });
  assert.deepEqual(await beat(maint, { util: 0.3, short: true }), { ok: true });

  queue('Sprint work');
  const other = (await claim(0.2))!;
  assert.equal(other.title, 'Sprint work');
  queue('More sprint work');
  assert.deepEqual(await beat(other, { util: 0.95, short: true }), { ok: true });
});

test('short of memory, Claude downtime work yields to Codex work waiting too (both engines share it)', async () => {
  reset();
  await seatsReady();
  queue('Refactoring pass', { downtime: true });
  const maint = (await claim(0.2))!;
  queue('Review a sprint PR', { engine: 'codex' });
  assert.deepEqual(await beat(maint, { util: 0.2 }), { ok: true }, 'room left: the Codex job starts beside it');
  assert.deepEqual(await beat(maint, { util: 0.2, short: true }), { ok: true, yield: 'waiting' });
});

test("a Codex seat's unmeasured window: one probe claim may start downtime work, which yields if the reading is 60% or more", async () => {
  reset();
  const id = queue('Review a downtime PR', { engine: 'codex', downtime: true });
  assert.equal(await codex(), null, 'unknown counts as full');
  const maint = (await codex(undefined, { probe: true }))!;
  assert.equal(maint.id, id);
  assert.deepEqual(await beat(maint, { probe: true }), { ok: true }, 'no reading yet');
  assert.deepEqual(await beat(maint, { util: 0.4, probe: true }), { ok: true });
  assert.deepEqual(await beat(maint, { util: 0.6, probe: true }), { ok: true, yield: 'window' });
  assert.deepEqual(await beat(maint, { util: 0.6 }), { ok: true }, 'a job started on a measured window yields at 80%');

  // a review or Quill's check doesn't yield once started, so a probe never starts one: it waits for a measured window
  reset();
  const review = jobs.createJob({ agent: 'nib', kind: 'review', pr: 904, round: 1, branch: 'job/904', title: 'Review PR #904', prompt: 'x',
    engine: 'codex', downtime: true }).id;
  assert.equal(await codex(undefined, { probe: true }), null);
  assert.equal((await codex(0.3))?.id, review);
});

test('a yield is a pause, not a failure: queued again in its session, the try not counted, with a note', async () => {
  reset();
  const id = queue('Hardening scan', { downtime: true });
  let maint = (await claim(0.2))!;
  assert.equal((await h.finish(maint, { status: 'yielded', session: 'sess-1' })).status, 200);
  assert.equal(h.job(id).status, 'queued');
  assert.equal(until(id), 0, 'nothing waits for its room, so no hold');
  assert.equal(await claim(0.7), null, 'it waits for headroom again');
  maint = (await claim(0.1))!;
  assert.equal(maint.id, id);
  assert.equal(maint.session, 'sess-1', 'in its own session');
  assert.equal(maint.attempts, 0, 'the yield was not a failed try');
  assert.match(maint.note, /^You were paused/);
  // a note it started with (the board's answer) is kept
  await h.answer(await h.park(maint, { kind: 'decision', title: 'Go on?' }), 'Go ahead.');
  maint = (await claim(0.1))!;
  await h.finish(maint, { status: 'yielded', session: 'sess-1' });
  maint = (await claim(0.1))!;
  assert.match(maint.note, /^You were paused[^]*Go ahead\./);
});

test('after a downtime job yields for other work, no spare work takes its room before that work starts, on any engine', async () => {
  reset();
  await seatsReady();
  const d1 = queue('Refactoring pass', { downtime: true }), d2 = queue('Hardening scan', { downtime: true });
  const running = (await claim(0.1))!;
  assert.equal(running.id, d1);
  const sprint = queue('Sprint work', { engine: 'codex' });
  const codexDowntime = queue('Log scan', { engine: 'codex', downtime: true });
  // short of memory, the Codex work is waiting on it
  assert.deepEqual(await beat(running, { util: 0.1, short: true }), { ok: true, yield: 'waiting' });
  await h.finish(running, { status: 'yielded', session: 'sess-1' });
  // the yielded job and the next one are older than the Codex work, and still neither takes back the room it waits for
  assert.equal(await claim(0.1), null, "Claude's freed slot doesn't hand the room to downtime work");
  assert.equal((await codex(0.1))?.id, sprint);
  // once it has started, the room is anyone's: normal work first, then downtime work in queue order
  const normal = queue('More sprint work');
  assert.equal((await claim(0.1))?.id, normal);
  assert.equal((await claim(0.1))?.id, d1);
  assert.equal((await claim(0.1))?.id, d2);
  assert.equal((await codex(0.1))?.id, codexDowntime);
});

test('hq job --downtime marks the job; hq jobs shows it', async () => {
  reset();
  const lead = await h.start({ agent: 'bolt', title: 'Lead' });
  const r = await h.agent('job', lead.token, { agent: 'juno', title: 'Weekly refactoring pass', downtime: true });
  assert.equal(r.status, 200);
  const plain = await h.agent('job', lead.token, { agent: 'juno', title: 'Sprint work', downtime: 'yes' });
  assert.deepEqual((await h.agent('jobs?agent=juno', lead.token)).body.map((j: { line: string }) => j.line),
    [`#${r.body.id} ${r.body.code} juno, queued (downtime): Weekly refactoring pass`, `#${plain.body.id} ${plain.body.code} juno, queued: Sprint work`]);
  assert.deepEqual([h.job(r.body.id).downtime, h.job(plain.body.id).downtime], [1, 0], 'the projects view too');
});

test('schedule.yaml: a downtime entry queues downtime jobs, and the Recurring list says so', () => {
  reset();
  schedule.tick(new Date('2026-09-29T10:00:00Z'));
  assert.deepEqual((jobs.listJobs() as any[]).reverse().map(j => [j.agent, j.downtime]), [['bolt', 1], ['juno', 0]]);
  assert.deepEqual(schedule.recurring().map(e => [e.id, e.downtime]), [['sweep', true], ['round', false]]);
});

test("a downtime job's pull request is reviewed (and fixed) as downtime work too", async () => {
  reset();
  // (every review of the round, however many its risk asks for)
  const flags = async (pr: number, o?: { downtime?: boolean }) => [...new Set((await reviewed(pr, o)).map(j => j.downtime))];
  assert.deepEqual(await flags(901), [1]);
  assert.deepEqual(await flags(902, {}), [0]);
});

test('a downtime review, once started, runs to its end: a paused one would come back without the review.json it wrote', async () => {
  reset();
  await reviewed(903);
  const review = (await claim(0.2))!;
  assert.equal(review.pr, 903, 'it starts on spare capacity only, like its pull request');
  queue('Sprint work');
  assert.deepEqual(await beat(review, { util: 0.3, short: true }), { ok: true }, 'other work waiting');
  assert.deepEqual(await beat(review, { util: 0.85 }), { ok: true }, 'its seat past 80%');
});

test("the board's feedback on a downtime pull request isn't downtime, and neither are the reviews after it", async () => {
  reset();
  const maint = await h.start({ agent: 'bolt', title: 'Refactoring pass', downtime: true }, { util: 0.1 }), branch = `job/${maint.id}`;
  await h.finish(maint);
  const feedback = await h.start({ agent: 'bolt', branch, title: 'Board feedback on PR #905' });
  await h.finish(feedback, { pr: 905, branch, sha: 'd'.repeat(40), files: ['platform/coordinator/src/jobs.ts'] });
  await completeTriage(h, 905);
  const round = (jobs.listJobs() as any[]).filter(j => ['review', 'consolidate'].includes(j.kind) && j.pr === 905);
  assert.ok(round.some(j => j.kind === 'review'));
  assert.deepEqual([...new Set(round.map(j => j.downtime))], [0]);
});

test("a job that hit the limit on a held Codex seat is claimable at the seat's next check, not at the hold's end", async () => {
  reset();
  const t = Date.now(), at = mock.method(Date, 'now', () => t);
  try {
    queue('Review a high-risk PR', { engine: 'codex' });
    const job = (await codex(0.2))!;
    // The week read full (resets in 50 hours), then the CLI's limit with no time named: a 30-minute backoff.
    const windows = { resets: 0, week: 1, weekResets: t + 50 * H };
    const seat = { engine: 'codex', state: 'sleeping', until: sleepUntil(t + H / 2, windows, t), checked: t };
    assert.equal(seat.until, t + 50 * H, 'the seat itself is held for the week');
    await h.finish(job, { status: 'limited', resetAt: retryAt(seat, false, t) });
    assert.equal(until(job.id), t + H);
    at.mock.mockImplementation(() => t + H - 1);
    assert.equal(checkDue(seat, t + H - 1), false);
    assert.equal(await codex(1), null, 'not before the check');
    at.mock.mockImplementation(() => t + H);
    assert.equal(checkDue(seat, t + H), true);
    assert.equal((await codex(1))?.id, job.id, 'the check can be this job');
    // another free seat: at once
    assert.equal(retryAt(seat, true, t), 0);
  } finally { at.mock.restore(); }
});

// The worker's seats reporting, and its claims, on named Claude seats.
const seat = (id: string, state: string, w: Record<string, number> = {}) => h.worker('seat', { seat: id, engine: 'claude', state, ...w });
const pickup = (id: string) => on(id, 'claude');

test("a job a limit paused while every seat was full starts on the first seat to get room, not at its own seat's reset", async () => {
  reset();
  const t = Date.now(), id = queue('Round-3 fixes');
  const job = (await pickup('claude-2'))!;
  assert.equal(job.id, id);
  // claude-2 drains at 90% of its week, and claude-1 and claude-3 are draining too: no seat is free, so the job goes
  // back until claude-2's weekly reset, two days off.
  await seat('claude-1', 'draining', { util: 0.9, week: 0.3 });
  await seat('claude-3', 'draining', { util: 0.9, week: 0.35 });
  await seat('claude-2', 'draining', { util: 0, week: 0.9 });
  const drained = { engine: 'claude', state: 'draining', until: t + 50 * H };
  assert.equal((await h.finish(job, { status: 'limited', session: 's-limited', resetAt: retryAt(drained, false, t) })).status, 200);
  assert.equal(until(id), t + 50 * H);
  assert.equal(await pickup('claude-1'), null);
  // a worker restart: a seat back as ready with no reading yet may be just as full, so it lets nothing go
  await seat('claude-1', 'ready');
  assert.equal(await pickup('claude-1'), null, 'not on an unmeasured seat');
  // a seat that's still draining doesn't either. Then claude-3's 5-hour window resets and it's ready with room: the job goes on
  await seat('claude-3', 'draining', { util: 0.92, week: 0.36 });
  assert.equal(await pickup('claude-3'), null);
  await seat('claude-3', 'ready', { util: 0, week: 0.36 });
  assert.equal(until(id), 0);
  const again = (await pickup('claude-3'))!;
  assert.equal(again.id, id);
  assert.equal(again.session, 's-limited', 'in its own session');
});

test('a seat that gets room between the worker reading no seat free and the limited finish lets the job go at once', async () => {
  reset(); db.exec('delete from seats');
  const t = Date.now(), id = queue('Round-3 fixes');
  const job = (await pickup('claude-2'))!;
  await seat('claude-1', 'draining', { util: 0.9, week: 0.3 });
  await seat('claude-2', 'draining', { util: 0, week: 0.9 });
  // the worker works out the hold while no seat is free, then claude-1's window resets before the run settles
  const resetAt = retryAt({ engine: 'claude', state: 'draining', until: t + 50 * H }, false, t);
  await seat('claude-1', 'ready', { util: 0, week: 0.3 });
  assert.equal((await h.finish(job, { status: 'limited', session: 's-limited', resetAt })).status, 200);
  assert.equal(until(id), 0);
  assert.equal((await pickup('claude-1'))?.id, id);
});

test("the seat that hit the limit, or one with no reading, doesn't let a limited job go at its finish", async () => {
  reset(); db.exec('delete from seats');
  const t = Date.now(), id = queue('Round-3 fixes');
  const job = (await pickup('claude-2'))!;
  await seat('claude-2', 'ready', { util: 0.5, week: 0.9 });
  await seat('claude-1', 'ready');
  const resetAt = retryAt({ engine: 'claude', state: 'draining', until: t + 50 * H }, false, t);
  assert.equal((await h.finish(job, { status: 'limited', resetAt })).status, 200);
  assert.equal(until(id), t + 50 * H);
  assert.equal(await pickup('claude-1'), null);
});

test("a seat with room lets go only its engine's limit holds: a downtime yield holds nothing, a Codex job waits for a Codex seat", async () => {
  reset();
  const t = Date.now();
  const ready = (id: string, engine: string) => h.worker('seat', { seat: id, engine, state: 'ready', util: 0.1, week: 0.2 });
  // limited before (held_by set), then it ran again and yielded as downtime work: the yield clears the limit's hold
  const maint = queue('Log scan', { downtime: true });
  await h.finish((await on('claude-1', 'claude', { util: 0.1 }))!, { status: 'limited', resetAt: t + 50 * H });
  await ready('claude-2', 'claude');
  const again = (await claim(0.1))!;
  assert.equal(again.id, maint);
  await h.finish(again, { status: 'yielded' });
  assert.equal(until(maint), 0);
  // a Codex job a limit holds waits for a Codex seat with room, not a Claude one
  const id = queue('Review', { engine: 'codex' });
  await h.finish((await codex(0.2))!, { status: 'limited', resetAt: t + H });
  await ready('claude-2', 'claude');
  assert.equal(until(id), t + H);
  await ready('codex-2', 'codex');
  assert.equal(until(id), 0);
});
