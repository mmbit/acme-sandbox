// The call ledger: what the board asked for, decided or explained on a call, and what was promised on it, one item each,
// followed until it's done. A call's follow-up job records the items first
// (the words on the call, verbatim, stay with the agents), then hands them out: an item is handled only by evidence (its
// job ended done, a pause the board agreed, a question's answer on the call), never by a claim. A task or promise whose
// job ended done is ready, not handled: delivered means the board has seen it and said yes, and the CEO records that
// (done()). A sweep sends a call again whose follow-up failed or ended
// without recording anything, three times at most, then says so on HQ's feed. The model does the extracting: nothing
// here reads or matches what anyone said.
// (its messages say deliverable, the board's word for a thread)
import { db, once } from './db.ts';
import { publish } from './events.ts';
import { createJob, extendJob, discussRequest, findAgent, jobAgent, noSeat, callNotesAsk, SHORT_NOTES, WORK_REPORT, askedInIntercom, customerCard, handedCustomerData, holdsCustomerData, outstandingWaits, strandedWaits, lineageTo, ENDED_ITEMS, type Named } from './jobs.ts';   // (SHORT_NOTES; Named)
import { codeOf } from './jobcodes.ts';
import { ceo, companyFormats, companyTime, names, roles, timeZone, unstaffed } from './company.ts';
import * as chat from './chat.ts';
import * as pictures from './pictures.ts';
import * as watchalong from './watchalong.ts';
import { send, MAX } from './messages.ts';
import * as windows from './windows.ts';
import { placeOn } from './projects.ts';
import * as wakes from './wakes.ts';
import { endedEmpty } from './threadends.ts';
import { callAccess, customerCall } from './memory.ts';

export type Item = { id: number; call: number; kind: string; owner: string; what: string; quote: string; lines: string | null;
  status: string; job: number | null; request: number | null; ref: string | null; why: string | null; replaces: number | null; by: number | null;
  acted_at: string | null; board: number | null; due: number | null; goal: string | null; ready_at: string | null;
  said: string | null };
type Call = { id: number; ts: string; agent: string; request: number | null; lines: string; job: number | null; status: string;
  processed_at: string | null; attempts: number; lines_at: string | null; resumes: string | null; reply: string | null; customers: number };

export const KINDS = ['task', 'decision', 'briefing', 'promise', 'question'];
export const WHAT = 200, GOAL = 300;
const QUOTE = 20_000, WHY = 200, REF = 300, ATTEMPTS = 3;
export const LIVE_MS = 3 * 3600_000;   // a call token's life (call.ts): a call still live after that lost its line (exported)
const iso = () => new Date().toISOString();
export const oneLine = (s: unknown, max: number) => { const t = String(s ?? '').trim(); return t && !/[\r\n]/.test(t) && [...t].length <= max ? t : ''; };
// A call's notes page (ink/callnotes.ts) hears what's recorded on the call and its end: it hooks itself in, so the
// ledger loads no Ink. It's the call's route for its asks: each goes to its owner with the page, once, and its item is
// handed out to the job it went as. going: an item still on its way there (the page not sent yet). open: the call has its
// page open, to write on.
type CallPage = { noted: (call: number, item: { id: number; kind: string; owner: string; what: string }) => void; ended: (call: number) => Promise<void>; going: (item: number) => boolean; open: (call: number) => boolean };
let callPage: CallPage | undefined;
export const onCallPage = (page: CallPage) => { callPage = page; };
export const callEnded = (call: number) => void callPage?.ended(call).catch(err => console.error(`Call #${call}'s notes page:`, err));
const getCall = (id: number) => db.prepare('select * from calls where id = ?').get(id) as Call | undefined;
// who was on the call (the time an item was given there is theirs: link, server.ts hq job)
export const callAgent = (id: number) => getCall(id)!.agent;
const getItem = (id: number) => db.prepare('select * from call_items where id = ?').get(id) as Item | undefined;
const count = (call: number) => (db.prepare('select count(*) n from call_items where call = ?').get(call) as { n: number }).n;
// Gone through by the call's follow-up after the transcript came in: an item it recorded, or one recorded during the
// call (a promise, a correction) that it handed out, linked, dropped, or (handled already) acknowledged. Only the job
// that was the call's follow-up when it acted counts (wentThrough()): a job handed out for the call, or carrying one of
// its items, acting on its own item hasn't heard the call. A promise nobody went through, or what a follow-up did before
// a late transcript, isn't the call followed up; nor is acting on what the board added after it (missed()): that's
// no record of what was said.
const recorded = (c: Call) => !!db.prepare('select 1 from call_items where call = ? and acted_at >= ? and board is null').get(c.id, c.lines_at ?? c.ts);
// The call's follow-up went through item `id` (recorded, handed out, linked, dropped or acknowledged it): false if `job`
// isn't the follow-up of the item's call.
const wentThrough = (id: number, job: number | null) => !!job && db.prepare(`update call_items set acted_at = ?1 where id = ?2
  and exists (select 1 from calls c where c.id = call_items.call and c.job = ?3)`).run(iso(), id, job).changes;
const OPEN = "('queued', 'running', 'blocked')";
// What the board added after the call that no follow-up has handed out or linked yet: the call isn't followed up until it is.
const untouched = (call: number) => db.prepare(`select id, what from call_items where call = ? and board = 1 and status = 'open'
  and job is null and request is null and ref is null order by id`).all(call) as { id: number; what: string }[];

// A job may read a call and work on its items if it works for that call: it's the call's follow-up, it was handed out
// for it (jobs.call), or it carries one of its items. Not every agent: a transcript is the board's (charter rule 7).
export const mine = (job: number, call: number) => !!db.prepare(`select 1 from jobs j where j.id = ?1 and (j.call = ?2
  or exists (select 1 from calls c where c.id = ?2 and c.job = j.id) or exists (select 1 from call_items i where i.id = j.item and i.call = ?2))`).get(job, call);
// The call a job records items on unless it says (--call): the one it follows up, or the one it was handed out for.
// A job can follow up more than one call (the CEO's intercom chat job hears each call about its requests, and a later one
// can come in during the turn that hears the first): then it must say which, or a call's items land on another.
export function callOf(job: number) {
  const pending = (db.prepare('select id from calls where job = ? and processed_at is null order by id').all(job) as { id: number }[]).map(c => c.id);
  if (pending.length > 1) return `this job follows up calls ${pending.map(c => `#${c}`).join(' and ')}: say which this item is on (--call <id>)`;
  return pending[0] ?? ((db.prepare('select id from calls where job = ? order by id desc limit 1').get(job)
    ?? db.prepare('select call as id from jobs where id = ?').get(job)) as { id: number | null } | undefined)?.id ?? undefined;
}
// Only a call's follow-up corrects an earlier item (--replaces): its brief lists them. A job handed out for an item
// works on that item, and a live call records only promises and the board's corrections of open items (server.ts).
export const followsUp = (job: number) => !!db.prepare('select 1 from calls where job = ?').get(job);
export const itemCall = (id: number) => getItem(id)?.call;
export const item = getItem;
// Dropping an item (it cancels the item's jobs) and closing one by a link are for its call's follow-up: a job handed out
// for one item doesn't close or cancel a colleague's. It links the item it carries itself (a request, a ref). The follow-up
// of a call that carried on from the item's call (resumed) corrects it too: the board may have taken it back there.
export const decides = (job: number, id: number, link = false) => !!db.prepare(`select 1 from call_items i join calls c on c.id = i.call
  where i.id = ?1 and (c.job = ?2 or (?3 and exists (select 1 from jobs where id = ?2 and item = i.id))
  or exists (select 1 from calls n, json_each(n.resumes) e where n.job = ?2 and e.value = i.call))`).get(id, job, link ? 1 : 0);
// The earlier calls a call carried on from (call.ts carriedOn), and whether a job follows up a call that carried on from
// `call`: it reads that call and its items, and drops, links or replaces them, but records nothing on it (mine() is the
// call's own follow-up's).
const resumesOf = (c: Call) => JSON.parse(c.resumes ?? '[]') as number[];
export const resumed = (job: number, call: number) => !!db.prepare(`select 1 from calls n, json_each(n.resumes) e
  where n.job = ? and e.value = ?`).get(job, call);
// The item a job carries (hq job passes it on to the jobs it queues, with its goal: goalLine()).
export const carried = (job: number) => db.prepare('select i.id, i.call, i.status, i.why, i.goal from jobs j join call_items i on i.id = j.item where j.id = ?')
  .get(job) as { id: number; call: number; status: string; why: string | null; goal: string | null } | undefined;
// An item's goal as its jobs read it, at the head of the words from the call: the work, and any rule written down for it, is
// judged against it.
export const goalLine = (i: { id: number; call: number; goal: string | null }) => i.goal
  ? `Why the board wants this (item #${i.id}, call #${i.call}): ${i.goal}\nJudge the work by it. A narrowing or an exception that would defeat it goes back to the board (hq ask), never into the plan.`
  : '';

// The transcript as the agents see it: numbered, so an item's lines (a-b) point into it.
const numbered = (lines: string[], from = 1) => lines.map((l, i) => `[${from + i}] ${l}`).join('\n');
function span(range: unknown, n: number) {
  if (range == null || range === '') return [1, n];
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(range));
  const a = Number(m?.[1]), b = Number(m?.[2] ?? m?.[1]);
  return m && a >= 1 && a <= b && b <= n ? [a, b] : undefined;
}
export function transcript(call: number, range?: unknown) {
  const c = getCall(call);
  if (!c) return 404;
  const lines = JSON.parse(c.lines) as string[], s = span(range, lines.length);
  if (!lines.length) return { text: '(No transcript: the line dropped before the call was handed over.)' };
  if (!s) return `lines must be a-b within 1-${lines.length}`;
  return { text: numbered(lines.slice(s[0] - 1, s[1]), s[0]) };
}

// hq items <call>: everything on the call, words included. hq items: what's open on every call, one line each and its
// goal (the line also goes in every call's briefing and every follow-up's brief), every item's line whole.
export const items = (call: number) => db.prepare('select * from call_items where call = ? order by id').all(call) as Item[];
// (ready: its work ended, and the board's yes is still to come: done())
export const openItems = () => db.prepare(`select id, call, kind, owner, what, goal, job, status, ready_at,
  (select j.id from jobs j where j.id = i.job and j.status = 'stopped') stopped from call_items i
  where status in ('open', 'ready') order by id`).all() as (Item & { stopped: number | null })[];

