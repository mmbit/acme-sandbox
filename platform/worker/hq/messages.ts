// What an agent shows and says: its status above its head in HQ, messages to colleagues (hq say, hq sent), and the hook
// that brings a job its own messages (hq inbox --hook).
import * as api from './api.ts';
import { additionsHead, colleaguesHead, guestsHead, intercomHead, meetingHead, partnersHead } from './inboxheads.ts';
import { readWords } from './files.ts';
import { sayOnCall } from './sayoncall.ts';
import { minute, present, print, printWritten, shown, stop, text } from './output.ts';

export const status = {
  help: `
   hq [--as id] status "what I'm doing"              show it above my head in HQ`,

  async run([words]: string[]) {
    if (words === undefined) stop('usage: hq status "what I\'m doing"');
    const body = api.withSpeaker({ type: 'status', state: 'working', text: words });
    const code = api.httpCode((await api.orNoAnswer(api.call('event', { body, timeoutMs: 30_000 }))).status);
    if (code === '200') return;
    if (code === '403') {
      stop(
        "hq status: not shown. --as takes only a team member of this job, by the id HQ registered when its lead started it: the Agent call's name, or its description where the tool has no name. A colleague's name (anyone in company/org.yaml's departments) is never registered: start the member under a new name.",
      );
    }
    stop(`hq status: HQ didn't answer (${code}). Not shown.`);
  },
};

export const say = {
  help: `
   hq [--as id] say <agent> --job <n> "message"      a message to a colleague (an agent in company/org.yaml, or an alumnus;
                                                     teammates in your own session: use SendMessage) about their job #n
                                                     (the number your brief or hq jobs gives): only that job's session
                                                     gets it, at its next step, or when it starts.
   hq [--as id] say [<agent>] --deliverable <project>/<slug> "message"
                                                     every session live on that deliverable (only the agent's, if named);
                                                     with none, a job on it for the agent, else its owner.
   hq [--as id] say <agent> "message"                naming no job: their running session, or every one when several
                                                     run. A copy that went to several says so, and is for whichever
                                                     it applies to; if none reads it, one becomes a job.
                                                     HQ keeps it and says what happened. CEO messages stay for the next
                                                     run, even while a pause holds work. Other idle recipients, or those whose job ends
                                                     unread, get a new job (added to the one your earlier message
                                                     made, if that hasn't started yet). A message's job starts once its
                                                     project's owner (else the CEO) has sorted it into the plan, named for
                                                     what it does. "-" as the message reads it from stdin.
                                                     --needs-answer: you need the answer during this job. If HQ makes a
                                                     job, it runs on its own in your project, outside your task order.
                                                     It still waits for its owner's sort and available capacity.
                                                     Up to 8000 characters; longer work goes by hq job. A chain of
                                                     messages may start 3 jobs; past that, only a running job gets one.
                                                     "Not confirmed" (exit 3): it may have gone; check hq sent, don't resend.
                                                     On a call: hq say <agent> - --job <n> --what "line" --goal -, the
                                                     board's word to a job or review under way (the reach tool), and why
                                                     the board wants it: both on stdin, as JSON {"goal": "...",
                                                     "words": "..."}.`,

  async run(args: string[]) {
    if (process.env.HQ_CALL) return sayOnCall(args);
    const { needsAnswer, job, deliverable, rest } = sayFlags(args);
    const named = deliverable === undefined ? rest.length === 2 : rest.length === 1 || rest.length === 2;
    if (!named || (job !== undefined && !/^[0-9]+$/.test(job)))
      stop(
        'usage: hq say [--needs-answer] <agent> --job <n> "message", [<agent>] --deliverable <project>/<slug> "message", or <agent> "message"   (- reads the message from stdin)',
      );
    const [to, given] = rest.length === 2 ? rest : [undefined, rest[0]];
    const words = given === '-' ? readWords('-') : given;
    const about = {
      ...(job === undefined ? {} : { job: Number(job) }),
      ...(deliverable === undefined ? {} : { deliverable }),
    };
    let answer;
    try {
      answer = await api.call('message', {
        body: api.withSpeaker({ to, text: words, ...about, ...(needsAnswer ? { needsAnswer: true } : {}) }),
        timeoutMs: 30_000,
      });
    } catch (error) {
      // Only a refusal or no connection at all proves nothing was sent. Anything else (a dropped connection, a server
      // error) may come after HQ saved the message and made a job: a retry would do it twice.
      if (!(error instanceof api.ApiError)) throw error;
      if (error.sentNothing) stop("hq say: couldn't reach HQ. Nothing was sent.");
      answer = { status: 0, body: '' };
    }
    if (answer.status === 200) return print(said(to ?? 'its owner', api.parseOrNull(answer.body), deliverable));
    stop(...sayRefusal(answer.status, to ?? 'its owner', words, api.errorIn(answer.body)));
  },
};

