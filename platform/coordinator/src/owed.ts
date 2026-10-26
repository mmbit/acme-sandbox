// What a product owes the board after its feedback: one owner, one job at a time, until it's back on the desk phone.
// The board's feedback on a product comes in pieces, in any order: review notes sent from HQ (feedback.ts), and its
// answers on cards tagged with the product (hq ask --product/--back). Each piece opens the product's owed return, or
// joins it:
//   - The owner is the product's (product.yaml `owner`, or a cycle folder's maker:
//     else the CEO; a new owner takes the return over once no job of the old one is on it). Every piece goes to the job
//     that holds the return: added to its prompt while it hasn't started, or to a job queued after it while it runs.
//     So no two jobs work on one product's feedback side by side, each thinking the other brings it back.
//   - It closes when a card filed with --back <slug> reaches the desk phone (a new presentation, or why not), or with
//     `hq owed close <slug> "why"` when the board's words ask for nothing back. Not while a job that hasn't run holds a
//     piece the card can't have covered.
//   - A job that ends with the return still open (a fix that needs its pull request merged first, or one that just
//     stopped) gets a follow-up for the owner, queued after it, so it starts once the fix is on main. sweep() checks
//     every minute, whatever ended the job; after FOLLOW_UPS of those it stays open for whoever reads the status
//     (hq owed, STATUS.md).
import { db, mergePending, redacted } from './db.ts';   // (redacted)
import { publish } from './events.ts';
import * as jobs from './jobs.ts';
import { ceo } from './company.ts';
import { codeOf } from './jobcodes.ts';
import { madeForProduct } from './made.ts';
// (the products, the cycles' pages, their owners and folders: owedproducts.ts.)
import { folder, isProduct, isKey, ownerOf } from './owedproducts.ts';
// (what a return's job reads: owedbrief.ts.)
import { brief, duty } from './owedbrief.ts';
export { CYCLES, folder, isProduct, isKey, about, ownerOf, slugs } from './owedproducts.ts';

const FOLLOW_UPS = 2;   // follow-ups sweep() queues for one return before it waits for the status report
const LIVE = "status in ('queued', 'running', 'blocked')";
// owed: job is the job that holds it now; follow_ups how many sweep() queued; stalled when it gave up queuing them;
//   card the request that brought it back; outcome how it closed, in a line.
// owed_pieces: kind is notes (review notes sent from HQ) or answer (the board's answer on a card).
// owed_jobs: the jobs this module made, whose whole prompt is their return's brief.
// owed_told: what a running asker reads with the answer (hq wait) about whose job brings each product back.
db.exec(`create table if not exists owed (id integer primary key, slug text not null, agent text not null, opened text not null,
  job integer, follow_ups integer not null default 0, stalled text, closed text, card integer, outcome text);
  create table if not exists owed_pieces (id integer primary key, owed integer not null, at text not null, kind text not null,
    request integer, notes text, job integer, text text not null);
  create table if not exists owed_jobs (job integer primary key, owed integer not null);
  create table if not exists owed_told (request integer primary key, text text not null);
  create table if not exists request_products (request integer not null, slug text not null, back integer not null default 0,
    primary key (request, slug))`);
// outcome holds the closer's own words, which every agent reads (hq owed) and the status report shows.
redacted('owed', 'outcome');

type Owed = { id: number; slug: string; agent: string; opened: string; job: number | null; follow_ups: number;
  stalled: string | null };
type Piece = { kind: 'notes' | 'answer'; request?: number; notes?: number[]; text: string };

// ---------------------------------------------------------------- the desk phone
// createRequest: the card is about these products (its answer is feedback on them), and brings back these.
export function tag(request: number, about: string[], back: string[], job?: number) {
  const insert = db.prepare('insert or ignore into request_products (request, slug, back) values (?, ?, ?)');
  for (const slug of new Set([...about, ...back])) insert.run(request, slug, back.includes(slug) ? 1 : 0);
  for (const slug of back) presented(slug, request, job);
}
export const productsOf = (request: number) => db.prepare('select slug, back from request_products where request = ? order by slug')
  .all(request) as { slug: string; back: number }[];

