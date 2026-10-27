// node --test src/visitors-report.test.ts   (infra/visitors.mjs, the status report's sections on the live products' page
// loads, over a throwaway hq.db at a given time)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const { dataDir: DATA } = await harness('visitors-report', { serve: false });
await import('./metrics.ts'); // (its tables)
writeFileSync(`${DATA}/time-zone`, 'Europe/Amsterdam');
const REPORT = new URL('../../../infra/visitors.mjs', import.meta.url).pathname;

// The sections as report.sh runs them (the coordinator's node, the script on stdin), with the clock at `now`
function report(now: string) {
  const clock = `data:text/javascript,Date.now = () => ${Date.parse(now)};`;
  const child = spawn('node', ['--disable-warning=ExperimentalWarning', '--import', clock, '--input-type=module'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, DATA_DIR: DATA },
  });
  createReadStream(REPORT).pipe(child.stdin);
  let out = '';
  child.stdout.on('data', chunk => (out += chunk));
  return new Promise<string>((done, fail) =>
    child.on('close', code => (code === 0 ? done(out) : fail(new Error(`the report sections exited ${code}`)))),
  );
}

test("the last seven days are the company's calendar days, in the last hour of a day after the clock went back too", async () => {
  // 23:30 on 28 October in Amsterdam, three days after summer time ended: six times 24 hours back is the 23rd there
  const out = await report('2026-10-28T22:30:00Z');
  assert.match(out, /page loads, visitors and visits, last 7 days from 2026-10-22 /);
  assert.match(out, /every page load by where it came from, last 7 days from 2026-10-22 /);
});
