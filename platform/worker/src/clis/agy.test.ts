// node --test src/clis/agy.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agy } from './agy.ts';
import { observe, outcome, verdict } from '../outcome.ts';
import { usageOf } from '../usage.ts';
import { see, verdictOf, written } from '../verdict.ts';

// Real lines from agy 1.3.5 (Linux x64) run in /w against a scripted Gemini API (an API key and GOOGLE_GEMINI_BASE_URL,
// as no account was used), with the init line's tools list cut short. They are the stream a seat's run prints too: the
// sign-in changes the backend, not the stream.
const WRITE_RUN = `
{"event":"init","conversation_id":"da149704-a55d-4dc1-8d51-100c2957f3f5","init":{"model":"gemini-3.1-pro-high","cwd":"/w","tools":["run_command","view_file","write_to_file","..."],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"conversation_id":"da149704-a55d-4dc1-8d51-100c2957f3f5","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"da149704-a55d-4dc1-8d51-100c2957f3f5","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":0.005510935,"usage":{"input_tokens":93,"output_tokens":13,"thinking_tokens":3,"cache_read_tokens":7,"total_tokens":106}}}
{"event":"step_update","step_update":{"conversation_id":"da149704-a55d-4dc1-8d51-100c2957f3f5","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/w/.hq/review.json"}}}}
{"event":"step_update","step_update":{"conversation_id":"da149704-a55d-4dc1-8d51-100c2957f3f5","step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_to_file","duration_seconds":0.006233958,"tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/w/.hq/review.json"}}}}
{"event":"step_update","step_update":{"conversation_id":"da149704-a55d-4dc1-8d51-100c2957f3f5","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"{\\"decision\\": \\"changes\\", \\"summary\\": \\"a hole\\", \\"blocking\\": []}\\n","duration_seconds":0.004883351,"usage":{"input_tokens":193,"output_tokens":23,"thinking_tokens":3,"cache_read_tokens":7,"total_tokens":216}}}
{"event":"result","result":{"conversation_id":"da149704-a55d-4dc1-8d51-100c2957f3f5","status":"SUCCESS","response":"{\\"decision\\": \\"changes\\", \\"summary\\": \\"a hole\\", \\"blocking\\": []}\\n","duration_seconds":0.079426391,"num_turns":1,"usage":{"input_tokens":286,"output_tokens":36,"thinking_tokens":6,"cache_read_tokens":14,"total_tokens":322}}}
`;
const COMMAND_RUN = `
{"event":"init","conversation_id":"c36a5bc8-d645-44ca-82ca-0b085f960470","init":{"cwd":"/w","tools":["run_command","view_file","write_to_file","..."],"permission_mode":"always-proceed"}}
{"event":"step_update","step_update":{"conversation_id":"c36a5bc8-d645-44ca-82ca-0b085f960470","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"c36a5bc8-d645-44ca-82ca-0b085f960470","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":0.006924068,"usage":{"input_tokens":93,"output_tokens":13,"thinking_tokens":3,"cache_read_tokens":7,"total_tokens":106}}}
{"event":"step_update","step_update":{"conversation_id":"c36a5bc8-d645-44ca-82ca-0b085f960470","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello_scripted"}}}}
{"event":"step_update","step_update":{"conversation_id":"c36a5bc8-d645-44ca-82ca-0b085f960470","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.010889423,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello_scripted"},"output":"hello_scripted\\r\\n"}}}
{"event":"step_update","step_update":{"conversation_id":"c36a5bc8-d645-44ca-82ca-0b085f960470","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"All done.\\n","duration_seconds":0.00431502,"usage":{"input_tokens":193,"output_tokens":23,"thinking_tokens":3,"cache_read_tokens":7,"total_tokens":216}}}
{"event":"result","result":{"conversation_id":"c36a5bc8-d645-44ca-82ca-0b085f960470","status":"SUCCESS","response":"All done.\\n","duration_seconds":0.085052457,"num_turns":1,"usage":{"input_tokens":286,"output_tokens":36,"thinking_tokens":6,"cache_read_tokens":14,"total_tokens":322}}}
`;
const HTTP_429 = `
{"event":"init","conversation_id":"8dab38f4-4f1b-42d4-908a-caaadfdeeee8","init":{"cwd":"/w","tools":["run_command","view_file","write_to_file","..."],"permission_mode":"request-review"}}
{"event":"result","result":{"conversation_id":"8dab38f4-4f1b-42d4-908a-caaadfdeeee8","status":"ERROR","response":"","error":"agent executor error: generating and executing: Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED, Details: []","duration_seconds":118.265307915,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}
`;
const HTTP_401 = `
{"event":"init","conversation_id":"2180fa72-e5d8-482c-90ef-564689c9e503","init":{"cwd":"/w","tools":["run_command","view_file","write_to_file","..."],"permission_mode":"request-review"}}
{"event":"result","result":{"conversation_id":"2180fa72-e5d8-482c-90ef-564689c9e503","status":"ERROR","response":"","error":"agent executor error: generating and executing: Error 401, Message: Request had invalid authentication credentials., Status: UNAUTHENTICATED, Details: []","duration_seconds":0,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}
`;
const HTTP_403 = `
{"event":"init","conversation_id":"b1eaf7ce-b76e-46a7-bd3f-645105ba66bb","init":{"cwd":"/w","tools":["run_command","view_file","write_to_file","..."],"permission_mode":"request-review"}}
{"event":"result","result":{"conversation_id":"b1eaf7ce-b76e-46a7-bd3f-645105ba66bb","status":"ERROR","response":"","error":"agent executor error: generating and executing: Error 403, Message: The caller does not have permission, Status: PERMISSION_DENIED, Details: []","duration_seconds":0,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}
`;
// With no sign-in, agy answers before it has a conversation, and exits 1
const SIGNED_OUT = `{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}`;
const SIGNED_OUT_STDERR =
  "Error: authentication required. Run 'antigravity' to log in, then retry.\nerror: authentication failed or timed out\n";

