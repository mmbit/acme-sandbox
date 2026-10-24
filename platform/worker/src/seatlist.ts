// The board's seats as HQ keeps them (the coordinator's seats.ts): the worker's own list follows HQ's, and each change the
// board made in Seats is carried out once, with words for the board on how it went. What touches the seats' folders, the
// sign-in tools and HQ comes in from the worker, so this runs in tests as it runs there.
import type { SeatProvider } from './providers.ts';
import { CLI_IDS } from './clis.ts';
import { DRAIN_AT } from './pace.ts';

// A seat on HQ's list, as the worker gets it
export type Listed = {
  id: string;
  engine: string;
  cli?: string; // (none: its engine's own)
  provider: string;
  sign_in: 'login' | 'key';
  url?: string;
  model?: string;
  models?: Record<string, string>;
  paused: boolean;
  stop?: number | null; // the board's stop level, in percent (null: the seat's own).
  week?: number; // the week's use HQ last heard, and when it resets (ms), till a run reads it again
  weekResets?: number;
};
// A change the board made that the worker hasn't taken up yet
export type SeatAction = { id: number; seat: string | null; what: string };
// (drainAt: its stop level, a share of its windows)
type BoardSeat = SeatProvider & {
  id: string;
  state: string;
  paused?: boolean;
  gone?: boolean;
  drainAt?: number;
};

// A seat the board paused takes no new work.
export const off = (s: BoardSeat) => !!s.paused;

// The seat ids that are the worker's own (a lowercase name, a dash, then digits or a word): an id that isn't names no folder.
const SEAT_ID = /^[a-z]+-([0-9]+|[a-z]+)$/;

type ListHooks<S> = {
  make: (id: string, engine: string) => S; // a seat new to the worker
  start: (seat: S) => void; // its own loop starts (once per seat)
  changed: (seat: S) => void; // paused, or back
  drop: (seat: S) => void; // off HQ's list
  held: Set<string>; // seats whose login move failed at this start (seatmoves.ts): kept off till the next
};
const started = new WeakSet<object>();

// The worker's seats take HQ's list: a seat new to it starts, the rest take what the board set (paused, its provider, its
// stop level: a seat the board hasn't set keeps its own), and one off the list takes no new work. Jobs running on a seat
// finish where they are.
export function applyList<S extends BoardSeat>(seats: S[], list: Listed[], hooks: ListHooks<S>) {
  for (const l of list) {
    const cli = l.cli ?? l.engine;
    if (
      hooks.held.has(l.id) ||
      !SEAT_ID.test(l.id) ||
      !['claude', 'codex'].includes(l.engine) ||
      !CLI_IDS.includes(cli)
    )
      continue;
    let seat = seats.find(s => s.id === l.id);
    // (a seat moved to another engine's work, or onto another CLI, starts again as a new one: its runs finish where they are)
    if (seat && (seat.engine !== l.engine || (seat.cli ?? seat.engine) !== cli)) {
      hooks.drop(seat);
      seat = undefined;
    }
    const was = seat && off(seat);
    if (!seat) {
      seat = hooks.make(l.id, l.engine);
      seats.push(seat);
    }
    Object.assign(seat, {
      cli,
      provider: l.provider,
      signIn: l.sign_in,
      url: l.url,
      model: l.model,
      models: l.models,
      paused: l.paused,
    });
    if (typeof l.stop === 'number') seat.drainAt = l.stop / 100;
    if (!started.has(seat)) {
      started.add(seat);
      hooks.start(seat);
    } else if (was !== off(seat)) hooks.changed(seat);
  }
  for (const seat of seats.filter(s => !list.some(l => l.id === s.id))) hooks.drop(seat);
}

type Doers<S> = {
  runsOn: (id: string) => number; // the jobs running on a seat now
  signIn: (seat: S, action?: number) => Promise<unknown>; // a sign-in shown on the seat's row; it settles the action
  takeKey: (seat: S) => Promise<{ ok: boolean; words: string }>; // the board's key, tried before it's kept
  drop: (seat: S) => void;
  forget: (id: string) => void; // the seat's sign-in deleted from our server
  settle: (id: number, status: 'working' | 'done' | 'failed', words?: string) => Promise<unknown>;
  pacing: () => boolean;
};

// One change of the board's, carried out, and HQ told how it went. A seat removed while jobs run on it lets them finish
// (their sign-in is already with them).
export async function carryOut<S extends BoardSeat>(a: SeatAction, seats: S[], d: Doers<S>) {
  const seat = seats.find(s => s.id === a.seat),
    runs = a.seat ? d.runsOn(a.seat) : 0;
  const after = runs ? ` The ${runs === 1 ? 'job' : `${runs} jobs`} running on it finish there first.` : '';
  if (a.what === 'pacing') return d.settle(a.id, 'done', d.pacing() ? 'Pacing is on.' : 'Pacing is off.');
  if (a.what === 'remove') {
    if (seat) d.drop(seat);
    if (a.seat && SEAT_ID.test(a.seat)) d.forget(a.seat);
    return d.settle(
      a.id,
      'done',
      `Removed, and its sign-in deleted from our server.${after} The account itself is still open with its provider: cancel it there if that's what you want.`,
    );
  }
  if (!seat) return d.settle(a.id, 'failed', "The worker doesn't have this seat. Try again in a minute.");
  if (a.what === 'stop')
    return d.settle(a.id, 'done', `Stops at ${Math.round((seat.drainAt ?? DRAIN_AT) * 100)}% of its limits now.`);
  if (a.what === 'pause') return d.settle(a.id, 'done', `Paused: it takes no new work.${after}`);
  if (a.what === 'resume') return d.settle(a.id, 'done', 'Back at work.');
  if (a.what === 'sign-in' || (a.what === 'add' && seat.signIn === 'login')) {
    await d.settle(a.id, 'working');
    if (a.what === 'add') await d.settle(a.id, 'done', 'Added. Its sign-in has started.');
    return d.signIn(seat, a.what === 'sign-in' ? a.id : undefined);
  }
  if (a.what === 'key' || a.what === 'add') {
    await d.settle(a.id, 'working');
    const r = await d.takeKey(seat);
    return d.settle(a.id, r.ok ? 'done' : 'failed', a.what === 'add' ? `Added. ${r.words}` : r.words);
  }
  return d.settle(a.id, 'failed', "The worker doesn't know this change.");
}
