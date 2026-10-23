// A meeting's seats (meetings.ts): started together by the claim (pick), briefed as they start, the lines said in the
// meeting, the chair's view of its progress, and its end.
import { db, takeBack } from './db.ts';
export { sittingIn } from './db.ts';
import { publish } from './events.ts';
import { ceo, projects } from './company.ts';
import { lastPlayed } from './forecast.ts';
import { chair, outlooks, post, progress, tally, type Tally } from './meetingchair.ts';
import { findAgent, seatReadyFor } from './jobs.ts';
import { listThreads } from './projects.ts';
import { oneLine } from './agreements.ts';
import { OFFER_AGAIN } from './messages.ts';
import { endedEmpty } from './threadends.ts';
import {
  agenda,
  asksOf,
  holdsCustomers,
  meeting,
  seatOfJob,
  seats,
  stillIn,
  type Line,
  type Meeting,
  type Seat,
} from './meetings.ts';

export const HOLD_MS = 10 * 60_000;
export const REST_MS = 5 * 60_000;

// ---- starting together

// The claim's pick (jobs.ts claim) from its candidates in the claim's order: the job to start, or null to start nothing
// and hold this slot for a meeting (the claim answers `held`, and the worker keeps the slot's room and seat place for it:
// holding). A hold is on the seat the slot claims on (its runner), and lasts while that seat is ready for it (dropStale):
// one that hits its limit, drains, signs out, is paused or is paced while the seat can wait for its weekly reset loses
// it, and the slot claiming on another seat does too. A slot holding a seat starts it once every seat of its meeting is
// held on a ready runner (the meeting goes live), and holds on until then; the meeting lets all its slots go after
// HOLD_MS, or as soon as a seat no slot holds has no ready seat to run on. Else the first candidate: a seat of a planned
// meeting is held
// (and starts if it was the last one) when the claim's own seat is ready for it and every other seat has a ready seat to
// run on; held by another slot, or its meeting resting, it's passed over. A seat of a live meeting starts at once (one
// added late). Without a slot name (an older worker) seats are passed over.
export function pick<T extends { id: number }>(
  sorted: T[],
  slot: string | undefined,
  seat: string,
  now = Date.now(),
): T | null | undefined {
  const held = slot ? holdOf(slot) : undefined;
  if (held && (held.runner !== seat || !seatReadyFor(held.job, now, seat))) release(held.job);
  const mine = held && holdOf(slot!);
  if (mine) {
    const m = meeting(mine.meeting)!,
      own = sorted.find(c => c.id === mine.job);
    if (!own) release(mine.job);
    else if (m.status === 'live') return started(own);
    else if (now - (m.gathering ?? now) >= HOLD_MS || !runnable(m.id, now)) letGo(m.id, now);
    else return complete(m.id, now) ? started(own) : null;
  }
  for (const c of sorted) {
    const s = seatOfJob(c.id);
    if (!s) return c;
    const m = meeting(s.meeting)!;
    if (m.status === 'live') return started(c);
    if (s.slot || !slot || (m.rests ?? 0) > now || !seatReadyFor(c.id, now, seat)) continue;
    if (!runnable(m.id, now)) {
      letGo(m.id, now);
      continue;
    }
    db.prepare('update meeting_seats set slot = ?, runner = ? where job = ?').run(slot, seat, c.id);
    db.prepare('update meetings set gathering = coalesce(gathering, ?) where id = ?').run(now, m.id);
    return complete(m.id, now) ? started(c) : null;
  }
  return undefined;
}

// The queued seat a slot holds, if any
const holdOf = (slot: string) =>
  db
    .prepare("select s.* from meeting_seats s join jobs j on j.id = s.job where s.slot = ? and j.status = 'queued'")
    .get(slot) as Seat | undefined;

