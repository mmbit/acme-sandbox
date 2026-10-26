// node --test src/meetingroom.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { reservations, FREE_MB, JOB_MB, SEAT_MB } from '../../worker/src/reserve.ts';

const h = await harness('meetingroom');
const meetings = await import('./meetings.ts');
const { HOLD_MS, REST_MS } = await import('./meetingseats.ts');

beforeEach(async () => {
  h.db.exec('delete from meeting_seats; delete from meetings; delete from jobs; delete from seats');
  await h.worker('seat', { seat: 'claude-1', engine: 'claude', state: 'ready', until: 0 });
  await h.worker('seat', { seat: 'codex-1', engine: 'codex', state: 'ready', until: 0 });
});
const create = (at: number, agents = ['wren', 'bolt', 'kit', 'moss']) => {
  const made = meetings.create({ topic: 'Capacity review', agents, at, calledBy: 'juno', code: undefined });
  assert.equal(typeof made, 'object');
  return made as { id: number; seats: { agent: string; job: number }[] };
};
const claim = (slot: string, engine = 'claude', room?: number) =>
  h.worker('claim', { slot, engine, seat: `${engine}-1`, room });

test('freed memory gathers five due seats before older work, across engines, without stopping running work', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const running = await h.start({ agent: 'bolt', engine: 'claude' }, { seat: 'claude-1' });
  const ordinary = h.queue({ agent: 'bolt', engine: 'claude' });
  const other = h.queue({ agent: 'nib', engine: 'codex' });
  const m = create(now + 60_000);
  t.mock.timers.tick(60_000);
  assert.equal(
    (await h.heartbeat(running, { short: true, capped: [] })).body.yield,
    undefined,
    'a due meeting never asks running work to yield',
  );
  const reserve = reservations<string>();
  let available = FREE_MB;
  const started = new Set<number>();
  for (let i = 1; i <= 5; i++) {
    available += i === 1 ? JOB_MB : SEAT_MB;
    assert.ok(reserve.room(available), 'enough memory has just freed for one claim');
    assert.equal((await claim(`other-${i}`, 'codex')).body, null, 'another engine cannot spend the freed room');
    const slot = `slot-${i}`,
      taken = reserve.take();
    const answer = (await claim(slot)).body;
    if (reserve.keepsHold(slot, 'claude-1', taken, answer)) continue;
    assert.equal(answer?.kind, 'meeting');
    started.add(answer.id);
  }
  for (const slot of [...reserve.holding.keys()]) {
    const taken = reserve.take(),
      answer = (await claim(slot)).body;
    assert.equal(reserve.keepsHold(slot, 'claude-1', taken, answer), false);
    assert.equal(answer.kind, 'meeting');
    started.add(answer.id);
  }
  assert.equal(started.size, 5);
  assert.equal(meetings.meeting(m.id)?.status, 'live');
  assert.equal(h.job(ordinary).status, 'queued');
  assert.equal(h.job(other).status, 'queued');
  assert.equal(h.job(running.id).status, 'running');
  assert.equal(
    (h.db.prepare('select stopping from jobs where id = ?').get(running.id) as { stopping: string | null }).stopping,
    null,
  );
  assert.equal((await claim('ordinary')).body?.id, ordinary);
});

test('the gathering bound starts at the set time even when no slot could claim', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const work = h.queue({ agent: 'bolt', engine: 'claude' });
  const m = create(now);
  t.mock.timers.tick(HOLD_MS - 1);
  assert.ok((await claim('one')).body?.held);
  t.mock.timers.tick(1);
  assert.equal((await claim('one')).body?.id, work, 'all holds go at the due-time bound');
  assert.equal((await claim('two')).body, null, 'ordinary work has the rest interval');
  t.mock.timers.tick(REST_MS);
  assert.ok((await claim('two')).body?.held, 'the next bounded attempt may gather');
  assert.equal(meetings.meeting(m.id)?.status, 'planned');
});

