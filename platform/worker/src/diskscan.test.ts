// node --test platform/worker/src/diskscan.test.ts (real probe processes over representative checkout and push-test trees).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiskScan } from './diskscan.ts';

// VmRSS counts the interpreter and its mapped libraries too: the whole process is what admission counts.
test('a checkout-shaped tree stays below 30 MB total scanner RSS with equal allocated bytes', async context => {
  const root = mkdtempSync(join(tmpdir(), 'disk-probe-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (let d = 0; d < 1600; d++) {
    const folder = join(root, `folder-${d % 40}`, `module-${d}`);
    mkdirSync(folder, { recursive: true });
    for (let f = 0; f < 14; f++) writeFileSync(join(folder, `file-${f}.ts`), 'x');
  }
  const scan = new DiskScan([root], { uid: process.getuid!(), gid: process.getgid!() });
  context.after(() => scan.close());
  const bytes = allocated([root]);
  for (let i = 0; i < 3; i++) assert.equal(await scan.measure(), bytes);
  assertMemory(scan, context);
});

// A job's folders while its push's tests run: its own clone (~23,000 entries), the tests' clone with its installs
// (~23,500) and the base's checkout they compare with (~12,700), ~60,000 entries in ~4,700 folders, under a 40-character
// commit folder. They fit a probe with half the accounting budget, so the live one's bound has room to spare.
test('a push-test tree stays below 30 MB total scanner RSS without reducing its supported size', async context => {
  const work = mkdtempSync(join(tmpdir(), 'disk-tests-tree-'));
  context.after(() => rmSync(work, { recursive: true, force: true }));
  const commit = 'c'.repeat(40);
  const parts = [
    ['jobs/1', 1600, 14],
    [`tests/1/${commit}/repo`, 1700, 13],
    [`tests/1/${commit}/tmp/tests-checkout-x`, 1400, 9],
  ] as const;
  for (const [part, folders, files] of parts)
    for (let d = 0; d < folders; d++) {
      const folder = join(work, part, `folder-${d % 40}`, `module-${d}`);
      mkdirSync(folder, { recursive: true });
      for (let f = 0; f < files; f++) writeFileSync(join(folder, `file-${f}.ts`), 'x');
    }
  const roots = ['jobs', 'homes', 'tests'].map(folder => join(work, folder, '1'));
  roots.forEach(root => mkdirSync(root, { recursive: true }));
  const scan = new DiskScan(roots, { uid: process.getuid!(), gid: process.getgid!() }, 1024);
  context.after(() => scan.close());
  const bytes = allocated(roots);
  for (let i = 0; i < 3; i++) assert.equal(await scan.measure(), bytes);
  assertMemory(scan, context);
});

test('local accounting counts upload staging when the tests root is absent or created later', async context => {
  const work = mkdtempSync(join(tmpdir(), 'disk-absent-tests-'));
  context.after(() => rmSync(work, { recursive: true, force: true }));
  const roots = ['jobs', 'homes', 'tests'].map(name => join(work, name));
  for (const root of roots.slice(0, 2)) mkdirSync(root);
  const staging = join(roots[1], 'tmp', 'lent-bundle-upload');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'bundle.tar.gz'), Buffer.alloc(8192));
  const scan = new DiskScan(roots, { uid: process.getuid!(), gid: process.getgid!() });
  context.after(() => scan.close());
  assert.equal(await scan.measure(), allocated(roots.slice(0, 2)));
  mkdirSync(roots[2]);
  writeFileSync(join(roots[2], 'check'), Buffer.alloc(16384));
  assert.equal(await scan.measure(), allocated(roots));
});

