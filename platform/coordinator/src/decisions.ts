// A decision of the board's, named ahead of its card ("pick the art direction"), and what waits for it: a pause on each
// project or thread it blocks (pauses.ts), which holds their queued work, reviews and fixes until the board answers the
// card that asks it. Nothing else ends it: an agent, the CEO too, can't read it as met. Work it doesn't block goes on.
import { db, inOneStep } from './db.ts';
import { publish } from './events.ts';
import * as pauses from './pauses.ts';
import { ceo } from './company.ts';
import { oneLine } from './agreements.ts';
import { ENDED_ITEMS } from './jobs.ts';

const NAME_MAX = 120;

type Decision = { id: number; name: string; by: string; at: string; request: number | null };

// hq decision "name" --blocks <project | project/thread>...: the CEO names it and blocks what depends on it, all of it
// or nothing. The answer is the decision and its pauses, or why not.
export function create(name: unknown, blocks: unknown[], by: string) {
  if (by !== ceo()) return `only the CEO (${ceo()}) names a decision of the board's`;
  const said = oneLine(String(name ?? ''));
  if (!said || said.length > NAME_MAX) return `name the decision in a line of up to ${NAME_MAX} characters`;
  const targets = [...new Set(blocks.map(String))];
  if (!targets.length) return 'a decision blocks one project or thread at least (--blocks <project | project/thread>)';
  const why = `waiting for the board's decision: ${said}`;
  try {
    return inOneStep(() => {
      const at = new Date().toISOString();
      const id = Number(
        db.prepare('insert into decisions (name, by, at) values (?, ?, ?)').run(said, by, at).lastInsertRowid,
      );
      const held = targets.map(target => {
        const paused = pauses.pause(
          { ...(target.includes('/') ? { thread: target } : { project: target }), why, decision: id },
          by,
        );
        if (typeof paused === 'string') throw new RefusedError(paused);
        return paused.target;
      });
      publish({ type: 'log', agent: by, text: `Waiting for the board's decision: ${said}` });
      return { id, name: said, blocks: held };
    });
  } catch (err) {
    if (err instanceof RefusedError) return err.message;
    throw err;
  }
}
class RefusedError extends Error {}

// hq decision link <id> <card>, or hq ask ... --decides <id> (jobs.ts createRequest): the open card that asks it. Its
// answer is the board's decision. Another card in its place (the first was closed, or rewritten as a new one) takes over.
export function link(id: number, card: number, by: string) {
  if (!canLink(id, by)) return `only the CEO, or a visual decision's card author, ties a card to decision #${id}`;
  const d = openDecision(id);
  if (typeof d === 'string') return d;
  if (mergeDecision(id) && d.request !== card && !canFile(id)) return 'this decision already has an open card';
  if (!db.prepare("select 1 from requests where id = ? and status = 'open'").get(card))
    return `card #${card} isn't open on the desk phone`;
  if (mergeDecision(id)) {
    const { questions } = db.prepare('select questions from requests where id = ?').get(card) as {
      questions: string | null;
    };
    const choices = questions && JSON.parse(questions);
    if (JSON.stringify(choices) !== JSON.stringify(mergeQuestions))
      return 'the visual card needs Go live and Changes first';
  }
  db.prepare('update decisions set request = ? where id = ?').run(card, id);
  return { ok: true as const };
}

// Whether the decision is still awaited (createRequest's --decides)
export const isOpen = (id: number) => typeof openDecision(id) !== 'string';

// The summary's lines (summary.ts): each decision still awaited, what it holds, and its card or that it has none yet.
export function awaited() {
  const open = db
    .prepare('select * from decisions where answered is null and released is null order by id')
    .all() as Decision[];
  const paused = open.length ? pauses.open() : []; // (once for them all)
  return open.map(d => {
    const held = paused.filter(p => p.decision?.id === d.id).map(p => `${p.target} (${p.held} queued)`);
    const card = d.request
      ? `card #${d.request}`
      : `no card yet: file it with hq ask ... --decides ${d.id}, or tie one with hq decision link ${d.id} <card>`;
    const merges = db.prepare('select pr from decision_merges where decision = ? order by pr').all(d.id) as {
      pr: number;
    }[];
    held.push(...merges.map(m => `PR #${m.pr}'s merge`));
    return `decision #${d.id} "${d.name}", since ${d.at.slice(0, 16).replace('T', ' ')} UTC, holds ${held.join(', ') || 'nothing now'}: ${card}`;
  });
}