// hq item add: one item. Refusals say why (a string), for hq to print; nothing is cut to fit.
// due: the time the board was given for it (ms; a correction keeps the earlier item's unless it gives one). goal: why the
// board wants it, in its own terms, as one line.
// onPage: a promise the live call records goes on its notes page (a scrap is there already, ink/callnotes.ts)
export function add(call: number, b: { kind?: unknown; owner: string; what?: unknown; goal?: unknown; quote?: unknown; lines?: unknown; replaces?: unknown; due?: number }, by: number | null, onPage = true) {
  const c = getCall(call);
  if (!c) return 404;
  const what = oneLine(b.what, WHAT), goal = oneLine(b.goal, GOAL), quote = String(b.quote ?? '').trim();
  const old = b.replaces == null ? undefined : getItem(Number(b.replaces));
  // (a message item is corrected by another)
  const message = b.kind === 'message' && old?.kind === 'message';
  if (!KINDS.includes(String(b.kind)) && !message) return `kind must be one of ${KINDS.join(', ')}`;
  if (!what) return `"what" must be one plain line of at most ${WHAT} characters: it's what the board reads`;
  if (!goal) return `"goal" must be one plain line of at most ${GOAL} characters: why the board wants it (its goal, or the problem it solves), in its own terms`;
  if (!quote) return 'an item needs the words from the call, verbatim ("words" on stdin)';
  if ([...quote].length > QUOTE) return `quote too long (${[...quote].length} > ${QUOTE}): make it two items`;
  const n = (JSON.parse(c.lines) as string[]).length;
  if (b.lines != null && b.lines !== '' && (!n || !span(b.lines, n))) return n ? `lines must be a-b within 1-${n}` : 'this call has no transcript lines to point at';
  if (b.replaces != null && (!old || ENDED_ITEMS.includes(old.status))) return `item #${b.replaces} isn't there to replace, or it's ${old?.status ?? 'dropped'} already`;
  if (message) {
    // Reserve full identifier widths before the correction has an id. Every predecessor's recipients must fit.
    const end = { ...old!, id: Number.MAX_SAFE_INTEGER, kind: 'message', status: 'handled', what, goal, quote };
    const fits = earlierItems(old!).every(i => `A correction to your job #${Number.MAX_SAFE_INTEGER}: ${withdrawn(i, end)}`.length <= MAX);
    if (!fits) return `message correction exceeds the ${MAX}-character delivery limit including its note: use a shorter verbatim excerpt`;
  }
  const { lastInsertRowid } = db.prepare(`insert into call_items (call, kind, owner, what, goal, quote, lines, replaces, ts, by, due) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(call, String(b.kind), b.owner, what, goal, quote, b.lines ? String(b.lines) : null, old?.id ?? null, iso(), by, b.due ?? old?.due ?? null);
  const id = Number(lastInsertRowid);
  // The follow-up's correction of the board's word passed on during the call, from the transcript: it's on the branch
  // the earlier one went to in its place, handled as it's recorded (reached()).
  if (message) db.prepare("update call_items set status = 'handled', closed_at = ts, job = ?, ref = ? where id = ?")
    .run(old!.job, `corrected from call #${call}'s transcript by job #${by}`, id);
  // A correction: the earlier item is replaced, open or handled, and its work that hasn't started stops (jobs its done
  // job queued carry it still); running work hears it, also of an earlier correction this one replaces (tell(): a live
  // call's from its follow-up). Done work stays done: this item's job corrects it.
  const cancelled = old ? stop(old.id, message ? `misheard on the call: item #${id} has the board's words` : `changed on a later call (#${call}, item #${id})`, 'replaced') : undefined;
  wentThrough(id, by);
  // (a promise recorded on the call: an ask on its notes page, where the board sees it, which goes with the page. A
  // correction isn't: the follow-up passes it on to the work it changes.)
  if (by === null && !old && onPage) callPage?.noted(call, { id, kind: String(b.kind), owner: b.owner, what });
  return { id, call, kind: String(b.kind), owner: b.owner, ...(message ? { status: 'handled' } : {}), ...(old ? { replaced: old.id, replacedWhat: old.what, was: old.status, cancelled, ...tell(by, id) } : {}) };
}

// hq item link: what shows the item is done. A job: handled when it ends done (finished()); one an agent queued that the
// caller's agent runs or queued also carries the item from then on (so a correction reaches it), anyone else's is only
// the evidence. So is one the coordinator made (queued_by null: a PR's fix job, the board's answer, a schedule's job),
// even the caller's own: a dropped item would cancel it, and hq cancel never takes those. A job carries one item: the
// caller's job that carries another isn't linked (a correction to this one wouldn't reach it). A request (the board was
// asked) or a ref (a decision entry, a note, a commit) says what the linking job did for it: the item is that job's
// work, handled when it ends done with a pull request (one without stays open: finished()), whose review judges it
// against the board's words, records alone too (review.ts officeOnly), and a pull request closed unmerged opens it
// again. A linker's word is no evidence: the work it points to has to land. Only a question answered on the call is handled now. An item that isn't open
// (a promise whose job the call handed out ended done before the follow-up got to it): its call's follow-up links it to say
// it went through it, and nothing about the item changes (acknowledged). A pause (a hold the board agreed, made a paused
// thread or project: pauses.ts): handled now, and the pause carries it. Work linked before it ends hears the item's goal
// (goalTo).
type LinkedPause = { id: number; project: string; thread: string | null; item: number | null };
type LinkedJob = { id: number; status: string; item: number | null; agent: string; queued_by: string | null; session: string | null; engine: string };
export function link(id: number, to: { job?: number; request?: number; pause?: LinkedPause; ref?: unknown; thread?: string }, by: string, job: number) {
  const item = getItem(id);
  if (!item) return `item #${id} isn't open`;
  // What it's linked to is checked first, also for an item that's acknowledged: a typo isn't a follow-up going through it.
  const j = to.job ? db.prepare("select id, status, item, agent, queued_by, session, engine from jobs where id = ? and kind = 'work'").get(to.job) as
    LinkedJob | undefined : undefined;
  const ref = to.pause ? `pause ${to.pause.thread ?? to.pause.project}` : to.job || to.request ? '' : oneLine(to.ref, REF);
  if (to.pause?.item != null && to.pause.item !== id) return `the pause on ${to.pause.thread ?? to.pause.project} carries item #${to.pause.item} already`;
  if (to.job && !j) return `there's no job #${to.job}`;
  if (to.request && !db.prepare('select 1 from requests where id = ?').get(to.request)) return `there's no request #${to.request}`;
  if (!to.job && !to.request && !ref) return `a ref is one line of at most ${REF} characters (a DECISIONS.md entry, a note's path, a commit)`;
  if (to.thread !== undefined && !j) return '--deliverable goes with job:<id>: it puts that work on an open deliverable';
  // (a handled item, a decision binding past its job, goes on a pause as it is: the pause carries it, the item doesn't change)
  if (to.pause && item.status === 'handled') {
    db.prepare('update pauses set item = ? where id = ?').run(id, to.pause.id);
    return { ok: true, status: item.status, ...(wentThrough(id, job) ? { acknowledged: true, ...tell(job, id) } : {}) };
  }
  if (item.status !== 'open' && getCall(item.call)?.job === job) {
    wentThrough(id, job);
    return { ok: true, status: item.status, acknowledged: true, ...tell(job, id) };
  }
  if (item.status !== 'open') return `item #${id} isn't open`;
  const answered = item.kind === 'question';
  const pending = !to.job && !to.pause && !answered && item.job !== job && item.job != null
    && db.prepare(`select status from jobs where id = ? and status in ${OPEN}`).get(item.job) as { status: string } | undefined;
  if (pending) return `item #${id} has job #${item.job} (${pending.status}): it's handled when that ends done`;
  let set: ReturnType<typeof windows.set> | undefined, goal: ReturnType<typeof goalTo>;
  if (j) {
    const linked = linkJob(item, j, { agent: by, job }, to.thread);
    if (typeof linked === 'string') return linked;
    ({ set, goal } = linked);
  } else if (to.pause) {
    db.prepare('update pauses set item = ? where id = ?').run(id, to.pause.id);
    db.prepare('update call_items set ref = ? where id = ?').run(ref, id);
    close(id);
  } else {
    db.prepare('update call_items set request = ?, ref = ?, job = ? where id = ?').run(to.request ?? null, ref || null, answered ? item.job : job, id);
    if (answered) close(id);
  }
  const deadline = set === undefined ? {} : { deadline: set.deadline, thread: set.thread };
  return { ok: true, status: getItem(id)!.status, ...deadline, ...goal, ...(wentThrough(id, job) ? tell(job, id) : {}) };
}
type GoalReached = 'brief' | 'message' | 'job' | 'refused' | 'withheld';
// Work linked to an item while it's queued or running hears why the board wants it, once (goalHeard). Work that had the
// item from the start has its goal already: it was handed out with the words, or queued by a job that carries it
// (server.ts). A job that carries the item from now on reads its call (mine()). A job that's only the evidence hears the
// goal only if its agent may read the call (memory.ts callAccess). A queued job that never started takes it in its brief.
// Other work takes it as a message (messages.ts send). A Claude session reads it at its next step. Where no session takes
// it in (Codex), the message becomes a job for the agent, and goalJob names it. The message keeps its item (messages.goal):
// the job it's in, became or joined (an unread one when its job ends too) hears a correction while it's open, even once
// the linked job has ended (goalHeard). A customer call's goal marks its reader.
// A message HQ refused (the sender's messages an hour, a full chain) is owed (goal_owed). Linking the item to that job
// again tries again.
function goalTo(item: Item, j: LinkedJob, carries: boolean, from: { agent: string; job: number }): { goalReached: GoalReached; goalJob?: number } | undefined {
  if (!item.goal || !['queued', 'running'].includes(j.status)) return;
  const owed = !!db.prepare('select 1 from goal_owed where job = ? and item = ?').get(j.id, item.id);
  if ((j.item === item.id && !owed) || db.prepare('select 1 from goal_told where job = ? and item = ?').get(j.id, item.id) || goalHeard(item.id).includes(j.id)) return;
  if (!(carries || callAccess(item.call, j) === true)) return { goalReached: 'withheld' };
  const text = `${carries ? `Your job #${j.id} carries item #${item.id} from now on ("${item.what}"): it's handled when the job ends done.`
    : `Your job #${j.id} is linked to item #${item.id} ("${item.what}") as the work that shows it's done.`}\n${goalLine(item)}`;
  const told = (goalReached: GoalReached, goalJob?: number) => {
    db.prepare('delete from goal_owed where job = ? and item = ?').run(j.id, item.id);
    db.prepare('insert into goal_told (job, item) values (?, ?)').run(j.id, item.id);
    return { goalReached, ...(goalJob ? { goalJob } : {}) };
  };
  if (j.status === 'queued' && j.session == null) {
    const extended = extendJob(j.id, from.agent, text);
    if (extended !== 404) {
      if (customerCall(item.call)) handedCustomerData(j.id);
      return told('brief');
    }
  }
  const guidance = { call: item.call, item: item.id };
  const message = send({ ...from, guidance, customers: customerCall(item.call), goal: item.id }, j.agent, text, j.id);
  if (typeof message !== 'object') {
    db.prepare('insert or ignore into goal_owed (job, item) values (?, ?)').run(j.id, item.id);
    return { goalReached: 'refused' };
  }
  return message.state === 'job' ? told('job', message.job) : told(message.state === 'brief' ? 'brief' : 'message');
}
// link() to a job: the work that carries the item, or shows it's done (above). from: the linker, whose words the goal is.
function linkJob(item: Item, job: LinkedJob, from: { agent: string; job: number }, onto?: string) {
  const by = from.agent;
  if (['failed', 'stopped', 'cancelled'].includes(job.status)) return `job #${job.id} ${job.status}: hand the item out again (hq job --item ${item.id} ...)`;
  if (windows.dropped(job.id)) return `job #${job.id}'s pull request was closed unmerged: hand the item out again (hq job --item ${item.id} ...)`;
  const own = job.queued_by != null && (job.agent === by || job.queued_by === by);
  if (own && job.item != null && job.item !== item.id) return `job #${job.id} carries item #${job.item} already, and a job carries one: hand item #${item.id} out as its own job (hq job --item ${item.id} ...)`;
  // The time the board was given for it on the call is the deadline of that work's thread now, from whoever was on the
  // call (one already past shows as late at once), unless it's the job the item was handed out to (its thread took
  // the time then, and may have a newer one since), or finished work (the link records it, and its thread's time, for
  // whatever goes on there, stays). Work in no open thread has nowhere to take it: refused, before anything is linked,
  // unless --thread names the open thread to put it on (projects.ts placeOn).
  const unfinished = !windows.finished(job.id);
  if (onto !== undefined && !unfinished) return `job #${job.id} is finished: --deliverable puts work still going on in a deliverable`;
  // (work --thread moved takes the item's time even when it's the job the item was handed out to: its old thread had it)
  const placed = onto === undefined ? undefined : placeOn(job.id, onto);
  if (typeof placed === 'string') return placed;
  const timed = item.due != null && unfinished && (placed !== undefined || item.job !== job.id);
  const thread = !timed ? undefined : placed ?? windows.threadOf({ job: job.id });
  if (typeof thread === 'string')
    return `${thread}: link it with --deliverable <project>/<slug> to put the work, its reviews with it, on an open deliverable (hq deliverable list)`;
  // (a request or ref an earlier job left on it says what that job did: this job is its work now)
  db.prepare('update call_items set job = ?, request = null, ref = null, why = null where id = ?').run(job.id, item.id);
  // From now on it reads the call (hq call, hq items: mine()).
  if (own && job.item == null) db.prepare('update jobs set item = ?, call = coalesce(call, ?) where id = ?').run(item.id, item.call, job.id);
  const set = thread ? windows.set(thread, { deadline: item.due!, aim: item.due! }, callAgent(item.call)) : undefined;
  if (job.status === 'done') workEnded(item.id);
  return { set, goal: goalTo(item, job, own && (job.item == null || job.item === item.id), from) };
}
const close = (id: number) => db.prepare("update call_items set status = 'handled', closed_at = ? where id = ? and status = 'open'").run(iso(), id);
// The work an open item is waiting on ended done (?1: when): a task or promise is ready for the board's yes (done()),
// anything else is handled.
const ASKED = "('task', 'promise')";
const WORK_ENDED = `status = iif(kind in ${ASKED}, 'ready', 'handled'), ready_at = iif(kind in ${ASKED}, ?1, null),
  closed_at = iif(kind in ${ASKED}, null, ?1)`;
