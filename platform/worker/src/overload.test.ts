// node --test src/overload.test.ts (real pressure files in throwaway folders).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { overloadWatch } from './overload.ts';
import { memoryFixture } from './memory.fixture.ts';

function pressureFiles(context: TestContext) {
  const folder = mkdtempSync(join(tmpdir(), 'overload-'));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  const pressure = (worker = 0, host = 0) => {
    writeFileSync(join(folder, 'cpu.pressure'), `some avg10=${worker} avg60=0.00 avg300=0.00 total=0\n`);
    writeFileSync(join(folder, 'host'), `some avg10=${host} avg60=0.00 avg300=0.00 total=0\n`);
  };
  pressure();
  const watch = overloadWatch(2048, 3072, folder, join(folder, 'host'));
  const look = (reading = {}) => watch({ freeMb: 5000, uses: new Map(), room: true, ...reading });
  return { pressure, look };
}

test('processor pressure warns even with free memory, holds its band, and clears after recovery', context => {
  const { pressure, look } = pressureFiles(context);
  assert.equal(look().verdict, 'calm');
  pressure(50);
  assert.match(look().reasons.join(), /CPU pressure 50%/);
  const busy = look();
  assert.equal(busy.verdict, 'low');
  assert.equal(busy.inputs.memoryVerdict, 'calm');
  assert.equal(busy.inputs.calm?.freeMb, 5000);
  assert.equal(busy.inputs.cpuBusy, true);
  pressure(40);
  assert.equal(look().verdict, 'low');
  pressure(30);
  assert.equal(look().verdict, 'calm');
  pressure(0, 80);
  assert.equal(look().verdict, 'low', 'host contention matters even when the worker has idle processors');
});

test('the worker room and low memory share the alert without changing a job memory cause', context => {
  const { look } = pressureFiles(context);
  assert.equal(look({ room: false }).verdict, 'low');
  assert.equal(look().verdict, 'calm');
  look({ uses: new Map([[7, 300]]) });
  const tight = look({ freeMb: 1500, uses: new Map([[7, 3800]]) });
  assert.equal(tight.verdict, 'low');
  assert.equal(tight.cause?.job, 7);
  assert.deepEqual(tight.inputs.calm, { freeMb: 5000, uses: { 7: 300 } });
  assert.deepEqual(tight.inputs.uses, { 7: 3800 });
  const recovering = look({ freeMb: 2500 });
  assert.equal(recovering.verdict, 'between');
  assert.match(recovering.reasons.join(), /memory recovering: 2\.4 GB free/);
  assert.equal(look().verdict, 'calm');
});

test('a memory warning retains the baseline actually compared and its original metered watch inputs', context => {
  const { memory, pressure, reading } = memoryFixture(context);
  const look = (used: number, uses = new Map<number, number>()) => {
    reading(8e9, used, 0, 8e9);
    const captured = memory.inspect(() => ({ freeMb: memory.freeMb(false), uses, room: memory.room() }));
    return pressure({ ...captured.value, inputs: captured.inputs });
  };
  const calm = look(2e9, new Map([[7, 300]]));
  const low = look(7e9, new Map([[7, 5000]]));
  assert.equal(low.cause?.job, 7);
  assert.deepEqual(low.inputs.baselineUsed, calm.inputs.calmSource);
  assert.equal(low.inputs.baselineUsed?.kind, 'calm');
  assert.ok(low.inputs.source?.free?.measurement.identity);
  assert.notDeepEqual(low.inputs.source?.free?.measurement.identity, calm.inputs.source?.free?.measurement.identity);
  assert.equal(low.inputs.source?.free?.value, low.inputs.freeMb);
  assert.equal(low.inputs.source?.room?.value, low.inputs.room);
  const recovered = look(2e9);
  assert.equal(recovered.inputs.baselineUsed, null, 'a replacement calm baseline was not used for cause comparison');
  assert.notDeepEqual(recovered.inputs.calmSource?.source, low.inputs.baselineUsed?.source);
  assert.deepEqual(
    low.inputs.baselineUsed,
    calm.inputs.calmSource,
    'the retained low look keeps its original baseline',
  );
});

test('an initial low look labels its stand-in baseline and missing metered source explicitly', context => {
  const { look } = pressureFiles(context);
  const first = look({ freeMb: 1000, uses: new Map([[7, 5000]]) });
  assert.equal(first.inputs.baselineUsed?.kind, 'initial stand-in');
  assert.equal(first.inputs.baselineUsed?.source, null);
  assert.equal(first.inputs.source, null);
  assert.equal(first.cause, undefined);
});
