// Messages between colleagues (hq say). Each one is a row, so it can be checked: queued for the recipient's running
// Claude job, whose hook (hq inbox --hook, from the worker's --settings) hands it to the session at its next step; or,
// when nobody can take it in (no running job, a Codex job, a job that ends before it looked), a job of its own.
// Delivery to a session is at least once, in two steps: take() offers the waiting messages to the hook, and only the
// hook's ack (after it printed them) marks them delivered. One offered but never acknowledged is offered again at a
// later step, or becomes a job if the run ends first. So a lost ack can mean a message reaches the session twice, or
// reaches it and also becomes a job; never neither. No message for a session is called delivered before the hook says
// the session has it. The one other delivery: an item's goal or correction for a job that hasn't started and that
// no message made goes into that job's brief, and is delivered as it goes in (toJob).
// A chain of messages (a job started by a message, messaging an idle colleague, whose job does the same...) may
// start CHAIN jobs; past that, a message only reaches a running job, and hq say says so (refused, or no job if unread).
// A guest's step on the guest page (guests.ts: a tick, an answer, a question) travels the same way, as outside data: fromGuest.
// An idle CEO's ordinary colleague messages stay in the inbox for the next run, without starting work held by a pause.
import { columnsOf, db, inOneStep, once, redacted } from './db.ts';
import { publish, redact } from './events.ts';
import { ceo } from './company.ts';
import { createJob, threadOf } from './jobs.ts';
import { findThread } from './projects.ts';
import * as sorting from './sorting.ts';
import * as ledger from './ledger.ts';
import { codeOf } from './jobcodes.ts';
import { oneTaskThread } from './made.ts';
import { outsideJob } from './outsidewords.ts';
import { lead, messageTitle, prompt } from './messagebrief.ts';

// offered: when a hook last took it (not yet acknowledged); depth: how many message-made jobs lie behind its sender's
// job (0: a job nobody's message started); lapsed: its job ended unread, and the chain was too long to start another;
// joined: it was added to the job another message (this one) made, instead of becoming a job of its own (toJob).
// delivered: when the session took it in, or when it went into the brief of the job it's for that hadn't started (toJob).
// guest: a guest's step on the guest page (guests.ts), its request; title: the job it becomes, if it does.
// call: the live call that made this addition to a job it queued (call.ts addToJob); it is the message's sender, as sender_job is a job's.
// customers: marked before 31 Oct as holding a customer's details; the job its words go into keeps the mark (keepsMark).
// held: the owner's notice of this proposal on its running session (proposals.ts tell, deliverFindings): offered unless
// the proposal was decided after it was sent, it lapses unread when the job ends.
// next_run: send chose delivery to the next CEO run, rather than one specific job or independent work.
// goal: the call item whose goal it carries (ledger.ts goalTo): whichever job it is in, or became or joined, hears when
// that item is replaced or dropped (ledger.ts goalHeard). corrects: the call item whose change it tells (ledger.ts tell).
// fan: the first of the copies one message went out as, one per live session on the work it named (messageabout.ts);
// copied_to: who the copies went to, as each copy says it. thread: the deliverable it's about, which the job it becomes
// is on.
db.exec(`create table if not exists messages (id integer primary key, created text not null, sender text not null,
  sender_job integer, recipient text not null, text text not null, job integer, delivered text, became integer,
  offered text, depth integer not null default 0, lapsed text, joined integer, guest integer, title text, call integer,
  customers integer not null default 0, held integer, needs_answer integer not null default 0, goal integer, corrects integer, next_run integer not null default 0, partner integer,
  fan integer, copied_to text, thread text)`);