test('staggered meetings that cannot fit share a rest for ordinary claims on every engine', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const measured = await h.start({ agent: 'bolt', engine: 'claude' });
  await h.worker('room', { short: false, free: 3000, jobs: [{ job: measured.id, mb: 400 }] });
  await h.finish(measured);
  const work = h.queue({ agent: 'bolt', engine: 'claude' });
  const other = h.queue({ agent: 'nib', engine: 'codex' });
  const first = create(now);
  const second = create(now + HOLD_MS / 2);
  assert.ok((await claim('only-room')).body?.held, 'room for one of five seats');
  t.mock.timers.tick(HOLD_MS / 2);
  assert.equal((await claim('other', 'codex')).body, null, 'the due meetings still have priority');
  t.mock.timers.tick(HOLD_MS / 2);
  assert.equal((await claim('only-room', 'claude', 400)).body?.id, work, 'ordinary work starts at the shared bound');
  const room = (await h.worker('room', { short: true, free: 1000, gathering: 1 })).body;
  assert.equal(room.meeting.state, 'resting');
  assert.equal(room.meeting.held, 0);
  assert.equal(room.meeting.until, now + HOLD_MS + REST_MS);
  create(Date.now());
  t.mock.timers.tick(REST_MS - 1);
  assert.equal((await claim('other', 'codex')).body?.id, other, 'a newly due meeting cannot interrupt the rest');
  for (const m of [first, second]) assert.equal(meetings.meeting(m.id)?.status, 'planned');
  t.mock.timers.tick(1);
  assert.ok((await claim('retry')).body?.held, 'meeting priority resumes after the shared rest');
});

test('room reports readiness ahead of time, waiting and bounded rest, and discards stale readings', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const m = create(now + 60_000);
  const report = async (gathering: number) =>
    (
      await h.worker('room', {
        short: true,
        free: 1000,
        jobs: [],
        claims: [],
        gathering,
      })
    ).body;
  await report(5);
  let room = (await h.board('/api/room')).body;
  assert.equal(room.meeting?.id, m.id);
  assert.equal(room.meeting?.state, 'scheduled');
  assert.equal(room.meeting?.ready, true);
  t.mock.timers.tick(60_000);
  const waiting = await report(0);
  assert.equal(waiting.meeting?.state, 'waiting');
  room = (await h.board('/api/room')).body;
  assert.match(room.line, /meeting.*waiting for room/i);
  assert.ok(!room.line.includes('#'), 'the board line has no internal numbers');
  assert.equal(room.meeting.ready, false);
  t.mock.timers.tick(HOLD_MS);
  room = (await h.board('/api/room')).body;
  assert.equal(room.meeting.state, 'resting');
  assert.equal(room.meeting.ready, null, 'old readings do not claim readiness');
  assert.ok(room.line);
});

test('priority begins when due, precedes windowed ordinary work, and preserves expedited work and chat', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const work = h.queue({ agent: 'bolt', engine: 'claude' });
  create(now + 60_000);
  assert.equal((await claim('before')).body?.id, work, 'a future meeting does not hold new starts');
  await h.worker('finish', { job: work, seat: 'claude-1', status: 'done' });
  const dated = h.queue({ agent: 'bolt', engine: 'claude', thread: h.dueThread({ deadline: now + 120_000 }) });
  t.mock.timers.tick(60_000);
  const expedited = h.queue({ agent: 'bolt', engine: 'claude', expedite: true });
  const chat = h.queue({ agent: 'juno', engine: 'claude', kind: 'chat' });
  assert.equal((await claim('urgent')).body?.id, expedited);
  assert.equal(
    (await h.worker('claim', { slot: 'chat', seat: 'claude-1', engine: 'claude', kind: 'chat' })).body?.id,
    chat,
  );
  assert.ok((await claim('due')).body?.held);
  assert.equal(h.job(dated).status, 'queued');
});
