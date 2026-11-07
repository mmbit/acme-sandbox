// A new time on a deliverable told to the board (hq window --tell): only a slip of a time the board set itself reaches
// its desk phone, once, as a quiet notice HQ files, the board's already, so it skips the card reader. A new time on one
// of our own reaches nobody: the board reads it on the projects overview, and a card that only reports one is the card
// reader's to settle (cardread.ts).
import * as jobs from './jobs.ts';
import { findProject, type Thread } from './projects.ts';
import { BOARD, clock, type Window } from './windows.ts';

// Why --tell can't go with this move, or undefined when it can (or there's no --tell). `was`: the thread before the move.
// The words of a slip are checked as the desk phone checks a card's text (textProblem: hq ask's checks, server.ts).
export function problem(
  b: { tell?: unknown; board_set?: unknown },
  was: Thread,
  window: Window | null,
  textProblem: (text: string) => string | null,
) {
  if (b.tell === undefined) return undefined;
  const why = String(b.tell).trim();
  if (!why) return 'say why it slips and what you did: --tell "..."';
  if (b.board_set === true) return '--tell gives the board a new time, which is ours: no --board-set with it';
  if (!window) return '--tell gives the board a new time: name it';
  if (!isBoards(was)) return undefined;
  if (window.deadline <= was.deadline!)
    return (
      `the board's own time, ${clock(was.deadline!, Date.now())}, doesn't slip, so there's nothing to tell it. ` +
      "A new time without --tell is ours, and a miss of the board's own would reach nobody: to finish sooner, keep its " +
      'time with --board-set and aim earlier with --aim'
    );
  return textProblem(why) ?? undefined;
}

// The notice of a slip of the board's own time: filed by HQ from the job that moved it, under the name of whoever moved it,
// with the deliverable and its new time on the board's clock, and their words. A new time on our own files nothing, with
// why. The window route files it in the same step as the move, once problem() let it through.
export function file(was: Thread, window: Window, why: string, from: { agent: string; job: number }, now = Date.now()) {
  if (!isBoards(was))
    return { told: false, why: 'our own time: the board reads it on the projects overview and hears nothing of it' };
  const card = jobs.fileCard({
    kind: 'notice',
    urgency: 'today',
    title: `${was.name}: live by ${clock(window.deadline, now)}`,
    body: why.trim(),
    topic: findProject(was.project)!.name,
    agent: from.agent,
    job: from.job,
    read: false, // (the board's own time: nothing on the card tells the reader so)
  });
  // (only our own fields: nothing in fileCard refuses them)
  if (typeof card !== 'object') throw new Error(`The desk phone refused the slip notice: ${String(card)}`);
  return { told: true, card: card.id };
}

const isBoards = (thread: Thread) => thread.deadline_by === BOARD && thread.deadline !== null;
