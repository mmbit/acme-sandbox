// Agent meetings (knowledge note "Threads in order", section 5). An agent asks the CEO for a meeting (hq meeting ask), and
// the CEO sets one from the open asks, or adds an ask to a meeting already holding its agents (hq meeting set, join). A
// meeting's seats are jobs of kind 'meeting', one per agent, that change no files and push nothing. The claim starts
// them together (meetingseats.ts pick): a free slot whose first job is a seat holds it, and the seats start only once every one is held,
// each in its own slot; one not complete within HOLD_MS lets its slots go for REST_MS. In the meeting the seats say lines
// (hq meeting say), read them (hq meeting listen, or the inbox hook between a Claude session's steps), change their own
// plans, and hand those changes in, staying in it. The CEO chairs every meeting, seated in it (meetingchair.ts): it
// watches the progress, reviews the tally of the combined changes once everyone has handed in, sends changes back, and
// alone closes it: a meeting has no time limit. Its transcript is kept: hq meeting <id>, hq search.
// A schedule.yaml entry with `with:` sets one at its time instead of one job (schedule.ts).
import { columnsOf, db, meetingChanges, meetingProjects, once, redacted, takeBack } from './db.ts';
import { publish } from './events.ts';
import { ceo } from './company.ts';
import { createJob, holdsCustomerData, noSeat } from './jobs.ts';
import { claim, codeOf, STANDING } from './jobcodes.ts';
import * as messages from './messages.ts';
import { oneLine } from './agreements.ts';
import { lastSaid } from './meetinggist.ts';
import * as windows from './windows.ts';

// at: when its seats may start (ms); gathering: since when its seats hold slots (ms); rests: until when it holds none
// after a gathering that didn't complete (ms); schedule: the schedule.yaml entry that set it. status: planned, live,
// done. before: the threads' outlooks as it went live, tally: the play once every seat handed in (JSON, meetingchair.ts
// tally); summary and headline: the chair's post for the news feed at the close; why: why it ended.
// A seat: its agent's job (kind 'meeting'), the ask that brought it, the slot holding it while the meeting gathers,
// since when it has handed in its plan changes (null while it's still changing them) and its line of what it changed,
// the last line it read (listen, the inbox hook) and that mark as it handed in (handed_read: taking the hand-in back
// reads on from there). A line: who said it, and the seats it's to (tagged, a JSON list), which a handed-in seat hears.
db.exec(`create table if not exists meetings (id integer primary key, topic text not null, brief text,
  status text not null default 'planned', at integer not null, called_by text not null,
  created text not null, started text, ended text, gathering integer, rests integer, schedule text, before text,
  tally text, summary text, headline text, why text);
create table if not exists meeting_seats (meeting integer not null, agent text not null, job integer not null,
  slot text, runner text, handed text, changed text, handed_read integer, read integer not null default 0, offered integer not null default 0,
  offered_at integer, primary key (meeting, agent));
create table if not exists meeting_lines (id integer primary key, meeting integer not null, at text not null,
  agent text not null, text text not null, tagged text);
create table if not exists meeting_asks (id integer primary key, created text not null, agent text not null, job integer,
  topic text not null, agents text not null, by integer, status text not null default 'open', meeting integer, why text)`);
redacted('meeting_lines', 'text');
redacted('meeting_asks', 'topic', 'why');
// No time limit, the hand-in, the tally, the summary, in an older database.
once('2026-10-20-meetings-hand-in', () => {
  if (columnsOf('meetings').includes('limit_min')) db.exec('alter table meetings drop column limit_min');
  for (const column of ['before', 'tally', 'summary', 'why'])
    if (!columnsOf('meetings').includes(column)) db.exec(`alter table meetings add column ${column} text`);
  if (columnsOf('meeting_seats').includes('left')) db.exec('alter table meeting_seats rename column left to handed');
  if (!columnsOf('meeting_seats').includes('handed_read'))
    db.exec('alter table meeting_seats add column handed_read integer');
  if (!columnsOf('meeting_lines').includes('tagged')) db.exec('alter table meeting_lines add column tagged text');
});
redacted('meetings', 'topic', 'brief', 'summary', 'headline');

// The CEO's batched job for asks heard outside a session: one queued at a time, which reads every open ask as it runs.
export const ASKS_TITLE = 'Meeting asks';

