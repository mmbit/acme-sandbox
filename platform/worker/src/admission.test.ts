// node --test src/admission.test.ts (disposable kernel and host readings)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryFixture } from './memory.fixture.ts';
import { FREE_MB, JOB_MB, SEAT_MB, STARTING_MS } from './reserve.ts';
import { PRESSURE_PERCENT, QUIET_MS } from './memory.ts';

for (const cap of [7168, 8192]) {
  test(`the captured load admits no ordinary or measured job under a ${cap} MiB ceiling`, t => {
    const { reading, memory } = memoryFixture(t);
    reading(cap * 2 ** 20, 7386316800, 340353024, 5404499968);
    assert.equal(memory.room(), false);
    assert.equal(memory.starts(), 0);
    assert.equal(memory.claimMb(), 0);
  });
}

test('host availability bounds admission even when the cgroup has more room', t => {
  const { reading, memory } = memoryFixture(t);
  reading(8192 * 2 ** 20, 1024 * 2 ** 20, 0, 5404499968);
  assert.equal(memory.availableMb(), 5404499968 / 2 ** 20);
  let admitted = 0;
  while (memory.room()) {
    memory.take();
    admitted++;
  }
  assert.equal(admitted, 5);
  assert.equal(memory.starts(), 0);
  assert.ok(memory.freeMb() >= FREE_MB);
});

test('shared, dirty, writeback and locked pages stay charged alongside anonymous and kernel memory', t => {
  const { reading, memory, write } = memoryFixture(t);
  reading(8192 * 2 ** 20, 8000 * 2 ** 20, 0, 9000 * 2 ** 20);
  write(
    'memory.stat',
    `file ${6000 * 2 ** 20}\nshmem ${2000 * 2 ** 20}\nfile_dirty ${1000 * 2 ** 20}\nfile_writeback ${500 * 2 ** 20}\nunevictable ${500 * 2 ** 20}`,
  );
  assert.equal(memory.availableMb(), 2192);
  assert.equal(memory.room(), false);
});

test('routine reclaim at the limit leaves the clean cache as room', t => {
  const { reading, memory, write } = memoryFixture(t);
  reading(8e9, 7.28e9, 5.45e9, 9.7e9);
  assert.equal(memory.room(), true);
  // The night of 30 October, captured during successful reclaim that falsely held room at 0 MB.
  write('memory.pressure', 'some avg10=1.64 avg60=1.32 avg300=0.60 total=1165805446');
  write('memory.events', 'low 0\nhigh 9\nmax 4242\noom 2\noom_kill 1');
  assert.ok(memory.availableMb() > 5000);
  assert.equal(memory.room(), true);
});

test('tasks stalled on memory a tenth of the time stop admission, and it recovers when quiet', t => {
  const { reading, memory, write, advance } = memoryFixture(t);
  reading(8e9, 7.28e9, 5.45e9, 9.7e9);
  write('memory.pressure', 'some avg10=12.50 avg60=4.00 avg300=1.00 total=1165805446');
  assert.equal(memory.availableMb(), 0);
  assert.equal(memory.room(), false);
  assert.equal(memory.claimMb(), 0);
  write('memory.pressure', 'some avg10=2.00 avg60=4.00 avg300=1.00 total=1165905446');
  advance(QUIET_MS);
  assert.equal(memory.room(), true);
});

test('sustained stalls extend the brake until a full window below the threshold', t => {
  const { reading, memory, write, advance } = memoryFixture(t);
  reading(8e9, 7.28e9, 5.45e9, 9.7e9);
  write('memory.pressure', `some avg10=${PRESSURE_PERCENT - 0.01} avg60=0.00 avg300=0.00 total=100`);
  assert.equal(memory.room(), true);
  write('memory.pressure', `some avg10=${PRESSURE_PERCENT} avg60=0.00 avg300=0.00 total=100`);
  assert.equal(memory.room(), false);
  advance(QUIET_MS);
  assert.equal(memory.room(), false, 'ongoing pressure extends the hold');
  write('memory.pressure', 'some avg10=0.09 avg60=0.00 avg300=0.00 total=100');
  advance(QUIET_MS - 1);
  assert.equal(memory.room(), false);
  advance(1);
  assert.equal(memory.room(), true);
});

