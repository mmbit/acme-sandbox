// node --test src/inbox.test.ts   (the real Claude CLI with the worker's --settings, a scripted model and a stand-in
// coordinator on 127.0.0.1: a colleague's message sent mid-run reaches the model's next request, once, in the job's own
// thread only, and the hook acknowledges it; a lost ack means it comes again; skipped where the CLI isn't installed,
// the worker image has it)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, chownSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { inboxSettings } from './inbox.ts';

const HQ = new URL('../bin/hq', import.meta.url).pathname;
const cli = (() => { try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const TOKEN = `job-token-${randomBytes(8).toString('hex')}`;

type Req = { thread: 'main' | 'sub'; text: string };   // each model request: whose, and everything it carries
type Reply = { text?: string; tool?: { name: string; input: unknown } };
// script(request, its turn in that thread, send) answers the model's request; send(text) is a colleague's hq say to this job.
// lostAcks: how many of the hook's acks the stand-in loses (as if HQ never got them).
async function run(script: (r: Req, turn: number, send: (text: string) => void) => Reply, lostAcks = 0) {
  const requests: Req[] = [], inboxCalls: string[] = [], acks: number[][] = [];
  const inbox = new Map<number, unknown>();   // waiting until acknowledged
  let nextId = 1;
  const send = (text: string) => { const id = nextId++; inbox.set(id, { message: id, from: 'vervain', from_job: 934, sent: new Date().toISOString(), reply_to: 'bolt', text }); };
  const sse = (res: ServerResponse, model: string, r: Reply) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (d: any) => res.write(`event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`);
    ev({ type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 } } });
    const blocks = [{ type: 'text', text: r.text ?? 'Working.' }, ...(r.tool ? [{ type: 'tool_use', id: `toolu_${requests.length}`, name: r.tool.name, input: r.tool.input }] : [])];
    blocks.forEach((b: any, i) => {
      ev({ type: 'content_block_start', index: i, content_block: b.type === 'text' ? { type: 'text', text: '' } : { ...b, input: {} } });
      ev({ type: 'content_block_delta', index: i, delta: b.type === 'text' ? { type: 'text_delta', text: b.text } : { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      ev({ type: 'content_block_stop', index: i });
    });
    ev({ type: 'message_delta', delta: { stop_reason: r.tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } });
    ev({ type: 'message_stop' });
    res.end();
  };
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => {
      // messages.ts's take() and ack(): this job's messages, offered until acknowledged (the stand-in offers them
      // again at once; HQ waits a minute, so parallel hooks don't both get them)
      if (req.url === '/api/agent/inbox') {
        inboxCalls.push(req.headers.authorization ?? '');
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(req.headers.authorization === `Bearer ${TOKEN}` ? [...inbox.values()] : []));
      }
      if (req.url === '/api/agent/inbox-ack' && req.headers.authorization === `Bearer ${TOKEN}`) {
        const ids: number[] = JSON.parse(b).ids;
        acks.push(ids);
        if (lostAcks > 0) { lostAcks--; res.writeHead(503); return res.end(); }
        for (const id of ids) inbox.delete(id);
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ delivered: ids }));
      }
      if (!req.url!.startsWith('/v1/messages') || req.url!.includes('count_tokens')) { res.writeHead(404); return res.end(); }
      const body = JSON.parse(b), text = JSON.stringify(body.messages);
      const r: Req = { thread: JSON.stringify(body.messages[0]).includes('SUBTASK') ? 'sub' : 'main', text };
      requests.push(r);
      const turn = requests.filter(x => x.thread === r.thread).length - 1;
      sse(res, body.model, script(r, turn, send));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const home = mkdtempSync(`${tmpdir()}/inbox-test-`);
  mkdirSync(`${home}/work`);
  // as the worker runs it, never as root (the CLI won't skip its permission prompts as root): a test run as root runs it
  // as nobody, in a home of nobody's
  const as = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
  if (as.uid) for (const f of [home, `${home}/work`]) chownSync(f, as.uid, as.gid!);
  // As the worker starts a work job (runJobIn): the same --settings, the job's HQ_* env; the scripted model stands in for the seat.
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: `${home}/.claude`, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'sk-ant-test',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HQ_URL: url, HQ_TOKEN: TOKEN, HQ_AGENT: 'bolt', HQ_JOB: '934', HQ_JOB_DIR: `${home}/work/.hq` };
  const child = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--model', 'sonnet',
    '--settings', inboxSettings(HQ)], { cwd: `${home}/work`, env, stdio: ['pipe', 'pipe', 'pipe'], ...as });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  child.stdin.end('MAIN: do the job.');
  const code = await new Promise<number>(r => child.on('close', c => r(c ?? 1)));
  server.close(); rmSync(home, { recursive: true, force: true });
  const result = out.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === 'result');
  return { code, err, result: result?.result, requests, inboxCalls, acks };
}
const bash = (command: string) => ({ name: 'Bash', input: { command, description: 'a step' } });