// hq say's flags, anywhere before the message: --needs-answer, and the work it's about (--job or --deliverable).
function sayFlags(args: string[]) {
  const rest: string[] = [];
  let needsAnswer = false,
    job: string | undefined,
    deliverable: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--needs-answer') needsAnswer = true;
    else if (args[i] === '--job' && job === undefined) job = args[++i] ?? '';
    else if (args[i] === '--deliverable' && deliverable === undefined && job === undefined)
      deliverable = args[++i] ?? '';
    else rest.push(args[i]);
  }
  return { needsAnswer, job, deliverable, rest };
}

type Said = {
  id: number;
  state: string;
  job?: number;
  waiting?: boolean;
  named?: string;
  sessions?: { message: number; job: number; agent: string }[];
  why?: string;
  added?: number;
  chain_full?: boolean;
  call?: number;
};

// (and a call with the board the recipient is on hears it too, within about 15 s: the coordinator's callmessages.ts offer.
function said(to: string, sent: Said, deliverable?: string) {
  const where = delivery(to, sent, deliverable);
  return present(sent.call)
    ? `${where}\n${to} is on call #${shown(sent.call)} with the board: the call hears it too, with ${to}'s next turn there.`
    : where;
}

function delivery(
  to: string,
  { id, state, job, why, added, chain_full, waiting, named, sessions }: Said,
  deliverable?: string,
) {
  const check = `Check: hq sent ${id}`;
  if (sessions) {
    const copies = sessions.map(s => `${s.agent}'s job #${s.job} (message #${s.message})`).join(', ');
    const unread =
      chain_full === true
        ? 'if none reads it, it lapses: it comes from a chain of messages that has started 3 jobs, the most one may'
        : 'if none reads it, one copy becomes a job';
    return `Sent to ${text(named)}: every session live on that has a copy, ${copies}. Each reads it at its next step, with who it went to, and acts on it only if it applies to its work; ${unread}. ${check}`;
  }
  if (state === 'queued' && waiting === true) {
    return `Queued for ${to}'s job #${job}, which isn't running now: its session reads it at its first step when it starts or resumes. ${check}`;
  }
  if (why === 'next-run') {
    return `Kept for ${to}: ${job ? `job #${job} reads it at its next step` : 'the next run reads it'}, even while a pause holds work. If unread, it stays for the following run. ${check}`;
  }
  if (state === 'job' && present(added)) {
    return `${to} has no running job that can read it now: it's added to job #${job}, which your message #${added} became and which hasn't started yet, so it runs with that one (message #${id}). ${check}`;
  }
  if (state === 'queued' && chain_full === true) {
    return `Queued for ${to}'s running job #${job}: it reads it at its next step. If the job ends first, it won't become a new job: it comes from a chain of messages that has started 3 jobs, the most one may (hq sent will say it wasn't read). ${check}`;
  }
  if (state === 'queued') {
    return `Queued for ${to}'s running job #${job}: it reads it at its next step; if the job ends first it becomes a new job. ${check}`;
  }
  if (why === 'deliverable') {
    return `Nobody is working on ${text(deliverable)} now: it's job #${job} for ${to} on that deliverable (message #${id}), which starts once it's sorted into the plan. ${check}`;
  }
  if (why === 'codex') {
    return `${to}'s running job is on Codex, which can't take a message mid-job: it's job #${job} now (message #${id}), which starts once it's sorted into the plan. ${check}`;
  }
  // (sorted: the coordinator's sorting.ts.)
  return `${to} has no running job: it's job #${job} now (message #${id}), which starts once it's sorted into the plan. ${check}`;
}

