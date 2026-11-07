// The machine's one browser slot can't be held for good. A render takes it with an exclusive flock on /run/lock
// (shared/browser/supervise.ts) and keeps it within its own 30 min bound, the wait for the slot included, so a holder
// the worker sees keep it for HOLD_MS is past any render: a leftover. The worker ends every process holding the lock,
// and the renders waiting for it go on. Its log's warning says what it ended and why, and HQ's report counts it (infra/
// report.sh's errors of the last 24 hours).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { redact } from './safety.ts';

export const SLOT = '/run/lock';
export const HOLD_MS = 40 * 60_000;

// One look at the slot, to be made every minute or so: the holder it found, and since when it has seen it hold
export function slotWatch(path: string, holdMs: number, log: (line: string) => void) {
  let seen: { pid: number; since: number } | undefined;
  return (now = Date.now()) => {
    const lock = lockOf(path);
    const pid = holderOf(lock);
    if (pid === undefined) return void (seen = undefined);
    if (seen?.pid !== pid) seen = { pid, since: now };
    if (now - seen.since < holdMs) return;
    const holders = holdersOf(lock);
    const named = holders.map(holder => `${holder} (${commandOf(holder)}, uid ${uidOf(holder)})`).join(', ');
    log(
      `warning: the browser slot was held for ${Math.round((now - seen.since) / 60_000)} min, past its ${holdMs / 60_000} min bound: ended ${named || `pid ${pid}, no longer running`}; the renders waiting for it go on`,
    );
    for (const holder of holders) end(holder);
    seen = undefined;
  };
}

// The lock as /proc/locks names it: its device's major and minor numbers in hex, and its inode
function lockOf(path: string) {
  const { dev, ino } = statSync(path, { bigint: true });
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  const hex = (n: bigint) => n.toString(16).padStart(2, '0');
  return `${hex(major)}:${hex(minor)}:${ino}`;
}

// The process that took the lock, if one holds it (waiters' lines have "->")
function holderOf(lock: string) {
  for (const line of readFileSync('/proc/locks', 'utf8').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] === 'FLOCK' && fields[5] === lock) return Number(fields[4]);
  }
}

// Every process with a descriptor that holds the lock: the one that took it, and any that inherited it
function holdersOf(lock: string) {
  const holds = (line: string) => line.startsWith('lock:') && line.includes(' FLOCK ') && line.includes(` ${lock} `);
  return pids().filter(pid =>
    readdirOr(`/proc/${pid}/fdinfo`).some(fd => readOr(`/proc/${pid}/fdinfo/${fd}`).split('\n').some(holds)),
  );
}

function end(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // (it ended meanwhile)
  }
}

const pids = () =>
  readdirOr('/proc')
    .filter(name => /^\d+$/.test(name))
    .map(Number);
// (a command line can hold a token)
const commandOf = (pid: number) => redact(readOr(`/proc/${pid}/cmdline`).split('\0').join(' ').trim()).slice(0, 200);
const uidOf = (pid: number) => readOr(`/proc/${pid}/status`).match(/^Uid:\s+(\d+)/m)?.[1];

// A /proc file or folder of a process that may have ended meanwhile, or that isn't ours to read: empty then
function readOr(path: string) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
function readdirOr(path: string) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