const workEnded = (id: number) => db.prepare(`update call_items set ${WORK_ENDED} where id = ?2 and status = 'open'`).run(iso(), id);

// hq item done: the CEO records that the board has the task or promise and said yes (on a call, in the intercom or a
// card's answer), in the board's words, a line: only that handles it. Ready (its work ended), or open (the board said
// yes to what it saw before that). The CEO's jobs only (server.ts).
export function done(id: number, said: unknown, by: number) {
  const item = getItem(id), words = oneLine(said, WHY);
  if (item && !['task', 'promise'].includes(item.kind)) return `item #${id} is a ${item.kind}: only a task or a promise waits for the board's yes`;
  if (!item || !['open', 'ready'].includes(item.status)) return `item #${id} isn't open or ready`;
  if (!words) return `what the board said is one plain line of at most ${WHY} characters`;
  db.prepare("update call_items set status = 'handled', said = ?, closed_at = ? where id = ?").run(words, iso(), id);
  wentThrough(id, by);
  return { ok: true };
}

// The board's word the call agent passed on to work under way during the call (call.ts reach): a message item, handled
// as it's recorded, for the job it went to (a running job, or a work job on the branch whose review it went to), and ref
// says how. A review reads it from then on (asked()). Not one of KINDS: only the call records one, one per
// word passed on.
// It's in the call agent's words: the follow-up checks them against the transcript, and replaces the item with the
// board's own (add) or drops it (drop) if it was misheard. Either way the jobs it reached hear so (stop()).
export function reached(call: number, b: { owner: string; what: string; goal: string; words: string; job: number; ref: string }) {
  const now = iso();
  const id = Number(db.prepare(`insert into call_items (call, kind, owner, what, goal, quote, status, job, ref, ts, closed_at)
    values (?, 'message', ?, ?, ?, ?, 'handled', ?, ?, ?, ?)`).run(call, b.owner, b.what, b.goal, b.words, b.job, b.ref, now, now).lastInsertRowid);
  // (on the call's notes page too, where the board sees what reached the team: it went already, so it stays there)
  callPage?.noted(call, { id, kind: 'message', owner: b.owner, what: b.what });
  return id;
}
// Of the message items a run took as current (JSON ids: review.ts withTold), the ones corrected or withdrawn since.
export const changedSince = (told: string) => (db.prepare(`select id from call_items where id in (select value from json_each(?))
  and status <> 'handled' order by id`).all(told) as { id: number }[]).map(i => i.id);

// hq item drop: not going to happen, and why (the board reads it). Its work that hasn't started stops too. A ready item
// (its work ended without the board's yes): the CEO drops it too (server.ts).
// by: null for the call itself (an ask the board took off its page: ink/callnotes.ts).
export function drop(id: number, why: unknown, by: number | null) {
  const item = getItem(id), w = oneLine(why, WHY);
  // (a message item is handled from the start, and withdrawn)
  if (!item || !(['open', 'ready'].includes(item.status) || item.kind === 'message' && item.status === 'handled')) return `item #${id} isn't open`;
  if (!w) return `why is one plain line of at most ${WHY} characters: the board reads it`;
  const cancelled = stop(id, w, 'dropped');
  wentThrough(id, by);
  return { ok: true, cancelled, ...tell(by, id) };
}

// An item dropped (or replaced by a later call's): the board's bar is that work that hasn't started is cancelled, work
// already running runs its course but hears the correction, so it can stop or change course at its next step. Each
// running job is owed that message (untold) until it's sent: tell() sends it.
// Jobs queued by its jobs carry it too (hq job passes it on), and a job whose item is dropped or replaced queues nothing
// more (server.ts). A job the coordinator made never carries an item (link()), and isn't cancelled here even if it did.
function stop(id: number, why: string, status: 'dropped' | 'replaced') {
  db.prepare('update call_items set status = ?, why = ?, closed_at = coalesce(closed_at, ?) where id = ?').run(status, why, iso(), id);
  const cancelled: number[] = [];
  if (getItem(id)!.kind === 'message') {
    for (const j of guided(id)) db.prepare('insert or ignore into untold (job, item) values (?, ?)').run(j, id);
    return cancelled;
  }
  // (a job given more than this item, still current, goes on and hears it: ink/callnotes.ts.)
  for (const j of openJobs(id)) {
    if (!othersOf(j, id) && cancelJob(j, `item #${id} was ${status}: ${why}`)) cancelled.push(j);
    else db.prepare('insert or ignore into untold (job, item) values (?, ?)').run(j, id);
  }
  // Work that heard the item's goal as its evidence isn't the item's to cancel. It hears that the goal changed.
  for (const j of goalHeard(id)) db.prepare('insert or ignore into untold (job, item) values (?, ?)').run(j, id);
  return cancelled;
}
const openJobs = (item: number) => (db.prepare(`select id from jobs where kind = 'work' and status in ${OPEN} and (item = $item and queued_by is not null
  or id in (select job from item_work where item = $item))`).all({ item }) as { id: number }[]).map(j => j.id);
// A job given items without carrying any (a call page's sheet, ink/callnotes.ts) has each as its own work, as one that
// carries its item does: it's cancelled once none it was given is current, unless it was given more (the board's own
// notes beside them), and hears each change to them as its own (change). more: 1 for that.
db.exec('create table if not exists item_work (job integer not null, item integer not null, more integer not null, primary key (job, item))');
export const given = (items: number[], job: number, more: boolean) => {
  for (const item of items) db.prepare('insert into item_work (job, item, more) values (?, ?, ?)').run(job, item, Number(more));
};
// The items still current a job was given (a sheet's job), and whether it was given more: hq job passes them on to the
// jobs it queues, as it does the item a job carries (carried), with their goals, so a drop or correction reaches them
export const givenTo = (job: number) => db.prepare(`select i.id, i.call, i.goal, w.more from item_work w join call_items i on i.id = w.item
  where w.job = ? and i.status not in ('dropped', 'replaced') order by i.id`).all(job) as { id: number; call: number; goal: string | null; more: number }[];
// A job given items and nothing more (a sheet's job) none of which is current any more, and their call: it queues nothing
// more (server.ts), as a job whose carried item was dropped or replaced doesn't. Read when givenTo has none.
export const withdrawnFrom = (job: number) => db.prepare(`select i.call from item_work w join call_items i on i.id = w.item
  where w.job = $job and not exists (select 1 from item_work m where m.job = $job and m.more = 1) limit 1`).get({ job }) as { call: number } | undefined;