export type Meeting = {
  id: number;
  topic: string;
  brief: string | null;
  status: 'planned' | 'live' | 'done';
  at: number;
  called_by: string;
  created: string;
  started: string | null;
  ended: string | null;
  gathering: number | null;
  rests: number | null;
  schedule: string | null;
  before: string | null;
  tally: string | null;
  summary: string | null;
  headline: string | null;
  why: string | null;
};
export type Seat = {
  meeting: number;
  agent: string;
  job: number;
  slot: string | null;
  runner: string | null;
  handed: string | null;
  changed: string | null;
  handed_read: number | null;
  read: number;
  offered: number;
  offered_at: number | null;
};
type Ask = {
  id: number;
  created: string;
  agent: string;
  job: number | null;
  topic: string;
  agents: string;
  by: number | null;
  status: 'open' | 'met' | 'dropped';
  meeting: number | null;
  why: string | null;
};
export type Line = { id: number; meeting: number; at: string; agent: string; text: string; tagged: string | null };

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
export const meeting = (id: number) => db.prepare('select * from meetings where id = ?').get(id) as Meeting | undefined;
export const seats = (id: number) =>
  db.prepare('select * from meeting_seats where meeting = ? order by rowid').all(id) as Seat[];
// The seats whose job is still queued or running: those in the meeting (one whose job ended is gone)
export const stillIn = (id: number) =>
  seats(id).filter(x => !!db.prepare("select 1 from jobs where id = ? and status in ('queued', 'running')").get(x.job));
export const seatOfJob = (job: number) =>
  db.prepare('select * from meeting_seats where job = ?').get(job) as Seat | undefined;
export const askOf = (id: number) => db.prepare('select * from meeting_asks where id = ?').get(id) as Ask | undefined;
const agentsOf = (a: Ask) => [a.agent, ...(JSON.parse(a.agents) as string[])];
// The asks set as a meeting or joined to it: its agenda
export const agenda = (a: Ask) =>
  `${a.agent} asked to meet ${(JSON.parse(a.agents) as string[]).join(', ')}: ${a.topic}`;
export const asksOf = (id: number) =>
  db.prepare('select * from meeting_asks where meeting = ? order by id').all(id) as Ask[];
// What a job says reaches a meeting (an ask, a topic, a line, what it changed) only while it holds no customer's own
// details (house rule 7): every seat and every transcript reader would get them, with no check on who may.
export const holdsCustomers = (job: number) =>
  holdsCustomerData(job)
    ? `job #${job} holds a customer's own details, and what it says in a meeting reaches every seat and the transcript: ` +
      'they stay in this job. Ask, say or leave from a job that holds none, without them'
    : null;

// ---- asking

// hq meeting ask: `from` asks the CEO for a meeting with `with` about `topic`, by a time if given. The CEO hears it in
// the running session (the inbox hook), else in one queued job that reads every open ask (ASKS_TITLE).
export function ask(
  from: { agent: string; job: number },
  o: { topic?: unknown; with?: unknown; by?: unknown },
  mayTake: (agent: string) => boolean,
  now = Date.now(),
) {
  const customers = holdsCustomers(from.job);
  if (customers) return customers;
  const topic = oneLine(String(o.topic ?? ''));
  if (!topic) return 'say what to settle';
  const named = Array.isArray(o.with) ? [...new Set(o.with.map(String))].filter(a => a !== from.agent) : [];
  if (!named.length) return 'name the colleagues to meet: --with <agent>';
  const stranger = named.find(a => !mayTake(a));
  if (stranger) return `${stranger} isn't a colleague in org.yaml who can meet`;
  let by: number | null = null;
  if (o.by != null) {
    const at = windows.parse(String(o.by), now);
    if (typeof at === 'string') return `--by ${at}`;
    by = at;
  }
  const { lastInsertRowid } = db
    .prepare('insert into meeting_asks (created, agent, job, topic, agents, by) values (?, ?, ?, ?, ?, ?)')
    .run(new Date(now).toISOString(), from.agent, from.job, topic, JSON.stringify(named), by);
  const id = Number(lastInsertRowid);
  publish({ type: 'log', agent: from.agent, text: `Asked for a meeting with ${named.join(', ')}: ${topic}` });
  return { id, heard: tellCeo(from, id, topic, named) };
}

function tellCeo(from: { agent: string; job: number }, id: number, topic: string, named: string[]) {
  const boss = ceo();
  const running = messages.runningSession(boss);
  if (running && running.id !== from.job) {
    const said = messages.send(
      from,
      boss,
      `Meeting ask #${id} from ${from.agent} with ${named.join(', ')}: ${topic}\n\n` +
        'hq meeting asks shows it with the meetings already holding its agents; hq meeting set, join or drop.',
      running.id,
    );
    if (typeof said === 'object' && said.state === 'queued') return 'session';
  }
  const waiting = db
    .prepare("select id from jobs where agent = ? and title = ? and status = 'queued' and session is null")
    .get(boss, ASKS_TITLE);
  // (word: its task code's, jobcodes.ts.)
  if (!waiting)
    createJob({ agent: boss, word: STANDING.meetingAsks, title: ASKS_TITLE, thread: null, prompt: ASKS_PROMPT });
  return 'job';
}

