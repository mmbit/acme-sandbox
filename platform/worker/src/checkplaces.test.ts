// node --test platform/worker/src/checkplaces.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckPlaces } from './checkplaces.ts';
import { seatPlaces } from './places.ts';
import { CHECK_SLOTS, WORK_SLOTS } from './slots.ts';
import { fewAtOnce } from './turns.ts';

const gate = () => Promise.withResolvers<void>();

test('all sessions waiting for checks return their places so a new session starts before checks finish', async () => {
  const checks = new CheckPlaces(CHECK_SLOTS),
    seats = seatPlaces({ codex: WORK_SLOTS.length });
  const seat = { id: 'codex-1', engine: 'codex' },
    finish = gate(),
    entered = gate();
  const turn = fewAtOnce(1),
    users = new Set<string>(),
    completed: number[] = [];
  const sessions = WORK_SLOTS.map((_, job) =>
    seats.hold(
      seat,
      false,
      () => false,
      () =>
        checks.run(
          job,
          async () => {
            users.add(await checks.take(job, () => false));
            if (users.size === WORK_SLOTS.length) entered.resolve();
            await turn.take(() => finish.promise);
            completed.push(job);
          },
          async error => {
            throw error;
          },
        ),
    ),
  );
  try {
    await entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(seats.count(seat), 0);
    await Promise.all(sessions);
    assert.equal(users.size, WORK_SLOTS.length);
    assert.equal(checks.checking.size, WORK_SLOTS.length);
    assert.deepEqual(completed, []);
    assert.equal(seats.roomOn(seat), true);
    let started = false;
    await seats.hold(
      seat,
      false,
      () => false,
      () =>
        checks.run(
          100,
          async () => {
            started = true;
          },
          async error => {
            throw error;
          },
        ),
    );
    assert.equal(started, true);
    assert.deepEqual(completed, []);
  } finally {
    finish.resolve();
  }
});

test('checks beyond the user pool wait without holding a session place and cancelled checks give their turn back', async () => {
  const checks = new CheckPlaces(['checks1']),
    finish = gate(),
    entered = gate(),
    cancelled = gate();
  const controller = new AbortController();
  await checks.run(
    1,
    async () => {
      assert.equal(await checks.take(1, () => false), 'checks1');
      entered.resolve();
      await finish.promise;
    },
    async error => {
      throw error;
    },
  );
  await entered.promise;
  await checks.run(
    2,
    async () => {
      await checks.take(2, () => false, controller.signal);
      assert.fail('cancelled check started');
    },
    async error => {
      assert.equal(error, controller.signal.reason);
      cancelled.resolve();
    },
  );
  controller.abort(new Error('stopped'));
  await cancelled.promise;
  assert.ok(checks.checking.has(1));
  finish.resolve();
  const third = gate();
  await checks.run(
    3,
    async () => {
      assert.equal(await checks.take(3, () => false), 'checks1');
      third.resolve();
    },
    async error => {
      throw error;
    },
  );
  await third.promise;
});

test('a reload reserves an active checks user and gives waiting checks another user', async () => {
  const checks = new CheckPlaces(['checks1', 'checks2'], ['checks1']);
  const finish = gate(),
    seen = gate();
  await checks.run(
    1,
    async () => {
      assert.equal(await checks.take(1, () => false, undefined, 'checks1'), 'checks1');
      await finish.promise;
    },
    async error => {
      throw error;
    },
  );
  await checks.run(
    2,
    async () => {
      assert.equal(await checks.take(2, () => false), 'checks2');
      seen.resolve();
    },
    async error => {
      throw error;
    },
  );
  await seen.promise;
  finish.resolve();
});

test('a stopped adopted check returns its reserved user even before it takes its turn', async () => {
  const checks = new CheckPlaces(['checks1'], ['checks1']);
  const stopped = new Error('stopped before checks');
  await assert.rejects(
    checks.run(
      1,
      async () => {
        throw stopped;
      },
      async error => {
        throw error;
      },
      'checks1',
    ),
    stopped,
  );
  const entered = gate();
  await checks.run(
    2,
    async () => {
      assert.equal(await checks.take(2, () => false), 'checks1');
      entered.resolve();
    },
    async error => {
      throw error;
    },
  );
  await entered.promise;
});