// answerRequest: the board answered a tagged card. Each product's owner hears it through its return. The asker still
// hears its own card (hear: tell()), told which job has which product. Where the job that hears the card is the
// product owner's and can hold the return (holds), that job holds it, and is told how it ends: one job, not two.
// heir: a job queued after the card that hears it for an asker that has ended (jobs.ts tellWaiting). hear gets the
// lines for the job that hears the card, and the lines on which job brings each product back, for every other job
// waiting for it. Returns what hear returned.
export function answered(req: { id: number; agent: string | null; job: number | null; title: string }, answer: string,
  heir: number | undefined, hear: (extra: string, others: string) => number | undefined) {
  const tagged = productsOf(req.id).map(product => ({ ...product, ...ownerOf(product.slug), held: holderOf(product.slug) }));
  if (!tagged.length) return hear('', '');
  const piece = (product: { name: string }): Piece => ({ kind: 'answer', request: req.id,
    text: `The board answered card #${req.id} ("${req.title}"), which is about ${product.name}, on its desk phone: ${answer}` });
  // tell() gives the answer to the asking job while it runs or waits on this card.
  // Otherwise the waiting job hears it, or tell() makes a new job for the asker.
  // An intercom chat holds no product return. A work job brings the product back, and the chat hears which job.
  const asker = req.job ? db.prepare('select kind, status, request from jobs where id = ?').get(req.job) as
    { kind: string; status: string; request: number | null } | undefined : undefined;
  const hearing = asker?.kind === 'work' && (asker.status === 'running' || (asker.status === 'blocked' && asker.request === req.id));
  const hearer = hearing ? req.job : heir ?? null;
  const hearerAgent = !hearing && heir ? agentOf(heir) : req.agent;
  const kept = asker?.kind === 'chat' ? []
    : tagged.filter(product => (product.held?.agent ?? product.agent) === hearerAgent && holds(product.slug, hearer));
  const carriedBy = (product: { name: string }, carrier: { agent: string; job: number }) =>
    `${product.name}: ${jobs.findAgent(carrier.agent)?.name ?? carrier.agent} (job #${carrier.job})`;
  const routed = tagged.filter(product => !kept.includes(product)).map(product => carriedBy(product, feedback(product.slug, piece(product))));
  const yours = kept.map(product => `\n\nYou own bringing ${product.name} (${folder(product.slug)}) back to the board after `
    + `this answer. HQ keeps that open, as owed to the board, until you do.\n${duty(product.slug, product.name)}`).join('');
  // (no other job waits for the card when the hearer is still to be made)
  const keptBy = hearer && hearerAgent ? kept.map(product => carriedBy(product, { agent: hearerAgent, job: hearer })) : [];
  const extra = goneTo(routed) + yours;
  const heard = hear(extra, goneTo([...routed, ...keptBy]));
  // a running asker reads the answer itself (hq wait), and tell() leaves it at that: the answer it reads carries this
  if (extra && asker?.status === 'running' && heard === req.job)
    db.prepare('insert or replace into owed_told (request, text) values (?, ?)').run(req.id, extra);
  for (const product of kept) feedback(product.slug, piece(product), heard);
  return heard;
}
// The line on which job brings each product back (carriers: "<product>: <agent> (job #<n>)"), for a job that doesn't.
function goneTo(carriers: string[]) {
  if (!carriers.length) return '';
  const one = carriers.length === 1;
  return `\n\nThe answer on ${one ? 'this product' : 'these products'} also went to the job that brings ${one ? 'it' : 'each'} `
    + `back to the board: ${carriers.join(', ')}. Leave bringing ${one ? 'it' : 'them'} back to that job.`;
}
// requestAnswer (hq wait): what the asker reads after the board's answer.
export const told = (request: number) => (db.prepare('select text from owed_told where request = ?').get(request) as
  { text: string } | undefined)?.text ?? '';

