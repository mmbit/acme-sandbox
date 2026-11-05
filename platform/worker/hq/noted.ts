// What a live call's agent hears once hq item puts something on its call's list (hq item add or replace on the call:
// the voice line's write_down on the phone, or off the notes page, and replace).
import { at } from './estimate.ts';
import { present, print, shown, text } from './output.ts';
import { stoppedOnCall } from './corrections.ts';

// The call's agent's answer: it's on the list, nobody has it yet, or (a promise about work under way) it's that job's,
// whose thread has its time already.
export function printNotedOnCall(
  recorded: Record<string, unknown>,
  { kind, owner, replaces }: { kind: string; owner: string; replaces: number | null },
) {
  const noted = `Noted as ${kind} #${shown(recorded.id)} on this call, for ${owner}`;
  if (replaces === null) print(`${noted}.`);
  else print(`${noted}: it replaces #${replaces} (${text(recorded.replacedWhat ?? '?')}), which the board changed.`);
  print(
    present(recorded.job)
      ? `It's job #${shown(recorded.job)}'s, done when that ends done, and the deadline of ${text(recorded.thread)} ` +
          `now: ${at(Date.parse(String(recorded.deadline)))}.`
      : "It's on the call's list, not handed to anyone yet: after the call, the follow-up hands it out.",
  );
  if (replaces !== null) print(...stoppedOnCall(recorded));
}
