// node --test src/downtime.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDue, codexLimits, codexLogLine, codexReading, codexTokens, drainPauses, drainUntil, firstToWake, healthiest, heard, inTurn, limitsReading, lineSeat, reportedUntil, sleepUntil, DRAIN_RECHECK, type Asked } from './downtime.ts';
import { drainLevel, drainLifts, paceChange, pacedUntil, paceTo, reserveElsewhere, windowUsed } from './pace.ts';
import { limitReset } from './outcome.ts';

const line = (at: string, used: unknown, extra: object = {}) => JSON.stringify({ timestamp: at, type: 'event_msg',
  payload: { type: 'token_count', rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1790000000, ...extra },
    secondary: { used_percent: 3, window_minutes: 10080 } } } });
const NOW = Date.parse('2026-09-29T12:00:00Z');

test("a Codex reading: the 5-hour window's share, written since the run started", () => {
  assert.deepEqual(codexReading(line('2026-09-29T11:59:00Z', 42), NOW - 3600e3, 0, NOW),
    { util: 0.42, at: Date.parse('2026-09-29T11:59:00Z'), resets: 1790000000e3, week: 0.03, weekResets: undefined });
  assert.equal(codexReading(line('2026-09-29T10:00:00Z', 42), NOW - 60e3, 0, NOW), undefined);   // an earlier run's
  assert.equal(codexReading('not json', 0, 0, NOW), undefined);
  assert.equal(codexReading(line('2026-09-29T11:59:00Z', '42'), 0, 0, NOW)?.util, undefined);   // (the week's still read)
});

test("an older reading never replaces a newer one on the same seat", () => {
  const b = codexReading(line('2026-09-29T11:58:00Z', 85), 0, 0, NOW)!;
  assert.equal(codexReading(line('2026-09-29T11:50:00Z', 20), 0, b.at, NOW), undefined);   // job A's idle re-read
  assert.equal(codexReading(line('2026-09-29T11:58:00Z', 20), 0, b.at, NOW), undefined);   // the same line again
  assert.equal(codexReading(line('2026-09-29T11:59:00Z', 87), 0, b.at, NOW)?.util, 0.87);
});

test("the weekly window comes along when the log has it, so downtime can't use up the week", () => {
  const weekly = { type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 20, window_minutes: 300 }, secondary: { used_percent: 85, window_minutes: 10080, resets_at: 1790500000 } } } };
  const r = codexReading(JSON.stringify({ timestamp: '2026-09-29T11:59:00Z', ...weekly }), 0, 0, NOW)!;
  assert.equal(r.util, 0.2);
  assert.equal(r.week, 0.85);
  assert.equal(r.weekResets, 1790500000e3);
  const none = JSON.stringify({ timestamp: '2026-09-29T11:59:00Z', payload: { rate_limits: { primary: { used_percent: 20, window_minutes: 300 } } } });
  assert.equal(codexReading(none, 0, 0, NOW)!.week, undefined);
});