// The claim's answer to a slot that starts nothing because it holds a seat (server.ts): the worker keeps its room
export function holding(slot: unknown) {
  const s = typeof slot === 'string' ? holdOf(slot) : undefined;
  return s ? { held: { meeting: s.meeting, job: s.job } } : null;
}

// Every seat of a meeting can start now: held ones on their runner (dropStale lets go of the rest), and every other has a
// ready seat to run on (jobs.ts seatReadyFor).
function runnable(id: number, now: number) {
  dropStale(id, now);
  return seats(id).every(s => s.slot !== null || !queued(s.job) || seatReadyFor(s.job, now));
}

// The holds of a meeting whose runner can't take its seat now (HQ heard it hit its limit, drain, sign out, be paused or
// be paced while the seat can wait for its weekly reset): the holding slot's next claim answers no `held`, and the worker
// gives its room and the seat's place back.
function dropStale(id: number, now: number) {
  for (const s of seats(id)) if (s.slot !== null && !seatReadyFor(s.job, now, s.runner)) release(s.job);
}
const release = (job: number) =>
  db.prepare('update meeting_seats set slot = null, runner = null where job = ?').run(job);
const queued = (job: number) => !!db.prepare("select 1 from jobs where id = ? and status = 'queued'").get(job);

// Every queued seat held: the meeting goes live, and the slots holding the others start theirs at their next claim.
function complete(id: number, now: number) {
  const open = db
    .prepare(
      "select count(*) n from meeting_seats s join jobs j on j.id = s.job where s.meeting = ? and j.status = 'queued' and s.slot is null",
    )
    .get(id) as { n: number };
  if (open.n) return false;
  // (before: how its threads and the windowed ones stood as it went live, which its tally compares with.)
  db.prepare(
    "update meetings set status = 'live', started = ?, gathering = null, before = ? where id = ? and status = 'planned'",
  ).run(new Date(now).toISOString(), JSON.stringify(outlooks(id, lastPlayed())), id);
  publish({ type: 'log', agent: meeting(id)!.called_by, text: `Meeting #${id} starts: ${meeting(id)!.topic}` });
  return true;
}

const started = <T extends { id: number }>(c: T) => {
  release(c.id);
  db.prepare('update jobs set prompt = ? where id = ?').run(briefing(c.id), c.id);
  return c;
};

function letGo(id: number, now: number) {
  db.prepare('update meeting_seats set slot = null, runner = null where meeting = ?').run(id);
  db.prepare('update meetings set gathering = null, rests = ? where id = ?').run(now + REST_MS, id);
}

// ---- the seat's briefing

// The topic, who's there and why (the asks, or the schedule's brief), and the plans of the projects its agents own.
export function briefing(job: number) {
  const s = seatOfJob(job)!,
    m = meeting(s.meeting)!,
    all = seats(m.id);
  const name = (id: string) => {
    const agent = findAgent(id);
    return `${agent?.name ?? id} (${[id, agent?.role].filter(Boolean).join(', ')})`;
  };
  const asks = asksOf(m.id);
  const why = asks.length ? asks.map(a => `- ${agenda(a)}`).join('\n') : (m.brief ?? `Set by ${m.called_by}.`);
  const owned = projects().list.filter(p => all.some(x => x.agent === p.owner));
  const plans = owned.map(p => {
    const threads = listThreads({ project: p.id });
    return `${p.name} (${p.id}), ${p.owner}'s:${threads.length ? '' : ' no open threads'}\n${threads
      .map(t => `  - ${t.id}: ${t.name}, done when ${t.goal} (${t.open} open jobs: hq thread ${t.id})`)
      .join('\n')}`;
  });
  return `Meeting #${m.id}: ${m.topic}

Who's there: ${all.map(x => name(x.agent)).join(', ')}. ${name(ceo())} chairs it. It has no time limit, and nobody leaves
early: it ends when the chair closes it.

Why:
${why}

The plans of the projects its agents own, as they stand now:
${plans.length ? plans.join('\n') : '(none of them owns a project)'}${s.agent === ceo() ? `\n\n${chair()}` : ''}`;
}

