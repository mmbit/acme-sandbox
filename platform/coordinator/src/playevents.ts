// Quota, completion and reservation events in the shared forward plan.
import type { Play } from './simulation.ts';
import type { QueuedJob } from './eta.ts';
import * as capacity from './playseats.ts';
import * as memory from './playmemory.ts';
import * as ledger from './playledger.ts';

export function advance(play: Play, now: number, next: number) {
  for (const run of play.started) {
    if (run.state !== 'running') continue;
    if (run.seat) capacity.consume(run.seat, next - now, run.row);
    const last = run.active.at(-1);
    if (last?.end === now) last.end = next;
    else run.active.push({ start: now, end: next });
  }
}

export function finish(play: Play, now: number) {
  for (const run of play.started.filter(r => r.ends <= now)) {
    play.started.splice(play.started.indexOf(run), 1);
    if (run.state === 'pausing') {
      run.state = 'waiting';
      run.seat = null;
      run.reviewSeat = null;
      continue;
    }
    run.state = 'done';
    play.unfinished.delete(run);
    play.claimants.delete(run);
    run.done = run.ends;
    run.seat = null;
  }
}

export function drain(play: Play, now: number) {
  if (play.account) ledger.exhaust(play.account, play, now);
  for (const run of [...play.started]) {
    if (run.state !== 'running' || run.seat?.engine !== 'claude' || !capacity.drained(run.seat, now)) continue;
    play.started.splice(play.started.indexOf(run), 1);
    run.left = Math.max(0, run.ends - now);
    run.state = 'waiting';
    run.seat = null;
  }
}

export function nextEvent(play: Play, now: number) {
  let next = Infinity;
  const event = (at: number) => {
    if (at > now && at < next) next = at;
  };
  const busy = new Map<capacity.Seat, QueuedJob[]>();
  for (const run of play.started) {
    if (run.state === 'running') {
      if (run.ends === now) return now;
      if (run.seat) busy.set(run.seat, [...(busy.get(run.seat) ?? []), run.row]);
    }
    event(run.ends);
  }
  for (const run of play.unfinished) {
    if (run.state !== 'waiting') continue;
    event(run.readyAt);
    while (run.fixedAt < run.fixed.length && run.fixed[run.fixedAt] <= now) run.fixedAt++;
    if (run.fixedAt < run.fixed.length) event(run.fixed[run.fixedAt]);
    for (const { run: prior, lag } of run.timedPriors) if (prior.done !== null) event(prior.done + lag);
  }
  for (const seat of play.seats) event(capacity.seatEvent(seat, play.seats, now, busy.get(seat) ?? []));
  const release = memory.nextEvent(play.snapshot, now);
  if (release !== null) event(release);
  return next;
}