const VERDICT = '{"decision": "changes", "summary": "a hole", "blocking": []}';

// The run as the worker reads it: every line through events(), then its readers, keeping the last reply as onLine does
function read(stream: string) {
  const state: Record<string, unknown> = {},
    how = outcome(),
    file = written('/w', '/w/.hq/review.json');
  const claude: any[] = [];
  let last = '',
    usage;
  for (const line of stream.trim().split('\n')) {
    for (const e of agy.events(JSON.parse(line), state) as any[]) {
      claude.push(e);
      observe(how, e);
      see(file, e);
      if (e.type === 'assistant') for (const c of e.message.content) if (c.type === 'text') last = c.text;
      if (e.type === 'result' && !e.is_error) last = e.result;
      usage = usageOf(e) ?? usage;
    }
  }
  return { claude, how, last, usage, verdict: verdictOf(file, last), state };
}

test('a normal end: its session, its reply, its usage under the model, and the verdict from the final message', () => {
  const run = read(WRITE_RUN);
  assert.equal(run.state['session'], 'da149704-a55d-4dc1-8d51-100c2957f3f5');
  assert.equal(run.claude[0].session_id, 'da149704-a55d-4dc1-8d51-100c2957f3f5');
  assert.equal(verdict(run.how, 'agy', ''), undefined);
  assert.equal(run.last, VERDICT);
  // the result's usage is the run's total, its input already without the cached part
  assert.deepEqual(run.usage, {
    models: { 'gemini-3.1-pro-high': { input: 286, cacheWrite: 0, cacheRead: 14, output: 36, cost: 0 } },
    cost: 0,
  });
  // the Write of the verdict file shows only its path: the file is unknown, and the final message is the verdict
  const write = run.claude.find(e => e.message?.content?.[0]?.type === 'tool_use').message.content[0];
  assert.deepEqual(write, {
    type: 'tool_use',
    id: 'da149704-a55d-4dc1-8d51-100c2957f3f5:2',
    name: 'Write',
    input: { file_path: '/w/.hq/review.json' },
  });
  assert.equal(run.verdict, VERDICT);
  assert.notEqual(read(WRITE_RUN.replace(/"response":"[^}]*\}\\n"/, '"response":"Done."')).verdict, VERDICT);
});

