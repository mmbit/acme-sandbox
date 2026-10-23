// node --test src/reserve.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reservations } from './reserve.ts';

// HQ's answers to a meeting's seats (meetingseats.ts pick): a free slot holds an open seat, and once every seat is held
// the meeting goes live and each holding slot starts its own.
function meeting(seats: number) {
  const held = new Set<string>();
  let live = false;
  return (slot: string) => {
    if (live) return held.has(slot) ? { id: 1 } : null;
    if (!held.has(slot)) {
      if (held.size === seats) return null;
      held.add(slot);
    }
    live = held.size === seats;
    return live ? { id: 1 } : { held: true };
  };
}

test("a ten-seat meeting gathers and starts in the worker's room with a few jobs running", () => {
  const reserve = reservations<string>(() => 0);
  const available = 7168 - 1500; // the worker's cap (infra/compose.yaml), less about 1.5 GB of running jobs
  const claim = meeting(10),
    started = new Set<string>();
  // fifteen slots claim in turn (worker.ts slotLoop): a free one only with room, a holding one on its hold
  for (let round = 0; round < 3; round++)
    for (let i = 1; i <= 15; i++) {
      const slot = `slot${i}`;
      if (started.has(slot) || (!reserve.holding.has(slot) && !reserve.room(available))) continue;
      const t = reserve.take(),
        answer = claim(slot);
      if (reserve.keepsHold(slot, 'claude-1', t, answer)) continue;
      if (!answer) reserve.giveBack(t);
      else started.add(slot);
    }
  assert.equal(started.size, 10);
  assert.equal(reserve.holding.size, 0);
});
