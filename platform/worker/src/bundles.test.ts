// node --test platform/worker/src/bundles.test.ts (a real remote-check upload stopped by resource enforcement).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clone } from '../../../shared/gates/fixture.ts';
import { blockRun } from './blocks.ts';
import { launch } from './detached.ts';
import { ResponseError } from './reports.ts';
import { processesFor, type ProcessSnapshot } from './shares.ts';

test('bundle cleanup and run stopping load from the deployed worker tree', context => {
  const installed = mkdtempSync(join(tmpdir(), 'installed-worker-'));
  context.after(() => rmSync(installed, { recursive: true, force: true }));
  // infra/worker.sh deploys platform/worker with its two parent directories stripped.
  for (const path of ['src', 'package.json'])
    cpSync(join(import.meta.dirname, '..', path), join(installed, path), { recursive: true });
  for (const module of ['bundles', 'stoprun']) {
    const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', `await import('./src/${module}.ts')`], {
      cwd: installed,
      encoding: 'utf8',
    });
    assert.equal(loaded.status, 0, loaded.stdout + loaded.stderr);
  }
});

for (const command of ['job', 'tests'])
  test(`a worker stop removes an interrupted ${command} upload bundle while keeping unrelated staging and symlink targets`, async context => {
    const temporary = mkdtempSync(join(tmpdir(), 'bundle-stop-'));
    context.after(() => rmSync(temporary, { recursive: true, force: true }));
    const homeTemporary = join(temporary, 'home', 'tmp');
    const testsTemporary = join(temporary, 'tests', '1', 'sha', 'tmp');
    for (const path of [homeTemporary, testsTemporary]) mkdirSync(path, { recursive: true });
    const uploadTemporary = command === 'tests' ? testsTemporary : homeTemporary;
    const repo = clone({ 'example.txt': 'base' }, { 'example.txt': 'change' });
    context.after(() => rmSync(repo.dir, { recursive: true, force: true }));
    let uploaded!: () => void;
    const uploading = new Promise<void>(resolve => {
      uploaded = resolve;
    });
    const server = createServer((request, _response) => {
      request.resume();
      request.on('end', uploaded);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    context.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address() as { port: number };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo.dir, encoding: 'utf8' }).trim();
    const check = {
      what: 'Upload',
      base: git('rev-parse', 'main'),
      tree: git('rev-parse', 'HEAD^{tree}'),
      script: 'unused',
      args: [],
      minutes: 1,
      bring: [],
      tools: [],
      fallback: false,
    };
    const { child, launched } = launch(
      temporary,
      command,
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const { onLent } = await import('./shared/gates/lent.ts'); await onLent(process.cwd(), JSON.parse(process.argv[1]));",
        JSON.stringify(check),
      ],
      {
        cwd: repo.dir,
        env: {
          ...process.env,
          TMPDIR: uploadTemporary,
          HQ_URL: `http://127.0.0.1:${address.port}`,
          HQ_TOKEN: 'fixture',
        },
      },
    );
    child.stdin!.end();
    context.after(() => child.kill('SIGKILL'));
    const ended = once(child, 'close');
    await Promise.race([
      uploading,
      ended.then(() => {
        throw new Error('Upload ended before submission');
      }),
    ]);
    const staging = readdirSync(uploadTemporary).filter(name => name.startsWith('lent-bundle-'));
    assert.equal(staging.length, 1);
    assert.ok(existsSync(join(uploadTemporary, staging[0], 'bundle.tar.gz')), 'the real transfer owns a staged bundle');
    const ids = { uid: process.getuid!(), gid: process.getgid!() };
    const procs = await processesFor([ids]);
    const root = procs.find(process => process.pid === child.pid)!;
    const run: ProcessSnapshot[] = [root];
    for (let i = 0; i < run.length; i++) run.push(...procs.filter(process => process.ppid === run[i].pid));
    const reused = `lent-bundle-${root.pid}-${BigInt(root.start) + 1n}-other`;
    const unrelated = 'lent-bundle-another-upload';
    for (const name of [reused, unrelated]) mkdirSync(join(uploadTemporary, name));
    const otherTemporary = command === 'tests' ? homeTemporary : testsTemporary;
    mkdirSync(join(otherTemporary, staging[0]));
    const outside = join(uploadTemporary, 'keep.txt');
    writeFileSync(outside, 'keep');
    const link = join(uploadTemporary, `lent-bundle-${root.pid}-${root.start}-link`);
    symlinkSync(outside, link);
    const options = {
      launches: [{ ...launched, start: String(BigInt(launched.start) + 1n), tmpdir: otherTemporary }, launched],
      checking: new Map(),
      ask: async () => ({ text: 'Stopped' }),
      log: () => {},
    };
    await blockRun(
      { job: 1, ...ids },
      {
        uid: ids.uid,
        measure: 'disk',
        used: null,
        share: 0,
        root,
        run,
        accountingError: { reason: 'worker-scanner', message: 'Fixture accounting failure' },
      },
      procs,
      options,
    );
    assert.equal((await ended)[1], 'SIGKILL');
    assert.ok(
      !existsSync(join(uploadTemporary, staging[0])),
      'the killed command cannot run finally, so the worker reclaims it',
    );
    assert.ok(!existsSync(link));
    for (const path of [reused, unrelated, 'keep.txt']) assert.ok(existsSync(join(uploadTemporary, path)), path);
    assert.ok(existsSync(join(otherTemporary, staging[0])), 'cleanup only visits the stopped launch temporary root');
  });

for (const report of ['answered', 'refused', 'lost'] as const)
  test(`cleanup failure preserves the ${report} HQ report outcome`, async context => {
    const temporary = mkdtempSync(join(tmpdir(), 'bundle-failure-'));
    context.after(() => rmSync(temporary, { recursive: true, force: true }));
    const stagingFile = join(temporary, 'file');
    writeFileSync(stagingFile, 'not a directory');
    const { child, launched } = launch(temporary, 'run', 'sleep', ['30'], {});
    child.stdin!.end();
    context.after(() => child.kill('SIGKILL'));
    const ended = once(child, 'close');
    await once(child, 'spawn');
    const owner = { job: 1, uid: process.getuid!(), gid: process.getgid!() };
    const procs = await processesFor([owner]);
    const root = procs.find(process => process.pid === child.pid)!;
    const reportError = report === 'refused' ? new ResponseError('blocked', 503) : new TypeError('fetch failed');
    let failure: unknown;
    try {
      await blockRun(owner, { uid: owner.uid, measure: 'disk', used: 1, share: 0, root, run: [root] }, procs, {
        launches: [{ ...launched, tmpdir: stagingFile }],
        checking: new Map(),
        log: () => {},
        ask: async () => {
          if (report !== 'answered') throw reportError;
          return { text: 'Stopped' };
        },
      });
    } catch (error) {
      failure = error;
    }
    assert.equal((await ended)[1], 'SIGKILL');
    if (report === 'answered') {
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /ENOTDIR/);
      assert.doesNotMatch(failure.message, /HQ.*unknown/);
    } else {
      assert.ok(failure instanceof AggregateError);
      const [reportFailure, cleanupFailure] = failure.errors;
      if (report === 'refused') assert.equal(reportFailure, reportError);
      else {
        assert.equal(reportFailure.cause, reportError);
        assert.match(reportFailure.message, /HQ.*unknown/);
      }
      assert.match(cleanupFailure.message, /ENOTDIR/);
    }
  });