// ---- in the meeting
// Nobody leaves a meeting early. A seat changes its own plans, then hands them in with a line of what
// it changed (hq meeting hand-in), and stays: handed in, it hears only the lines said to it (hq meeting say --to). Feedback
// or a question it answers with a change takes its hand-in back (hq meeting withdraw, or any plan change it makes), and it
// hands in again. Once every seat has handed in and the sizes of the work in the meeting's projects have settled, the
// tally plays the queue with the combined changes (sweep). The chair reviews the whole against it, sends changes back
// (hq meeting reopen) or closes the meeting with its summary for the news feed (hq meeting close).

const liveSeat = (job: number): (Seat & { m: Meeting }) | string => {
  const s = seatOfJob(job);
  if (!s) return "this job isn't a seat in a meeting";
  const customers = holdsCustomers(job);
  if (customers) return customers;
  const m = meeting(s.meeting)!;
  if (m.status !== 'live') return `meeting #${m.id} is ${m.status}`;
  return { ...s, m };
};

// The seats that hand in: every one in it but the chair's
const handing = (id: number) => stillIn(id).filter(x => x.agent !== ceo());

// hq meeting say: a line to everyone in the meeting; --to names the seats it's for, which hear it even handed in.
export function say(job: number, text: unknown, to?: unknown, now = Date.now()) {
  const s = liveSeat(job);
  if (typeof s === 'string') return s;
  const said = String(text ?? '').trim();
  if (!said) return 'say something: an empty line';
  const named = Array.isArray(to) ? [...new Set(to.map(String))] : [];
  const here = seats(s.meeting).map(x => x.agent);
  const stranger = named.find(a => a === s.agent || !here.includes(a));
  if (stranger) return `${stranger} isn't another seat in meeting #${s.meeting}: ${here.join(', ')}`;
  const { lastInsertRowid } = db
    .prepare('insert into meeting_lines (meeting, at, agent, text, tagged) values (?, ?, ?, ?, ?)')
    .run(s.meeting, new Date(now).toISOString(), s.agent, said, named.length ? JSON.stringify(named) : null);
  return { line: Number(lastInsertRowid) };
}

// The others' lines this seat hasn't read: while it's handed in, only those said to it. They're marked read only once
// its session has them (read): listen's hq and the inbox hook say so after printing them, so a lost answer loses no line.
const unread = (s: Seat, after = s.read) =>
  (
    db
      .prepare('select * from meeting_lines where meeting = ? and id > ? and agent != ? order by id')
      .all(s.meeting, after, s.agent) as Line[]
  )
    .map(l => ({ id: l.id, at: l.at, agent: l.agent, text: l.text, to: tags(l) }))
    .filter(l => !s.handed || l.to.includes(s.agent));
const tags = (l: Line) => (l.tagged ? (JSON.parse(l.tagged) as string[]) : []);

// The inbox hook's meeting lines (server.ts, beside messages.take): the seat's unread lines while its meeting is live,
// one batch at a time: a later step's hook gets an unconfirmed batch again after OFFER_AGAIN.
export function take(job: number, now = Date.now()) {
  const s = seatOfJob(job);
  if (!s || meeting(s.meeting)!.status !== 'live') return [];
  const fresh = s.offered_at !== null && now - s.offered_at < OFFER_AGAIN;
  if (fresh && s.offered > s.read) return [];
  const lines = unread(s);
  if (lines.length)
    db.prepare('update meeting_seats set offered = ?, offered_at = ? where job = ?').run(lines.at(-1)!.id, now, job);
  return lines.map(l => ({
    meeting: s.meeting,
    line: l.id,
    from: l.agent,
    ...(l.to.length && { to: l.to }),
    sent: l.at,
    text: l.text,
  }));
}