// (--code)
const ASKS_PROMPT = `Colleagues asked you for meetings. Read them with \`hq meeting asks\`: each ask with the planned or live
meetings already holding any of its agents. For each: add it to such a meeting (\`hq meeting join <meeting> <ask>\`)
rather than set a second one, set a meeting for one or several asks (\`hq meeting set <ask>... "topic" --code WORD
[--at <time>]\`, before its --by: WORD for what it settles, its seats' task code), or drop it with why (\`hq meeting
drop <ask> "why"\`). A short job: settle the asks and stop.`;

// hq meeting asks: the open asks, each with the planned and live meetings already holding any of its agents
export function openAsks() {
  const held = db
    .prepare(
      `select m.id, m.topic, m.status, m.at, m.started, (select json_group_array(agent) from (select agent from meeting_seats
    where meeting = m.id order by rowid)) agents from meetings m where m.status in ('planned', 'live') order by m.at, m.id`,
    )
    .all() as { id: number; topic: string; status: string; at: number; started: string | null; agents: string }[];
  return (db.prepare("select * from meeting_asks where status = 'open' order by id").all() as Ask[]).map(a => {
    const agents = agentsOf(a);
    return {
      id: a.id,
      created: a.created,
      agent: a.agent,
      topic: a.topic,
      with: JSON.parse(a.agents) as string[],
      by: iso(a.by),
      overlap: held
        .filter(m => (JSON.parse(m.agents) as string[]).some(x => agents.includes(x)))
        .map(m => ({
          meeting: m.id,
          topic: m.topic,
          status: m.status,
          at: m.started ?? iso(m.at),
          seats: JSON.parse(m.agents),
        })),
    };
  });
}

const openAsk = (id: number): Ask | string => {
  const a = askOf(id);
  if (!a) return `there's no meeting ask #${id} (hq meeting asks)`;
  return a.status === 'open'
    ? a
    : `meeting ask #${id} was ${a.status === 'met' ? `set as meeting #${a.meeting}` : 'dropped'} already`;
};
const onlyCeo = (by: string) =>
  by === ceo() ? null : `only the CEO (${ceo()}) sets meetings: ask with hq meeting ask`;

// hq meeting set: the CEO sets a meeting for the asks, their agents its seats, at a time (now if none).
// (code: the word of its task code, the CEO's as it sets it: jobcodes.ts claim.)
export function set(
  ids: unknown,
  topic: unknown,
  at: unknown,
  by: { agent: string; job: number; code: unknown },
  now = Date.now(),
) {
  const refused = onlyCeo(by.agent) ?? holdsCustomers(by.job);
  if (refused) return refused;
  const list = Array.isArray(ids) ? [...new Set(ids.map(Number))] : [];
  if (!list.length) return 'name the asks it settles: hq meeting set <ask>... "topic"';
  const asks: Ask[] = [];
  for (const id of list) {
    const a = openAsk(id);
    if (typeof a === 'string') return a;
    asks.push(a);
  }
  let when = now;
  if (at != null) {
    const t = windows.parse(String(at), now);
    if (typeof t === 'string') return `--at ${t}`;
    when = t;
  }
  const named = claim(by.code, null);
  if ('refused' in named) return named.refused;
  const made = create(
    { topic, agents: [...new Set(asks.flatMap(agentsOf))], at: when, calledBy: by.agent, asks, code: named.code },
    now,
  );
  if (typeof made === 'string') return made;
  return { meeting: made.id, at: iso(when), seats: made.seats };
}

// A meeting with a seat for each agent (its job queued for `at`), from asks (who brought whom) or a brief (schedule.ts),
// and one for the CEO, its chair, if it isn't one of them.
export function create(
  o: {
    topic: unknown;
    agents: string[];
    at: number;
    calledBy: string;
    asks?: Ask[];
    brief?: string;
    schedule?: string;
    code: string | undefined; // (its seats' task code: jobcodes.ts.)
  },
  now = Date.now(),
): { id: number; seats: { agent: string; job: number }[] } | string {
  const topic = oneLine(String(o.topic ?? ''));
  if (!topic) return 'a meeting needs a topic';
  const agents = [...new Set([...o.agents, ceo()])];
  if (agents.length < 2) return 'a meeting needs two agents or more';
  const unseated = agents.map(a => noSeat(a)).find(Boolean);
  if (unseated) return unseated;
  const { lastInsertRowid } = db
    .prepare('insert into meetings (topic, brief, at, called_by, created, schedule) values (?, ?, ?, ?, ?, ?)')
    .run(topic, o.brief ?? null, o.at, o.calledBy, new Date(now).toISOString(), o.schedule ?? null);
  const id = Number(lastInsertRowid);
  const seated = agents.map(agent => seat(id, topic, agent, o.at, o.code));
  for (const a of o.asks ?? [])
    db.prepare("update meeting_asks set status = 'met', meeting = ? where id = ?").run(id, a.id);
  publish({ type: 'log', agent: o.calledBy, text: `Meeting #${id} set with ${agents.join(', ')}: ${topic}` });
  return { id, seats: seated };
}

