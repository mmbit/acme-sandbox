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
    await withNotes([[]], async env => assert.deepEqual(await workHook(home, env, readable), {}));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a work Stop hook whose gates pass tells the run once of the board's notes it left open", async () => {
  const home = mkdtempSync(`${tmpdir()}/completion-notes-`);
  try {
    writeFileSync(`${home}/package.json`, JSON.stringify({ scripts: { gates: 'true' } }));
    await withNotes([[7, 9], []], async env => {
      const first = await workHook(home, env);
      assert.equal(first.decision, 'block');
      assert.match(first.reason, /the board's notes #7, #9 sent to this job are neither marked fixed nor answered/);
      assert.match(first.reason, /hq note <id> answered/);
      assert.deepEqual(await workHook(home, env), {}, 'told once, it may stop');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a work Stop hook whose note check fails blocks with the error, not as if no note were open', async () => {
  const home = mkdtempSync(`${tmpdir()}/completion-notes-down-`);
  try {
    writeFileSync(`${home}/package.json`, JSON.stringify({ scripts: { gates: 'true' } }));
    await withNotes([], async env => {
      const failed = await workHook(home, env);
      assert.equal(failed.decision, 'block');
      assert.match(failed.reason, /HQ is restarting/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a failed local fallback retains the helper failure and a passing fallback is accepted', async () => {
  const checkout = mkdtempSync(`${tmpdir()}/completion-fallback-`);
  try {
    writeFileSync(`${checkout}/package.json`, JSON.stringify({ scripts: { gates: 'node gates.cjs' } }));
    writeFileSync(
      `${checkout}/gates.cjs`,
      [
        "if (process.argv.includes('--helper')) { console.log('helper transport unavailable'); process.exit(2); }",
        "console.log('local gates unavailable'); process.exit(1);",
      ].join('\n'),
    );
    const failed = await workHook(checkout);
    assert.equal(failed.decision, 'block');
    assert.match(failed.reason, /helper transport unavailable[\s\S]*local gates unavailable/);
    writeFileSync(`${checkout}/gates.cjs`, "if (process.argv.includes('--helper')) process.exit(2);\n");
    await withNotes([[]], async env => assert.deepEqual(await workHook(checkout, env), {}));
  } finally {
    rmSync(checkout, { recursive: true, force: true });
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

test("a follow-through check's work Stop hook holds the session until HQ owes nothing, then runs the gates", async () => {
  const checkout = mkdtempSync(`${tmpdir()}/completion-owed-`);
  let owed: boolean | 'failing' | 'gone' = 'failing';
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/agent/followthrough-owed');
    assert.equal(req.headers.authorization, 'Bearer test-job-token');
    if (owed === 'gone') return res.destroy();
    res.statusCode = owed === 'failing' ? 503 : 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(owed === 'failing' ? { error: 'HQ is restarting' } : { owed }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    writeFileSync(`${checkout}/package.json`, JSON.stringify({ scripts: { gates: 'node gates.cjs' } }));
    writeFileSync(`${checkout}/gates.cjs`, "console.log('gates ran'); process.exit(1);");
    const { port } = server.address() as { port: number };
    const env = { HQ_URL: `http://127.0.0.1:${port}`, HQ_TOKEN: 'test-job-token' };
    // (a lookup that fails holds the session as a verdict owed does, and runs no gates)
    const failed = await workHook(checkout, env);
    assert.equal(failed.decision, 'block');
    assert.ok(failed.reason.includes('HQ is restarting'), failed.reason);
    owed = 'gone';
    const dropped = await workHook(checkout, env);
    assert.equal(dropped.decision, 'block');
    assert.ok(!dropped.reason.includes('gates ran'), dropped.reason);
    owed = true;
    const held = await workHook(checkout, env);
    assert.equal(held.decision, 'block');
    assert.ok(held.reason.includes('recorded no verdict'), held.reason);
    assert.ok(!held.reason.includes('gates ran'), held.reason);
    owed = false;
    assert.ok((await workHook(checkout, env)).reason.includes('gates ran'));
  } finally {
    server.close();
    rmSync(checkout, { recursive: true, force: true });
  }
});

// A stub HQ that answers the work Stop hook's note check (notes-untold) with each list in turn, then 503, and owes no
// follow-through verdict: env is the address and token the hook reaches it by.
async function withNotes(told: number[][], run: (env: Record<string, string>) => Promise<void>) {
  const server = createServer((req, res) => {
    if (req.url === '/api/agent/followthrough-owed') return res.end(JSON.stringify({ owed: false }));
    const ours = req.url === '/api/agent/notes-untold' && req.headers.authorization === 'Bearer job-token';
    const notes = ours ? told.shift() : undefined;
    res.writeHead(notes ? 200 : ours ? 503 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(notes ? { notes } : { error: ours ? 'HQ is restarting' : 'not found' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    await run({ HQ_URL: `http://127.0.0.1:${address.port}`, HQ_TOKEN: 'job-token' });
  } finally {
    server.close();
  }
}

// (HQ's address and token only as a test gives them: a job's own would reach the real HQ. A test that gives none
// gets the stub, with no note list: its gates fail before the note check)
async function workHook(cwd: string, env: Record<string, string> = {}, readable: string[] = []): Promise<any> {
  if (!env.HQ_URL) {
    let answer;
    await withNotes([], async hq => {
      answer = await workHook(cwd, { ...env, ...hq }, readable);
    });
    return answer;
  }
  const { HQ_URL: _url, HQ_TOKEN: _token, ...own } = process.env;
  const child = spawn(hq, ['complete', 'work', cwd, ...readable], {
    cwd,
    env: { ...own, ...env },
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
