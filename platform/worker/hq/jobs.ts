// Work handed on as jobs (hq job), and the queue around it: open jobs, adding to one, cancelling one, and sending a
// stuck pull request back to review.
import { mkdirSync, writeFileSync } from 'node:fs';
import * as api from './api.ts';
import { changeLines, lateLines, missWords, moveWords, threadWords, type Deadline, type Move } from './deadlines.ts';
import { at } from './estimate.ts';
import { isReadable, readGoalAndWords, readText, readTextOrStdin } from './files.ts';
import { takeItemFlags, takeThread, takeValues, takeWhen } from './flags.ts';
import { stopped } from './corrections.ts';
import { minute, present, print, shown, stop, text, warn } from './output.ts';
import { asHelp, ONE_DEADLINE } from './levels.ts';
import { liftWords } from './pauses.ts';
import { WINDOW_FIRST } from './levels.ts';

// (the pointer to hq waits add; the title's line)
// (one deadline per deliverable)
// (--thread new: drawn in the project's plan)
// (--code)
// (a thread is one pull request, the follow-on thread's line)
// hq code (the coordinator's jobcodes.ts name).
export const code = {
  help: `
   hq code WORD                                      a task HQ made without a code (a bug report, a call's follow-up):
                                                     name it, once, as hq job --code names a queued one`,

  async run([word, ...rest]: string[]) {
    if (!word || rest.length) stop('usage: hq code WORD');
    const answer = await api.call('code', { body: { code: word } });
    const named = api.parseOrNull(answer.body) as { code?: string } | null;
    if (!api.isSuccess(answer.status) || !named?.code) stop(`Not named: ${api.errorIn(answer.body, 'no answer')}`);
    print(`This task is ${text(named.code)} now.`);
  },
};

