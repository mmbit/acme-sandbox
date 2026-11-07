// The run helper: a machine that lends HQ its cores for long headless runs (hq run). It asks HQ for work over HTTPS and
// opens no port. Each run goes into a throwaway workspace, as another user with no network, and only its output and
// the files it names go back. A machine runs one helper per kind of run, each in a container of that kind's image,
// taking only that kind's runs. Each says, as it asks or beats, its machine's speed and load, and the run's newest output.
// README.md says how they're started and what they can reach.
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HQ_URL = process.env.HQ_URL ?? '';
const KEY_FILE = process.env.KEY_FILE ?? '/state/key';
// The kind of run this helper takes (its start command sets it, or for this server's, infra/run_helpers.py).
const RUN_KIND = process.env.RUN_KIND || undefined;
// Which of its machine's helpers of the kind this is, and whether it sits on the manager's closed network (manager.mjs
// sets both): only then may a kind's runs keep their sockets, as they reach no further than this helper does
const SLOT = Number(process.env.HELPER_SLOT) || undefined;
const LOCKED = process.env.HELPER_LOCKED === '1';
// A run with sockets reaches the package registries through the manager's proxy, and keeps their downloads here. The
// helper keeps its runs' base here too (keptBase), made as it starts, before any run could put something in its place.
const CACHE_DIR = process.env.CACHE_DIR ?? '/cache';
const KEPT = `${CACHE_DIR}/base.git`;
const KEEPS_BASE = existsSync(CACHE_DIR) && onPath('git');
const WORK_DIR = process.env.WORK_DIR ?? '/work';
// A run's bundle beside its workspace, the helper's own, from its download until it's unpacked
const BUNDLE_SUFFIX = '.bundle.tar.gz';
const NONET_FILE = process.env.NONET_FILE ?? '/tmp/nonet.pl';
// The user every run's processes belong to: never the helper's own in the container, so a run can't signal, trace or
// read the helper (its key included). A test outside a container gives its own uid.
const TASK_UID = Number(process.env.TASK_UID ?? 1000);
const TASK_GID = Number(process.env.TASK_GID ?? 1000);
// (a test outside a container, its runs as itself)
const SHARED_USER = process.getuid() === TASK_UID;
const POLL_MS = Number(process.env.POLL_MS ?? 10_000);
const BEAT_MS = Number(process.env.BEAT_MS ?? 10_000);
const OUTPUT_MAX_BYTES = 1024 * 1024;
// The newest output of a run a beat sends at most, for HQ's live view
const LINES_MAX_BYTES = 4 * 1024;
// A fixed piece of integer work, the same on every machine: about a quarter of a second on a recent core
const BENCH_STEPS = 50_000_000;
const GPU_READ_MS = 2_000;
const FILES_MAX_BYTES = 200 * 1024 * 1024;
const CALL_MS = 60_000;
// A bundle's download and a run's uploads (a push's tests carry the whole repo: a few hundred MB)
const TRANSFER_MS = 15 * 60_000;
// How long a run's bundle and result transfers recover while HQ can't be reached: as long as a deploy waits for HQ to
// answer (infra/hq-up.sh's HQ_UP_S).
const HQ_RETRY_MS = Number(process.env.HQ_RETRY_MS ?? 10 * 60_000);
// A run's exit code when its time ran out, as timeout(1) gives
const TIMED_OUT = 124;
const KILL_STEP_MS = 100;
const KILL_WAIT_MS = 5_000;

class HqUnavailableError extends Error {}
// Why a run's base couldn't be had (keptBase): the run ends saying so, its command never run
class BaseLackingError extends Error {}