function sayRefusal(status: number, to: string, words: string, error = ''): [string, number] {
  switch (status) {
    case 400:
      return ['hq say: the message is empty. Nothing was sent.', 1];
    case 403:
      return [
        "hq say: not allowed. --as takes only a team member of this job, never a colleague's name, and a call has no hq say (use hq job). Nothing was sent.",
        1,
      ];
    case 409:
      return [
        `hq say: ${to} has no running job that can read a message now, so it would start a new job, and this job is the last of the 3 a chain of messages may start. Nothing was sent. If ${to} must act on it, hand it over with hq job <agent> "title" <file>; a thanks or an acknowledgement needs no message.`,
        1,
      ];
    case 404:
      return [
        `hq say: "${to}" isn't a colleague who runs jobs (an agent in company/org.yaml or an alumnus). Nothing was sent. A teammate in your own session: use SendMessage. The board: hq ask.`,
        1,
      ];
    case 413:
      return [
        `hq say: the message is ${Buffer.byteLength(words)} characters, over the 8000 a message may have. Nothing was sent: shorten it, or hand the work over with hq job <agent> "title" <file>.`,
        1,
      ];
    case 429:
      return ['hq say: this job has sent 30 messages in the last hour, the most it may. Nothing was sent.', 1];
  }
  // (HQ's own words where it says why, e.g. a colleague no job runs as)
  if (api.isRefusal(status))
    return [`hq say: ${error || `HQ didn't take the message (HTTP ${status})`}. Nothing was sent.`, 1];
  return [
    `hq say: not confirmed (HTTP ${api.httpCode(status)}): HQ may have taken the message, and made a job of it, already. Don't send it again: check hq sent first.`,
    3,
  ];
}

export const sent = {
  help: `
   hq [--as id] sent [id]                            your sent messages and what became of each: waiting for job #n,
                                                     offered to job #n (not confirmed yet), delivered to job #n at
                                                     <time>, became job #n or was added to it (and how that job stands),
                                                     or never read;
                                                     with an id, that message in full`,

  async run([id]: string[]) {
    const query: string[] = [];
    if (id) {
      if (!/^[0-9]+$/.test(id)) stop('usage: hq sent [id]');
      query.push(`id=${id}`);
    }
    if (api.speaker()) query.push(`as=${api.uri(api.speaker())}`);
    const sender = api.speaker() || 'you';
    let list: string;
    try {
      list = await api.get(query.length > 0 ? `sent?${query.join('&')}` : 'sent');
    } catch (error) {
      if (!(error instanceof api.ApiError)) throw error;
      stop(id ? `No message #${id} sent by ${sender}.` : "hq sent: HQ didn't answer.");
    }
    print(...JSON.parse(list).map(sentLine));
    if (!id && list.replace(/\n+$/, '') === '[]') print(`No messages sent by ${sender} yet.`);
  },
};

type SentMessage = {
  id: number;
  to: string;
  created: string;
  job: number;
  job_status?: string | null;
  joined?: number;
  became?: number;
  delivered?: string;
  lapsed?: boolean;
  offered?: string;
  text?: string;
  first?: string;
  call?: number;
  needsAnswer?: boolean;
  fan?: number;
};

function sentLine(message: SentMessage) {
  const content = present(message.text) ? `\n\n${text(message.text)}` : `\n    ${text(message.first)}`;
  const onCall = present(message.call) ? ` (on call #${message.call})` : '';
  const needed = message.needsAnswer ? " (answer needed during the caller's run)" : '';
  return `#${message.id} to ${message.to}, ${minute(message.created)}${onCall}${needed}: ${whatBecameOf(message)}${content}`;
}

function whatBecameOf(message: SentMessage) {
  const { job } = message;
  const jobStatus = message.job_status ?? 'gone';
  if (present(message.joined)) {
    return `added to job #${message.became} (${jobStatus}), which your message #${message.joined} became, before it started`;
  }
  if (present(message.became)) return `became job #${message.became} (${jobStatus})`;
  if (present(message.delivered)) return `delivered to job #${job} at ${minute(message.delivered)}`;
  if (present(message.lapsed) && present(message.fan)) {
    return `not read in job #${job}, which ended first: it was one copy of message #${message.fan}, and another copy was read, became a job or still waited for a session`;
  }
  if (present(message.lapsed)) {
    return `never read: job #${job} ended first, and its chain of messages had started 3 jobs already, so it didn't start another`;
  }
  if (present(message.offered) && message.job_status === 'running') {
    return `offered to job #${job}'s session at ${minute(message.offered)}, not confirmed yet: if it didn't arrive, a later step gets it again`;
  }
  if (job == null) return 'kept for the next run, even while a pause holds work';
  if (message.job_status === 'running') {
    return `waiting for job #${job}, which is running: its session gets it at its next step`;
  }
  return `waiting for job #${job} (${jobStatus}): its session gets it when the job runs again`;
}

export const inbox = {
  help: `
   hq inbox --hook                                   (your CLI runs this for you: it brings your messages into the session)`,

  // Claude Code runs this after each tool call and before the session stops (the worker's --settings), with the hook's
  // JSON on stdin; a Codex work run after each tool call only (its hooks.json: inbox.ts). Only the job's own thread takes its mail (a team member's tool call carries agent_id).
  // Two steps, at least once: HQ offers the waiting messages; this prints them and, once the session's pipe has them,
  // acknowledges their ids. Only that ack marks them delivered. A failure before the print is written sends no ack: the
  // messages wait. A lost ack: the session has them, and HQ offers them again at a later step (or makes them a job if
  // the run ends first), so they can arrive twice, but are never lost. Both calls together (10 s each) stay well inside
  // the hook's 30 s (platform/worker/src/inbox.ts), so Claude Code doesn't kill the hook between its ack and its exit.
  async run([flag]: string[]) {
    if (flag !== '--hook') stop('usage: hq inbox --hook (Claude Code runs it for the worker; see hq say)');
    const event = hookEvent(readWords('-'));
    if (event === undefined) return;
    let messages: InboxMessage[];
    try {
      const answer = await api.call('inbox', { body: { stopping: event === 'Stop' }, timeoutMs: 10_000 });
      if (answer.status >= 400) return;
      messages = JSON.parse(answer.body);
    } catch {
      return; // the messages wait for the next step
    }
    if (!Array.isArray(messages) || messages.length === 0) return;
    await printWritten(JSON.stringify(hookOutput(event, messages)));
    // (a meeting's lines by their line ids: HQ marks them read only now.)
    const ids = messages.map(message => message.message).filter(present);
    const lines = messages.filter(message => present(message.meeting)).map(message => message.line);
    const chat = messages.filter(message => present(message.chat)).map(message => message.chat);
    const disk = messages.map(message => message.disk).filter(present);
    if (ids.length === 0 && lines.length === 0 && disk.length === 0 && chat.length === 0) return;
    // A lost ack is fine: HQ offers the messages and lines again at a later step.
    await api.orNoAnswer(
      api.call('inbox-ack', {
        body: {
          ids,
          ...(lines.length ? { lines } : {}),
          ...(disk.length ? { disk } : {}),
          ...(chat.length ? { chat } : {}),
        },
        timeoutMs: 10_000,
      }),
    );
  },
};

// A message, a line said in the job's meeting (hq meeting say), or HQ's word on the server's memory (the coordinator's
// lowmemory.ts).
type InboxMessage = {
  message?: number;
  memory?: number;
  disk?: string;
  text?: string;
  guest?: unknown;
  partner?: unknown;
  call?: unknown;
  meeting?: number;
  chat?: number;
  line?: number;
  from?: string;
};

// The hook's event, or undefined when the call is a team member's (its tool call carries agent_id) or can't be read.
function hookEvent(hookInput: string): string | undefined {
  if (hookInput.trim() === '') return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(hookInput);
  } catch {
    return undefined;
  }
  if (parsed === null) return 'PostToolUse';
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const { agent_id, hook_event_name } = parsed as { agent_id?: unknown; hook_event_name?: unknown };
  if (shown(agent_id) !== '') return undefined;
  return present(hook_event_name) ? text(hook_event_name) : 'PostToolUse';
}