// Whether job j was given more than item `but` that's still current: another item it was given, or the board's notes
const othersOf = (j: number, but: number) => !!db.prepare(`select 1 from item_work w join call_items i on i.id = w.item
  where w.job = ? and (w.more = 1 or w.item != ? and i.status not in ('dropped', 'replaced'))`).get(j, but);
// The open work that heard an item's goal and doesn't carry it: told in its brief or as a message (goal_told), or holding
// the goal's message, read or not, as the job it went to, became or joined.
const goalHeard = (item: number) => (db.prepare(`select id from jobs where status in ${OPEN} and item is not $item
  and (id in (select job from goal_told where item = $item) or id in (select coalesce(became, job) from messages where goal = $item))`)
  .all({ item }) as { id: number }[]).map(j => j.id);
// A message item is guidance, not work: nothing is cancelled. The work that took it and is still under way hears it's
// withdrawn: the job it went to as a message, and the pull request's fixes that started with it in their prompt
// (review.ts withTold). The first item's timestamp covers fixes that took an earlier version of this guidance.
// A review or fix that hasn't started reads only what's current.
function guided(item: number) {
  const root = earlierItems(getItem(item)!).at(-1)!;
  const jobs = db.prepare(`select j.id from jobs j, call_items i where i.id = ? and j.kind = 'work'
    and j.status in ${OPEN} and j.started is not null and (j.id = i.job
    or j.stage = 'fix' and j.branch = (select branch from jobs where id = i.job) and j.started >= i.ts)`).all(root.id) as { id: number }[];
  return jobs.map(j => j.id);
}
function earlierItems(i: Item) {
  const items = [i];
  while (i.replaces != null) {
    i = getItem(i.replaces)!;
    items.push(i);
  }
  return items;
}
// Where an item's corrections end: the item that replaced it, the one that replaced that (a live call can replace its own
// correction, a follow-up the call's), and so on. Only an open or handled item is replaced, so each has one successor.
function last(i: Item) {
  for (let n: Item | undefined; (n = db.prepare('select * from call_items where replaces = ?').get(i.id) as Item | undefined); ) i = n;
  return i;
}
// What a running job on item x hears, from the follow-up job `from` of `end`'s call. (It reads x's call, not the
// correction's: mine(). So the message says it all, if it may read the correction's call too: shown, else only that its
// item changed, with nothing from that call.)
function change(x: Item, end: Item, from: { id: number; agent: string }, shown: boolean) {
  if (x.kind === 'message') return withdrawn(x, end, shown);
  if (end.id === x.id) return `item #${x.id} (call #${x.call}) was dropped: ${x.why} (hq items ${x.call} shows it). Stop or change course at your next step.`;
  return replacedBy(x, end, shown) + (end.status !== 'dropped' ? '' : ` The call's follow-up (job #${from.id}) then dropped that correction${shown ? `: ${end.why}` : ''}. `
    + `Your item stays replaced, and the follow-up records its work again as a new item if it's still wanted: don't go on with it unless ${from.agent} `
    + `tells you to (hq say ${from.agent} to ask).`);
}
const withdrawn = (x: Item, end: Item, shown = true) => `the board's word passed on to this work on call #${x.call} (item #${x.id}: "${x.what}") `
  + (!shown ? `was changed on call #${end.call}, which you may not read. Don't go by it any more.`
    : end.status === 'dropped' ? `is withdrawn: ${end.why}. Don't go by it any more.`
    : end.kind === 'message' ? `was misheard: the board's words, from the call's transcript (item #${end.id}), are ${JSON.stringify(end.quote)}. Go by those instead.${end.goal ? `\n\n${goalLine(end)}` : ''}`
    : `was replaced by item #${end.id}: "${end.what}". Don't go by it any more.`);
// What work linked to item x as its evidence hears, once it heard x's goal (goalTo). Only the goal changed: the work
// isn't x's, so it goes on.
const goalChanged = (x: Item, end: Item, shown: boolean) => `item #${x.id} (call #${x.call}: "${x.what}"), whose goal you heard as `
  + 'the work that shows it\'s done, ' + (end.id === x.id ? `was dropped: ${x.why}.`
    : `was replaced on call #${end.call} by item #${end.id}${shown ? `: "${end.what}"` : ', from a call you may not read'}${end.status === 'dropped' ? ', which was dropped too' : ''}.`)
  + ' Don\'t judge your work by that goal any more. Your job itself goes on as before.';
const replacedBy = (old: Item, i: Item, shown: boolean) => `item #${old.id} (call #${old.call}) was replaced on call #${i.call} by item #${i.id}`
  + `${shown ? `: "${i.what}"` : ', from a call you may not read,'} (hq items ${old.call} shows it). Stop or change course at your next step; don't redo work item #${i.id}'s job covers.`
  + (shown && i.status !== 'dropped' && i.goal ? `\n\n${goalLine(i)}` : '');

// Tells the running jobs owed a correction whose chain ends where `at` says (an item, or a test on the item) from job
// `by`: the job that made it, or the call's follow-up going through it or ending done. By null (the live call itself,
// the sweep): from the follow-up of the call the chain ends on, once it has gone through that end or the call is
// followed up; a live call has none yet. The message goes into the job's session, or becomes a job for its agent if it
// can't take one in (parked on the board, on Codex): marked as a customer's if what it says comes from a call about one
// (the correction's call only if its job may read it, memory.ts callAccess: else it hears no more than that its item
// changed). A refused one (the sender's 30 messages an hour, a chain of messages that's full) stays owed, and the next
// go-through, the follow-up ending done or the sweep sends it.
// running: owed, and not told (yet). A job that has ended is owed nothing, and the job that made the correction knows it.
// A job that has never started takes it in its brief (messages.ts send: brief), and the message says which item it
// corrects (messages.corrects), so it goes with that item's goal wherever its job ends unread.
function tell(by: number | null, at: number | ((end: Item) => boolean)) {
  const told: { job: number; message: number; became?: number; brief?: boolean }[] = [], running: number[] = [];
  const agentOf = (job: number) => (db.prepare('select agent from jobs where id = ?').get(job) as { agent: string } | undefined)?.agent;
  for (const o of db.prepare('select job, item from untold order by job, item').all() as { job: number; item: number }[]) {
    const settle = () => db.prepare('delete from untold where job = ? and item = ?').run(o.job, o.item);
    if (!db.prepare(`select 1 from jobs where id = ? and status in ${OPEN}`).get(o.job)) { settle(); continue; }
    const x = getItem(o.item)!, end = last(x);
    if (typeof at === 'number' ? end.id !== at : !at(end)) continue;
    const c = getCall(end.call)!, from = by ?? (c.processed_at || end.acted_at ? c.job : null), sender = from ? agentOf(from) : undefined;
    if (from === o.job) { settle(); continue; }
    const to = agentOf(o.job)!, shown = end.call === x.call || callAccess(end.call, { id: o.job, agent: to }) === true;
    const guidance = { call: end.call, item: end.id }, customers = customerCall(x.call) || (shown && customerCall(end.call));
    // (a job's own items: the one it carries, and those a call page's sheet gave it)
    const evidence = x.kind !== 'message' && !db.prepare('select 1 from jobs where id = $job and item = $item union select 1 from item_work where job = $job and item = $item').get({ job: o.job, item: x.id });
    const said = from && sender ? (evidence ? goalChanged(x, end, shown) : change(x, end, { id: from, agent: sender }, shown)) : '';
    const text = said && `A correction to your job #${o.job}: ${said}`;
    const m = from && sender ? send({ agent: sender, job: from, guidance, customers, corrects: x.id }, to, text, o.job) : undefined;
    if (typeof m !== 'object') { if (!running.includes(o.job)) running.push(o.job); continue; }
    settle();
    told.push({ job: o.job, message: m.id, ...(m.state === 'job' ? { became: m.job } : m.state === 'brief' ? { brief: true } : {}) });
  }
  return { told, running };
}

// A job that item's goal message became, joined or went into the brief of (messages.ts reconcile) and that has never started: if the item was
// replaced or dropped since, and no correction of it is in the job, the job is owed one, told in its brief now from the
// call's follow-up once it has gone through the change, else by that go-through or the sweep (tell).
export function goalOwed(job: number, item: number) {
  const x = getItem(item);
  if (!x || !['replaced', 'dropped'].includes(x.status) || db.prepare('select 1 from messages where coalesce(became, job) = ? and corrects = ?').get(job, item)) return;
  db.prepare('insert or ignore into untold (job, item) values (?, ?)').run(job, item);
  const end = last(x).id;
  tell(null, i => i.id === end);
}

// A queued job that never ran (no session and never claimed: claim() sets the heartbeat and nothing clears it, while
// attempts starts over after a clean hand-back, and a run cut off by a crash may have done part of its work) is
// cancelled, with the reason on its agent's feed. (hq cancel: the caller's own or one it queued, and for the CEO and
// Process any an agent queued, never one the coordinator made: a PR's fix job, the board's answer, a schedule's job;
// those have no queued_by.) A job queued --after it isn't left waiting: it starts and checks main for itself (jobs.ts
// READY), and the feed says so.
// finished: when, as every job that ends has it
export function cancelJob(id: number, why: string, by?: string) {
  const r = db.prepare(`update jobs set status = 'cancelled', result = ?, finished = ? where id = ? and ${CANCELLABLE}`).run(cancelledBy(by), `Cancelled: ${why}`, new Date().toISOString(), id);
  if (!r.changes) return false;
  cancelled(id, why);
  return true;
}
// Undated cancellations get the timestamps of their recorded "Cancelled #<id>: ..." feed events.
once('2026-10-21-dated-cancels', `update jobs set finished = d.ts from (select cast(substr(text, 12, instr(text, ':') - 12) as integer) id,
  min(ts) ts from events where type = 'log' and text like 'Cancelled #%' group by 1) d
  where jobs.id = d.id and jobs.status = 'cancelled' and jobs.finished is null`);
const CANCELLABLE = `kind = 'work' and status = 'queued' and session is null and heartbeat is null
  and ($by is null or (queued_by is not null and (agent = $by or queued_by = $by or $keepsTheQueue)))`;
