// node --test src/checks.test.ts (real HQ command and git checkouts, helper transport played locally)
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clone, playedHq } from '../../../shared/gates/fixture.ts';

const root = new URL('../../../', import.meta.url).pathname;

test('the installed HQ checks dirty and new files in their folder and returns screenshots on failure', async context => {
  const installed = mkdtempSync(join(tmpdir(), 'installed-hq-'));
  context.after(() => rmSync(installed, { recursive: true, force: true }));
  for (const folder of ['bin', 'hq'])
    cpSync(join(root, 'platform/worker', folder), join(installed, folder), { recursive: true });
  const hq = join(installed, 'bin/hq');
  const bin = join(installed, 'tools');
  mkdirSync(bin);
  for (const tool of ['age', 'age-keygen', 'versitygw', 'caddy'])
    writeFileSync(join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = await playedHq(undefined, {
    HELPER_KINDS: JSON.stringify([{ name: 'pages', present: true, lentOnly: true, checkout: true }]),
  });
  const { dir } = clone(
    {
      'shared/gates/tests-on-helper.sh': 'shift; exec node ../check-command.ts "$@"\n',
      'subject.txt': 'base',
      'package.json': '{"type":"module"}',
      'kits/check/run.mjs': `import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
mkdirSync('shots');
writeFileSync('shots/check.png', Buffer.from([137,80,78,71,0,255]));
writeFileSync('shots/facts.json', JSON.stringify({
  text: readFileSync('../../subject.txt','utf8'),
  added: readFileSync('../../new.txt','utf8'),
  base: execFileSync('git',['show','origin/main:subject.txt'],{encoding:'utf8'}),
  kind: process.env.RUN_KIND, nested: process.env.HQ_RENDER_CHILD
}));
console.log('the check ran'); process.exitCode = 7;`,
    },
    { 'subject.txt': 'committed' },
  );
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'subject.txt'), 'edited');
  writeFileSync(join(dir, 'new.txt'), 'untracked');
  const index = execFileSync('git', ['write-tree'], { cwd: dir });
  const ran = spawnSync(hq, ['run', '--kind', 'pages', '--bring', 'shots', '--', 'node', 'run.mjs'], {
    cwd: join(dir, 'kits/check'),
    encoding: 'utf8',
    env: { ...process.env, ...env, TESTS_TOOLS_BIN: bin },
  });
  assert.equal(ran.status, 7, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /the check ran/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'kits/check/shots/facts.json'), 'utf8')), {
    text: 'edited',
    added: 'untracked',
    base: 'base',
    kind: 'pages',
    nested: '1',
  });
  assert.deepEqual(readFileSync(join(dir, 'kits/check/shots/check.png')), Buffer.from([137, 80, 78, 71, 0, 255]));
  assert.deepEqual(execFileSync('git', ['write-tree'], { cwd: dir }), index);
});

test('explicit folder runs keep their command, fallback and original artifact protocol', async context => {
  const { dir } = clone({ 'inputs/a.txt': 'input' }, { 'inputs/a.txt': 'changed' });
  const archive = execFileSync('tar', ['-czf', '-', '--files-from', '/dev/null']);
  let specification: { command: string; bring: string[]; kind: string };
  let bundleNames = '';
  const server = createServer(async (request, response) => {
    if (request.url === '/api/agent/runs/helper')
      return response.end(JSON.stringify({ kinds: [{ name: 'render', present: true }] }));
    if (request.url === '/api/agent/runs') {
      specification = JSON.parse(Buffer.from(String(request.headers['x-run']), 'base64url').toString());
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      bundleNames = execFileSync('tar', ['-tzf', '-'], { input: Buffer.concat(chunks), encoding: 'utf8' });
      return response.end(JSON.stringify({ id: 1, kind: 'render' }));
    }
    if (request.url === '/api/agent/runs/1/output') return response.end('original command output\n');
    if (request.url === '/api/agent/runs/1/files') return response.end(archive);
    response.end(
      JSON.stringify({
        id: 1,
        state: 'done',
        kind: 'render',
        on: 'lent',
        machine: 'attic',
        exitCode: 0,
        bring: [],
        helper: { name: 'attic', server: {} },
      }),
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address() as { port: number };
  const command = 'node render.mjs';
  const child = spawn(
    join(root, 'platform/worker/bin/hq'),
    ['run', '--kind', 'render', '--paths', 'inputs', '--fallback', 'here', '--', command],
    { cwd: dir, env: { ...process.env, HQ_URL: `http://127.0.0.1:${address.port}`, HQ_TOKEN: 'test' } },
  );
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
  });
  child.stderr.on('data', chunk => {
    output += chunk;
  });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, output);
  assert.equal(specification!.command, command);
  assert.match(bundleNames, /inputs\/a.txt/);
  assert.doesNotMatch(bundleNames, /tests.bundle/);
  assert.match(output, /hq run #1: done on attic/);
  assert.match(output, /original command output/);
});

test('a failed helper setup reports its reason with exit 2 before the command runs', async context => {
  const installed = mkdtempSync(join(tmpdir(), 'installed-hq-'));
  context.after(() => rmSync(installed, { recursive: true, force: true }));
  for (const folder of ['bin', 'hq'])
    cpSync(join(root, 'platform/worker', folder), join(installed, folder), { recursive: true });
  const bin = join(installed, 'tools');
  mkdirSync(bin);
  for (const tool of ['age', 'age-keygen', 'versitygw', 'caddy'])
    writeFileSync(join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const env = await playedHq(undefined, {
    HELPER_KINDS: JSON.stringify([{ name: 'audit', present: true, lentOnly: true, checkout: true }]),
    HELPER_ENV: JSON.stringify({ HOME: join(installed, 'home'), PATH: `${bin}:${process.env.PATH}` }),
  });
  const { dir } = clone(
    {
      'package.json': '{"type":"module"}',
      'package-lock.json': '{}',
      'platform/coordinator/package.json': '{}',
      'platform/coordinator/package-lock.json': '{}',
      'kits/check/keep.txt': 'input',
    },
    { 'kits/check/keep.txt': 'edited' },
  );
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'main'], { cwd: dir });
  const ran = spawnSync(join(installed, 'bin/hq'), ['run', '--kind', 'audit', '--', 'echo COMMAND-RAN'], {
    cwd: join(dir, 'kits/check'),
    encoding: 'utf8',
    env: { ...process.env, ...env, TESTS_TOOLS_BIN: bin },
  });
  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /could not run on the helper: npm ci/);
  assert.doesNotMatch(ran.stdout + ran.stderr, /COMMAND-RAN|HQ fault|Error:/);
});