// ---------------------------------------------------------------- feedback joins the return
// A piece of the board's feedback on slug: to the job that holds the product's return. heardBy: a job of the owner's
// that hears it already (the asker's: parked on the card, running, or just queued to hear it, its prompt told how the
// return ends): it carries the piece and holds the return if it can (holds). Returns the job that carries the piece,
// and whose it is.
export function feedback(slug: string, piece: Piece, heardBy?: number) {
  const owing = open(slug) ?? start(slug);
  const owner = ownerOf(slug).agent;
  if (owing.agent !== owner && !(owing.job && isLive(owing.job))) {   // a new owner, and nobody of the old one's on it
    db.prepare('update owed set agent = ? where id = ?').run(owner, owing.id);
    owing.agent = owner;
  }
  let job: number, made = false;
  if (heardBy && holds(slug, heardBy) && isLive(heardBy) && agentOf(heardBy) === owing.agent) job = heardBy;
  else if (owing.job && waiting(owing.job)) job = owing.job;
  else {
    made = true;
    job = jobs.createJob({ agent: owing.agent, title: 'Board feedback', prompt: '', after: previous(slug, owing) }).id;
    db.prepare('insert into owed_jobs (job, owed) values (?, ?)').run(job, owing.id);
  }
  // (a holder still to start waits for every task with a piece of it too.)
  if (waiting(job)) waitForPieces(owing, job, previous(slug, owing));
  // new words from the board: the follow-ups count again
  db.prepare('update owed set job = ?, follow_ups = 0, stalled = null where id = ?').run(job, owing.id);
  owing.job = job;
  const notes = piece.notes ? JSON.stringify(piece.notes) : null;
  db.prepare('insert into owed_pieces (owed, at, kind, request, notes, job, text) values (?, ?, ?, ?, ?, ?, ?)')
    .run(owing.id, new Date().toISOString(), piece.kind, piece.request ?? null, notes, job, piece.text);
  const name = ownerOf(slug).name;
  if (waiting(job) && ours(job)) brief(owing, job);
  // a job that hears the card and hasn't started takes later pieces at the end of what tell() wrote (a running or
  // parked one has the answer in its session already)
  else if (waiting(job) && job !== heardBy) db.prepare(`update jobs set prompt = prompt || ? where id = ?
    and status = 'queued' and session is null`).run(`\n\nMore feedback on ${name}, which you also bring back:\n\n${piece.text}`, job);
  // (in the product's project, named by its brief's title.)
  if (made) madeForProduct(slug, { id: job });
  const what = piece.kind === 'notes' ? 'review notes' : `card #${piece.request}`;
  publish({ type: 'log', agent: owing.agent, text: `Board feedback on ${slug} (${what}) is with job #${job}` });
  return { job, agent: agentOf(job) ?? owing.agent };
}