redacted('messages', 'text');
once('2026-10-22-messages-held', () => {
  if (!columnsOf('messages').includes('held')) db.exec('alter table messages add column held integer');
});
once('2026-10-24-messages-needs-answer', () => {
  if (!columnsOf('messages').includes('needs_answer')) db.exec('alter table messages add column needs_answer integer not null default 0');
});
once('2026-10-24-messages-goal', () => {
  if (!columnsOf('messages').includes('goal')) db.exec('alter table messages add column goal integer');
  if (!columnsOf('messages').includes('corrects')) db.exec('alter table messages add column corrects integer');
});
once('2026-10-26-messages-next-run', () => {
  if (!columnsOf('messages').includes('next_run')) db.exec('alter table messages add column next_run integer not null default 0');
});
once('2026-11-03-messages-partner', () => { // a linked company's urgent message: its workspace.
  if (!columnsOf('messages').includes('partner')) db.exec('alter table messages add column partner integer');
});
once('2026-11-07-messages-copies', () => {
  for (const [name, type] of [['fan', 'integer'], ['copied_to', 'text'], ['thread', 'text']]) if (!columnsOf('messages').includes(name)) db.exec(`alter table messages add column ${name} ${type}`);
});
db.exec('create index if not exists messages_goal on messages (goal) where goal is not null');
// A job's messages still on their way (take, jobEnded): read at every step and every end, they read every message's
// text without it.
db.exec(`create index if not exists messages_open on messages (job)
  where delivered is null and became is null and lapsed is null`);

export const MAX = 8000;        // characters; a longer text is refused (hq say tells the sender), never cut
export const PER_HOUR = 30;     // per sending job (or call): a loop can't flood a colleague with jobs
export const CHAIN = 3;         // jobs one chain of messages may start: a reply, a thanks, ... can't bounce between idle agents
export const OFFER_AGAIN = 60e3; // ms before an unacknowledged message is offered again: longer than a hook lives (inbox.ts)

export type Message = { id: number; created: string; sender: string; sender_job: number | null; recipient: string; text: string;
  job: number | null; delivered: string | null; became: number | null; offered: string | null; depth: number; lapsed: string | null;
  joined: number | null; guest: number | null; title: string | null; call: number | null; customers: number; held: number | null;
  needs_answer: number; goal: number | null; corrects: number | null; next_run: number; partner: number | null;
  fan: number | null; copied_to: string | null; thread: string | null };
// agent: who speaks (the job's agent or a team member of it). A live call's agent has no job: only its addition to a job
// it queued (call.ts addToJob), keyed by its call. A follow-up's guidance correction keeps its transcript out of events.
// goal and corrects: the call item whose goal it carries, or whose change it tells (the columns above).
export type From = { agent: string; job: number; guidance?: { call: number; item: number }; goal?: number; corrects?: number }
  | { agent: string; job: null; call: number };

// to: an org.yaml agent or alumnus (the caller checked). Returns what happened to it, for hq say to word; 409: it would
// start a job, and its chain has started CHAIN already (nothing stored, nothing shown). only: that one job of to's, not
// whichever is running (the ledger's correction to the jobs on a dropped item): running, or paused (queued again after
// it ran: it resumes in its session, whose hook reads it then). Parked on the board, or on Codex: a job now, as for hq say.
// held: the proposal whose notice it is, held on `only` (the column above).
// needsAnswer keeps a resulting job off the caller's branch and out of its task order.
// thread: the deliverable it's about, which no session is live on (messageabout.ts): a job for `to` on it, never their
// session on other work. fan and copiedTo: one copy of several (sendCopies).
// An item's goal or correction for `only` while it has never started goes into its brief (toJob), so it never starts
// without it; the answer's state is 'brief' then.
export type Sending = { only?: number; held?: number; needsAnswer?: boolean; thread?: string; fan?: number; copiedTo?: string };
export function send(from: From, to: string, text: string, sending: Sending = {}) {
  return refused(from, text, 1) ?? deliver(from, to, text, sending);
}

// One message as a copy for each live session on the work it names (messageabout.ts), refused whole if the copies
// would fill the sender's hour. Every copy's fan is the first copy's id.
export function sendCopies(from: From, sessions: { job: number; agent: string }[], text: string, sending: Sending) {
  const refusal = refused(from, text, sessions.length);
  if (refusal) return refusal;
  return inOneStep(() => {
    let fan: number | undefined;
    return sessions.map(s => {
      // (a live session reads it, so deliver never refuses it)
      const copy = deliver(from, s.agent, text, { ...sending, only: s.job, fan }) as Delivered;
      if (fan === undefined) db.prepare('update messages set fan = id where id = ?').run((fan = copy.id));
      return { ...copy, agent: s.agent };
    });
  });
}

