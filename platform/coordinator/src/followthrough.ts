// The CEO's hourly follow-through check, its heartbeat: while the board has agreements from its calls that still stand, or
// the CEO's summary (summary.ts) has something to look at (an open goal always has), HQ queues the CEO a short check with the summary in it that sets them
// against the work actually running, to make sure work gets done, and alarms when a check doesn't start, finish or say: the Process team gets a job to
// mend it. It's the one way HQ's picture reaches the CEO: nothing else makes a job of a slip, a stall or a wait.
// A check found on track can name its next look, the CEO's judgment: until then HQ queues none, unless the summary gets a
// new line.
import { db, inOneStep, remember, setting } from './db.ts';
import { publish } from './events.ts';
import * as jobs from './jobs.ts';
import { STANDING } from './jobcodes.ts';
import { agreements, agreedPart, itemWords, oneLine, type OpenByID } from './agreements.ts';
import * as pauses from './pauses.ts';
import { ceo, roles } from './company.ts';
import * as forecast from './forecast.ts';
import * as summary from './summary.ts';
import { checkPrompt } from './heartbeat.ts';
import { made, madeCode } from './made.ts'; // (madeCode)
import { parse as parseTime } from './windows.ts';

export const START_MS = 15 * 60_000,
  FINISH_MS = 45 * 60_000,
  RETELL_MS = 3 * 3_600_000;
export const SAID_MAX = 200;
export const LONG_LINE = `keep it to one line of up to ${SAID_MAX} characters`;
const READY_SHOWN = 15;
const ALARM = 'followthrough.alarm';

export type Verdict = 'ok' | 'acted';
type Check = {
  slot: string;
  job: number;
  created: string;
  verdict: Verdict | null;
  said: string | null;
  seen: string | null;
  next: string | null;
  compared: string | null;
};
type Problem = { kind: 'not started' | 'overran' | 'no verdict'; line: string };
// since: when the checks stopped working (the first alarm since the last verdict); told: the Process team's job about it
type Alarm = Problem & { slot: string; since: string; told?: number; toldAt?: string; carded?: number };

// Every minute: the check due this hour, and the last one watched until it records its verdict.
export function followThroughSweep(t = Date.now()) {
  if (jobs.paused()) {
    restartClock(t);
    return;
  }
  // (its seats all at their limits or pace: a repair job would wait on them)
  const last = lastCheck();
  if (last && !last.verdict && jobs.seatsOut(last.job, t)) restartClock(t);
  // (an open pause is checked as an agreement is)
  const open = stillOpen(t);
  const slot = new Date(t).toISOString().slice(0, 13);
  const hourFree = !open && !findCheck(slot);
  // (waiting: the check whose named next look hasn't come yet. Until it has, the summary is compared (compares) with the
  // one it was queued with once an hour, and only a line new since then brings the check forward. An acted check, or one
  // that said no time, gets the next hour's.)
  const waiting = hourFree && last?.verdict === 'ok' && last.next && t < Date.parse(last.next) ? last : undefined;
  const compares = hourFree && waiting?.compared !== slot;
  const standing = agreements().length > 0 || pauses.anyOpen();
  // (the summary is read only where it decides: for the hour's check to queue, once an hour while a check waits for its
  // next look, or, with nothing else standing, whether a check that ended without its verdict is still watched.)
  const picture =
    compares || (!standing && !open && last && !last.verdict) ? summary.read(forecast.current(t)) : undefined;
  if (waiting && compares)
    db.prepare('update followthrough_checks set compared = ? where job = ?').run(slot, waiting.job);
  const due = !!picture && compares && (!waiting || newLine(picture.looks, waiting));
  if (!standing && !open && !picture?.worth) {
    remember(ALARM, null);
    return;
  }
  watch(t);
  if (!due || !picture) return;
  // (on a one-task thread whose window ends with the hour it's for, in one step with it: made.ts made.)
  inOneStep(() => {
    const { id } = jobs.createJob({
      agent: ceo(),
      code: madeCode('checks', 'hq', STANDING.followThrough), // (each hour's: its task code, made.ts.)
      title: `Follow-through check (${slot.slice(11)}:00 UTC)`,
      prompt: `${checkPrompt()}\n\nThe summary as this check was queued (\`hq summary\` reads it as it is now):\n\n${picture.text}`,
      effort: 'medium',
      check: true,
    });
    made('checks', 'hq', { id }, hourEnd(Date.parse(`${slot}:00Z`)));
    db.prepare('insert into followthrough_checks (slot, job, created, seen) values (?, ?, ?, ?)').run(
      slot,
      id,
      new Date(t).toISOString(),
      JSON.stringify(substance(picture.looks)),
    );
  });
}

