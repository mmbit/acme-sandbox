// Meetings of agents (hq meeting): an owner asks the CEO for one, the CEO sets it, and its seats talk, change their own
// plans and hand them in, staying in it. The CEO chairs it: the tally once everyone has handed in, its review, the close.
// It has no time limit. The coordinator's meetings.ts and meetingseats.ts.
import { setTimeout } from 'node:timers/promises';
import * as api from './api.ts';
import { takeValues } from './flags.ts';
import { minute, oneLine, print, stop, text } from './output.ts';

type Ask = {
  id: number;
  created: string;
  agent: string;
  topic: string;
  with: string[];
  by: string | null;
  overlap: { meeting: number; topic: string; status: string; at: string | null; seats: string[] }[];
};
type Seat = { agent: string; job: number };
type Line = { id: number; at: string; agent: string; text: string; to?: string[] };
type Outlook = { finish: number | null; standing: 'misses' | 'gives' | 'holds' | null };
type Tally =
  | { waiting: { job: number; failed: boolean }[] }
  | {
      at: string;
      threads: (Outlook & { id: string; name: string; owner: string; deadline: number | null; was: Outlook | null })[];
    };
type Heard = {
  meeting: number;
  status: 'planned' | 'live' | 'done';
  you: { agent: string; chair: boolean; handed: boolean };
  lines: Line[];
  seats: { agent: string; chair: boolean; handed: boolean; changed: string | null }[];
  // (the chair's alone)
  progress?: {
    minutes: number;
    lines: number;
    change: { by: string; project: string; minutes: number } | null;
    since: number;
  };
  tally?: Tally | null;
};
type Listed = {
  id: number;
  topic: string;
  at: string | null;
  started: string | null;
  chair: string;
  seats: string[];
};
type Change = { at: string; project: string; thread: string | null; what: string; by: string };
type Meeting = {
  id: number;
  topic: string;
  status: string;
  at: string | null;
  started: string | null;
  ended: string | null;
  called_by: string;
  chair: string;
  brief: string | null;
  seats: (Seat & { handed: string | null; changed: string | null })[];
  asks: { id: number; agent: string; topic: string }[];
  lines: Line[];
  changes: Change[];
  tally: Tally | null;
  summary: string | null;
  headline: string | null;
  why: string | null;
};

// How often listen --wait asks again while nothing new is said
const POLL_MS = 2000;

export const meeting = {
  help: `
   hq meeting ask "what to settle" --with <agent>... [--by <time>]
                                                     ask the CEO for a meeting with those agents (--with repeats, or
                                                     takes a comma list), held by --by (2h, 14:30, an ISO time) if given
   hq meeting asks                                   the CEO: the open asks, each with the live or planned meetings
                                                     already holding any of its agents
   hq meeting set <ask>... "topic" --code WORD [--at <time>]
                                                     the CEO sets a meeting for those asks, now or at --at: each agent's
                                                     seat is a job, and all of them start together. WORD says what it
                                                     settles: its seats' task code (as hq job --code)
   hq meeting join <meeting> <ask>                   the CEO adds an ask's agents to a planned or live meeting
   hq meeting drop <ask> "why"                       the CEO drops an ask, with why
   hq meeting say "..." [--to <agent>...]            in a meeting: a line to everyone in it, one point each; --to names
                                                     the seats it's for, which hear it even handed in
   hq meeting listen [--wait <s>]                    in a meeting: the lines since your last read, waiting up to <s>
                                                     seconds for a first one, and who's handed in; the chair also sees
                                                     how long it has run, the lines since its last plan change, and
                                                     the tally once everyone has handed in
   hq meeting hand-in "what I changed"               in a meeting: your plan changes are in (a line of what you
                                                     changed); you stay in it, hearing only lines said to you
   hq meeting withdraw                               take your hand-in back to change more (a plan change does too)
   hq meeting reopen <agent>... "what to change"     the chair: send those seats' changes back, reopening their hand-ins
   hq meeting close --headline "what was decided" --opening "…" --project "name" --decision "…"... [--project ...]
     --next "…" [--stalled]                          the chair: end the meeting after the tally (--stalled: before it),
                                                     its post in HQ's news feed laid out from these parts, one line each
   hq meeting [<id>]                                 the live and planned meetings, or one meeting's whole transcript`,

  async run(given: string[]) {
    const [command, ...rest] = given;
    if (command === 'ask') return askFor(rest);
    if (command === 'asks') return listAsks(rest);
    if (command === 'set') return setMeeting(rest);
    if (command === 'join') return joinMeeting(rest);
    if (command === 'drop') return dropAsk(rest);
    if (command === 'say') return sayLine(rest);
    if (command === 'listen') return listen(rest);
    if (command === 'hand-in') return handIn(rest);
    if (command === 'withdraw') return withdraw(rest);
    if (command === 'reopen') return reopen(rest);
    if (command === 'close') return close(rest);
    if (command === undefined) return listMeetings();
    if (/^[0-9]+$/.test(command) && !rest.length) return showMeeting(command);
    stop(
      'usage: hq meeting ask "what to settle" --with <agent>... [--by <time>], hq meeting asks | set | join | drop | say | listen | hand-in | withdraw | reopen | close ..., or hq meeting [<id>]',
    );
  },
};

