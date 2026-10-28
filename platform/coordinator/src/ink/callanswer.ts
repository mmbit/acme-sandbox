// The book on a call (Ink answers, DESIGN section 6): the board's notes reach the call's agent as the Pencil lifts
// (bookcalls.ts forVoice), each with what the judge made of it (bookjudge.ts) and the versions its try has clipped on
// so far. A text answer on one is the call's agent's own, written with its answer_note tool (hq answer-note): it heard
// the conversation, so no quick run starts for a call's note (bookanswer.ts asks booktry.ts onCall).
//   - What changes on a call's note later (its verdict made, a version landed) is a 'book' event naming the call and the
//     note: the board's HQ tells the line (calldraw.js 'noted'), which reads the note again and gives the agent its line.
import { db } from '../db.ts';
import { publish } from '../events.ts';
import type { Refused } from '../pagechecks.ts';
import { BOARD } from './book.ts';
import { clipText } from './bookanswer.ts';
import { SLIP_MAX } from './bookslips.ts';
import { onCall, type Target } from './booktry.ts';

type Caller = { agent: string; call?: boolean; callId?: number };

// The board's note number `n` on live call `call`'s page
const callNote = (call: number, n: number) =>
  (Number.isInteger(n) && n > 0
    ? db
        .prepare(
          `select n.id from book_notes n join book_pages p on p.id = n.page join calls c on c.id = p.call
            where p.call = ? and p.kind = 'call' and n.n = ? and n.by = p.who and c.status = 'live' order by n.id desc limit 1`,
        )
        .get(call, n)
    : undefined) as { id: number } | undefined;

// POST /api/agent/call-answer { note, words } (the call's answer_note tool): the call's agent's answer written on the
// board's note (its number on the call's page), beside it in the book, as any agent's text answer
export function answerOnCall(b: any, me: Caller) {
  if (!me.call || !me.callId) return [403, "only a call's agent answers a note on its call this way"] as Refused;
  const n = callNote(me.callId, Number(b?.note));
  if (!n) return [404, `the board drew no note ${b?.note} on this call's page`] as Refused;
  const words = typeof b.words === 'string' ? b.words.trim() : '';
  if (!words || words.length > SLIP_MAX) return [400, `an answer is text, at most ${SLIP_MAX} characters`] as Refused;
  return { slip: clipText({ note: n.id }, me.agent, words) };
}

// Something new on a note on a live call (its verdict, a version): the board's HQ tells the line to read it again
export function heardOnCall(t: Target) {
  const call = onCall(t);
  const note = t.note ?? (t.grp ? noteOfGroup(t.grp) : null);
  if (call && note) publish({ type: 'book', agent: BOARD, text: 'call note', call, note });
}
const noteOfGroup = (grp: number) =>
  (db.prepare('select note from notebook_groups where id = ?').get(grp) as { note: number | null } | undefined)?.note ??
  null;