// Runs a command as the runs' user with no network: a seccomp filter refuses every socket but a Unix one, connecting
// and io_uring before the command starts. The filter goes on while the process is still the helper's user, and only
// then does it become the runs' user. Otherwise a run's process could trace a new process between the user change and
// the filter. Perl because every Debian image has it. x86-64 only: any other architecture's calls end the process.
// "net", for a run that keeps its sockets (LOCKED), keeps the rest of the filter (the architecture, x32 and io_uring) and
// leaves out its socket and connect rules.
const NONET = `
my ($mode, $uid, $gid) = splice @ARGV, 0, 3;
my @nonet = (
  [0x20, 0, 0, 4], [0x15, 1, 0, 0xC000003E], [0x06, 0, 0, 0x80000000],
  [0x20, 0, 0, 0], [0x35, 0, 1, 0x40000000], [0x06, 0, 0, 0x80000000],
  [0x15, 4, 0, 41], [0x15, 6, 0, 42], [0x15, 0, 1, 425], [0x06, 0, 0, 0x00050026], [0x06, 0, 0, 0x7fff0000],
  [0x20, 0, 0, 16], [0x15, 0, 1, 1], [0x06, 0, 0, 0x7fff0000], [0x06, 0, 0, 0x0005000d],
);
my @filter = $mode eq 'net' ? (@nonet[0 .. 5], @nonet[8 .. 10]) : @nonet;
my $code = join '', map { pack 'SCCL', @$_ } @filter;
my $program = pack 'S x6 Q', scalar @filter, unpack('Q', pack('p', $code));
syscall(157, 38, 1, 0, 0, 0) == 0 or die "nonet: no_new_privs: $!\\n";
syscall(317, 1, 0, $program) == 0 or die "nonet: seccomp: $!\\n";
unless ($< == $uid) {
  syscall(116, 0, 0) == 0 or die "nonet: setgroups: $!\\n";
  syscall(106, $gid + 0) == 0 or die "nonet: setgid $gid: $!\\n";
  syscall(105, $uid + 0) == 0 or die "nonet: setuid $uid: $!\\n";
}
exec { $ARGV[0] } @ARGV or die "nonet: $ARGV[0]: $!\\n";
`;

// Removes every System V IPC object (shared memory, message queue, semaphore set) the runs' user created, as that user:
// they outlive its processes. The id goes in as a number, since syscall passes a string as a pointer.
const CLEAR_SYSV = `
for my $kind (['shm', 31], ['msg', 71], ['sem', 66]) {
  my ($name, $control) = @$kind;
  open my $list, '<', "/proc/sysvipc/$name" or next;
  my @columns = split ' ', <$list>;
  my ($creator) = grep { $columns[$_] eq 'cuid' } 0 .. $#columns;
  for (<$list>) {
    my @row = split;
    next unless $row[$creator] == $<;
    syscall($control, $row[1] + 0, 0, 0, 0) == 0 or die "$name $row[1]: $!\\n";
  }
}
`;

// The in-memory folders besides the work folder that a run can leave files in: POSIX shared memory and message queues.
// They're the container's own. A test that runs as itself leaves them alone, since they're its machine's.
const IPC_FOLDERS = SHARED_USER ? [] : ['/dev/shm', '/dev/mqueue'].filter(folder => existsSync(folder));

// The kill(-1) processes from their start to their end. One is root until it changes user, so no scan of the runs'
// user sees it, and it must end before cleanup does: a late one would end the processes of the next step or run.
const killers = new Set();
// The cleanup under way, which every call in the meantime waits for
let ending = null;

if (process.arch !== 'x64') throw new Error('The helper runs on x86-64 machines only');
const missing = ['perl', 'tar', 'find', 'sh'].filter(tool => !onPath(tool));
if (Number(process.versions.node.split('.')[0]) < 22) missing.unshift('node 22 or later');
if (missing.length)
  throw new Error(
    `This image has no ${missing.join(', ')}: a kind's image needs node 22 or later, perl, tar, find and sh, so it can't run the helper`,
  );