async function askFor(given: string[]) {
  const { agents, args: rest } = takeWith(given);
  const { values, args } = takeValues(rest, ['--by'], 'Nothing was asked');
  const [topic, ...extra] = args;
  if (!topic?.trim() || !agents.length || extra.length)
    stop('usage: hq meeting ask "what to settle" --with <agent>... [--by <time>]');
  const body = api.withSpeaker({ topic, with: agents, ...(values.by && { by: values.by }) });
  const made = await answer<{ id: number; heard: 'session' | 'job' }>('meetings/ask', 'Nothing was asked', body);
  const heard = made.heard === 'session' ? 'in their running session now' : 'in a short job';
  print(`Meeting ask #${made.id} is with the CEO, who hears it ${heard}.`);
}

// --with <agent> (or say's --to), repeated or a comma list, taken out before the other arguments are read
function takeWith(given: string[], flag = '--with') {
  const agents: string[] = [];
  const args: string[] = [];
  for (let i = 0; i < given.length; i++) {
    if (given[i] !== flag) {
      args.push(given[i]);
      continue;
    }
    const value = given[++i];
    if (!value?.trim()) stop(`Nothing was ${flag === '--with' ? 'asked' : 'said'}: ${flag} needs an agent`);
    agents.push(
      ...value
        .split(',')
        .map(agent => agent.trim())
        .filter(Boolean),
    );
  }
  return { agents, args };
}

async function listAsks(rest: string[]) {
  if (rest.length) stop('usage: hq meeting asks');
  const asks = await answer<Ask[]>('meetings/asks', "Couldn't read the asks");
  if (!asks.length) return print('No open meeting asks.');
  for (const ask of asks) {
    const by = ask.by ? `, by ${minute(ask.by)} UTC` : '';
    print(
      `#${ask.id} ${text(ask.topic)} (from ${ask.agent} with ${ask.with.join(', ')}${by}, ${minute(ask.created)} UTC)`,
    );
    for (const m of ask.overlap) {
      const when = m.at ? `, ${minute(m.at)} UTC` : '';
      print(
        `    meeting #${m.meeting} ${text(m.topic)} (${m.status}${when}) already holds ${m.seats.join(', ')}: hq meeting join ${m.meeting} ${ask.id}`,
      );
    }
  }
}

// (--code)
async function setMeeting(given: string[]) {
  const { values, args } = takeValues(given, ['--at', '--code'], 'No meeting was set');
  const asks = args.slice(0, -1);
  const topic = args.at(-1);
  if (!asks.length || !asks.every(ask => /^[0-9]+$/.test(ask)) || !topic?.trim())
    stop('usage: hq meeting set <ask>... "topic" --code WORD [--at <time>]');
  const body = { asks: asks.map(Number), topic, code: values.code, ...(values.at && { at: values.at }) };
  const set = await answer<{ meeting: number; at: string; seats: Seat[] }>('meetings/set', 'No meeting was set', body);
  print(`Meeting #${set.meeting} is set for ${minute(set.at)} UTC, with ${seatList(set.seats)}.`);
}

