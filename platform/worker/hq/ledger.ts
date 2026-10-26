// The call ledger: a call's follow-up records what was said on it (hq item) and hands it out, and hq items shows where
// each item stands. A correction's answer also tells which jobs it cancelled or told (stopped()).
import * as api from './api.ts';
// (at: an item's time on the board's clock on a call, estimate.ts)
import { at } from './estimate.ts';
import { readGoalAndWords, readTextOrStdin } from './files.ts';
import { present, print, shown, stop, text } from './output.ts';
import { takeItemFlags, takeValues, type ItemFlags } from './flags.ts';
import { stopped, stoppedOnCall } from './corrections.ts';

// roles.asks in the help below
export const items = {
  help: `
   The call ledger: a call's follow-up records what was said on it, and hands it out (only jobs working for that call,
   and org.yaml's roles.asks for ended calls about neither customers nor keys):
   hq items [call]                                   a call's items in full (the words from the call, lines, where each
                                                     stands), or without a call: what's open on every call, one line each
   hq call <id> [a-b]                                the call's transcript, numbered (or lines a to b)`,

  async run([callId]: string[]) {
    if (!callId) return listOpenItems();
    if (!/^[0-9]+$/.test(callId)) stop('usage: hq items [call]');
    const list = JSON.parse(
      await api.orStop(api.get(`items?call=${callId}`), `Call #${callId} isn't one this job works for.`),
    );
    if (list.length === 0) return print(`No items on call #${callId} yet.`);
    for (const item of list) print(...itemInFull(item));
  },
};

async function listOpenItems() {
  const list = JSON.parse(await api.orStop(api.get('items'), "Couldn't list the open items."));
  if (list.length === 0) return print('No open items.');
  for (const item of list) {
    const job = present(item.job) ? ` · job #${item.job}` : '';
    const stopped = present(item.stopped) ? ` · returned by stopped job #${item.stopped}` : '';
    // (ready: its work ended, open until the CEO records the board's yes)
    const ready = item.status === 'ready' ? ', ready for the board to say yes' : '';
    print(
      `#${item.id} (call #${item.call}, ${text(item.kind)} for ${text(item.owner)}${ready}): ${text(item.what)}${job}${stopped}`,
    );
    if (present(item.goal)) print(`   goal: ${text(item.goal)}`);
  }
}

function itemInFull(item: Record<string, unknown>) {
  const facts = [
    present(item.lines) && `lines ${text(item.lines)}`,
    present(item.due) && `due ${at(Number(item.due))}`,
    present(item.job) && `job #${item.job}`,
    present(item.request) && `request #${item.request}`,
    present(item.ref) && `ref ${text(item.ref)}`,
    present(item.replaces) && `replaces #${item.replaces}`,
    present(item.why) && `${item.status === 'dropped' ? 'dropped: ' : ''}${text(item.why)}`,
    present(item.ready_at) && `ready since ${at(Date.parse(String(item.ready_at)))}`,
    present(item.said) && `the board said yes: ${text(item.said)}`,
  ].filter(fact => fact !== false);
  const goal = present(item.goal) ? [`   goal: ${text(item.goal)}`] : [];
  const quoted = text(item.quote);
  const quote = (quoted === '' ? [] : quoted.split('\n')).map(line => `   > ${line}`).join('\n');
  return [
    `#${item.id} ${text(item.kind)} for ${text(item.owner)}, ${text(item.status)}: ${text(item.what)}`,
    ...goal,
    `   ${facts.join(' · ')}`,
    quote,
    '',
  ];
}

const ADD_USAGE =
  'usage: hq item add <kind> <owner> "what" - [a-b] --goal - [--call <id>] [--replaces <item>] [--deadline <when> [--job <id> [--thread <project>/<slug>]]]';
const REPLACE_USAGE = 'usage: hq item replace <item> "what" - [a-b] --goal - [--call <id>] [--deadline <when>]';
const LINK_USAGE =
  'usage: hq item link <item> job:<id> [--thread <project>/<slug>] | request:<id> | pause:<project or thread> | "<ref>"';