// ---------------------------------------------------------------- the board's notes in a task (routing.ts)
// Whether a task of agent's (job: an open one, null: one still to make) holds slug's return with its notes: the
// product's owner's, and no other job has had a piece of it or holds it still (holds).
export const canHold = (slug: string, agent: string, job: number | null) => ownerOf(slug).agent === agent && holds(slug, job);
// What a task's brief says about the return of the product its notes are on: how it ends when the task holds it, else
// that the owner's return follows it.
export function returnWords(slug: string, holding: boolean) {
  const { agent, name } = ownerOf(slug);
  if (holding) return `You own bringing ${name} (${folder(slug)}) back to the board after these notes. HQ keeps that open, \
as owed to the board, until you do.\n\n${duty(slug, name)}`;
  return `HQ brings ${name} back to the board once this work is done: a job of ${jobs.findAgent(agent)!.name}'s, \
queued after it, shows the board each change. Say in your report what changed for each note on ${name}.`;
}
// A task's notes on slug, a piece of the product's return. The task holds the return when it can (canHold, as its brief
// said), else the return follows it: sweep() queues it once no job with a piece is still on it, and the job that holds
// it, while it hasn't started, waits for this task's merge too, and no more for the routing check that held them.
export function carried(slug: string, piece: Piece, job: number, holding: boolean) {
  const owing = open(slug) ?? start(slug);
  if (owing.job && piece.notes) routedOn(owing.job, slug, piece.notes);
  db.prepare('insert into owed_pieces (owed, at, kind, request, notes, job, text) values (?, ?, ?, ?, ?, ?, ?)')
    .run(owing.id, new Date().toISOString(), piece.kind, null, piece.notes ? JSON.stringify(piece.notes) : null, job, piece.text);
  // new words from the board: the follow-ups count again
  if (holding) {
    owing.agent = ownerOf(slug).agent;
    owing.job = job;
  } else if (owing.job && owing.job !== job && waiting(owing.job)) {
    holdFor(owing.job, job);
    if (ours(owing.job)) brief(owing, owing.job);
  }
  db.prepare('update owed set agent = ?, job = ?, follow_ups = 0, stalled = null where id = ?').run(owing.agent, owing.job, owing.id);
  if (waiting(job) && ours(job)) brief(owing, job);
  publish({ type: 'log', agent: owing.agent, text: `Board feedback on ${slug} (review notes) is with job #${job}` });
}

// The board's notes given back to routing from the work they went to (feedback.ts backToRouting), as they go to other
// work: they're a piece of no job's any more (text: what's left of a piece in words, routing.ts pieceText). A job whose
// only feedback on a product they were, and that held its return, lets that go and the waits it had for the return's other
// pieces and its routing checks (routedOff): the job the notes go to next holds it if it can (canHold), else sweep()
// queues it after the work, once the notes are routed. A job that held none, its holder still to start waits for no more, but for the routing check that takes
// the notes (check), until they're routed (carried: then for the job they go to). A check ended without routing them
// holds it still (a check never merges), until any job of the CEO's routes them (routing.ts). Any other feedback a job
// has stays its. Returns the products whose return a job let go.
export function givenBack(notes: number[], text: (kept: number[]) => string, check: number) {
  const pieces = db.prepare(`select p.id, p.owed, p.job, p.notes from owed_pieces p join owed o on o.id = p.owed
    where p.kind = 'notes' and o.closed is null and exists (select 1 from json_each(p.notes) where value in
    (select value from json_each(?)))`).all(JSON.stringify(notes)) as { id: number; owed: number; job: number; notes: string }[];
  const emptied = new Map<number, Set<number>>();   // owed: the jobs left without a piece of it
  for (const piece of pieces) {
    const kept = (JSON.parse(piece.notes) as number[]).filter(note => !notes.includes(note));
    if (kept.length) db.prepare('update owed_pieces set notes = ?, text = ? where id = ?').run(JSON.stringify(kept), text(kept), piece.id);
    else db.prepare('delete from owed_pieces where id = ?').run(piece.id);
    if (!db.prepare('select 1 from owed_pieces where owed = ? and job = ?').get(piece.owed, piece.job))
      emptied.set(piece.owed, (emptied.get(piece.owed) ?? new Set()).add(piece.job));
  }
  const released: string[] = [];
  for (const id of new Set(pieces.map(piece => piece.owed))) {
    const owing = db.prepare('select * from owed where id = ?').get(id) as Owed;
    if (owing.job && emptied.get(id)?.has(owing.job)) {
      for (const other of holders(owing).filter(other => other !== owing.job))
        db.prepare('delete from waits where job = ? and on_job = ?').run(owing.job, other);
      routedOff(owing);
      db.prepare('update owed set job = null where id = ?').run(id);
      released.push(owing.slug);
    } else if (owing.job && waiting(owing.job)) {
      // (a holder still to start waits no more for a job that has no piece of it left)
      for (const gone of emptied.get(id) ?? []) db.prepare('delete from waits where job = ? and on_job = ?').run(owing.job, gone);
      holdFor(owing.job, check);
      if (ours(owing.job)) brief(owing, owing.job);
    }
  }
  return released;
}
// The board's notes on a product given back to routing and not routed again yet (routing.ts): its return waits for them.
const inRouting = (slug: string) =>
  !!db.prepare('select 1 from note_routes where slug = ? and returns = 1 and routed is null').get(slug);
