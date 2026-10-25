"""python3 -m unittest discover -s shared/inference -p 'test_provider.py'"""

import json
import os
from pathlib import Path
import subprocess
import unittest


CLIENT = r'''
const { createStdio } = await import(process.env.PROVIDER_MODULE);
const provider = createStdio({name: 'stdio'});
const model = provider.languageModel('fixture');
const prompt = [{role: 'user', content: [{type: 'text', text: 'Change the fixture and test it'}]}];
const tools = [{type: 'function', name: 'read', inputSchema: {type: 'object'}}];
const invoke = () => model.doStream({prompt, tools, toolChoice: {type: 'auto'}});
const read = async response => { const parts = []; for await (const part of response.stream) parts.push(part); return parts; };
const output = {turns: []};
try {
  if (process.env.SCENARIO === 'concurrent') {
    const first = invoke();
    try { await invoke(); } catch (error) { output.concurrentFailure = error.message; }
    output.turns.push(await read(await first));
  } else {
    output.turns.push(await read(await invoke()));
    if (process.env.SCENARIO === 'replay' || process.env.SCENARIO === 'changed') {
      prompt.push({role: 'assistant', content: [
        {type: 'reasoning', text: 'normalized reasoning'},
        {type: 'text', text: process.env.SCENARIO === 'changed' ? 'changed' : 'Reading'},
        {type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: {path: 'a.txt'}}]});
      prompt.push({role: 'tool', content: [{type: 'tool-result', toolCallId: 'call-1',
        toolName: 'read', output: {type: 'text', value: 'original'}}]});
      output.turns.push(await read(await invoke()));
    }
  }
} catch (error) { output.failure = error.message; }
console.log(JSON.stringify(output));
'''


def answer(finish='stop', message=None):
    return {'id': 1, 'choices': [{'finish_reason': finish, 'message': message or {
        'role': 'assistant', 'content': 'Done'}}], 'usage': {'prompt_tokens': 11, 'completion_tokens': 7},
        'timings': {'prompt_ms': 2.5, 'predicted_ms': 4.5}}


class ProviderTests(unittest.TestCase):
    def invoke(self, responses, scenario='once', allowed=None):
        response_read, response_write = os.pipe()
        request_read, request_write = os.pipe()
        events_read, events_write = os.pipe()
        settings = {'readFd': response_read, 'writeFd': request_write, 'eventsFd': events_write,
                    'model': 'fixture', 'tools': ['read'] if allowed is None else allowed,
                    'outputTokens': 1024, 'sampling': {'temperature': 1, 'top_k': 20}}
        child = subprocess.Popen(['node', '--input-type=module', '-e', CLIENT],
                                 env={**os.environ, 'INFERENCE_PROVIDER': json.dumps(settings),
                                      'PROVIDER_MODULE': Path(__file__).with_name('provider.mjs').as_uri(),
                                      'SCENARIO': scenario},
                                 pass_fds=(response_read, request_write, events_write),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for fd in (response_read, request_write, events_write):
            os.close(fd)
        requests = []
        try:
            with os.fdopen(request_read) as incoming, os.fdopen(response_write, 'w') as outgoing:
                for response in responses:
                    line = incoming.readline()
                    self.assertTrue(line, 'The provider did not send its expected request')
                    requests.append(json.loads(line))
                    response['id'] = requests[-1]['id']
                    outgoing.write(json.dumps(response, ensure_ascii=False) + '\n')
                    outgoing.flush()
            output, diagnostics = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0, diagnostics)
            with os.fdopen(events_read) as stream:
                events = [json.loads(line) for line in stream]
            return json.loads(output), requests, events
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_real_pipes_preserve_complete_assistant_and_measurements(self):
        assistant = {'role': 'assistant', 'content': 'Reading', 'reasoning_content': 'é🧭' * 18000,
                     'opaque': {'preserve': True}, 'tool_calls': [{'id': 'call-1', 'type': 'function',
                     'function': {'name': 'read', 'arguments': '{ "path": "a.txt" }'}}]}
        output, requests, events = self.invoke([answer('tool_calls', assistant), answer()], 'replay')
        self.assertNotIn('failure', output)
        self.assertEqual(requests[1]['messages'][1], assistant)
        self.assertEqual(requests[1]['messages'][2]['content'], 'original')
        self.assertEqual(requests[0]['max_tokens'], 1024)
        self.assertEqual(requests[0]['top_k'], 20)
        self.assertEqual(events[1]['usage']['prompt_tokens'], 11)
        self.assertEqual(events[1]['timings']['prompt_ms'], 2.5)
        self.assertGreater(events[1]['exchangeSeconds'], 0)
        self.assertEqual(output['turns'][1][-1]['finishReason']['unified'], 'stop')

    def test_truncated_response_fails_and_retains_its_usage(self):
        output, requests, events = self.invoke([answer('length')])
        self.assertIn('failure', output)
        self.assertEqual(len(requests), 1)
        self.assertEqual(events[1]['finishReason'], 'length')
        self.assertEqual(events[1]['usage']['completion_tokens'], 7)

    def test_changed_assistant_fails_before_another_runtime_request(self):
        assistant = {'role': 'assistant', 'content': 'Reading', 'tool_calls': [{'id': 'call-1',
                     'type': 'function', 'function': {'name': 'read', 'arguments': '{"path":"a.txt"}'}}]}
        output, requests, events = self.invoke([answer('tool_calls', assistant)], 'changed')
        self.assertIn('failure', output)
        self.assertEqual(len(requests), 1)
        self.assertIn('failure', events[-1])

    def test_concurrent_request_is_refused_without_dispatch(self):
        output, requests, events = self.invoke([answer()], 'concurrent')
        self.assertIn('concurrentFailure', output)
        self.assertEqual(len(requests), 1)
        self.assertTrue(any('failure' in event for event in events))

    def test_unapproved_runtime_tool_never_becomes_an_sdk_tool_call(self):
        assistant = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'bad', 'type': 'function',
                     'function': {'name': 'bash', 'arguments': '{"command":"touch forbidden"}'}}]}
        output, _, _ = self.invoke([answer('tool_calls', assistant)])
        self.assertIn('failure', output)
        self.assertEqual(output['turns'], [])


if __name__ == '__main__':
    unittest.main()