// The lines a seat's session has now (inbox-ack, hq meeting listen's after printing): read up to the last of them.
export function read(job: number, lines: unknown) {
  const s = seatOfJob(job);
  if (!s || !Array.isArray(lines)) return 400;
  const last = Math.max(0, ...lines.map(Number).filter(Number.isInteger));
  const mine = db.prepare('select 1 from meeting_lines where id = ? and meeting = ?').get(last, s.meeting);
  if (mine) db.prepare('update meeting_seats set read = ? where job = ? and read < ?').run(last, job, last);
  return { read: Math.max(s.read, mine ? last : 0) };
}

// hq meeting listen: the lines since this seat last read, who's in it (the chair, who has handed in what), and for the
// chair the meeting's progress and its tally. It answers at once: hq waits by asking again (a request held open would
// read as the server held in latency.ts), and says which it printed (read).
export function listen(job: number) {
  const s = seatOfJob(job);
  if (!s) return "this job isn't a seat in a meeting";
  const m = meeting(s.meeting)!;
  const chair = ceo();
  return {
    meeting: m.id,
    status: m.status,
    you: { agent: s.agent, chair: s.agent === chair, handed: !!s.handed },
    lines: m.status === 'live' ? unread(s) : [],
    seats: stillIn(m.id).map(x => ({
      agent: x.agent,
      chair: x.agent === chair,
      handed: !!x.handed,
      changed: x.changed,
    })),
    ...(s.agent === chair &&
      m.status === 'live' && { progress: progress(m), tally: m.tally ? (JSON.parse(m.tally) as Tally) : null }),
  };
}

// hq meeting hand-in: this seat's plan changes are in, with a line of what it changed. It stays in the meeting.
export function handIn(job: number, changed: unknown, now = Date.now()) {
  const s = liveSeat(job);
  if (typeof s === 'string') return s;
  if (s.agent === ceo()) return 'you chair this meeting: once everyone has handed in, review the tally and close it';
  const said = oneLine(String(changed ?? ''));
  if (!said) return 'say what you changed in a line ("nothing" is a line)';
  db.prepare('update meeting_seats set handed = ?, changed = ?, handed_read = read where job = ?').run(
    new Date(now).toISOString(),
    said,
    job,
  );
  return {
    waiting: handing(s.meeting)
      .filter(x => !x.handed && x.job !== job)
      .map(x => x.agent),
  };
}

// hq meeting withdraw: this seat takes its hand-in back to change more (a plan change it makes does the same: db.ts)
export function withdraw(job: number) {
  const s = liveSeat(job);
  if (typeof s === 'string') return s;
  if (!s.handed) return "you haven't handed in: change your plans, then hq meeting hand-in";
  takeBack(s.meeting, s.agent);
  return { ok: true as const };
}

// hq meeting reopen: the chair sends changes back to those seats, what to change said to them; their hand-ins reopen.
export function reopen(job: number, agents: unknown, text: unknown, now = Date.now()) {
  const s = liveSeat(job);
  if (typeof s === 'string') return s;
  if (s.agent !== ceo()) return `only the chair (${ceo()}) sends changes back: say it to them (hq meeting say --to)`;
  const named = Array.isArray(agents) ? [...new Set(agents.map(String))] : [];
  if (!named.length) return 'name the seats whose changes go back';
  const said = say(job, text, named, now);
  if (typeof said === 'string') return said;
  for (const x of seats(s.meeting)) if (named.includes(x.agent) && x.handed) takeBack(x.meeting, x.agent);
  return said;
}

// ---- the end

