// node --test src/reload.test.ts   (disposable command trees, local HQ, real reload signals)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { SUITES } from '../../../shared/gates/suites.ts';
import { harness } from '../../coordinator/src/harness.ts';
import { alive, procStat } from './detached.ts';
import { Reload } from './reload.ts';
import { signal, type Block, type ProcessSnapshot } from './shares.ts';

const h = await harness('reload');
// Use the same watchdog as the push runner, including when this file runs directly.
const timeout = Number(
  SUITES.node
    .command([])
    .find(arg => arg.startsWith('--test-timeout='))!
    .split('=')[1],
);

for (const [measure, mode] of [
  ['memory', 'reply'],
  ['processes', 'reply'],
  ['cores', 'reply'],
  ['cores', 'deadline-delay'],
  ['memory', 'deadline-request'],
  ['cores', 'error-ready'],
  ['processes', 'error-keep'],
])
  test(
    `${measure} block cleanup survives reload after a committed report loses its reply (${mode})`,
    { timeout },
    async context => {
      const job = await h.start({ agent: 'bolt' });
      const dir = mkdtempSync(`${tmpdir()}/reload-command-`);
      let requests = 0;
      const events: unknown[] = [];
      const boundary = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        events.push(body.event);
        const receipt = await h.worker('blocked', body);
        assert.equal(receipt.status, 200);
        requests++;
        if (requests === 1) response.destroy();
        else if (mode === 'deadline-request') worker.kill('SIGUSR2');
        else response.end(JSON.stringify(receipt.body));
      }).listen(0, '127.0.0.1');
      await once(boundary, 'listening');
      const url = `http://127.0.0.1:${(boundary.address() as AddressInfo).port}`;
      const worker = fork(new URL('./reload.fixture.ts', import.meta.url), [dir, url, String(job.id), measure, mode], {
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const exited = once(worker, 'exit');
      let run: ProcessSnapshot[] = [],
        block: Block | undefined,
        stderr = '';
      const messages: Record<string, any>[] = [];
      worker.stderr!.on('data', bytes => (stderr += bytes));
      worker.on('message', (message: Record<string, any>) => {
        messages.push(message);
        if (message.run) {
          run = message.run;
          block = message.block;
        }
        if (message.lost && mode !== 'deadline-request' && !messages.some(m => m.reloading)) {
          assert.ok(run.length >= 2 && run.every(p => procStat(p.pid)?.state === 'T'), 'the whole command is frozen');
          worker.kill('SIGUSR2');
        }
      });
      context.after(() => {
        worker.kill('SIGKILL');
        signal(run, 'SIGKILL');
        boundary.closeAllConnections();
        boundary.close();
        rmSync(dir, { recursive: true, force: true });
      });
      const [code, killed] = await exited;
      assert.equal(killed, null, stderr);
      assert.equal(code, 0, stderr);
      assert.ok(
        messages.some(m => m.reloading),
        'reload began after the lost reply',
      );
      while (run.some(p => alive(p.pid, p.start))) await sleep(10, undefined, { signal: context.signal });
      assert.ok(
        run.length >= 2 && run.every(p => !alive(p.pid, p.start)),
        'reload ends the whole blocked tree before exiting',
      );
      assert.equal(new Set(events).size, 1, 'retries preserve the report receipt');
      assert.ok(
        messages.some(m => m.stopped === 'refused'),
        'the late block reports its refused admission',
      );
      assert.ok(
        messages.some(m => m.stopped === 'admitted' && m.reasons.length === 1),
        'the admitted block reports its completed stop with push-check attribution',
      );
      if (mode === 'error-ready' || mode === 'error-keep') assert.ok(messages.some(m => m.failed));
      else assert.ok(messages.some(m => m.finished));
      if (mode === 'reply' || mode === 'error-keep')
        assert.match(readFileSync(`${dir}/command.err`, 'utf8'), /block 1 of 3/);
      else
        assert.ok(
          messages.some(m => /block report outcome is unknown/.test(m.blockFailed)),
          'cancellation reports an uncertain HQ outcome',
        );

      if (mode === 'deadline-request')
        assert.ok(
          messages.some(m => m.cause === 'Error: Worker reloading'),
          'reload cancels the active production request',
        );

      // The next worker cannot report the ended run again, even from a snapshot taken before reload.
      await new Reload().block({ job: job.id, uid: process.getuid!(), gid: process.getgid!() }, block!, run, {
        checking: new Map(),
        stopped: () => {},
        ask: async body => (await h.worker('blocked', body)).body,
      });
      const strikes = h.db.prepare('select count(*) n from blocks where job = ?').get(job.id) as { n: number };
      assert.equal(strikes.n, 1, 'only one strike is recorded across the reload');
      await h.finish(job);
    },
  );
