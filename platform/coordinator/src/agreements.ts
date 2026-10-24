// What the board agreed on its calls that still stands, and the work on each: the CEO's follow-through check reads it
// (followthrough.ts) and hands failed work on it back (takeover.ts).
import { db, prepared } from './db.ts';
import * as jobs from './jobs.ts';
import * as redraws from './redraws.ts';
import * as memory from './memory.ts';
import { ceo } from './company.ts';

const QUOTE_MAX = 600;

export type OpenByID = Map<number, ReturnType<typeof jobs.openJobs>[number]>;
type Agreement = {
  id: number;
  call: number;
  kind: string;
  owner: string;
  what: string;
  quote: string;
  status: string;
  request: number | null;
  ceo_call: number;
  carriers: string;
  pause: string | null;
};

// The jobs carrying item i: the one handed it (call_items.job), every job carrying it on (jobs.item, hq job passes it
// down) and each job in place of one of those (jobs.ts replacements: a review's retry, a takeover). One is unfinished
// while it's open, done with its pull request not yet merged or closed, or failed with nothing in its place: a sibling
// carrying the same item does other work, however late it came. The carriers are two selects, not one with an or, so
// each uses its index; the cross join keeps SQLite going from the carriers to their rows, not from every done job. Their
// kind, status and branch are read from covering indexes (db.ts jobs_state, jobs_carried), as they sit after the brief:
// every handled item's carriers are read for the CEO's summary.
const CARRIERS = jobs.lineageFrom(
  `select j.id from jobs j indexed by jobs_state where j.kind = 'work' and j.id = i.job
  union select j.id from jobs j indexed by jobs_carried where j.kind = 'work' and j.item = i.id`,
);
const UNFINISHED = `exists (select 1 from (${CARRIERS}) c cross join jobs u indexed by jobs_state on u.id = c.id where (u.status in ('queued', 'running', 'blocked')
  or u.status = 'done' and exists (select 1 from prs p where p.branch = coalesce(u.branch, 'job/' || u.id) and p.status in ('open', 'stuck', 'board'))
  or u.status = 'failed' and not ${jobs.hasReplacement('u.id')}))`;

// A pause carrying item i that still stands for the board: it holds, or it was resumed by hand before the jobs it waits
// for merged (pauses.ts).
const PAUSE_STANDS = `exists (select 1 from pauses p where p.item = i.id and (${jobs.pauseHolds('p')}
  or exists (select 1 from pause_until u join jobs prior on prior.id = u.job where u.pause = p.id and not ${jobs.merged('prior')})))`;

// Open tasks, promises and decisions, whenever they were said; handled ones while a job carrying them is unfinished or a
// pause carrying them stands; and the board's decisions until a later call replaces or drops them (a decision such as a
// hold binds after its job has ended). The same list decides whether a check is queued.
export function agreements() {
  return db
    .prepare(
      redraws.query(`select i.id, i.call, i.kind, i.owner, i.what, i.quote, i.status, i.request, c.agent = $ceo ceo_call,
        (select json_group_array(id) from (select distinct id from (${CARRIERS}) order by id)) carriers,
        (select coalesce(p.thread, p.project) || iif(p.resumed is null, '', ', resumed') from pauses p where p.item = i.id
          order by p.id desc limit 1) pause
      from call_items i join calls c on c.id = i.call
      where i.kind in ('task', 'promise', 'decision') and (i.status = 'open'
        or i.status = 'handled' and (i.kind = 'decision' or ${UNFINISHED} or ${PAUSE_STANDS}))
      order by i.id`),
    )
    .all({ ceo: ceo() }) as Agreement[];
}

// The board's tasks and promises handled whose work has ended: jobs carried them and none is unfinished (a pull request
// closed unmerged opened the item again: review.ts unmerged). The summary's finished part reads when that work went live
// (finished.ts).
export function ended() {
  const rows = db
    .prepare(
      `select i.id, i.call, i.kind, i.owner, i.what,
        (select json_group_array(id) from (select distinct id from (${CARRIERS}) order by id)) carriers
      from call_items i where i.kind in ('task', 'promise') and i.status = 'handled' and not ${UNFINISHED} order by i.id`,
    )
    .all() as (Pick<Agreement, 'id' | 'call' | 'kind' | 'owner' | 'what'> & { carriers: string })[];
  return rows.map(r => ({ ...r, carriers: JSON.parse(r.carriers) as number[] })).filter(r => r.carriers.length);
}

