// The flags hq commands take anywhere after the command, taken out before their other arguments are read.
import { stop } from './output.ts';
import { companyLevels } from './files.ts';

export type ItemFlags = {
  item?: string;
  replaces?: string;
  call?: string;
  deadline?: string;
  lands?: string;
  job?: string;
  goal?: string;
};

// --item, --replaces and --call <number> (hq items), --lands <job> (hq job: the failed job whose saved work it lands),
// --job <job> (hq item add on a live call: the work under way a promise is about),
// --deadline <when> (hq item add, replace: the item's time; hq job refuses it), and --goal - (hq item add and replace,
// and hq job on a call: why the board wants it, on stdin with the words). hq job's --goal.
export function takeItemFlags(given: string[], command: 'job' | 'item') {
  const flags: ItemFlags = {};
  const args: string[] = [];
  for (let i = 0; i < given.length; i++) {
    const flag = given[i];
    const value = given[i + 1];
    const numbered = ['--item', '--replaces', '--call'].includes(flag);
    if (numbered || (command === 'job' && flag === '--lands') || (command === 'item' && flag === '--job')) {
      if (!/^[0-9]+$/.test(value ?? ''))
        stop(`${flag} needs a number (${numbered ? 'hq items' : flag === '--lands' ? 'the failed job' : 'the job'})`);
      flags[flag.slice(2) as 'item' | 'replaces' | 'call' | 'lands' | 'job'] = value;
      i++;
    } else if (flag === '--deadline') {
      if (command === 'job')
        stop("No job was queued: hq job takes no --deadline. Its time is its deliverable's window: --by <when>");
      // (hq_tools.py reads "Nothing recorded" as a refusal; the time's forms)
      if (!value)
        stop("Nothing recorded: --deadline needs a time (2h, 90m, 2026-10-26 09:00 on the company's clock, 14:30 UTC)");
      flags.deadline = value;
      i++;
    } else if (flag === '--goal') {
      if (value !== '-') {
        stop(
          `${command === 'job' ? 'No job was queued' : 'Nothing recorded'}: --goal takes -, the goal on stdin with the words as JSON {"goal": "...", "words": "..."}`,
        );
      }
      flags.goal = value;
      i++;
    } else {
      args.push(flag);
    }
  }
  return { flags, args };
}

// --when <event>, anywhere and repeated, taken out before the other arguments are read (the coordinator reads each:
// wakes.ts).
// (its loop is takeRepeated's)
export function takeWhen(given: string[]) {
  const { values, args } = takeRepeated(
    given,
    '--when',
    'No job was queued: --when needs an event (deploy, deploy:2, recreated:worker, deployed:<job>, 2h, 14:30)',
  );
  return { when: values, args };
}

// --<name> <value> flags, the ones `names` lists, by name without their dashes. refused: how the command says it did
// nothing ("No thread was started").
export function takeValues(given: string[], names: string[], refused: string) {
  const values: Record<string, string> = {};
  const args: string[] = [];
  for (let i = 0; i < given.length; i++) {
    const flag = given[i];
    const value = given[i + 1];
    if (!names.includes(flag)) {
      args.push(flag);
      continue;
    }
    if (!value) stop(`${refused}: ${flag} needs a value`);
    values[flag.slice(2)] = value;
    i++;
  }
  return { values, args };
}

// --<name> <value>, anywhere and repeated, every value in order. refused: what the command says if a value is missing.
export function takeRepeated(given: string[], name: string, refused: string) {
  const values: string[] = [],
    args: string[] = [];
  for (let i = 0; i < given.length; i++) {
    if (given[i] !== name) {
      args.push(given[i]);
      continue;
    }
    const value = given[++i];
    if (!value) stop(refused);
    values.push(value);
  }
  return { values, args };
}

export type NewThread = { project: string; name: string; goal: string; needs?: string[] };

type ThreadFlag = { thread?: string; newThread?: NewThread; args: string[] };

// --thread, the old name of --deliverable, read as it
export const deliverableFlag = (given: string[]) => given.map(arg => (arg === '--thread' ? '--deliverable' : arg));

// --deliverable <project>/<slug>, the open deliverable hq job's work goes in, or --deliverable new:<project> "name"
// "done when" [--needs <deliverable>]..., one it starts. Without either, the job stays in the deliverable of the job that
// queued it.
export function takeThread(flags: string[]): ThreadFlag {
  const given = deliverableFlag(flags);
  const at = given.indexOf('--deliverable');
  if (at === -1) return { args: given };
  const [value = '', name = '', goal = ''] = given.slice(at + 1);
  const project = /^new:([^/\s]+)$/.exec(value)?.[1];
  const width = project ? 4 : 2;
  const { needs, args } = takeNeeds([...given.slice(0, at), ...given.slice(at + width)], 'No job was queued');
  if (args.includes('--deliverable')) stop('No job was queued: --deliverable comes once');
  if (needs.length && !project)
    stop('No job was queued: --needs goes with --deliverable new:, the deliverable it draws');
  if (project) {
    if (!name.trim() || !goal.trim()) {
      stop(
        `No job was queued: --deliverable new:${project} needs a "name" and a "done when". ${companyLevels().lines.thread}`,
      );
    }
    return { newThread: { project, name, goal, ...(needs.length && { needs }) }, args };
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) {
    stop(
      `No job was queued: --deliverable takes <project>/<slug> or new:<project> "name" "done when" (hq deliverable list). ${companyLevels().lines.thread}`,
    );
  }
  return { thread: value, args };
}

// --needs <deliverable>, any number of times: the deliverables a new one waits for, done and merged, and the arguments left
export function takeNeeds(given: string[], refused: string) {
  const needs: string[] = [];
  const args = given.filter((arg, i) => {
    if (given[i - 1] === '--needs') return false;
    if (arg !== '--needs') return true;
    if (!given[i + 1]) stop(`${refused}: --needs takes a deliverable`);
    needs.push(given[i + 1]);
    return false;
  });
  return { needs, args };
}
