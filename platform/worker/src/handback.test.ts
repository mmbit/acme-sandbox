// node --test src/handback.test.ts   (the file between a stopping worker and the next; the coordinator's side is
// coordinator/src/deploys.test.ts).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { handBack, noteHandBacks, ResponseError } from './handback.ts';

const dir = mkdtempSync(`${tmpdir()}/handback-test-`);
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const newFile = () => `${dir}/handback-${++n}.json`;
const jobsIn = (file: string) => JSON.parse(readFileSync(file, 'utf8')).map((r: { job: number }) => r.job);
const lines: string[] = [];
const log = (...a: unknown[]) => lines.push(a.join(' '));
const noWait = async () => {};

test('while a hand-back waits for the coordinator, only the runs not sent yet are left in the file', async () => {
  const file = newFile();
  const sent: number[] = [];
  noteHandBacks(file, [
    { job: 1, seat: 'claude-1' },
    { job: 2, seat: 'claude-1' },
  ]);
  let stopped = false;
  await handBack(
    file,
    async b => {
      if (b.job === 2 && !stopped) {
        stopped = true;
        throw new TypeError('fetch failed');
      }
      sent.push(Number(b.job));
    },
    log,
    async () => assert.deepEqual(jobsIn(file), [2], 'only the unsent run is left'),
  );
  assert.deepEqual(sent, [1, 2]);
  assert.ok(!existsSync(file));
});

test('a run the coordinator failed to take (500) is sent again, and leaves the file once it is taken', async () => {
  const file = newFile();
  const tries: number[] = [];
  noteHandBacks(file, [{ job: 3, seat: 'claude-1', session: 's-3' }]);
  await handBack(
    file,
    async b => {
      tries.push(Number(b.job));
      if (tries.length === 1) throw new ResponseError('finish', 500);
    },
    log,
    async () => assert.deepEqual(jobsIn(file), [3], 'kept while it is tried again'),
  );
  assert.deepEqual(tries, [3, 3]);
  assert.ok(lines.includes('job #3: handed back, cut off by the last stop'));
  assert.ok(!existsSync(file));
});

test('a coordinator that keeps failing (5xx) lets the run go after a while, so the slots can start', async () => {
  const file = newFile();
  const waits: number[] = [];
  noteHandBacks(file, [{ job: 4, seat: 'claude-1' }]);
  await handBack(
    file,
    async () => {
      throw new ResponseError('finish', 503);
    },
    log,
    async ms => waits.push(ms),
  );
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16_000, 32_000]);
  assert.ok(lines.some(l => l.startsWith('job #4: not handed back')));
  assert.ok(!existsSync(file));
});

test('a refusal (4xx) settles a run at once', async () => {
  const file = newFile();
  noteHandBacks(file, [{ job: 5, seat: 'claude-1' }]);
  await handBack(
    file,
    async () => {
      throw new ResponseError('finish', 409);
    },
    log,
    async () => assert.fail('a refusal is not tried again'),
  );
  assert.ok(!existsSync(file));
});

test("a file that can't be read throws, at a start and at a stop, and is left as it is", async () => {
  for (const text of ['[{"job": 6, "seat": "cla', '{"job": 6}']) {
    const file = newFile();
    writeFileSync(file, text);
    await assert.rejects(handBack(file, async () => assert.fail('nothing is sent'), log, noWait));
    assert.throws(() => noteHandBacks(file, [{ job: 7, seat: 'claude-1' }]));
    assert.equal(readFileSync(file, 'utf8'), text);
  }
});

test('a write that fails leaves the queue as it was, and a new one is 0600', () => {
  const file = newFile();
  noteHandBacks(file, [{ job: 8, seat: 'claude-1' }]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  mkdirSync(`${file}.new`); // the write beside it fails
  assert.throws(() => noteHandBacks(file, [{ job: 9, seat: 'claude-1' }]));
  assert.deepEqual(jobsIn(file), [8]);
});
