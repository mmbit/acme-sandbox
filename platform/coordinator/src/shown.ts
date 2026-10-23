// The desk phone's open cards, as SQL (later.ts: cards for later, and cards held until work they wait for is live), in a
// module with no imports of its own: push.ts reads it, and company.ts loads push.ts before most of HQ, so anything later.ts
// imports would otherwise be loaded half-made.
// A card (`card`, a requests row's alias) held for work still to go live (later.ts holdsFor).
export const heldCard = (card: string) => `exists (select 1 from request_holds h where h.request = ${card}.id)`;
export const HELD = heldCard('requests');
// A card on the desk phone at `now` (an SQL ISO time, often a parameter): not hidden then, nor held.
export const shownCard = (card: string, now: string) =>
  `(not ${heldCard(card)} and (${card}.hidden_until is null or ${card}.hidden_until <= ${now}))`;
// The query's own: none hidden at `now` (an ISO time, a parameter of the query), nor held
export const SHOWN = shownCard('requests', '?');