const DROP_USAGE = 'usage: hq item drop <item> "why"';
const DONE_USAGE = 'usage: hq item done <item> "what the board said"';

// (an item's time becomes its work's thread's window; --deadline's forms)
export const item = {
  help: `
   hq item add <kind> <owner> "what" - [a-b] --goal - [--call <id>] [--replaces <item>] [--deadline <when> [--job <id>
                                                     [--thread <project>/<slug>]]]
                                                     record one item (kind: task, decision, briefing, promise or question)
                                                     on the call you follow up (--call: which one, if you follow up more
                                                     than one): "what" is one plain line the board reads; a-b its
                                                     transcript lines. Stdin holds JSON {"goal": "...", "words": "..."}
                                                     (< a file in $TMPDIR): the words from the call verbatim, and the
                                                     goal, why the board wants it (its goal or the problem it solves, in
                                                     its own terms, one line). The jobs that carry the item get the goal,
                                                     and judge the work by it. Both hold what was said on the call, so
                                                     neither goes in argv, where other jobs can read it.
                                                     --replaces (a call's follow-up only): the board changed an earlier
                                                     item; that one is replaced, its jobs that never ran are cancelled,
                                                     and a running one is told at its next step.
                                                     --deadline: the time the board was given for it on the call (its own
                                                     with its date and no zone, 2026-10-26 09:00, on the company's clock;
                                                     one with Z or a time of day alone, 14:30, is UTC; 2h counts from
                                                     now): the thread of
                                                     the job that carries it (hq job --item) or of the job it's linked to
                                                     takes it as its window (hq window); a correction keeps the
                                                     earlier time. --job <id>, on a live call: a promise about
                                                     its owner's work under way, linked to it as it's recorded (handled
                                                     when it ends done), whose thread takes the time at once;
                                                     --thread puts a job the call queued in no thread on that one
   hq item replace <item> "what" - [a-b] --goal - [--call <id>] [--deadline <when>]
                                                     the same as add --replaces, with the earlier item's kind and owner.
                                                     On a live call (its own token): only an open item, while the board is
                                                     on the line. "Not confirmed" (exit 3, for add too): it may be
                                                     recorded, don't record it again
   hq item link <item> job:<id> [--thread <project>/<slug>] | request:<id> | pause:<project or thread> | "<ref>"
                                                     what shows it's done: a job (handled when it ends done; a task or
                                                     a promise is ready then, open until hq item done), a pause
                                                     the board agreed (hq thread pause, hq project pause: it carries the
                                                     item, handled already or not), or a request to the board or a ref
                                                     (a DECISIONS.md entry, a note, a commit) saying what your job did:
                                                     then it's your job's work, handled when it ends done with a pull
                                                     request, judged in its review (notes alone too); without one it
                                                     stays open (a question: handled now).
                                                     The call's follow-up, the job that carries the item, or a job of
                                                     roles.asks. The CEO also links with --why "reason", shown on the feed.
                                                     A job of yours carries one item, so it takes no second
                                                     (hand that one out).
                                                     A job linked while it's queued or running hears the item's goal.
                                                     An item already handled (or dropped, replaced): the call's follow-up
                                                     links it to note it went through it; nothing about it changes.
                                                     The item's time goes on the job's thread: --thread puts work still
                                                     going on that's in no open thread (none, or one that's done) on that
                                                     open thread first, its reviews and fixes with it (hq thread list)
   hq item drop <item> "why"                         it won't happen, and why (one line the board reads); the call's
                                                     follow-up only (it cancels the item's jobs that never ran and
                                                     tells a running one at its next step), and the CEO on a ready item
   hq item done <item> "what the board said"         the CEO: the board has the task or promise and said yes (on a
                                                     call, in the intercom or a card's answer), in one line. Only this
                                                     handles a task or promise: its work ending makes it ready, and it
                                                     stays on what the board asked for until then`,

  async run(given: string[]) {
    const { flags, args } = takeItemFlags(given, 'item');
    const [action, ...rest] = args;
    const replaces = flags.replaces === undefined ? null : Number(flags.replaces);
    const callId = flags.call === undefined ? null : Number(flags.call);
    if (action === 'add') {
      // (--thread: with --job, on a live call)
      const { values, args: given } = takeValues(rest, ['--thread'], 'Nothing recorded');
      if (given.length < 4 || (values.thread !== undefined && flags.job === undefined)) stop(ADD_USAGE);
      const [kind, owner, what, quote, lines = ''] = given;
      return recordItem({
        action,
        kind,
        owner,
        what,
        quote,
        lines,
        replaces,
        callId,
        deadline: flags.deadline,
        work: flags.job === undefined ? undefined : { job: flags.job, thread: values.thread },
        goal: flags.goal,
      });
    }
    if (action === 'replace') {
      if (!/^[0-9]+$/.test(rest[0] ?? '') || rest.length < 3) stop(REPLACE_USAGE);
      const [earlier, what, quote, lines = ''] = rest;
      return recordItem({
        action,
        kind: '',
        owner: '',
        what,
        quote,
        lines,
        replaces: Number(earlier),
        callId,
        deadline: flags.deadline,
        goal: flags.goal,
      });
    }
    refuseRecordingFlags(flags);
    if (action === 'link') return linkItem(rest);
    if (action === 'drop') return dropItem(rest);
    if (action === 'done') return doneItem(rest);
    stop('usage: hq item add | replace | link | drop | done (run hq for details)');
  },
};

