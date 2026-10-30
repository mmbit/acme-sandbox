// A jam the worker's shares can't free: the worker short of memory while work waits to start (room.ts's starved spell),
// still ESCALATE_MS after it began, though the worker blocks the heaviest run past a job's share all along (blocks.ts).
// It goes to the CEO at once, as an incident (incidents.ts: a job the worker's incident slot starts whatever the room)
// naming the jobs holding the most, and the deploys shortly before it if any; and if that job still hasn't started
// CARD_MS later, to the board, a card on the desk phone whose Approve stops those jobs then and there (a tool's grant:
// approvals.ts). When the worker has room again, a card still open leaves the desk phone. One incident and one card a
// spell.
import { db, remember, setting } from './db.ts';
import { publish } from './events.ts';
import { ceo, roles } from './company.ts';
import * as approvals from './approvals.ts';
import * as jobs from './jobs.ts';
import * as incidents from './incidents.ts';

export const ESCALATE_MS = 10 * 60_000;
export const CARD_MS = 15 * 60_000;
const NAMED = 3; // the jobs an incident and a card name, those holding the most
const KEY = 'jam';
const GRANT = 'jam';

type Held = { job: number; mb: number };
export type Spell = { since: number; free: number; waiting: number; jobs: Held[] };
// A spell's escalation: when it began (the room's since), the CEO's incident job and when, the card, and the jobs they
// named (done: what Approve did with each, once the board approved)
type Jam = { since: number; incident?: number; noted?: number; card?: number; jobs: number[]; done?: string[] };

approvals.register(GRANT, { kind: GRANT, describe, decide });

// Each report of the room (room.ts): the spell under way, or none
export function watch(spell: Spell | undefined, now = Date.now()) {
  let jam = current();
  if (jam && jam.since !== spell?.since) {
    end(jam);
    jam = undefined;
  }
  if (!spell || now - spell.since < ESCALATE_MS) return;
  jam ??= { since: spell.since, jobs: [] };
  const named = heaviest(spell.jobs);
  if (!jam.noted) {
    jam.jobs = named.map(h => h.job);
    jam.incident = incidents.stalled('jam', jammed(spell, named, now), spell.since, true);
    jam.noted = now;
    if (jam.incident)
      publish({ type: 'log', agent: ceo(), text: `HQ called the CEO: the worker is jammed (job #${jam.incident}).` });
  } else if (!jam.card && now - jam.noted >= CARD_MS && unstarted(jam.incident)) {
    jam.jobs = named.map(h => h.job);
    const card = jobs.createRequest({
      kind: GRANT,
      urgency: 'now',
      agent: roles().process,
      title: 'Stop the jobs jamming the worker?',
      body: cardText(spell, named, now),
      approves: `${GRANT}:${jam.since}`,
    });
    if (typeof card === 'object') jam.card = card.id;
  }
  remember(KEY, JSON.stringify(jam));
}

function current(): Jam | undefined {
  const kept = setting(KEY);
  return kept ? (JSON.parse(kept) as Jam) : undefined;
}

// The spell ended (or another began): an open card leaves the desk phone, as HQ's doing
function end(jam: Jam) {
  remember(KEY, '');
  const open = jam.card && db.prepare("select 1 from requests where id = ? and status = 'open'").get(jam.card);
  if (open) jobs.endRequest(jam.card!, 'The worker has room again: nothing to stop.');
}

// The running jobs holding the most
function heaviest(held: Held[]) {
  return held
    .filter(h => jobs.jobAgent(h.job))
    .toSorted((a, b) => b.mb - a.mb)
    .slice(0, NAMED);
}

const mins = (ms: number) => Math.round(ms / 60_000);
const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
const row = (id: number) =>
  db.prepare('select agent, title, step, round, kind from jobs where id = ?').get(id) as
    { agent: string; title: string; step: string | null; round: number | null; kind: string } | undefined;

// (the incident's alarm, in its words: what the CEO judges from)
function jammed(spell: Spell, named: Held[], now: number) {
  const lines = named.map(h => {
    const j = row(h.job)!;
    return `- job #${h.job} (${j.agent}, ${j.kind}): ${gb(h.mb)}, "${jobs.nameOf(j)}"`;
  });
  return (
    `the worker has been short of memory for ${mins(now - spell.since)} min (${spell.free} MB free), and ` +
    `${spell.waiting} job${spell.waiting === 1 ? '' : 's'} can't start. The worker blocks the heaviest run past a ` +
    `job's share all along, and it hasn't freed the room. Holding the most:\n` +
    (lines.join('\n') || '- (no job holds much: something outside the jobs holds the worker, or the reading is wrong)')
  );
}

// (no incident at all, as the CEO's couldn't be made, counts as one not started)
const unstarted = (job?: number) =>
  !job || !!db.prepare("select 1 from jobs where id = ? and status = 'queued'").get(job);

function cardText(spell: Spell, named: Held[], now: number) {
  return (
    `No new work has started for ${mins(now - spell.since)} min: the worker is out of memory, and stopping the heaviest ` +
    `work hasn't freed it. ${spell.waiting} job${spell.waiting === 1 ? '' : 's'} wait. The CEO was called ` +
    `${mins(CARD_MS)} min ago, and couldn't start.\n\nApprove stops ${named.length === 1 ? 'the job' : 'the jobs'} holding the most, ` +
    'now. Not now leaves them running.\n\nRecommended: Approve.'
  );
}

const named = (id: number) => {
  const j = row(id)!;
  return `${jobs.findAgent(j.agent)?.name ?? j.agent}'s "${jobs.nameOf(j)}"`;
};

// What Approve does, in HQ's words: the jobs it stops, as the card named them
// (once approved, what came of it: decide)
function describe(grant: string) {
  const jam = current();
  const mine = jam && `${GRANT}:${jam.since}` === grant;
  if (mine && jam.done) return `${jam.done.join('. ')}. Their work so far stays on their branches.`;
  const each = (mine ? jam.jobs : []).map(named);
  return each.length
    ? `Approving stops ${new Intl.ListFormat('en-GB', { type: 'conjunction' }).format(each)} now. Their work so far stays on their branches.`
    : 'The worker has room again: approving stops nothing.';
}

// Approve takes the named jobs off the worker (jobs.ts offWorker) and keeps what came of each, which the answer then
// says (describe): a review goes back to the queue instead, and one that ended meanwhile is left as it is.
function decide(grant: string, yes: boolean, request: number) {
  const jam = current();
  if (!yes || !jam || `${GRANT}:${jam.since}` !== grant) return true;
  jam.done = jam.jobs.map(id => {
    const off = jobs.offWorker(
      id,
      `the board's card #${request}: the worker was out of memory, and this job held the most`,
    );
    const name = named(id);
    return typeof off === 'string'
      ? `${name} wasn't stopped: ${off}`
      : 'yields' in off
        ? `${name} goes back to the queue at its next step (a review can't end early), until the worker has room`
        : `${name} is stopping`;
  });
  remember(KEY, JSON.stringify(jam));
  publish({ type: 'log', agent: ceo(), text: `The board's card #${request}: ${jam.done.join('; ')}.` });
  return true;
}