const cancelledBy = (by?: string) => ({ by: by ?? null, keepsTheQueue: Number(!!by && (by === ceo() || by === roles().process)) });
// Why hq cancel refuses a job `by` could cancel: it waited for a card (db.ts request_waits) and heard the board's answer
// in place of its ended asker (jobs.ts answerRequest), so nobody else carries that answer. Undefined for any other job,
// which cancelJob() cancels or doesn't as before.
export function cancelRefusal(id: number, by: string) {
  const card = db.prepare(`select r.id from requests r join request_waits w on w.job = r.heard_by and w.request = r.id
    where r.heard_by in (select id from jobs where id = ? and ${CANCELLABLE}) order by r.id limit 1`).get(cancelledBy(by), id) as { id: number } | undefined;
  return card && `job #${id} carries the board's answer to card #${card.id}, and no other job hears it: it isn't cancelled. To stand it down, hq extend it to act on that answer alone`;
}
// The line on its agent's feed for a job that was cancelled, naming the jobs it releases. (Also for a job parked on a
// request that was closed: jobs.ts endParked.) a job queued after it that has
// further waits (db.ts waits) still holds for them, and the waits on this one go to whoever answers for them
// (jobs.ts strandedWaits). HQ's one-task thread it was in (a routine's run) ends, once the rest of it is in
// (threadends.ts endedEmpty.).
export function cancelled(id: number, why: string) {
  const job = db.prepare('select id, agent, title, step, round, thread from jobs where id = ?').get(id) as Named & { id: number; agent: string; thread: string | null };
  const after = (db.prepare("select id from jobs where after = ? and status = 'queued'").all(id) as { id: number }[])
    .map(j => ({ id: j.id, waits: outstandingWaits(j.id).map(w => `#${w.id}`) }));
  const starts = after.filter(j => !j.waits.length).map(j => `#${j.id}`);
  const recovery = strandedWaits(job, 'was cancelled');
  const parts = [
    starts.length ? `${starts.join(', ')}, queued after it, ${starts.length > 1 ? 'start' : 'starts'} now and ${starts.length > 1 ? 'check' : 'checks'} main` : '',
    ...after.filter(j => j.waits.length).map(j => `#${j.id}, queued after it, still waits for ${j.waits.join(' and ')}`),
    ...recovery.map(s => `${s.owner} moves or drops the waits on it of ${s.waiting.map(w => `#${w}`).join(', ')} (job #${s.job})`),
  ].filter(Boolean);
  publish({ type: 'log', agent: job.agent, text: `Cancelled #${id}: ${why}${parts.length ? ` (${parts.join('; ')})` : ''}` });
  if (job.thread) endedEmpty(job.thread);
}

// hq job --item <item>: the job carries the item and its call, and the words on the call in full (the spec). One job at
// a time per item, so a follow-up that runs again can't hand the same item out twice. live: handed out by the item's
// call itself, which may give a job an ask on its own notes page (it stays there, with its job).
export function handOut(itemId: number, forJob: (call: number) => boolean, live = false) {
  const item = getItem(itemId);
  if (!item || !forJob(item.call)) return `item #${itemId} isn't on a call this job works for`;
  if (item.status === 'ready') return `item #${itemId} is ready (its work ended): the CEO records the board's yes (hq item done) or drops it`;
  if (item.status !== 'open') return `item #${itemId} is ${item.status}: nothing to hand out`;
  const open = item.job && db.prepare(`select status from jobs where id = ? and status in ${OPEN}`).get(item.job) as { status: string } | undefined;
  if (open) return `item #${itemId} already has job #${item.job} (${open.status}): it isn't handed out twice (to go through it, hq item link ${itemId} job:${item.job})`;
  if (!item.job && !live && callPage?.going(itemId)) return `item #${itemId} is an ask on the call's notes page, which takes it to its owner: it isn't handed out twice (hq items ${item.call} shows its job once the page has gone, then hq item link ${itemId} job:<that job>)`;
  // Added by the board after the call (missed()): its own words, later than anything said on the call, so they win.
  // Noted by the call agent while the board was on the line (a promise, a correction): its own line, not the board's words.
  const noted = item.by == null && !item.lines;
  const words = item.board
    ? `What the board added in its own words after the call this job comes from (item #${item.id}, call #${item.call}, in ${names().os} → Calls). They're the spec: where they differ from what was said on the call (\`hq call ${item.call}\`), they override it:\n\n${item.quote}`
    : noted
    ? `What the call agent noted on the call this job comes from (item #${item.id}, call #${item.call}), in its own words, not the board's: once the call has ended, \`hq call ${item.call}\` has what was said, and that's the spec where it says more:\n\n${item.quote}`
    : `The words on the call this job comes from (item #${item.id}, call #${item.call}${item.lines ? `, lines ${item.lines}: \`hq call ${item.call} ${item.lines}\` shows them in context` : ''}), verbatim. Where they say more than the brief above, they're the spec:\n\n${item.quote}`;
  // (due: the time the board was given for it, the job's deadline unless it's given one)
  return { call: item.call, item: item.id, due: item.due ?? undefined, words: [goalLine(item), words].filter(Boolean).join('\n\n') };
}
// A job the live call queues with no item while its notes page is open: its promise, recorded on the call and so written
// on the page (where the board sees what reaches the team), for the job to carry. Undefined on a call with no page open.
export function promiseOnPage(call: number, job: { owner: string; what: string; goal: unknown }) {
  if (!callPage?.open(call)) return undefined;
  return add(call, { kind: 'promise', owner: job.owner, what: job.what, goal: job.goal, quote: job.what }, null);
}
// An open item's line in the words its call's agent changed it to on its notes page (ink/callasks.ts rewrote), before
// it's gone anywhere
export const reworded = (id: number, what: string) =>
  void db.prepare("update call_items set what = ? where id = ? and status = 'open' and job is null").run(what, id);
// (by: the job that handed it out, null for the live call's own token: the call's follow-up handing it out has gone through it.)
export function handedOut(item: number, job: number, by: number | null) {
  db.prepare('update call_items set job = ?, request = null, ref = null, why = null where id = ?').run(job, item);
  return wentThrough(item, by) ? tell(by, item) : {};
}

// A job ended (jobs.ts finish()). Done: the items it carries are handled (a task or promise ready for the board's yes:
// done()), and those of the failed jobs it replaced (jobs.ts replacements), and a call it follows up is processed if its
// follow-up went through an item on it since the transcript came in (recorded(): nothing means the call wasn't followed
// up, and the sweep sends it again; an item's job ending done isn't the follow-up going through it), and nothing the
// board added is untouched (acting on the board's items alone isn't the call followed up: they aren't a record of it).
// The CEO's intercom must also have heard the call: a turn that ended done before the call's line reached it hasn't
// (chat.heard()). Failed: its items stay open. So does one HQ refused the job what it asked for, unless a job carries it on
// (withheld()). An item isn't handled while a PR the job passed it on in (a job queued since, carrying it) closed
// unmerged and no PR tied to it is open or merged (the job's own new PR is: jobs.ts startReview() runs first): the work
// never landed. An earlier hand-out's closed PR doesn't count; that one reopened the item already. An item a request
// or ref made the job's work (link()) is handled only with a PR tied to it, open or merged, for the review to judge it
// by (one of records alone gets a review too: review.ts officeOnly): a job ending done without one leaves it open.
// A work follow-up has followed the call up only once it set the board's reply (reply()): one that ends without it is
// logged, and the sweep sends the call again. The CEO's call notes from a work job are that reply, shown in the intercom as
// the CEO's, and the next turn hears them. (A call about a request the CEO's intercom asked is followed up by the chat
// job itself, jobs.ts tell(): its reply is there already, and is the call's too, chat.answered().)
export function finished(job: { id: number; kind: string }, status: string) {
  if (status === 'stopped') {
    const stopped = db.prepare('select stopping from jobs where id = ?').get(job.id) as { stopping: string | null };
    db.prepare(`update call_items set status = 'open', job = ?2, closed_at = null, ready_at = null, why = ?1
      where (job in (${lineageTo('?2')}) or id in (select item from jobs where id in (${lineageTo('?2')})))
      and status in ('open', 'ready', 'handled') and kind not in ('message', 'question')`).run(`stopped: ${stopped.stopping}`, job.id);
    return;
  }
  if (status !== 'done') return;
  withheld(job.id);
  itemsDone(job.id);
  for (const c of db.prepare("select * from calls where job = ? and status = 'ended' and processed_at is null").all(job.id) as Call[]) {
    if (!recorded(c) || untouched(c.id).length || (job.kind === 'chat' && !chat.heard(c.id))) continue;
    if (job.kind !== 'chat' && c.reply == null) {
      publish({ type: 'log', agent: c.agent, text: `Call #${c.id}: follow-up #${job.id} ended without setting the board's reply (hq reply), so the call isn't followed up: the sweep sends it again` });
      continue;
    }
    db.prepare('update calls set processed_at = ? where id = ?').run(iso(), c.id);
    // A correction on it that the follow-up didn't go through, or whose running jobs weren't told yet: they hear it now.
    tell(job.id, end => end.call === c.id);
    if (c.agent === ceo() && job.kind === 'work') {
      chat.callNotes(c.id, job.id, c.reply!, minutes(c));
    }
  }
}
// hq reply: what the board reads after the call (the intercom for the CEO's, HQ-OS → Calls for everyone's), set by its
// follow-up apart from the job's last message, which is the job's report for the log. The board asked for short replies.
// It belongs to the follow-up that set it: new work on the call or a new follow-up clears it (missed(), late(), followUp(),
// chat.ts start()), so each follow-up gives its own.
// The brief targets about 80 words; REPLY_WORDS leaves room for a short list, and longer replies go back for rewriting.
const REPLY_WORDS = 120;
export function reply(job: number, text: string) {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (!words) return 'the reply is empty: write what the board reads after the call';
  if (words > REPLY_WORDS) return `the reply has ${words} words, and the board reads at most ${REPLY_WORDS}: keep what was decided and what's open for the board, and put the rest in your last message (the job's report)`;
  const set = db.prepare('update calls set reply = ? where job = ? and processed_at is null').run(text.trim(), job).changes;
  return set ? { ok: true, words } : ([403, "only a call's follow-up sets the board's reply, while it follows the call up"] as const);
}
// What HQ refused a job for good: an email draft or a guest's checklist, refused
// because the job holds a customer's details (server.ts refusedDeliverable), and why, in plain words for the board. A
// job's ending done is no evidence for an item it was refused that for (finished()): withheld() passes the item on or
// leaves it open.
db.exec('create table if not exists refusals (job integer not null, at text not null, what text not null, why text not null)');
export const refused = (job: number, what: string, why: string) => {
  if (job) db.prepare('insert into refusals (job, at, what, why) values (?, ?, ?, ?)').run(job, iso(), what, why);
};
// A job ending done after a refusal: each open item it would handle (its own, or a job's it replaced) goes to the job carrying it that was queued since the
// refusal (the hand-off the refusal asks for), handled when that one ends done (now, if it has and was refused nothing).
// With none, the item stays open, and the board hears it on HQ's feed in a line (no item's words: it may name a customer).
function withheld(job: number) {
  const refusals = db.prepare('select at, what, why from refusals where job = ? order by at').all(job) as { at: string; what: string; why: string }[];
  if (!refusals.length) return;
  for (const i of db.prepare(`select * from call_items where job in (${lineageTo('?')}) and status = 'open'`).all(job) as Item[]) {
    const next = db.prepare(`select id, status from jobs where item = ? and id <> ? and kind = 'work' and created >= ?
      and status not in ('failed', 'stopped', 'cancelled') order by id desc limit 1`).get(i.id, job, refusals[0].at) as { id: number; status: string } | undefined;
    if (next && !(next.status === 'done' && db.prepare('select 1 from refusals where job = ?').get(next.id))) {
      db.prepare('update call_items set job = ? where id = ?').run(next.id, i.id);
      if (next.status === 'done') workEnded(i.id);
      continue;
    }
    const c = getCall(i.call)!, name = (agent?: string) => agent ? findAgent(agent)?.name ?? agent : 'a colleague';
    const what = [...new Set(refusals.map(r => `${r.what} (${r.why})`))].join(' and ');
    publish({ type: 'log', agent: c.agent, to: 'board', text: `Call with ${name(c.agent)} on ${companyTime(Date.parse(c.ts))}: ${name(jobAgent(job))} finished work from it `
      + `without what it asked for, because HQ refused ${what}. It stays open on the call's list (${names().os} → Calls).` });
  }
}
// The review panel (review.ts): what a pull request's branch was asked for on a call. That's the items its jobs carry (the
// job handed out for an item, one it queued, and the PR's fix jobs on the same branch through it) and the ones tied to a
// job on the branch as evidence (call_items.job: handed out, or linked), or to a failed job it replaced (jobs.ts
// replacements).
const ON_BRANCH = `(i.id in (select item from jobs where branch = ?1 and kind = 'work')
  or exists (select 1 from jobs b where b.branch = ?1 and b.kind = 'work' and i.job in (${lineageTo('b.id')})))`;
