// What a test starts ends with it, however it got away: each node:test file's process imports this (suites.ts).
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

// The marks, one for each run a process is part of: a suite's (tests.ts), and its file's within it
export const MARK = 'TESTS_TREE';
// How long a SIGKILLed process can take to leave /proc: the kernel ends it within milliseconds, unless it is stuck in
// the kernel (a hung disk or mount), which no signal ends. One still there after this is reported, not waited on: no
// further look would end it, and the file's end, and the run behind it, would wait on it with nothing to show.
const LOOKING_MS = 2_000;
const PAUSE_MS = 20;

// (node:test sets NODE_TEST_CONTEXT in the files' processes alone)
if (process.env.NODE_TEST_CONTEXT) {
  const mark = randomUUID();
  process.env[MARK] = [process.env[MARK], mark].filter(Boolean).join(' ');
  process.on('exit', () => endMarked(mark));
}

// Ends every process but this one whose environment carries the mark. One being ended still shows until it has gone,
// and one forked meanwhile carries the mark too, so it looks again until it finds none, and says which it couldn't end.
export function endMarked(mark: string) {
  const until = Date.now() + LOOKING_MS;
  for (;;) {
    const marked = readdirSync('/proc').filter(
      name => /^\d+$/.test(name) && Number(name) !== process.pid && marksOf(name).includes(mark),
    );
    if (!marked.length) return;
    if (Date.now() >= until) {
      process.stderr.write(
        `Tests' leftovers still running ${LOOKING_MS / 1000} s after their end: ${marked.join(', ')}\n`,
      );
      return;
    }
    for (const pid of marked) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // (it ended meanwhile)
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PAUSE_MS); // (it runs as a process exits: no awaiting)
  }
}

// A process's marks as it started, or none for one that ended or isn't ours to read
function marksOf(pid: string) {
  try {
    const entry = readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .find(line => line.startsWith(`${MARK}=`));
    return entry?.slice(MARK.length + 1).split(' ') ?? [];
  } catch {
    return [];
  }
}