async function joinMeeting([meetingId, askId, ...rest]: string[]) {
  if (!/^[0-9]+$/.test(meetingId ?? '') || !/^[0-9]+$/.test(askId ?? '') || rest.length)
    stop('usage: hq meeting join <meeting> <ask>');
  const body = { meeting: Number(meetingId), ask: Number(askId) };
  const joined = await answer<{ meeting: number; seats: Seat[] }>('meetings/join', 'Not joined', body);
  const added = joined.seats.length ? `, adding ${seatList(joined.seats)}` : ': its agents already had seats';
  print(`Ask #${askId} joins meeting #${joined.meeting}${added}.`);
}

async function dropAsk([askId, why, ...rest]: string[]) {
  if (!/^[0-9]+$/.test(askId ?? '') || !why?.trim() || rest.length) stop('usage: hq meeting drop <ask> "why"');
  await answer('meetings/drop', 'Not dropped', { ask: Number(askId), why });
  print(`Dropped ask #${askId}.`);
}

async function sayLine(given: string[]) {
  const { agents: to, args } = takeWith(given, '--to');
  const [words, ...rest] = args;
  if (!words?.trim() || rest.length) stop('usage: hq meeting say "..." [--to <agent>...]');
  const said = await answer<{ line: number }>('meetings/say', 'Nothing was said', {
    text: words,
    ...(to.length && { to }),
  });
  print(`Said (line #${said.line}).`);
}

// HQ answers at once, so --wait asks again until a line comes, the meeting ends or the time is up.
async function listen(given: string[]) {
  const { values, args } = takeValues(given, ['--wait'], 'Nothing was read');
  if (args.length || (values.wait !== undefined && !/^[0-9]+$/.test(values.wait)))
    stop('usage: hq meeting listen [--wait <seconds>]');
  const until = Date.now() + Number(values.wait ?? 0) * 1000;
  let heard = await answer<Heard>('meetings/listen', 'Nothing was read', {});
  while (!heard.lines.length && heard.status !== 'done' && Date.now() + POLL_MS <= until) {
    await setTimeout(POLL_MS);
    heard = await answer<Heard>('meetings/listen', 'Nothing was read', {});
  }
  print(...(heard.lines.length ? heard.lines.map(spoken) : ['No new lines.']));
  // (printed: HQ marks them read now. A lost answer shows them again at the next listen.)
  if (heard.lines.length)
    await api.orNoAnswer(api.call('meetings/read', { body: { lines: heard.lines.map(line => line.id) } }));
  if (heard.seats.length) print(`In it: ${heard.seats.map(seatState).join('; ')}`);
  if (heard.progress) print(progressLine(heard.progress));
  if (heard.tally !== undefined) print(...tallyLines(heard.tally, heard.seats));
  if (heard.status === 'done') print('The meeting has ended: end your session with a one-line report.');
  else if (heard.you.handed)
    print("You've handed in: wait for lines said to you (hq meeting listen --wait 600) until the chair closes it.");
}

const seatState = (seat: Heard['seats'][number]) =>
  seat.chair
    ? `${seat.agent} (chair)`
    : seat.handed
      ? `${seat.agent} (handed in: ${oneLine(seat.changed ?? '', ' ')})`
      : `${seat.agent} (changing)`;

