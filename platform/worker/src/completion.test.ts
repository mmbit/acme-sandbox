// node --test src/completion.test.ts (real CLIs with local scripted providers, no paid API calls)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chownSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { completionHooks } from './completion.ts';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const hq = new URL('../bin/hq', import.meta.url).pathname;
const replies = [
  'The panel should read this.',
  '{"decision":"review","consolidator":"author"}',
  '{"decision":"review","consolidator":"ruler","reviewers":[]}',
];
const errors = ['ineligible consolidator', null];

test('a valid answer file with a prose final message explains which output to correct', async () => {
  const home = mkdtempSync(`${tmpdir()}/completion-prose-`);
  try {
    mkdirSync(`${home}/.hq`);
    writeFileSync(`${home}/.hq/review.json`, replies[2]);
    const child = spawn(hq, ['complete', 'review'], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, HQ_JOB_DIR: `${home}/.hq` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'I wrote .hq/review.json.' }));
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, 0);
    const refused = JSON.parse(output);
    assert.equal(refused.decision, 'block');
    assert.ok(refused.reason.includes('your final message is not the JSON answer'));
    assert.ok(refused.reason.includes('end with the same JSON you wrote to .hq/review.json, and nothing else'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a work Stop hook returns the formatter failure and accepts the corrected file', async () => {
  const home = mkdtempSync(`${tmpdir()}/completion-gates-`);
  try {
    // (Prettier's package lies outside the checkout: the hook names it readable, as the worker names the git mirror)
    const prettier = fileURLToPath(import.meta.resolve('prettier/bin/prettier.cjs'));
    const readable = [dirname(dirname(prettier))];
    writeFileSync(`${home}/package.json`, JSON.stringify({ scripts: { gates: `node ${prettier} --check sample.js` } }));
    writeFileSync(`${home}/sample.js`, 'const answer={ready:true};');
    const failed = await workHook(home, {}, readable);
    assert.equal(failed.decision, 'block');
    assert.ok(failed.reason.includes('sample.js'));
    writeFileSync(`${home}/sample.js`, 'const answer = { ready: true };\n');
    assert.deepEqual(await workHook(home, {}, readable), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a work Stop hook's gates can't read, write or reopen the CLI home outside the checkout, nor see its environment", async () => {
  const home = mkdtempSync(`${tmpdir()}/completion-home-`);
  const checkout = mkdtempSync(`${tmpdir()}/completion-checkout-`);
  try {
    mkdirSync(`${home}/.codex`);
    writeFileSync(`${home}/.codex/auth.json`, '{"signed":"in"}');
    const opened = [home, `${home}/.codex`, `${home}/.codex/auth.json`];
    opened.forEach(f => chmodSync(f, 0o700));
    const modes = () => opened.map(f => statSync(f).mode);
    const before = modes();
    const probe = [
      "const fs = require('fs');",
      'const tried = f => { try { return f(), "done"; } catch (e) { return e.code; } };',
      `console.log("read " + tried(() => fs.readFileSync(${JSON.stringify(`${home}/.codex/auth.json`)})));`,
      `console.log("wrote " + tried(() => fs.writeFileSync(${JSON.stringify(`${home}/.codex/hooks.json`)}, "{}")));`,
      `console.log("chmod " + ${JSON.stringify(opened)}.map(f => tried(() => fs.chmodSync(f, 0o777))));`,
      'console.log("checkout " + tried(() => fs.writeFileSync("written", "")));',
      'console.log("env " + ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "PRINTAPI_CLIENT_ID"].filter(k => k in process.env));',
      'process.exit(1);',
    ];
    writeFileSync(`${checkout}/probe.js`, probe.join('\n'));
    writeFileSync(`${checkout}/package.json`, JSON.stringify({ scripts: { gates: 'node probe.js' } }));
    const env = { CODEX_HOME: `${home}/.codex`, CLAUDE_CONFIG_DIR: `${home}/.claude`, PRINTAPI_CLIENT_ID: 'test' };
    const { reason } = await workHook(checkout, env);
    assert.ok(reason.includes('read EACCES'), reason);
    assert.ok(reason.includes('wrote EACCES'), reason);
    assert.ok(reason.includes('chmod EPERM,EPERM,EPERM'), reason);
    assert.deepEqual(modes(), before);
    assert.ok(reason.includes('checkout done'), reason);
    assert.ok(reason.includes('env \n'), reason);
    assert.ok(!existsSync(`${home}/.codex/hooks.json`));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

async function workHook(cwd: string, env: Record<string, string> = {}, readable: string[] = []) {
  const child = spawn(hq, ['complete', 'work', cwd, ...readable], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
  });
  child.stdin.end(JSON.stringify({ hook_event_name: 'Stop' }));
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0);
  return JSON.parse(output);
}

for (const cli of ['claude', 'codex'])
  test(
    `${cli} refuses repeated invalid answers inside one session`,
    {
      skip: spawnSync(cli, ['--version']).status !== 0 && `no ${cli} CLI`,
    },
    async () => {
      const requests: string[] = [],
        answers: unknown[] = [];
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', chunk => {
          body += chunk;
        });
        req.on('end', () => {
          if (req.url === '/api/agent/review-output') {
            assert.equal(req.headers.authorization, 'Bearer test-job-token');
            answers.push(JSON.parse(body).output);
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify({ error: errors[answers.length - 1] }));
          }
          if (
            cli === 'claude'
              ? !req.url!.startsWith('/v1/messages') || req.url!.includes('count_tokens')
              : !req.url!.endsWith('/responses')
          ) {
            res.writeHead(404);
            return res.end();
          }
          requests.push(body);
          const text = replies[Math.min(requests.length - 1, replies.length - 1)];
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const event = (value: any) => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
          if (cli === 'codex') {
            event({ type: 'response.created', response: { id: `resp_${requests.length}` } });
            event({
              type: 'response.output_item.done',
              item: {
                type: 'message',
                role: 'assistant',
                id: `msg_${requests.length}`,
                content: [{ type: 'output_text', text }],
              },
            });
            event({
              type: 'response.completed',
              response: {
                id: `resp_${requests.length}`,
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            });
          } else {
            event({
              type: 'message_start',
              message: {
                id: `msg_${requests.length}`,
                type: 'message',
                role: 'assistant',
                model: 'sonnet',
                content: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            });
            event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
            event({ type: 'content_block_stop', index: 0 });
            event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
            event({ type: 'message_stop' });
          }
          res.end();
        });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const home = mkdtempSync(`${tmpdir()}/completion-`);
      try {
        const url = `http://127.0.0.1:${(server.address() as any).port}`;
        const hooks = completionHooks('consolidate', { hq });
        mkdirSync(`${home}/.codex`);
        writeFileSync(`${home}/.codex/hooks.json`, JSON.stringify({ hooks }));
        const as = cli === 'claude' && process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
        if (as.uid) chownSync(home, as.uid, as.gid!);
        const env = {
          PATH: process.env.PATH,
          HOME: home,
          CODEX_HOME: `${home}/.codex`,
          CLAUDE_CONFIG_DIR: `${home}/.claude`,
          ANTHROPIC_BASE_URL: url,
          ANTHROPIC_API_KEY: 'test',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          STAND_IN_KEY: 'test',
          HQ_URL: url,
          HQ_TOKEN: 'test-job-token',
          HQ_JOB_DIR: `${home}/.hq`,
        };
        const args =
          cli === 'codex'
            ? [
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
              ]
            : [
                '-p',
                '--output-format',
                'stream-json',
                '--verbose',
                '--permission-mode',
                'bypassPermissions',
                '--model',
                'sonnet',
                '--settings',
                JSON.stringify({ hooks }),
              ];
        const child = spawn(cli, args, { cwd: home, env, ...as, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', chunk => {
          stdout += chunk;
        });
        child.stderr.on('data', chunk => {
          stderr += chunk;
        });
        child.stdin.end('Choose the reviewers.');
        const code = await new Promise(resolve => child.on('close', resolve));
        assert.equal(code, 0, stderr + stdout);
        assert.deepEqual(answers, replies.slice(1));
        assert.equal(requests.length, 3);
        assert.ok(requests[1].includes('your final message is not the JSON answer'));
        assert.ok(requests[2].includes('ineligible consolidator'));
        const events = stdout
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line));
        const sessions = new Set(events.flatMap(event => event.session_id ?? event.thread_id ?? []));
        assert.equal(sessions.size, 1, 'the same CLI session corrects every answer');
      } finally {
        server.closeAllConnections();
        server.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
