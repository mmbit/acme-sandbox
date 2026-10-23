// The call ledger: a call's follow-up records what was said on it (hq item) and hands it out, and hq items shows where
// each item stands. A correction's answer also tells which jobs it cancelled or told (stopped()).
import * as api from './api.ts';
import { isReadable, readTextOrStdin } from './files.ts';
import { minute, present, print, shown, stop, text } from './output.ts';
import { takeItemFlags, takeValues } from './flags.ts';

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
    print(`#${item.id} (call #${item.call}, ${text(item.kind)} for ${text(item.owner)}): ${text(item.what)}${job}`);
  }
}

function itemInFull(item: Record<string, unknown>) {
  const facts = [
    present(item.lines) && `lines ${text(item.lines)}`,
    present(item.due) && `due ${minute(new Date(Number(item.due)).toISOString())} UTC`,
    present(item.job) && `job #${item.job}`,
    present(item.request) && `request #${item.request}`,
    present(item.ref) && `ref ${text(item.ref)}`,
    present(item.replaces) && `replaces #${item.replaces}`,
    present(item.why) && `dropped: ${text(item.why)}`,
  ].filter(fact => fact !== false);
  const quoted = text(item.quote);
  const quote = (quoted === '' ? [] : quoted.split('\n')).map(line => `   > ${line}`).join('\n');
  return [
    `#${item.id} ${text(item.kind)} for ${text(item.owner)}, ${text(item.status)}: ${text(item.what)}`,
    `   ${facts.join(' · ')}`,
    quote,
    '',
  ];
}

const ADD_USAGE =
  'usage: hq item add <kind> <owner> "what" <quote-file | -> [a-b] [--call <id>] [--replaces <item>] [--deadline <when>]';
const REPLACE_USAGE = 'usage: hq item replace <item> "what" <quote-file | -> [a-b] [--call <id>] [--deadline <when>]';
const LINK_USAGE =
  'usage: hq item link <item> job:<id> [--thread <project>/<slug>] | request:<id> | pause:<project or thread> | "<ref>"';
const DROP_USAGE = 'usage: hq item drop <item> "why"';

// (an item's time becomes its work's thread's window)
export const item = {
  help: `
   hq item add <kind> <owner> "what" <quote-file | -> [a-b] [--call <id>] [--replaces <item>] [--deadline <when>]
                                                     record one item (kind: task, decision, briefing, promise or question)
                                                     on the call you follow up (--call: which one, if you follow up more
                                                     than one): "what" is one plain line the board reads; the quote file
                                                     holds the words from the call verbatim (- : on stdin); a-b its
                                                     transcript lines. --replaces (a call's follow-up only): the board
                                                     changed an earlier item; that one is replaced, its jobs that never
                                                     ran are cancelled, and a running one is told at its next step.
                                                     --deadline: the time the board was given for it on the call (a UTC
                                                     time, 14:30 or 2026-10-06T14:30Z; 2h counts from now): the thread of
                                                     the job that carries it (hq job --item) or of the job it's linked to
                                                     takes it as its window (hq window); a correction keeps the
                                                     earlier time
   hq item replace <item> "what" <quote-file | -> [a-b] [--call <id>] [--deadline <when>]
                                                     the same as add --replaces, with the earlier item's kind and owner.
                                                     On a live call (its own token): only an open item, while the board is
                                                     on the line. "Not confirmed" (exit 3, for add too): it may be
                                                     recorded, don't record it again
   hq item link <item> job:<id> [--thread <project>/<slug>] | request:<id> | pause:<project or thread> | "<ref>"
                                                     what shows it's done: a job (handled when it ends done), a pause
                                                     the board agreed (hq thread pause, hq project pause: it carries the
                                                     item, handled already or not), or a request to the board or a ref
                                                     (a DECISIONS.md entry, a note, a commit) saying what your job did:
                                                     then it's your job's work, handled when it ends done with a pull
                                                     request, judged in its review (notes alone too); without one it
                                                     stays open (a question: handled now).
                                                     The call's follow-up, the job that carries the item, or a job of
                                                     roles.asks; a job of yours carries one item, so it takes no second
                                                     (hand that one out).
                                                     An item already handled (or dropped, replaced): the call's follow-up
                                                     links it to note it went through it; nothing about it changes.
                                                     The item's time goes on the job's thread: --thread puts work still
                                                     going on that's in no open thread (none, or one that's done) on that
                                                     open thread first, its reviews and fixes with it (hq thread list)
   hq item drop <item> "why"                         it won't happen, and why (one line the board reads); the call's
                                                     follow-up only (it cancels the item's jobs that never ran and
                                                     tells a running one at its next step)`,

  async run(given: string[]) {
    const { flags, args } = takeItemFlags(given, 'item');
    const [action, ...rest] = args;
    const replaces = flags.replaces === undefined ? null : Number(flags.replaces);
    const callId = flags.call === undefined ? null : Number(flags.call);
    if (action === 'add') {
      if (rest.length < 4) stop(ADD_USAGE);
      const [kind, owner, what, quote, lines = ''] = rest;
      return recordItem({ action, kind, owner, what, quote, lines, replaces, callId, deadline: flags.deadline });
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
      });
    }
    if (flags.deadline !== undefined) {
      stop("--deadline goes with hq item add or replace: a linked item's time goes to the job it's linked to");
    }
    if (action === 'link') return linkItem(rest);
    if (action === 'drop') return dropItem(rest);
    stop('usage: hq item add | replace | link | drop (run hq for details)');
  },
};

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
};

