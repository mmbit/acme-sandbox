// Downtime jobs, the worker's side (the coordinator's rule is in its jobs.ts): reading a Codex seat's windows, when a
// seat drains, and which downtime jobs stop when their heartbeats say yield.
import { spawn } from 'node:child_process';
import { full, windowUsed, type Windows } from './pace.ts';
import { cliOf, type SeatProvider } from './providers.ts';

// A reading from a Codex session log's last rate_limits line (token_count entries: used_percent of each window, the
// 5-hour one of 300 minutes and the weekly one of 10080). A plan may report only one of them: on 2026-09-30 a seat's
// only window was the week, as `primary`, so a window counts as the 5-hour one only if it says 300 minutes (or names no
// length at all), never by its place. Only one written since the run started (a resumed session's log starts with its
// last run's figures) and newer than the seat's latest (several runs share a seat, and an idle one keeps re-reading an
// old line) counts. The log is in the job's home, so the agent can write it: a figure is clamped to 0-100%, a timestamp
// that isn't a string is ignored (an object's toString could throw out of a timer), a line dated ahead of now is
// ignored (it would hold off every real reading after it), and so is a reset further ahead than its window is long (a
// planted resets_at in 2100 would drain the seat until then): that window's reset counts as unknown (DRAIN_RECHECK).
// util undefined: the reading has no 5-hour window. credits: the account pays for use past its limits (the board's
// Codex credits; the reading's `credits`, when it has one), so a full window doesn't drain the seat (drainUntil).
export function codexReading(line: string, since: number, measured = 0, now = Date.now()) {
  let e: any; try { e = JSON.parse(line); } catch { return; }
  const rl = e?.payload?.rate_limits, ws = [rl?.primary, rl?.secondary].filter(x => Number.isFinite(x?.used_percent));
  const w = ws.find(x => x.window_minutes === 300) ?? ws.find(x => x.window_minutes === undefined);
  const wk = ws.find(x => x.window_minutes === 10080);
  const at = typeof e?.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  if (!(at >= since && at > measured && at <= now + 60_000) || !w && !wk) return;
  const share = (x: { used_percent: number }) => Math.min(100, Math.max(0, x.used_percent)) / 100;
  const reset = (x: { resets_at?: number }, minutes: number) =>
    Number.isFinite(x.resets_at) && x.resets_at! * 1000 <= now + minutes * 60_000 ? x.resets_at! * 1000 : undefined;
  const credits = rl.credits && (rl.credits.unlimited === true || rl.credits.has_credits === true);
  return { at, ...(w ? { util: share(w), resets: reset(w, 300) } : {}), ...(wk ? { week: share(wk), weekResets: reset(wk, 10080) } : {}),
    ...(rl.credits ? { credits } : {}) };
}
// The tokens a Codex session has written so far, from the same line (its token_count's total), for HQ's chart of the
// work; undefined when it doesn't say.
export function codexTokens(line: string) {
  let e: any; try { e = JSON.parse(line); } catch { return; }
  const output: unknown = e?.payload?.info?.total_token_usage?.output_tokens;
  return Number.isInteger(output) && (output as number) >= 0 ? output as number : undefined;
}

