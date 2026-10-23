// A decision of the board's, named ahead of its card ("pick the art direction"), and what waits for it: a pause on each
// project or thread it blocks (pauses.ts), which holds their queued work, reviews and fixes until the board answers the
// card that asks it. Nothing else ends it: an agent, the CEO too, can't read it as met. Work it doesn't block goes on.
import { db, inOneStep } from './db.ts';
import { publish } from './events.ts';
import * as pauses from './pauses.ts';
import { ceo } from './company.ts';
import { oneLine } from './agreements.ts';

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
  if (by !== ceo()) return `only the CEO (${ceo()}) ties a card to a decision`;
  const d = openDecision(id);
  if (typeof d === 'string') return d;
  if (!db.prepare("select 1 from requests where id = ? and status = 'open'").get(card))
    return `card #${card} isn't open on the desk phone`;
  db.prepare('update decisions set request = ? where id = ?').run(card, id);
  return { ok: true as const };
}

// Whether the CEO can tie a card to it (createRequest's --decides)
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