// The summary's lines for the CEO to look at (summary.ts looks) with their numbers masked (ages, times, spans, counts,
// percents: all but #ids; "1 h 20 min" is one), so a line that only aged or ticked on is the same line, and a new one is
// new work to look at.
const substance = (looks: string[]) => [
  ...new Set(
    looks.map(line =>
      line
        .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?=\d)/g, '')
        .replace(/(?<![#\w-])\d+(?:[.:,/-]\d+)*(?:\s?(?:min|h|d|s|[AP]M)\b|%)?/g, '…')
        .replace(/…(?: …)+/g, '…'),
    ),
  ),
];
const newLine = (looks: string[], since: Check) => {
  const seen = new Set(JSON.parse(since.seen ?? '[]') as string[]);
  return substance(looks).some(line => !seen.has(line));
};

// hq followthrough ok [--next <when>] | acted "line": the running check's verdict. Only a check records one, once.
// `next`: when an on-track check says the next look is worth it (windows.ts parse reads it).
export function recordVerdict(job: number, verdict: Verdict, said: string, next = '', now = Date.now()) {
  const check = db.prepare('select * from followthrough_checks where job = ?').get(job) as Check | undefined;
  if (!check) return "only HQ's follow-through check records a verdict, and this job isn't one";
  if (check.verdict) return `this check already recorded "${check.verdict}"`;
  const line = oneLine(said);
  if (verdict === 'acted' && !line)
    return 'say in one line what was off and what you did: hq followthrough acted "..."';
  if (line.length > SAID_MAX) return LONG_LINE;
  if (next && verdict === 'acted') return "an acted check gets the next hour's look: --next goes with ok";
  const at = next ? parseTime(next, now, false, 'the next look') : null;
  if (typeof at === 'string') return at;
  // (one check an hour: a look inside this check's own hour couldn't queue before the next)
  const earliest = hourEnd(Date.parse(`${check.slot}:00Z`)).deadline;
  if (at !== null && at < earliest)
    return `the next look can't fall inside this check's own hour: the earliest is ${new Date(earliest).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  db.prepare('update followthrough_checks set verdict = ?, said = ?, at = ?, next = ? where job = ?').run(
    verdict,
    line || null,
    new Date(now).toISOString(),
    at === null ? null : new Date(at).toISOString(),
    job,
  );
  remember(ALARM, null);
  return { ok: true, ...(at !== null && { next: new Date(at).toISOString() }) };
}

// A check that hasn't recorded its verdict yet: only that one hands failed work back (takeover.ts).
export const checkUnderWay = (job: number) =>
  !!db.prepare('select 1 from followthrough_checks where job = ? and verdict is null').get(job);

// hq followthrough, for the CEO's job `reader`: the board's words only from a call hq call would show it.
export function read(reader: jobs.Reader) {
  const open = new Map(jobs.openJobs({ except: reader.id }).map(j => [j.id, j]));
  const last = db
    .prepare('select * from followthrough_checks where job != ? order by created desc limit 1')
    .get(reader.id) as Check | undefined;
  const parts = [pausesPart(open, reader), agreedPart(open, reader), runningPart(open, last), readyPart(open)];
  return [...parts, lastPart(last)].join('\n\n');
}

// ---- watching the checks

// A check that hasn't started, runs on past FINISH_MS or ended without a verdict is an alarm on HQ's feed and in the
// status report until a later check records one, and a job for the Process team to mend it: one while it's open, and
// another every RETELL_MS the checks stay broken after it ended. Persistent failures reach the desk phone without a
// worker. One that runs on is stopped, so the next hour's can start.
function watch(t: number) {
  const last = lastCheck();
  if (!last || last.verdict) return;
  let problem = problemOf(last, t);
  if (!problem) return;
  const queuedOverrun =
    problem.kind === 'overran' && db.prepare("select 1 from jobs where id = ? and status = 'queued'").get(last.job);
  if (queuedOverrun) {
    jobs.finish(last.job, { status: 'failed', result: problem.line });
    problem = problemOf(last, t)!;
  }
  const before = currentAlarm();
  const alarm: Alarm = {
    ...problem,
    slot: last.slot,
    since: before?.since ?? new Date(t).toISOString(),
    told: before?.told,
    toldAt: before?.toldAt,
    carded: before?.carded,
  };
  if (before?.slot !== last.slot || before.kind !== problem.kind) {
    publish({ type: 'log', agent: ceo(), text: problem.line });
    if (problem.kind === 'overran')
      jobs.stopJob(last.job, ceo(), `the follow-through check is a short read: ${problem.line}`);
  }
  if (!alarm.told || (t - Date.parse(alarm.toldAt!) >= RETELL_MS && !stillWorking(alarm.told))) {
    alarm.told = tellProcess(alarm, t);
    alarm.toldAt = new Date(t).toISOString();
  }
  if (!alarm.carded && t - Date.parse(alarm.since) >= RETELL_MS) {
    const hours = brokenHours(alarm, t);
    const card = jobs.createRequest({
      kind: 'decision',
      urgency: 'today',
      agent: roles().process,
      title: 'The hourly agreement checks need help',
      body:
        `HQ's hourly check of what you agreed on calls has not reported back for ${hours} h. ` +
        `The Process team has a repair job, but the checks still need help.\n\nChoose:\n` +
        `- Let the Process team repair the checks (recommended): your answer goes to that team.\n` +
        `- Something else: say what you want the team to do.`,
    });
    if (typeof card !== 'number') alarm.carded = card.id;
  }
  remember(ALARM, JSON.stringify(alarm));
}