export const job = {
  // (the title's step alone; a feature's later piece chained)
  // (--needs, and the drawn deliverable's chain)
  help: `
   hq job [--after <job id> | --after request:<id>]... <agent> "title" [file | -] --code WORD [--downtime] [--when <event>]... [--deliverable <project>/<slug> | --deliverable new:<project> "name" "done when" [--needs <deliverable>]...] [--check]
          [--item <item> | --lands <job>] [--findings <id,id,...>] [--notes <id,id,...>] [--now] [--only <id>]
          [--by <when | project/slug | none>] [--model <lighter model>] --size <90m> [--refs <job,job>] --why "scope comparison"
                                                     first inspect hq estimate for clean past jobs and judge their scope.
                                                     --size is your estimate of agent time (90m, 2h, 1h30m), --refs names
                                                     the past jobs you leaned on, and --why explains the comparison or
                                                     why no past job fits. This estimate is saved when queued and stays
                                                     fixed. Only the CEO changes it later when work slips.
                                                     hand work to someone as a separate job, with the brief in the file
                                                     (- : on stdin); prints the job number. The title is what the board
                                                     reads in its projects view: plain words for the work, no job, card,
                                                     call or PR numbers (--after, --item and the brief carry those), and
                                                     the step alone: the view shows it inside its deliverable, so never
                                                     the deliverable's or project's name in front.
                                                     --code: a word for what the task does (COVERS, FLIGHT, IMPRINT), in
                                                     capitals, at most 8 letters, easy to say on a call; HQ puts its
                                                     project's prefix in front (HQ-COVERS), and that's how the board and
                                                     calls name the task. A word another task in the project holds is
                                                     refused: pick another. --lands and --findings need none: a step of
                                                     a task carries its code.
                                                     "Not confirmed" (exit 3): it may
                                                     be queued, don't send it again. --after starts it once that job is done
                                                     and its pull request merged or closed, or it was cancelled. --after
                                                     request:<id> starts it once the board has answered that card (hq ask),
                                                     with the answer at the end of its brief. --after repeats, jobs and cards
                                                     mixed: one job that joins the rest waits for all of them. So queue each
                                                     piece that can start now without --after, all at once, and only the step
                                                     that needs them with it. Queued is not started: nobody is
                                                     on it until it runs. --downtime: maintenance
                                                     (refactoring, hardening, log scans) that runs only on spare capacity
                                                     and pauses when other work needs the room. A job queued from a
                                                     running job stays in its deliverable by itself. A deliverable is one
                                                     pull request, opened by its first task's push; each later push is
                                                     its next round. Propose work needing its release to the project's
                                                     owner (hq propose). The owner or CEO queues it with --when
                                                     deployed: on that deliverable's work, giving the job a deliverable
                                                     of its own after the release.
                                                     --deliverable <project>/<slug>
                                                     sends it to another (hq deliverable list), --deliverable
                                                     new:<project> "name" "done when" [--needs <deliverable>]... draws
                                                     one for it in the project's plan, as hq plan deliverable does (its
                                                     owner or the CEO), chained after the deliverables it needs: those
                                                     named, else the last one chained from the one under way it most
                                                     likely continues. Related work joins the open deliverable it
                                                     belongs to. --thread,
                                                     the old name, still works. With requireThread enabled in
                                                     company/projects.yaml, a job with no deliverable to inherit must
                                                     name one. --check: QA, audits, security and compliance reads, which
                                                     fold in the projects view. --item <item>: the job
                                                     carries an item from a call (hq items), with the words from the call;
                                                     the item is handled when the job ends done. One open job per item.
                                                     --lands <job>: replace that failed or stopped job for its own agent, landing
                                                     its saved work or retrying a deliverable's task that saved nothing.
                                                     It keeps its place, code, call and item. No brief file is needed:
                                                     HQ reuses the failed job's brief. Work on a PR continues there.
                                                     --findings names the review findings a fix task answers.
                                                     It carries any call item, handled when it ends done.
${asHelp(ONE_DEADLINE)}
                                                     --when <event>: it starts once that has happened, and reads what did
                                                     (repeat it: all of them). deploy or deploy:<n>, the next n deploys from
                                                     now; recreated:<service>, a deploy that recreates that container
                                                     (worker, coordinator, caddy, product-<slug>...); deployed:<job> or
                                                     deployed:pr:<n>, that work merged and deployed; or a time: 2h, 90m
                                                     or 1h30m from now; the board's own with its date and no zone
                                                     (2026-10-26 09:00, on the company's clock); one with Z or a time of
                                                     day alone (14:30) is UTC. Never wait in your session for a later
                                                     event: queue that step with --when, its brief saying what you found
                                                     so far, and stop. On a call, a job waits for the call to end,
                                                     so what the board adds on it goes into its brief.
                                                     --now (on a call only) starts it at once.
                                                     --model <lighter model>: a small, fully specified change (a
                                                     sentence or label the brief quotes, a colour value, a margin it
                                                     points at, a setting or count) runs on a lighter model of
                                                     models.yaml's choices (by its id or name: sonnet), for an agent on
                                                     the claude engine; if it turns out bigger, it hands itself up to the
                                                     agent's own model (hq up). Anything needing diagnosis, design or
                                                     judgment, creative work, market research and running the company
                                                     stay on the agent's own model, the default.
                                                     --only <id>: the task does work only one engine and model do
                                                     (company/org.yaml engineOnly, by its id), so it runs on them
                                                     from the start, whoever it's for.
                                                     --notes: the CEO, routing the board's sent notes (hq route): the
                                                     task takes on those notes, at the end of its brief.
                                                     --expedite (the CEO only): a structural fix to HQ itself, when a fault
                                                     could also stall its own fix. It starts first, ahead of the plan,
                                                     pacing and pauses, in no deliverable; once a push passes its gates and
                                                     tests it merges and deploys, and its review comes after (hq expedite)
   hq job move <job id> <project>/<slug>             move work still going on into another deliverable, its pull
                                                     request's reviews and fix rounds with it (its agent, its
                                                     deliverable's owner, the CEO or Process), naming deliverables that
                                                     need the old one for their owners to decide.
                                                     Out of a pause: its owner or the CEO, with --why "reason" on the feed`,
  // (--when; move: --now)

  async run(given: string[]) {
    if (given[0] === 'move') return moveJob(given.slice(1));
    // (--only)
    const { values: review, args: withoutReview } = takeValues(
      given,
      ['--findings', '--code', '--only', '--notes', '--by', '--size', '--refs', '--why', '--model'],
      'No job was queued',
    );
    if (review.refs !== undefined && !/^#?[1-9][0-9]*(,#?[1-9][0-9]*)*$/.test(review.refs))
      stop('No job was queued: --refs takes past job numbers, comma-separated');
    const { flags, args: withWhen } = takeItemFlags(withoutReview, 'job');
    const { when, args: withThread } = takeWhen(withWhen);
    const { thread, newThread, args: withSwitches } = takeThread(withThread);
    const isNew = withSwitches.includes('--new');
    const downtime = withSwitches.includes('--downtime');
    const check = withSwitches.includes('--check');
    const now = withSwitches.includes('--now');
    const expedite = withSwitches.includes('--expedite');
    if (now && !process.env.HQ_CALL) stop('No job was queued: --now is for a call, where work waits for its end');
    const args = withSwitches.filter(arg => !['--new', '--downtime', '--check', '--now', '--expedite'].includes(arg));
    // A call's agent isn't asked: it has what's in flight in its call context, and its tool runs one command.
    const { agent, title, after, afterRequest, more, briefPath } = readArguments(args);
    // (--notes: the routing check has read the open work in hq route.)
    if (review.notes !== undefined && !/^#?[0-9]+(,#?[0-9]+)*$/.test(review.notes))
      stop('No job was queued: --notes takes the note numbers, comma-separated (hq route lists them)');
    if (!isNew && !process.env.HQ_CALL && review.notes === undefined) await refuseOverlap(agent);
    // The brief is read from the file, never passed in argv. HQ adds who assigned it. On a call it comes on stdin, with the
    // board's why (--goal -), which a promise it carries on the call's notes page takes
    const told = flags.goal === undefined ? undefined : goalAndBrief(briefPath);
    const brief = (told?.words ?? readTextOrStdin(briefPath)).replace(/\s+$/u, '');
    const body = {
      agent,
      title,
      after,
      ...(review.size && { size: review.size }),
      ...(review.size && { refs: review.refs ? review.refs.split(',').map(id => Number(id.replace('#', ''))) : [] }),
      ...(review.why && { why: review.why }),
      ...(review.findings && { findings: review.findings }),
      ...(review.code && { code: review.code }),
      ...(review.only && { only: review.only }),
      ...(review.model !== undefined && { model: review.model }),
      ...(review.notes && { notes: review.notes.split(',').map(id => Number(id.replace('#', ''))) }),
      ...(review.by && { by: review.by }),
      ...(afterRequest !== null && { afterRequest }),
      ...(brief !== '' ? { prompt: brief } : flags.lands === undefined ? { prompt: title } : {}),
      ...(told && { goal: told.goal }),
      ...(downtime && { downtime: true }),
      ...(thread !== undefined && { thread }),
      ...(newThread !== undefined && { newThread }),
      ...(check && { check: true }),
      ...(now && { now: true }),
      ...(expedite && { expedite: true }),
      ...(flags.item !== undefined && { item: Number(flags.item) }),
      ...(flags.lands !== undefined && { lands: Number(flags.lands) }),
      ...(when.length > 0 && { when }),
    };
    const creation = await api.createOnce('job', body);
    if (!creation.made) {
      const { refused, status, error, failure } = creation;
      if (refused) stop(`No job was queued: ${error || failure || `the coordinator refused it (HTTP ${status})`}`);
      const doubt = failure ?? `HTTP ${status}: ${error || 'no job number'}`;
      stop(
        `Not confirmed: the job for ${agent} may or may not be queued (${doubt}). Don't send it again: it may be there already.`,
        3,
      );
    }
    printQueued(agent, title, creation.answer, flags, when);
    // the rest of its waits, now that it waits for its first: it can't start in between
    const id = Number(creation.answer.id);
    for (const w of more) {
      const answer = await api.change('waits', {
        body: { id, ...('request' in w ? { request: w.request } : { to: w.job }) },
      });
      const named = 'request' in w ? `card #${w.request}` : `#${w.job}`;
      if (shown(api.parseOrNull(answer.body)?.ok) === 'true') print(`#${id} waits for ${named} too.`);
      else
        warn(
          `#${id} doesn't wait for ${named}: ${api.errorIn(answer.body, 'no answer')} (hq waits ${id} add ${'request' in w ? `request:${w.request}` : w.job} to try again)`,
        );
    }
  },
};

// --goal -: the brief and the board's why together on stdin (files.ts readGoalAndWords)
function goalAndBrief(briefPath: string) {
  if (briefPath !== '-') stop('No job was queued: --goal - takes the brief on stdin with the goal (-)');
  return readGoalAndWords() ?? stop('No job was queued: --goal - takes {"goal": "...", "words": "..."} on stdin');
}

// [--after <job id> | --after request:<id>]... <agent> "title" [file | -], checked. The job comes with its first
// wait on a job (after, null without) and its first on a card (afterRequest); the rest of its waits are `more`.
function readArguments(args: string[]) {
  const waits: ({ job: number } | { request: number })[] = [];
  while (args[0] === '--after') {
    const card = /^request:([0-9]+)$/.exec(args[1] ?? ''),
      job = jsonArgument(args[1]);
    if (!card && !(Number.isSafeInteger(job) && (job as number) > 0))
      stop('No job was queued: --after takes a job number or request:<id> for a card');
    waits.push(card ? { request: Number(card[1]) } : { job: job as number });
    args = args.slice(2);
  }
  const firstJob = waits.find(w => 'job' in w),
    firstCard = waits.find(w => 'request' in w);
  const [agent, title, brief, ...rest] = args;
  // Old briefs and memories pass a numeric priority before the title.
  if (/^[0-4]$/.test(title ?? '') && brief !== undefined) {
    stop(
      `No job was queued: hq job takes no priority any more. Work runs in the order of its deliverable's window (hq window) and what waits on it. Remove the priority ${title} after the agent and run the same command again, keeping all other arguments.`,
    );
  }
  // On a live call (the voice line sets HQ_CALL) the brief comes on stdin (-), never from a file: a file argument
  // would let the call's agent send any file it can open (the seat's token, other calls) past its Read fence.
  const fileArguments = [brief, ...rest].filter(arg => arg !== undefined).join(' ');
  if (process.env.HQ_CALL && fileArguments !== '' && fileArguments !== '-') {
    stop('hq job on a call takes no file: the brief comes on stdin (-)');
  }
  const briefPath = brief || '/dev/null';
  if (briefPath !== '-' && !isReadable(briefPath)) stop(`No job was queued: can't read the brief (${briefPath})`);
  if (title === undefined)
    stop('usage: hq job [--after <job id> | --after request:<id>]... <agent> "title" [file | -] --code WORD');
  const after = firstJob && 'job' in firstJob ? firstJob.job : null;
  const afterRequest = firstCard && 'request' in firstCard ? firstCard.request : null;
  return {
    agent,
    title,
    after,
    afterRequest,
    more: waits.filter(w => w !== firstJob && w !== firstCard),
    briefPath,
  };
}

// The deliverable a queued job is in. One it joined is read back with its done when, so its queuer reads what the work
// is filed under (board, call 172).
function printFiled(id: string, queued: Record<string, unknown>) {
  if (!present(queued.thread)) return;
  if (!present(queued.doneWhen)) return print(`In deliverable ${text(queued.thread)}.`);
  print(
    `In deliverable ${text(queued.thread)}, ${text(queued.threadName)}, done when ${text(queued.doneWhen)}.`,
    `If this work doesn't deliver that, move it to the one it does: hq job move ${id} <project>/<slug>.`,
  );
}

function printQueued(
  agent: string,
  title: string,
  queued: Record<string, unknown>,
  { item, lands }: { item?: string; lands?: string },
  when: string[],
) {
  const id = shown(queued.id);
  // (its code after the number, which tools read; none for a step of a task that had none)
  print(`Queued job #${id}${present(queued.code) ? ` ${text(queued.code)}` : ''} for ${agent}: ${title}`);
  printFiled(id, queued);
  if (present(queued.chain)) print(text(queued.chain));
  if (present(queued.lighter))
    print(
      `It runs on ${text(queued.lighter)}, and hands itself up to ${agent}'s own model if it's bigger than it looks.`,
    );
  if (present(queued.followOn))
    print(
      `Not in ${text(queued.followOn)}: a deliverable is one pull request, and this waits for that deliverable's own ` +
        `work to be deployed, so it's a deliverable of its own after the release.`,
    );
  const paused = queued.paused as
    { target: string; why: string; untilTime: string | null; until: number[] } | undefined;
  if (paused) {
    const lift = liftWords({ untilTime: paused.untilTime, until: paused.until.map(id => ({ id })) });
    print(`Held: ${text(paused.target)} is paused (${text(paused.why)}) until ${lift}. It starts once that's resumed.`);
  }
  if (when.length > 0) print(`It starts once these have happened: ${when.join(', ')}.`);
  if (present(queued.untilCall))
    print("It starts once this call ends: what's added to it before then goes into its brief.");
  // (the time given, or its item's, on its thread now; or the window of the deliverable it serves, or none: askwindow.ts;
  // on the board's clock on a call: estimate.ts at)
  if (present(queued.deadline)) print(`Its deliverable's deadline: ${at(Date.parse(String(queued.deadline)))}.`);
  const serves = queued.serves as { thread: string; deadline: string } | undefined;
  if (serves) print(`It serves ${text(serves.thread)}'s window: ${at(Date.parse(serves.deadline))}.`);
  if (present(queued.untimed)) print(text(queued.untimed));
  if (present(queued.askedCeo))
    print(`It's the board's ask with no window: ${text(queued.askedCeo)}, the CEO, is asked for its time.`);
  if (item !== undefined) {
    print(`It carries item #${item}: handled when #${id} ends done (it hasn't started yet).`, ...stopped(queued));
  }
  if (lands !== undefined) print(`It takes over #${lands}'s work.`);
  // the threads it moves
  if (Array.isArray(queued.moves))
    print(...changeLines(queued as { moves: Move[]; deadlines: Deadline[] }, 'this job'));
}

// The target's open jobs come first, so an overlap is seen before a parallel job is added. If it has any, nothing is
// queued until the same command comes again with --new. Exit 2, not 3: 3 is "Not confirmed" (it may be queued, don't
// resend), and here nothing was sent.
async function refuseOverlap(agent: string) {
  let open: OpenJob[];
  try {
    open = JSON.parse(await api.get(`jobs?agent=${api.uri(agent)}`));
  } catch (error) {
    if (!(error instanceof api.ApiError)) throw error;
    return warn(`(Couldn't list ${agent}'s open jobs, so queuing without the check.)`);
  }
  if (open.length === 0) return;
  print(`${agent} already has open jobs:`, ...open.map(openJobLine));
  stop(
    "Nothing queued yet. If one of these is the same work, extend it (hq extend <id>, before it starts) or wait on it (hq job --after <id> ... --new, with only what's left). If none is, run the same command again with --new.",
    2,
  );
}

// Any JSON value, digits with leading zeros as a number, or undefined.
function jsonArgument(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  if (/^\s*[0-9]+\s*$/.test(value)) return Number(value);
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// Each open job in the coordinator's words (jobs.ts openLine), printed as it comes.
type OpenJob = { line: string };

const openJobLine = (open: OpenJob) => text(open.line);

// hq job move: the work and its review loop onto another thread (the coordinator's regroup.ts)
async function moveJob(given: string[]) {
  const {
    values: { why },
    args: [id, thread, ...rest],
  } = takeValues(given, ['--why'], 'Nothing moved');
  if (!/^[0-9]+$/.test(id ?? '') || !thread || rest.length) stop('usage: hq job move <job id> <project>/<slug>');
  const answer = await api.change('jobs/move', { body: api.withSpeaker({ id: Number(id), thread, why }) });
  if (!api.isSuccess(answer.status)) stop(`Nothing moved: ${api.errorIn(answer.body, 'no answer')}`);
  const moved = JSON.parse(answer.body) as { thread: string; jobs: number[]; notices?: string[] };
  print(`${moved.jobs.map(n => `#${n}`).join(', ')} on ${text(moved.thread)} now.`, ...(moved.notices ?? []).map(text));
}

export const expedite = {
  help: `
   hq expedite <job id>                              (the CEO only) a structural fix to HQ itself goes first: a queued or
                                                     running job starts ahead of everything (once what it waits for is
                                                     met) and merges on its gates and tests; one that has pushed, its
                                                     pull request still in review, merges now if its last push passed
                                                     them. Its review follows on what merged, and anything blocking is
                                                     its author's next job. A deliverable's task
                                                     that hasn't started leaves its deliverable as its own job; one that ran
                                                     stays (queue the fix with hq job --expedite). Never ordinary work`,

  // (a refusal opens "Nothing expedited", as the call's expedite tool reads it: hq_tools.py.)
  async run([id, ...rest]: string[]) {
    if (!/^[0-9]+$/.test(id ?? '') || rest.length) stop('usage: hq expedite <job id>');
    const answer = await api.change('expedite', { body: { id: Number(id) } });
    const done = api.parseOrNull(answer.body);
    if (shown(done?.ok) !== 'true') stop(`Nothing expedited: ${api.errorIn(answer.body, 'HQ refused it')}`);
    const left = done.from !== undefined ? ` It left ${shown(done.from)} and runs on its own branch from main.` : '';
    // (waits: what it still needs first, which expedite never passes)
    print(
      done.merged !== undefined
        ? `PR #${shown(done.merged)} merged expedited; it deploys within a minute, and its review follows on what merged.`
        : done.waits !== undefined
          ? `#${id} is expedited, but it doesn't start yet: it's queued ${shown(done.waits)}. Then it starts ahead of other work, and merges once a push passes its gates and tests.${left}`
          : `#${id} is expedited: it starts ${shown(done.starts)}, and merges once a push passes its gates and tests.${left}`,
    );
  },
};

export const stopJob = {
  help: `
   hq stop <job id> "why"                            end a running job of yours now (the CEO: anyone's), instead of it
                                                     polling or going on with work that's no longer wanted. It ends stopped,
                                                     keeps its commits on its branch and opens no pull request. Its item
                                                     stays open for its owner to judge. Within a minute; a paused
                                                     job stops as it starts again. The reason is logged. A job that never
                                                     ran: hq cancel. A review or ruling on a paused deliverable pauses at
                                                     its next step instead, and goes on once the pause lifts`,

  async run([id, why = '', ...rest]: string[]) {
    if (!/^[0-9]+$/.test(id ?? '') || !why.trim() || rest.length) stop('usage: hq stop <job id> "why"');
    const answer = await api.change('stop', { body: { id: Number(id), why } });
    const stopping = api.parseOrNull(answer.body);
    if (shown(stopping?.ok) !== 'true') stop(`Couldn't stop #${id}: ${api.errorIn(answer.body, 'no answer')}`);
    // (paused: a review or ruling held with its thread, jobs.ts suspendReview)
    const paused = shown(stopping.paused);
    print(
      paused
        ? `#${id} pauses at its next step, within a few minutes, and goes on in its session once ${paused} resumes.`
        : shown(stopping.running) === 'true'
          ? `#${id} stops within a minute; it ends stopped, its work kept without opening a pull request.`
          : `#${id} is paused: it stops as it starts again, its work kept.`,
    );
  },
};

// hq up: a job on the lighter model its queuer chose hands itself up to its agent's own model. The note waits in the
// job's folder, as hq request's card does, and the worker hands it on as the run ends (the coordinator's jobs.ts handUp).
// HQ_LIGHTER, the agent's own model's name, is set only on such a run.
export const up = {
  help: `
   hq up "note" | -                                  on a job running on a lighter model (hq job --model) that turns out
                                                     bigger than it looked: don't force it. The note (- : on stdin) says
                                                     what you found and did so far; then end your turn. The same job goes
                                                     on at once on your own model, on its branch and clone, in a new
                                                     session with your note in its briefing; this run opens no pull request`,

  async run(given: string[]) {
    const note = (given.length === 1 && given[0] === '-' ? readTextOrStdin('-') : given.join(' ')).trim();
    if (!note) stop('usage: hq up "what you found and did so far" (or - for the note on stdin)');
    const own = process.env.HQ_LIGHTER;
    if (!own)
      stop(
        "Not handed up: this job runs on its agent's own model, so there's no model to hand it up to. Finish it, or hand a part of it on with hq job.",
      );
    if (api.speaker()) stop("Not handed up: hq up is the lead's, for the whole job. Tell your lead what you found.");
    const folder = process.env.HQ_JOB_DIR;
    if (folder === undefined) stop('hq: HQ_JOB_DIR: unbound variable');
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}/up.json`, `${JSON.stringify({ note }, null, 2)}\n`);
    print(`Handed up: once you stop, this job goes on on ${own}, with your note in its briefing. End your turn now.`);
  },
};

export const cancel = {
  help: `
   hq cancel <job id> ["why"]                        cancel a queued job that never ran that you or a colleague queued
                                                     (yours, or one you queued; the CEO and Process: any an agent
                                                     queued; not one HQ made, like a PR's fix job)`,

  async run([id, why = '']: string[]) {
    if (!/^[0-9]+$/.test(id ?? '')) stop('usage: hq cancel <job id> ["why"]');
    const answer = await api.change('cancel', { body: { id: Number(id), ...(why !== '' && { why }) } });
    const cancelled = api.parseOrNull(answer.body);
    if (shown(cancelled?.ok) !== 'true') stop(`Couldn't cancel #${id}: ${api.errorIn(answer.body, 'no answer')}`);
    print(`Cancelled job #${id}.`);
    if (Array.isArray(cancelled.moves)) print(...changeLines(cancelled, 'cancelling it'));
  },
};

export const waits = {
  help: `
   hq waits <job id> add <job>                       a queued job waits for that job's work to merge too (besides any
   hq waits <job id> move <waited for> <replacement> --after and its other waits), for the replacement's instead, or
   hq waits <job id> drop <waited for>               no longer for it. Yours or one you queued (the CEO and Process:
                                                     any queued job's). A job HQ made (a pull request's fix, the board's
                                                     answer) takes an added wait from the CEO or Process with --why
                                                     "reason", shown on the feed. Refused when that job ended without
                                                     work that merged or still can, or waits for this one. HQ sends you a
                                                     job when work it waits for ends without merging
   hq waits <job id> add|drop request:<id>           a queued job that hasn't started waits for a card's answer too (or no
                                                     longer): it starts once the board has answered, with the answer at the
                                                     end of its brief. A card that leaves the desk phone unanswered lets it
                                                     start, and it reads why`,

  async run(given: string[]) {
    const {
      values: { why },
      args: [id, how, waitedFor, replacement, ...rest],
    } = takeValues(given, ['--why'], 'Wait unchanged');
    if (rest.length) stop('Too many arguments: hq waits <job> add|move|drop <wait> [replacement] [--why "reason"]');
    const number = /^[0-9]+$/;
    const card = /^request:([0-9]+)$/.exec(waitedFor ?? '');
    if (card) return changeCardWait(id, how, Number(card[1]), replacement, why);
    const valid =
      number.test(id ?? '') &&
      number.test(waitedFor ?? '') &&
      (how === 'move' ? number.test(replacement ?? '') : ['add', 'drop'].includes(how) && replacement === undefined);
    if (!valid) {
      stop(
        'usage: hq waits <job id> add <job to wait for>, hq waits <job id> move <job it waits for> <job replacing it>, or hq waits <job id> drop <job it waits for>',
      );
    }
    const change = how as 'add' | 'move' | 'drop';
    const from = change === 'add' ? null : Number(waitedFor);
    const to = { add: Number(waitedFor), move: Number(replacement), drop: null }[change];
    const answer = await api.change('waits', { body: { id: Number(id), from, to, why } });
    if (shown(api.parseOrNull(answer.body)?.ok) !== 'true') {
      stop(`Couldn't change #${id}'s wait: ${api.errorIn(answer.body, 'no answer')}`);
    }
    const done = {
      add: `#${id} waits for #${waitedFor} too now.`,
      move: `#${id} waits for #${replacement} now, in place of #${waitedFor}.`,
      drop: `#${id} no longer waits for #${waitedFor}.`,
    };
    print(done[change]);
  },
};

async function changeCardWait(id: string, how: string, card: number, extra: string | undefined, why?: string) {
  if (!/^[0-9]+$/.test(id ?? '') || !['add', 'drop'].includes(how) || extra !== undefined) {
    stop(
      "usage: hq waits <job id> add request:<id>, or hq waits <job id> drop request:<id> (a card's wait isn't moved)",
    );
  }
  const answer = await api.change('waits', {
    body: { id: Number(id), request: card, why, ...(how === 'drop' && { drop: true }) },
  });
  if (shown(api.parseOrNull(answer.body)?.ok) !== 'true') {
    stop(`Couldn't change #${id}'s wait: ${api.errorIn(answer.body, 'no answer')}`);
  }
  print(how === 'add' ? `#${id} waits for card #${card} too now.` : `#${id} no longer waits for card #${card}.`);
}

// (one stuck on tests that couldn't complete)
export const review = {
  help: `
   hq review <pr>                                    a stuck pull request (STATUS.md's prs table) back to the review panel,
                                                     same round and commit: the runs that failed run again, or its
                                                     author's fix job that failed; one stuck on tests that couldn't
                                                     complete: its author pushes the same commit and they run again;
                                                     ruled on, with the branch pushed outside any job since, a job for
                                                     its author whose push gets the next round (its author, the CEO or
                                                     the process team; a failed run is retried once by itself)`,

  // back with the panel, or a failed fix job back with its author
  async run([pr]: string[]) {
    if (!/^[0-9]+$/.test(pr ?? '')) stop('usage: hq review <pr>');
    const answer = await api.change('review', { body: { pr: Number(pr) } });
    const sentBack = api.parseOrNull(answer.body);
    if (shown(sentBack?.ok) !== 'true') stop(`Couldn't send PR #${pr} back: ${api.errorIn(answer.body, 'no answer')}`);
    if (sentBack.ruling) return print(`PR #${pr}: the ruling from job #${shown(sentBack.ruling)} was acted on.`);
    const jobs = (sentBack.jobs as number[]).map(id => `job #${id}`).join(', ');
    print(`PR #${pr} is back in review: ${jobs}.`);
  },
};

// hq window: on a thread, never one job (the coordinator's windows.ts).
const TARGET = '<project>/<slug> | <job id> | pr:<n>';
const target = (given: string | undefined) => {
  const match = /^(?:(pr:)?([0-9]+)|([a-z0-9-]+\/[a-z0-9-]+))$/.exec(given ?? '');
  if (!match) return undefined;
  return match[3] ? { thread: match[3] } : { [match[1] ? 'pr' : 'job']: Number(match[2]) };
};
// (a time's forms, the board's own with its date and no zone among them, here and in the help)
const WINDOW_USAGE = `usage: hq window ${TARGET} <deadline | none> [--aim <time>] [--try] (2h, 90m, 2026-10-26 09:00 on the company's clock, 14:30 UTC)`;
type Miss = { project: string; name: string; deadline: number; finish: number | null };

export const window = {
  help: `
   hq window ${TARGET} <deadline | none> [--aim <time>] [--try]
                                                     a deliverable's window (named by it, or a job or PR on it), the way
                                                     to put work first: the scheduler makes room for it, taking the seat
                                                     from work in its way when its time needs it and giving it back
                                                     after, by itself (never a pause for it). The deadline,
                                                     the latest it may be merged and deployed and still be what was
                                                     agreed, orders its work; --aim, the time we said, at or before it
                                                     (else the aim stays, or is the deadline). 2h, 90m or 1h30m from now;
                                                     the board's own time with its date and no zone (2026-10-26 09:00, on
                                                     the company's clock); one with Z or a time of day alone (14:30) is
                                                     UTC; none takes it off. Prints the deliverables whose
                                                     planned finish moves and the windows the plan misses; --try: nothing saved`,

  async run(given: string[]) {
    const { values, args } = takeValues(given, ['--aim'], 'No window was set');
    const tried = args.includes('--try');
    const [named, deadline, ...rest] = args.filter(arg => arg !== '--try');
    const to = target(named);
    if (!to || !deadline || rest.length) stop(WINDOW_USAGE);
    const body = { ...to, deadline, ...(values.aim !== undefined && { aim: values.aim }), ...(tried && { try: true }) };
    const answer = await api.change('window', { body: api.withSpeaker(body) });
    const set = api.parseOrNull(answer.body);
    if (!present(set?.thread))
      stop(`No window was ${tried ? 'tried' : 'set'}: ${api.errorIn(answer.body, 'no answer')}`);
    const thread = text(set.thread);
    if (!present(set.deadline)) print(tried ? `Tried: ${thread} with no window.` : `${thread} has no window now.`);
    else
      print(
        `${tried ? 'Tried' : 'Window of'} ${thread}: deadline ${minute(String(set.deadline))}, aim ${minute(String(set.aim))}.`,
      );
    if (present(set.deadline) && !tried) print(`${WINDOW_FIRST} Nothing needs pausing for it.`);
    if (tried) print('Nothing was saved.');
    if (Array.isArray(set.moves)) {
      if (!set.moves.length) print('Moves no deliverable.');
      for (const move of set.moves as Move[]) print(`Moves ${moveWords(move)}.`);
    }
    const misses = (set.misses ?? []) as Miss[];
    for (const miss of misses)
      print(
        `Misses ${threadWords(miss)}: deadline ${at(miss.deadline)}, ${miss.finish === null ? 'no finish in sight' : `planned finish ${at(miss.finish)}`}.`,
      );
    // on a call, what to do about them
    print(...lateLines(missWords(misses.map(threadWords))));
  },
};

export const jobs = {
  help: `
   hq jobs [agent]                                   what's in flight: open jobs (queued, running, waiting for the board), all or one agent's.
                                                     hq job shows its target's open jobs first and, if there are any,
                                                     queues nothing (exit 2): if one is the same work, extend it or wait on it
                                                     (--after, with --new); if not, add --new`,

  async run([agent]: string[]) {
    const route = agent ? `jobs?agent=${api.uri(agent)}` : 'jobs';
    const open: OpenJob[] = JSON.parse(await api.orStop(api.get(route), "Couldn't list the open jobs."));
    // no jobs start for memory, while it lasts (the coordinator's room.ts)
    const room = await api.getJson('room').then(
      (r: { line?: string | null }) => r.line,
      () => "Couldn't check whether jobs are waiting for memory.",
    );
    if (room) print(room);
    if (open.length > 0) print(...open.map(openJobLine));
    else print(`No open jobs${agent ? ` for ${agent}` : ''}.`);
  },
};

export const extend = {
  help: `
   hq extend <job id> "text" [file]                  add to a job that hasn't started yet (the text, or the file's), instead of a second job`,

  async run([id, words, file]: string[]) {
    if (!/^[0-9]+$/.test(id ?? '') || !words) stop('usage: hq extend <job id> "text" [file]');
    if (process.env.HQ_CALL) return addOnCall(id, words, file);
    const refusal = `Couldn't add to #${id}: only a job an agent queued that hasn't started yet can be extended. Wait on it instead (hq job --after ${id} ... --new).`;
    const filePath = file || '/dev/null';
    if (!isReadable(filePath)) stop(refusal);
    const added = [words, readText(filePath)].filter(part => part !== '').join('\n\n');
    await api.orStop(api.post('extend', api.withSpeaker({ id: Number(id), text: added })), refusal);
    print(`Added to job #${id}.`);
  },
};

// On a live call (the voice line sets HQ_CALL), what the board adds to a job the call queued, started or not: the words
// come on stdin (-), never from a file (as for hq job). Only a refusal or no connection at all proves nothing was added;
// anything else may have come after HQ added it (exit 3, "Not confirmed").
async function addOnCall(id: string, words: string, file: string | undefined) {
  if (words !== '-' || file !== undefined) stop('hq extend on a call takes no file: the words come on stdin (-)');
  const body = { id: Number(id), text: readTextOrStdin('-') };
  const creation = await api.createOnce('extend', body, answer => present(answer.added));
  if (!creation.made) {
    const { refused, status, error, failure } = creation;
    if (refused) stop(`Nothing was added: ${failure ? "couldn't reach HQ" : error || 'HQ refused it'}.`);
    stop(`Not confirmed: it may or may not have been added (HQ answered ${api.httpCode(status)}).`, 3);
  }
  const added = creation.answer;
  const agent = text(added.agent);
  if (added.added === 'brief') {
    print(`Added to job #${id}'s brief: it hasn't started yet, so ${agent} gets it with the rest.`);
  } else if (added.added === 'message') {
    print(
      `Job #${id} has started: ${agent}'s session reads the addition at its next step (message #${shown(added.message)}). If the job ends first, it becomes a job of its own for ${agent}.`,
    );
  } else {
    print(
      `Job #${id} can't take it mid-job (it waits for the board, or runs on Codex): the addition is job #${shown(added.became)} for ${agent} now (message #${shown(added.message)}).`,
    );
  }
}
