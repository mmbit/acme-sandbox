// The whole book check shared out over workers side by side (book-check.mjs --worker, each a process with its own
// server, played stores and browsers): the next part goes to whichever worker is free, so the two engines and every
// story run at once. A worker that dies mid-part fails that part and another takes its place.
import { fork } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';

// A worker at its fullest (its node, server, WebKit and Chromium with a part's pages open): the whole check on one
// worker on the shots helper held 2.3 GB at most beyond what the machine held before it
const WORKER_BYTES = 2.3e9;

// Plays parts ({ engine, name }, in order) on count workers of entry (none: workersHere()), each started with args and
// --worker, every part's line logged as it comes, each part through the memory hold (below), and each part with what
// its worker sent back given to played. Returns how many failed, on how many
// workers, the most memory in use and how much of it the check's (bytes), and how long parts waited for memory (ms).
export async function sharedOut(entry, args, parts, count, played = () => {}) {
  const queue = [...parts],
    workers = Math.min(count || workersHere(), queue.length),
    hold = memoryHold(queue),
    before = inUse();
  let failed = 0,
    peak = before;
  const watch = setInterval(() => (peak = Math.max(peak, inUse())), 1000);
  const worker = () =>
    new Promise(done => {
      const child = fork(entry, [...args, '--worker'], { stdio: 'inherit' });
      let doing = null;
      const next = async () => {
        doing = await hold.next(child.pid);
        child.send(doing);
      };
      const ended = () => {
        hold.ended(child.pid);
        doing = null;
      };
      child.on('message', result => {
        console.log(result.line);
        if (!result.ok) failed++;
        played(doing, result);
        ended();
        next();
      });
      child.on('exit', code => {
        if (!doing) return done();
        failed++;
        console.log(`FAIL ${doing.engine}: ${doing.name}\n     its worker ended mid-part (${code})`);
        ended();
        (queue.length ? worker() : Promise.resolve()).then(done);
      });
      next();
    });
  await Promise.all(Array.from({ length: workers }, worker));
  clearInterval(watch);
  return { failed, count: workers, peak, own: peak - before, waitedMs: hold.waitedMs() };
}

// As many workers as this machine holds: a worker keeps about two cores busy (its node and its browser's page), and
// each takes a worker's fullest of the memory left
const workersHere = () =>
  Math.max(1, Math.min(Math.floor(availableParallelism() / 2), Math.floor(memoryNow().left / WORKER_BYTES)));
// The next part off queue for the worker of that pid, one start at a time so each sees the one before it counted: a
// part starts once the memory left holds what its worker may still grow by (a worker at its fullest, less what it
// holds) beside what the workers playing may still grow by, or once nothing else plays. A machine pushed into swap goes
// quiet for minutes.
function memoryHold(queue) {
  const playing = new Set();
  let waitedMs = 0,
    turn = Promise.resolve();
  const room = pid => {
    if (!playing.size) return true;
    const holding = heldBy([pid, ...playing]),
      toCome = worker => Math.max(0, WORKER_BYTES - holding.get(worker)),
      coming = [...playing].reduce((sum, worker) => sum + toCome(worker), 0);
    return memoryNow().left - coming >= toCome(pid);
  };
  return {
    next: pid =>
      (turn = turn.then(async () => {
        if (!queue.length) return null;
        const from = performance.now();
        while (!room(pid)) await new Promise(r => setTimeout(r, 1000));
        waitedMs += performance.now() - from;
        playing.add(pid);
        return queue.shift();
      })),
    ended: pid => playing.delete(pid),
    waitedMs: () => waitedMs,
  };
}
// What each of pids holds with the processes under it that can't be reclaimed (bytes): their share of the memory they
// share with others, anonymous or shared (smaps_rollup's Pss_Anon and Pss_Shmem)
function heldBy(pids) {
  const parentOf = new Map();
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    const stat = processFile(pid, 'stat');
    if (stat) parentOf.set(Number(pid), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
  }
  const topOf = pid => (pids.includes(pid) ? pid : parentOf.has(pid) ? topOf(parentOf.get(pid)) : null),
    holding = new Map(pids.map(pid => [pid, 0]));
  for (const pid of parentOf.keys()) {
    const top = topOf(pid),
      // (empty for one ended but not yet reaped)
      rollup = top && processFile(pid, 'smaps_rollup');
    if (!rollup) continue;
    const kB = name => Number(rollup.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))[1]) * 1024;
    holding.set(top, holding.get(top) + kB('Pss_Anon') + kB('Pss_Shmem'));
  }
  return holding;
}
// A file of a process in /proc, or none for one that ended as it was read
function processFile(pid, file) {
  try {
    return readFileSync(`/proc/${pid}/${file}`, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return null;
    throw e;
  }
}
// The memory in use: the machine's less what's left
const inUse = () => {
  const { limit, left } = memoryNow();
  return limit - left;
};
const CGROUP = '/sys/fs/cgroup';
// The memory this machine has and what's left of it that no part holds: in a cgroup with a limit, the limit less what
// the cgroup holds but for its file cache, which the kernel hands back when a part needs it (memory.stat's active_file
// and inactive_file). Outside one, the kernel's MemTotal and MemAvailable.
function memoryNow() {
  const limit = existsSync(`${CGROUP}/memory.max`) ? readFileSync(`${CGROUP}/memory.max`, 'utf8').trim() : 'max';
  if (limit === 'max') {
    const meminfo = readFileSync('/proc/meminfo', 'utf8'),
      kB = name => Number(meminfo.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))[1]) * 1024;
    return { limit: kB('MemTotal'), left: kB('MemAvailable') };
  }
  const stat = readFileSync(`${CGROUP}/memory.stat`, 'utf8'),
    bytes = name => Number(stat.match(new RegExp(`^${name} (\\d+)`, 'm'))[1]),
    held = Number(readFileSync(`${CGROUP}/memory.current`, 'utf8')) - bytes('active_file') - bytes('inactive_file');
  return { limit: Number(limit), left: Number(limit) - held };
}