if (!/^https?:\/\//.test(HQ_URL)) throw new Error("HQ_URL must be HQ's address");
if (TASK_UID === 0) throw new Error('TASK_UID must not be root');

const GPU_TOOL = onPath('nvidia-smi');
let cpuBefore = cpuTimes();
let key = await ownKey();
const machine = { ...machineSize(), bench: benchmark() };
writeFileSync(NONET_FILE, NONET, { mode: 0o644 });
console.log(
  `Helper started: ${machine.cpus} cores, ${machine.memoryGb} GB, speed ${machine.bench} a core, asking ${HQ_URL}`,
);
await clearAway();
if (KEEPS_BASE) await git('init', '-q', '--bare', KEPT);
let refusedWith = '';
for (;;) {
  const run = await takeRun().catch(error => console.error('HQ: no answer:', error.message));
  if (!run) {
    await sleep(POLL_MS);
    continue;
  }
  await carryOut(run).catch(error => console.error(`Run ${run.id}: stopped:`, error.message));
  // (a run's leftovers that can't be cleared stop the helper here, and its restart clears them before it takes another)
  await clearAway();
}

// The key HQ knows this machine by. HQ made it when the board added the machine, and its key command saved it in the
// folder every kind's container shares (HQ's Settings › Machines). It never goes in a log. Until it's there, the helper
// waits for it.
async function ownKey() {
  if (!existsSync(KEY_FILE)) console.log("No key yet: paste the machine's key command from HQ's Settings › Machines");
  while (!existsSync(KEY_FILE)) await sleep(POLL_MS);
  return readFileSync(KEY_FILE, 'utf8').trim();
}

// The cores and memory runs get: the container's limits where it has them
function machineSize() {
  const [quota, period] = readOr('/sys/fs/cgroup/cpu.max', 'max').split(' ');
  const cpus = quota === 'max' ? availableParallelism() : Math.floor(Number(quota) / Number(period));
  const limit = Number(readOr('/sys/fs/cgroup/memory.max', 'max'));
  const memoryGb = Math.floor((Number.isFinite(limit) ? limit : totalmem()) / 2 ** 30);
  return { cpus, memoryGb };
}

// The machine's speed on one core: the best of three timings of the fixed work, in millions of steps a second. HQ
// multiplies it by the cores runs get.
function benchmark() {
  let fastestMs = Infinity;
  let value = 1;
  for (let round = 0; round < 3; round++) {
    const started = performance.now();
    for (let step = 0; step < BENCH_STEPS; step++) value = (Math.imul(value, 1103515245) + 12345) | 0;
    fastestMs = Math.min(fastestMs, performance.now() - started);
  }
  // (the work's result is used, so it can't be optimised away)
  return value === 0 ? 0 : Math.round(BENCH_STEPS / fastestMs / 1000);
}

// The oldest waiting run of its kind, once HQ lets it in. A refusal is said once, until HQ answers otherwise. A key HQ
// doesn't know is read again, so a new key command takes without a restart.
async function takeRun() {
  const answer = await callHq('POST', '/api/helper/take', {
    // (keepsBase)
    json: {
      ...machine,
      kind: RUN_KIND,
      slot: SLOT,
      locked: LOCKED || undefined,
      keepsBase: KEEPS_BASE || undefined,
      ...(await readings()),
    },
  });
  if (answer.status === 401) key = readOr(KEY_FILE, key);
  const refusal =
    answer.status === 401
      ? "HQ doesn't know this machine's key: add the machine in HQ's Settings › Machines and paste its key command"
      : answer.status === 400
        ? `HQ refused this helper: ${errorIn(answer.body)}`
        : '';
  if (refusal && refusal !== refusedWith) console.log(refusal);
  refusedWith = refusal;
  if (refusal || answer.status === 204) return null;
  if (answer.status !== 200) throw new Error(`HTTP ${answer.status}`);
  return JSON.parse(answer.body.toString());
}

// One run, start to end: its workspace, its command under its time limit, every process it started ended, its output and
// files to HQ. HQ's "stop" on a beat ends it early. No beat of it is still under way when it returns, so a late "stop"
// never reaches the next run.
async function carryOut(run) {
  const workspace = `${WORK_DIR}/run-${run.id}`;
  const bundle = `${workspace}${BUNDLE_SUFFIX}`;
  console.log(`Run ${run.id}: started, ${run.minutes} min at most`);
  const command = { child: null, stopped: false, fresh: collector(LINES_MAX_BYTES, true) };
  const lifetime = new AbortController();
  const beats = [];
  const beat = setInterval(() => beats.push(beatFor(run, command, lifetime.signal)), BEAT_MS);
  try {
    await transfer('GET', `/api/helper/runs/${run.id}/bundle`, { answerFile: bundle });
    if (command.stopped) return;
    const unpacked = await asTask(
      ['sh', '-c', 'mkdir "$1" && mkdir "$1/tree" "$1/home" && tar -xzf "$2" -C "$1/tree"', 'sh', workspace, bundle],
      {},
    );
    rmSync(bundle, { force: true });
    if (unpacked.code !== 0) throw new Error(`the bundle didn't unpack: ${unpacked.errors.toString().slice(-500)}`);
    if (command.stopped) return;
    const lacking = run.base
      ? await keptBase(run, workspace).then(
          () => '',
          error => {
            if (error instanceof BaseLackingError) return error.message;
            throw error;
          },
        )
      : '';
    if (lacking) return await report(run, Buffer.from(`The run's base isn't on the helper: ${lacking}\n`), 2);
    if (command.stopped) return;
    const ended = await runCommand(run, workspace, command);
    if (command.stopped) return;
    const files = run.bring.length ? await packFiles(run, workspace) : { output: Buffer.alloc(0), problem: '' };
    const output = Buffer.concat([ended.output, Buffer.from(files.problem)]);
    await report(run, output, ended.exitCode, files.output, ended.timedOut);
  } finally {
    clearInterval(beat);
    lifetime.abort();
    await Promise.all(beats);
  }
}

// A run's output, files and exit code to HQ, which ends it
async function report(run, output, exitCode, files = Buffer.alloc(0), timedOut = false) {
  await transfer('POST', `/api/helper/runs/${run.id}/output`, { body: output });
  await transfer('POST', `/api/helper/runs/${run.id}/finish`, {
    body: files,
    headers: { 'x-run-exit': String(exitCode), 'x-run-timed-out': timedOut ? '1' : '0' },
  });
  console.log(`Run ${run.id}: ended with ${exitCode}`);
}

// A run whose bundle stands on a base (a commit of HQ's checkout, the bundle carrying only what came after it:
// shared/gates/lent.ts) finds it in the repo the helper keeps in its cache, fetched from HQ when it lacks it (only
// what's new since the commits it has). It's the helper's own, so a run reads it (tree/base.git, the objects its own
// repo borrows) but can't change it for the next. Why it couldn't be had is a BaseLackingError; the transfer from HQ
// fails as the bundle's does.
async function keptBase(run, workspace) {
  const has = () =>
    git('-C', KEPT, 'cat-file', '-e', `${run.base}^{commit}`).then(
      () => true,
      () => false,
    );
  if (!(await has())) {
    const have = (await git('-C', KEPT, 'for-each-ref', '--format=%(objectname)', 'refs/kept')).split('\n');
    const bundle = await transfer('GET', `/api/helper/runs/${run.id}/base?have=${have.filter(Boolean).join(',')}`);
    // (in the kept repo: the helper's root has no right to write in the run's workspace, the runs' user's)
    const file = `${KEPT}/base.bundle`;
    writeFileSync(file, bundle.body);
    try {
      // (the refs it has: one whose commit the helper named in have is left out, HEAD too)
      const heads = (await git('-C', KEPT, 'bundle', 'list-heads', file)).trim().split('\n');
      const refspecs = heads
        .map(line => line.split(' ')[1])
        .map(ref => `+${ref}:refs/kept/${ref.replace(/^refs\//, '')}`);
      await git('-C', KEPT, 'fetch', '-q', file, ...refspecs);
    } catch (error) {
      throw new BaseLackingError(`HQ's bundle didn't fetch: ${error.message}`);
    } finally {
      rmSync(file, { force: true });
    }
    if (!(await has())) throw new BaseLackingError(`HQ's bundle lacks ${run.base}`);
  }
  const linked = await asTask(['ln', '-s', KEPT, 'base.git'], { cwd: `${workspace}/tree` });
  if (linked.code !== 0) throw new BaseLackingError(`base.git wasn't linked: ${linked.errors.toString().slice(-300)}`);
}

// (a declaration: the helper's loop runs before the module's later consts are set)
function git(...args) {
  return new Promise((resolve, reject) =>
    execFile('git', args, { encoding: 'utf8' }, (error, out, err) =>
      error ? reject(new Error(err.trim().slice(-300) || error.message)) : resolve(out),
    ),
  );
}

// The beat: the machine's load and the run's output since the last beat, up to its last whole line
async function beatFor(run, command, lifetime) {
  try {
    const read = await readings();
    const fresh = command.fresh.bytes().toString();
    const cut = Math.max(fresh.lastIndexOf('\n'), fresh.lastIndexOf('\r')) + 1;
    command.fresh = collector(LINES_MAX_BYTES, true);
    command.fresh.add(Buffer.from(fresh.slice(cut)));
    const json = { ...read, lines: fresh.slice(0, cut) };
    const answer = await callHq('POST', `/api/helper/runs/${run.id}/beat`, { json, signal: lifetime });
    if (lifetime.aborted) return;
    if (answer.status === 200 && JSON.parse(answer.body.toString()).go === false) {
      if (!command.stopped) console.log(`Run ${run.id}: HQ stopped it`);
      command.stopped = true;
      await endTaskProcesses(command.child);
    }
  } catch (error) {
    if (!lifetime.aborted) console.error(`Run ${run.id}: beat not heard:`, error.message);
  }
}

// The command in the tree's own folder, its stderr in with its stdout, the last MB of it kept. Every process the run
// started has ended when it returns, detached ones too, so nothing changes the workspace after.
async function runCommand(run, workspace, command) {
  const ending = [];
  const started = asTask(['sh', '-c', `exec 2>&1\n${run.command}`], {
    cwd: `${workspace}/tree/${run.cwd}`,
    home: `${workspace}/home`,
    sockets: run.sockets === true && LOCKED,
    keepTail: true,
    onOutput: chunk => command.fresh.add(chunk),
    // (a process it left behind would hold the output open)
    onStart: child => {
      command.child = child;
      child.once('exit', () => ending.push(endTaskProcesses(child)));
    },
  });
  let timedOut = false;
  const limit = setTimeout(() => {
    timedOut = true;
    ending.push(endTaskProcesses(command.child));
  }, run.minutes * 60_000);
  const ended = await started;
  clearTimeout(limit);
  await Promise.all(ending);
  await endTaskProcesses(command.child);
  return { exitCode: timedOut ? TIMED_OUT : ended.code, timedOut, output: ended.output };
}

// The files the run named, from the tree's root, as a gzipped tar, packed as the runs' user with no network. One that
// isn't there is left out and said so, and so is one the run put behind a link (its workspace, its tree or a folder on
// the way), which would reach outside the tree, or behind a folder it locked.
async function packFiles(run, workspace) {
  const reachable = run.bring.filter(path => !throughLink(workspace, path));
  const linked = run.bring.filter(path => !reachable.includes(path));
  const refused = linked.map(path => `helper: ${path}: behind a link or a locked folder, left out\n`).join('');
  if (!reachable.length) return { output: Buffer.alloc(0), problem: `\n${refused}` };
  const packed = await asTask(
    ['sh', '-c', 'cd "$1/tree" && shift && tar -czf - --ignore-failed-read -- "$@"', 'sh', workspace, ...reachable],
    {},
  );
  if (packed.tooLong)
    return { output: Buffer.alloc(0), problem: `\nhelper: the files are over ${FILES_MAX_BYTES} bytes, none sent\n` };
  const warnings = packed.errors.toString() + refused;
  return { output: packed.output, problem: warnings ? `\n${warnings}` : '' };
}

// Whether a folder on the way to path (from the workspace itself down) is a link, isn't a folder or can't be read. Read
// after every process of the run ended, so nothing changes it before the tar reads.
function throughLink(workspace, path) {
  let folder = workspace;
  return ['', 'tree', ...path.split('/').slice(0, -1)].some(part => {
    folder = part ? `${folder}/${part}` : folder;
    try {
      const found = lstatSync(folder, { throwIfNoEntry: false });
      return found !== undefined && !found.isDirectory();
    } catch {
      return true;
    }
  });
}

// End the runs' processes, then remove all their user left: its files in the work folder, shared memory and message
// queues (folders it locked opened first), and its System V IPC objects. Something left throws.
async function clearAway() {
  await endTaskProcesses(null);
  const folders = [WORK_DIR, ...IPC_FOLDERS];
  const cleared = await asTask(
    [
      'sh',
      '-c',
      'uid=$1 && shift && find "$@" -mindepth 1 ! -user "$uid" -prune -o -type d -exec chmod u+rwx {} \\; && ' +
        'find "$@" -mindepth 1 -maxdepth 1 -user "$uid" -exec rm -rf {} +',
      'sh',
      String(TASK_UID),
      ...folders,
    ],
    {},
  );
  if (cleared.code !== 0)
    throw new Error(`The runs' files could not be removed: ${cleared.errors.toString().slice(-500)}`);
  // (a bundle the helper was downloading or unpacking as it stopped)
  for (const name of readdirSync(WORK_DIR))
    if (name.endsWith(BUNDLE_SUFFIX)) rmSync(`${WORK_DIR}/${name}`, { force: true });
  if (SHARED_USER) return;
  const objects = await asTask(['perl', '-e', CLEAR_SYSV], {});
  if (objects.code !== 0)
    throw new Error(`The runs' IPC objects could not be removed: ${objects.errors.toString().slice(-500)}`);
}

// As the runs' own user, kill(-1) ends every process it has, until none is left. A run can outlive it by stopping or
// ending the process that sends it, so one still there after a few seconds stops the helper, and Docker's restart ends
// every process in the container. Calls while it's under way wait for the same one. A test that runs as itself ends the
// command's process group instead, since kill(-1) would end the test.
async function endTaskProcesses(child) {
  if (SHARED_USER) {
    try {
      if (child?.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    return;
  }
  ending ??= killUntilNoneLeft().finally(() => {
    ending = null;
  });
  await ending;
}

// A kill(-1) at once, another while a run's thread is left, until none is and every one sent has ended. A run can stop
// one once it's the runs' user, so it's never awaited past the deadline, and a later one ends it.
async function killUntilNoneLeft() {
  let left = true;
  for (let waitedMs = 0; waitedMs < KILL_WAIT_MS; waitedMs += KILL_STEP_MS) {
    if (left) {
      const killer = asTask(['perl', '-e', 'kill 9, -1'], {})
        .catch(() => {
          /* not started: the next scan decides whether another is needed */
        })
        .finally(() => killers.delete(killer));
      killers.add(killer);
    }
    await sleep(KILL_STEP_MS);
    left = taskProcessesLeft();
    if (!left && !killers.size) return;
  }
  console.error('Cleanup still has task processes or kill(-1) senders: the helper stops, and its restart ends them');
  process.exit(1);
}

// Whether any thread of the runs' user is alive, excluding threads waiting to be reaped
function taskProcessesLeft() {
  const theirs = new RegExp(`^Uid:\\s+${TASK_UID}\\s`, 'm');
  const alive = status => theirs.test(status) && !/^State:\s+[ZX]/m.test(status);
  return readdirSync('/proc').some(pid => {
    if (!/^\d+$/.test(pid)) return false;
    const status = readOr(`/proc/${pid}/status`, '');
    if (!theirs.test(status)) return false;
    if (alive(status)) return true;
    // An exited leader shows Z even while other threads in its process keep running.
    let threads;
    try {
      threads = readdirSync(`/proc/${pid}/task`);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    return threads.some(tid => alive(readOr(`/proc/${pid}/task/${tid}/status`, '')));
  });
}

// A command as the runs' user, with no network (but sockets: see NONET), in its own process group. Its output comes
// back whole, or as a tail.
function asTask(argv, { cwd = WORK_DIR, home = WORK_DIR, keepTail = false, sockets = false, onStart, onOutput }) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, LANG: 'C.UTF-8' };
    if (sockets)
      Object.assign(env, {
        HTTPS_PROXY: process.env.HTTPS_PROXY,
        HTTP_PROXY: process.env.HTTP_PROXY,
        NO_PROXY: 'localhost,127.0.0.1,::1',
        ...(existsSync(CACHE_DIR) ? { npm_config_cache: `${CACHE_DIR}/npm` } : {}),
      });
    const child = spawn('perl', [NONET_FILE, sockets ? 'net' : 'nonet', String(TASK_UID), String(TASK_GID), ...argv], {
      cwd,
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onStart?.(child);
    const output = collector(keepTail ? OUTPUT_MAX_BYTES : FILES_MAX_BYTES, keepTail);
    const errors = collector(OUTPUT_MAX_BYTES, true);
    child.stdout.on('data', output.add);
    if (onOutput) child.stdout.on('data', onOutput);
    child.stderr.on('data', errors.add);
    child.on('error', reject);
    child.on('close', code =>
      resolve({ code: code ?? 128, output: output.bytes(), errors: errors.bytes(), tooLong: output.over }),
    );
  });
}

// Bytes up to max: past it, the newest max bytes (a tail) or none, marked as over
function collector(max, tail) {
  let chunks = [];
  let size = 0;
  const kept = {
    over: false,
    add: chunk => {
      if (kept.over && !tail) return;
      size += chunk.length;
      chunks.push(chunk);
      if (size <= max) return;
      kept.over = true;
      if (!tail) {
        chunks = [];
        size = 0;
        return;
      }
      const joined = Buffer.concat(chunks);
      chunks = [joined.subarray(joined.length - max)];
      size = max;
    },
    bytes: () => Buffer.concat(chunks),
  };
  return kept;
}

// The machine's load, { live: { cpu, mem, freeMb, cores, gpu }, gpu }: CPU in use since the last reading (/proc/stat),
// memory in use and free (/proc/meminfo), its cores and, where the kind's container has a GPU, its use and name
// (nvidia-smi, cut off if slow). A container reads the machine's own (on Windows, Docker's VM's).
async function readings() {
  const cpuNow = cpuTimes();
  const total = cpuNow.total - cpuBefore.total;
  const cpu = total > 0 ? (100 * (cpuNow.busy - cpuBefore.busy)) / total : undefined;
  cpuBefore = cpuNow;
  const info = readOr('/proc/meminfo', '');
  const kb = name => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(info)?.[1]);
  const mem = kb('MemTotal') > 0 ? 100 * (1 - kb('MemAvailable') / kb('MemTotal')) : undefined;
  const sizes = { freeMb: Math.round(kb('MemAvailable') / 1024) || undefined, cores: availableParallelism() };
  const gpus = GPU_TOOL ? await gpuUse() : [];
  if (!gpus.length) return { live: { cpu, mem, ...sizes } };
  const name = gpus.length > 1 ? `${gpus.length}× ${gpus[0].name}` : gpus[0].name;
  const gpu = gpus.reduce((sum, one) => sum + one.use, 0) / gpus.length;
  return { live: { cpu, mem, ...sizes, gpu }, gpu: name.slice(0, 80) };
}

function cpuTimes() {
  // user, nice, system, idle, iowait, irq, softirq, steal
  const times = readOr('/proc/stat', 'cpu').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
  const total = times.reduce((sum, time) => sum + time, 0);
  return { busy: total - (times[3] ?? 0) - (times[4] ?? 0), total };
}

function gpuUse() {
  const query = ['--query-gpu=name,utilization.gpu', '--format=csv,noheader,nounits'];
  return new Promise(resolve =>
    execFile('nvidia-smi', query, { timeout: GPU_READ_MS }, (error, out) => {
      const rows = (error ? '' : out).split('\n').map(line => line.split(',').map(part => part.trim()));
      const read = rows.filter(([name, use]) => name && /^\d+$/.test(use));
      resolve(read.map(([name, use]) => ({ name, use: Number(use) })));
    }),
  );
}

// A run's immutable bundle and idempotent uploads stay with the active attempt through a broken connection. Fetch's
// TypeError includes a response body cut off mid-transfer. Caddy returns 503 while the coordinator is unavailable.
// Beats continue through HQ_RETRY_MS (ten minutes by default). A take request or the run's command is never repeated.
async function transfer(method, path, { body, headers = {}, answerFile } = {}) {
  const since = Date.now();
  const endpoint = path.split('/').pop();
  for (let wait = 1000; ; wait = Math.min(wait * 2, 30_000)) {
    try {
      const answer = await callHq(method, path, { body, headers, timeoutMs: TRANSFER_MS, answerFile });
      if (answer.status === 503) throw new HqUnavailableError(`${endpoint}: HTTP 503`);
      if (answer.status !== 200) throw new Error(`${endpoint}: HTTP ${answer.status}`);
      return answer;
    } catch (error) {
      const unavailable = error instanceof TypeError || error instanceof HqUnavailableError;
      if (!unavailable || Date.now() - since >= HQ_RETRY_MS) throw error;
      console.error(`${endpoint}: HQ not reached (${error.message}), tried again in ${wait / 1000} s`);
    }
    await sleep(wait);
  }
}

// With an answerFile, the answer is written there as it comes, never held whole: a push's bundle is a few hundred MB,
// which the helper's memory would keep through the run, beside the run's own.
async function callHq(method, path, { json, body, headers = {}, timeoutMs = CALL_MS, signal, answerFile } = {}) {
  const response = await fetch(`${HQ_URL}${path}`, {
    method,
    redirect: 'error',
    headers: { authorization: `Bearer ${key}`, ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
  });
  if (answerFile && response.status === 200) {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(answerFile, { mode: 0o644 }));
    return { status: response.status };
  }
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
}

function errorIn(body) {
  try {
    return String(JSON.parse(body.toString()).error).slice(0, 500);
  } catch {
    return 'no reason given';
  }
}

function onPath(tool) {
  return (process.env.PATH ?? '').split(':').some(folder => folder && existsSync(`${folder}/${tool}`));
}

function readOr(file, fallback) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
