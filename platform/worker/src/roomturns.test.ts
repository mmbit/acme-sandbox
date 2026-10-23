// node --test src/roomturns.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomTurns, IDLE_MS } from './roomturns.ts';

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, pass: (ms: number) => (t += ms) };
};
const both = [{ engine: 'claude' }, { engine: 'codex' }];
const never = () => undefined;
// What one free slot picks with room, by engine name
const pick = (turns: ReturnType<typeof roomTurns>, ready = both) => turns.next(ready, true, never)?.engine;

test('slots that pick while earlier claims are still unanswered alternate, in the same millisecond too', () => {
  const turns = roomTurns(clock().now);
  assert.deepEqual([pick(turns), pick(turns), pick(turns), pick(turns)], ['claude', 'codex', 'claude', 'codex']);
});

test('vacancies far apart, every slot busy between them, still alternate', () => {
  const c = clock(),
    turns = roomTurns(c.now);
  const picked: string[] = [];
  for (let i = 0; i < 6; i++) {
    const engine = pick(turns)!;
    picked.push(engine);
    turns.found(engine, true);
    c.pass(60_000); // no slot looks until the next one frees
  }
  assert.deepEqual(picked, ['claude', 'codex', 'claude', 'codex', 'claude', 'codex']);
});

test('an engine with no seat to start on holds nobody up, and keeps its place for when it has one', () => {
  const c = clock(),
    turns = roomTurns(c.now);
  assert.equal(pick(turns), 'claude');
  for (let i = 0; i < 3; i++) {
    assert.equal(pick(turns, [{ engine: 'claude' }]), 'claude');
    c.pass(60_000);
  }
  assert.equal(pick(turns), 'codex');
});

test('an engine whose claim found nothing goes after those with work, until IDLE_MS has passed', () => {
  const c = clock(),
    turns = roomTurns(c.now);
  turns.found(pick(turns)!, false); // Claude's claim found nothing
  assert.equal(pick(turns), 'codex');
  assert.equal(pick(turns), 'codex');
  assert.equal(pick(turns, [{ engine: 'claude' }]), 'claude', 'alone, an idle engine still claims');
  c.pass(IDLE_MS);
  assert.equal(pick(turns), 'codex', 'back in rotation, the oldest turn first');
  assert.equal(pick(turns), 'claude');
});

test('short of room only a claim with its room goes, and it takes no turn', () => {
  const turns = roomTurns(clock().now);
  assert.equal(turns.next(both, false, never), undefined);
  assert.deepEqual(
    turns.next(both, false, engine => (engine === 'codex' ? 900 : undefined)),
    { engine: 'codex', room: 900 },
  );
  assert.equal(pick(turns), 'claude');
  assert.equal(pick(turns), 'codex');
});
