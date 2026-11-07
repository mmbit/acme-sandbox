// node --test src/browserslot.test.ts   (a lock file of its own stands in for the machine's browser slot)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slotWatch } from './browserslot.ts';

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(done(), true);
};
const freed = (lock: string) => spawnSync('flock', ['--nonblock', lock, 'true']).status === 0;

// A lock file of a test's own, and a way to take it with flock, whose command `script` holds it too: it inherits flock's
// descriptor. Each holder is started by a shell in a session of its own that exits at once, so the holder is orphaned
// as a leftover is. Its group is that shell's pid.
function slot() {
  const dir = mkdtempSync(join(tmpdir(), 'browser-slot-'));
  const lock = join(dir, 'lock');
  writeFileSync(lock, '');
  let taken = 0;
  const take = async (script = 'sleep infinity', ...args: string[]) => {
    const held = join(dir, `held-${taken++}`);
    // (the shell's own arguments: $0 the lock, then flock's command)
    const shell = spawnSync(
      'setsid',
      [
        'sh',
        '-c',
        'flock --exclusive "$0" "$@" >/dev/null 2>&1 & echo $$ $!',
        lock,
        'sh',
        '-c',
        `touch "$0"; ${script}`,
        held,
        ...args,
      ],
      { encoding: 'utf8' },
    );
    const [group, pid] = shell.stdout.trim().split(' ').map(Number);
    await until(() => existsSync(held));
    return { pid, group, held };
  };
  return { lock, take };
}
const end = (pid: number) => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // (ended by the watch)
  }
};

test('a holder that keeps the browser slot past its bound is ended, with a warning that names it, and the renders waiting for it go on', async () => {
  const { lock, take } = slot();
  const holder = await take();
  try {
    const waiter = spawn('flock', ['--exclusive', '--timeout', '30', lock, 'true'], { stdio: 'ignore' });
    const waited = new Promise(resolve => waiter.once('exit', resolve));
    const lines: string[] = [];
    const look = slotWatch(lock, 60_000, line => lines.push(line));
    look(0);
    look(59_000);
    assert.equal(lines.length, 0);
    look(61_000);
    assert.equal(lines.length, 1);
    for (const named of ['warning', 'held for 1 min', `${holder.pid} (flock --exclusive ${lock}`])
      assert.ok(lines[0].includes(named), lines[0]);
    assert.equal(await waited, 0);
    look(62_000);
    assert.equal(lines.length, 1);
  } finally {
    end(-holder.group);
  }
});

test('what inherited the slot from a taker that has gone is ended at the bound too', async () => {
  const { lock, take } = slot();
  const holder = await take();
  try {
    const lines: string[] = [];
    const look = slotWatch(lock, 60_000, line => lines.push(line));
    look(0);
    end(holder.pid);
    await until(() => !existsSync(`/proc/${holder.pid}`));
    assert.equal(freed(lock), false);
    look(61_000);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /sh -c touch/);
    await until(() => freed(lock));
  } finally {
    end(-holder.group);
  }
});

test('a holder whose command line holds a key is named with the key redacted', async () => {
  const { lock, take } = slot();
  const holder = await take(undefined, 'HQ_TOKEN=abcdefgh123456');
  try {
    const lines: string[] = [];
    const look = slotWatch(lock, 60_000, line => lines.push(line));
    look(0);
    look(61_000);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /HQ_TOKEN=\[redacted\]/);
    assert.doesNotMatch(lines[0], /abcdefgh123456/);
  } finally {
    end(-holder.group);
  }
});

test('what a holder hands the slot on to between two looks, as it goes, keeps its deadline', async () => {
  const { lock, take } = slot();
  const holder = await take('while [ ! -e "$0.go" ]; do sleep 0.05; done; sleep infinity &');
  try {
    const lines: string[] = [];
    const look = slotWatch(lock, 60_000, line => lines.push(line));
    look(0);
    writeFileSync(`${holder.held}.go`, '');
    await until(() => !existsSync(`/proc/${holder.pid}`));
    assert.equal(freed(lock), false);
    look(61_000);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /sleep infinity/);
    await until(() => freed(lock));
  } finally {
    end(-holder.group);
  }
});

test('a slot that changes hands, or is free, is never ended', async () => {
  const { lock, take } = slot();
  const lines: string[] = [];
  const look = slotWatch(lock, 60_000, line => lines.push(line));
  for (const at of [0, 50_000]) {
    const holder = await take();
    look(at);
    look(at + 40_000);
    end(-holder.group);
    await until(() => freed(lock)); // (the whole group has let go)
  }
  look(200_000);
  assert.deepEqual(lines, []);
});
