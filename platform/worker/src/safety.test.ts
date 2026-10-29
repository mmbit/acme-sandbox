// node --test src/safety.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chownSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { agentEnv, redact, redactJson, JOB_BRANCH, PROFILE_BRANCH, SIGN_IN, workRunsOn } from './safety.ts';
import { CLIS } from './clis.ts';

test('agents get only allowlisted variables: no GitHub or worker token, no NODE_OPTIONS', () => {
  const env = { PATH: '/usr/bin', LANG: 'C.UTF-8', HOME: '/root', GITHUB_TOKEN: 'ghp_x', WORKER_TOKEN: 'w', NODE_OPTIONS: '--require /tmp/x.js',
    ANTHROPIC_BASE_URL: 'http://evil', HTTPS_PROXY: 'http://evil', REPO: 'o/r', CI: '1' };
  const out = agentEnv(env, { HOME: '/home/worker', HQ_TOKEN: 'job-token', HQ_AGENT: 'wren', HQ_RENDERS: '/work/renders',
    WORKER_TOKEN: 'passed by mistake', GITHUB_TOKEN: 'passed by mistake', NODE_OPTIONS: 'x' },
    { PRINTAPI_CLIENT_ID: 'id', STRIPE_SECRET_KEY: 'sk', NODE_OPTIONS: 'x', ANTHROPIC_BASE_URL: 'x', PRINTAPI_LIVE_SECRET: 'live',
      STRIPE_TEST_KEY: 'raw', printapi_x: 'lower', PRINTAPI_OBJ: { not: 'a string' },
      ANTHROPICEVAL_API_KEY: 'eval', ANTHROPIC_API_KEY: 'x', ANTHROPICEVAL_OTHER: 'x' });
  assert.deepEqual(out, { PATH: '/usr/bin', LANG: 'C.UTF-8', CI: '1', HOME: '/home/worker', HQ_TOKEN: 'job-token', HQ_AGENT: 'wren',
    HQ_RENDERS: '/work/renders', PRINTAPI_CLIENT_ID: 'id', STRIPE_SECRET_KEY: 'sk', ANTHROPICEVAL_API_KEY: 'eval' });
});

test('seat and job values win over partner keys', () => {
  assert.equal(agentEnv({}, { HOME: '/home/worker' }, { HOME: '/evil' }).HOME, '/home/worker');
});

test("another CLI's seat variables pass by name, and only those named", () => {
  const out = agentEnv({}, { HOME: '/h', VIBE_HOME: '/h/.vibe', VIBE_OTHER: 'x' }, {}, ['VIBE_HOME']);
  assert.deepEqual(out, { HOME: '/h', VIBE_HOME: '/h/.vibe' });
});

test("no CLI's seat variables are named like a key, so the pass-through above never hands a job one", () => {
  for (const [name, cli] of Object.entries(CLIS)) {
    const names = [...Object.keys(cli.home('/h')), ...Object.keys(cli.env?.({ model: 'm', effort: 'high' }) ?? {})];
    for (const k of names) assert.doesNotMatch(k, /(^|_)(KEY|TOKEN|SECRET|PASSWORD)S?(_|$)/, `${name}: ${k}`);
  }
});

test('redact catches the token shapes that turn up in event and error text', () => {
  const s = redact(`git push https://x-access-token:abc123def@github.com/o/r ghp_${'a'.repeat(36)} github_pat_${'b'.repeat(20)} `
    + `Authorization: Bearer abcdefgh12345 sk-ant-oat01-${'c'.repeat(40)} sk_test_${'d'.repeat(20)}`);
  assert.ok(!/abc123def|aaaa|bbbb|abcdefgh12345|cccc|dddd/.test(s), s);
});

test('redact matches the coordinator\'s: URL passwords keep the host, Basic, Twilio pairs, named keys; words stay', () => {
  const sid = `AC${'1'.repeat(32)}`, tw = 'f'.repeat(32);
  assert.equal(redact('https://x-access-token:abc123def@github.com/o/r'), 'https://[redacted]@github.com/o/r');
  assert.equal(redact('curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="'), 'curl -H "Authorization: [redacted]"');
  assert.equal(redact(`${sid}:${tw}`), '[redacted]');
  assert.equal(redact('HQ_TOKEN=abcdef123456 BOARD_PIN: "482913" STRIPE_SECRET_KEY=\'x1y2z3w4\''),
    'HQ_TOKEN=[redacted] BOARD_PIN: "[redacted]" STRIPE_SECRET_KEY=\'[redacted]\'');
  for (const words of ['the desk-phone and the task-queue stay', 'mask_something_long stays', 'KEY=short']) assert.equal(redact(words), words);
});

