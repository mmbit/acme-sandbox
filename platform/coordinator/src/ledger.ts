// The call ledger: what the board asked for, decided or explained on a call, and what was promised on it, one item each,
// followed until it's done. A call's follow-up job records the items first
// (the words on the call, verbatim, stay with the agents), then hands them out: an item is handled only by evidence (its
// job ended done, a pause the board agreed, a question's answer on the call), never by a claim. A sweep sends a call again whose follow-up failed or ended
// without recording anything, three times at most, then says so on HQ's feed. The model does the extracting: nothing
// here reads or matches what anyone said.
import { db, once } from './db.ts';
import { publish } from './events.ts';
import { createJob, discussRequest, findAgent, jobAgent, noSeat, callNotesAsk, SHORT_NOTES, WORK_REPORT, askedInIntercom, customerCard, handedCustomerData, holdsCustomerData, outstandingWaits, strandedWaits, lineageTo, type Named } from './jobs.ts';   // (SHORT_NOTES; Named)
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

export type Item = { id: number; call: number; kind: string; owner: string; what: string; quote: string; lines: string | null;
  status: string; job: number | null; request: number | null; ref: string | null; why: string | null; replaces: number | null; by: number | null;
  acted_at: string | null; board: number | null; due: number | null };
type Call = { id: number; ts: string; agent: string; request: number | null; lines: string; job: number | null; status: string;
  processed_at: string | null; attempts: number; lines_at: string | null; resumes: string | null; reply: string | null; customers: number };

export const KINDS = ['task', 'decision', 'briefing', 'promise', 'question'];
export const WHAT = 200;
const QUOTE = 20_000, WHY = 200, REF = 300, ATTEMPTS = 3;
const LIVE_MS = 3 * 3600_000;   // a call token's life (call.ts): a call still live after that lost its line
const iso = () => new Date().toISOString();
export const oneLine = (s: unknown, max: number) => { const t = String(s ?? '').trim(); return t && !/[\r\n]/.test(t) && [...t].length <= max ? t : ''; };
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
const ENDED = ['dropped', 'replaced'];   // an item that won't be worked on any more (a job carrying it queues nothing)

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
// The item a job carries (hq job passes it on to the jobs it queues).
export const carried = (job: number) => db.prepare('select i.id, i.call, i.status, i.why from jobs j join call_items i on i.id = j.item where j.id = ?')
  .get(job) as { id: number; call: number; status: string; why: string | null } | undefined;

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

// hq items <call>: everything on the call, words included. hq items: what's open on every call, one line each (it also
// goes in every call's briefing and every follow-up's brief), every item's line whole.
export const items = (call: number) => db.prepare('select * from call_items where call = ? order by id').all(call) as Item[];
export const openItems = () => db.prepare(`select id, call, kind, owner, what, job from call_items where status = 'open' order by id`).all() as Item[];