function seat(id: number, topic: string, agent: string, at: number, code: string | undefined) {
  // (its prompt is written as it starts: briefing, from the plans as they are then)
  const job = createJob({
    agent,
    kind: 'meeting',
    code,
    title: `Meeting #${id}: ${topic}`,
    prompt: '',
    thread: null,
  }).id;
  db.prepare('update jobs set not_before = ? where id = ?').run(at, job);
  db.prepare('insert into meeting_seats (meeting, agent, job) values (?, ?, ?)').run(id, agent, job);
  return { agent, job };
}

// hq meeting join: the CEO adds an ask to a planned or live meeting's agenda, and its agents not seated yet. A seat added
// to a live meeting starts as soon as a slot takes it (its briefing has the ask); the seats already in it hear the ask as
// a line of the CEO's.
export function join(id: number, askId: number, by: string) {
  const refused = onlyCeo(by);
  if (refused) return refused;
  const m = meeting(id);
  if (!m || m.status === 'done') return `meeting #${id} isn't planned or live (hq meeting)`;
  const a = openAsk(askId);
  if (typeof a === 'string') return a;
  const there = seats(id).map(s => s.agent);
  const fresh = agentsOf(a).filter(x => !there.includes(x));
  const unseated = fresh.map(x => noSeat(x)).find(Boolean);
  if (unseated) return unseated;
  const code = codeOf(seats(id)[0].job) ?? undefined;
  const added = fresh.map(agent => seat(id, m.topic, agent, m.at, code));
  db.prepare("update meeting_asks set status = 'met', meeting = ? where id = ?").run(id, a.id);
  if (m.status === 'live') {
    const [at, said] = [new Date().toISOString(), `On the agenda now: ${agenda(a)} (ask #${a.id})`];
    db.prepare('insert into meeting_lines (meeting, at, agent, text) values (?, ?, ?, ?)').run(id, at, by, said);
    // (a new item: its agents seated already take it up again, and the tally goes.)
    for (const agent of [by, ...agentsOf(a).filter(x => there.includes(x))]) takeBack(id, agent);
  }
  return { meeting: id, seats: added };
}

// hq meeting drop: the CEO drops an ask, why in a line, which the asker's job hears while it runs.
export function drop(id: number, why: unknown, by: { agent: string; job: number }) {
  const refused = onlyCeo(by.agent) ?? holdsCustomers(by.job);
  if (refused) return refused;
  const a = openAsk(id);
  if (typeof a === 'string') return a;
  const said = oneLine(String(why ?? ''));
  if (!said) return `say why in a line: ${a.agent} reads it`;
  db.prepare("update meeting_asks set status = 'dropped', why = ? where id = ?").run(said, id);
  if (a.job && messages.inSession(a.job))
    messages.send(by, a.agent, `Your meeting ask #${id} ("${a.topic}") was dropped: ${said}`, a.job!);
  return { ok: true as const };
}

// ---- reading

// GET /api/meetings and hq meeting: the live meetings and the planned ones
export function list() {
  const shown = (m: Meeting) => ({
    id: m.id,
    topic: m.topic,
    at: iso(m.at),
    started: m.started,
    chair: ceo(),
    seats: stillIn(m.id).map(s => s.agent),
    // (live: the projects it changed so far, each seat's last line.)
    ...(m.status === 'live' && { projects: meetingProjects(m.id), said: lastSaid(m.id) }),
  });
  const of = (status: string) =>
    (db.prepare('select * from meetings where status = ? order by at, id').all(status) as Meeting[]).map(shown);
  return { live: of('live'), planned: of('planned') };
}

// hq meeting <id>: the meeting with its seats, asks and whole transcript
export function one(id: number) {
  const m = meeting(id);
  if (!m) return 404;
  const asks = asksOf(id).map(a => ({ id: a.id, agent: a.agent, topic: a.topic }));
  return {
    id: m.id,
    topic: m.topic,
    status: m.status,
    at: iso(m.at),
    started: m.started,
    ended: m.ended,
    called_by: m.called_by,
    chair: ceo(),
    brief: m.brief,
    seats: seats(id).map(s => ({ agent: s.agent, job: s.job, handed: s.handed, changed: s.changed })),
    asks,
    lines: (
      db
        .prepare('select id, at, agent, text, tagged from meeting_lines where meeting = ? order by id')
        .all(id) as Line[]
    ).map(({ tagged, ...l }) => ({ ...l, to: tagged ? (JSON.parse(tagged) as string[]) : [] })),
    changes: meetingChanges(id),
    tally: m.tally ? JSON.parse(m.tally) : null,
    summary: m.summary,
    headline: m.headline,
    why: m.why,
  };
}