// What the chair judges the meeting's progress by.
function progressLine(p: NonNullable<Heard['progress']>) {
  const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`;
  const change = p.change
    ? `the last plan change ${p.change.minutes} min ago (${p.change.by}, ${p.change.project}), ${lines(p.since)} since`
    : `no plan change in it yet, ${lines(p.since)} since the start`;
  return `You chair it: running ${p.minutes} min, ${lines(p.lines)} said; ${change}.`;
}

// The tally for the chair: waiting for seats or sizes, or each thread's planned finish against its window, by owner,
// with how it stood when the meeting began
function tallyLines(t: Tally | null, seats: Heard['seats']) {
  if (!t) {
    const out = seats.filter(seat => !seat.chair && !seat.handed).map(seat => seat.agent);
    return [`The tally runs once everyone has handed in${out.length ? ` (still changing: ${out.join(', ')})` : ''}.`];
  }
  if ('waiting' in t) {
    const jobs = (failed: boolean) =>
      t.waiting
        .filter(w => w.failed === failed)
        .map(w => `#${w.job}`)
        .join(', ');
    return [
      `Everyone has handed in: the tally waits for the sizes of ${t.waiting.length} jobs to settle.`,
      ...(jobs(false) ? [`  Still being sized: ${jobs(false)}.`] : []),
      ...(jobs(true) ? [`  The sizer couldn't size ${jobs(true)}: their owners set them (hq estimate set).`] : []),
    ];
  }
  const when = (ms: number | null) =>
    ms === null ? 'no finish in sight' : `${minute(new Date(ms).toISOString())} UTC`;
  const outlook = (o: Outlook) => `${when(o.finish)}${o.standing ? `, ${o.standing}` : ''}`;
  return [
    `The tally (${minute(t.at)} UTC): every thread of the meeting's projects and every windowed one, played with the changes.`,
    ...t.threads.map(
      x =>
        `  ${x.id} (${x.owner}'s): ${outlook(x)}${x.deadline ? ` (deadline ${when(x.deadline)})` : ''}` +
        `${x.was ? `; was ${outlook(x.was)}` : '; new'}`,
    ),
    'Review the whole, then send changes back (hq meeting reopen) or close it (hq meeting close --headline "…" --opening "…" --project "…" --decision "…" --next "…").',
  ];
}

async function handIn([changed, ...rest]: string[]) {
  if (!changed?.trim() || rest.length) stop('usage: hq meeting hand-in "what I changed"');
  const handed = await answer<{ waiting: string[] }>('meetings/hand-in', 'Not handed in', { changed });
  const waiting = handed.waiting.length ? `still changing: ${handed.waiting.join(', ')}` : 'the tally runs next';
  print(
    `Handed in (${waiting}). Stay in the meeting: wait for lines said to you (hq meeting listen --wait 600) until the chair closes it.`,
  );
}

async function withdraw(rest: string[]) {
  if (rest.length) stop('usage: hq meeting withdraw');
  await answer('meetings/withdraw', 'Not withdrawn', {});
  print('Your hand-in is back with you: change what you need, then hand in again (hq meeting hand-in).');
}

async function reopen(given: string[]) {
  const words = given.at(-1);
  const agents = given.slice(0, -1);
  if (!agents.length || !words?.trim()) stop('usage: hq meeting reopen <agent>... "what to change"');
  const said = await answer<{ line: number }>('meetings/reopen', 'Nothing was sent back', { agents, text: words });
  print(`Sent back to ${agents.join(', ')} (line #${said.line}): their hand-ins are open again.`);
}

// (the post in parts, each --decision under the --project before it.)
async function close(given: string[]) {
  const stalled = given.includes('--stalled');
  const usage =
    'usage: hq meeting close --headline "…" --opening "…" --project "name" --decision "…"... [--project ...] --next "…" [--stalled]';
  const post = { headline: '', opening: '', next: '', projects: [] as { name: string; decisions: string[] }[] };
  const parts = given.filter(arg => arg !== '--stalled');
  for (let i = 0; i < parts.length; i += 2) {
    const [flag, value] = [parts[i], parts[i + 1]];
    if (value === undefined) stop(usage);
    if (flag === '--headline') post.headline = value;
    else if (flag === '--opening') post.opening = value;
    else if (flag === '--next') post.next = value;
    else if (flag === '--project') post.projects.push({ name: value, decisions: [] });
    else if (flag === '--decision' && post.projects.length) post.projects.at(-1)!.decisions.push(value);
    else stop(usage);
  }
  await answer('meetings/close', 'Not closed', { ...post, ...(stalled && { stalled }) });
  print(
    "You've closed the meeting, its post in HQ's news feed: whoever was still in it stops. End your session with a one-line report.",
  );
}