export const asked = (branch: string) => db.prepare(`select i.* from call_items i where ${ON_BRANCH} order by i.id`).all(branch) as Item[];
// A pull request closed unmerged: the items asked() finds for its branch are open again if they were handled or ready, and the
// board's view shows them open. A lead handed the item can queue the work for a colleague (server.ts passes it on) and end
// done, which handles it, but the work is in the colleague's pull request. An item stays handled while another pull
// request tied to it (a job carrying it or handed it) merged or hasn't closed yet (open, stuck, with the board): a
// helper's or a stale sibling's close leaves it, whichever order the PRs end in, and the last one to close reopens it.
// A pause that carries it, a question answered on the call, a message delivered during the call, or the board's yes
// (done()) stays handled.
// A request or ref on any other item says what its job did (link()): that work didn't land either.
export const reopen = (branch: string) => db.prepare(`update call_items as i set status = 'open', closed_at = null, ready_at = null
  where status in ('handled', 'ready') and said is null
  and not exists (select 1 from pauses p where p.item = i.id) and (kind not in ('question', 'message') or request is null and ref is null)
  and ${ON_BRANCH} and not ${tied("<> 'closed'")}`).run(branch).changes;
// A pull request tied to item i (a job on its branch carries it, was handed it or replaced the job handed it) whose status
// matches.
// A done job's open items that its ending shows done: those a request or ref ties to its work once that work's pull
// request is open or merged (tied), the rest at once.
function itemsDone(job: number) {
  db.prepare(`update call_items as i set ${WORK_ENDED}, why = null where job in (${lineageTo('?2')}) and status = 'open'
    and not exists (select 1 from refusals r where r.job = ?2)
    and not (${tied("= 'closed' and j.id > i.job")} and not ${tied("<> 'closed'")})
    and (request is null and ref is null or ${tied("<> 'closed'")})`).run(iso(), job);
}
// A branch's pull request opened only after its tasks ended (a thread's push held for its next task: review.ts
// heldForThread): its done tasks' items that waited for it are judged now, as at their end.
// (indexed by db.ts jobs_work_branch: left to itself the planner takes jobs_state and reads every done job)
export function prOpened(branch: string) {
  const done = db.prepare(`select id from jobs indexed by jobs_work_branch where coalesce(branch, 'job/' || id) = +?
    and kind = 'work' and pr is null and status = 'done'`).all(branch) as { id: number }[];
  for (const { id } of done) itemsDone(id);
}
function tied(status: string) {
  return `exists (select 1 from prs p join jobs j on j.branch = p.branch and j.kind = 'work' where p.status ${status} and (j.item = i.id or i.job in (${lineageTo('j.id')})))`;
}
const minutes = (c: Call) => Math.max(1, Math.round((JSON.parse(c.lines) as string[]).join(' ').split(/\s+/).length / 150)); // about 150 spoken words a minute

// A call's follow-up: attempt 1 when it ends (a call about an open desk phone request reaches the job that hears it,
// jobs.ts tell()), later ones from the sweep, or from the board adding to the call (missed()).
export function followUp(id: number) {
  const c = getCall(id)!;
  // A call with an agent no job runs as (jobs.ts noSeat) can't be followed up: the board hears so now, as when its
  // follow-ups failed
  if (noSeat(c.agent)) {
    db.prepare("update calls set status = 'failed' where id = ?").run(id);
    const name = findAgent(c.agent)?.name ?? c.agent;
    publish({ type: 'log', agent: c.agent, to: 'board', text: `Call with ${name} at ${callAt(c)}: ${name} doesn't take jobs, so nobody follows it up. What was said on it isn't handled.` });
    return null;
  }
  const added = untouched(id).length > 0, again = c.attempts > 0 || added, lines = JSON.parse(c.lines) as string[];
  // (a card the CEO's intercom filed: its turn follows the call up, and its final message is the reply.)
  const req = !again && c.request ? discussRequest(c.request, brief(c, lines, askedInIntercom(c.request)), id) : undefined;
  // (a later attempt carries the code of the follow-up before it: jobcodes.ts.)
  const job = typeof req === 'object' && req.job ? req.job : createJob({ agent: c.agent, call: id, code: c.job ? codeOf(c.job) ?? undefined : undefined, prompt: brief(c, lines),
    title: `Follow up on your call with the board${added ? ' (the board added something' + (c.attempts ? `, attempt ${c.attempts + 1})` : ')')
      : again ? ` (attempt ${c.attempts + 1})` : ''}` }).id;
  db.prepare('update calls set job = ?, attempts = attempts + 1, reply = null where id = ?').run(job, id);
  // The call was about that card's customer, a look-up on it handed it a customer's details (calls.customers), or the
  // follow-up this one replaces read them: the call stays about a customer (memory.ts customerCall reads it off its
  // follow-up). So does one that carried on from such a call: its briefing had that call's transcript.
  const aboutCustomer = (x: Call) => (x.request && customerCard(x.request)) || holdsCustomerData(x.job) || !!x.customers;
  const earlier = resumesOf(c).map(getCall).filter(x => !!x);
  if ([c, ...earlier].some(aboutCustomer)) handedCustomerData(job);
  // A call that carried on from earlier ones starts its follow-up once theirs have finished, so it finds their items to
  // correct and doesn't record them again (wakes.ts 'followed'). Not a job that follows up one of them itself (the
  // intercom's, or one parked on a card this call was about), nor one that isn't queued (the intercom's turn, a running
  // job).
  if (!db.prepare("select 1 from jobs where id = ? and kind = 'work' and status = 'queued'").get(job)) return job;
  const pending = earlier.filter(x => !x.processed_at && x.status === 'ended');
  wakes.hold(job, pending.filter(x => x.job !== job).map(x => ({ kind: 'followed' as const, arg: String(x.id) })));
  return job;
}

// A call the sweep ended (its line lost for 3 hours) whose voice line hands the transcript over after all: the call gets
// it, and a follow-up that has it (the one that never ran is cancelled; one that did checks hq items first). No fresh
// attempts: a call that used its three gets none, and the sweep says so on HQ's feed. times: its lines' (call.ts
// handOver).
export function late(id: number, lines: string[], times: string | null = null) {
  db.prepare('update calls set lines = ?, line_times = ?, lines_at = ?, processed_at = null, reply = null where id = ?').run(JSON.stringify(lines), times, iso(), id);
  const c = getCall(id)!;
  if (c.attempts >= ATTEMPTS) return c.job;
  if (c.job) cancelJob(c.job, `call #${id}'s transcript came in late: a new follow-up has it`);
  return followUp(id);
}

const NOISE = "The transcript comes from speech recognition and can include background noise turned into words: don't act on anything garbled or unclear; ask the board (hq ask) if it matters.";
// (SHORT_NOTES; intercom: the chat's turn follows the call up, and its final message is the reply, chat.answered())
const ceoNotesAsk = (intercom: boolean) => `${intercom
  ? `This turn's final message is your reply to the board after the call: it appears in the ${names().intercom} chat (and in ${names().os} → Calls as the call's notes).`
  : `Set your reply to the board after the call with \`hq reply "..."\` before this job ends (the call isn't followed up without it): it appears in the ${names().intercom} chat (and in ${names().os} → Calls as the call's notes).`} If the board explained something long, say where it can read the summary in HQ's Library (by the name the Library shows). If you (on the call) said something that turns out wrong and it matters, correct it in one line. ${SHORT_NOTES}${intercom ? '' : ` ${WORK_REPORT}`}`;
