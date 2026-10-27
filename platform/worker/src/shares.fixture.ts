// A disposable share pass with production helpers interrupted at exec by shares.trace.py.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { processesFor, tally, cliProcesses } from './shares.ts';
import { procStat } from './detached.ts';
import { enforcePriority } from './priority.ts';
import { ids, limits, shareFixture } from './sharefixture.ts';

const [command, mode = 'busy'] = process.argv.slice(2);
const affectedIds = ids.uid === 0 ? { uid: 65005, gid: 65005 } : ids;
const otherIds = ids.uid === 0 ? { uid: 65006, gid: 65006 } : ids;
const jobs = ids.uid === 0 ? [affectedIds, otherIds] : [ids];
const fixture = shareFixture(jobs);
const affected = fixture.track(spawn('sleep', ['300'], { ...affectedIds, detached: true }));
const other = fixture.track(spawn('sleep', ['300'], otherIds));
try {
  await Promise.all([once(affected.child, 'spawn'), once(other.child, 'spawn')]);
  const first = await fixture.snapshots();
  const own = first.find(p => p.pid === affected.child.pid)!;
  if (command === 'grep') {
    assert.equal(own.memoryMeasure, 'rss');
    assert.match(own.processReadingError!, /Process reading unavailable/);
    assert.equal(own.writeBytes, undefined);
    assert.equal(own.writeCallBytes, undefined);
    if (ids.uid === 0) {
      const healthy = first.find(p => p.pid === other.child.pid)!;
      assert.equal(healthy.processReadingError, undefined);
      assert.equal(healthy.memoryMeasure, 'pss');
    }
  } else {
    assert.ok(command !== 'sh' || own.group, 'autogroup is available');
    const measured = { ...own, nice: 0 };
    const before = [{ ...measured, ticks: own.ticks - (mode === 'idle' ? 0 : 500) }];
    const busyLimits = { ...limits, cores: 4 };
    const cli = mode === 'protected' ? cliProcesses([own], own) : new Set<number>();
    if (mode === 'gone') {
      affected.child.kill('SIGKILL');
      await affected.ended;
    }
    // The suite runner uses nice 10. The measured sample requests the helper despite that inherited priority.
    if (mode === 'busy') {
      await fixture.pass([measured], before, { limits: busyLimits, cli });
      assert.deepEqual(
        fixture.receipts.map(r => [r.measure, r.used, r.share]),
        [['cores', 5, 4]],
      );
      assert.equal(affected.stopped.length, 1, 'push checks retain the ordinary overuse attribution');
      assert.equal((await affected.ended)[1], 'SIGKILL');
    } else {
      // These cases exercise helper API exclusions, including a target that exits after selection.
      const uses = tally([measured], before, 1000);
      const selected = { slow: command === 'renice' ? [own] : [], groups: command === 'sh' ? [own] : [] };
      assert.deepEqual(await enforcePriority(jobs, uses, cli, busyLimits, selected), []);
      if (mode !== 'gone') assert.equal(procStat(affected.child.pid!)?.start, own.start);
    }
  }
  // A healthy command remains protected as a CLI, then subject to the ordinary resource pass.
  const now = first.filter(p => p.pid === other.child.pid);
  const cli = cliProcesses(now, { pid: other.child.pid!, start: now[0].start });
  await fixture.pass(now, now, { limits: { ...limits, mostMb: 0, processes: 0 }, cli });
  assert.equal(procStat(other.child.pid!)?.start, now[0].start);
  await fixture.pass(now, now, { limits: { ...limits, mostMb: 0 } });
  assert.deepEqual(fixture.receipts.at(-1)?.measure, 'memory');
  assert.equal(other.stopped.length, 1);
  assert.equal((await other.ended)[1], 'SIGKILL');
  // execFile has closed and reaped every helper before either API returns.
  const remaining = (await processesFor(jobs)).filter(
    p => p.ppid === process.pid && ['grep', 'renice', 'sh'].includes(p.comm),
  );
  assert.deepEqual(remaining, []);
} finally {
  await fixture.close();
}