test('a message sent mid-run is in the model\'s next request, once, framed as a colleague\'s; one that comes as it stops gets a turn', { skip: !cli && 'no claude CLI here' }, async () => {
  const first = `Logs are in /tmp/logs-${randomBytes(4).toString('hex')}`, last = `One more thing ${randomBytes(4).toString('hex')}`;
  const r = await run((req, turn, send) => {
    if (turn === 0) { send(first); return { tool: bash('echo one') }; }   // sent while the job works: its next step brings it
    if (turn === 1) return { tool: bash('echo two') };
    if (turn === 2) { send(last); return { text: 'Done.' }; }            // sent as it's about to stop: the Stop hook keeps it going
    return { text: 'Read it; done now.' };
  });
  assert.equal(r.code, 0, r.err.slice(-500));
  assert.equal(r.result, 'Read it; done now.');
  const main = r.requests.filter(q => q.thread === 'main');
  assert.equal(main.length, 4);
  assert.ok(!main[0].text.includes(first));
  const framed = JSON.stringify(JSON.stringify({ message: 1, from: 'vervain' })).slice(1, -3);   // the message's JSON, as it sits in the request
  assert.ok(main[1].text.includes('PostToolUse:Bash hook additional context: a message from a colleague reached you through HQ (hq say)'), main[1].text.slice(-800));
  assert.ok(main[1].text.includes(framed) && main[1].text.includes(first));
  assert.ok(!main[2].text.split(first).slice(1).join('').includes('hook additional context: a message'), 'delivered once, not again at the next step');
  assert.ok(main[3].text.includes('Not an error: before you stop, a message from a colleague') && main[3].text.includes(last), main[3].text.slice(-800));
  assert.ok(r.inboxCalls.length >= 4 && r.inboxCalls.every(a => a === `Bearer ${TOKEN}`));   // after each tool call and each stop, with the job's token
  assert.deepEqual(r.acks, [[1], [2]]);   // each acknowledged once, after the hook printed it
});

test('a lost ack: the message is in the next request, and again at a later step (at least once, never lost)', { skip: !cli && 'no claude CLI here' }, async () => {
  const text = `Twice is fine ${randomBytes(4).toString('hex')}`;
  const r = await run((req, turn, send) => {
    if (turn === 0) { send(text); return { tool: bash('echo one') }; }
    if (turn === 1) return { tool: bash('echo two') };
    if (turn === 2) return { tool: bash('echo three') };
    return { text: 'Done.' };
  }, 1);
  assert.equal(r.code, 0, r.err.slice(-500));
  const main = r.requests.filter(q => q.thread === 'main'), shown = (q: Req) => q.text.split('hook additional context: a message').length - 1;
  assert.deepEqual(main.map(shown), [0, 1, 2, 2]);   // shown at step one; its ack lost, shown again at step two; then acknowledged
  assert.ok(main[1].text.includes(text));
  assert.deepEqual(r.acks, [[1], [1]]);
});

test('a team member\'s tool call doesn\'t take the lead\'s message; the lead\'s next step does', { skip: !cli && 'no claude CLI here' }, async () => {
  const text = `For the lead ${randomBytes(4).toString('hex')}`;
  const r = await run((req, turn, send) => {
    if (req.thread === 'sub') {
      if (turn === 0) { send(text); return { tool: bash('echo helper') }; }   // arrives while the helper works (the lead waits on it)
      return { text: 'Helper done.' };
    }
    if (turn === 0) return { tool: { name: 'Agent', input: { description: 'helper', prompt: 'SUBTASK: help', subagent_type: 'general-purpose', run_in_background: false } } };
    return { text: 'Lead done.' };
  });
  assert.equal(r.code, 0, r.err.slice(-500));
  const sub = r.requests.filter(q => q.thread === 'sub'), main = r.requests.filter(q => q.thread === 'main');
  assert.equal(sub.length, 2);
  assert.ok(sub.every(q => !q.text.includes(text)), 'the helper never got it');
  assert.ok(main[1].text.includes(text), 'the lead got it at its next step');
});