const OTHER_KINDS: (keyof InboxMessage)[] = ['guest', 'partner', 'call', 'meeting', 'chat', 'memory', 'disk'];

// The messages go in as JSON (data, in an envelope their text can't close), after a line saying what they are: a
// colleague's (hq say), the board's addition on a call (call.ts addToJob), a line said in the job's meeting (hq meeting
// say), or a guest's step on their page (hq guest) or a linked company's urgent message (hq workspace), which are outside
// data.
function hookOutput(event: string, messages: InboxMessage[]) {
  const stopping = event === 'Stop';
  const of = (kind: keyof InboxMessage) => messages.filter(message => present(message[kind]));
  const memory = messages.filter(message => present(message.memory) || present(message.disk));
  const colleagues = messages.filter(message => !OTHER_KINDS.some(kind => present(message[kind])));
  const additions = of('call'),
    meetingLines = of('meeting'),
    intercom = of('chat'),
    guests = of('guest'),
    partners = of('partner');
  const sections: [InboxMessage[], string][] = [
    [colleagues, colleaguesHead(colleagues.length)],
    [additions, additionsHead(additions.length)],
    [meetingLines, meetingHead(meetingLines)],
    [intercom, intercomHead(intercom.length)],
    [guests, guestsHead(guests.length)],
    [partners, partnersHead(partners.length)],
  ];
  const shownSections = sections.filter(([group]) => group.length > 0);
  // (HQ's own words, not a colleague's: as they are. It sends none as a session stops.)
  const blocks: string[] = memory.map(message => shown(message.text));
  shownSections.forEach(([group, head], i) => {
    const last = i === shownSections.length - 1;
    blocks.push(
      head +
        (last && stopping
          ? "Your last message is still what this job hands in (its report, or a call's notes): after dealing with this, end by giving it again, whole, not just what you did about the message. "
          : '') +
        'As JSON, one per line:\n' +
        group.map(message => JSON.stringify(message)).join('\n'),
    );
  });
  const context = (stopping ? 'Not an error: before you stop, ' : '') + blocks.join('\n\n');
  if (stopping) return { decision: 'block', reason: context };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}
