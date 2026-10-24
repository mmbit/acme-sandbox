// node --test src/admission.test.ts (disposable kernel and host readings)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admission } from './admission.ts';
import { FREE_MB, JOB_MB, SEAT_MB, STARTING_MS } from './reserve.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const kernel = mkdtempSync(join(tmpdir(), 'admission-'));
  t.after(() => rmSync(kernel, { recursive: true }));
  const meminfo = join(kernel, 'meminfo');
  let now = 0;
  const memory = admission<string>(() => now, kernel, meminfo);
  return {
    memory,
    advance: () => {
      now += STARTING_MS;
    },
    reading(cap: number | 'max', used: number, inactive: number, host: number) {
      for (const [name, contents] of Object.entries({
        'memory.max': cap,
        'memory.current': used,
        'memory.stat': `anon 0\ninactive_file ${inactive}\n`,
        meminfo: `MemAvailable: ${host / 1024} kB\n`,
      }))
        writeFileSync(join(kernel, name), String(contents));
    },
  };
}

for (const cap of [7168, 8192]) {
  test(`the captured load admits no ordinary or measured job under a ${cap} MiB ceiling`, t => {
    const { reading, memory } = fixture(t);
    reading(cap * 2 ** 20, 7386316800, 340353024, 5404499968);
    assert.equal(memory.room(), false);
    assert.equal(memory.starts(), 0);
    assert.equal(memory.claimMb(), 0);
  });
}

test('host availability bounds admission even when the cgroup has more room', t => {
  const { reading, memory } = fixture(t);
  reading(8192 * 2 ** 20, 1024 * 2 ** 20, 0, 5404499968);
  let admitted = 0;
  while (memory.room()) {
    memory.take();
    admitted++;
  }
  assert.equal(admitted, 5);
  assert.equal(memory.starts(), 0);
  assert.ok(memory.freeMb() >= FREE_MB);
});

test('reclaimable file cache makes room for a candidate above the reserve', t => {
  const { reading, memory } = fixture(t);
  reading(8192 * 2 ** 20, 6692 * 2 ** 20, 0, 6000 * 2 ** 20);
  assert.equal(memory.room(), false);
  reading(8192 * 2 ** 20, 6692 * 2 ** 20, JOB_MB * 2 ** 20, 6000 * 2 ** 20);
  assert.equal(memory.room(), true);
  memory.take();
  assert.equal(memory.freeMb(), FREE_MB);
  assert.equal(memory.room(), false);
});

test('holds and young starts reduce admission but shortage uses the unreserved reading', t => {
  const { reading, memory, advance } = fixture(t);
  reading('max', 1024, 0, (FREE_MB + JOB_MB + SEAT_MB) * 2 ** 20);
  const start = memory.take();
  memory.keepsHold('slot1', 'seat1', start, { held: true });
  assert.equal(memory.room(), true);
  memory.take();
  assert.equal(memory.room(), false);
  assert.equal(memory.room(false), true);
  advance();
  assert.equal(memory.room(), true);
});

test('shortage begins below 2200 MiB while a measured small claim can still fit', t => {
  const { reading, memory } = fixture(t);
  reading('max', 1024, 0, 2200 * 2 ** 20);
  assert.equal(memory.room(false), true);
  reading('max', 1024, 0, 2199 * 2 ** 20);
  assert.equal(memory.room(false), false);
  assert.equal(memory.claimMb(), 699);
});
