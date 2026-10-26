// What a correction did to the jobs on the item it changed, as hq item and hq job print it (the coordinator's ledger.ts
// tell()).
import { present } from './output.ts';

type Stopped = {
  cancelled?: number[];
  told?: { job: number; message: number; became?: number; brief?: boolean }[];
  running?: number[];
};

const jobList = (ids: number[]) => ids.map(id => `#${id}`).join(', ');

// A correction's answer (hq item add --replaces, link, drop, hq job --item): the replaced or dropped item's jobs that
// never ran (cancelled), the running ones told, and those not told yet (the coordinator sends it again: ledger.ts tell()).
export function stopped({ cancelled = [], told = [], running = [] }: Stopped) {
  const lines: string[] = [];
  if ((cancelled ?? []).length > 0) lines.push(`Cancelled (never ran): ${jobList(cancelled)}.`);
  for (const { job, message, became, brief } of told ?? []) {
    // (brief)
    if (brief === true) {
      lines.push(`#${job} hasn't started: the correction is in its brief, so it starts with it (message #${message}).`);
    } else if (present(became)) {
      lines.push(
        `#${job} can't take a message mid-job (it waits for the board, or runs on Codex): the correction is job #${became} for its agent now (message #${message}).`,
      );
    } else {
      lines.push(
        `Told #${job}: the correction is queued for its session, which reads it at its next step (message #${message}; check: hq sent ${message}).`,
      );
    }
  }
  if ((running ?? []).length > 0) {
    lines.push(
      `Running and not told yet (the message was refused: this job's 30 messages an hour, or a full chain of messages): ${jobList(running)}. It's kept: the coordinator sends it once it can, within minutes of the limit allowing, while that job runs. Nothing to resend.`,
    );
  }
  return lines;
}

// The same on a live call, which tells nobody: the follow-up does.
export function stoppedOnCall({ cancelled = [], running = [] }: Stopped) {
  const lines: string[] = [];
  if ((cancelled ?? []).length > 0) lines.push(`Cancelled (never ran): ${jobList(cancelled)}.`);
  if ((running ?? []).length > 0) {
    lines.push(
      `Already running, so it runs on: ${jobList(running)}. It hears the correction from the call's follow-up, when it goes through this item or ends.`,
    );
  }
  return lines;
}