// notes on slug routed: holder waits no more for the routing checks that held them (givenBack), those with none of slug's
// left to route.
const routedOn = (holder: number, slug: string, notes: number[]) => db.prepare(`delete from waits where job = ? and on_job in
  (select job from note_routes where note in (select value from json_each(?))) and not exists (select 1 from note_routes r
  where r.job = waits.on_job and r.slug = ? and r.returns = 1 and r.routed is null)`).run(holder, JSON.stringify(notes), slug);
// owing's holder lets it go: it waits no more for the routing checks this return held it for (givenBack), but for one
// that still has unrouted notes of another return it holds.
const routedOff = (owing: Owed) => db.prepare(`delete from waits where job = ? and on_job in
  (select job from note_routes where slug = ? and returns = 1) and not exists (select 1 from note_routes r join owed o
  on o.slug = r.slug and o.closed is null where r.job = waits.on_job and o.job = waits.job and o.id != ? and r.returns = 1
  and r.routed is null)`).run(owing.job, owing.slug, owing.id);

const open = (slug: string) => db.prepare('select * from owed where slug = ? and closed is null order by id desc limit 1')
  .get(slug) as Owed | undefined;
function start(slug: string) {
  const { lastInsertRowid } = db.prepare('insert into owed (slug, agent, opened) values (?, ?, ?)')
    .run(slug, ownerOf(slug).agent, new Date().toISOString());
  return db.prepare('select * from owed where id = ?').get(Number(lastInsertRowid)) as Owed;
}
// The live job that holds slug's open return, and whose it is.
function holderOf(slug: string) {
  const owing = open(slug);
  return owing?.job && isLive(owing.job) ? { job: owing.job, agent: owing.agent } : undefined;
}
// Whether job (a job that hears a card, or the new one tell() will make: null) can hold slug's return itself: no other
// job has had a piece of it, and none it would have to wait for is still on it. Else it would start beside that job,
// or before its fix merged, its prompt without the earlier words.
function holds(slug: string, job: number | null) {
  const owing = open(slug);
  const elsewhere = owing && db.prepare('select 1 from owed_pieces where owed = ? and job is not ?').get(owing.id, job);
  const before = previous(slug, owing);
  return !elsewhere && (!before || before === job);
}
// The job a new holder of slug's return queues after: the one that holds it now, or the last return's while it's still
// on it (feedback right after its --back card).
function previous(slug: string, owing?: Owed) {
  if (owing?.job) return owing.job;
  const last = db.prepare('select job from owed where slug = ? and closed is not null and job is not null order by id desc limit 1')
    .get(slug) as { job: number } | undefined;
  return last && isLive(last.job) ? last.job : undefined;
}
// A holder of the return still to start, queued after `after`, also waits for every other job with a piece of it, still
// on it or its pull request still to merge: it starts once all their work is on main.
function waitForPieces(owing: Owed, job: number, after: number | undefined | null) {
  for (const other of holders(owing).filter(other => other !== after && other !== job && toMerge(other)))
    holdFor(job, other);
}
// holder waits for other's merge, unless other needs holder first (a later task in its thread, its waits): neither
// would ever start. Then presented() keeps the return open until other merges, and sweep() queues it after holder.
function holdFor(holder: number, other: number) {
  if (!jobs.prerequisites([other], { ordered: true }).some(prior => prior.id === holder)) jobs.holdForMerge(holder, other, 'hq');
}
const toMerge = (job: number) => !!db.prepare(`select 1 from jobs j where id = ? and ${mergePending('j')}`).get(job);
const isLive = (job: number) => !!db.prepare(`select 1 from jobs where id = ? and kind = 'work' and ${LIVE}`).get(job);
// queued and never started: its prompt can still take more (a started session has read it already)
const waiting = (job: number) => !!db.prepare(`select 1 from jobs where id = ? and kind = 'work' and status = 'queued'
  and session is null`).get(job);