for (const event of ['oom', 'oom_kill']) {
  test(`a new ${event} event stops repeated claims until a quiet pressure window passes`, t => {
    const { reading, memory, write, advance } = memoryFixture(t);
    reading(8e9, 7.28e9, 5.45e9, 9.7e9);
    assert.equal(memory.room(), true, 'historical counters are not current pressure');
    const events = { low: 0, high: 0, max: 42, oom: 2, oom_kill: 1 };
    events[event as keyof typeof events]++;
    write(
      'memory.events',
      Object.entries(events)
        .map(([name, count]) => `${name} ${count}`)
        .join('\n'),
    );
    assert.equal(memory.room(), false);
    assert.equal(memory.claimMb(), 0, 'a second read inside the window stays braked');
    advance(QUIET_MS - 1);
    assert.equal(memory.room(), false);
    advance(1);
    assert.equal(memory.room(), true);
  });
}

test('routine clean cache reclaim at the cap keeps admission open and the watch calm', async t => {
  const { reading, memory, write, advance } = memoryFixture(t);
  const { memoryWatch } = await import('./lowmemory.ts');
  const watch = memoryWatch(2048, 3072);
  watch(6000, new Map([[7, 100]]));
  reading(8e9, 8e9, 5.45e9, 9.7e9, 'active_file 4790000000\n');
  assert.equal(memory.room(), true);
  for (let i = 1; i <= 3; i++) {
    advance(1000);
    write('memory.events', `low 0\nhigh ${i}\nmax ${42 + i}\noom 2\noom_kill 1`);
    write(
      'memory.pressure',
      `some avg10=0.09 avg60=0.00 avg300=0.00 total=${100 + i * 50}\nfull avg10=0.05 avg60=0.00 avg300=0.00 total=${50 + i * 40}`,
    );
    assert.equal(memory.availableMb(), 5.45e9 / 2 ** 20);
    assert.equal(memory.room(), true);
    assert.deepEqual(watch(memory.freeMb(false), new Map([[7, 2300]])), { verdict: 'calm' });
  }
});

test('reclaimable file cache makes room for a candidate above the reserve', t => {
  const { reading, memory } = memoryFixture(t);
  reading(8192 * 2 ** 20, 6692 * 2 ** 20, 0, 6000 * 2 ** 20);
  assert.equal(memory.room(), false);
  reading(8192 * 2 ** 20, 6692 * 2 ** 20, JOB_MB * 2 ** 20, 6000 * 2 ** 20);
  assert.equal(memory.room(), true);
  memory.take();
  assert.equal(memory.freeMb(), FREE_MB);
  assert.equal(memory.room(), false);
});

test('holds and young starts reduce admission but shortage uses the unreserved reading', t => {
  const { reading, memory, advance } = memoryFixture(t);
  reading('max', 1024, 0, (FREE_MB + JOB_MB + SEAT_MB) * 2 ** 20);
  const start = memory.take();
  memory.keepsHold('slot1', 'seat1', start, { held: true });
  assert.equal(memory.room(), true);
  memory.take();
  assert.deepEqual(memory.startupReservations(), [{ until: STARTING_MS, mb: JOB_MB }]);
  assert.equal(memory.room(), false);
  assert.equal(memory.room(false), true);
  advance();
  assert.deepEqual(memory.startupReservations(), []);
  assert.equal(memory.room(), true);
});

test('shortage begins below 2200 MiB while a measured small claim can still fit', t => {
  const { reading, memory } = memoryFixture(t);
  reading('max', 1024, 0, 2200 * 2 ** 20);
  assert.equal(memory.room(false), true);
  reading('max', 1024, 0, 2199 * 2 ** 20);
  assert.equal(memory.room(false), false);
  assert.equal(memory.claimMb(), 699);
});