test('a redacted verdict file stays the JSON it was: a named key inside escaped quotes is redacted, not the quote', () => {
  const file = JSON.stringify({ decision: 'changes', summary: 'The Dockerfile bakes in "HQ_TOKEN=abcdef123456" as a build arg',
    blocking: [{ file: 'x', why: 'Bearer abcdefghijkl leaks' }] });
  const out = JSON.parse(redactJson(file));
  assert.equal(out.decision, 'changes');
  assert.equal(out.summary, 'The Dockerfile bakes in "HQ_TOKEN=[redacted]" as a build arg');
  assert.equal(out.blocking[0].why, '[redacted] leaks');
  assert.throws(() => JSON.parse(redact(file)), 'on the raw text the redaction breaks the JSON');
  assert.equal(redactJson('not json, sk-abcdefghijkl'), 'not json, [redacted]');
});

import { BRANCH_CONFIG, REVIEW_STRIP, claudeArgs } from './safety.ts';

test('a reviewer or consolidator loads only user settings, so no branch config runs while it reviews', () => {
  const args = claudeArgs({ reviewing: true, settings: { autoMode: {} }, agents: ['--agents', 'x'], session: 'sess' });
  const i = args.indexOf('--setting-sources');
  assert.ok(i >= 0 && args[i + 1] === 'user', 'reviewing jobs pass --setting-sources user');
  assert.ok(!args.includes('--agents'), 'a reviewer is not offered the team-member agent');
  assert.deepEqual(args.slice(-2), ['--resume', 'sess']);
});

test('a work job keeps default sources (its CLAUDE.md memory loads) and gets its team-member agent', () => {
  const args = claudeArgs({ reviewing: false, settings: { autoMode: {}, hooks: {} }, agents: ['--agents', '{"team-member":{}}'] });
  assert.ok(!args.includes('--setting-sources'), 'work jobs keep the default setting sources');
  const i = args.indexOf('--agents');
  assert.ok(i >= 0 && args[i + 1] === '{"team-member":{}}', 'work jobs are offered the team-member agent');
  assert.ok(!args.includes('--resume'), 'no session, no resume');
});

test("a job compacts at the company's auto-compact window, and a value that isn't one is left out", () => {
  const at = (autocompact?: string) => {
    const args = claudeArgs({ reviewing: false, settings: {}, autocompact });
    return args.includes('--autocompact') ? args[args.indexOf('--autocompact') + 1] : null;
  };
  assert.equal(at('400000'), '400000');
  assert.equal(at('400k'), '400k');
  assert.equal(at('auto'), 'auto');
  assert.equal(at(undefined), null, 'not set: Claude Code decides');
  assert.equal(at('--dangerously-skip-permissions'), null, 'never a flag of its own');
  assert.equal(at('400000 tokens'), null);
});

test('the branch config the worker strips covers both CLIs code-running config', () => {
  for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.codex/config.toml', '.codex/hooks.json'])
    assert.ok(BRANCH_CONFIG.includes(f), `${f} is stripped from every clone`);
});

test('a reviewing clone loses the whole project folders of both CLIs (agents, skills, commands) and .mcp.json', () => {
  assert.deepEqual([...REVIEW_STRIP].sort(), ['.agents', '.claude', '.codex', '.mcp.json']);
});