const ours = (job: number) => !!db.prepare('select 1 from owed_jobs where job = ?').get(job);
const agentOf = (job: number) => (db.prepare('select agent from jobs where id = ?').get(job) as { agent: string } | undefined)?.agent;

// ---------------------------------------------------------------- closing
// A card filed with --back slug. Closes the return unless another job that holds a piece is still to run or on it (the
// card came from someone else's job, before its fix), or its pull request is still to merge (the card can't show it), or
// the board's notes on it are back in routing (inRouting): sweep() then queues the return after it.
function presented(slug: string, request: number, job?: number) {
  const owing = open(slug);
  if (!owing) return;
  if (inRouting(slug)) return publish({ type: 'log', agent: owing.agent,
    text: `Card #${request} brings ${slug} back, but its return stays open: the board's notes on it are being routed again` });
  const busy = holders(owing).filter(holder => holder !== job && toMerge(holder));
  if (busy.length) return publish({ type: 'log', agent: owing.agent,
    text: `Card #${request} brings ${slug} back, but its return stays open: job #${busy[0]} has feedback on it not on main yet` });
  db.prepare('update owed set closed = ?, card = ?, outcome = ? where id = ?')
    .run(new Date().toISOString(), request, `brought back on card #${request}`, owing.id);
  publish({ type: 'log', agent: owing.agent, text: `${slug} is back on the board's desk phone (card #${request})` });
}
function holders(owing: Owed) {
  const pieces = db.prepare('select job from owed_pieces where owed = ? order by id').all(owing.id) as { job: number }[];
  const pieceJobs = pieces.map(piece => piece.job);
  return [...new Set([owing.job, ...pieceJobs])].filter((job): job is number => !!job);
}

// hq close on a --back card before the board answered it: it brought nothing back, so the return it closed opens again
// (unless the product owes a newer one already). A card the board talked through on a call stays brought back: the call's
// follow-up carries the board's words on.
export function withdrawn(request: number) {
  const call = db.prepare("select id, job from calls where request = ? and status = 'ended' and job is not null order by id desc limit 1")
    .get(request) as { id: number; job: number } | undefined;
  for (const owing of db.prepare('select * from owed where card = ?').all(request) as Owed[]) {
    if (open(owing.slug)) continue;
    if (call) {
      publish({ type: 'log', agent: owing.agent, text: `Card #${request} left the desk phone after call #${call.id} about it: `
        + `${owing.slug} stays brought back, and the call's follow-up (job #${call.job}) has the board's words` });
      continue;
    }
    db.prepare('update owed set closed = null, card = null, outcome = null where id = ?').run(owing.id);
    publish({ type: 'log', agent: owing.agent,
      text: `Card #${request} was taken off the desk phone: ${owing.slug} owes the board its return again` });
  }
}

const WHY_MAX = 300;