test('a command step reads as a Bash call and its result, shown once', () => {
  const run = read(COMMAND_RUN);
  const steps = run.claude.flatMap(e => e.message?.content ?? []);
  assert.deepEqual(
    steps.filter(c => c.type === 'tool_use'),
    [
      {
        type: 'tool_use',
        id: 'c36a5bc8-d645-44ca-82ca-0b085f960470:2',
        name: 'Bash',
        input: { command: 'echo hello_scripted' },
      },
    ],
  );
  assert.deepEqual(
    steps.filter(c => c.type === 'tool_result'),
    [
      {
        type: 'tool_result',
        tool_use_id: 'c36a5bc8-d645-44ca-82ca-0b085f960470:2',
        content: 'hello_scripted\r\n',
        is_error: false,
      },
    ],
  );
  assert.equal(run.last, 'All done.');
  // a step that arrives only DONE, failed, still shows its call
  const failed = agy.events(
    {
      event: 'step_update',
      step_update: {
        conversation_id: 'c',
        step_index: 5,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: {
          name: 'view_file',
          parameters: { AbsolutePath: '/w/a.ts' },
          error: { type: 'not_found', message: 'no such file' },
        },
      },
    },
    {},
  ) as any[];
  assert.deepEqual(
    failed.map(e => e.message.content[0]),
    [
      { type: 'tool_use', id: 'c:5', name: 'Read', input: { file_path: '/w/a.ts' } },
      { type: 'tool_result', tool_use_id: 'c:5', content: 'no such file', is_error: true },
    ],
  );
});

test("a reply's deltas are shown whole once its step is done", () => {
  // the shape of agy's docs (headless, "Read the results"): an ACTIVE delta, then the DONE one
  const state: Record<string, unknown> = {};
  const step = (state_: string, text_delta: string) => ({
    event: 'step_update',
    step_update: { conversation_id: 'c', step_index: 2, state: state_, step_type: 'agent_response', text_delta },
  });
  assert.deepEqual(agy.events(step('ACTIVE', 'app'), state), []);
  assert.deepEqual(agy.events(step('ACTIVE', 'le'), state), []);
  assert.deepEqual((agy.events(step('DONE', '\n'), state) as any[])[0].message.content, [
    { type: 'text', text: 'apple' },
  ]);
});

test('the API refusing the run: a usage limit, a bad sign-in, a refusal that is neither', () => {
  const limited = read(HTTP_429);
  assert.equal(verdict(limited.how, 'agy', ''), 'limited');
  assert.equal(limited.claude.at(-1).api_error_status, 429);
  assert.match(limited.how.cli, agy.errors.limit);
  assert.equal(verdict(read(HTTP_401).how, 'agy', ''), 'auth');
  assert.match(read(HTTP_401).how.cli, agy.errors.auth);
  // a 403 on its own isn't a closed account: an API key without the model answers the same
  const denied = read(HTTP_403);
  assert.equal(verdict(denied.how, 'agy', ''), undefined);
  assert.doesNotMatch(denied.how.cli, agy.errors.closed!);
});

test('no sign-in: the result agy prints, and its stderr when nothing structured came', () => {
  const run = read(SIGNED_OUT);
  assert.equal(verdict(run.how, 'agy', ''), 'auth');
  assert.equal(run.state['session'], undefined);
  assert.match(SIGNED_OUT_STDERR, agy.errors.auth);
  assert.doesNotMatch(SIGNED_OUT_STDERR, agy.errors.limit);
});

test('a closed account: the tier check names it (text from the binary, never seen live)', () => {
  assert.match('Account ineligible: ADMIN_SUSPENDED', agy.errors.closed!);
  assert.match('Account ineligible: INELIGIBLE_ACCOUNT', agy.errors.closed!);
  assert.doesNotMatch(
    'Error 403, Message: The caller does not have permission, Status: PERMISSION_DENIED',
    agy.errors.closed!,
  );
});

test('the prompt goes on stdin as one stream-json line, never in the arguments', () => {
  const prompt = 'Review "this"\nplease';
  assert.deepEqual(JSON.parse(agy.input!(prompt)), { event: 'user', message: { content: prompt } });
  assert.ok(agy.input!(prompt).endsWith('}\n'));
  const args = agy.run({ home: '/h', model: 'gemini-4-argon', effort: 'high', session: 's1', reviewing: false });
  assert.ok(!args.includes('-p') && !args.some(a => a.includes('Review')));
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gemini-4-argon']);
  assert.deepEqual(args.slice(-2), ['--conversation', 's1']);
  assert.ok(!agy.ask({ home: '/h' }).includes('--dangerously-skip-permissions'));
});
