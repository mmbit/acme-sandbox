// Natural cache-only reports from disposable kernel files for coordinator behavioral checks.
import { memoryFixture } from '../../worker/src/memory.fixture.ts';
import { roomRecords } from '../../worker/src/roomrecords.ts';
import { reportRoom } from './room.ts';
import * as memoryNotices from './lowmemory.ts';

export function cacheReports(t: Parameters<typeof memoryFixture>[0]) {
  memoryNotices.report({ verdict: 'calm', reasons: [] }, 6000);
  const fixture = memoryFixture(t);
  const records = roomRecords();
  fixture.advance(Date.now() - 20_000);
  fixture.reading(8e9, 7.28e9, 5.45e9, 9.7e9, 'active_file 4000000000\n');
  fixture.memory.room();
  fixture.advance(10_000);
  fixture.memory.room();
  const next = () => {
    fixture.advance(1);
    const captured = fixture.memory.inspect(() => ({
      freeMb: fixture.memory.freeMb(false),
      room: fixture.memory.room(),
      uses: new Map<number, number>(),
    }));
    const pressure = fixture.pressure({ ...captured.value, inputs: captured.inputs });
    const report = { free: Math.round(captured.value.freeMb), memory: pressure };
    records.room({ report, pressure, inputs: captured.inputs.map(input => ({ ...input, phase: 'watch' })) });
    return structuredClone({ ...report, records: records.latest() });
  };
  const send = () => {
    const report = next();
    reportRoom(report);
    return report;
  };
  return { fixture, next, send };
}
