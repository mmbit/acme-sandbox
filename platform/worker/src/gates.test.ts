// node --test src/gates.test.ts (real gates, Git checkout and native CLI with a local provider, no paid calls)
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ON_HELPER, playedHq } from '../../../shared/gates/fixture.ts';
import { completionHooks } from './completion.ts';

const repo = new URL('../../..', import.meta.url).pathname;
const hq = new URL('../bin/hq', import.meta.url).pathname;

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'completion-repo-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
  for (const path of [
    'package.json',
    'eslint.config.js',
    'tsconfig.json',
    '.prettierignore',
    'shared/gates/gates.ts',
    'shared/gates/repo.ts',
    'shared/gates/lent.ts',
    'shared/gates/output.ts',
    'shared/gates/sizes.ts',
    'shared/demo/renders.mjs',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repo, path), join(root, path));
  }
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'shared/gates/tests-on-helper.sh'), ON_HELPER);
  // Any local fallback fails before loading the tools, so acceptance proves the helper supplied the verdict.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { gates: 'node entry.cjs' } }));
  writeFileSync(
    join(root, 'entry.cjs'),
    [
      "if (!process.argv.includes('--helper')) { require('fs').writeFileSync('local-gates', 'ran'); process.exit(1); }",
      "import('./shared/gates/gates.ts');",
    ].join('\n'),
  );
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, 'lib/value.ts'), 'export const value = 1;\n');
  return root;
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input: string) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0, stderr + stdout);
  return stdout;
}

test('confined completion receives real helper gate failures and accepts a correction without local gates', async () => {
  const root = checkout();
  const env = await playedHq(undefined, { GATES_HOME: process.env.GATES_HOME ?? '/opt/gates' });
  try {
    writeFileSync(join(root, 'lib/value.ts'), "export const value: number = 'one';\n");
    const failed = JSON.parse(await run(hq, ['complete', 'work', root], root, env, '{}'));
    assert.equal(failed.decision, 'block');
    assert.match(failed.reason, /lib\/value\.ts:1:.*TS2322/);
    assert.match(failed.reason, /on attic/);
    writeFileSync(join(root, 'lib/value.ts'), 'export const value = 1;\n');
    assert.deepEqual(JSON.parse(await run(hq, ['complete', 'work', root], root, env, '{}')), {});
    assert.equal(existsSync(join(root, 'local-gates')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'an ordinary native work completion passes real helper gates without a local type check',
  {
    skip: spawnSync('codex', ['--version']).status !== 0 && 'no codex CLI',
  },
  async () => {
    const root = checkout();
    const home = mkdtempSync(join(tmpdir(), 'completion-native-'));
    const env = await playedHq(undefined, { GATES_HOME: process.env.GATES_HOME ?? '/opt/gates' });
    let requests = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests++;
        if (requests > 1) {
          res.writeHead(400);
          return res.end('Completion unexpectedly requested another turn');
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const event = (value: any) => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
        event({ type: 'response.created', response: { id: 'response' } });
        event({
          type: 'response.output_item.done',
          item: {
            type: 'message',
            role: 'assistant',
            id: 'message',
            content: [{ type: 'output_text', text: 'Work complete.' }],
          },
        });
        event({
          type: 'response.completed',
          response: {
            id: 'response',
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        });
        res.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as any).port}`;
      mkdirSync(join(home, '.codex'));
      const hooks = completionHooks('work', { hq, checkout: root });
      writeFileSync(join(home, '.codex/hooks.json'), JSON.stringify({ hooks }));
      const output = await run(
        'codex',
        [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--dangerously-bypass-hook-trust',
          '-c',
          'model_provider="stand-in"',
          '-c',
          `model_providers.stand-in={name="stand-in",base_url="${url}/v1",wire_api="responses",env_key="STAND_IN_KEY"}`,
          '-m',
          'gpt-6.1-sol',
          '-',
        ],
        root,
        { ...env, HOME: home, CODEX_HOME: join(home, '.codex'), STAND_IN_KEY: 'test' },
        'Finish the work.',
      );
      assert.match(output, /Work complete/);
      assert.equal(requests, 1);
      const answer = await fetch(`${env.HQ_URL}/api/agent/runs/1`, {
        headers: { authorization: `Bearer ${env.HQ_TOKEN}` },
      });
      const helper = await answer.json();
      assert.equal(helper.state, 'done');
      assert.equal(helper.exitCode, 0);
      assert.equal(helper.machine, 'attic');
      assert.equal(existsSync(join(root, 'local-gates')), false);
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
);