function openDecision(id: number): Decision | string {
  const d = db.prepare('select * from decisions where id = ?').get(id) as
    (Decision & { answered: string | null; released: string | null }) | undefined;
  if (!d) return `there's no decision #${id}`;
  if (d.answered || d.released) return `decision #${id} was ${d.answered ? 'answered' : 'let go'} already`;
  return d;
}

// Review holds use the same decision and card lifecycle as --blocks, with merges as the held work.
export function holdMerge(pr: { number: number; branch: string; author: string; sha: string }, thread: string | null) {
  return inOneStep(() => {
    const previous = db.prepare('select decision, sha from decision_merges where pr = ?').get(pr.number) as
      { decision: number; sha: string } | undefined;
    if (previous?.sha === pr.sha) return { id: previous.decision, needsCard: false, replacedCard: null };
    const scope = thread ?? pr.branch;
    let decision = db
      .prepare(
        `select d.* from decisions d join decision_merges m on m.decision = d.id
      where m.scope = ? and d.answered is null and d.released is null limit 1`,
      )
      .get(scope) as Decision | undefined;
    const replacedCard = decision?.request ?? null;
    let needsCard = !decision;
    if (!decision) {
      const name = 'Go live with the visual changes';
      const id = Number(
        db
          .prepare('insert into decisions (name, by, at) values (?, ?, ?)')
          .run(name, pr.author, new Date().toISOString()).lastInsertRowid,
      );
      decision = { id, name, by: pr.author, at: new Date().toISOString(), request: null };
    } else if (decision.request) {
      // A card cannot approve pictures that were added after it was filed.
      db.prepare('update decisions set request = null where id = ?').run(decision.id);
      needsCard = true;
    }
    db.prepare('insert or replace into decision_merges (pr, decision, sha, scope) values (?, ?, ?, ?)').run(
      pr.number,
      decision.id,
      pr.sha,
      scope,
    );
    return { id: decision.id, needsCard, author: decision.by, replacedCard };
  });
}

export function retireMerge(pr: number) {
  return inOneStep(() => {
    const decision = db
      .prepare(
        `select d.* from decisions d join decision_merges m on m.decision = d.id
      where m.pr = ?`,
      )
      .get(pr) as (Decision & { answered: string | null; released: string | null }) | undefined;
    if (!decision) return undefined;
    db.prepare('delete from decision_merges where pr = ?').run(pr);
    if (decision.answered || decision.released) return undefined;
    const remaining = mergeDecision(decision.id);
    db.prepare('update decisions set request = null, released = ? where id = ?').run(
      remaining ? null : new Date().toISOString(),
      decision.id,
    );
    return {
      id: decision.id,
      author: decision.by,
      replacedCard: decision.request,
      needsCard: remaining && !!decision.request,
    };
  });
}

// hq decision settle <id> item:<n> | card:<n>: a visual decision the board already answered in its own words, a call's
// item or a card it answered, settled by the CEO without the card it waits for. Only the board's word settles it, never
// an agent's: the item or card is the record, and the CEO only ties it to the decision. The answer is what the settling
// leaves to end (the card job the hold queued, its open card) and the held pull requests, or why not.
export function settle(id: number, word: string, by: string) {
  if (by !== ceo()) return `only the CEO (${ceo()}) settles a decision on the board's word`;
  const d = openDecision(id);
  if (typeof d === 'string') return d;
  if (!mergeDecision(id))
    return `decision #${id} holds no visual change: only the board's answer on its card lets it go`;
  const [, kind, n] = /^(item|card):([0-9]+)$/.exec(word) ?? [];
  if (!kind) return "name the board's word as item:<n> (a call's item) or card:<n> (a card the board answered)";
  const given = kind === 'item' ? boardItem(Number(n)) : boardCard(Number(n));
  if (typeof given === 'string') return given;
  const { said } = given;
  const at = new Date().toISOString();
  db.prepare('update decisions set answered = ?, settled = ? where id = ?').run(at, word, id);
  publish({ type: 'log', agent: by, text: `Decision #${id} "${d.name}" settled on the board's ${said}` });
  const { card_job } = db.prepare('select card_job from decisions where id = ?').get(id) as { card_job: number | null };
  return { cardJob: card_job, card: d.request, said, merges: merges(id) };
}

