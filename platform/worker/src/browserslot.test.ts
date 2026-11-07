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

test('a holder that keeps the browser slot past its bound is ended, with a warning that names it, and the renders waiting for it go on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-slot-'));
  const [lock, held] = [join(dir, 'lock'), join(dir, 'held')];
  writeFileSync(lock, '');
  const holder = spawn('flock', ['--exclusive', lock, 'sh', '-c', `touch '${held}'; sleep infinity`], {
    detached: true,
    stdio: 'ignore',
  });
  try {
    await until(() => existsSync(held));
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
    try {
      process.kill(-holder.pid!, 'SIGKILL');
    } catch {
      // (ended by the watch)
    }
  }
});

test('a holder whose command line holds a key is named with the key redacted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-slot-'));
  const [lock, held] = [join(dir, 'lock'), join(dir, 'held')];
  writeFileSync(lock, '');
  const holder = spawn(
    'flock',
    ['--exclusive', lock, 'sh', '-c', `touch '${held}'; sleep infinity`, 'HQ_TOKEN=abcdefgh123456'],
    {
      detached: true,
      stdio: 'ignore',
    },
  );
  try {
    await until(() => existsSync(held));
    const lines: string[] = [];
    const look = slotWatch(lock, 60_000, line => lines.push(line));
    look(0);
    look(61_000);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /HQ_TOKEN=\[redacted\]/);
    assert.doesNotMatch(lines[0], /abcdefgh123456/);
  } finally {
    try {
      process.kill(-holder.pid!, 'SIGKILL');
    } catch {
      // (ended by the watch)
    }
  }
});

test('a slot that changes hands, or is free, is never ended', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-slot-'));
  const lock = join(dir, 'lock');
  writeFileSync(lock, '');
  const lines: string[] = [];
  const look = slotWatch(lock, 60_000, line => lines.push(line));
  for (const at of [0, 50_000]) {
    const held = join(dir, `held-${at}`);
    const holder = spawn('flock', ['--exclusive', lock, 'sh', '-c', `touch '${held}'; sleep infinity`], {
      detached: true,
      stdio: 'ignore',
    });
    await until(() => existsSync(held));
    look(at);
    look(at + 40_000);
    process.kill(-holder.pid!, 'SIGKILL');
    await until(() => spawnSync('flock', ['--nonblock', lock, 'true']).status === 0); // (the whole group has let go)
  }
  look(200_000);
  assert.deepEqual(lines, []);
});