// The flags only hq item add or replace takes, refused on link and drop.
function refuseRecordingFlags(flags: ItemFlags) {
  if (flags.job !== undefined) stop('--job goes with hq item add, on a live call');
  if (flags.deadline !== undefined) {
    stop("--deadline goes with hq item add or replace: a linked item's time goes to the job it's linked to");
  }
  if (flags.goal !== undefined) {
    stop('--goal goes with hq item add or replace: an item keeps the goal it was recorded with');
  }
}

export const reply = {
  help: `
   hq reply "<text>" | -                             a call's follow-up: what the board reads after the call (the
                                                     intercom for the CEO's calls, HQ's Calls for everyone's), at most
                                                     120 words (- : on stdin). It goes when this job ends done, and
                                                     the call isn't followed up without it; again replaces it. Your
                                                     last message stays the job's report for the log`,

  async run([given, ...rest]: string[]) {
    if (!given || rest.length) stop('usage: hq reply "<text>" | -');
    const replyText = given === '-' ? readTextOrStdin('-') : given;
    const answer = await api.call('reply', { body: { text: replyText } });
    const set = api.parseOrNull(answer.body) ?? {};
    if (shown(set.ok) !== 'true') refused(answer.body, 'No reply set');
    print(`The board's reply is set (${text(set.words)} words): it reaches the board when this job ends done.`);
  },
};

type NewItem = {
  action: string;
  kind: string;
  owner: string;
  what: string;
  quote: string;
  lines: string;
  replaces: number | null;
  callId: number | null;
  deadline?: string;
  work?: { job: string; thread?: string };
  goal?: string;
};