const brokenHours = (alarm: Alarm, t: number) => Math.floor((t - Date.parse(alarm.since)) / 3_600_000);

const stillWorking = (job: number) =>
  !!db.prepare("select 1 from jobs where id = ? and status in ('queued', 'running', 'blocked')").get(job);

// The Process team's repair job, due by the end of the hour it's made in, in one step with its thread (made.ts made).
function tellProcess(alarm: Alarm, t: number) {
  const hours = brokenHours(alarm, t);
  const again = alarm.told
    ? `\n\nThe checks have been broken for ${hours} h, and job #${alarm.told} about it ended without mending them. If you can't ` +
      `mend it in this job, put it on the desk phone: the board's agreements go unchecked meanwhile.`
    : '';
  return inOneStep(() => {
    const { id } = jobs.createJob({
      agent: roles().process,
      code: madeCode('checks', 'hq', STANDING.checksBroken), // (its task code, made.ts.)
      title: `The CEO's hourly follow-through check isn't working (${alarm.kind})`,
      prompt:
        `${alarm.line}. Until a check records its verdict, nobody compares what the board agreed with the work that runs.` +
        `${again}\n\nFind why and mend the cause, not the one check: ` +
        `a check that doesn't start is a claim that never takes it (the CEO's seat and engine, the worker's room (below ` +
        `its room line a job starts only when its measured memory fits), the status report's worker lines); one that ` +
        `runs on or ends without a verdict is the CEO's session (its log: does \`hq followthrough\` answer, does the ` +
        `verdict record). The next hour's check queues by itself once this one has ended, and its verdict clears the alarm.`,
    });
    return made('checks', 'hq', { id }, hourEnd(t));
  });
}

// A window ending with the hour `t` is in
const hourEnd = (t: number) => {
  const end = Math.floor(t / 3_600_000) * 3_600_000 + 3_600_000;
  return { deadline: end, aim: end };
};

function problemOf(check: Check, t: number): Problem | null {
  const job = db.prepare('select status, started from jobs where id = ?').get(check.job) as
    { status: string; started: string | null } | undefined;
  const named = `The follow-through check for ${check.slot.slice(11)}:00 UTC (#${check.job})`;
  const minutes = (since: string) => Math.round((t - Date.parse(since)) / 60_000);
  if (job?.status === 'queued' && !job.started)
    return t - Date.parse(check.created) < START_MS
      ? null
      : { kind: 'not started', line: `${named} hasn't started ${minutes(check.created)} min after it was queued` };
  if (job?.status === 'running' || job?.status === 'queued') {
    const since = job.started && job.started > check.created ? job.started : check.created;
    return t - Date.parse(since) < FINISH_MS
      ? null
      : { kind: 'overran', line: `${named} has run ${minutes(since)} min without a verdict` };
  }
  return { kind: 'no verdict', line: `${named} ended (${job?.status ?? 'gone'}) without a verdict` };
}

// A queued check's clock starts again while work is paused or its seats are out, including one paused mid-session; one
// already told to stop keeps its clock, so its overrun still expires it.
const restartClock = (t: number) =>
  db
    .prepare(
      `update followthrough_checks set created = ? where verdict is null
      and job in (select id from jobs where status = 'queued' and stopping is null)`,
    )
    .run(new Date(t).toISOString());

const findCheck = (slot: string) => db.prepare('select 1 from followthrough_checks where slot = ?').get(slot);
const lastCheck = () =>
  db.prepare('select * from followthrough_checks order by created desc limit 1').get() as Check | undefined;
// The last check still queued or running: the next waits for it rather than queue behind it.
const stillOpen = (t: number) => {
  const last = lastCheck();
  return !!last && !last.verdict && problemOf(last, t)?.kind !== 'no verdict';
};

// ---- the read (hq followthrough)