// The last rate_limits line of a Codex session's log, read as the job's uid (the home is the job's) from its sessions
// folder. The agent can plant anything there, and this runs in the worker's own process, so the read is bounded: the
// file is found by NUL-separated name (a newline in a name can't point it at another path), only a regular file, only
// its last 8 MB, at most 1 MB of output, and a read that takes over `ms` (a FIFO swapped in, a huge tree) is killed
// with everything it started. undefined: no log, no figures in it yet, or it couldn't be read in time.
export function codexLogLine(who: { uid?: number; gid?: number; env: Record<string, string> }, sessions: string, session: string,
  ms = 10_000) {
  return new Promise<string | undefined>(resolve => {
    const script = 'find "$1" -type f -name "*$2*.jsonl" -print0 -quit | xargs -0 -r tail -c 8388608 -- | grep -F \'"rate_limits":{\' | tail -n 1';
    let out = '', done = false;
    const end = (v?: string) => {
      if (done) return;
      done = true; clearTimeout(t);
      if (v === undefined) try { process.kill(-c.pid!, 'SIGKILL'); } catch {}   // (its whole group: a tail left blocked on a FIFO too)
      resolve(v?.trim() || undefined);
    };
    const c = spawn('sh', ['-c', script, 'sh', sessions, session],
      { env: who.env, uid: who.uid, gid: who.gid, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const t = setTimeout(() => end(), ms);
    c.on('error', () => end());
    c.stdout!.on('data', d => { out += d; if (out.length > 2 ** 20) end(); });
    c.on('close', () => end(out));
  });
}

// A seat takes no new jobs once either window is at its drain level (drainLevel), Claude's and Codex's alike, until that
// window resets
// (the later reset when both are full, so a full week isn't taken back at the 5-hour reset): its jobs wait in the queue
// instead of starting and hitting the limit. A window with no known reset (a Codex line without resets_at, or one
// further ahead than its window) holds it for DRAIN_RECHECK. 0: not full, or not measured. A Codex seat held this way
// still takes one job every DRAIN_RECHECK (the worker's checkSeat), whose own run keeps the hold or lifts it. A seat
// with credits doesn't drain: past its limits it runs on them, until they run out and a limit puts it to sleep. Downtime
// work still goes by the windows (windowUsed), so it never spends them.
export const DRAIN_RECHECK = 60 * 60_000;
export function drainUntil(s: Windows, now = Date.now()) {
  if (s.credits) return 0;
  const over = full(s, now);
  return over.length ? Math.max(...over.map(([, reset]) => reset || now + DRAIN_RECHECK)) : 0;
}

// Whether a held Codex seat lets a job through now (the worker's checkSeat). Its readings come from a log its jobs can
// write, so a hold they set (a drain, or a sleep past the limit's own time: sleepUntil) can't be the last word: a held
// Codex seat takes one job every DRAIN_RECHECK, whose own run's reading keeps the hold or lifts it, and whose limit puts
// the seat back to sleep. (Claude seats have the worker's recheckLoop: their readings come from the CLI's own events.)
// checked: when the hold began or a job last went through.
type Held = { engine: string; state: string; until: number; checked?: number };
const held = (s: Held, now: number) => s.engine === 'codex' && (s.state === 'draining' || s.state === 'sleeping') && s.until > now;
export const checkDue = (s: Held, now = Date.now()) => held(s, now) && (s.checked ?? 0) + DRAIN_RECHECK <= now;

// The `until` the coordinator gets for a seat: a held Codex seat's next check, not the end of its hold (that goes in the
// seat's note). The panel counts a Codex seat as out until its `until` (codexSeatOut in review.ts) and starts a normal
// round without a Codex reviewer meanwhile, so with the hold's end there a check would only ever come from Codex work or
// a high-risk review, and one planted line could keep the panel short of Codex for days. Once the check is due, rounds
// get their Codex reviewer again, and the first such job is the check.
export const reportedUntil = (s: Held, now = Date.now()) => held(s, now) ? Math.min(s.until, (s.checked ?? 0) + DRAIN_RECHECK) : s.until;

// When a job that hit the limit on a seat may be claimed again (its not_before): at once if another seat is free, else
// when this seat next takes a job, which for a held Codex seat is its next check (reportedUntil), not the hold's end.
// With the hold's end there, the job (a stranded run, a high-risk review waiting for Codex) would sit out the whole
// hold, days for a full week, while the seat's hourly checks ran other work. That time is only the latest it waits: the
// first seat of its engine to report itself ready with a reading lets it go sooner (the coordinator's setSeat).
export const retryAt = (s: Held, free: boolean, now = Date.now()) => free ? 0 : reportedUntil(s, now);

// With no seat to pick (none ready, none draining), the one asleep at its limit that wakes first: the voice line's seat
// then (lineSeat), so a call that can't be answered now can be once that seat wakes, and the line says until when. None
// asleep: every seat is signed out.
export const firstToWake = <S extends { state: string; until: number }>(seats: S[]) =>
  seats.filter(s => s.state === 'sleeping').sort((a, b) => a.until - b.until)[0];

// The healthiest seat of an engine (the worker's pickSeat, once it has woken the seats whose sleep or drain is over): ready,
// least used by the fuller of its windows (none measured counts as full). board: the board's own work (the intercom, the
// voice line) may take a draining seat too, the reserve kept for it.
type Pickable = Windows & { engine: string; state: string };
export const healthiest = <S extends Pickable>(seats: S[], engine: string, board = false, not?: S, now = Date.now()) =>
  seats.filter(s => s.engine === engine && (s.state === 'ready' || board && s.state === 'draining') && s !== not)
    .sort((a, b) => (windowUsed(a, now) ?? 1) - (windowUsed(b, now) ?? 1))[0];

// The seat a slot claiming for Codex takes: each ready Codex seat in turn (the one whose last claim is the oldest), not the least used. Every
// Codex job is for one seat, which alone claims it (the coordinator's codexShare: the seats share the work evenly, and an
// account at its limit keeps its share, never handing it to the other), so a slot that kept picking the least used seat
// would only ever claim that seat's share and leave the other's waiting. lastClaimAt: when each seat last claimed.
export const inTurn = <S extends { id: string; engine: string; state: string }>(seats: S[], lastClaimAt: Map<string, number>, not?: S) =>
  seats.filter(s => s.engine === 'codex' && s.state === 'ready' && s !== not).sort((a, b) => (lastClaimAt.get(a.id) ?? 0) - (lastClaimAt.get(b.id) ?? 0))[0];

// A slot's seat among the engine's free ones (`pick`: healthiest): one whose last claim came back
// empty while paced (`empty`: claimAnswered) comes after the others while it's paced still (`paced`, its pacedUntil),
// so work it holds back starts on a seat that isn't paced; it's still picked when it's the only one, for the work it
// does take.
export const unpacedFirst = <S>(free: S[], empty: ReadonlySet<S>, paced: (s: S) => number | undefined, pick: (seats: S[]) => S | undefined) =>
  pick(free.filter(s => !empty.has(s) || paced(s) === undefined)) ?? pick(free);
// What a claim's answer does to the seats whose paced claim came back empty (`empty`): a job found takes its seat off,
// an empty paced claim puts it on, and an empty unpaced one takes off those that take the same work (its engine and CLI):
// there's none a pacing holds back from them, so each is tried again in its order.
export function claimAnswered<S extends SeatProvider>(empty: Set<S>, seat: S, paced: boolean, found: boolean) {
  if (found) empty.delete(seat);
  else if (paced) empty.add(seat);
  else for (const o of empty) if (o.engine === seat.engine && cliOf(o) === cliOf(seat)) empty.delete(o);
}

// The voice line's seat: the healthiest Claude seat, a draining one too, and with none, the first to wake (undefined:
// every Claude seat is signed out).
export const lineSeat = <S extends Pickable & { until: number }>(seats: S[], now = Date.now()) =>
  healthiest(seats, 'claude', true, undefined, now) ?? firstToWake(seats.filter(s => s.engine === 'claude'));

// The jobs a Claude seat stops at their next step when it starts draining, so they don't spend the board's reserve: every
// one running on it but the board's own (keep: the intercom's slot). A Codex seat's run on: a held Codex seat takes one
// job an hour anyway (checkDue).
export const drainPauses = (seat: { id: string; engine: string }, running: Iterable<[string, { seat: string; job: number }]>, keep: string) =>
  seat.engine === 'claude' ? [...running].filter(([slot, r]) => r.seat === seat.id && slot !== keep).map(([, r]) => r.job) : [];

// Until when a seat that hit its limit sleeps: the limit's own reset (limitReset: often only a backoff of 30 minutes
// and up, when the CLI's message names no time), but never before a drain its windows already call for. A run that
// reads the week full and then hits the limit would otherwise wake in 30 minutes and start jobs into the same wall.
export const sleepUntil = (limit: number, s: Windows, now = Date.now()) => Math.max(limit, drainUntil(s, now));

// A downtime job asked to yield: since when, why ('waiting': other work, 'window': its seat's window), and held: a
// probe's first reading was already at the start threshold, so later heartbeats (held to the higher yield threshold)
// can't take it back.
export type Asked = { at: number; why: string; held?: boolean; immediate?: boolean };

// A heartbeat's answer for a job selected to yield by the coordinator. It stays asked only while heartbeats keep
// saying so (the work it would make room for may start elsewhere). first: this heartbeat carried the probe's first
// reading. Returns what changed. A reined answer (its job past its share of HQ's time: the coordinator's jobs.ts
// heartbeat) still carries a pause or room yield, but left the downtime window unread, so a window yield heard stands.
export function heard(yielding: Map<number, Asked>, id: number,
  r: { yield?: string; immediate?: boolean; reined?: boolean } | undefined,
  o: { first?: boolean }, now = Date.now()): 'yielding' | 'carrying on' | undefined {
  const asked = yielding.get(id), held = !!o.first && r?.yield === 'window';
  if (r?.reined && asked?.why === 'window') return;
  if (!r?.yield) { if (asked && !asked.held) { yielding.delete(id); return 'carrying on'; } return; }
  if (asked) { Object.assign(asked, { why: asked.held ? asked.why : r.yield, held: asked.held || held, immediate: r.immediate }); return; }
  yielding.set(id, { at: now, why: r.yield, held, ...(r.immediate ? { immediate: true } : {}) });
  return 'yielding';
}
