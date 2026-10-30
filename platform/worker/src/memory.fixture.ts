// Disposable kernel and host readings shared by admission and capacity checks.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admission } from './admission.ts';
import { memoryMeter } from './memory.ts';
import { overloadWatch } from './overload.ts';
import { STARTING_MS } from './reserve.ts';

export function memoryFixture(t: { after: (fn: () => void) => void }) {
  const kernel = mkdtempSync(join(tmpdir(), 'worker-memory-'));
  t.after(() => rmSync(kernel, { recursive: true }));
  const meminfo = join(kernel, 'meminfo');
  let now = 0;
  const read = (name: string) => readFileSync(join(kernel, name), 'utf8').trim();
  const measure = memoryMeter(read, () => now);
  const memory = admission<string>(() => now, measure, meminfo);
  return {
    memory,
    pressure: overloadWatch(2048, 3072, kernel, join(kernel, 'cpu.pressure')),
    measure,
    read,
    write: (name: string, contents: string) => writeFileSync(join(kernel, name), contents),
    advance: (ms = STARTING_MS) => {
      now += ms;
    },
    reading(cap: number | 'max', used: number, file: number, host: number, extra = '') {
      for (const [name, contents] of Object.entries({
        'memory.max': cap,
        'memory.current': used,
        'memory.stat': `anon 0\nfile ${file}\nshmem 0\nfile_dirty 0\nfile_writeback 0\nunevictable 0\ninactive_file 0\n${extra}`,
        'memory.swap.current': '0',
        'memory.swap.max': '0',
        'memory.swap.events': 'high 0\nmax 0\nfail 0',
        'cpu.max': 'max 100000',
        'cpuset.cpus.effective': '0-3',
        'cpu.stat': 'usage_usec 0',
        'cpu.pressure': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0',
        'io.pressure': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0',
        'memory.events': 'low 0\nhigh 0\nmax 42\noom 2\noom_kill 1\n',
        'memory.pressure':
          'some avg10=0.00 avg60=0.00 avg300=0.00 total=100\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=50\n',
        meminfo: `MemAvailable: ${host / 1024} kB\n`,
      }))
        writeFileSync(join(kernel, name), String(contents));
    },
  };
}
