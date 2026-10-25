// The CEO's hourly follow-through check: while the board has agreements from its calls that still stand, or the CEO's
// summary (summary.ts) has something to look at, HQ queues the CEO a short check with the summary in it that sets them
// against the work actually running, to make sure work gets done, and alarms when a check doesn't start, finish or say: the Process team gets a job to
// mend it. It's the one way HQ's picture reaches the CEO: nothing else makes a job of a slip, a stall or a wait.
import { db, inOneStep, remember, setting } from './db.ts';
import { publish } from './events.ts';
import * as jobs from './jobs.ts';
import { STANDING } from './jobcodes.ts';
import { agreements, agreedPart, itemWords, oneLine, type OpenByID } from './agreements.ts';
import * as pauses from './pauses.ts';
import { ceo, roles, yamlFile } from './company.ts';
import * as forecast from './forecast.ts';
import * as summary from './summary.ts';
import { made, madeCode } from './made.ts'; // (madeCode)

export const START_MS = 15 * 60_000,
  FINISH_MS = 45 * 60_000,
  RETELL_MS = 3 * 3_600_000;
export const SAID_MAX = 200;
export const LONG_LINE = `keep it to one line of up to ${SAID_MAX} characters`;
const READY_SHOWN = 15;
const ALARM = 'followthrough.alarm';

export type Verdict = 'ok' | 'acted';
type Check = { slot: string; job: number; created: string; verdict: Verdict | null; said: string | null };
type Problem = { kind: 'not started' | 'overran' | 'no verdict'; line: string };
// since: when the checks stopped working (the first alarm since the last verdict); told: the Process team's job about it
type Alarm = Problem & { slot: string; since: string; told?: number; toldAt?: string; carded?: number };

// Every minute: the check due this hour, and the last one watched until it records its verdict.
export function followThroughSweep(t = Date.now()) {
  if (jobs.paused()) {
    restartClock(t);
    return;
  }
  // (its seats all at their limits: it starts when the first is back, and a repair job would wait for the same seats)
  const last = lastCheck();
  if (last && !last.verdict && jobs.seatsOut(last.job, t)) restartClock(t);
  // (an open pause is checked as an agreement is)
  const open = stillOpen(t);
  const slot = new Date(t).toISOString().slice(0, 13);
  const due = !open && !findCheck(slot);
  const standing = agreements().length > 0 || pauses.anyOpen();
  // (the summary is read only where it decides: for the hour's check to queue, or, with nothing else standing, whether a
  // check that ended without its verdict is still watched.)
  const picture = due || (!standing && !open && last && !last.verdict) ? summary.read(forecast.current(t)) : undefined;
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
    db.prepare('insert into followthrough_checks (slot, job, created) values (?, ?, ?)').run(
      slot,
      id,
      new Date(t).toISOString(),
    );
  });
}

// hq followthrough ok | acted "line": the running check's verdict. Only a check records one, once.
export function recordVerdict(job: number, verdict: Verdict, said: string) {
  const check = db.prepare('select * from followthrough_checks where job = ?').get(job) as Check | undefined;
  if (!check) return "only HQ's follow-through check records a verdict, and this job isn't one";
  if (check.verdict) return `this check already recorded "${check.verdict}"`;
  const line = oneLine(said);
  if (verdict === 'acted' && !line)
    return 'say in one line what was off and what you did: hq followthrough acted "..."';
  if (line.length > SAID_MAX) return LONG_LINE;
  db.prepare('update followthrough_checks set verdict = ?, said = ?, at = ? where job = ?').run(
    verdict,
    line || null,
    new Date().toISOString(),
    job,
  );
  remember(ALARM, null);
  return { ok: true };
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
    const since = job.started ?? check.created;
    return t - Date.parse(since) < FINISH_MS
      ? null
      : { kind: 'overran', line: `${named} has run ${minutes(since)} min without a verdict` };
  }
  return { kind: 'no verdict', line: `${named} ended (${job?.status ?? 'gone'}) without a verdict` };
}

