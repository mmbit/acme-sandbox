#!/usr/bin/env python3
"""Check real pinned OpenCode file/edit/test tools against deterministic stdio replies, without weights."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
from types import SimpleNamespace

import coding
import smoke


# Each case's scripted replies, in order: a tool call (name, arguments), 'stop' (a final answer) or 'length' (a cut-off
# answer). A negative case passes when the route refuses it the way `refusal` says, and leaves the fixture unrepaired.
CASES = {
    'positive': {'steps': ['read', 'edit', 'bash', 'stop']},
    # The confined worker denies a command outside settings' allowlist (no commit is ever approved)
    'denied-command': {'steps': [('candidate_bash', {'command': 'git commit -qam Denied', 'description': 'Commit the fixture'}),
                                 'stop'], 'denied': 'candidate_bash'},
    # A tool the settings don't expose: the provider refuses the answer before OpenCode sees it
    'unapproved-tool': {'steps': [('webfetch', {'url': 'https://example.invalid/', 'format': 'text'})],
                        'refusal': ['Invalid or unapproved tool call']},
    'truncation': {'steps': ['length'], 'refusal': ['Runtime answer is truncated or unsuccessful']},
    # OpenCode asks for a session title beside the task: the single request lane refuses one of the two
    'auxiliary': {'steps': ['stop', 'stop'], 'auxiliary': True,
                  'refusal': ['A concurrent, auxiliary or post-completion request was attempted',
                              'The session history changed or an auxiliary request was attempted']},
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('opencode', 'settings', 'receipt', 'report'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--case', choices=CASES, default='positive')
    arguments = parser.parse_args()
    settings = json.loads(arguments.settings.read_text())
    receipt = json.loads(arguments.receipt.read_text())
    case = CASES[arguments.case]
    measurement = {'passed': False, 'model': 'deterministic fixture'}
    report = {'passed': False, 'fixture': True, 'case': arguments.case, 'weightsLoaded': False,
              'harness': settings['opencode'], 'models': [measurement]}
    evidence = smoke.Evidence(arguments.report, report)
    evidence.record('started')
    try:
        coding.verify_tools(arguments, settings, receipt)
        report['candidateBoundary'] = coding.boundary.verify(receipt)
        evidence.record('candidate-boundary')
        with tempfile.TemporaryDirectory(prefix='opencode-fixture-') as temporary:
            folder = Path(temporary)
            source = folder / 'value.mjs'
            source.write_text('export function sum(a, b) { return a - b; }\n')
            (folder / 'value.test.mjs').write_text(
                "import assert from 'node:assert/strict';\nimport {sum} from './value.mjs';\n"
                'assert.equal(sum(2, 3), 5);\n')
            subprocess.run(['git', '-C', temporary, 'init', '-q', '--template='], check=True)
            subprocess.run(['git', '-C', temporary, 'add', '--all'], check=True)
            subprocess.run(['git', '-C', temporary, '-c', 'user.name=Fixture', '-c',
                            'user.email=fixture@localhost', 'commit', '-qm', 'Fixture baseline'], check=True)
            baseline = head(temporary)
            before = subprocess.run(['node', '--test', 'value.test.mjs'], cwd=temporary, capture_output=True)
            smoke.require(before.returncode != 0, 'The fixture must fail before the edit')
            arguments.workspace = folder
            arguments.prompt = folder / 'prompt.txt'
            arguments.prompt.write_text('Read value.mjs, repair sum, run node --test value.test.mjs, then finish.')
            arguments.phase = 'execution'
            refused = exercise(arguments, settings, report, evidence, case)
            after = subprocess.run(['node', '--test', 'value.test.mjs'], cwd=temporary, capture_output=True)
            if arguments.case == 'positive':
                smoke.require(refused is None, f'The positive route failed: {refused}')
                smoke.require(measurement['requests'] == 4, 'The fixture made unexpected model requests')
                smoke.require(after.returncode == 0, 'The real file/edit/test route did not repair the fixture')
                smoke.require([tool['tool'] for tool in measurement['tools']] == ['candidate_read', 'candidate_edit', 'candidate_bash'],
                              'OpenCode did not execute all three required tools')
                smoke.require(all(tool['status'] == 'completed' for tool in measurement['tools']),
                              'An OpenCode tool failed')
            else:
                expect_refusal(arguments, case, refused, measurement)
                smoke.require(after.returncode != 0 and head(temporary) == baseline,
                              'A refused route still changed the fixture')
        measurement['passed'] = True
        report['passed'] = True
    except Exception as failure:
        evidence.record('failed', failure=str(failure))
        raise
    finally:
        evidence.record('finished')


def head(folder):
    return subprocess.run(['git', '-C', folder, 'rev-parse', 'HEAD'], check=True, capture_output=True).stdout


# The caller's own failure, or None. The runtime's history checks hold in every case.
def exercise(arguments, settings, report, evidence, case):
    requests_read, requests_write = os.pipe()
    responses_read, responses_write = os.pipe()
    failures = []
    measurement = report['models'][0]
    server = threading.Thread(target=serve, args=(requests_read, responses_write, arguments.workspace, failures,
                                                  measurement, case))
    runtime = SimpleNamespace(stdin=os.fdopen(requests_write, 'w'), stdout=os.fdopen(responses_read))
    server.start()
    refused = None
    try:
        coding.run_opencode(arguments, settings, runtime, {'contextTokens': 32768},
                            {'name': 'fixture', 'sampling': {'temperature': 0}}, measurement, evidence,
                            auxiliary=case.get('auxiliary', False))
    except Exception as failure:
        refused = str(failure)
        measurement['callerFailure'] = refused
    finally:
        runtime.stdin.close()
        runtime.stdout.close()
        server.join()
    smoke.require(not failures, f'The deterministic runtime rejected OpenCode: {failures}')
    return refused


# A denied tool comes back to the model as an error, so its session may still end normally. Every other refusal
# fails it.
def expect_refusal(arguments, case, refused, measurement):
    if 'denied' in case:
        events = arguments.report.with_suffix('.opencode.jsonl').read_text().splitlines()
        tools = [json.loads(line)['part'] for line in events if json.loads(line).get('type') == 'tool_use']
        denied = [tool for tool in tools if tool['tool'] == case['denied']]
        measurement['deniedTools'] = [{'tool': tool['tool'], 'status': tool['state']['status'],
                                       'error': str(tool['state'].get('error', ''))[:300]} for tool in denied]
        smoke.require(denied and all(tool['state']['status'] == 'error' for tool in denied),
                      'The denied tool was not refused by OpenCode')
        return
    smoke.require(refused is not None, 'A route the case must refuse completed normally')
    seen = [turn['failure'] for turn in measurement.get('turns', []) if 'failure' in turn]
    measurement['retainedFailures'] = seen
    smoke.require(any(failure in case['refusal'] for failure in seen),
                  'The provider did not retain the expected refusal')


def serve(requests_read, responses_write, workspace, failures, report, case):
    replies = []
    commands = {
        'read': ('candidate_read', {'filePath': str(workspace / 'value.mjs')}),
        'edit': ('candidate_edit', {'filePath': str(workspace / 'value.mjs'),
                          'oldString': 'return a - b;', 'newString': 'return a + b;'}),
        'bash': ('candidate_bash', {'command': 'node --test value.test.mjs', 'description': 'Run deterministic fixture checks'}),
    }
    steps = case['steps']
    try:
        with os.fdopen(requests_read) as incoming, os.fdopen(responses_write, 'w') as outgoing:
            for index, line in enumerate(incoming):
                request = json.loads(line)
                assistants = [message for message in request['messages'] if message['role'] == 'assistant']
                smoke.require(index < len(steps), 'An extra or auxiliary model request was made')
                # (an auxiliary title request starts a history of its own)
                if not case.get('auxiliary'):
                    smoke.require(assistants == replies, 'Full assistant fields were not replayed exactly')
                step = commands.get(steps[index], steps[index]) if isinstance(steps[index], str) else steps[index]
                assistant = {'role': 'assistant', 'content': None, 'reasoning_content': f'Fixture step {index}',
                             'fixtureOpaque': {'mustSurviveReplay': True}}
                if isinstance(step, tuple):
                    name, arguments = step
                    assistant['tool_calls'] = [{'id': f'fixture-{index}', 'type': 'function',
                                               'function': {'name': name, 'arguments': json.dumps(arguments)}}]
                    finish = 'tool_calls'
                else:
                    assistant['content'] = 'Fixture complete.' if step == 'stop' else 'Fixture cut'
                    finish = step
                response = {'id': request['id'], 'choices': [{'message': assistant, 'finish_reason': finish}],
                            'usage': {'prompt_tokens': 1, 'completion_tokens': 1},
                            'timings': {'prompt_ms': 0, 'predicted_ms': 0}}
                outgoing.write(json.dumps(response) + '\n')
                outgoing.flush()
                replies.append(assistant)
        report['replayedMessages'] = len(replies)
    except Exception as failure:
        failures.append(str(failure))


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, smoke.interrupted)
    main()