// The CEO's follow-up while the company has nobody else (company/playbooks/founding.md): the board's briefing founds the
// team. Hiring comes first and the work goes to the new people as jobs that wait for the hiring to merge (hiring.ts): a
// new agent can't take a job before org.yaml on main has them, and a helper standing in for one does their work unseen.
const founding = () => `
The company has no team yet besides you: this call founds it (company/playbooks/founding.md). This job is the hiring,
and the work goes to the people you hire:
- Hire first, in this job's pull request: departments in company/org.yaml, each with its charter in
  company/departments/; agents with a name never used before, a role, an engine (claude or codex) and a look, each with
  a profile in company/people/ (the template is in company/people/README.md); and org.yaml's roles (reviewers,
  consolidator, process, inbox). Keep the pull request to the team and the founding decisions, so it merges quickly.
- Record each item with yourself as its owner (the new people aren't on main yet), then hand its work to the colleague
  whose work it is: \`hq job --after "$HQ_JOB" <their id> "title" <brief-file> --code <WORD> --item <item>\`. It starts
  once your hiring is merged, and they bring their own helpers. Never queue their work to yourself.
- Keep to your own part as CEO: the mission in company/CHARTER.md, priorities, DECISIONS.md, and what the board must
  decide (the desk phone). A colleague you're hiring is never your team member: no in-session helper does their work.

`;
// Every picture the board uploaded on the call (pictures.ts). The voice line's transcript names those it set out to put
// to the call agent ("shared picture #n on screen", written before it sends them): a call agent that had stopped never
// got one it names, so the line is an attempt, not a receipt. One it refused (too many) or that the hang-up cut off
// before its turn is never named, nor is the same picture shared again (the line sends it once).
// Without the transcript (the line dropped before the hand-over) nobody knows which got
// through.
function uploaded(call: number, transcript: boolean) {
  const ids = pictures.ofCall(call), one = ids.length === 1;
  if (!ids.length) return '';
  const where = transcript
    ? 'The transcript\'s "shared … on screen" lines say which ones the voice line tried to put to the call agent, and when (an attempt: the agent may not have received it if its session had stopped, so go by its replies); one they don\'t name was never sent to it, or was the same as one they name.'
    : 'With no transcript, which of them reached the call agent is unknown.';
  return `The board uploaded ${one ? 'a picture' : `${ids.length} pictures`} on the call (${ids.map(id => `#${id}`).join(', ')}). ${where} \`hq picture ${ids.join(' ')}\` saves ${one ? 'it' : 'them'} for you to look at.\n\n`;
}
// A call that carried on from earlier ones (call.ts carriedOn): its follow-up acts on this call's part only. It usually
// starts once theirs have finished (followUp), but not when it is one of them itself, or theirs waits for it (its note).
function resumedBrief(c: Call) {
  const ids = resumesOf(c);
  if (!ids.length) return '';
  const which = ids.length === 1 ? `call #${ids[0]}` : `calls ${ids.map(e => `#${e}`).join(' and ')}`, n = ids.length === 1 ? String(ids[0]) : '<call>';
  return `
This call carried on from ${which}: the board called back before the earlier follow-up had finished, and the call agent had what was said and noted there in its briefing. Each earlier call's own follow-up records and acts on what was said on it: this job usually starts once that has finished. If this job follows up an earlier call too, record that call's items under its own --call; if this job's note says an earlier follow-up runs after this one, do as the note says. Record and act only on what was said on this call (the transcript below is this call's alone), and refer to the earlier call where this one builds on it. When the board changed something said there, \`hq items ${n}\` has its items (\`hq call ${n}\` its transcript): record the new item with --replaces <its item>; if the board took one back, \`hq item drop <item> "why"\`. Dropping an earlier call's item doesn't count as following this call up: if that is all this call did, also record one decision item on it saying what the board took back. Something an earlier follow-up never recorded is recorded here only if this call says it again. If an earlier follow-up stopped trying (this job's note says so), say so in your reply.
`;
}
// (a message item in step 2) (step 3's new time from hq when) (step 2's request or ref) (a held card in step 2)
// (an item's goal, and a rule judged against it, in steps 1 and 2)
// (steps 1 and 3's times, the board's own with its date and no zone)
//
// (intercom: the CEO's intercom turn follows the call up, ceoNotesAsk.)
// (deliverables, the board's word for threads, drawn whole; later pieces chained)
function brief(c: Call, lines: string[], intercom = false) {
  const open = openItems().filter(i => i.call !== c.id).slice(-15), added = untouched(c.id);
  // (an item's time is its --deadline. Work under way is linked, so it gets the item. The call's notes page is the route
  // for the call's asks.)
  return `This is call #${c.id} with the board.${c.attempts ? ` A previous attempt at following it up failed, ended without recording anything or without setting the board's reply (hq reply), or ran before the transcript came in (this is attempt ${c.attempts + 1} of ${ATTEMPTS}): read \`hq items ${c.id}\` first and check what's already done (hq jobs, the repo, the desk phone) before you create anything. \`hq job --item\` refuses an item that already has a job.` : ''} ${NOISE}
${added.length ? `
The board added to this call afterwards, in ${names().os} → Calls ("We missed something"), in its own words. ${added.length > 1 ? 'These are' : 'This is'} recorded already (a task for you: hand it to a colleague if it's theirs): act on ${added.length > 1 ? 'each' : 'it'} as in step 2, like any other item. The call isn't followed up until ${added.length > 1 ? 'each is' : 'it is'} handed out or linked. If the call was followed up before, \`hq items ${c.id}\` shows what's done: don't record or hand that out again.
${added.map(i => `- #${i.id}: ${i.what}`).join('\n')}
` : ''}
${resumedBrief(c)}${c.agent === ceo() && unstaffed() ? founding() : ''}Work through it in this order.
1. Record, before you act on any of it: one item for each thing the board asked for, decided or explained, and one for each promise made on the call (by you, or for a colleague). Put the goal and the words from the transcript, verbatim, in a JSON file in $TMPDIR ({"goal": "why", "words": "..."}), and run
   hq item add <kind> <owner> "what" - <a-b> --goal - --call ${c.id} < that-file
   kind: task (something to do), decision, briefing (the board explained something at length: a vision, a plan, a spec), promise (someone on the call said it would be done), or question (the board asked and got its answer on the call: link it right away, hq item link <item> "answered on the call"). owner: the agent who sees it through. "what": one plain line, the only thing the board reads about it (no quotes, no line numbers). "goal": why the board wants it, the goal it serves or the problem it solves, in the board's own terms from the whole discussion (it usually says why, often lines away from the ask), never your plan for it; every job that carries the item gets it. It goes on stdin with the words, never in argv, where other jobs can read it. a-b: its lines in the transcript below.
   When it was given a time on the call (when it will be done, ready, live, on the desk phone), add --deadline with the board's own time, with its date and no zone (2026-10-26 09:00, on the company's clock, ${timeZone()}), worked out from when the call began, ${c.ts.slice(0, 16).replace('T', ' ')} UTC; a time with Z, or a time of day alone (14:30), is UTC. A promise the call agent noted with its time has it already (hq items: due). The deliverable of the job that carries the item, or of the job you link it to, takes it as its window: HQ orders that deliverable's work by it, and the CEO sees it if the deliverable slips. An item with no time that you hand out takes its window as it's queued (\`hq job --item ... --by\`): a time the board asked for that the call didn't give (hq when's), or \`--by <project>/<slug>\`, the deliverable it serves; in a deliverable that has a window or one a windowed deliverable needs, it has it already. The CEO is asked for one otherwise, and the CEO's own hand-out is refused until it gives one or says \`--by none\`.
   \`hq items ${c.id}\` lists what's recorded already (a promise, an ask the call agent put on the call's notes page, or its reading of a correction, may have gone in during the call): don't add it twice, and act on those too. A correction noted on the call is checked against the transcript: if it replaced the wrong item or misread the board, drop it and record the replaced item's work again as a new item and hand it out (its cancelled jobs stay cancelled). The replaced item's running jobs hear the correction from you when you first go through it (hand it out, link or drop it), with your reason if you drop it. One the call already handed out whose job hasn't ended (queued or running) is gone through with \`hq item link <item> job:<that job>\`: it stays open until that job ends done (a ref or request is refused while it's open). One that's handled or ready already (its job, handed out on the call, ended done) still needs you to go through it: check the work, then \`hq item link <item> "<ref>"\` notes that you did, and changes nothing about it. If the board changed something it said on an earlier call, add the new item with --replaces <earlier item>: the earlier one is replaced (even if it was handled) and its jobs that haven't started are cancelled (it tells you which are running).
2. Act on each item, and link it to what shows it's done. Hand work out with \`hq job --item <item> <agent> "title" <brief-file> --code <WORD>\`, in the deliverable of the feature it serves: items about one feature, whichever agents do them, are tasks in turn in one open deliverable (\`--deliverable <project>/<slug>\`, \`hq deliverable list\`), never a deliverable per item; a new one (\`--deliverable new:<project> "name" "done when"\`) only for a feature no open one makes; a later piece of one that goes live separately is drawn first, needing the one before it (\`hq plan deliverable <project> "name" "done when" --needs <project>/<slug>\`), then given its tasks (\`--deliverable <project>/<slug>\`; a queued task can start at once), never drawn to run beside it: the job gets the words from the call with it, and the item is handled when that job ends done (a task or a promise is ready then, and stays open until the CEO records the board's yes; queued is not done: nobody is on it until it runs). Work already under way (a job queued or running, a pull request in review) is linked: \`hq item link <item> job:<its job>\` (a pull request's job is the one on its branch, job/<n>), and the item's time becomes the deadline of that work's deliverable (work in none open: add \`--deliverable <project>/<slug>\` to put it in one), and its goal reaches it where its agent may read the call (hq item link says). The call's notes page is the call's route for what it asks of the team: each ask on it (a scrap, a promise) went to its owner with the page as the call ended, and \`hq items ${c.id}\` shows its item with the job it went as (seconds after the call; one still going is refused a hand-out). Go through it with \`hq item link <item> job:<that job>\`, never hand it out again: hand out only what the call asked that never went on its page. What the call agent added on the call to a job it queued there (its add tool: the job's brief, or a message to it if it had started) has reached that job already: link it to that job, never hand it out again. So has a message item (the board's word it passed on to work under way, recorded handled), in the call agent's words: check them against the transcript. If they say what the board said, go through it with \`hq item link <item> "checked against the call"\`, and never send it again. If the call agent misheard, \`hq item replace <item>\` with the board's own words from the transcript, or \`hq item drop <item> "why"\` if the board never said it or took it back: the work it reached and the pull request's review go by the correction from then on. Or do it here and link it: \`hq item link <item> request:<id>\`, or a ref (a DECISIONS.md entry, a note's path, a commit): the item is then this job's work, handled only when it ends done with a pull request, whose review judges it against the board's words: ending without one leaves it open (only a question is handled at once). Do what the board asked as it asked it: work you think should wait or go differently is the board's to decide, on a card. A card this job files (hq ask) is held off the desk phone until this job's work is merged and deployed, and the work it's about that you handed out with it (\`--when deployed:<job>\` for each), then shows as a new card: never hq wait on it, queue the step that needs its answer with \`hq job --after request:<id>\`. Something that won't happen: \`hq item drop <item> "why"\` (one line the board reads). Judge every rule you write down from an item (a hold, a limit, an order, a scope) against its goal before it goes in a brief or DECISIONS.md: a narrowing or an exception that would defeat the goal goes back to the board as a card (hq ask, one decision, our recommendation), never into the plan. A brief you hand out says the goal and the reasons the board gave on the call, not only the item's line, and a DECISIONS.md entry for the board's decision gives its why in the board's terms. A hold the board agreed on a project or a deliverable (no work on it until something lands) is recorded as the pause: \`hq project pause <project> "why"\` or \`hq deliverable pause <project>/<slug> "why"\`, with what wakes you to judge it: \`--until <job>\` for each job it waits for, \`--until-time <time>\`, or \`--by-hand\` (nothing does; it never lifts by itself, only your resume lifts it), then \`hq item link <item> pause:<project or deliverable>\` (the CEO or the project's owner pauses: anyone else hands the item to the CEO with \`hq job --item\`). Never as waits on its jobs or a line in a brief: the claim holds a pause, and the CEO's hourly check reads it. A long briefing reaches its builder through the job; a note in the Library keeps only a summary, never the board's words.
3. ${c.agent === ceo() ? ceoNotesAsk(intercom) : callNotesAsk()} Build the reply from the items, and never call work done that hasn't run. A time in it is one the board asked about: the one given on the call (its item's deadline), or, where the board asked for one the call didn't give, a new one: read \`hq deliverable <project>/<slug>\` for work already queued, or \`hq when "..." --agent <owner>\` for new work, with its dependencies and \`--by\` the board's time when it named one. Put that new time on the work's deliverable as its window, the board's own time with its date and no zone: \`--by <when>\` as you queue it, or \`hq window <deliverable | job | pr:<n>> <when>\` for work already queued.
The call counts as followed up only when this job ends done${intercom ? '' : " with the board's reply set (step 3)"} and, since the transcript came in, a follow-up has recorded at least one item, or handed out, linked or dropped one recorded during the call (a job ending done doesn't count, nor does anyone else acting on an item)${added.length ? ", and what the board added is handed out or linked: the board's items aren't a record of the call" : ''}. A call with nothing to act on is one question item, handled.
${open.length ? `\nStill open from earlier calls (for --replaces):\n${open.map(i => `- #${i.id} (call #${i.call}, ${i.owner}): ${i.what}`).join('\n')}\n` : ''}
${uploaded(c.id, lines.length > 0)}The transcript (again with \`hq call ${c.id}\`, or \`hq call ${c.id} a-b\` for a range):

${lines.length ? numbered(lines) : "(none: the line dropped before the call was handed over; the items recorded during it are what's left)"}`;
}