// The list for the CEO's job `reader`: the board's words only from a call hq call would show it.
export function agreedPart(open: OpenByID, reader: jobs.Reader) {
  const shown = callsShown(reader);
  const lines = agreements().map(a => {
    if (a.status !== 'open' && !shown(a.call))
      return `- item #${a.id} (call ${a.call}, ${a.kind}, ${a.status}): left out (hq call doesn't show this call to this job)`;
    const words = a.kind === 'decision' && a.ceo_call ? `\n  The board's words: ${wordsOf(a, shown)}` : '';
    const carriers = JSON.parse(a.carriers) as number[];
    const work = carriers.length
      ? carriers.map(id => workState(id, open)).join('; ')
      : a.pause
        ? `the pause on ${a.pause}`
        : a.request
          ? `card #${a.request}`
          : 'no job';
    return `- item #${a.id} (call ${a.call}, ${a.kind} for ${a.owner}, ${a.status}): ${a.what} · ${work}${words}`;
  });
  return `What the board agreed and still stands:\n${lines.join('\n') || '- nothing'}`;
}

// Whether hq call would show a call to the CEO's job `reader` (memory.ts callAccess: not a live call's, one carried from
// a card for keys or one about a customer it may not read), each call read once however many items it has; a customer
// call's reader holds their details from then on.
function callsShown(reader: jobs.Reader) {
  const shown = new Map<number, boolean>();
  return (call: number) => {
    let ok = shown.get(call);
    if (ok === undefined) {
      ok = memory.callAccess(call, reader) === true;
      if (ok && memory.customerCall(call)) jobs.handedCustomerData(reader.id);
      shown.set(call, ok);
    }
    return ok;
  };
}

// The quote as hq call would give it to the reader (`shown`: callsShown's)
function wordsOf(a: Pick<Agreement, 'call' | 'quote'>, shown: (call: number) => boolean) {
  if (!shown(a.call)) return `left out (hq call ${a.call} doesn't show this call to this job)`;
  return `"${clip(a.quote)}"`;
}

// A pause's call item (pauses.ts) for the CEO's job `reader`: what it says, and the board's words as hq call would show
// them.
export function itemWords(id: number, reader: jobs.Reader) {
  const item = db.prepare('select call, kind, what, quote from call_items where id = ?').get(id) as
    Pick<Agreement, 'call' | 'kind' | 'what' | 'quote'> | undefined;
  if (!item) return `item #${id} (not found)`;
  const shown = callsShown(reader);
  if (!shown(item.call)) return `item #${id}: left out (hq call doesn't show this call to this job)`;
  return `item #${id} (call ${item.call}, ${item.kind}): ${item.what}\n    The board's words: ${wordsOf(item, shown)}`;
}

// A job's state in a line: open (as hq jobs says it), or how it ended and where its pull request stands. (Its status and
// branch from db.ts jobs_state.)
function workState(id: number, open: OpenByID) {
  const known = open.get(id);
  if (known) return known.line;
  const ended = prepared(
    `select j.status, (select '#' || p.number || ' ' || p.status from prs p
        where p.branch = coalesce(j.branch, 'job/' || j.id) order by p.number desc limit 1) pr from jobs j indexed by jobs_state
        where j.id = ?`,
  ).get(id) as { status: string; pr: string | null } | undefined;
  if (!ended) return `job #${id} (not found)`;
  const replacement = jobs.replacementOf(id);
  const taken = replacement
    ? `, taken over by #${replacement}`
    : ended.status === 'failed'
      ? ', nobody has taken it over'
      : '';
  return `job #${id} ${ended.status}${ended.pr ? `, PR ${ended.pr}` : ''}${taken}`;
}

const clip = (quote: string) => jobs.preview(oneLine(quote), QUOTE_MAX);

export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
