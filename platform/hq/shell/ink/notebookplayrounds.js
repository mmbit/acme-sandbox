// The Notebook's store played in memory (notebookplay.js): a review round (a seeded notebook's round: { state, guests,
// asksOpen, closed, back }) closed from the Shelf, refused while asks are open unless anyway; one back from the CEO
// unwrapped. Each answers the round, as notebookrounds.ts does.
import { refuse } from './notebookplaychecks.js';

export function closeRound(s, b) {
  const n = roundOf(s, b);
  if (n.round.state !== 'open') refuse(409, 'That round is already closed.');
  if (n.round.asksOpen && b.anyway !== true)
    throw Object.assign(new Error('Asks are still open on this round.'), { status: 409, reason: 'asksOpen' });
  Object.assign(n.round, { state: 'away', closed: s.stamp() });
  s.changed(n.id, null);
  return structuredClone(n.round);
}
export function unwrapRound(s, b) {
  const n = roundOf(s, b);
  if (n.round.state !== 'back') refuse(409, "That round isn't back yet.");
  n.round.state = 'done';
  s.changed(n.id, null);
  return structuredClone(n.round);
}
// (a round book by its id: none, 404)
const roundOf = (s, b) => {
  const n = s.notebook(Number(b?.id));
  return n?.round ? n : refuse(404);
};