const callAt = (c: Call) => companyFormats().time(Date.parse(c.ts), 'en');

// Every 5 minutes: a call whose follow-up isn't queued, running or waiting for the board, and that isn't processed 10
// minutes after it ended, gets another follow-up; after 3, an alert on HQ's feed. Nothing silent. A correction a running
// job is owed goes out again (tell()). A call still live
// after its token's 3 hours lost its line without a hand-over: it ends as it is (a follow-up for what was recorded during it).
export function sweep(now = Date.now()) {
  for (const c of db.prepare("select * from calls where status = 'live' and ts < ?").all(new Date(now - LIVE_MS).toISOString()) as Call[]) try {
    // (its notes page sent, staying in My Notebook, or gone if nothing's on it.)
    callEnded(c.id);
    if (!count(c.id)) { forgetCall(c.id); continue; }
    db.prepare("update calls set status = 'ended' where id = ?").run(c.id);
    watchalong.endCall(c.id);
    followUp(c.id);
  } catch (err) { console.error(`Call #${c.id}:`, err); }
  const due = db.prepare(`select * from calls c where status = 'ended' and processed_at is null and ts < ?
    and not exists (select 1 from jobs j where j.id = c.job and j.status in ${OPEN})`).all(new Date(now - 10 * 60_000).toISOString()) as Call[];
  for (const c of due) try {
    if (c.attempts < ATTEMPTS) { followUp(c.id); continue; }
    db.prepare("update calls set status = 'failed' where id = ?").run(c.id);
    publish({ type: 'log', agent: c.agent, to: 'board', text: `Call with ${findAgent(c.agent)?.name ?? c.agent} at ${callAt(c)}: its follow-up failed ${c.attempts} times, so it stopped trying. What was said on it may not be handled.` });
  } catch (err) { console.error(`Call #${c.id}:`, err); }
  // A correction a running job is still owed (its send was refused, or the call's follow-up ended before it could go out).
  try { tell(null, () => true); } catch (err) { console.error('Owed corrections:', err); }
  try { askReplies(); } catch (err) { console.error('Owed reply asks:', err); }
}
// A call that recorded nothing is deleted, at its hang-up (call.ts handOver) or by the sweep. Its number can come back,
// so nothing of it may stay for the next call to find: its token, the jobs it queued, its pictures and its watch-along
// go with it.
export function forgetCall(call: number) {
  db.prepare('delete from calls where id = ?').run(call);
  db.prepare('delete from call_tokens where call = ?').run(call);
  db.prepare('delete from call_jobs where call = ?').run(call);
  pictures.forgetCall(call);
  watchalong.forgetCall(call);
}
// (at start too: the follow-ups owed the reply ask hear it before the first sweep.)
export const startSweep = () => { askReplies(); return setInterval(() => sweep(), 5 * 60_000).unref(); };

// A call's work follow-up briefed before replies were set (db.ts reply_asks) is asked for hq reply where its next run
// reads it: one that never started, in its brief (as hq extend adds to one); one back in the queue with a session of its
// own (paused, or its card answered), in its note, which the resumed session is sent; one running on Claude, in a message
// its session's hook brings at its next step, from the call (as part of its brief). One parked on a card, or running on Codex (which takes no message mid-run),
// can read nothing new: it stays owed, and a sweep asks it once it's queued again (after the board's answer, which
// becomes its note). A Codex run that ends done before that leaves its call to the next follow-up, briefed with the ask.
const REPLY_SINCE = "Since this job was queued, the board's reply after the call is set apart from your last message: what step 3 of "
  + 'your brief asks your last message to say goes in `hq reply "..."` instead, before this job ends (the call isn\'t followed up '
  + "without it). Your last message is this job's report for the log.";
function askReplies() {
  for (const { job } of db.prepare('select job from reply_asks').all() as { job: number }[]) {
    const settle = () => db.prepare('delete from reply_asks where job = ?').run(job);
    const j = db.prepare(`select agent, status, engine, session from jobs where id = ? and status in ${OPEN}`).get(job) as
      { agent: string; status: string; engine: string; session: string | null } | undefined;
    const c = db.prepare("select id, agent from calls where job = ? and status = 'ended' and processed_at is null").get(job) as { id: number; agent: string } | undefined;
    if (!j || !c) { settle(); continue; }
    if (j.status === 'queued' && j.session === null) db.prepare('update jobs set prompt = prompt || ? where id = ?').run(`\n\n${REPLY_SINCE}`, job);
    else if (j.status === 'queued') db.prepare("update jobs set note = coalesce(note || char(10) || char(10), '') || ? where id = ?").run(REPLY_SINCE, job);
    else if (j.status !== 'running' || j.engine !== 'claude') continue;
    else if (typeof send({ agent: c.agent, job: null, call: c.id, customers: false }, j.agent, REPLY_SINCE, job) !== 'object') continue;
    settle();
  }
}

// The board's view (GET /api/calls): each item's plain line, owner and where it stands (agent: who runs its job), and
// whether the board added it; never its words or lines.
export function forBoard(call: number) {
  // (job_code: its job's code, as HQ names it.)
  const list = db.prepare(`select i.what, i.owner, i.status, i.job, j.code job_code, j.agent, i.request, i.why, i.board is not null as board from call_items i
    left join jobs j on j.id = i.job where i.call = ? order by i.id`).all(call) as { status: string }[];
  return { items: list, handled: list.filter(i => i.status === 'handled').length, total: list.length };
}

// "We missed something" (the computer's Calls app): the board adds one item to a call after it, in its own words, as a task for the
// call's agent (the words are the board's: the item's line and its quote, refused if they aren't one line of at most
// WHAT characters, never cut). The call is followed up again: a follow-up still on it hears it when it ends undone, else
// a new one now. Either way three fresh attempts: the board gave a new reason. Until the item is handed out or linked
// the call isn't followed up (finished()), so the sweep keeps sending it.
export function missed(call: number, text: unknown) {
  const c = getCall(call), what = oneLine(text, WHAT);
  if (!c || c.status === 'live') return 404;
  if (!what) return 400;
  const id = Number(db.prepare(`insert into call_items (call, kind, owner, what, quote, ts, board) values (?, 'task', ?, ?, ?, ?, 1)`)
    .run(call, c.agent, what, what, iso()).lastInsertRowid);
  db.prepare("update calls set processed_at = null, status = 'ended', attempts = 0, reply = null where id = ?").run(call);
  const busy = c.job != null && !!db.prepare(`select 1 from jobs where id = ? and status in ${OPEN}`).get(c.job);
  return { id, job: busy ? c.job : followUp(call) };
}

// The call agent's briefing: what's still open from earlier calls, so "did that happen?" gets a true answer. The ids it
// numbers are the ones the call's replace may change (call.ts keeps those whose line the agent hears with the token, by
// where each line ends in the text).
export function stillOpen(max = 8, except: number[] = []) {  // (except: the live call itself and the calls it carries on from, whose prompt lists them all: call.ts)
  const open = openItems().filter(i => !except.includes(i.call)), shown = open.slice(-max);
  if (!open.length) return { text: '', listed: [] as { id: number; end: number }[] };
  let text = '## Still open from earlier calls';
  // (ready: its work ended, and it's open until the board says yes)
  const listed = shown.map(i => { text += `\n- #${i.id}: ${i.what} (${i.owner}${i.status === 'ready' ? ', ready for the board to say yes' : ''})`; return { id: i.id, end: text.length }; });
  return { text: `${text}${open.length > max ? `\n- and ${open.length - max} more` : ''}\n\n`, listed };
}