// A call's item the board said, still standing (not dropped or replaced)
function boardItem(n: number) {
  const item = db.prepare('select what, status from call_items where id = ?').get(n) as
    { what: string; status: string } | undefined;
  if (!item) return `there's no call item #${n}`;
  if (ENDED_ITEMS.includes(item.status)) return `item #${n} was ${item.status}: it's no standing word of the board's`;
  return { said: `item #${n} ("${item.what}")` };
}

// A card the board itself answered: a guest's answer, or a card closed without one, isn't the board's word
function boardCard(n: number) {
  const card = db.prepare('select title, kind, status from requests where id = ?').get(n) as
    { title: string; kind: string; status: string } | undefined;
  if (!card) return `there's no card #${n}`;
  if (card.status !== 'answered' || card.kind === 'guest') return `card #${n} wasn't answered by the board`;
  return { said: `card #${n} ("${card.title}")` };
}

export const mergeQuestions = [
  {
    title: 'Go live with these visual changes?',
    detail: 'Go live is recommended.',
    options: ['Go live', 'Changes first'],
  },
];

export const mergeDecision = (id: number) => !!db.prepare('select 1 from decision_merges where decision = ?').get(id);
export const canLink = (id: number, by: string) =>
  by === ceo() ||
  !!db
    .prepare(
      `select 1 from decisions d
  join decision_merges m on m.decision = d.id where d.id = ? and d.by = ?`,
    )
    .get(id, by);
export const mergeCard = (card: number) =>
  !!db
    .prepare(
      `select 1 from decisions d join decision_merges m
  on m.decision = d.id where d.request = ?`,
    )
    .get(card);
export const heldMerge = (pr: number) =>
  db
    .prepare(
      `select d.id, d.request from decisions d join decision_merges m
  on m.decision = d.id where m.pr = ? and d.answered is null and d.released is null`,
    )
    .get(pr) as { id: number; request: number | null } | undefined;

// The held pull requests still open, by their decision
const merges = (id: number) =>
  db
    .prepare(
      `select p.number, p.branch, p.author from prs p join decision_merges m on m.pr = p.number
  where m.decision = ? and p.status in ('open', 'board', 'stuck')`,
    )
    .all(id) as { number: number; branch: string; author: string }[];

export const cardMerges = (card: number) =>
  db
    .prepare(
      `select p.number, p.branch, p.author from prs p
  join decision_merges m on m.pr = p.number join decisions d on d.id = m.decision
  where d.request = ? and p.status in ('open', 'board', 'stuck')`,
    )
    .all(card) as { number: number; branch: string; author: string }[];

export const canFile = (id: number) =>
  !db
    .prepare(
      `select 1 from decisions d join requests r on r.id = d.request
  where d.id = ? and r.status = 'open'`,
    )
    .get(id);

// The assigned card author reads the current waiting set before taking its pictures.
export function show(id: number, by: string) {
  if (!canLink(id, by)) return 'only the CEO or the assigned card author reads this decision';
  const decision = db.prepare('select * from decisions where id = ?').get(id) as Decision | undefined;
  if (!decision) return `there is no decision #${id}`;
  const merges = db
    .prepare(
      `select p.number, p.branch, p.author, m.sha from decision_merges m
    join prs p on p.number = m.pr where m.decision = ? and p.status in ('open', 'board', 'stuck') order by p.number`,
    )
    .all(id);
  return { ...decision, merges };
}