// hq meeting close: the chair ends the meeting with its post for the news feed, in its own words and in parts: a headline,
// an opening, each project's decisions, the next step (meetingchair.ts post lays them out). After the tally; before it
// only when the chair judges the meeting has stalled. Seats still in it stop at their next step. (The post's parts)
export function close(job: number, given: Record<string, unknown>, stalled: unknown, now = Date.now()) {
  const s = liveSeat(job);
  if (typeof s === 'string') return s;
  if (s.agent !== ceo())
    return `only the chair (${ceo()}) closes the meeting: hand in your changes (hq meeting hand-in)`;
  const laid = post(given);
  if (typeof laid === 'string') return laid;
  const tally = s.m.tally ? (JSON.parse(s.m.tally) as Tally) : null;
  const tallied = tally !== null && 'at' in tally;
  if (!tallied && stalled !== true) {
    const out = handing(s.meeting)
      .filter(x => !x.handed)
      .map(x => x.agent);
    const failed = tally && 'waiting' in tally ? tally.waiting.filter(w => w.failed).map(w => `#${w.job}`) : [];
    return out.length
      ? `not everyone has handed in (${out.join(', ')}): wait, or close it as stalled (hq meeting close --stalled)`
      : failed.length
        ? `the tally waits for sizes the sizer couldn't give (${failed.join(', ')}): their owners set them (hq estimate set), or close it as stalled (--stalled)`
        : "the tally hasn't run yet (it waits for the sizes to settle): wait, or close it as stalled (--stalled)";
  }
  db.prepare('update meetings set summary = ?, headline = ? where id = ?').run(laid.summary, laid.headline, s.meeting);
  end(s.meeting, stalled === true ? 'the chair closed it as stalled' : 'the chair closed it', now);
  return { ended: true as const };
}

// A meeting ends: seats still in it stop at their next step, seats that never started are cancelled. HQ's one-task
// thread the seats share (a routine's run) ends once none of them is open (threadends.ts endedEmpty: a seat that stops
// ends it as it ends.).
function end(id: number, why: string, now = Date.now()) {
  if (
    !db
      .prepare("update meetings set status = 'done', ended = ?, why = ? where id = ? and status != 'done'")
      .run(new Date(now).toISOString(), why, id).changes
  )
    return;
  for (const s of seats(id)) {
    db.prepare("update jobs set stopping = ? where id = ? and status = 'running'").run(
      `HQ: meeting #${id} ended (${why})`,
      s.job,
    );
    db.prepare("update jobs set status = 'cancelled', result = ?, finished = ? where id = ? and status = 'queued'").run(
      `Cancelled: meeting #${id} ended (${why})`,
      new Date(now).toISOString(),
      s.job,
    );
  }
  publish({ type: 'log', agent: meeting(id)!.called_by, text: `Meeting #${id} ended (${why})` });
  const threads = db
    .prepare(
      'select distinct thread from jobs where thread is not null and id in (select job from meeting_seats where meeting = ?)',
    )
    .all(id) as { thread: string }[];
  for (const { thread } of threads) endedEmpty(thread);
}

// Every minute (server.ts): the tally of a meeting every seat has handed in, and the ends no chair can close any more.
// No time limit ends a meeting, only its chair (close). A live one ends without it only once its chair's seat ended, or
// every seat did; a planned one all of whose seats were cancelled ends too.
export function sweep(now = Date.now()) {
  for (const m of db.prepare("select * from meetings where status in ('planned', 'live')").all() as Meeting[]) {
    const present = stillIn(m.id);
    const chairGone =
      m.status === 'live' && seats(m.id).some(s => s.agent === ceo()) && !present.some(s => s.agent === ceo());
    if (!present.length) end(m.id, m.status === 'live' ? 'every seat ended' : 'its seats were cancelled', now);
    else if (chairGone) end(m.id, "its chair's session ended", now);
    else if (m.status === 'live') {
      const due = handing(m.id).length > 0 && handing(m.id).every(s => s.handed);
      const done = m.tally && 'at' in (JSON.parse(m.tally) as Tally);
      if (due && !done)
        db.prepare('update meetings set tally = ? where id = ?').run(JSON.stringify(tally(m, now)), m.id);
    } else if (m.gathering !== null && now - m.gathering >= HOLD_MS) letGo(m.id, now);
  }
}