async function listMeetings() {
  const { live, planned } = await answer<{ live: Listed[]; planned: Listed[] }>(
    'meetings',
    "Couldn't read the meetings",
  );
  if (!live.length && !planned.length) return print('No live or planned meetings.');
  if (live.length) print('Live:', ...live.map(liveLine));
  if (planned.length) print('Planned:', ...planned.map(plannedLine));
}

function liveLine(m: Listed) {
  const started = m.started ? `started ${minute(m.started)} UTC, ` : '';
  return `  #${m.id} ${text(m.topic)} (${started}chaired by ${m.chair}): ${m.seats.join(', ')}`;
}

function plannedLine(m: Listed) {
  const at = m.at ? `${minute(m.at)} UTC` : 'as soon as every seat can start';
  return `  #${m.id} ${text(m.topic)} (${at}, chaired by ${m.chair}): ${m.seats.join(', ')}`;
}

async function showMeeting(id: string) {
  const m = await answer<Meeting>(`meetings/one?id=${id}`, `No meeting #${id}`);
  const times = [
    m.at && `at ${minute(m.at)} UTC`,
    m.started && `started ${minute(m.started)} UTC`,
    m.ended && `ended ${minute(m.ended)} UTC`,
  ].filter(Boolean);
  print(
    `#${m.id} ${text(m.topic)} (${[m.status, ...times].join(', ')}), called by ${m.called_by}, chaired by ${m.chair}`,
  );
  if (m.brief) print('', text(m.brief));
  print('', 'Seats:', ...m.seats.map(seatLine));
  if (m.asks.length) print('', 'Asks:', ...m.asks.map(ask => `  #${ask.id} from ${ask.agent}: ${text(ask.topic)}`));
  print('', ...(m.lines.length ? m.lines.map(spoken) : ['Nothing said yet.']));
  // (who owns each change, the tally, the end.)
  if (m.changes.length)
    print(
      '',
      'Plan changes made in it:',
      ...m.changes.map(c => `  ${c.by}'s, ${c.thread ?? c.project}: ${oneLine(c.what, ' ')}`),
    );
  if (m.tally) print('', ...tallyLines(m.tally, []));
  if (m.why) print('', `Ended: ${m.why}.`);
  if (m.summary) print('', 'Summary:', ...(m.headline ? [`# ${text(m.headline)}`] : []), text(m.summary));
}

function seatLine(seat: Meeting['seats'][number]) {
  const handed = seat.handed ? `, handed in ${minute(seat.handed)} UTC` : '';
  const changed = seat.changed ? `: ${oneLine(seat.changed, ' ')}` : '';
  return `  ${seat.agent} (job #${seat.job})${handed}${changed}`;
}

// A line said in the meeting, kept to one line so it can't pass for another agent's
const spoken = (line: Line) =>
  `${minute(line.at).slice(11)} ${line.agent}${line.to?.length ? ` to ${line.to.join(', ')}` : ''}: ${oneLine(line.text, ' ')}`;

const seatList = (seats: Seat[]) => seats.map(seat => `${seat.agent} (job #${seat.job})`).join(', ');

// A meeting route's answer: a GET without a body, else a POST. A refusal stops hq with the command's words and HQ's
// reason.
async function answer<T = unknown>(route: string, refused: string, body?: object): Promise<T> {
  const reply = body ? await api.change(route, { body }) : await api.call(route);
  const parsed = api.parseOrNull(reply.body);
  if (!api.isSuccess(reply.status) || parsed === null)
    stop(`${refused}: ${api.errorIn(reply.body, 'no answer') || `HQ answered ${api.httpCode(reply.status)}`}`);
  return parsed as T;
}