async function recordItem({
  action,
  kind,
  owner,
  what,
  quote,
  lines,
  replaces,
  callId,
  deadline,
  work,
  goal,
}: NewItem) {
  const onCall = Boolean(process.env.HQ_CALL);
  const given = readGoalAndQuote(action, quote, goal);
  const body = {
    what,
    goal: given.goal,
    quote: given.words,
    ...(kind !== '' && { kind, owner }),
    ...(lines !== '' && { lines }),
    ...(replaces !== null && { replaces }),
    ...(callId !== null && { call: callId }),
    ...(deadline !== undefined && { deadline }),
    ...(work && { job: Number(work.job), ...(work.thread !== undefined && { thread: work.thread }) }),
  };
  const recorded = await record(body);
  const id = shown(recorded.id);
  // replace: the earlier item's kind and owner
  const recordedKind = text(recorded.kind ?? kind);
  const recordedOwner = text(recorded.owner ?? owner);
  if (onCall) return printNotedOnCall(recorded, { kind: recordedKind, owner: recordedOwner, replaces });
  const recordedAs = `Recorded item #${id} (${recordedKind} for ${recordedOwner}) on call #${text(recorded.call)}.`;
  // A message item corrected from the transcript: handled, as the one it replaces was (the coordinator's ledger.ts add)
  if (recorded.status === 'handled') {
    print(`${recordedAs} The work item #${replaces} reached goes by it from now on: nothing to hand out.`);
  } else {
    print(
      `${recordedAs} It's open until it's linked to what shows it's done (hq job --item ${id}, or hq item link ${id} ...).`,
    );
  }
  if (shown(recorded.replaced) !== '') {
    const stays =
      recorded.was === 'handled' && recorded.status !== 'handled'
        ? ": its work that ended done stays done, so this item's job corrects it"
        : '';
    print(`Item #${replaces} is replaced by this one${stays}.`, ...stopped(recorded));
  }
}

// The goal and the words, on stdin as JSON (--goal -). Both hold what was said on the call, so they stay out of argv,
// where any uid can read them (/proc/<pid>/cmdline).
function readGoalAndQuote(action: string, quote: string, goal: string | undefined) {
  if (quote !== '-')
    stop(`Nothing recorded: hq item ${action} takes no file: the words come on stdin with the goal (- --goal -)`);
  if (goal !== '-') stop(`Nothing recorded: hq item ${action} takes its goal on stdin with the words (--goal -)`);
  return readGoalAndWords() ?? stop('Nothing recorded: --goal - takes {"goal": "...", "words": "..."} on stdin');
}

// The call's agent's answer: it's on the list, nobody has it yet, or (a promise about work under way) it's that job's,
// whose thread has its time already.
function printNotedOnCall(
  recorded: Record<string, unknown>,
  { kind, owner, replaces }: { kind: string; owner: string; replaces: number | null },
) {
  const noted = `Noted as ${kind} #${shown(recorded.id)} on this call, for ${owner}`;
  if (replaces === null) print(`${noted}.`);
  else print(`${noted}: it replaces #${replaces} (${text(recorded.replacedWhat ?? '?')}), which the board changed.`);
  print(
    present(recorded.job)
      ? `It's job #${shown(recorded.job)}'s, done when that ends done, and the deadline of ${text(recorded.thread)} ` +
          `now: ${at(Date.parse(String(recorded.deadline)))}.`
      : "It's on the call's list, not handed to anyone yet: after the call, the follow-up hands it out.",
  );
  if (replaces !== null) print(...stoppedOnCall(recorded));
}

async function record(body: object) {
  const creation = await api.createOnce('item', body);
  if (creation.made) return creation.answer;
  const { refused, status, error, failure } = creation;
  if (refused) {
    const reason = error === 'not found' ? "it isn't on a call this job works for" : error;
    stop(`Nothing recorded: ${reason || failure || `the coordinator refused it (HTTP ${status})`}`);
  }
  const doubt = failure ?? `HTTP ${status}: ${error || 'no item number'}`;
  stop(
    `Not confirmed: the item may or may not be recorded (${doubt}). Don't record it again: it may be there already.`,
    3,
  );
}