test("a plan that reports only the week: no 5-hour figure, and the week isn't read as one (2026-09-30)", () => {
  // Nib's #2601 on codex-1: the only window was the week, as primary, at 100%
  const real = JSON.stringify({ timestamp: '2026-09-30T13:42:10Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    limit_id: 'codex', primary: { used_percent: 100.0, window_minutes: 10080, resets_at: 1791052696 } } } });
  assert.deepEqual(codexReading(real, 0, 0, Date.parse('2026-09-30T13:43:00Z')),
    { at: Date.parse('2026-09-30T13:42:10Z'), week: 1, weekResets: 1791052696e3 });
  // a window of some other length is neither
  const odd = JSON.stringify({ timestamp: '2026-09-29T11:59:00Z', payload: { rate_limits: { primary: { used_percent: 50, window_minutes: 1440 } } } });
  assert.equal(codexReading(odd, 0, 0, NOW), undefined);
  // one that names no length is still taken for the 5-hour one, as before
  const bare = JSON.stringify({ timestamp: '2026-09-29T11:59:00Z', payload: { rate_limits: { primary: { used_percent: 50 } } } });
  assert.equal(codexReading(bare, 0, 0, NOW)!.util, 0.5);
  // measured by the week alone
  assert.equal(windowUsed({ resets: 0, week: 0.97, weekResets: NOW + 1 }, NOW), 0.97);
  assert.equal(windowUsed({ resets: 0, week: 0.97, weekResets: NOW }, NOW), 0);
});

test('a seat drains at 90% of either window, until that window resets', () => {
  const H = 3600e3;
  assert.equal(drainUntil({ resets: 0, weekResets: 0 }, NOW), 0, 'not measured');
  assert.equal(drainUntil({ util: 0.89, resets: NOW + H, week: 0.5, weekResets: NOW + 50 * H }, NOW), 0);
  assert.equal(drainUntil({ util: 0.9, resets: NOW + H, week: 0.5, weekResets: NOW + 50 * H }, NOW), NOW + H);
  assert.equal(drainUntil({ util: 0.2, resets: NOW + H, week: 0.92, weekResets: NOW + 50 * H }, NOW), NOW + 50 * H);
  // both full: the later reset, so a full week isn't taken back at the 5-hour reset
  assert.equal(drainUntil({ util: 0.95, resets: NOW + H, week: 0.92, weekResets: NOW + 50 * H }, NOW), NOW + 50 * H);
  // Codex on 2026-09-30: the week alone, at 100%, back on 3 October at 18:38 UTC
  assert.equal(drainUntil({ resets: 0, week: 1, weekResets: 1791052696e3 }, NOW), Date.parse('2026-10-03T18:38:16Z'));
  // a window that has reset since doesn't hold it; one with no known reset holds it for a recheck
  assert.equal(drainUntil({ util: 0.95, resets: NOW, week: 0.3, weekResets: NOW + H }, NOW), 0);
  assert.equal(drainUntil({ resets: 0, week: 0.95, weekResets: 0 }, NOW), NOW + DRAIN_RECHECK);
});

test("a seat's own drain level, and a week's reserve that shrinks in its last day", () => {
  const H = 3600e3;
  // a big plan's seat runs to its own level (SEATS' claude-1:claude:95)
  assert.equal(drainUntil({ util: 0.2, resets: NOW + H, week: 0.92, weekResets: NOW + 50 * H, drainAt: 0.95 }, NOW), 0);
  assert.equal(drainUntil({ util: 0.2, resets: NOW + H, week: 0.95, weekResets: NOW + 50 * H, drainAt: 0.95 }, NOW), NOW + 50 * H);
  // the week's last day: with 12 hours left half the reserve is kept, at the reset none
  assert.equal(drainLevel({ weekResets: NOW + 12 * H }, true, NOW), 0.95);
  assert.equal(drainLevel({ weekResets: NOW + 12 * H, drainAt: 0.95 }, true, NOW), 0.975);
  assert.equal(drainUntil({ resets: 0, week: 0.93, weekResets: NOW + 12 * H }, NOW), 0, 'the board, 14 Oct: the last 10% may go');
  assert.equal(drainUntil({ resets: 0, week: 0.96, weekResets: NOW + 12 * H }, NOW), NOW + 12 * H);
  // the 5-hour window keeps its level: it resets soon anyway
  assert.equal(drainLevel({ weekResets: NOW + 12 * H }, false, NOW), 0.9);
});

test("a seat ahead of its week's pace is paced until its weekly reset, once it would stop more than 3 hours early", () => {
  const H = 3600e3, D = 24 * H, at = (week: number, daysLeft: number) => pacedUntil({ week, weekResets: NOW + daysLeft * D }, 0.9, NOW);
  assert.equal(at(0.3, 6.5), undefined, 'not a day gone: no pace to go by');
  // three days gone, four to go, and the room to 88% (2 points under the stop) that has to last them
  assert.equal(at(0.37, 4), undefined, 'on pace: the room lasts past the reset');
  assert.equal(at(0.38, 4), undefined, 'out an hour early: not worth holding work back');
  assert.equal(at(0.4, 4), NOW + 4 * D, 'out some 10 hours early');
  assert.equal(at(0.5, 4), NOW + 4 * D);
  // a busy start that a quiet day evens out: 54% after four days is paced; 62% a day later, not
  assert.equal(at(0.54, 3), NOW + 3 * D);
  assert.equal(at(0.62, 2), undefined);
  // the week's last hours: 95% used with nine hours remaining on a 95% seat
  assert.equal(pacedUntil({ week: 0.95, weekResets: NOW + 9 * H }, 0.95, NOW), NOW + 9 * H);
  // a seat that runs to its limit while another keeps the reserve paces to its limit, not to 90%
  assert.equal(pacedUntil({ week: 0.85, weekResets: NOW + 24.5 * H }, 0.9, NOW), NOW + 24.5 * H);
  assert.equal(pacedUntil({ week: 0.85, weekResets: NOW + 24.5 * H }, 1, NOW), undefined);
  assert.equal(pacedUntil({ weekResets: NOW + 3 * D }, 0.9, NOW), undefined, 'the week not measured');
  // what it aims for: its drain level, its limit while another seat keeps the reserve, the same on credits, nothing off
  const seat = { resets: 0, week: 0.7, weekResets: NOW + 3 * D, drainAt: 0.95 };
  assert.deepEqual([paceTo(seat, true, false), paceTo(seat, true, true), paceTo({ ...seat, credits: true }, true, false), paceTo(seat, false, false)],
    [0.95, 1, 0.95, undefined]);
});

test("a paced seat's pacing lifts as an idle week goes on, before its reset, when the time left meets the stop its pace leads to", () => {
  const H = 3600e3, D = 24 * H, week = { week: 0.5, weekResets: NOW + 4 * D };
  assert.equal(pacedUntil(week, 0.9, NOW), NOW + 4 * D, 'half the week used with four days to go: paced');
  const lifts = paceChange(week, 0.9, NOW)!;
  assert.ok(lifts > NOW + 21 * H && lifts < NOW + 22 * H, `it lifts after some 22 hours, not at the reset (${(lifts - NOW) / H} h)`);
  assert.equal(pacedUntil(week, 0.9, lifts - 60_000), NOW + 4 * D);
  assert.equal(pacedUntil(week, 0.9, lifts + 60_000), undefined);
  assert.equal(paceChange(week, 0.9, lifts + 60_000), undefined, 'and with its use as it is, no pacing again');
  const late = { week: 0.8, weekResets: NOW + 48 * H }, lastDay = paceChange(late, 0.9, NOW)!;
  assert.ok(lastDay > NOW + 24 * H, "one that lifts in the week's last day, its reserve shrinking meanwhile");
  assert.equal(pacedUntil(late, 0.9, lastDay - 2000), late.weekResets);
  assert.equal(pacedUntil(late, 0.9, lastDay), undefined);
  assert.equal(paceChange({ week: 0.1, weekResets: NOW + 6.5 * D }, 0.9, NOW), NOW + 0.5 * D, 'once a day has gone it may start');
  assert.equal(paceChange(week, undefined, NOW), undefined, 'pacing off');
});

test('one seat of an engine keeps the reserve: the others run to their limit', () => {
  const H = 3600e3, seat = (engine: string, state: string, util?: number) => ({ engine, state, util, resets: NOW + H, weekResets: 0 });
  const full = seat('claude', 'ready', 0.95), other = seat('claude', 'ready', 0.5);
  assert.equal(reserveElsewhere(full, [full, other], NOW), true, 'the other one keeps it');
  assert.equal(reserveElsewhere(full, [full, seat('claude', 'ready', 0.92)], NOW), false, 'both past it: this one drains');
  assert.equal(reserveElsewhere(full, [full, seat('claude', 'sleeping', 0.1)], NOW), false, 'only a ready seat keeps it');
  assert.equal(reserveElsewhere(full, [full, seat('codex', 'ready', 0.1)], NOW), false, "another engine's doesn't count");
  assert.equal(reserveElsewhere(full, [full, seat('claude', 'ready')], NOW), false, 'nor one never measured');
  assert.equal(reserveElsewhere(full, [full], NOW), false, 'a lone seat drains as before');
  // a seat full for the week takes the reserve back once its last day's drain level rises past its use (drainLifts)
  const week = { engine: 'claude', state: 'ready', resets: 0, week: 0.95, weekResets: NOW + 20 * H }, lifts = drainLifts(week, NOW)!;
  assert.ok(lifts > NOW && lifts < week.weekResets);
  assert.equal(reserveElsewhere(full, [full, week], lifts - 1000), false, 'full for the week till then');
  assert.equal(reserveElsewhere(full, [full, week], lifts), true, 'under its level at the event');
  assert.equal(drainLifts({ ...week, week: 0.5 }, NOW), undefined, 'one under its level has nothing to lift');
});

test("a Codex seat with credits doesn't drain: past its limits it runs on them, and downtime still goes by the windows", () => {
  // (the reading as the worker keeps it on its seat: codexWindow)
  const full = (credits?: object) => { const r = codexReading(JSON.stringify({ timestamp: '2026-09-29T11:59:00Z', payload: { rate_limits: {
    primary: { used_percent: 100, window_minutes: 10080, resets_at: NOW / 1000 + 3600 }, ...(credits ? { credits } : {}) } } }), 0, 0, NOW)!;
    return { ...r, resets: r.resets ?? 0, weekResets: r.weekResets ?? 0 }; };
  assert.equal(full({ has_credits: true, unlimited: false, balance: '57000' }).credits, true);
  assert.equal(full({ has_credits: false, unlimited: true, balance: null }).credits, true);
  assert.equal(full({ has_credits: false, unlimited: false, balance: '0' }).credits, false);
  assert.equal(full().credits, undefined);
  assert.deepEqual([full({ has_credits: true, balance: '57000' }).creditsLeft, full({ unlimited: true, balance: null }).creditsLeft,
    full({ has_credits: true, balance: '1e9' }).creditsLeft], [57000, undefined, undefined]);
  assert.equal(drainUntil(full({ has_credits: true }), NOW), 0);
  assert.equal(drainUntil(full({ has_credits: false }), NOW), NOW + 3600e3);
  assert.equal(windowUsed(full({ has_credits: true }), NOW), 1);
});

test("a job's log can't drain a seat past its window's length: a later reset counts as unknown (PR #262 review)", () => {
  // the line Quill's review planted: 100% of the week until 2100, dated now
  const forged = JSON.stringify({ timestamp: '2026-09-29T12:00:00Z', payload: { rate_limits: {
    primary: { used_percent: 100, window_minutes: 10080, resets_at: 4102444800 } } } });
  const r = codexReading(forged, 0, 0, NOW)!;
  assert.deepEqual(r, { at: NOW, week: 1, weekResets: undefined });
  assert.equal(drainUntil({ resets: 0, ...r, weekResets: r.weekResets ?? 0 }, NOW), NOW + DRAIN_RECHECK, 'an hour, then measured again');
  // the 5-hour window's bound is 5 hours, and a window that names no length is held to that too
  const five = (minutes: object, ahead: number) => codexReading(JSON.stringify({ timestamp: '2026-09-29T12:00:00Z', payload: { rate_limits: {
    primary: { used_percent: 95, resets_at: NOW / 1000 + ahead, ...minutes } } } }), 0, 0, NOW)!.resets;
  assert.equal(five({ window_minutes: 300 }, 5 * 3600), NOW + 5 * 3600e3);
  assert.equal(five({ window_minutes: 300 }, 5 * 3600 + 1), undefined);
  assert.equal(five({}, 6 * 3600), undefined);
  // a real week's reset, days ahead, still counts
  const week = (ahead: number) => codexReading(JSON.stringify({ timestamp: '2026-09-29T12:00:00Z', payload: { rate_limits: {
    primary: { used_percent: 95, window_minutes: 10080, resets_at: NOW / 1000 + ahead } } } }), 0, 0, NOW)!.weekResets;
  assert.equal(week(4 * 86400), NOW + 4 * 86400e3);
  assert.equal(week(7 * 86400 + 1), undefined);
});

test('a limit never wakes a seat before the drain its windows call for (PR #262 review)', () => {
  // the week read full at the end of a run, then the run hits the limit: Codex's message names no reset
  const seat = { resets: 0, week: 1, weekResets: NOW + 50 * 3600e3 };
  const backoff = limitReset({ events: 3, cli: "You've hit your usage limit." }, '', 1, NOW);
  assert.equal(backoff, NOW + 30 * 60e3);
  assert.equal(sleepUntil(backoff, seat, NOW), NOW + 50 * 3600e3, 'the weekly reset, not 30 minutes');
  // with room in both windows, or a limit that names a later reset, the limit's own time
  assert.equal(sleepUntil(backoff, { util: 0.5, resets: NOW + 3600e3, week: 0.5, weekResets: NOW + 50 * 3600e3 }, NOW), backoff);
  assert.equal(sleepUntil(NOW + 60 * 3600e3, seat, NOW), NOW + 60 * 3600e3);
});

test("a held Codex seat lets one job through an hour, so a line a job planted can't keep it out", () => {
  const H = 3600e3, codex = (o: object) => ({ engine: 'codex', state: 'draining', until: NOW + 50 * H, checked: NOW - H, ...o });
  assert.equal(checkDue(codex({}), NOW), true);
  assert.equal(checkDue(codex({ checked: NOW - H + 1 }), NOW), false, 'within the hour of the last one, or of the hold starting');
  assert.equal(checkDue(codex({ state: 'sleeping' }), NOW), true, 'a sleep past the limit, too');
  assert.equal(checkDue(codex({ until: NOW }), NOW), false, 'a hold that has ended: the seat is ready again anyway');
  assert.equal(checkDue(codex({ state: 'ready' }), NOW), false);
  assert.equal(checkDue(codex({ state: 'login' }), NOW), false);
  assert.equal(checkDue(codex({ engine: 'claude' }), NOW), false, "Claude's readings are the CLI's own: recheckLoop");
  // a forged week, bounded to its 7 days, still lets the next job in within the hour
  const forged = codexReading(JSON.stringify({ timestamp: '2026-09-29T12:00:00Z', payload: { rate_limits: {
    primary: { used_percent: 100, window_minutes: 10080, resets_at: NOW / 1000 + 7 * 86400 } } } }), 0, 0, NOW)!;
  const until = drainUntil({ resets: 0, ...forged, weekResets: forged.weekResets ?? 0 }, NOW);
  assert.equal(until, NOW + 7 * 86400e3);
  assert.equal(checkDue(codex({ until, checked: NOW }), NOW + H - 1), false);
  assert.equal(checkDue(codex({ until, checked: NOW }), NOW + H), true);
});

test("the panel sees a held Codex seat as out only until its next check, so a normal round's review can be the check", () => {
  const H = 3600e3, seat = { engine: 'codex', state: 'draining', until: NOW + 50 * H, checked: NOW };
  assert.equal(reportedUntil(seat, NOW), NOW + H);
  assert.equal(reportedUntil({ ...seat, state: 'sleeping', checked: NOW - 2 * H }, NOW), NOW - H, 'due: out no longer');
  assert.equal(reportedUntil({ ...seat, until: NOW + H / 2 }, NOW), NOW + H / 2, 'a hold ending sooner than the check');
  assert.equal(reportedUntil({ ...seat, engine: 'claude' }, NOW), NOW + 50 * H);
  assert.equal(reportedUntil({ ...seat, state: 'ready', until: 0 }, NOW), 0);
});

test("a seat's window for downtime: the fuller of the 5-hour and the weekly one, each back to 0 once it resets", () => {
  assert.equal(windowUsed({ resets: 0, weekResets: 0 }, NOW), undefined, 'not measured yet');
  assert.equal(windowUsed({ util: 0.2, resets: 0, weekResets: 0 }, NOW), 0.2, 'no weekly figure yet');
  assert.equal(windowUsed({ util: 0.2, resets: 0, week: 0.85, weekResets: NOW + 1 }, NOW), 0.85);
  assert.equal(windowUsed({ util: 0.2, resets: 0, week: 0.85, weekResets: NOW }, NOW), 0.2, 'the week has reset');
  assert.equal(windowUsed({ util: 0.7, resets: NOW - 1, week: 0.1, weekResets: 0 }, NOW), 0.1, 'the 5 hours have reset');
});

test('a planted line: clamped, none dated ahead of now, and a timestamp that is no string never throws', () => {
  assert.equal(codexReading(line('2026-09-29T11:59:00Z', -50), 0, 0, NOW)?.util, 0);
  assert.equal(codexReading(line('2026-09-29T11:59:00Z', 900), 0, 0, NOW)?.util, 1);
  assert.equal(codexReading(line('2099-01-01T00:00:00Z', 0), 0, 0, NOW), undefined);
  // (Date.parse of an object whose toString is null throws: it would crash the worker from its measuring timer)
  for (const at of [{ toString: null }, 1790000000, null, ['2026-09-29T11:59:00Z']])
    assert.equal(codexReading(line(at as any, 10), 0, 0, NOW), undefined);
});

test("a probe's first reading at the start threshold holds its yield", () => {
  const y = new Map<number, Asked>();
  assert.equal(heard(y, 1, { yield: 'window' }, { first: true }), 'yielding');
  // the next heartbeat is held to the yield threshold only, and the seat is under it: still yielding
  assert.equal(heard(y, 1, { }, {}), undefined);
  assert.equal(y.get(1)?.why, 'window');
  // a job asked to yield for other work first, whose probe reading then comes in over the threshold, holds as well
  assert.equal(heard(y, 2, { yield: 'waiting' }, {}), 'yielding');
  heard(y, 2, { yield: 'window' }, { first: true });
  assert.equal(heard(y, 2, {}, {}), undefined);
  assert.ok(y.has(2));
});

test("a reined heartbeat's answer (its job past its share of HQ's time) leaves a window yield it heard as it was, and reads the rest", () => {
  const y = new Map<number, Asked>();
  heard(y, 1, { yield: 'window' }, {});
  assert.equal(heard(y, 1, { reined: true }, {}), undefined);
  assert.equal(y.get(1)?.why, 'window');
  assert.equal(heard(y, 1, { yield: 'paused' }, {}), undefined);
  assert.equal(y.get(1)?.why, 'paused');
  assert.equal(heard(y, 1, { reined: true }, {}), 'carrying on', 'the pause it heard is lifted');
  assert.equal(heard(y, 2, { reined: true }, {}), undefined);
});

test("other work waiting: a yield is cancelled once nothing waits, unless it's a held one", () => {
  const y = new Map<number, Asked>();
  heard(y, 1, { yield: 'waiting' }, {});
  assert.equal(heard(y, 1, { }, {}), 'carrying on');
  assert.equal(y.size, 0);
  heard(y, 3, { yield: 'window' }, {});   // a non-probe window yield: the seat's window reset
  assert.equal(heard(y, 3, {}, {}), 'carrying on');
});

test('every run selected by the coordinator yields', () => {
  const y = new Map<number, Asked>();
  for (const id of [1, 2, 3, 4]) assert.equal(heard(y, id, { yield: 'waiting' }, {}), 'yielding');
  assert.deepEqual([...y.keys()], [1, 2, 3, 4]);
});

test("a planted session log can't hang the worker: a newline-named file next to a FIFO, a FIFO alone, a huge line", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const who = { env: { PATH: process.env.PATH! } };
  const root = mkdtempSync(`${tmpdir()}/codexlog-`), timed = async (dir: string) => {
    const t = Date.now(), r = await codexLogLine(who, dir, 'sess', 2000);
    assert.ok(Date.now() - t < 4000, 'returns promptly');
    return r;
  };
  try {
    // Quill's case: `find | head -n 1` cut the name at its newline and opened the FIFO x-sess
    const a = `${root}/a`; mkdirSync(`${a}/x-sess\nrest`, { recursive: true });
    execFileSync('mkfifo', [`${a}/x-sess`]);
    writeFileSync(`${a}/x-sess\nrest/rollout-sess.jsonl`, `{"old":1}\n${line('2026-09-29T11:59:00Z', 42)}\nnot json\n`);
    assert.equal(await timed(a), line('2026-09-29T11:59:00Z', 42));
    // a FIFO under the log's own name is no regular file
    const b = `${root}/b`; mkdirSync(b); execFileSync('mkfifo', [`${b}/rollout-sess.jsonl`]);
    assert.equal(await timed(b), undefined);
    // one swapped in after find matched a regular file (a race; here a find that names it) is killed at the timeout,
    // tail and all
    const c = `${root}/c`; mkdirSync(`${c}/bin`, { recursive: true }); execFileSync('mkfifo', [`${c}/rollout-sess.jsonl`]);
    writeFileSync(`${c}/bin/find`, `#!/bin/sh\nprintf '%s\\0' "$1/rollout-sess.jsonl"\n`, { mode: 0o755 });
    const t = Date.now();
    assert.equal(await codexLogLine({ env: { PATH: `${c}/bin:${process.env.PATH}` } }, c, 'sess', 1000), undefined);
    assert.ok(Date.now() - t < 3000, 'returns at the timeout');
    // (tail's command line is the only one naming the FIFO; opening it to check would unblock tail itself)
    let reader = true;
    for (let i = 0; i < 20 && reader; i++) {
      try { execFileSync('pgrep', ['-f', '--', `${c}/rollout-sess.jsonl`]); await new Promise(r => setTimeout(r, 50)); }
      catch (err: any) { if (err.status === 1) reader = false; else throw err; }
    }
    assert.ok(!reader, 'the blocked tail was killed');
    // a line too long to hold is dropped, not buffered; no log at all is no reading
    const d = `${root}/d`; mkdirSync(d);
    writeFileSync(`${d}/rollout-sess.jsonl`, `{"rate_limits":{"x":"${'y'.repeat(3 * 2 ** 20)}"}}\n`);
    assert.equal(await timed(d), undefined);
    assert.equal(await timed(`${root}/none`), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the worker reads a Codex account itself through the app server, outside any job's home", async () => {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(`${tmpdir()}/codexlimits-`);
  try {
    // a fake codex: answers initialize and the read as the app server does, then stays up until it's ended
    const answer = '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":30,"windowDurationMins":10080,"resetsAt":1790000000},"secondary":null,"credits":{"hasCredits":false,"unlimited":false,"balance":"0"}}}}';
    const fake = (reply: string) => writeFileSync(`${root}/codex`, `#!/bin/sh
[ "$1" = app-server ] || exit 1
echo "$CODEX_HOME" > "${root}/home"
while read -r line; do
  case "$line" in *'"id":1'*) echo '{"id":1,"result":{}}' ;; *'"id":2'*) ${reply} ;; esac
done
sleep 60
`, { mode: 0o755 });
    const who = { env: { PATH: `${root}:${process.env.PATH}`, CODEX_HOME: `${root}/seat` } };
    fake(`echo '{"method":"configWarning","params":{}}'; printf '%s\\n' '${answer}'`);
    const t = Date.now();
    assert.deepEqual(await codexLimits(who, 5000), JSON.parse(answer).result);
    assert.ok(Date.now() - t < 4000, 'ended once it answered, not at the timeout');
    assert.equal(readFileSync(`${root}/home`, 'utf8').trim(), `${root}/seat`, "the seat's own folder is its home");
    fake(`echo '{"id":2,"error":{"code":-32600,"message":"codex account authentication required to read rate limits"}}'`);
    assert.equal(await codexLimits(who, 5000), undefined, 'an error is no reading');
    fake('true');
    assert.equal(await codexLimits(who, 500), undefined, 'nor is no answer in time');
    assert.equal(await codexLimits({ env: { PATH: '/nonexistent' } }, 500), undefined, 'nor no codex');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the account's read as a reading: its windows and credits as of now, as a session log's line gives them", () => {
  const H = 3600e3, read = (credits: object | null, secondary: object | null = null) => limitsReading({ rateLimits: {
    primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: (NOW + 50 * H) / 1000 }, secondary, credits } }, NOW);
  assert.deepEqual(read({ hasCredits: true, unlimited: false, balance: '500' }),
    { at: NOW, week: 1, weekResets: NOW + 50 * H, credits: true, creditsLeft: 500 });
  assert.deepEqual(read(null, { usedPercent: 40, windowDurationMins: 300, resetsAt: null }),
    { at: NOW, util: 0.4, resets: undefined, week: 1, weekResets: NOW + 50 * H }, 'no credits said, a reset unknown');
  assert.equal(limitsReading({ rateLimits: { primary: null, secondary: null } }, NOW), undefined);
  assert.equal(limitsReading(undefined, NOW), undefined);
});

test("with no seat to pick, the voice line's is the one that wakes first, not the first on the list", () => {
  const seats = [{ id: 'claude-1', state: 'sleeping', until: 2000 }, { id: 'claude-2', state: 'sleeping', until: 1000 }, { id: 'claude-3', state: 'login', until: 0 }];
  assert.equal(firstToWake(seats)?.id, 'claude-2');
  assert.equal(firstToWake(seats.filter(s => s.id !== 'claude-2'))?.id, 'claude-1');
  assert.equal(firstToWake([{ id: 'claude-3', state: 'login', until: 0 }]), undefined);   // signed out everywhere
});

const seat = (id: string, state: string, util?: number, engine = 'claude') => ({ id, engine, state, until: 0, util, resets: 0, weekResets: 0 });

test("jobs take a ready seat, least used; the board's own work may take a draining one, the reserve kept for it", () => {
  const seats = [seat('claude-1', 'sleeping', 1), seat('claude-2', 'draining', 0.92), seat('claude-3', 'ready', 0.5), seat('claude-4', 'ready', 0.2)];
  assert.equal(healthiest(seats, 'claude')?.id, 'claude-4');
  assert.equal(healthiest(seats, 'claude', false, seats[3])?.id, 'claude-3');   // (another seat than the one that hit the limit)
  assert.equal(healthiest(seats.slice(0, 2), 'claude'), undefined);              // a job waits: nothing ready
  assert.equal(healthiest(seats.slice(0, 2), 'claude', true)?.id, 'claude-2');   // the intercom doesn't
  assert.equal(healthiest([seat('claude-5', 'ready'), seat('claude-6', 'ready', 0.95)], 'claude')?.id, 'claude-6');   // unmeasured counts as full
});

test("the voice line takes a draining seat before one asleep at its limit, and the first to wake when that's all there is", () => {
  const asleep = { ...seat('claude-1', 'sleeping', 1), until: 5000 }, draining = seat('claude-2', 'draining', 0.93);
  assert.equal(lineSeat([asleep, draining, seat('codex-1', 'ready', 0, 'codex')])?.id, 'claude-2');
  assert.equal(lineSeat([asleep, seat('claude-3', 'ready', 0.4), draining])?.id, 'claude-3');   // (room before the reserve)
  assert.equal(lineSeat([asleep, { ...seat('claude-3', 'sleeping', 1), until: 3000 }, seat('codex-1', 'ready', 0, 'codex')])?.id, 'claude-3');
  assert.equal(lineSeat([seat('claude-1', 'login'), seat('codex-1', 'ready', 0, 'codex')]), undefined);
});

test("a Claude seat that drains pauses every job running on it but the intercom's; a Codex seat's run on", () => {
  const running = new Map([
    ['claude#1', { seat: 'claude-2', job: 11 }], ['claude#2', { seat: 'claude-1', job: 12 }],
    ['claude#chat', { seat: 'claude-2', job: 13 }], ['claude#3', { seat: 'claude-2', job: 14 }], ['codex#1', { seat: 'codex-1', job: 15 }]]);
  assert.deepEqual(drainPauses({ id: 'claude-2', engine: 'claude' }, running, 'claude#chat'), [11, 14]);
  assert.deepEqual(drainPauses({ id: 'codex-1', engine: 'codex' }, running, 'claude#chat'), []);
});

test("Codex slots take the ready Codex seats in turn, so each seat's share of the work gets claimed", () => {
  const one = seat('codex-1', 'ready', 0.1, 'codex'), two = seat('codex-2', 'ready', undefined, 'codex'), claude = seat('claude-1', 'ready', 0);
  const lastClaimAt = new Map<string, number>(), seats = [claude, one, two];
  assert.equal(inTurn(seats, lastClaimAt), one);   // (none has claimed yet: the list's order)
  lastClaimAt.set('codex-1', 1000);
  assert.equal(inTurn(seats, lastClaimAt), two, "an unmeasured seat isn't passed over as full");
  lastClaimAt.set('codex-2', 2000);
  assert.equal(inTurn(seats, lastClaimAt), one);
  // one that can't take work isn't picked, and its share waits for it: the other seat only ever claims its own (claim)
  one.state = 'sleeping';
  assert.equal(inTurn(seats, lastClaimAt), two);
  assert.equal(inTurn(seats, lastClaimAt, two), undefined);
  assert.equal(inTurn([claude], lastClaimAt), undefined);
});

test("a Codex log line says the tokens its session has written, when it has them", () => {
  const withInfo = (output_tokens: unknown) => JSON.stringify({ ...JSON.parse(line('2026-09-29T11:59:00Z', 42)),
    payload: { ...JSON.parse(line('2026-09-29T11:59:00Z', 42)).payload, info: { total_token_usage: { output_tokens } } } });
  assert.equal(codexTokens(withInfo(5120)), 5120);
  assert.equal(codexTokens(withInfo('5120')), undefined);
  assert.equal(codexTokens(line('2026-09-29T11:59:00Z', 42)), undefined);
  assert.equal(codexTokens('not json'), undefined);
});

test('a deadline heartbeat requests an immediate stop and can withdraw it when the waiter starts elsewhere', () => {
  const asked = new Map<number, Asked>();
  heard(asked, 8, { yield: 'waiting' }, {}, 10);
  assert.equal(asked.get(8)?.immediate, undefined);
  heard(asked, 8, { yield: 'waiting', immediate: true }, {}, 20);
  assert.equal(asked.get(8)?.immediate, true);
  assert.equal(asked.get(8)?.at, 10);
  heard(asked, 8, {}, {}, 30);
  assert.equal(asked.has(8), false);
});
