// node --test src/turns.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fewAtOnce, roomInTurn } from './turns.ts';

// a run that ends when its test says so
function held() {
  let end!: () => void;
  const done = new Promise<void>(resolve => (end = resolve));
  return { end, run: () => done };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('two at a time: the third starts only once one ends, the rest in the order they came', async () => {
  const turn = fewAtOnce(2),
    started: string[] = [],
    runs = ['a', 'b', 'c', 'd'].map(name => ({ name, ...held() }));
  const all = runs.map(r =>
    turn(() => {
      started.push(r.name);
      return r.run();
    }),
  );
  await settle();
  assert.deepEqual(started, ['a', 'b']);
  runs[1].end();
  await settle();
  assert.deepEqual(started, ['a', 'b', 'c']);
  // a newcomer while c and a run waits behind d
  const late = held();
  const lateDone = turn(() => {
    started.push('late');
    return late.run();
  });
  runs[0].end();
  await settle();
  assert.deepEqual(started, ['a', 'b', 'c', 'd']);
  runs[2].end();
  runs[3].end();
  late.end();
  await Promise.all([...all, lateDone]);
  assert.deepEqual(started, ['a', 'b', 'c', 'd', 'late']);
});

test('a run that fails gives its place back, and its error reaches its caller', async () => {
  const turn = fewAtOnce(1);
  await assert.rejects(
    turn(() => Promise.reject(new Error('broke'))),
    /broke/,
  );
  assert.equal(await turn(async () => 'next'), 'next');
});

test('only a run that had to wait hears how long', async () => {
  const turn = fewAtOnce(1),
    first = held(),
    heard: number[] = [];
  const one = turn(first.run, ms => heard.push(ms));
  const two = turn(
    async () => 'second',
    ms => heard.push(ms),
  );
  await settle();
  assert.deepEqual(heard, []);
  first.end();
  assert.equal(await two, 'second');
  await one;
  assert.equal(heard.length, 1);
  assert.ok(heard[0] >= 0);
});

test('a waiting run of urgent work takes the next place before those that came earlier, which keep their order', async () => {
  const turn = fewAtOnce(1),
    started: string[] = [],
    urgent = new Set(['c']),
    runs = ['a', 'b', 'c', 'd'].map(name => ({ name, ...held() }));
  const all = runs.map(r =>
    turn(
      () => {
        started.push(r.name);
        return r.run();
      },
      undefined,
      () => urgent.has(r.name),
    ),
  );
  await settle();
  // (urgency read as the place frees: d's came while it waited)
  urgent.add('d');
  for (const r of runs) {
    r.end();
    await settle();
  }
  await Promise.all(all);
  assert.deepEqual(started, ['a', 'c', 'd', 'b']);
});

test("while urgent work's check waits for room the others leave it the room, and take it once it has it", async () => {
  let room = false;
  const ticks: (() => void)[] = [];
  const tick = () => new Promise<void>(go => ticks.push(go));
  const roomBack = roomInTurn(async () => room, tick, 15_000);
  const waiter = (name: string, first: boolean) => roomBack(() => first).then(() => name);
  const back: string[] = [];
  const ordinary = waiter('ordinary', false).then(name => back.push(name));
  const urgent = waiter('urgent', true).then(name => back.push(name));
  await settle();
  room = true;
  // the ordinary one asks first, sees the urgent one waiting and leaves the room; the urgent one takes it
  ticks.shift()!();
  await settle();
  assert.deepEqual(back, []);
  ticks.shift()!();
  await urgent;
  assert.deepEqual(back, ['urgent']);
  ticks.shift()!();
  await ordinary;
  assert.deepEqual(back, ['urgent', 'ordinary']);
});