// An unstarted check's time to start counts from now: work is paused, or its seats are out.
const restartClock = (t: number) =>
  db
    .prepare(
      `update followthrough_checks set created = ? where verdict is null
      and job in (select id from jobs where status = 'queued' and started is null)`,
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
// ended, or whose owner was woken and hasn't decided, is flagged for this hour.
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
    const flag = woken
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

// (where a waited-on job is while it can still end with what the pause waits for: pauses.ts untilWords)
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
  return `Running now:\n${lines.join('\n') || '- nothing'}`;
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
  if (last.verdict) return `The last check (${when}) found all on track.`;
  return `The last check (${when}) recorded no verdict: ${currentAlarm()?.line ?? 'it may still be running'}.`;
}

// The status report (infra/report.sh) reads this alarm too.
const currentAlarm = () => JSON.parse(setting(ALARM) ?? 'null') as Alarm | null;

// The check's own text, every company's. The company's own words for it (org.yaml's followThrough.prompt) come after
// it, as a routine's additions do (schedule.ts). (Acting from the run when the way out is itself held.)
// (a slip's cause, the scheduler's or the task's, instead of cutting by hand)
// (judged against what the board is waiting for, not whether HQ's rules held: board, 25 Oct)
const PROMPT = `HQ's hourly check. Its own question, each hour: is the board getting what it asked for, and if not, why
not and what do you do now? It judges against what the board wants in real terms, never against whether HQ's rules
held: rules that held while the board still lacks what it asked for are off track. HQ queues it while the board's
agreements or pauses stand or the summary has something in it. It is a short read, not a report: the board hears
nothing from it unless something needs its judgment.

Delivered means one thing: the board has seen it and said yes, this is what I want. Not a job ending, merging or
deploying. Until the board has said yes, what it asked for is open, and this check acts on it.

1. Read the summary below and \`hq followthrough\`. The summary: what the board asked for and how long it has waited,
   what finished since the last check (threads done and the board's items, merged and deployed: whether the board hears
   is yours, and what it asked to hear the moment it's ready goes to it as a notice marked \`now\`), the alarms on now,
   what threatens the plan (windows the plan misses and what holds them, threads giving past their aim, and the threats
   before anything slips: work past its size, a stuck pull request, tests slow or failing, timeouts, the worker's room
   down to a couple of jobs, a seat near its limit, and from the owners' plans; a missed window and a stuck pull request
   with when their work last moved: a new commit pushed, a review round opened or ruled, the merge or its deploy, never
   a job queued, started, re-sent or ended with nothing pushed), what waits for the board's decision,
   and the queue. \`hq followthrough\`: the paused projects and threads (why, until what, the board's item, and work on
   each still running from before the pause), what the board agreed that still stands (in its own words for your
   calls' decisions), the work on each and where it stands, what's running now, what starts next, and what the last
   check did.
2. List what the board is waiting for: each thing it asked for, in its own words (a product, a deadline, an
   experiment's or a trial's results, a fix, an answer, anything), from its agreements, the items and holds it agreed,
   and the summary. For each, where it really stands, read on real state (what's on main, the reports, what's live,
   the cards it answered), never on job states: does the board have it and has it said yes? If not, is the work that
   gets it there moving, and does it reach the board by the time it agreed?
3. Compare. Off track is anything the board asked for that it doesn't have and that isn't on its way to it on time:
   nobody on it, the work not moving, or the work that should bring it ended without it (a job done, merged or deployed
   with no result in it is not delivery). Also anything that threatens the plan; work running or about to start
   against an agreement (a hold, a pause, an order); and agreed work that no longer serves why the board wanted it:
   read an agreement as the board said it, not as a later brief narrowed it. Flagged and acted on this hour, never
   on track:
   - A pause still on with what it waited for met, or a job it waits for ended. Nothing lifts a pause but a resume:
     what it waits for wakes its owner with a job to judge it. Its owner hasn't decided yet (no job woke them, it
     ended without a resume or a new condition, or the work ended without the result the hold was for): decide now,
     as the pause's reason says: lift it, take the results to the board, or queue what's missing and pause it again
     on that (\`hq project pause\` with the same why and \`--until\` the new job keeps it on).
   - A result the board asked for first (its priority, an experiment, a comparison) promised and not in its hands: no
     work running that brings it, or the work that should have ended without it. Queue what's missing now, and tell
     the board on the desk phone where it stands when its time is at risk.
   Work still running on a pause started before it: stop it (\`hq stop\`) or let it finish, as the pause's reason says.
   A hold the board agreed on a project or thread that isn't a pause yet goes in as the pause (\`hq project pause\` or
   \`hq thread pause\`, \`--until\` the jobs whose end wakes you to judge it, \`--until-time\` a time, or \`--by-hand\`,
   then \`hq item link <item> pause:<project or thread>\`), not as waits or a line in a brief.
4. On track only when everything the board waits for is with it and accepted, or on its way to it in time on real
   state, and nothing in the summary needs you since the last check: \`hq followthrough ok\`, and stop. No report, no
   message, no card.
5. Off track: find the cause on real state and fix it now, never one job moved by hand. The plan orders the work by
   its threads' windows and the scheduler (the play and the claim) makes room for it, taking seats and run places from
   lower work: never hand-pick work to cut, pause or move ahead to win time back. The summary, \`hq report\` and \`hq
   thread\` say what a slip, or a window under threat, comes from:
   - The scheduler failed to act: lower work kept a seat or a place that ready deadline work could have used and should
     have taken from it, a pause didn't free one, the plan mis-ordered the work. That is a scheduler fault, never
     written off as the plan's forecast: say it is one, and queue its structural fix to the play's owner at once (\`hq
     job --expedite\` when the fault could hold up its own fix).
   - The scheduler acted and capacity is short: the deadline work's eligible seat is out of quota until its reset, or
     the server is short of room, so pausing the holder frees nothing the deadline work could use. That is no scheduler
     fault: the shortage goes to its owner, and decide whether the board hears the new time.
   - The scheduler acted and the task itself overruns: re-size it (\`hq estimate set\`) so the plan plays its real
     size, decide whether the board hears the new time, and find why it runs long: a heavy run that belongs off the
     worker (\`hq run\`), the server short of memory or cores, tests slow or hung, or something else. Its cause goes
     to its owner.
   - Something stuck: queue its cause's owner a job with what you found. HQ, the platform, the tests, the worker's room
     and the seats are Process's, and so are sizes or plays that proved wrong. \`hq stop\` work running against an
     agreement, \`hq waits <job> add <job>\` to hold queued work behind what must land first, hand failed agreed work
     back (\`hq followthrough requeue <failed job> "what was off"\`: the agent whose call it is takes it over).
   - A repair fixes the cause: never another flag, rule or reminder on top of it.
   Before you act, ask whether the way you reach for is itself held by what's wrong: a job you queue waits for the same
   seats, room and queue as the work it should free, so behind a jammed worker or a stuck queue it does nothing. Then act
   from this run: what only the outside can do goes out on the two lines that never stick behind HQ: the Overseer (\`hq
   overseer\`, let out when this run ends) and the board on the desk phone, one or both. After you act, think on: what
   happens next, and what if it doesn't work? Tell the Overseer ahead so it watches, and put a card to the board early
   when the Overseer can't act.
   When you can't see the fix, take it to the board on the desk phone. Then \`hq followthrough acted "what was off and
   what you did, in one line"\`: the next check reads it. After a note to the Overseer, end the run at once after that
   line: your notes go out when it ends.

Keep it short: it runs every hour, so it spends little when all is on track.`;
// org.yaml's followThrough.prompt (template/company/org.yaml documents it): what the check is for to the company's
// board and how far it goes. Without one, the check runs on its own text.
function checkPrompt() {
  const own = String(yamlFile('company/org.yaml').followThrough?.prompt ?? '').trim();
  return own ? `${PROMPT}\n\nOur own additions:\n${own}` : PROMPT;
}
