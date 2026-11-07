// The machine's one browser slot, which no leftover keeps: the worker ends a holder past its bound.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { commandLine, procStat, processes } from './detached.ts';

export const SLOT = '/run/lock';
// (a render keeps the slot within its own 30 min bound, the wait for it included: shared/browser/supervise.ts)
export const HOLD_MS = 40 * 60_000;

type Holder = ReturnType<typeof holdersOf>[number];
const keyOf = (holder: Holder) => `${holder.pid}/${holder.start}`; // (a pid is used again once its process has gone)

// One look at the slot, to be made every minute or so. The lock is timed from when it was first seen held, and every
// holder ends once that is holdMs ago. A holder can hand the lock on between two looks: it starts a child, which
// inherits it, and goes. The child then keeps the start of the holders that went: a render's taker runs until its
// render ends, so a lock whose taker has gone is no new render's.
export function slotWatch(path: string, holdMs: number, log: (line: string) => void) {
  let since = new Map<string, number>();
  return (now = Date.now()) => {
    const target = realpathSync(path);
    const holders = free(target) ? [] : holdersOf(target, lockOf(target));
    const seen = holders.flatMap(holder => since.get(keyOf(holder)) ?? []);
    const gone = [...since].filter(([key]) => !holders.some(holder => keyOf(holder) === key)).map(([, from]) => from);
    const handedOn = holders.every(holder => !existsSync(`/proc/${holder.taker}`));
    const from = seen.length ? Math.min(...seen) : handedOn ? Math.min(...gone, now) : now;
    since = new Map(holders.map(holder => [keyOf(holder), from]));
    if (!holders.length || now - from < holdMs) return;
    const minutes = Math.round((now - from) / 60_000);
    const listed = holders.map(holder => `${holder.pid} (${commandLine(holder.pid).slice(0, 200)}, uid ${holder.uid})`);
    log(
      `warning: the browser slot was held for ${minutes} min, past its ${holdMs / 60_000} min bound: ended ${listed.join(', ')}`,
    );
    for (const holder of holders) end(holder);
    since.clear();
  };
}

// Whether nothing holds the lock: one flock try, so a free slot costs no read of every process's descriptors
function free(path: string) {
  const tried = spawnSync('flock', ['--nonblock', '--conflict-exit-code', '75', path, 'true']);
  if (tried.status === 0) return true;
  if (tried.status === 75) return false;
  throw new Error(`flock couldn't try the browser slot: ${tried.error ?? tried.stderr}`);
}

// The lock as fdinfo's "lock:" line names it: its device's major and minor numbers in hex, and its inode
function lockOf(path: string) {
  const { dev, ino } = statSync(path, { bigint: true });
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  const hex = (n: bigint) => n.toString(16).padStart(2, '0');
  return `${hex(major)}:${hex(minor)}:${ino}`;
}

// Every process with a descriptor on the slot that holds its lock: the one that took it, and any that inherited it (a
// waiter's descriptor has no "lock:" line). Each has the lock's taker as the line names it, which is a pid that no
// process has once the taker has gone (0 in a pid namespace).
function holdersOf(target: string, lock: string) {
  const takerIn = (fdinfo: string) => {
    const fields = fdinfo
      .split('\n')
      .find(line => line.startsWith('lock:') && line.includes(' FLOCK ') && line.includes(` ${lock} `))
      ?.split(/\s+/);
    return fields && Number(fields[fields.indexOf(lock) - 1]);
  };
  const takerOf = (pid: number) =>
    ofProcess(() => readdirSync(`/proc/${pid}/fd`), [])
      .filter(fd => ofProcess(() => readlinkSync(`/proc/${pid}/fd/${fd}`), '') === target)
      .map(fd => takerIn(ofProcess(() => readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'), '')))
      .find(taker => taker !== undefined);
  return processes().flatMap(found => {
    const taker = takerOf(found.pid);
    return taker === undefined ? [] : [{ ...found, taker }];
  });
}

// (only the process that was seen: one that has ended since may have left its pid to another)
function end(holder: Holder) {
  if (procStat(holder.pid)?.start !== holder.start) return;
  try {
    process.kill(holder.pid, 'SIGKILL');
  } catch {
    // (it ended meanwhile)
  }
}

// A read of one process's /proc files, which go as it ends: `none` then
function ofProcess<T>(read: () => T, none: T) {
  try {
    return read();
  } catch {
    return none;
  }
}