// The paused projects and threads (pauses.ts), first: each with why, what wakes its owner, the board's item, how much
// queued work it holds, and the work on it still running, which started before the pause. One whose waited-on work
// ended, or whose owner was woken and hasn't decided, is flagged for this hour (the reader's own wake judges it now).
function pausesPart(open: OpenByID, reader: jobs.Reader) {
  const lines = pauses.open().map(p => {
    const decided =
      p.decision &&
      `the board decides "${p.decision.name}" (${p.decision.card ? `card #${p.decision.card}` : 'no card yet'})`;
    const waits = [
      ...(p.untilTime ? [`${p.untilTime.slice(0, 16).replace('T', ' ')} UTC`] : []),
      ...(p.until.length
        ? [`${p.until.map(u => `#${u.id} (${u.agent}, ${u.state})`).join(' and ')} merged or ended`]
        : []),
    ];
    const until = [
      ...(waits.length ? [`wakes its owner at ${waits.join(' and ')}`] : []),
      ...(decided ? [`until ${decided}`] : []),
    ];
    const ended = p.until.filter(u => !UNDER_WAY.some(w => u.state.startsWith(w)));
    const woken = p.woken && open.get(p.woken);
    const flag =
      p.woken === reader.id
        ? '\n  Met: what it waited for is met, and this job judges it'
        : woken
          ? `\n  Met: what it waited for is met and its owner judges it in ${woken.line}`
          : p.woken
            ? `\n  Off track, act this hour: its owner was woken (#${p.woken}), which ended with it still on and nothing to wake them again`
            : ended.length
              ? `\n  Off track, act this hour: ${ended.map(u => `#${u.id} ended ${u.state}`).join(' and ')}, with the pause still on`
              : '';
    const item = p.item ? itemWords(p.item, reader) : 'no call item linked';
    const running = p.running.map(r => {
      const line = open.get(r.id)?.line ?? `#${r.id} ${r.agent}, ${r.status} (${r.kind}): ${jobs.nameOf(r)}`;
      const since = r.started ? `${r.started.slice(11, 16)} UTC` : 'unknown';
      return `\n  Still on it: ${line} · started ${since}${r.status === 'queued' ? ', held mid-run' : ''}`;
    });
    const at = `${p.at.slice(0, 16).replace('T', ' ')} UTC`;
    const lifts = until.join(', ') || 'by hand: nothing wakes its owner';
    return `- ${p.target} (${p.kind}, paused by ${p.by} ${at}, ${p.held} queued held): ${p.why} · ${lifts}${flag}\n  ${item}${running.join('')}`;
  });
  return `Paused (the claim holds everything queued on them, reviews and fixes too):\n${lines.join('\n') || '- nothing'}`;
}

// (where a waited-on job is while it can still end with what the pause waits for: pausewords.ts untilWords)
const UNDER_WAY = ['queued', 'running', 'waiting for the board', 'in review'];

function runningPart(open: OpenByID, last: Check | undefined) {
  const running = [...open.values()].filter(j => j.status === 'running');
  const started = new Map(
    (
      db.prepare("select id, started from jobs where status = 'running' and kind = 'work'").all() as {
        id: number;
        started: string | null;
      }[]
    ).map(j => [j.id, j.started]),
  );
  const lines = running.map(j => {
    const since = started.get(j.id);
    const fresh = since && last && since > last.created ? ', started since the last check' : '';
    return `- ${j.line} · since ${since ? `${since.slice(11, 16)} UTC` : 'unknown'}${fresh}`;
  });
  return `Running now (hq activity <job>: what one is doing this minute):\n${lines.join('\n') || '- nothing'}`;
}

function readyPart(open: OpenByID) {
  const ready = jobs.readyWork().filter(id => open.has(id));
  const lines = ready.slice(0, READY_SHOWN).map(id => `- ${open.get(id)!.line}`);
  const more = ready.length > READY_SHOWN ? `\n- and ${ready.length - READY_SHOWN} more (hq jobs)` : '';
  return `Next to start (queued, waiting for nothing but a seat):\n${lines.join('\n') || '- nothing'}${more}`;
}

function lastPart(last: Check | undefined) {
  if (!last) return 'The last check: none yet.';
  const when = `${last.slot.slice(11)}:00 UTC`;
  if (last.verdict === 'acted') return `The last check (${when}) acted: ${last.said}`;
  if (last.verdict && last.next)
    return `The last check (${when}) found all on track, and named its next look ${last.next.slice(0, 16).replace('T', ' ')} UTC (sooner on a new line in the summary).`;
  if (last.verdict) return `The last check (${when}) found all on track.`;
  return `The last check (${when}) recorded no verdict: ${currentAlarm()?.line ?? 'it may still be running'}.`;
}

// The status report (infra/report.sh) reads this alarm too.
const currentAlarm = () => JSON.parse(setting(ALARM) ?? 'null') as Alarm | null;