// The real CLI with a scripted model (skipped where it isn't installed; the worker image has it): a step of the job's
// looks for the sign-in everywhere a job's command can: its own env, the CLI's /proc environ and open descriptors (its
// own inherited ones too) and the config folder. In the env, as before, it finds it; on the pipe, nowhere, and the
// model still gets it.
const cli = (() => { try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const PROBE = `import { readFileSync, readdirSync, readlinkSync, openSync, readSync, closeSync, constants, writeFileSync } from 'node:fs';
const [cli, config, out] = process.argv.slice(2), seen = [JSON.stringify(process.env)];
const read = p => { try { const fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK), b = Buffer.alloc(1 << 20); const n = readSync(fd, b); closeSync(fd); return b.subarray(0, n).toString(); } catch { return ''; } };
seen.push(read('/proc/' + cli + '/environ'));
for (const pid of [cli, 'self']) for (const fd of readdirSync('/proc/' + pid + '/fd')) {
  let to = ''; try { to = readlinkSync('/proc/' + pid + '/fd/' + fd); } catch {}
  if (+fd > 2 && !/^(socket|anon_inode):/.test(to)) seen.push(read('/proc/' + pid + '/fd/' + fd));
}
const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(d + '/' + e.name) : seen.push(read(d + '/' + e.name)); };
walk(config);
writeFileSync(out, seen.join('\\n'));`;

async function signedIn(how: 'env' | 'pipe') {
  const token = `sk-ant-oat01-${randomBytes(30).toString('hex')}`, home = mkdtempSync(`${tmpdir()}/sign-in-test-`), auth: string[] = [];
  writeFileSync(`${home}/probe.mjs`, PROBE);
  // as the worker runs it, never as root (the CLI won't skip its permission prompts as root): a test run as root runs it
  // as nobody, in a home of nobody's
  const as = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
  if (as.uid) for (const f of [home, `${home}/probe.mjs`]) chownSync(f, as.uid, as.gid!);
  let pid = 0, turn = 0;
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => {
      if (!req.url!.startsWith('/v1/messages') || req.url!.includes('count_tokens')) { res.writeHead(404); return res.end(); }
      auth.push(req.headers.authorization ?? '');
      const tool = turn++ === 0, ev = (d: any) => res.write(`event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`);
      const block = tool ? { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `node ${home}/probe.mjs ${pid} ${home}/.claude ${home}/seen`, description: 'look' } }
        : { type: 'text', text: 'Done.' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      ev({ type: 'message_start', message: { id: `msg_${turn}`, type: 'message', role: 'assistant', model: JSON.parse(b).model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      ev({ type: 'content_block_start', index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } });
      ev({ type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify((block as any).input) } : { type: 'text_delta', text: 'Done.' } });
      ev({ type: 'content_block_stop', index: 0 });
      ev({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } });
      ev({ type: 'message_stop' }); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const env = { ...agentEnv({ PATH: process.env.PATH }, { HOME: home, CLAUDE_CONFIG_DIR: `${home}/.claude`, ...(how === 'pipe' ? SIGN_IN.vars : {}) }),
    ...(how === 'env' ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}), ANTHROPIC_BASE_URL: url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const child = spawn('claude', ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--model', 'sonnet'],
    { cwd: home, env, stdio: how === 'pipe' ? SIGN_IN.stdio : ['pipe', 'pipe', 'pipe'], ...as });
  pid = child.pid!;
  let out = '', err = '';
  child.stdout!.on('data', d => { out += d; }); child.stderr!.on('data', d => { err += d; });
  child.stdin!.end('Look around.');
  if (how === 'pipe') SIGN_IN.hand(child, token);
  const code = await new Promise<number>(r => child.on('close', c => r(c ?? 1)));
  server.close();
  const seen = existsSync(`${home}/seen`) ? readFileSync(`${home}/seen`, 'utf8') : undefined;
  rmSync(home, { recursive: true, force: true });
  return { code, err, result: out && JSON.parse(out).result, auth: [...new Set(auth)], token, seen };
}

test("the seat's sign-in reaches the CLI on a pipe: the model gets it, nothing the job runs can read it", { skip: !cli && 'no claude CLI here' }, async () => {
  const before = await signedIn('env');
  assert.equal(before.code, 0, before.err.slice(-500));
  assert.ok(before.seen?.includes(before.token), 'in the env, a step finds it (the CLI\'s /proc environ)');
  const r = await signedIn('pipe');
  assert.equal(r.code, 0, r.err.slice(-500));
  assert.equal(r.result, 'Done.');
  assert.deepEqual(r.auth, [`Bearer ${r.token}`], 'every request carries it');
  assert.ok(r.seen !== undefined && r.seen.length > 1000, 'the step looked');
  assert.ok(!r.seen.includes(r.token), 'and found it nowhere');
});

test("profile/<n> is a branch of its own: no job branch passes as one, nor one as a job branch", () => {
  for (const branch of ['profile/5620', 'profile/1']) assert.ok(PROFILE_BRANCH.test(branch) && !JOB_BRANCH.test(branch), branch);
  for (const branch of ['job/5620', 'profile/', 'profile/12x', 'profile/12/x', 'refs/heads/profile/12', 'profile/12:main', 'main'])
    assert.ok(!PROFILE_BRANCH.test(branch), branch);
});

test("a work job runs on its job/<n>, and a profile pull request's fix on that profile/<n>, nothing else", () => {
  assert.ok(workRunsOn('job/12') && workRunsOn('job/12', 40));
  assert.ok(workRunsOn('profile/12', 40), "a fix of profile/12's pull request");
  for (const [branch, pr] of [['profile/12', null], ['main', 40], ['profile/12x', 40], ['review/12', 40]] as const)
    assert.ok(!workRunsOn(branch, pr), `${branch} ${pr}`);
});

test("a job's settings leave out the terminal's own tools and skills, and keep its own", () => {
  const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]);
  const s = settingsOf(claudeArgs({ reviewing: false, settings: { autoMode: { environment: ['x'] }, permissions: { deny: ['WebFetch'] } } }));
  assert.deepEqual(s.autoMode, { environment: ['x'] });
  assert.ok(s.permissions.deny.includes('WebFetch'), "a job's own deny stays");
  for (const tool of ['ScheduleWakeup', 'EnterWorktree', 'CronCreate']) assert.ok(s.permissions.deny.includes(tool), `${tool} is off`);
  for (const tool of ['Agent', 'Bash', 'SendMessage', 'Workflow', 'Monitor']) assert.ok(!s.permissions.deny.includes(tool), `${tool} stays`);
  assert.equal(s.skillOverrides.loop, 'off');
  assert.equal(s.skillOverrides.dataviz, undefined, 'skills a job may use stay listed');
  assert.equal(settingsOf(claudeArgs({ reviewing: true, settings: {} })).skillOverrides['keybindings-help'], 'off', 'a reviewer too');
});
