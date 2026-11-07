// What a test starts ends with it. Each node:test file's process imports this (suites.ts): it marks the environment
// everything the file starts inherits, and as the file ends, every process still marked ends too, however it got away
// (detached into a session of its own, or orphaned). node:test waits for a file's output to close, which a leftover
// would hold open for good, and a leftover holding a lock (the worker's browser slot) blocks every job behind it. The
// tests' runner ends each suite's leftovers the same way (tests.ts).
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

export const MARK = 'TESTS_TREE';

// (node:test sets NODE_TEST_CONTEXT in the files' processes alone)
if (process.env.NODE_TEST_CONTEXT) {
  const mark = randomUUID();
  process.env[MARK] = mark;
  process.on('exit', () => endMarked(mark));
}

// Ends every process but this one whose environment carries the mark, looking again while it finds any, so one forked
// meanwhile goes too
export function endMarked(mark: string) {
  const entry = `${MARK}=${mark}`;
  for (let round = 0; round < 3; round++) {
    const marked = readdirSync('/proc').filter(
      name => /^\d+$/.test(name) && Number(name) !== process.pid && environment(name).includes(entry),
    );
    if (!marked.length) return;
    for (const pid of marked) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // (it ended meanwhile)
      }
    }
  }
}

// A process's environment as it started, or none for one that ended or isn't ours to read
function environment(pid: string) {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch {
    return [];
  }
}
