// hq say on a live call: the board's word to one job under way (the coordinator's call.ts reach).
import * as api from './api.ts';
import { readGoalAndWords } from './files.ts';
import { present, print, shown, stop } from './output.ts';

// On a live call (the voice line sets HQ_CALL), the board's word to a job under way (call.ts reach): hq say <agent> -
// --job <n> --what "line" --goal -, the words and the goal on stdin (files.ts readGoalAndWords), never a file or argv
// (--goal). The agent and the number must match, so a misheard number is refused.
// Only a refusal or no connection at all proves nothing was sent; anything else may have gone (exit 3).
export async function sayOnCall(args: string[]) {
  const [to, dash, jobFlag, job, whatFlag, what, goalFlag, goalDash] = args;
  const flagged = jobFlag === '--job' && whatFlag === '--what' && goalFlag === '--goal' && goalDash === '-';
  if (args.length !== 8 || dash !== '-' || !flagged || !/^[0-9]+$/.test(job)) {
    stop(
      'usage on a call: hq say <agent> - --job <number> --what "one line for the call\'s list" --goal - (the goal and the words on stdin, as JSON {"goal": "...", "words": "..."})',
    );
  }
  const given =
    readGoalAndWords() ?? stop('Nothing was sent: hq say on a call takes {"goal": "...", "words": "..."} on stdin.');
  const body = { to, job: Number(job), what, goal: given.goal, text: given.words.replace(/\n+$/, '') };
  const creation = await api.createOnce('message', body, answer => present(answer.item));
  if (!creation.made) {
    const { refused, status, error, failure } = creation;
    if (refused) stop(`Nothing was sent: ${failure ? "couldn't reach HQ" : error || 'HQ refused it'}.`);
    stop(`Not confirmed: it may or may not have gone (HQ answered ${api.httpCode(status)}).`, 3);
  }
  const reached = creation.answer;
  const listed = `It's on this call's list as item #${shown(reached.item)}, so the follow-up won't send it again.`;
  if (present(reached.message)) {
    return print(
      `Sent to ${to}'s job #${job}: its session reads it at its next step (message #${shown(reached.message)}). ${listed}`,
    );
  }
  const round = `round ${shown(reached.round)}`;
  print(
    reached.ruling === 'started'
      ? `With PR #${shown(reached.pr)}'s review from now on: the ruling on ${round} had already started without it, so the fixes and every later round read it. ${listed}`
      : `With PR #${shown(reached.pr)}'s review from now on: the ruling on ${round} reads it, as do the fixes and every later round (reviews already running don't). ${listed}`,
  );
}