// (--thread)
async function linkItem(given: string[]) {
  const { values, args } = takeValues(given, ['--thread', '--why'], 'Not linked');
  const { thread, why } = values;
  const [id, target, ...rest] = args;
  if (!/^[0-9]+$/.test(id ?? '') || !target || rest.length) stop(LINK_USAGE);
  if (thread !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(thread))
    stop('Not linked: --thread takes an open thread, <project>/<slug> (hq thread list)');
  const jobOrRequest = target.match(/^(job|request):([0-9]+)$/);
  if (!jobOrRequest && /^#?[0-9]+$/.test(target))
    stop(`Is ${target} a job or a request? Say job:<id> or request:<id>.`);
  // (pause: the open pause on a project or thread carries it)
  const pause = /^pause:(\S+)$/.exec(target)?.[1];
  const to = jobOrRequest ? { [jobOrRequest[1]]: Number(jobOrRequest[2]) } : pause ? { pause } : { ref: target };
  const answer = await api.call('item-link', {
    body: { id: Number(id), to, why, ...(thread !== undefined && { thread }) },
  });
  const linked = api.parseOrNull(answer.body) ?? {};
  const status = shown(linked.status);
  if (status === '') refused(answer.body, 'Not linked');
  if (shown(linked.acknowledged) === 'true') {
    print(
      `Item #${id} is ${status} already: noted that this follow-up went through it (nothing about it changed, ${target} isn't stored).`,
    );
  } else if (status === 'handled') {
    print(`Item #${id} is handled (${target}).`);
  } else if (status === 'ready') {
    print(
      `Item #${id} is ready (${target} ended done): it stays open until the CEO records the board's yes (hq item done).`,
    );
  } else if (jobOrRequest?.[1] === 'job') {
    print(`Item #${id} is linked to ${target}: handled when that job ends done (until then it's open).`);
  } else {
    // (a request or ref: the linking job's own work)
    print(
      `Item #${id} is your job's work now (${target}): handled when this job ends done with a pull request, whose review judges it against the board's words (until then, or without one, it's open).`,
    );
  }
  // the item's time, on the work's thread now
  if (present(linked.deadline))
    print(`Its time is the deadline of ${text(linked.thread)} now: ${at(Date.parse(String(linked.deadline)))}.`);
  printGoalDelivery(linked, target);
  print(...stopped(linked));
}

function printGoalDelivery(linked: Record<string, unknown>, target: string) {
  // the item's goal, to work linked while it's under way (the coordinator's ledger.ts goalTo)
  const goalDelivery: Record<string, string> = {
    brief: `${target} has the item's goal in its brief.`,
    message: `${target} hears the item's goal at its next step.`,
    job: `${target} takes no message in its session, so the item's goal went to its agent as job #${shown(linked.goalJob)}.`,
    refused: `The item's goal didn't reach ${target} (HQ refused the message: too many this hour, or its chain of messages is full): link it again later, and HQ sends it then.`,
    withheld: `${target} may not read the item's call, so it didn't hear its goal: tell it why the work matters with hq say, without details from that call.`,
  };
  const reachedLine = goalDelivery[shown(linked.goalReached)];
  if (reachedLine !== undefined) print(reachedLine);
}

async function dropItem([id, why]: string[]) {
  if (!/^[0-9]+$/.test(id ?? '') || !why) stop(DROP_USAGE);
  const answer = await api.call('item-drop', { body: { id: Number(id), why } });
  const dropped = api.parseOrNull(answer.body) ?? {};
  if (shown(dropped.ok) !== 'true') refused(answer.body, 'Not dropped');
  print(`Item #${id} is dropped: ${why}`, ...stopped(dropped));
}

// hq item done: the CEO records the board's yes
async function doneItem([id, said, ...rest]: string[]) {
  if (!/^[0-9]+$/.test(id ?? '') || !said || rest.length) stop(DONE_USAGE);
  const answer = await api.call('item-done', { body: { id: Number(id), said } });
  if (shown((api.parseOrNull(answer.body) ?? {}).ok) !== 'true') refused(answer.body, 'Not recorded');
  print(`Item #${id} is handled: the board said yes (${said}).`);
}

// A refusal says why in the coordinator's words. "not found": not a call or item this job works for.
function refused(body: string, what: string): never {
  const why = api.errorIn(body);
  stop(`${what}: ${(why === 'not found' ? "it isn't on a call this job works for" : why) || 'no answer'}`);
}