// hq item add: one item. Refusals say why (a string), for hq to print; nothing is cut to fit.
// due: the time the board was given for it (ms; a correction keeps the earlier item's unless it gives one).
export function add(call: number, b: { kind?: unknown; owner: string; what?: unknown; quote?: unknown; lines?: unknown; replaces?: unknown; due?: number }, by: number | null) {
  const c = getCall(call);
  if (!c) return 404;
  const what = oneLine(b.what, WHAT), quote = String(b.quote ?? '').trim();
  const old = b.replaces == null ? undefined : getItem(Number(b.replaces));
  // (a message item is corrected by another)
  const message = b.kind === 'message' && old?.kind === 'message';
  if (!KINDS.includes(String(b.kind)) && !message) return `kind must be one of ${KINDS.join(', ')}`;
  if (!what) return `"what" must be one plain line of at most ${WHAT} characters: it's what the board reads`;
  if (!quote) return 'an item needs the words from the call, verbatim (the quote file)';
  if ([...quote].length > QUOTE) return `quote too long (${[...quote].length} > ${QUOTE}): make it two items`;
  const n = (JSON.parse(c.lines) as string[]).length;
  if (b.lines != null && b.lines !== '' && (!n || !span(b.lines, n))) return n ? `lines must be a-b within 1-${n}` : 'this call has no transcript lines to point at';
  if (b.replaces != null && (!old || ENDED.includes(old.status))) return `item #${b.replaces} isn't there to replace, or it's ${old?.status ?? 'dropped'} already`;
  if (message) {
    // Reserve full identifier widths before the correction has an id. Every predecessor's recipients must fit.
    const end = { ...old!, id: Number.MAX_SAFE_INTEGER, kind: 'message', status: 'handled', quote };
    const fits = earlierItems(old!).every(i => `A correction to your job #${Number.MAX_SAFE_INTEGER}: ${withdrawn(i, end)}`.length <= MAX);
    if (!fits) return `message correction exceeds the ${MAX}-character delivery limit including its note: use a shorter verbatim excerpt`;
  }
  const { lastInsertRowid } = db.prepare(`insert into call_items (call, kind, owner, what, quote, lines, replaces, ts, by, due) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(call, String(b.kind), b.owner, what, quote, b.lines ? String(b.lines) : null, old?.id ?? null, iso(), by, b.due ?? old?.due ?? null);
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
// thread or project: pauses.ts): handled now, and the pause carries it.
type LinkedPause = { id: number; project: string; thread: string | null; item: number | null };
type LinkedJob = { id: number; status: string; item: number | null; agent: string; queued_by: string | null };
export function link(id: number, to: { job?: number; request?: number; pause?: LinkedPause; ref?: unknown; thread?: string }, by: string, job: number) {
  const item = getItem(id);
  if (!item) return `item #${id} isn't open`;
  // What it's linked to is checked first, also for an item that's acknowledged: a typo isn't a follow-up going through it.
  const j = to.job ? db.prepare("select id, status, item, agent, queued_by from jobs where id = ? and kind = 'work'").get(to.job) as LinkedJob | undefined : undefined;
  const ref = to.pause ? `pause ${to.pause.thread ?? to.pause.project}` : to.job || to.request ? '' : oneLine(to.ref, REF);
  if (to.pause?.item != null && to.pause.item !== id) return `the pause on ${to.pause.thread ?? to.pause.project} carries item #${to.pause.item} already`;
  if (to.job && !j) return `there's no job #${to.job}`;
  if (to.request && !db.prepare('select 1 from requests where id = ?').get(to.request)) return `there's no request #${to.request}`;
  if (!to.job && !to.request && !ref) return `a ref is one line of at most ${REF} characters (a DECISIONS.md entry, a note's path, a commit)`;
  if (to.thread !== undefined && !j) return '--thread goes with job:<id>: it puts that work on an open thread';
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
  let set: ReturnType<typeof windows.set> | undefined;
  if (j) {
    const linked = linkJob(item, j, by, to.thread);
    if (typeof linked === 'string') return linked;
    set = linked;
  } else if (to.pause) {
    db.prepare('update pauses set item = ? where id = ?').run(id, to.pause.id);
    db.prepare('update call_items set ref = ? where id = ?').run(ref, id);
    close(id);
  } else {
    db.prepare('update call_items set request = ?, ref = ?, job = ? where id = ?').run(to.request ?? null, ref || null, answered ? item.job : job, id);
    if (answered) close(id);
  }
  const deadline = set === undefined ? {} : { deadline: set.deadline, thread: set.thread };
  return { ok: true, status: getItem(id)!.status, ...deadline, ...(wentThrough(id, job) ? tell(job, id) : {}) };
}
// link() to a job: the work that carries the item, or shows it's done (above).
function linkJob(item: Item, job: LinkedJob, by: string, onto?: string) {
  if (['failed', 'cancelled'].includes(job.status)) return `job #${job.id} ${job.status}: hand the item out again (hq job --item ${item.id} ...)`;
  if (windows.dropped(job.id)) return `job #${job.id}'s pull request was closed unmerged: hand the item out again (hq job --item ${item.id} ...)`;
  const own = job.queued_by != null && (job.agent === by || job.queued_by === by);
  if (own && job.item != null && job.item !== item.id) return `job #${job.id} carries item #${job.item} already, and a job carries one: hand item #${item.id} out as its own job (hq job --item ${item.id} ...)`;
  // The time the board was given for it on the call is the deadline of that work's thread now, from whoever was on the
  // call (one already past shows as late at once), unless it's the job the item was handed out to (its thread took
  // the time then, and may have a newer one since), or finished work (the link records it, and its thread's time, for
  // whatever goes on there, stays). Work in no open thread has nowhere to take it: refused, before anything is linked,
  // unless --thread names the open thread to put it on (projects.ts placeOn).
  const unfinished = !windows.finished(job.id);
  if (onto !== undefined && !unfinished) return `job #${job.id} is finished: --thread puts work still going on in a thread`;
  // (work --thread moved takes the item's time even when it's the job the item was handed out to: its old thread had it)
  const placed = onto === undefined ? undefined : placeOn(job.id, onto);
  if (typeof placed === 'string') return placed;
  const timed = item.due != null && unfinished && (placed !== undefined || item.job !== job.id);
  const thread = !timed ? undefined : placed ?? windows.threadOf({ job: job.id });
  if (typeof thread === 'string')
    return `${thread}: link it with --thread <project>/<slug> to put the work, its reviews with it, on an open thread (hq thread list)`;
  // (a request or ref an earlier job left on it says what that job did: this job is its work now)
  db.prepare('update call_items set job = ?, request = null, ref = null where id = ?').run(job.id, item.id);
  // From now on it reads the call (hq call, hq items: mine()).
  if (own && job.item == null) db.prepare('update jobs set item = ?, call = coalesce(call, ?) where id = ?').run(item.id, item.call, job.id);
  const set = thread ? windows.set(thread, { deadline: item.due!, aim: item.due! }, callAgent(item.call)) : undefined;
  if (job.status === 'done') close(item.id);
  return set;
}
const close = (id: number) => db.prepare("update call_items set status = 'handled', closed_at = ? where id = ? and status = 'open'").run(iso(), id);

// The board's word the call agent passed on to work under way during the call (call.ts reach): a message item, handled
// as it's recorded, for the job it went to (a running job, or a work job on the branch whose review it went to), and ref
// says how. A review reads it from then on (asked()). Not one of KINDS: only the call records one, one per
// word passed on.
// It's in the call agent's words: the follow-up checks them against the transcript, and replaces the item with the
// board's own (add) or drops it (drop) if it was misheard. Either way the jobs it reached hear so (stop()).
export function reached(call: number, b: { owner: string; what: string; words: string; job: number; ref: string }) {
  const now = iso();
  return Number(db.prepare(`insert into call_items (call, kind, owner, what, quote, status, job, ref, ts, closed_at)
    values (?, 'message', ?, ?, ?, 'handled', ?, ?, ?, ?)`).run(call, b.owner, b.what, b.words, b.job, b.ref, now, now).lastInsertRowid);
}
// Of the message items a run took as current (JSON ids: review.ts withTold), the ones corrected or withdrawn since.
export const changedSince = (told: string) => (db.prepare(`select id from call_items where id in (select value from json_each(?))
  and status <> 'handled' order by id`).all(told) as { id: number }[]).map(i => i.id);

// hq item drop: not going to happen, and why (the board reads it). Its work that hasn't started stops too.
export function drop(id: number, why: unknown, by: number) {
  const item = getItem(id), w = oneLine(why, WHY);
  // (a message item is handled from the start, and withdrawn)
  if (!item || !(item.status === 'open' || item.kind === 'message' && item.status === 'handled')) return `item #${id} isn't open`;
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
  for (const j of openJobs(id)) {
    if (cancelJob(j, `item #${id} was ${status}: ${why}`)) cancelled.push(j);
    else db.prepare('insert or ignore into untold (job, item) values (?, ?)').run(j, id);
  }
  return cancelled;
}
const openJobs = (item: number) => (db.prepare(`select id from jobs where item = ? and kind = 'work' and queued_by is not null and status in ${OPEN}`)
  .all(item) as { id: number }[]).map(j => j.id);
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
// correction's: mine(). So the message says it all.)
function change(x: Item, end: Item, from: { id: number; agent: string }) {
  if (x.kind === 'message') return withdrawn(x, end);
  if (end.id === x.id) return `item #${x.id} (call #${x.call}) was dropped: ${x.why} (hq items ${x.call} shows it). Stop or change course at your next step.`;
  return replacedBy(x, end) + (end.status !== 'dropped' ? '' : ` The call's follow-up (job #${from.id}) then dropped that correction: ${end.why}. `
    + `Your item stays replaced, and the follow-up records its work again as a new item if it's still wanted: don't go on with it unless ${from.agent} `
    + `tells you to (hq say ${from.agent} to ask).`);
}
const withdrawn = (x: Item, end: Item) => `the board's word passed on to this work on call #${x.call} (item #${x.id}: "${x.what}") `
  + (end.status === 'dropped' ? `is withdrawn: ${end.why}. Don't go by it any more.`
    : end.kind === 'message' ? `was misheard: the board's words, from the call's transcript (item #${end.id}), are ${JSON.stringify(end.quote)}. Go by those instead.`
    : `was replaced by item #${end.id}: "${end.what}". Don't go by it any more.`);
const replacedBy = (old: Item, i: Item) => `item #${old.id} (call #${old.call}) was replaced on call #${i.call} by item #${i.id}: "${i.what}" `
  + `(hq items ${old.call} shows it). Stop or change course at your next step; don't redo work item #${i.id}'s job covers.`;

// Tells the running jobs owed a correction whose chain ends where `at` says (an item, or a test on the item) from job
// `by`: the job that made it, or the call's follow-up going through it or ending done. By null (the live call itself,
// the sweep): from the follow-up of the call the chain ends on, once it has gone through that end or the call is
// followed up; a live call has none yet. The message goes into the job's session, or becomes a job for its agent if it
// can't take one in (parked on the board, on Codex). A refused one (the sender's 30 messages an hour, a chain of messages
// that's full) stays owed, and the next go-through, the follow-up ending done or the sweep sends it.
// running: owed, and not told (yet). A job that has ended is owed nothing, and the job that made the correction knows it.
function tell(by: number | null, at: number | ((end: Item) => boolean)) {
  const told: { job: number; message: number; became?: number }[] = [], running: number[] = [];
  const agentOf = (job: number) => (db.prepare('select agent from jobs where id = ?').get(job) as { agent: string } | undefined)?.agent;
  for (const o of db.prepare('select job, item from untold order by job, item').all() as { job: number; item: number }[]) {
    const settle = () => db.prepare('delete from untold where job = ? and item = ?').run(o.job, o.item);
    if (!db.prepare(`select 1 from jobs where id = ? and status in ${OPEN}`).get(o.job)) { settle(); continue; }
    const x = getItem(o.item)!, end = last(x);
    if (typeof at === 'number' ? end.id !== at : !at(end)) continue;
    const c = getCall(end.call)!, from = by ?? (c.processed_at || end.acted_at ? c.job : null), sender = from ? agentOf(from) : undefined;
    if (from === o.job) { settle(); continue; }
    const guidance = x.kind === 'message' ? { call: end.call, item: end.id } : undefined;
    const text = from && sender ? `A correction to your job #${o.job}: ${change(x, end, { id: from, agent: sender })}` : '';
    const m = from && sender ? send({ agent: sender, job: from, guidance }, agentOf(o.job)!, text, o.job) : undefined;
    if (typeof m !== 'object') { if (!running.includes(o.job)) running.push(o.job); continue; }
    settle();
    told.push({ job: o.job, message: m.id, ...(m.state === 'job' ? { became: m.job } : {}) });
  }
  return { told, running };
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
// a time per item, so a follow-up that runs again can't hand the same item out twice.
export function handOut(itemId: number, forJob: (call: number) => boolean) {
  const item = getItem(itemId);
  if (!item || !forJob(item.call)) return `item #${itemId} isn't on a call this job works for`;
  if (item.status !== 'open') return `item #${itemId} is ${item.status}: nothing to hand out`;
  const open = item.job && db.prepare(`select status from jobs where id = ? and status in ${OPEN}`).get(item.job) as { status: string } | undefined;
  if (open) return `item #${itemId} already has job #${item.job} (${open.status}): it isn't handed out twice (to go through it, hq item link ${itemId} job:${item.job})`;
  // Added by the board after the call (missed()): its own words, later than anything said on the call, so they win.
  // Noted by the call agent while the board was on the line (a promise, a correction): its own line, not the board's words.
  const noted = item.by == null && !item.lines;
  // (due: the time the board was given for it, the job's deadline unless it's given one)
  return { call: item.call, item: item.id, due: item.due ?? undefined, words: item.board
    ? `What the board added in its own words after the call this job comes from (item #${item.id}, call #${item.call}, in ${names().os} → Calls). They're the spec: where they differ from what was said on the call (\`hq call ${item.call}\`), they override it:\n\n${item.quote}`
    : noted
    ? `What the call agent noted on the call this job comes from (item #${item.id}, call #${item.call}), in its own words, not the board's: once the call has ended, \`hq call ${item.call}\` has what was said, and that's the spec where it says more:\n\n${item.quote}`
    : `The words on the call this job comes from (item #${item.id}, call #${item.call}${item.lines ? `, lines ${item.lines}: \`hq call ${item.call} ${item.lines}\` shows them in context` : ''}), verbatim. Where they say more than the brief above, they're the spec:\n\n${item.quote}` };
}
// (by: the job that handed it out, null for the live call's own token: the call's follow-up handing it out has gone through it.)
export function handedOut(item: number, job: number, by: number | null) {
  db.prepare('update call_items set job = ?, request = null, ref = null where id = ?').run(job, item);
  return wentThrough(item, by) ? tell(by, item) : {};
}

// A job ended (jobs.ts finish()). Done: the items it carries are handled, and those of the failed jobs it replaced (jobs.ts
// replacements), and a call it follows up is processed if its
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
  if (status !== 'done') return;
  withheld(job.id);
  db.prepare(`update call_items as i set status = 'handled', closed_at = ?1 where job in (${lineageTo('?2')}) and status = 'open'
    and not exists (select 1 from refusals r where r.job = ?2)
    and not (${tied("= 'closed' and j.id > i.job")} and not ${tied("<> 'closed'")})
    and (request is null and ref is null or ${tied("<> 'closed'")})`).run(iso(), job.id);
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
      and status not in ('failed', 'cancelled') order by id desc limit 1`).get(i.id, job, refusals[0].at) as { id: number; status: string } | undefined;
    if (next && !(next.status === 'done' && db.prepare('select 1 from refusals where job = ?').get(next.id))) {
      db.prepare('update call_items set job = ? where id = ?').run(next.id, i.id);
      if (next.status === 'done') close(i.id);
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
// A pull request closed unmerged: the items asked() finds for its branch are open again if they were handled, and the
// board's view shows them open. A lead handed the item can queue the work for a colleague (server.ts passes it on) and end
// done, which handles it, but the work is in the colleague's pull request. An item stays handled while another pull
// request tied to it (a job carrying it or handed it) merged or hasn't closed yet (open, stuck, with the board): a
// helper's or a stale sibling's close leaves it, whichever order the PRs end in, and the last one to close reopens it.
// A pause that carries it, a question answered on the call, or a message delivered during the call stays handled.
// A request or ref on any other item says what its job did (link()): that work didn't land either.
export const reopen = (branch: string) => db.prepare(`update call_items as i set status = 'open', closed_at = null where status = 'handled'
  and not exists (select 1 from pauses p where p.item = i.id) and (kind not in ('question', 'message') or request is null and ref is null)
  and ${ON_BRANCH} and not ${tied("<> 'closed'")}`).run(branch).changes;
// A pull request tied to item i (a job on its branch carries it, was handed it or replaced the job handed it) whose status
// matches.
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
//
// (intercom: the CEO's intercom turn follows the call up, ceoNotesAsk.)
function brief(c: Call, lines: string[], intercom = false) {
  const open = openItems().filter(i => i.call !== c.id).slice(-15), added = untouched(c.id);
  // an item's time (--deadline), and work under way linked so it gets it
  return `This is call #${c.id} with the board.${c.attempts ? ` A previous attempt at following it up failed, ended without recording anything or without setting the board's reply (hq reply), or ran before the transcript came in (this is attempt ${c.attempts + 1} of ${ATTEMPTS}): read \`hq items ${c.id}\` first and check what's already done (hq jobs, the repo, the desk phone) before you create anything. \`hq job --item\` refuses an item that already has a job.` : ''} ${NOISE}
${added.length ? `
The board added to this call afterwards, in ${names().os} → Calls ("We missed something"), in its own words. ${added.length > 1 ? 'These are' : 'This is'} recorded already (a task for you: hand it to a colleague if it's theirs): act on ${added.length > 1 ? 'each' : 'it'} as in step 2, like any other item. The call isn't followed up until ${added.length > 1 ? 'each is' : 'it is'} handed out or linked. If the call was followed up before, \`hq items ${c.id}\` shows what's done: don't record or hand that out again.
${added.map(i => `- #${i.id}: ${i.what}`).join('\n')}
` : ''}
${resumedBrief(c)}${c.agent === ceo() && unstaffed() ? founding() : ''}Work through it in this order.
1. Record, before you act on any of it: one item for each thing the board asked for, decided or explained, and one for each promise made on the call (by you, or for a colleague). Put the words from the transcript in a file, verbatim, and run
   hq item add <kind> <owner> "what" <quote-file> <a-b> --call ${c.id}
   kind: task (something to do), decision, briefing (the board explained something at length: a vision, a plan, a spec), promise (someone on the call said it would be done), or question (the board asked and got its answer on the call: link it right away, hq item link <item> "answered on the call"). owner: the agent who sees it through. "what": one plain line, the only thing the board reads about it (no quotes, no line numbers). a-b: its lines in the transcript below.
   When it was given a time on the call (when it will be done, ready, live, on the desk phone), add --deadline with that time in UTC (2026-10-06T14:30Z), worked out from when the call began, ${c.ts.slice(0, 16).replace('T', ' ')} UTC, and the board's own time zone (${timeZone()}). A promise the call agent noted with its time has it already (hq items: due). The thread of the job that carries the item, or of the job you link it to, takes it as its window: HQ orders that thread's work by it, and the CEO sees it if the thread slips. An item with no time that you hand out takes its window as it's queued (\`hq job --item ... --by\`): a time the board asked for that the call didn't give (hq when's), or \`--by <project>/<slug>\`, the deliverable it serves; on a thread that has a window or one a windowed thread needs, it has it already. The CEO is asked for one otherwise, and the CEO's own hand-out is refused until it gives one or says \`--by none\`.
   \`hq items ${c.id}\` lists what's recorded already (a promise, or the call agent's reading of a correction, may have gone in during the call): don't add it twice, and act on those too. A correction noted on the call is checked against the transcript: if it replaced the wrong item or misread the board, drop it and record the replaced item's work again as a new item and hand it out (its cancelled jobs stay cancelled). The replaced item's running jobs hear the correction from you when you first go through it (hand it out, link or drop it), with your reason if you drop it. One the call already handed out whose job hasn't ended (queued or running) is gone through with \`hq item link <item> job:<that job>\`: it stays open until that job ends done (a ref or request is refused while it's open). One that's handled already (its job, handed out on the call, ended done) still needs you to go through it: check the work, then \`hq item link <item> "<ref>"\` notes that you did, and changes nothing about it. If the board changed something it said on an earlier call, add the new item with --replaces <earlier item>: the earlier one is replaced (even if it was handled) and its jobs that haven't started are cancelled (it tells you which are running).
2. Act on each item, and link it to what shows it's done. Hand work out with \`hq job --item <item> <agent> "title" <brief-file> --code <WORD>\`: the job gets the words from the call with it, and the item is handled when that job ends done (queued is not done: nobody is on it until it runs). Work already under way (a job queued or running, a pull request in review) is linked: \`hq item link <item> job:<its job>\` (a pull request's job is the one on its branch, job/<n>), and the item's time becomes the deadline of that work's thread (work in no open thread: add \`--thread <project>/<slug>\` to put it on one). What the call agent added on the call to a job it queued there (its add tool: the job's brief, or a message to it if it had started) has reached that job already: link it to that job, never hand it out again. So has a message item (the board's word it passed on to work under way, recorded handled), in the call agent's words: check them against the transcript. If they say what the board said, go through it with \`hq item link <item> "checked against the call"\`, and never send it again. If the call agent misheard, \`hq item replace <item>\` with the board's own words from the transcript, or \`hq item drop <item> "why"\` if the board never said it or took it back: the work it reached and the pull request's review go by the correction from then on. Or do it here and link it: \`hq item link <item> request:<id>\`, or a ref (a DECISIONS.md entry, a note's path, a commit): the item is then this job's work, handled only when it ends done with a pull request, whose review judges it against the board's words: ending without one leaves it open (only a question is handled at once). Do what the board asked as it asked it: work you think should wait or go differently is the board's to decide, on a card. A card this job files (hq ask) is held off the desk phone until this job's work is merged and deployed, and the work it's about that you handed out with it (\`--when deployed:<job>\` for each), then shows as a new card: never hq wait on it, queue the step that needs its answer with \`hq job --after request:<id>\`. Something that won't happen: \`hq item drop <item> "why"\` (one line the board reads). A hold the board agreed on a project or a thread (no work on it until something lands) is recorded as the pause: \`hq project pause <project> "why"\` or \`hq thread pause <project>/<slug> "why"\`, with what wakes you to judge it: \`--until <job>\` for each job it waits for, \`--until-time <time>\`, or \`--by-hand\` (nothing does; it never lifts by itself, only your resume lifts it), then \`hq item link <item> pause:<project or thread>\` (the CEO or the project's owner pauses: anyone else hands the item to the CEO with \`hq job --item\`). Never as waits on its jobs or a line in a brief: the claim holds a pause, and the CEO's hourly check reads it. A long briefing reaches its builder through the job; a note in the Library keeps only a summary, never the board's words.
3. ${c.agent === ceo() ? ceoNotesAsk(intercom) : callNotesAsk()} Build the reply from the items, and never call work done that hasn't run. A time in it is one the board asked about: the one given on the call (its item's deadline), or, where the board asked for one the call didn't give, a new one: read \`hq thread <project>/<slug>\` for work already queued, or \`hq when "..." --agent <owner>\` for new work, with its dependencies and \`--by\` the board's time when it named one. Put that new time on the work's thread as its window in UTC: \`--by <when>\` as you queue it, or \`hq window <thread | job | pr:<n>> <when>\` for work already queued.
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
    // (its token goes with it: calls.id can be used again, and a late hand-over must not find another call)
    if (!count(c.id)) { db.prepare('delete from calls where id = ?').run(c.id); db.prepare('delete from call_tokens where call = ?').run(c.id); pictures.forgetCall(c.id); watchalong.forgetCall(c.id); continue; }
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
  const listed = shown.map(i => { text += `\n- #${i.id}: ${i.what} (${i.owner})`; return { id: i.id, end: text.length }; });
  return { text: `${text}${open.length > max ? `\n- and ${open.length - max} more` : ''}\n\n`, listed };
}
