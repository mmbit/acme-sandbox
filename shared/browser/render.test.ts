// node --test shared/browser/render.test.ts   (throwaway repos, real supervisors, no heavy renders)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { clone, playedHq } from '../gates/fixture.ts';
import { supervise } from './supervise.ts';

const root = resolve(import.meta.dirname, '../..');
const noHelper = { HQ_URL: '', HQ_TOKEN: '', HQ_RENDER_CHILD: '' };
const fixture = `
import '../../platform/hq/harness.mjs';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, openSync, closeSync, unlinkSync, mkdirSync} from 'node:fs';
const option = name => process.argv[process.argv.indexOf(name)+1];
const output = option('--out');
mkdirSync(output,{recursive:true});
if (process.env.RENDER_BUSY) {
  const fd = openSync(process.env.RENDER_BUSY, 'wx');
  await new Promise(r=>setTimeout(r, 200));
  closeSync(fd); unlinkSync(process.env.RENDER_BUSY);
}
const facts = {kind: process.env.RUN_KIND ?? 'local', text: readFileSync('subject.txt','utf8'),
  base: execFileSync('git',['show',option('--ref')+':subject.txt'],{encoding:'utf8'}),
  source: process.env.HQ_RENDER_SOURCE && JSON.parse(process.env.HQ_RENDER_SOURCE)};
writeFileSync(output+'/facts.json', JSON.stringify(facts));
writeFileSync(output+'/shot.png', Buffer.from([137,80,78,71,0,255,254]));
if (process.argv.includes('--record')) writeFileSync(option('--record'), JSON.stringify(facts.source));
process.exitCode = Number(process.env.RENDER_EXIT ?? 0);
`;

function repository() {
  const files = Object.fromEntries(
    [
      'platform/hq/harness.mjs',
      'platform/worker/hq/unpack.ts',
      'shared/browser/render.ts',
      'shared/browser/supervise.ts',
      'shared/browser/onhelper.ts',
    ].map(name => [name, readFileSync(join(root, name), 'utf8')]),
  );
  return clone(
    {
      ...files,
      'subject.txt': 'base',
      'shared/browser/fixture.mjs': fixture,
      'shared/browser/onhelper.sh': 'exec node shared/browser/onhelper.ts "$1"\n',
    },
    { 'subject.txt': 'change' },
  );
}

function run(dir: string, args: string[], env = {}) {
  const child = spawn(process.execPath, ['shared/browser/fixture.mjs', ...args], {
    cwd: dir,
    env: { ...process.env, ...noHelper, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
  });
  child.stderr.on('data', chunk => {
    output += chunk;
  });
  return new Promise<{ code: number | null; output: string }>(resolve => {
    child.once('exit', code => resolve({ code, output }));
  });
}

test('independent harness runs use one worker render slot when the helper is absent', async () => {
  const repositories = [repository(), repository()];
  const scratch = mkdtempSync(join(tmpdir(), 'render-lock-'));
  const env = { RENDER_BUSY: join(scratch, 'busy') };
  const outcomes = await Promise.all(
    ['one', 'two'].map((name, index) =>
      run(repositories[index].dir, ['--ref', 'main', '--out', join(scratch, name)], env),
    ),
  );
  for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.output);
  for (const name of ['one', 'two'])
    assert.equal(JSON.parse(readFileSync(join(scratch, name, 'facts.json'), 'utf8')).kind, 'local');
});

test('a helper render gets the dirty snapshot and chosen base, returns binary files and provenance, and keeps its failure final', async () => {
  const { dir } = repository();
  writeFileSync(join(dir, 'subject.txt'), 'uncommitted');
  const output = join(dir, 'pictures with spaces');
  const env = await playedHq(
    [
      ['waiting', 'attic'],
      ['done', 'attic'],
    ],
    {
      HELPER_ENV: JSON.stringify({ RENDER_EXIT: '7' }),
      HELPER_TAKE_MINUTES: '0',
    },
  );
  const ran = await run(dir, ['--ref', 'main', '--record', 'record.md', '--out', output], env);
  assert.equal(ran.code, 7, ran.output);
  const facts = JSON.parse(readFileSync(join(output, 'facts.json'), 'utf8'));
  assert.equal(facts.kind, 'render');
  assert.equal(facts.text, 'uncommitted');
  assert.equal(facts.base, 'base');
  assert.equal(facts.source.branch, 'work');
  assert.equal(facts.source.dirty, true);
  assert.equal(facts.source.ref, 'main');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'record.md'), 'utf8')), facts.source);
  assert.deepEqual(readFileSync(join(output, 'shot.png')), Buffer.from([137, 80, 78, 71, 0, 255, 254]));
  assert.doesNotMatch(ran.output, /queued on this worker/);
});

test('an away helper goes straight to the worker queue', async () => {
  const { dir } = repository();
  const output = join(dir, 'pictures');
  const ran = await run(dir, ['--ref', 'main', '--out', output], await playedHq(undefined, { HELPER_KINDS: '[]' }));
  assert.equal(ran.code, 0, ran.output);
  assert.equal(JSON.parse(readFileSync(join(output, 'facts.json'), 'utf8')).kind, 'local');
});

function processFixture(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'render-process-'));
  const file = join(dir, 'fixture.mjs');
  writeFileSync(file, source);
  return { dir, file };
}

function stopped(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z ');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return true;
  }
}

for (const ending of ['stall', 'exit'])
  test(`a render's ${ending} ends detached Chromium descendants and releases the worker slot`, async () => {
    const { dir, file } = processFixture(`
    import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    writeFileSync('child.pid',String(child.pid));
    ${ending === 'stall' ? 'setInterval(()=>{},1000);' : 'process.exit(0);'}
  `);
    const code = await supervise(file, [], { cwd: dir, lock: true, idleMs: 1000 });
    assert.equal(code, ending === 'stall' ? 124 : 0);
    assert.equal(stopped(Number(readFileSync(join(dir, 'child.pid'), 'utf8'))), true);
    const next = processFixture('process.exit(0)');
    assert.equal(await supervise(next.file, [], { cwd: next.dir, lock: true, idleMs: 1000 }), 0);
  });

test('ending the dispatch process ends its running render and detached descendants', async () => {
  const { dir, file } = processFixture(`
    import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    writeFileSync('child.pid',String(child.pid)); setInterval(()=>{},1000);
  `);
  const driver = join(dir, 'driver.mjs');
  writeFileSync(
    driver,
    `import {supervise} from ${JSON.stringify(join(root, 'shared/browser/supervise.ts'))};
    process.exitCode = await supervise(${JSON.stringify(file)}, [], {cwd:${JSON.stringify(dir)},lock:true});`,
  );
  const child = spawn(process.execPath, [driver], { stdio: 'ignore' });
  const pidFile = join(dir, 'child.pid');
  for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(existsSync(pidFile), true);
  child.kill('SIGKILL');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 200 && !stopped(pid); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(stopped(pid), true);
  const next = processFixture('process.exit(0)');
  assert.equal(await supervise(next.file, [], { cwd: next.dir, lock: true, idleMs: 1000 }), 0);
});