test('ordinary admission keeps immutable prior observed quiet bounds without inventing an initial OOM baseline', t => {
  const { reading, memory, advance } = memoryFixture(t);
  reading(8e9, 7.28e9, 5.45e9, 9.7e9);
  const roomInput = () => memory.inspect(() => memory.room()).inputs[0].measurement;
  const first = roomInput();
  assert.equal(first.quietPredecessor, null);
  assert.equal(first.previousOomEvents, null);
  advance(QUIET_MS);
  const second = roomInput();
  assert.deepEqual(second.quietPredecessor?.first.identity, first.identity);
  assert.equal(second.quietPredecessor?.observedReadCount, 1);
  assert.equal(second.quietPredecessor?.initialPreviousOomEvents, null);
  const third = roomInput();
  const quiet = third.quietPredecessor!;
  assert.equal(quiet.observedReadCount, 2);
  assert.deepEqual(quiet.last.identity, second.identity);
  assert.equal(quiet.last.readEndedAt - quiet.first.readStartedAt, QUIET_MS);
  assert.equal(quiet.last.sequence - quiet.first.sequence, 1);
  assert.deepEqual(quiet.previousOomEvents, [2, 1]);
  assert.equal(third.underPressure, false);
  assert.equal(third.lastPressureTrigger, null);
  assert.equal(third.availableBytes, 6.17e9);
  advance(1000);
  roomInput();
  assert.equal(quiet.observedReadCount, 2);
});

for (const cause of ['psi', 'oom'] as const) {
  test(`an observed ${cause} trigger clears quiet history and preserves its identity through the hold`, t => {
    const { reading, memory, write, advance } = memoryFixture(t);
    reading(8e9, 7.28e9, 5.45e9, 9.7e9);
    const roomInput = () => memory.inspect(() => memory.room()).inputs[0].measurement;
    roomInput();
    advance(QUIET_MS);
    roomInput();
    if (cause === 'psi') write('memory.pressure', `some avg10=${PRESSURE_PERCENT} avg60=0 avg300=0 total=100`);
    else write('memory.events', 'low 0\nhigh 0\nmax 42\noom 3\noom_kill 1');
    const blocked = roomInput();
    assert.equal(blocked.quietPredecessor, null);
    assert.equal(blocked.underPressure, true);
    assert.equal(blocked.availableBytes, 0);
    assert.deepEqual(blocked.lastPressureTrigger?.identity, blocked.identity);
    assert.equal(blocked.lastPressureTrigger?.psiThreshold, cause === 'psi');
    assert.equal(blocked.lastPressureTrigger?.someAvg10, cause === 'psi' ? PRESSURE_PERCENT : 0);
    assert.equal(blocked.lastPressureTrigger?.memoryPressure, blocked.memoryPressure);
    assert.equal(blocked.lastPressureTrigger?.memoryEvents, blocked.memoryEvents);
    assert.equal(blocked.lastPressureTrigger?.newOomEvent, cause === 'oom');
    assert.deepEqual(blocked.lastPressureTrigger?.previousOomEvents, [2, 1]);
    write('memory.pressure', 'some avg10=0 avg60=0 avg300=0 total=100');
    advance(QUIET_MS - 1);
    const held = roomInput();
    assert.equal(held.quietPredecessor, null);
    assert.deepEqual(held.lastPressureTrigger, blocked.lastPressureTrigger);
    advance(1);
    const recovered = roomInput();
    assert.equal(recovered.underPressure, false);
    assert.equal(recovered.quietPredecessor, null, 'quiet reads inside the hold do not supply a predecessor');
    assert.equal(recovered.pressureUntil, blocked.lastPressureTrigger?.pressureUntil);
    advance(QUIET_MS);
    const next = roomInput();
    assert.equal(next.quietPredecessor?.observedReadCount, 1);
    assert.deepEqual(next.quietPredecessor?.first.identity, recovered.identity);
    const qualified = roomInput();
    assert.equal(qualified.quietPredecessor?.observedReadCount, 2);
    assert.deepEqual(qualified.lastPressureTrigger, blocked.lastPressureTrigger);
  });
}