// hq owed close <slug> "why": the board's words ask for nothing back. Its owner or the CEO, from a job that holds the
// return or once no job of it is still on it. A refusal is [status, why].
export function close(slug: string, agent: string, job: number, why: string) {
  // (a dropped product's folder may be gone already; isKey)
  const owing = isKey(slug) ? open(slug) : undefined;
  if (!owing) return [404, `${slug} owes the board nothing`] as const;
  const owners = [owing.agent, isProduct(slug) ? ownerOf(slug).agent : owing.agent, ceo()];
  if (!owners.includes(agent)) return [403, `${slug}'s return is ${owing.agent}'s (or the CEO's) to close`] as const;
  why = why.replace(/\s+/g, ' ').trim();
  if (!why || why.length > WHY_MAX)
    return [400, `say why nothing goes back to the board, in one line of up to ${WHY_MAX} characters: the board reads it`] as const;
  const busy = holders(owing).filter(holder => holder !== job && isLive(holder));
  if (busy.length) return [409, `job #${busy[0]} still holds feedback on ${slug}: it closes it, or brings it back`] as const;
  db.prepare('update owed set closed = ?, outcome = ? where id = ?')
    .run(new Date().toISOString(), `closed by ${agent}: ${why}`, owing.id);
  publish({ type: 'log', agent, text: `${slug} owes the board nothing more: ${why}` });
  return { ok: true };
}

// ---------------------------------------------------------------- the check
// Every minute (server.ts): an open return whose job has ended gets a follow-up for its owner, queued after that job
// (so it waits for the job's pull request), up to FOLLOW_UPS; past that it's logged once, and the status report (hq owed, STATUS.md) shows it.
export function sweep() {
  for (const owing of db.prepare('select * from owed where closed is null').all() as Owed[]) {
    // (every job with a piece of it: a task routed its notes)
    const held = holders(owing);
    if (held.some(isLive) || inRouting(owing.slug)) continue;   // (inRouting)
    if (owing.follow_ups >= FOLLOW_UPS) {
      if (!owing.stalled) {
        db.prepare('update owed set stalled = ? where id = ?').run(new Date().toISOString(), owing.id);
        publish({ type: 'log', agent: owing.agent,
          text: `${owing.slug} still owes the board its return after ${FOLLOW_UPS} follow-ups (last job #${owing.job}): `
            + 'nobody is on it' });
      }
      continue;
    }
    if (isProduct(owing.slug) && ownerOf(owing.slug).agent !== owing.agent) {   // a new owner takes it over
      owing.agent = ownerOf(owing.slug).agent;
      db.prepare('update owed set agent = ? where id = ?').run(owing.agent, owing.id);
    }
    // After the job that held it, else the last task with a piece of it, and every other such job's pull request still
    // to merge; in the product's project, named by its brief's title
    const last = owing.job ?? held.at(-1) ?? null;
    const job = jobs.createJob({ agent: owing.agent, title: 'Back to the board', prompt: '',
      // (the task it brings back carries its code: jobcodes.ts.)
      after: last ?? undefined, code: codeOf(last) ?? undefined }).id;
    waitForPieces(owing, job, last);
    db.prepare('update owed set job = ?, follow_ups = follow_ups + 1 where id = ?').run(job, owing.id);
    db.prepare('insert into owed_jobs (job, owed) values (?, ?)').run(job, owing.id);
    brief(owing, job);
    madeForProduct(owing.slug, { id: job });
    const after = last ? ` after job #${last}` : '';
    publish({ type: 'log', agent: owing.agent,
      text: `${owing.slug} still owes the board its return: job #${job} brings it back${after}` });
  }
}

// ---------------------------------------------------------------- reading
// hq owed and the status report: what's open, and what closed in the last day.
export function list() {
  const rows = db.prepare(`select o.*, j.status job_status, (select count(*) from owed_pieces where owed = o.id) pieces from owed o
    left join jobs j on j.id = o.job where o.closed is null or o.closed > ? order by o.closed is not null, o.opened`)
    .all(new Date(Date.now() - 864e5).toISOString()) as any[];
  // (new feedback may have queued a job since it stalled)
  const stalled = (row: any) => ['queued', 'running', 'blocked'].includes(row.job_status) ? null : row.stalled;
  return rows.map(row => ({ ...row, name: ownerOf(row.slug).name, stalled: stalled(row) }));
}