// Send's refusals before anything is stored: empty, too long, or `copies` more would fill the sending job's (or call's)
// hour.
function refused(from: From, text: string, copies: number) {
  if (!text.trim()) return 400;
  if (text.length > MAX) return 413;
  const hour = new Date(Date.now() - 3600e3).toISOString();
  const [senderColumn, senderKey] = from.job === null ? ['call', from.call] : ['sender_job', from.job];
  if ((db.prepare(`select count(*) n from messages where ${senderColumn} = ? and created > ?`).get(senderKey, hour) as { n: number }).n + copies > PER_HOUR) return 429;
}

type Delivered = Exclude<ReturnType<typeof deliver>, number>;
function deliver(from: From, to: string, text: string, { only, held, needsAnswer = false, thread, fan, copiedTo }: Sending) {
  // The recipient's running work job; another than the sender's own, if it has two. One named (only) may be a try run
  // too: a call's prototype build takes the call's word as a job the call queued (callbuilds.ts).
  const job = (only ? db.prepare("select id, engine, status, session from jobs where id = ? and agent = ? and status in ('running', 'queued') and kind in ('work', 'try')").get(only, to)
    : thread ? undefined
    : db.prepare(`select id, engine, status, session from jobs where agent = ? and status = 'running' and kind = 'work'
    order by engine = 'claude' desc, id = ?, id desc limit 1`).get(to, from.job)) as { id: number; engine: string; status: string; session: string | null } | undefined;
  // The sender's job came from a message (it's what that message became): this one is a link further down the chain.
  const born = from.job ? db.prepare('select depth from messages where became = ?').get(from.job) as { depth: number } | undefined : undefined;
  const depth = born ? born.depth + 1 : 0, full = depth >= CHAIN;
  const nextRun = to === ceo() && from.job !== null && only === undefined && held === undefined && thread === undefined && !needsAnswer;
  if (full && job?.engine !== 'claude' && !nextRun) return 409;
  const call = from.job === null ? from.call : null;
  const ledgered = from.job === null ? null : from.goal ?? from.corrects ?? null;
  const reads = job?.engine === 'claude' && !(ledgered != null && job.status === 'queued' && job.session == null);
  // (one that becomes a job is kept with it or not at all: createJob refuses an agent no seat runs)
  const { id, made } = inOneStep(() => {
    const [goal, corrects] = from.job === null ? [null, null] : [from.goal ?? null, from.corrects ?? null];
    const { lastInsertRowid } = db.prepare('insert into messages (created, sender, sender_job, recipient, text, job, depth, call, held, needs_answer, goal, corrects, next_run, thread, fan, copied_to) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), from.agent, from.job, to, redact(text)!, reads ? job.id : null, depth, call, held ?? null, Number(needsAnswer), goal, corrects, Number(nextRun), thread ?? null, fan ?? null, copiedTo ?? null);
    const id = Number(lastInsertRowid);
    return { id, made: reads || nextRun ? undefined : toJob(id, only) };
  });
  // HQ's bubble (the events log keeps it): a call's addition by its number only, as the board's words stay with the job
  const guidance = from.job === null ? undefined : from.guidance;
  const shown = guidance ? `Message #${id}: correction for item #${guidance.item} on call #${guidance.call}`
    : call ? `Message #${id}: sent on call #${call}` : text;
  publish({ type: 'chat', agent: from.agent, to, text: shown, job: from.job ?? undefined }); // (job)
  if (nextRun) {
    publish({ type: 'log', agent: to, text: 'Message kept for the CEO: the next run reads it, even while a pause holds work' });
    return { id, state: reads ? 'queued' : 'pending', job: reads ? job.id : undefined, why: 'next-run' };
  }
  if (!made) return { id, state: 'queued', job: job!.id, ...(full ? { chain_full: true } : {}), ...(job!.status === 'running' ? {} : { waiting: true }) }; // (not started, or paused)
  reconcile([id]);
  if (made.job === only && !reads) return { id, state: 'brief', job: made.job };
  return { id, state: 'job', job: made.job, why: thread ? 'deliverable' : job ? 'codex' : 'idle', ...(made.added ? { added: made.added } : {}) };
}

// A guest's step (guests.ts) for the agent who wrote the request, as one line of JSON (`text`): queued for the agent's
// running Claude job (the request's own first), or a job titled `title` on a deliverable of its own (outsideJob). A
// guest ticks several items in a row: while that job hasn't started, the next step joins it. No hq say back (the guest isn't a colleague) and no bubble in HQ (the
// card shows it).
export function fromGuest(to: string, item: number, from: number | null, title: string, text: string) {
  const job = db.prepare(`select id from jobs where agent = ? and status = 'running' and kind = 'work' and engine = 'claude'
    order by id = ? desc, id desc limit 1`).get(to, from) as { id: number } | undefined;
  const { lastInsertRowid } = db.prepare('insert into messages (created, sender, recipient, text, job, guest, title) values (?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), `guest item #${item}`, to, text, job?.id ?? null, item, title);
  const id = Number(lastInsertRowid);
  return job ? { id, state: 'queued', job: job.id } : { id, state: 'job', job: toJob(id).job };
}

// A linked company's urgent message for our executive, as a guest's step goes (no sort: the executive judges it).
export function fromPartner(to: string, workspace: number, title: string, text: string) {
  const job = runningSession(to);
  const { lastInsertRowid } = db.prepare('insert into messages (created, sender, recipient, text, job, partner, title) values (?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), `workspace #${workspace}`, to, text, job?.id ?? null, workspace, title);
  const id = Number(lastInsertRowid);
  return job ? { id, state: 'queued', job: job.id } : { id, state: 'job', job: toJob(id).job };
}

// An agent's running Claude work session, which hears a line at its next step (a Codex job takes none mid-run), and
// whether a job of any kind is running on Claude.
export const runningSession = (agent: string) =>
  db.prepare(`select id from jobs where agent = ? and status = 'running' and kind = 'work' and engine = 'claude'
    order by id desc limit 1`).get(agent) as { id: number } | undefined;
export const inSession = (job: number) => !!db.prepare("select 1 from jobs where id = ? and status = 'running' and engine = 'claude'").get(job);

// HQ's own urgent inbox notice has no sending job. It lapses with the session, like any held proposal notice.
export function notice(to: string, text: string, job: number, held: number) {
  db.prepare(`insert into messages (created, sender, recipient, text, job, held) values (?, 'hq', ?, ?, ?, ?)`)
    .run(new Date().toISOString(), to, redact(text)!, job, held);
}

// A line from HQ for one running job of the agent's (a try run's, ink/booktry.ts: the board wrote again on the note it
// tries), handed to the session at its next step like any message, and a job of its own if the run ends unread
// (jobEnded).
export function forRun(to: string, text: string, job: number) {
  const { lastInsertRowid } = db
    .prepare(`insert into messages (created, sender, recipient, text, job) values (?, 'hq', ?, ?, ?)`)
    .run(new Date().toISOString(), to, redact(text)!, job);
  return Number(lastInsertRowid);
}

// The message as a job for its recipient: the sender and first line as the title, the whole text as the prompt, held
// for its sort (sortLater).
// A later message from the same sender job (about the same deliverable, if it names one), while the job an earlier one became hasn't started yet, is added to that job
// instead (like hq extend), so a follow-up or a correction runs with the first message, not as a parallel
// job without it. The job's prompt is its messages in the order they were sent (by id), rebuilt whenever one joins: one
// can join late and still be the earlier (it waited on a running job that ended without reading it: jobEnded), and each
// is worded by its real neighbour. (A message's job takes nothing else: hq extend refuses jobs nobody queued.)
// Returns the job, and with `added` the message that made it.
// into: the job a correction is for (send's only). One a message became that hasn't started takes it in its prompt, so
// it never runs on the word corrected (ledger.ts tell(): an item's goal). Any
// other that has never started takes an item's goal or correction in its brief, signed as hq extend signs: delivered
// there, not what made the job, so no prompt rebuild, joining lookup or chain reads it as one.
// An item's goal or correction joins the job that hasn't started holding that item's goal or a correction of it, from
// whichever sender, each in its own words: one that ended unread with the job it went to doesn't run apart from the
// other.
function toJob(id: number, into?: number) {
  const m = db.prepare('select * from messages where id = ?').get(id) as Message;
  if (m.guest || m.partner) return outsideJob(m);

  const item = m.goal ?? m.corrects;
  const waitingIn = (where: string, key: number) => db.prepare(`select coalesce(x.joined, x.id) message, j.id job from messages x join jobs j on j.id = x.became
    where ${where} and x.recipient = $to and x.id != $id and x.guest is null and x.needs_answer = $needs and x.thread is $thread
    and j.status = 'queued' and j.session is null and j.kind = 'work' order by x.id desc limit 1`)
    .get({ key, to: m.recipient, id: m.id, needs: m.needs_answer, thread: m.thread }) as { message: number; job: number } | undefined;
  const target = into ? waitingIn('j.id = $key and x.joined is null', into) : undefined;
  if (into && !target && item != null && db.prepare(`update jobs set prompt = prompt || ? where id = ? and kind = 'work' and status = 'queued'
    and session is null and not exists (select 1 from messages where became = jobs.id)`).run(`\n\n${m.text}\n(Added by ${m.sender}.)`, into).changes) {
    db.prepare('update messages set job = ?, delivered = ? where id = ?').run(into, new Date().toISOString(), id);
    keepsMark(m, into);
    return { job: into };
  }
  const waiting = target ?? (item != null ? waitingIn('(x.goal = $key or x.corrects = $key)', item) : undefined)
    ?? (m.sender_job ? waitingIn('x.sender_job = $key and x.joined is null', m.sender_job) : m.call ? waitingIn('x.call = $key and x.joined is null', m.call) : undefined);
  if (waiting) {
    const all = [...db.prepare('select * from messages where became = ? and id != ?').all(waiting.job, id) as Message[], m].sort((a, b) => a.id - b.id);
    if (db.prepare(`update jobs set prompt = ? where id = ? and status = 'queued' and session is null`).run(prompt(all), waiting.job).changes) {
      db.prepare('update messages set became = ?, joined = ? where id = ?').run(waiting.job, waiting.message, id);
      keepsMark(m, waiting.job);
      sortLater(waiting.job, m);
      publish({ type: 'log', agent: m.recipient, text: `Message #${id} from ${m.sender} added to job #${waiting.job}, which hasn't started yet (message #${waiting.message} made it).` });
      return { job: waiting.job, added: waiting.message };
    }
  }
  const job = createJob({ agent: m.recipient, title: messageTitle(m), prompt: prompt([m]), from: m.sender_job ?? undefined,
    // (it carries the code of the task that sent it, jobcodes.ts, unless it names a deliverable: a task of that one then.
    code: m.needs_answer || m.thread ? undefined : codeOf(m.sender_job) ?? undefined,
    thread: m.needs_answer ? null : m.thread ?? undefined }).id;
  // A needed answer is parallel work in the project it's about (else the caller's), with its own branch.
  if (m.needs_answer) {
    const about = m.thread ?? (m.sender_job ? threadOf(m.sender_job) : null);
    oneTaskThread(about ? findThread(about)?.project : null, { id: job, title: messageTitle(m) });
  }
  db.prepare('update messages set became = ? where id = ?').run(job, id);
  keepsMark(m, job);
  sortLater(job, m);
  return { job };
}
// A message marked before 31 Oct as holding a customer's details (messages.customers) keeps its check in the brief its
// words go into: that job is marked as the message was (jobs.ts holdsCustomerData). Nothing marks a message now.
const keepsMark = (m: Message, job: number) => {
  if (m.customers) db.prepare('update jobs set customers = 1 where id = ?').run(job);
};

// An item's goal message that became or joined a job, or went into its brief: if the item changed since and the job holds no correction of
// it, the job is owed one, which goes into its brief before it starts (ledger.ts goalOwed). Run once every message of a
// step is in its job, so a correction that came with them counts.
function reconcile(ids: number[]) {
  for (const id of ids) {
    const m = db.prepare('select coalesce(became, job) job, goal from messages where id = ?').get(id) as { job: number | null; goal: number | null };
    if (m.job != null && m.goal != null) ledger.goalOwed(m.job, m.goal);
  }
}

// A message's job starts under its template title, and waits until the owner of its thread's project (else the CEO)
// sorts it into the plan, named for what it does (sorting.ts).
function sortLater(job: number, m: Message) {
  const thread = threadOf(job);
  const why = `HQ made this job from ${m.sender}'s message (hq say #${m.id}), which no running session of ${m.recipient}'s took in.`;
  sorting.hold(job, { from: m.sender, project: (thread && findThread(thread)?.project) ?? null, why });
}

// hq inbox --hook, step one: the running job's waiting messages (only its own: the token says which job; a held one
// unless its proposal was decided since), offered to its hook. Offered isn't delivered: the hook acknowledges what it
// printed (ack). Until then no other hook of this job gets them (two at once, after parallel tool calls); after
// OFFER_AGAIN, a later step's hook gets them again.
export function take(job: number) {
  db.prepare(`update messages set job = ?, offered = null where recipient = ? and delivered is null
    and (job is null or job != ? and not exists (select 1 from jobs where id = messages.job and status = 'running'))
    and became is null and lapsed is null and next_run = 1
    and exists (select 1 from jobs where id = ? and agent = ? and status = 'running')`).run(job, ceo(), job, job, ceo());
  const now = new Date(), again = new Date(now.getTime() - OFFER_AGAIN).toISOString();
  const waiting = db.prepare(`select * from messages where job = ? and delivered is null and became is null and lapsed is null
    and (offered is null or offered < ?) and (held is null or exists (select 1 from proposals where id = messages.held and (status = 'open' or decided <= messages.created))) order by id`).all(job, again) as Message[];
  for (const m of waiting) db.prepare('update messages set offered = ? where id = ?').run(now.toISOString(), m.id);
  return waiting.map(m => m.guest ? { message: m.id, from: m.sender, guest: m.guest, sent: m.created, text: m.text }
    : m.partner ? { message: m.id, from: m.sender, partner: m.partner, sent: m.created, text: m.text }
    : m.call ? { message: m.id, from: m.sender, call: m.call, sent: m.created, text: m.text }
    : { message: m.id, from: m.sender, from_job: m.sender_job, sent: m.created, reply_to: lead(m), text: m.text,
      ...(m.needs_answer ? { needsAnswer: true } : {}), ...(m.copied_to ? { copied_to: m.copied_to } : {}) });
}

// Step two: the hook printed these (the session has them once it exits): delivered now. Only this job's own, only
// ones it was offered; anything else in ids is left as it is. Says which it marked.
export function ack(job: number, ids: unknown) {
  if (!Array.isArray(ids)) return 400;
  const now = new Date().toISOString(), marked: number[] = [];
  for (const id of new Set(ids.map(Number))) {
    const m = db.prepare(`select * from messages where id = ? and job = ? and offered is not null and delivered is null
      and became is null and lapsed is null`).get(id, job) as Message | undefined;
    if (!m) continue;
    db.prepare('update messages set delivered = ? where id = ?').run(now, id);
    publish({ type: 'log', agent: m.recipient, text: `Message #${id} from ${m.sender} to ${m.recipient}: delivered into job #${job}'s session.` });
    marked.push(id);
  }
  return { delivered: marked };
}

// A run ended without taking its messages in (done, failed, parked on the board), or without acknowledging one it
// was offered: each becomes a job, unless its chain has started CHAIN jobs already (then it lapses, as hq say told
// the sender it would). A paused or requeued job keeps them: it resumes in the same session and its hook reads them then.
export function jobEnded(job: number) {
  const s = (db.prepare('select status from jobs where id = ?').get(job) as { status: string } | undefined)?.status;
  if (!s || s === 'running' || s === 'queued') return;
  const made: number[] = [];
  for (const m of db.prepare('select * from messages where job = ? and delivered is null and became is null and lapsed is null').all(job) as Message[]) {
    const unread = m.offered ? `was offered to job #${job} but not confirmed read before it ended` : `wasn't read before job #${job} ended`;
    if (m.next_run) {
      db.prepare('update messages set job = null, offered = null where id = ?').run(m.id);
      publish({ type: 'log', agent: m.recipient, text: 'Unread message kept for the CEO: the next run reads it, even while a pause holds work' });
    } else if (m.held !== null) lapseHeld(m);
    else if (m.fan !== null && elsewhere(m)) {
      db.prepare('update messages set lapsed = ? where id = ?').run(new Date().toISOString(), m.id);
      publish({ type: 'log', agent: m.recipient, text: `Message #${m.id} to ${m.recipient} ${unread}. Another copy of it was read, became a job or still waits for a session, so it didn't start a job.` });
    } else if (m.depth >= CHAIN) {
      db.prepare('update messages set lapsed = ? where id = ?').run(new Date().toISOString(), m.id);
      publish({ type: 'log', agent: m.recipient, text: `Message #${m.id} to ${m.recipient} ${unread}. Its chain of messages had started ${CHAIN} jobs already, so it didn't start another.` });
    } else {
      const into = toJob(m.id);
      made.push(m.id);
      publish({ type: 'log', agent: m.recipient, text: `Message #${m.id} to ${m.recipient} ${unread}: ${into.added ? `added to job #${into.job}, which message #${into.added} made and which hasn't started yet` : `it's job #${into.job} now`}.` });
    }
  }
  reconcile(made);
}

// Another copy of a fanned-out message was read, became a job, or still waits on a job that runs (or is paused).
const elsewhere = (m: Message) => !!db.prepare(`select 1 from messages x where x.fan = ? and x.id != ? and (x.delivered is not null
  or x.became is not null or x.lapsed is null and exists (select 1 from jobs where id = x.job and status in ('running', 'queued')))`).get(m.fan, m.id);

// A proposal's held notices not yet read lapse (proposals.ts sweep, when it tells the owner again).
export function withdraw(proposal: number) {
  for (const m of db.prepare('select * from messages where held = ? and delivered is null and became is null and lapsed is null').all(proposal) as Message[]) lapseHeld(m);
}

// One held notice lapses. A job that ends lapses only its own: a new owner's running session may hold the same proposal's
// (proposals.ts ownerChanged), and keeps it.
function lapseHeld(m: Message) {
  db.prepare('update messages set lapsed = ? where id = ?').run(new Date().toISOString(), m.id);
  publish({ type: 'log', agent: m.recipient, text: `Message #${m.id} to ${m.recipient} wasn't read while job #${m.job} ran: it lapses.` });
}

// finish() (jobs.ts) ends the job before its hand-offs, and calls jobEnded last: if one of them throws, or the coordinator
// stops in between, a retried finish returns early for the ended job and its unread messages would wait for good. They're
// swept up at start and every minute (server.ts). A message only ever waits on a running job, so one that waits on a job
// that isn't running or queued (a pause) is one of those.
// send() stores a message for an idle or Codex recipient before it makes it a job: one that has no job to wait on and
// became none (publish threw, or the coordinator stopped in between) is made a job here.
export function sweep() {
  for (const { job } of db.prepare(`select distinct job from messages where delivered is null and became is null and lapsed is null
    and (select status from jobs where id = messages.job) not in ('running', 'queued')`).all() as { job: number }[])
    try { jobEnded(job); } catch (err) { console.error(`Messages of job #${job}:`, err); }
  for (const { id } of db.prepare(`select id from messages where job is null and delivered is null and became is null and lapsed is null
    and next_run = 0`).all() as { id: number }[])
    try { toJob(id); reconcile([id]); } catch (err) { console.error(`Message #${id}:`, err); }
}