async function recordItem({ action, kind, owner, what, quote, lines, replaces, callId, deadline }: NewItem) {
  const onCall = Boolean(process.env.HQ_CALL);
  // On a live call the words come on stdin (-), never from a file (as for hq job).
  if (onCall && quote !== '-') stop(`hq item ${action} on a call takes no file: the words come on stdin (-)`);
  if (quote !== '-' && !isReadable(quote)) stop(`Nothing recorded: can't read the quote (${quote})`);
  const body = {
    what,
    quote: readTextOrStdin(quote),
    ...(kind !== '' && { kind, owner }),
    ...(lines !== '' && { lines }),
    ...(replaces !== null && { replaces }),
    ...(callId !== null && { call: callId }),
    ...(deadline !== undefined && { deadline }),
  };
  const recorded = await record(body);
  const id = shown(recorded.id);
  // replace: the earlier item's kind and owner
  const recordedKind = text(recorded.kind ?? kind);
  const recordedOwner = text(recorded.owner ?? owner);
  if (onCall) {
    // the call's agent: it's on the list, nobody has it yet
    const noted = `Noted as ${recordedKind} #${id} on this call, for ${recordedOwner}`;
    if (replaces === null) print(`${noted}.`);
    else print(`${noted}: it replaces #${replaces} (${text(recorded.replacedWhat ?? '?')}), which the board changed.`);
    print("It's on the call's list, not handed to anyone yet: after the call, the follow-up hands it out.");
    if (replaces !== null) print(...stoppedOnCall(recorded));
    return;
  }
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
  const { values, args } = takeValues(given, ['--thread'], 'Not linked');
  const { thread } = values;
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
  const answer = await api.call('item-link', { body: { id: Number(id), to, ...(thread !== undefined && { thread }) } });
  const linked = api.parseOrNull(answer.body) ?? {};
  const status = shown(linked.status);
  if (status === '') refused(answer.body, 'Not linked');
  if (shown(linked.acknowledged) === 'true') {
    print(
      `Item #${id} is ${status} already: noted that this follow-up went through it (nothing about it changed, ${target} isn't stored).`,
    );
  } else if (status === 'handled') {
    print(`Item #${id} is handled (${target}).`);
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
    print(`Its time is the deadline of ${text(linked.thread)} now: ${minute(String(linked.deadline))} UTC.`);
  print(...stopped(linked));
}

async function dropItem([id, why]: string[]) {
  if (!/^[0-9]+$/.test(id ?? '') || !why) stop(DROP_USAGE);
  const answer = await api.call('item-drop', { body: { id: Number(id), why } });
  const dropped = api.parseOrNull(answer.body) ?? {};
  if (shown(dropped.ok) !== 'true') refused(answer.body, 'Not dropped');
  print(`Item #${id} is dropped: ${why}`, ...stopped(dropped));
}

// A refusal says why in the coordinator's words. "not found": not a call or item this job works for.
function refused(body: string, what: string): never {
  const why = api.errorIn(body);
  stop(`${what}: ${(why === 'not found' ? "it isn't on a call this job works for" : why) || 'no answer'}`);
}

type Stopped = { cancelled?: number[]; told?: { job: number; message: number; became?: number }[]; running?: number[] };

const jobList = (ids: number[]) => ids.map(id => `#${id}`).join(', ');

// A correction's answer (hq item add --replaces, link, drop, hq job --item): the replaced or dropped item's jobs that
// never ran (cancelled), the running ones told, and those not told yet (the coordinator sends it again: ledger.ts tell()).
export function stopped({ cancelled = [], told = [], running = [] }: Stopped) {
  const lines: string[] = [];
  if ((cancelled ?? []).length > 0) lines.push(`Cancelled (never ran): ${jobList(cancelled)}.`);
  for (const { job, message, became } of told ?? []) {
    if (present(became)) {
      lines.push(
        `#${job} can't take a message mid-job (it waits for the board, or runs on Codex): the correction is job #${became} for its agent now (message #${message}).`,
      );
    } else {
      lines.push(
        `Told #${job}: the correction is queued for its session, which reads it at its next step (message #${message}; check: hq sent ${message}).`,
      );
    }
  }
  if ((running ?? []).length > 0) {
    lines.push(
      `Running and not told yet (the message was refused: this job's 30 messages an hour, or a full chain of messages): ${jobList(running)}. It's kept: the coordinator sends it once it can, within minutes of the limit allowing, while that job runs. Nothing to resend.`,
    );
  }
  return lines;
}

function stoppedOnCall({ cancelled = [], running = [] }: Stopped) {
  const lines: string[] = [];
  if ((cancelled ?? []).length > 0) lines.push(`Cancelled (never ran): ${jobList(cancelled)}.`);
  if ((running ?? []).length > 0) {
    lines.push(
      `Already running, so it runs on: ${jobList(running)}. It hears the correction from the call's follow-up, when it goes through this item or ends.`,
    );
  }
  return lines;
}
