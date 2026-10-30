// Walk-throughs of finished work. Finished work lands on the desk phone, never as a page in the
// book, and its card offers "Walk me through it" when its maker judged it worth one (a new feature yes, an icon no): one
// flag the maker sets as it files the card (hq ask --walk, requests.walk: jobs.ts createRequest). Tapping it rings the maker about the card;
// nobody is ever rung out of the blue.
//   - The call is a walk-through (calls.walk) only when HQ says so and its card offers one, and its agent's briefing
//     says what's asked of it: open the work on the board's screen, drive it and ring things as it talks.
//   - Its page is the call's notes page, as any call's (ink/callnotes.ts): one page a call, gone at the end if nothing's
//     on it.
import { db } from './db.ts';

const offered = (request: number) =>
  !!(db.prepare('select walk from requests where id = ?').get(request) as { walk: number } | undefined)?.walk;

// A new call about a card (call.ts context): a walk-through when HQ asked for one and the card offers it
export function begin(call: number, request: number, walk: boolean) {
  if (walk && request && offered(request)) db.prepare('update calls set walk = 1 where id = ?').run(call);
}
export const isWalk = (call: number) =>
  !!(db.prepare('select walk from calls where id = ?').get(call) as { walk: number } | undefined)?.walk;

// What the call's agent is told, under what the call is about
export const BRIEFING = `## A walk-through
The board tapped "Walk me through it" on this card: walk them through the work it's about, as its maker. Open it on their
screen (open_work: a preview's address, or one of HQ's own screens), then drive it as you talk (drive: scroll to
something, scroll a screen, point at something) and ring what matters with draw. Talk them through what it does and
why, at their pace; they can draw alongside you or take over at any point, and whatever they write on this call's page
in their book is kept for you to act on afterwards.
`;
