// Natural ordinary pressure gates made through disposable kernel files and worker record APIs.
import { memoryFixture } from '../../worker/src/memory.fixture.ts';
import { roomRecords } from '../../worker/src/roomrecords.ts';
import { ordinaryGate } from '../../worker/src/gateevidence.ts';
import { reportRoom } from './room.ts';

export function publishPressure(t: Parameters<typeof memoryFixture>[0]) {
  const fixture = memoryFixture(t);
  fixture.advance(Date.now() - 1000);
  fixture.reading(8e9, 7.28e9, 5.45e9, 9.7e9, 'active_file 4000000000\n');
  fixture.write('memory.pressure', 'some avg10=10.00 avg60=0 avg300=0 total=100');
  const captured = fixture.memory.inspect(() => [fixture.memory.room(), fixture.memory.claimMb()]);
  const records = roomRecords();
  records.decision({
    action: 'select claim',
    outcome: 'no claim',
    slot: 'ordinary',
    claim: null,
    job: null,
    inputs: captured.inputs,
    gate: ordinaryGate(
      {
        ordinarySelected: false,
        ready: [{ seat: 'ordinary', engine: 'codex', state: 'ready', check: false }],
        shortClaims: [{ engine: 'codex', throttled: false, exclusion: 'nonpositive room' }],
      },
      captured.inputs,
    ),
  });
  reportRoom({ records: records.latest() });
}
