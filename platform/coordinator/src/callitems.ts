// An item on a call's list with its time and the work under way it names, checked whole before anything is recorded:
// hq item add and replace, and on a live call what its agent writes down (ink/callnotes.ts writeDown).
import * as call from './call.ts';
import * as jobs from './jobs.ts';
import * as ledger from './ledger.ts';
import { keysAgent } from './memory.ts';
import * as projects from './projects.ts';
import * as windows from './windows.ts';
import { isRefused, refusableStep, RefusedError, type Refused } from './pagechecks.ts';

// Who records the item: a job (its id), or a live call's agent on its own call (id 0, callId the call)
export type Recorder = { id: number; agent: string; call?: boolean; callId?: number };
// The item as recorded, with the work it was linked to and the time that took
export type Item = Exclude<ReturnType<typeof ledger.add>, string | number> & {
  job?: number;
  deadline?: string | null;
  thread?: string;
};
// A live call's agent, recording on its own call
export const onCall = (c: { id: number; agent: string }): Recorder => ({
  id: 0,
  agent: c.agent,
  call: true,
  callId: c.id,
});

// A live call's item's owner, as named (none: the follow-up decides), or why not: a call about a card for keys is its own
// agent's alone (memory.ts keysAgent), named or left out. Its notes' write_down and hq item add on it alike.
export function ownerOn(call: number, owner: string | null): string | null | Refused {
  const keys = keysAgent(call);
  if (keys && owner !== null && owner !== keys)
    return [
      400,
      `owner: this call is about a card for keys, so its work is ${keys}'s alone: name ${keys} or leave it out`,
    ];
  return owner ?? keys;
}

// Item b on call `on`'s list, checked: the refusal of its time or the work it names, or the step that records it (onPage:
// a live call's item goes in its notes by itself, unless it's there already).
// deadline: the time the board was given for it, which its job takes. job, on a live call: the work under way it's
// about. The item is linked to it as it's added (as hq item link job:<id>, thread too), so its thread takes the time at
// once and it's handled when that work ends done: both or neither (askwindow.ts).
export function toList(on: number, b: any, by: Recorder, onPage = true): Refused | (() => Item | Refused) {
  const due = b.deadline == null ? undefined : windows.parse(String(b.deadline), Date.now(), true);
  if (typeof due === 'string') return [400, due];
  const work = b.job == null ? undefined : notedWork(b, due, by);
  if (isRefused(work)) return work;
  if (b.thread != null && !work) return [400, '--deliverable goes with --job: it puts that work on the deliverable'];
  // (--board-set: the board set that time itself, not one it was given: windows.ts BOARD)
  const quote = by.call && !b.quote ? b.what : b.quote,
    fields = { ...b, owner: String(b.owner), quote, due, dueBoard: b.board_set === true };
  const add = () => added(on, ledger.add(on, fields, by.call ? null : by.id, onPage));
  if (!work) return add;
  return () =>
    refusableStep(() => {
      const item = add();
      if (isRefused(item)) return item;
      const link = ledger.link(item.id, work, by.agent, by.id);
      // (the item with it: the step takes it back)
      if (typeof link === 'string') throw new RefusedError([409, link]);
      return { ...item, job: work.job, ...('deadline' in link && { deadline: link.deadline, thread: link.thread }) };
    });
}
// The work under way that a note written on a live call names (write_down's job, hq item add --job), checked before
// anything is recorded: its owner's (a misheard number names someone else's: call.ts reach), under way, and in an open
// thread, or put on the one it names (--thread) if the call queued it in none (askwindow.ts untimedLine).
function notedWork(b: any, due: number | undefined, by: Recorder): Refused | { job: number; thread?: string } {
  const id = Number(b.job),
    onto = b.thread == null ? undefined : String(b.thread);
  if (!by.call) return [400, '--job is for a live call: its follow-up links the item to the work (hq item link)'];
  if (due === undefined) return [400, "--job goes with --deadline: the time the work's deliverable takes"];
  const whose =
    Number.isSafeInteger(id) && id > 0
      ? call.notTheirs(String(b.owner), id)
      : ([404, `there's no job #${b.job}`] as Refused);
  if (whose) return whose;
  if (windows.finished(id) || windows.dropped(id))
    return [409, `job #${id} isn't work under way: write it down without it, and the follow-up links it`];
  const queuedHere = call.queuedHere(by.callId, id);
  if (onto === undefined) {
    const thread = windows.threadOf({ job: id });
    if (typeof thread !== 'string') return { job: id };
    // (the field is deliverable)
    return [
      409,
      queuedHere
        ? `${thread}: write it down with the open deliverable it serves too (deliverable)`
        : `${thread}: write it down without it, and the follow-up puts the work on a deliverable`,
    ];
  }
  const had = jobs.threadOf(id);
  if (had && projects.isOpen(had))
    return [409, `job #${id} is on ${had} already: write it down without the deliverable`];
  if (!queuedHere) return [409, `job #${id} wasn't queued on this call: only one you queued goes on a deliverable now`];
  if (!projects.isOpen(onto)) return [409, `${onto} isn't an open deliverable (eta lists them)`];
  return { job: id, thread: onto };
}
// ledger.add's answer as an item or a refusal
const added = (on: number, answer: ReturnType<typeof ledger.add>): Item | Refused =>
  typeof answer === 'object' ? answer : typeof answer === 'string' ? [400, answer] : [answer, `there's no call #${on}`];
