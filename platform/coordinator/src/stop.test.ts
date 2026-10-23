// node --test src/stop.test.ts   (the real coordinator started as its own process, on the harness's test company)
// A deploy stops the coordinator with SIGTERM. It stops taking connections at once (Caddy holds the new ones until the
// next coordinator listens), ends HQ's live feeds cleanly so they reconnect, and exits without waiting out its deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { harness } from './harness.ts';

const h = await harness('stop', { serve: false }); // (its board session is in the database the process opens)
const free = createServer().listen(0);
const port = (free.address() as AddressInfo).port;
free.close();
const base = `http://localhost:${port}`;

test('SIGTERM: the feed ends cleanly, new connections are refused, and the process exits at once', async t => {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', new URL('./server.ts', import.meta.url).pathname],
    { env: { ...process.env, PORT: String(port), PUBLIC_HOST: 'localhost' }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => child.kill());
  const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', d => {
      if (String(d).includes('listening on')) resolve();
    });
    child.on('exit', () => reject(new Error('the coordinator exited before it listened')));
  });
  const feed = await fetch(`${base}/api/events`, { headers: { cookie: h.boardCookie } });
  assert.equal(feed.status, 200);
  const reader = feed.body!.getReader();
  await reader.read(); // the recent events

  const t0 = Date.now();
  child.kill('SIGTERM');
  for (;;) if ((await reader.read()).done) break; // a clean end: an aborted stream would throw here
  assert.equal(await exited, 0);
  assert.ok(Date.now() - t0 < 2_000, `stopped in ${Date.now() - t0} ms, not at once`);
  await assert.rejects(fetch(`${base}/health`), 'nothing listens after the stop');
});