const allocated = (roots: string[]) =>
  execFileSync('du', ['-s', '-B1', ...roots], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .reduce((bytes, line) => bytes + Number(line.split('\t')[0]), 0);

function assertMemory(scan: DiskScan, context: any) {
  const status = readFileSync(`/proc/${scan.pid}/status`, 'utf8');
  const rssBytes = Number(status.match(/^VmRSS:\s+(\d+) kB/m)![1]) * 1024;
  const anonymousBytes = Number(status.match(/^RssAnon:\s+(\d+) kB/m)![1]) * 1024;
  context.diagnostic(
    `Scanner RSS ${(rssBytes / 2 ** 20).toFixed(2)} MiB, anonymous ${(anonymousBytes / 2 ** 20).toFixed(2)} MiB`,
  );
  assert.ok(rssBytes < 30_000_000, `scanner RSS is ${rssBytes} bytes, target is below 30 MB (30,000,000 bytes)`);
}

test(
  'a slot cannot trace the scanner running with its filesystem permissions',
  { skip: process.getuid!() !== 0 && 'needs the production root worker identity' },
  async context => {
    const root = mkdtempSync('/tmp/disk-trace-');
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const ids = { uid: 65534, gid: 65534 };
    chownSync(root, ids.uid, ids.gid);
    chmodSync(root, 0o700);
    writeFileSync(join(root, 'counted'), 'inside');
    const scan = new DiskScan([root], ids);
    context.after(() => scan.close());
    const bytes = await scan.measure();
    const code = `
import ctypes, errno, sys
library = ctypes.CDLL(None, use_errno=True)
PTRACE_ATTACH = 16
assert library.ptrace(PTRACE_ATTACH, int(sys.argv[1]), None, None) == -1
assert ctypes.get_errno() == errno.EPERM
`;
    execFileSync('python3', ['-I', '-c', code, String(scan.pid)], { ...ids, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(await scan.measure(), bytes, 'trace denial leaves accounting available');
  },
);

test('a private index write failure remains an infrastructure accounting failure', context => {
  const root = mkdtempSync(join(tmpdir(), 'disk-index-failure-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (let file = 0; file < 6000; file++) writeFileSync(join(root, String(file)), 'x');
  const probe = fileURLToPath(new URL('./diskprobe.py', import.meta.url));
  const code = `
import resource, runpy, signal, sys
resource.setrlimit(resource.RLIMIT_FSIZE, (512, 512))
signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
`;
  const identities = JSON.stringify({ uid: process.getuid!(), gid: process.getgid!() });
  const output = execFileSync('python3', ['-I', '-B', '-u', '-c', code, probe, identities, '2048', root], {
    input: 'measure\n',
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  });
  const reading = JSON.parse(output);
  assert.equal(reading.bytes, undefined, 'failed index never returns a partial total');
  assert.equal(reading.error.reason, 'worker-scanner', 'private index I/O must not strike a slot tree');
});

test('directory turnover near the supported bound keeps its live allocation', async context => {
  const root = mkdtempSync(join(tmpdir(), 'disk-turnover-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scan = new DiskScan([root], { uid: process.getuid!(), gid: process.getgid!() }, 1);
  context.after(() => scan.close());
  for (let file = 0; file < 80; file++) writeFileSync(join(root, `old-${file}`), 'x');
  assert.equal(await scan.measure(), allocated([root]));
  for (let file = 0; file < 80; file++) unlinkSync(join(root, `old-${file}`));
  for (let file = 0; file < 80; file++) writeFileSync(join(root, `new-${file}`), 'x');
  for (let look = 0; look < 3; look++) assert.equal(await scan.measure(), allocated([root]));
});

for (const separateRoots of [false, true]) {
  test(`cross-directory moves ${separateRoots ? 'between roots' : 'within a root'} release stale charges first`, async context => {
    const root = mkdtempSync(join(tmpdir(), 'disk-move-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(destination, 'marker'), 'x');
    for (let file = 0; file < 80; file++) writeFileSync(join(source, `file-${file}`), 'x');
    const roots = separateRoots ? [destination, source] : [root];
    const scan = new DiskScan(roots, { uid: process.getuid!(), gid: process.getgid!() }, 1);
    context.after(() => scan.close());
    assert.equal(await scan.measure(), allocated(roots));
    // The first event queues destination before source, even though the live tree never grows.
    appendFileSync(join(destination, 'marker'), 'x');
    for (let file = 0; file < 80; file++) renameSync(join(source, `file-${file}`), join(destination, `file-${file}`));
    for (let look = 0; look < 3; look++) assert.equal(await scan.measure(), allocated(roots));
  });
}

test('scanner startup failures include their Python cause', async context => {
  const scan = new DiskScan([], { uid: -2, gid: process.getgid!() });
  context.after(() => scan.close());
  await assert.rejects(scan.measure(), /OverflowError/);
});

test(
  'index backing belongs to the worker before a slot can fill or reset it',
  { skip: process.getuid!() !== 0 && 'needs the production root worker identity' },
  context => {
    const root = mkdtempSync('/tmp/disk-index-owner-');
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const ids = { uid: 65534, gid: 65534 };
    chownSync(root, ids.uid, ids.gid);
    chmodSync(root, 0o700);
    for (let file = 0; file < 80; file++) writeFileSync(join(root, String(file)), 'x');
    const probe = fileURLToPath(new URL('./diskprobe.py', import.meta.url));
    const code = `
import json, os, subprocess, sys
probe, root = sys.argv[1:]
child = subprocess.Popen([sys.executable, '-I', '-B', '-u', probe,
    json.dumps({'uid': 65534, 'gid': 65534}), '1', root],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def request():
    child.stdin.write('measure\\n')
    child.stdin.flush()
    return json.loads(child.stdout.readline())
def backing():
    files = []
    for fd in os.listdir(f'/proc/{child.pid}/fd'):
        path = f'/proc/{child.pid}/fd/{fd}'
        if os.readlink(path).endswith(' (deleted)'):
            files.append(os.stat(path))
    assert files, 'backing exists before any cache spill'
    assert all(f.st_uid == 0 and f.st_nlink == 0 for f in files), 'slots never own the index'
try:
    assert 'bytes' in request()
    backing()
    for file in range(80, 1000):
        open(os.path.join(root, str(file)), 'w').close()
    assert request()['error']['reason'] == 'job-tree'
    for file in range(80, 1000):
        os.unlink(os.path.join(root, str(file)))
    assert 'bytes' in request()
    backing()
finally:
    child.stdin.close()
    assert child.wait() == 0
`;
    execFileSync('python3', ['-I', '-c', code, probe, root], { env: { PATH: '/usr/bin:/bin' } });
  },
);

test('lost inotify notifications rescan every directory and preserve allocated totals across roots', async context => {
  const work = mkdtempSync(join(tmpdir(), 'disk-overflow-'));
  context.after(() => rmSync(work, { recursive: true, force: true }));
  const roots = ['jobs', 'homes', 'tests'].map(name => join(work, name));
  for (const root of roots) mkdirSync(join(root, 'nested'), { recursive: true });
  const burst = join(roots[0], 'nested', 'burst');
  writeFileSync(burst, '');
  const scan = new DiskScan(roots, { uid: process.getuid!(), gid: process.getgid!() });
  context.after(() => scan.close());
  assert.equal(await scan.measure(), allocated(roots));
  const queued = Number(readFileSync('/proc/sys/fs/inotify/max_queued_events', 'utf8'));
  // Alternating modify and close-write events cannot coalesce, without growing the fixture's entry count.
  for (let write = 0; write <= queued / 2; write++) appendFileSync(burst, 'x');
  writeFileSync(join(roots[1], 'nested', 'after-overflow'), Buffer.alloc(8192));
  writeFileSync(join(roots[2], 'nested', 'after-overflow'), Buffer.alloc(16384));
  assert.equal(await scan.measure(), allocated(roots));
  rmSync(join(roots[0], 'nested'), { recursive: true });
  writeFileSync(join(roots[1], 'nested', 'after-overflow'), 'smaller');
  assert.equal(await scan.measure(), allocated(roots));
});
